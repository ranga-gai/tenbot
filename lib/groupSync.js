/**
 * Group Membership Synchronizer
 * -----------------------------
 * Keeps namesStore, ratings, and playerActivity synchronized with WhatsApp group membership.
 *
 * Handles:
 * - Real-time join events (action === 'add'): adds member to names, ratings, and activity.
 * - Real-time leave events (action === 'remove'): removes member from names, ratings, and activity
 *   (if they are no longer in any other allowed group).
 * - Full reconciliation (syncGroupMembership): adds current group members and prunes non-members
 *   across namesStore, ratings, and playerActivity.
 */

const { jidNormalizedUser } = require('@whiskeysockets/baileys');
const namesStore = require('./names');
const ratings = require('./ratings');
const playerActivity = require('./playerActivity');
const groupsConfig = require('./groupsConfig');
const groupCommands = require('./commands/groupCommands');

/**
 * Formats a rating for log output, tolerating missing values.
 */
function fmtRating(rating) {
  return (rating === null || rating === undefined || Number.isNaN(Number(rating)))
    ? 'n/a'
    : ratings.formatRating(rating);
}

/**
 * Builds a compact "id / pn / lid" descriptor for log lines.
 */
function describeIds({ id, pn, lid }) {
  const parts = [];
  if (id) parts.push(`id: ${id}`);
  if (pn && pn !== id) parts.push(`pn: ${pn}`);
  if (lid && lid !== id) parts.push(`lid: ${lid}`);
  return parts.join(', ') || 'no ids';
}

/**
 * Summarizes an activity entry's last-seen info for log output.
 */
function describeActivity(entry) {
  if (!entry) return 'no entry';
  const latest = playerActivity.computeLatest(entry.played, entry.voted, entry.messaged);
  const when = playerActivity.formatActivityDate(latest.time, { showTime: false });
  const weeks = entry.weekly ? Object.keys(entry.weekly).length : 0;
  return `status: ${entry.status || 'active'}, last ${latest.type || 'activity'}: ${when}, weeks tracked: ${weeks}`;
}

/**
 * Checks whether an identifier belongs to any allowed group currently tracked.
 * Optionally excludes a specific groupId that the member is leaving.
 */
function isMemberOfAnyAllowedGroup(idOrPn, excludeGroupId = null) {
  if (!idOrPn) return false;
  const groupMemberships = namesStore.getAllGroupMemberships ? namesStore.getAllGroupMemberships() : null;
  if (!groupMemberships || groupMemberships.size === 0) return false;

  for (const [chatId, set] of groupMemberships.entries()) {
    if (excludeGroupId && chatId === excludeGroupId) continue;
    if (set && set.size > 0 && groupsConfig.isGroupAllowed(chatId)) {
      if (namesStore.isMemberOfGroup(chatId, idOrPn, true)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Handles participant updates (add / remove) for an allowed group.
 */
async function handleParticipantsUpdate(sock, { id, participants, action }, recordNameFn = null) {
  if (!id || !Array.isArray(participants) || participants.length === 0) return;

  // Only manage membership for allowed groups
  if (!groupsConfig.isGroupAllowed(id)) {
    return;
  }

  if (action === 'add') {
    // 1. Fetch fresh metadata from WhatsApp if sock is available
    let metadata = null;
    if (sock && typeof sock.groupMetadata === 'function') {
      try {
        metadata = await sock.groupMetadata(id);
        if (metadata) {
          groupCommands.getGroupMetadataCache().set(id, metadata);
        }
      } catch (err) {
        console.warn(`[group-sync] Could not fetch fresh metadata for ${id} on participant add:`, err.message);
      }
    }
    if (!metadata) {
      metadata = groupCommands.getGroupMetadataCache().get(id);
    }

    const groupParticipants = metadata?.participants || [];

    for (const p of participants) {
      const pJid = typeof p === 'string' ? p : (p.id || p.jid);
      if (!pJid || namesStore.isTenbot(pJid)) continue;

      const pObj = groupParticipants.find(
        (gp) => gp.id === pJid || gp.jid === pJid || gp.lid === pJid
      ) || (typeof p === 'object' ? p : { id: pJid });

      const rawPn = pObj.id || pObj.jid;
      const rawLid = pObj.lid;
      const pn = rawPn && rawPn.endsWith('@s.whatsapp.net') ? jidNormalizedUser(rawPn) : null;
      const lid = rawLid && rawLid.endsWith('@lid') ? jidNormalizedUser(rawLid) : (rawPn && rawPn.endsWith('@lid') ? jidNormalizedUser(rawPn) : null);
      const name = pObj.name || pObj.notify || pObj.verifiedName || null;

      // Add to in-memory group membership
      namesStore.addGroupMember(id, pObj);

      // Add to namesStore
      if (pn && lid && pn !== lid) {
        namesStore.setMapping(lid, pn, name);
      } else {
        namesStore.setName(lid || pn || pJid, name, [], pn);
      }

      if (name && recordNameFn) {
        if (pn) recordNameFn(pn, name);
        if (lid) recordNameFn(lid, name);
      }

      const canonicalId = lid || pn || pJid;
      const resolvedName = name || namesStore.getName(canonicalId) || canonicalId;

      // Add to ratings
      let ratingInfo;
      const existingRating = ratings.findPlayer(resolvedName, canonicalId);
      if (!existingRating) {
        await ratings.ensureRated([{ name: resolvedName, jid: pn, lid }]);
        const addedRating = ratings.findPlayer(resolvedName, canonicalId);
        ratingInfo = addedRating
          ? `added ${fmtRating(addedRating.entry?.rating)} (key: ${addedRating.key}` +
            `${addedRating.entry?.tennisRecord === false ? ', no TennisRecord match' : ''}` +
            `${addedRating.entry?.tennisRecordLocation ? `, ${addedRating.entry.tennisRecordLocation}` : ''})`
          : 'not added (unnamed player)';
      } else {
        ratingInfo = `kept existing ${fmtRating(existingRating.entry?.rating)} (key: ${existingRating.key})`;
      }

      // Add to playerActivity
      const priorActivity = playerActivity.load()[canonicalId];
      const activityEntry = playerActivity.addPlayerActivity(canonicalId, id, resolvedName);
      const activityInfo = !activityEntry
        ? 'not added'
        : priorActivity
          ? `kept existing (${describeActivity(activityEntry)})`
          : `added (${describeActivity(activityEntry)})`;

      console.log(
        `[group-sync] + joined ${id}: "${resolvedName}" | names: ${describeIds({ id: canonicalId, pn, lid })}` +
        `${name ? '' : ' (no display name from WhatsApp)'} | ratings: ${ratingInfo} | activity: ${activityInfo}`
      );
    }
  } else if (action === 'remove') {
    // Invalidate cached metadata so subsequent checks don't see departed members
    groupCommands.getGroupMetadataCache().delete(id);

    for (const p of participants) {
      const pJid = typeof p === 'string' ? p : (p.id || p.jid);
      if (!pJid || namesStore.isTenbot(pJid)) continue;

      const resolvedName = namesStore.getName(pJid) || namesStore.getFullName(pJid);
      const canonicalId = namesStore.resolveCanonicalId(pJid);
      const lid = namesStore.getLidByPn(pJid) || (pJid.endsWith('@lid') ? pJid : null);
      const pn = namesStore.getPnByLid(pJid) || (pJid.endsWith('@s.whatsapp.net') ? pJid : null);

      // Remove from this group's membership in memory
      namesStore.removeGroupMember(id, pJid);
      if (canonicalId && canonicalId !== pJid) namesStore.removeGroupMember(id, canonicalId);
      if (lid && lid !== pJid) namesStore.removeGroupMember(id, lid);
      if (pn && pn !== pJid) namesStore.removeGroupMember(id, pn);

      // Check if player still belongs to any other allowed group
      const stillInAny =
        isMemberOfAnyAllowedGroup(pJid, id) ||
        (canonicalId && isMemberOfAnyAllowedGroup(canonicalId, id)) ||
        (lid && isMemberOfAnyAllowedGroup(lid, id)) ||
        (pn && isMemberOfAnyAllowedGroup(pn, id));

      if (!stillInAny) {
        // Capture pre-removal details so the log can report what was actually dropped
        const priorRating = ratings.findPlayer(resolvedName || pJid, canonicalId || pJid);
        const priorRatingValue = priorRating?.entry?.rating;
        const priorActivity = playerActivity.load()[canonicalId || pJid]
          || (resolvedName ? playerActivity.load()[resolvedName.toLowerCase()] : null);
        const priorNameEntry = namesStore.load()[canonicalId || pJid];

        // Remove from ratings
        let ratingsRemoved = false;
        for (const key of [canonicalId, lid, pn, pJid, resolvedName]) {
          if (key && ratings.removeRating(key)) ratingsRemoved = true;
        }

        // Remove from playerActivity
        let activityRemoved = false;
        for (const key of [canonicalId, lid, pn, pJid, resolvedName]) {
          if (key && playerActivity.removePlayerActivity(key, id)) activityRemoved = true;
        }

        // Remove from namesStore
        let namesRemoved = namesStore.removeEntry(pJid);
        for (const key of [canonicalId, lid, pn]) {
          if (key && namesStore.removeEntry(key)) namesRemoved = true;
        }

        console.log(
          `[group-sync] - left ${id}: "${resolvedName || pJid}" (not in any other allowed group) | ` +
          `names: ${namesRemoved ? `removed (${describeIds({ id: canonicalId || pJid, pn, lid })}` +
            `${priorNameEntry?.fullName && priorNameEntry.fullName !== priorNameEntry.name ? `, full: ${priorNameEntry.fullName}` : ''}` +
            `${priorNameEntry?.aliases?.length ? `, aliases: ${priorNameEntry.aliases.join(', ')}` : ''})` : 'no entry'} | ` +
          `ratings: ${ratingsRemoved ? `removed ${fmtRating(priorRatingValue)}${priorRating?.key ? ` (key: ${priorRating.key})` : ''}` : 'no entry'} | ` +
          `activity: ${activityRemoved ? `removed (${describeActivity(priorActivity)})` : 'no entry'}`
        );
      } else {
        console.log(`[group-sync] Member "${resolvedName || pJid}" left group ${id}, but remains in another allowed group. Kept in stores.`);
      }
    }

    // Refresh metadata cache if sock available
    if (sock && typeof sock.groupMetadata === 'function') {
      try {
        const fresh = await sock.groupMetadata(id);
        if (fresh) groupCommands.getGroupMetadataCache().set(id, fresh);
      } catch (err) {}
    }
  }
}

/**
 * Performs a full reconciliation of namesStore, ratings, and playerActivity
 * against active WhatsApp group participants in all allowed groups.
 */
async function syncGroupMembership(sock, targetGroupId = null) {
  const result = {
    syncedGroups: [],
    totalMembers: 0,
    added: { names: 0, ratings: 0, activity: 0 },
    removed: { names: 0, ratings: 0, activity: 0 }
  };

  // Determine allowed groups to introspect
  const allowedGroupIds = [];
  if (targetGroupId) {
    if (!groupsConfig.isGroupAllowed(targetGroupId)) {
      return { ...result, error: `Group "${targetGroupId}" is not in the allowed groups list.` };
    }
    allowedGroupIds.push(targetGroupId);
  } else {
    // 1. Fetch from sock if possible
    if (sock && typeof sock.groupFetchAllParticipating === 'function') {
      try {
        const allGroups = await sock.groupFetchAllParticipating();
        for (const [gId, gMeta] of Object.entries(allGroups || {})) {
          if (groupsConfig.isGroupAllowed(gId, gMeta?.subject)) {
            allowedGroupIds.push(gId);
            groupCommands.getGroupMetadataCache().set(gId, gMeta);
          }
        }
      } catch (err) {
        console.warn('[group-sync] Could not fetch all participating groups:', err.message);
      }
    }

    // 2. Fallback to groups.json configured groups
    const rawCfg = groupsConfig.loadRawConfig();
    if (rawCfg?.groups) {
      for (const [key, gVal] of Object.entries(rawCfg.groups)) {
        const jid = key.endsWith('@g.us') ? key : groupsConfig.getGroupJid(key);
        if (jid && !allowedGroupIds.includes(jid) && groupsConfig.isGroupAllowed(jid, gVal?.name)) {
          allowedGroupIds.push(jid);
        }
      }
    }
  }

  if (allowedGroupIds.length === 0) {
    return { ...result, error: 'No allowed groups found to synchronize.' };
  }

  // Collect metadata and participants for each allowed group
  const allCurrentMembers = new Map(); // canonicalId -> { pn, lid, name, pObj }
  const allMemberIdentifiers = new Set();

  for (const gId of allowedGroupIds) {
    let metadata = null;
    if (sock && typeof sock.groupMetadata === 'function') {
      try {
        metadata = await sock.groupMetadata(gId);
        if (metadata) {
          groupCommands.getGroupMetadataCache().set(gId, metadata);
        }
      } catch (err) {
        console.warn(`[group-sync] Could not fetch groupMetadata for ${gId}:`, err.message);
      }
    }
    if (!metadata) {
      metadata = groupCommands.getGroupMetadataCache().get(gId);
    }

    if (!metadata || !Array.isArray(metadata.participants)) {
      continue;
    }

    result.syncedGroups.push({ id: gId, subject: metadata.subject, memberCount: metadata.participants.length });
    namesStore.setGroupMembers(gId, metadata.participants);

    for (const p of metadata.participants) {
      const rawPn = p.id || p.jid;
      const rawLid = p.lid;
      if (namesStore.isTenbot(rawPn) || namesStore.isTenbot(rawLid)) continue;

      const pn = rawPn && rawPn.endsWith('@s.whatsapp.net') ? jidNormalizedUser(rawPn) : null;
      const lid = rawLid && rawLid.endsWith('@lid') ? jidNormalizedUser(rawLid) : (rawPn && rawPn.endsWith('@lid') ? jidNormalizedUser(rawPn) : null);
      const name = p.name || p.notify || p.verifiedName || null;

      const canonical = lid || pn || rawPn;
      if (canonical) {
        allCurrentMembers.set(canonical, { pn, lid, name, pObj: p });

        if (pn) {
          allMemberIdentifiers.add(pn.toLowerCase());
          allMemberIdentifiers.add(pn.split('@')[0]);
        }
        if (lid) {
          allMemberIdentifiers.add(lid.toLowerCase());
          allMemberIdentifiers.add(lid.split('@')[0]);
        }
        if (name) {
          allMemberIdentifiers.add(name.toLowerCase().trim());
        }
      }
    }
  }

  result.totalMembers = allCurrentMembers.size;

  // Safety guard: if 0 participants were fetched, abort to avoid wiping stores
  if (allCurrentMembers.size === 0) {
    console.warn('[group-sync] 0 participants found across allowed groups. Aborting store pruning.');
    return { ...result, error: 'No participants retrieved from WhatsApp groups.' };
  }

  // 1. Add missing group members to namesStore, ratings, and playerActivity
  for (const [canonical, info] of allCurrentMembers.entries()) {
    const { pn, lid, name } = info;

    // namesStore
    const hadNameEntry = !!namesStore.getName(canonical);
    if (pn && lid && pn !== lid) {
      namesStore.setMapping(lid, pn, name);
    } else if (!namesStore.getName(canonical) || (name && namesStore.getName(canonical) === 'Player')) {
      namesStore.setName(canonical, name, [], pn);
    }
    if (!hadNameEntry && namesStore.getName(canonical)) {
      result.added.names++;
      console.log(
        `[group-sync] + names: "${namesStore.getName(canonical)}" (${describeIds({ id: canonical, pn, lid })})` +
        `${name ? '' : ' -- no display name from WhatsApp, stored as placeholder'}`
      );
    }

    const registeredName = namesStore.getName(canonical);
    const registeredFullName = namesStore.getFullName(canonical);
    const registeredAliases = namesStore.getAliases(canonical);

    if (registeredName) allMemberIdentifiers.add(registeredName.toLowerCase().trim());
    if (registeredFullName) allMemberIdentifiers.add(registeredFullName.toLowerCase().trim());
    for (const a of registeredAliases) allMemberIdentifiers.add(a.toLowerCase().trim());

    const dispName = registeredName || name || canonical;

    // ratings
    if (!ratings.findPlayer(dispName, lid || pn)) {
      await ratings.ensureRated([{ name: dispName, jid: pn, lid }]);
      const addedRating = ratings.findPlayer(dispName, lid || pn);
      if (addedRating) {
        result.added.ratings++;
        console.log(
          `[group-sync] + ratings: "${dispName}" ${fmtRating(addedRating.entry?.rating)} (key: ${addedRating.key}` +
          `${addedRating.entry?.tennisRecord === false ? ', no TennisRecord match' : ''}` +
          `${addedRating.entry?.tennisRecordLocation ? `, ${addedRating.entry.tennisRecordLocation}` : ''})`
        );
      } else {
        console.log(`[group-sync] ~ ratings: skipped "${dispName}" (${describeIds({ id: canonical, pn, lid })}) -- no rating entry created`);
      }
    }

    // playerActivity
    const actData = playerActivity.load();
    const actKey = lid || pn || canonical;
    if (!actData[actKey] && !actData[dispName.toLowerCase()]) {
      const activityEntry = playerActivity.addPlayerActivity(actKey, null, dispName);
      if (activityEntry) {
        result.added.activity++;
        console.log(`[group-sync] + activity: "${activityEntry.name}" (key: ${actKey}, ${describeActivity(activityEntry)})`);
      } else {
        console.log(`[group-sync] ~ activity: skipped "${dispName}" (key: ${actKey}) -- no activity entry created`);
      }
    }
  }

  // 2. Prune non-members from namesStore
  const namesData = namesStore.load();

  // Snapshot display names before pruning so the ratings/activity logs below
  // can still name the entries they drop (rating entries store no name field).
  const nameByKey = new Map();
  for (const [k, v] of Object.entries(namesData)) {
    if (v?.name) {
      nameByKey.set(k.toLowerCase(), v.name);
      if (v.pn) nameByKey.set(v.pn.toLowerCase(), v.name);
    }
  }
  for (const [k, v] of Object.entries(namesData)) {
    if (namesStore.isTenbot(k) || namesStore.isTenbot(v?.name)) continue;
    const kLower = k.toLowerCase().trim();
    const kDigits = k.split('@')[0];
    const nameLower = v?.name ? v.name.toLowerCase().trim() : null;
    const fullLower = v?.fullName ? v.fullName.toLowerCase().trim() : null;
    const pnLower = v?.pn ? v.pn.toLowerCase().trim() : null;
    const pnDigits = v?.pn ? v.pn.split('@')[0] : null;

    const isPresent =
      allMemberIdentifiers.has(kLower) ||
      allMemberIdentifiers.has(kDigits) ||
      (nameLower && allMemberIdentifiers.has(nameLower)) ||
      (fullLower && allMemberIdentifiers.has(fullLower)) ||
      (pnLower && allMemberIdentifiers.has(pnLower)) ||
      (pnDigits && allMemberIdentifiers.has(pnDigits));

    if (!isPresent) {
      console.log(
        `[group-sync] - names: "${v?.name || k}" (key: ${k}${v?.pn ? `, pn: ${v.pn}` : ''}` +
        `${v?.fullName && v.fullName !== v.name ? `, full: ${v.fullName}` : ''}` +
        `${v?.aliases?.length ? `, aliases: ${v.aliases.join(', ')}` : ''}) -- not in any synced group`
      );
      delete namesData[k];
      result.removed.names++;
    }
  }
  if (result.removed.names > 0) {
    namesStore.save();
  }

  // 3. Prune non-members from ratings
  const ratingsObj = ratings.load();
  for (const [k, p] of Object.entries(ratingsObj.players || {})) {
    if (ratings.isPlaceholder(k) || (p?.name && ratings.isPlaceholder(p.name))) continue;
    const kLower = k.toLowerCase().trim();
    const kDigits = k.split('@')[0];
    const pNameLower = p?.name ? p.name.toLowerCase().trim() : null;

    const isPresent =
      allMemberIdentifiers.has(kLower) ||
      allMemberIdentifiers.has(kDigits) ||
      (pNameLower && allMemberIdentifiers.has(pNameLower));

    if (!isPresent) {
      console.log(
        `[group-sync] - ratings: "${p?.name || nameByKey.get(kLower) || k}" ${fmtRating(p?.rating)} (key: ${k}` +
        `${p?.locallyModified ? ', locally modified' : ''}` +
        `${p?.updatedAt ? `, updated: ${p.updatedAt}` : ''}) -- not in any synced group`
      );
      delete ratingsObj.players[k];
      result.removed.ratings++;
    }
  }
  if (result.removed.ratings > 0) {
    ratings.save();
  }

  // 4. Prune non-members from playerActivity
  const actObj = playerActivity.load();
  for (const [k, entry] of Object.entries(actObj || {})) {
    if (playerActivity.isTenbot(k) || (entry?.name && playerActivity.isTenbot(entry.name))) continue;
    const kLower = k.toLowerCase().trim();
    const kDigits = k.split('@')[0];
    const entryNameLower = entry?.name ? entry.name.toLowerCase().trim() : null;

    const isPresent =
      allMemberIdentifiers.has(kLower) ||
      allMemberIdentifiers.has(kDigits) ||
      (entryNameLower && allMemberIdentifiers.has(entryNameLower));

    if (!isPresent) {
      console.log(
        `[group-sync] - activity: "${entry?.name || nameByKey.get(kLower) || k}" (key: ${k}, ${describeActivity(entry)}) -- not in any synced group`
      );
      delete actObj[k];
      result.removed.activity++;
    }
  }
  if (result.removed.activity > 0) {
    playerActivity.save();
  }

  console.log(
    `[group-sync] Sync complete across ${result.syncedGroups.length} group(s) ` +
    `[${result.syncedGroups.map((g) => `${g.subject || g.id}: ${g.memberCount}`).join(', ')}], ${result.totalMembers} member(s): ` +
    `Added: (names: ${result.added.names}, ratings: ${result.added.ratings}, activity: ${result.added.activity}), ` +
    `Removed: (names: ${result.removed.names}, ratings: ${result.removed.ratings}, activity: ${result.removed.activity})`
  );

  return result;
}

module.exports = {
  handleParticipantsUpdate,
  syncGroupMembership,
  isMemberOfAnyAllowedGroup
};
