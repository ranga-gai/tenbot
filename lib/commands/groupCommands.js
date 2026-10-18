/**
 * Group Management Commands & Helpers
 * Handles Superadmin commands via DM for WhatsApp groups configuration,
 * whitelisting, participant resolution, and admin checks.
 */

const { jidNormalizedUser } = require('@whiskeysockets/baileys');
const groupsConfig = require('../groupsConfig');
const namesStore = require('../names');
const ratings = require('../ratings');

const GENERIC_NAMES = new Set(['someone', 'player', 'player 1', 'player 2', 'player 3', 'player 4', 'me']);

// Cache of group metadata (id -> metadata)
const groupMetadataCache = new Map();

let targetGroupJid = null;

function setTargetGroupJid(jid) {
  targetGroupJid = jid;
}

function getCachedTargetGroupJid() {
  return targetGroupJid;
}

function getGroupMetadataCache() {
  return groupMetadataCache;
}

/**
 * Checks if two identities (JID and/or display name) represent the same user.
 */
function isSameUser(jid1, jid2, name1, name2) {
  const k1 = ratings.keyFor(name1);
  const k2 = ratings.keyFor(name2);
  if (k1 && k2 && !GENERIC_NAMES.has(k1) && !GENERIC_NAMES.has(k2)) {
    if (k1 === k2) return true;
    const m1 = namesStore.findIdByNameOrAlias(name1);
    const m2 = namesStore.findIdByNameOrAlias(name2);
    if (m1 && m2 && m1.id === m2.id) return true;
  }
  if (!jid1 || !jid2) return false;
  const norm1 = jidNormalizedUser(jid1);
  const norm2 = jidNormalizedUser(jid2);
  if (norm1 && norm2 && norm1 === norm2) return true;
  const lid1 = namesStore.resolveCanonicalId(norm1);
  const lid2 = namesStore.resolveCanonicalId(norm2);
  if (lid1 && lid2 && lid1 === lid2) return true;
  return false;
}

/**
 * Parses key=value arguments from a command string.
 * Supports quoted values (e.g. key="foo bar" or key='foo bar').
 */
function parseConfigKeyValueArgs(argsStr) {
  const updates = {};
  const regex = /(\w+)\s*=\s*(?:["']([^"']+)["']|([^\s]+))/g;
  let match;
  while ((match = regex.exec(argsStr)) !== null) {
    const key = match[1];
    const val = match[2] !== undefined ? match[2] : match[3];
    updates[key] = val;
  }
  return updates;
}

/**
 * Fetches all participating WhatsApp groups using Baileys socket or falls back to cache.
 */
async function fetchParticipatingGroups(sock) {
  let groups = {};

  if (sock && typeof sock.groupFetchAllParticipating === 'function') {
    try {
      groups = await sock.groupFetchAllParticipating();
      if (groups && typeof groups === 'object') {
        for (const [gId, gMeta] of Object.entries(groups)) {
          groupMetadataCache.set(gId, gMeta);
        }
      }
    } catch (err) {
      console.warn('[groups] Failed to fetch participating groups via socket, falling back to cache:', err.message);
    }
  }

  // Fallback to cached group metadata if socket fetch returned empty or failed
  if ((!groups || Object.keys(groups).length === 0) && groupMetadataCache.size > 0) {
    groups = {};
    for (const [gId, gMeta] of groupMetadataCache.entries()) {
      groups[gId] = gMeta;
    }
  }

  return groups;
}

/**
 * Searches participating WhatsApp groups for a match by JID or group name.
 * Returns { id, metadata, subject } or { multiple: true, matches } or null.
 */
async function resolveParticipatingGroup(sock, query) {
  if (!query) return null;
  const rawQuery = String(query).replace(/^["']|["']$/g, '').trim();
  if (!rawQuery) return null;

  const groups = await fetchParticipatingGroups(sock);
  const entries = Object.entries(groups || {});
  const lowerQuery = rawQuery.toLowerCase();

  // 1. Direct match by JID
  for (const [gId, gMeta] of entries) {
    if (gId.toLowerCase() === lowerQuery) {
      return { id: gId, metadata: gMeta, subject: gMeta?.subject || gId };
    }
  }

  // 2. Exact match by group subject/name
  const exactMatches = entries.filter(([gId, gMeta]) => (gMeta?.subject || '').trim().toLowerCase() === lowerQuery);
  if (exactMatches.length === 1) {
    const [gId, gMeta] = exactMatches[0];
    return { id: gId, metadata: gMeta, subject: gMeta?.subject || gId };
  }
  if (exactMatches.length > 1) {
    return {
      multiple: true,
      matches: exactMatches.map(([gId, gMeta]) => ({ id: gId, subject: gMeta?.subject || gId }))
    };
  }

  // 3. Substring match by group subject/name
  const partialMatches = entries.filter(([gId, gMeta]) => (gMeta?.subject || '').toLowerCase().includes(lowerQuery));
  if (partialMatches.length === 1) {
    const [gId, gMeta] = partialMatches[0];
    return { id: gId, metadata: gMeta, subject: gMeta?.subject || gId };
  }
  if (partialMatches.length > 1) {
    return {
      multiple: true,
      matches: partialMatches.map(([gId, gMeta]) => ({ id: gId, subject: gMeta?.subject || gId }))
    };
  }

  return null;
}

/**
 * Retrieves the groups where the given user is an admin (or all allowed groups if superadmin).
 */
async function getAdminGroupsForUser(sock, senderJid) {
  if (!sock || !senderJid) return [];
  const adminGroups = [];
  try {
    let groups = groupMetadataCache;
    if (groups.size === 0) {
      const fetched = await sock.groupFetchAllParticipating();
      for (const [gId, gMeta] of Object.entries(fetched)) {
        groupMetadataCache.set(gId, gMeta);
      }
      groups = groupMetadataCache;
    }

    const normUser = jidNormalizedUser(senderJid);
    const pnUser = namesStore.getPnByLid(normUser) || (normUser?.endsWith('@s.whatsapp.net') ? normUser : null);
    const lidUser = namesStore.resolveCanonicalId(normUser) || (normUser?.endsWith('@lid') ? normUser : null);

    const isSuper = groupsConfig.isSuperAdmin(senderJid);
    if (isSuper) {
      for (const [gId, gMeta] of groups.entries()) {
        if (!groupsConfig.isGroupAllowed(gId, gMeta.subject)) continue;
        adminGroups.push({ id: gId, name: gMeta.subject || gId });
      }
      return adminGroups;
    }

    for (const [gId, gMeta] of groups.entries()) {
      if (!groupsConfig.isGroupAllowed(gId, gMeta.subject)) continue;
      if (!gMeta.participants) continue;

      const participant = gMeta.participants.find((p) => {
        const pPn = jidNormalizedUser(p.id || p.jid);
        const pLid = jidNormalizedUser(p.lid);
        return (
          pPn === normUser ||
          pLid === normUser ||
          (pnUser && (pPn === pnUser || pLid === pnUser)) ||
          (lidUser && (pPn === lidUser || pLid === lidUser))
        );
      });

      if (participant && (participant.admin === 'admin' || participant.admin === 'superadmin')) {
        adminGroups.push({ id: gId, name: gMeta.subject || gId });
      }
    }
  } catch (err) {
    console.error('Failed to get admin groups for user:', err.message);
  }
  return adminGroups;
}

/**
 * Retrieves the target group JID (caching if necessary).
 */
async function getTargetGroupJid(sock, senderJid = null) {
  if (senderJid) {
    const adminGroups = await getAdminGroupsForUser(sock, senderJid);
    if (adminGroups.length > 0) return adminGroups[0].id;
  }
  if (targetGroupJid) return targetGroupJid;
  try {
    const groups = await sock.groupFetchAllParticipating();
    for (const [gId, gMeta] of Object.entries(groups)) {
      groupMetadataCache.set(gId, gMeta);
      if (groupsConfig.isGroupAllowed(gId, gMeta.subject)) {
        targetGroupJid = gId;
        return gId;
      }
    }
  } catch (err) {
    console.error('Failed to fetch participating groups:', err.message);
  }
  return null;
}

/**
 * Fetches and caches group metadata, populating LID <-> Phone Number maps in namesStore.
 */
async function getGroupMetadata(sock, remoteJid, recordNameFn = null) {
  if (!remoteJid || !remoteJid.endsWith('@g.us')) return null;
  let metadata = groupMetadataCache.get(remoteJid);
  if (!metadata) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        metadata = await sock.groupMetadata(remoteJid);
        if (metadata) {
          groupMetadataCache.set(remoteJid, metadata);
          if (groupsConfig.isGroupAllowed(remoteJid, metadata?.subject) && !targetGroupJid) {
            targetGroupJid = remoteJid;
          }
          break;
        }
      } catch (err) {
        if (attempt === 1) {
          await new Promise((r) => setTimeout(r, 300));
        } else {
          console.error(`Failed to fetch group metadata for ${remoteJid}:`, err.message);
        }
      }
    }
  }

  // Record participant name, LID mappings, and group membership for allowed groups
  const isAllowed = groupsConfig.isGroupAllowed(remoteJid, metadata?.subject);
  if (isAllowed && metadata?.participants) {
    namesStore.setGroupMembers(remoteJid, metadata.participants);
    for (const p of metadata.participants) {
      const rawPn = p.id || p.jid;
      const rawLid = p.lid;
      const pn = rawPn && rawPn.endsWith('@s.whatsapp.net') ? jidNormalizedUser(rawPn) : null;
      const lid = rawLid && rawLid.endsWith('@lid') ? jidNormalizedUser(rawLid) : (rawPn && rawPn.endsWith('@lid') ? jidNormalizedUser(rawPn) : null);
      const name = p.name || p.notify || p.verifiedName;
      if (pn && lid && pn !== lid) {
        namesStore.setMapping(lid, pn, name);
      } else if (name && recordNameFn) {
        if (pn) recordNameFn(pn, name);
        if (lid) recordNameFn(lid, name);
      }
    }
  }
  return metadata;
}

/**
 * Checks if a user is an admin or superadmin in a group.
 */
async function isUserAdmin(sock, remoteJid, senderJid) {
  if (!sock || !senderJid) return false;
  if (groupsConfig.isSuperAdmin(senderJid)) return true;
  const targetJid = (remoteJid && remoteJid.endsWith('@g.us')) ? remoteJid : (await getTargetGroupJid(sock));
  if (!targetJid) return false;
  try {
    const metadata = await getGroupMetadata(sock, targetJid);
    if (!metadata?.participants) return false;

    const normUser = jidNormalizedUser(senderJid);
    const pnUser = namesStore.getPnByLid(normUser) || (normUser?.endsWith('@s.whatsapp.net') ? normUser : null);
    const lidUser = namesStore.resolveCanonicalId(normUser) || (normUser?.endsWith('@lid') ? normUser : null);

    const participant = metadata.participants.find((p) => {
      const pPn = jidNormalizedUser(p.id || p.jid);
      const pLid = jidNormalizedUser(p.lid);
      return (
        pPn === normUser ||
        pLid === normUser ||
        (pnUser && (pPn === pnUser || pLid === pnUser)) ||
        (lidUser && (pPn === lidUser || pLid === lidUser))
      );
    });

    return participant?.admin === 'admin' || participant?.admin === 'superadmin';
  } catch (err) {
    console.error('Failed to check admin status:', err.message);
    return false;
  }
}

/**
 * Lists all WhatsApp groups the bot is currently a participating member of.
 * Displays group names, JIDs, participant counts, and whitelist status.
 */
async function handleListGroups(sock, senderJid = null) {
  if (senderJid && !groupsConfig.isSuperAdmin(senderJid)) {
    return '⚠️ Only the bot superadmin can view information of all WhatsApp groups.';
  }
  const groups = await fetchParticipatingGroups(sock);

  const groupEntries = Object.entries(groups || {});
  if (groupEntries.length === 0) {
    return 'The bot is not currently a member of any WhatsApp groups.';
  }

  // Sort alphabetically by group subject
  groupEntries.sort((a, b) => (a[1]?.subject || '').localeCompare(b[1]?.subject || ''));

  const lines = [`👥 *WhatsApp Groups the bot is a member of* (${groupEntries.length}):\n`];

  for (let i = 0; i < groupEntries.length; i++) {
    const [gId, gMeta] = groupEntries[i];
    const subject = gMeta?.subject || 'Unnamed Group';
    const count = Array.isArray(gMeta?.participants) ? gMeta.participants.length : (gMeta?.size || 'Unknown');
    const isAllowed = groupsConfig.isGroupAllowed(gId, subject);
    const groupCfg = groupsConfig.getGroupConfig(gId, subject);

    let statusNote = '';
    if (!isAllowed) {
      statusNote = ' ⛔ [Not in whitelist]';
    } else if (groupCfg?.alias || (groupCfg?.name && groupCfg.name !== gId)) {
      statusNote = ' ⚙️ [Configured in groups.json]';
    }

    lines.push(`${i + 1}. *${subject}*${statusNote}`);
    lines.push(`   • JID: \`${gId}\``);
    lines.push(`   • Members: ${count}`);
    if (groupCfg?.alias) {
      lines.push(`   • Alias: ${groupCfg.alias}`);
    }
    lines.push('');
  }

  if (groupsConfig.isSuperAdmin(senderJid)) {
    lines.push('');
    lines.push('👑 *Superadmin Group Management (DM only):*');
    lines.push('• `!addgroup <jid/name> [displayName]` — Add a group to groups.json & whitelist');
    lines.push('• `!removegroup <jid/name>` — Remove a group from groups.json & whitelist');
    lines.push('• `!setgroupconfig <jid/name> key=value ...` — Update group settings');
    lines.push('• `!groupconfig [jid/name]` — View detailed configuration');
  } else {
    lines.push('💡 _Use the group JID as the key in groups.json for group-specific configuration._');
  }
  return lines.join('\n').trim();
}

/**
 * Handles superadmin text commands for group management:
 * !groups, !addgroup, !removegroup, !setgroupconfig, !groupconfig
 */
async function handleGroupCommand(sock, text, chatId, senderJid) {
  const lower = text.toLowerCase();

  // !groups, !listgroups, etc.
  if (
    lower === '!groups' || lower.startsWith('!groups ') ||
    lower === '!listgroups' || lower.startsWith('!listgroups ') ||
    lower === '!mygroups' ||
    lower === '!getgroups' ||
    lower === '!allgroups' ||
    lower === '!groupids' ||
    lower === '!grouplids'
  ) {
    if (chatId && chatId.endsWith('@g.us')) {
      return '⚠️ The `!groups` command can only be called via Direct Message (DM) with the bot.';
    }
    if (!groupsConfig.isSuperAdmin(senderJid)) {
      return '⚠️ Only the bot superadmin can use `!groups` to view group details.';
    }
    return await handleListGroups(sock, senderJid);
  }

  // !addgroup
  if (lower.startsWith('!addgroup')) {
    if (chatId && chatId.endsWith('@g.us')) {
      return '⚠️ The `!addgroup` command can only be called via Direct Message (DM) with the bot.';
    }
    if (!groupsConfig.isSuperAdmin(senderJid)) {
      return '⚠️ Only the bot superadmin can add groups.';
    }
    const raw = text.replace(/^!addgroup\s*/i, '').trim();
    if (!raw) {
      return 'Usage: !addgroup <groupName or groupJid> [displayName] [key=value...]\nExample: !addgroup Bot-testing\nExample: !addgroup 120363403838804497@g.us Bot-testing';
    }

    const kvUpdates = parseConfigKeyValueArgs(raw);
    const nonKv = raw.replace(/\b\w+\s*=\s*(?:["'][^"']+["']|[^\s]+)/g, '').trim();

    let target = '';
    let customName = null;

    const quoteMatch = nonKv.match(/^["']([^"']+)["'](?:\s+(.*))?$/);
    if (quoteMatch) {
      target = quoteMatch[1].trim();
      customName = quoteMatch[2]?.replace(/^["']|["']$/g, '').trim() || null;
    } else {
      const tokens = nonKv.split(/\s+/);
      if (tokens[0] && tokens[0].includes('@')) {
        target = tokens[0].trim();
        customName = tokens.slice(1).join(' ').trim() || null;
      } else {
        target = nonKv.trim();
        customName = null;
      }
    }

    if (!target) {
      return 'Usage: !addgroup <groupName or groupJid> [displayName] [key=value...]\nExample: !addgroup Bot-testing\nExample: !addgroup 120363403838804497@g.us Bot-testing';
    }

    let finalJid = null;
    let displayName = customName;
    let note = '';

    if (target.includes('@')) {
      finalJid = target;
      if (!displayName) {
        const resolved = await resolveParticipatingGroup(sock, target);
        if (resolved && resolved.subject) {
          displayName = resolved.subject;
        }
      }
    } else {
      const resolved = await resolveParticipatingGroup(sock, target);
      if (resolved?.multiple) {
        const list = resolved.matches.map((m, idx) => `${idx + 1}. *${m.subject}* (\`${m.id}\`)`).join('\n');
        return `⚠️ Multiple participating WhatsApp groups matched "${target}":\n\n${list}\n\nPlease specify the exact group name or JID:\nExample: \`!addgroup ${resolved.matches[0].id}\``;
      }
      if (resolved && resolved.id) {
        finalJid = resolved.id;
        displayName = displayName || resolved.subject;
      } else {
        finalJid = target;
        displayName = displayName || target;
        note = `\nℹ️ _Note: Bot is not currently in a participating WhatsApp group matching "${target}". When added to the group, the bot will recognize it by name._`;
      }
    }

    const res = groupsConfig.addGroup(finalJid, { name: displayName, ...kvUpdates });
    return `✅ Added group "${res.name}" (\`${res.jid}\`) to groups.json configuration.${note}`;
  }

  // !removegroup / !deletegroup
  if (lower.startsWith('!removegroup') || lower.startsWith('!deletegroup') || lower.startsWith('!rmgroup')) {
    if (chatId && chatId.endsWith('@g.us')) {
      return '⚠️ The `!removegroup` command can only be called via Direct Message (DM) with the bot.';
    }
    if (!groupsConfig.isSuperAdmin(senderJid)) {
      return '⚠️ Only the bot superadmin can remove groups.';
    }
    const target = text.replace(/^!(?:removegroup|deletegroup|rmgroup)\s*/i, '').trim();
    if (!target) {
      return 'Usage: !removegroup <groupJid/name>\nExample: !removegroup Bot-testing';
    }
    const res = groupsConfig.removeGroup(target);
    if (!res) {
      return `⚠️ Group "${target}" was not found in groups.json.`;
    }
    return `🗑️ Removed group "${res.name || res.jid}" (\`${res.jid}\`) from groups.json configuration.`;
  }

  // !setgroupconfig / !updategroupconfig
  if (lower.startsWith('!setgroupconfig') || lower.startsWith('!updategroupconfig')) {
    if (chatId && chatId.endsWith('@g.us')) {
      return '⚠️ The `!setgroupconfig` command can only be called via Direct Message (DM) with the bot.';
    }
    if (!groupsConfig.isSuperAdmin(senderJid)) {
      return '⚠️ Only the bot superadmin can change group configurations.';
    }
    const raw = text.replace(/^!(?:setgroupconfig|updategroupconfig)\s*/i, '').trim();
    if (!raw) {
      return 'Usage: !setgroupconfig <groupJid/name> <key>=<value> ...\nExample: !setgroupconfig Bot-testing courtBookingEnabled=true sport=tennis directCourtBookingAccounts="Pramod Immaneni, Conrad Rodricks"';
    }
    const firstSpace = raw.search(/\s/);
    if (firstSpace === -1) {
      return 'Please specify at least one key=value configuration setting.\nExample: !setgroupconfig Bot-testing courtBookingEnabled=true';
    }
    const target = raw.slice(0, firstSpace).trim();
    const rest = raw.slice(firstSpace).trim();
    const updates = parseConfigKeyValueArgs(rest);
    if (Object.keys(updates).length === 0) {
      return 'Please specify settings in key=value format (e.g. courtBookingEnabled=true sport=tennis).';
    }
    const res = groupsConfig.updateGroupConfig(target, updates);
    if (!res) {
      return `⚠️ Group "${target}" was not found in groups.json.`;
    }
    return `✅ Updated configuration for "${res.name || res.jid}":\n${groupsConfig.formatGroupConfig(res.jid)}`;
  }

  // !groupconfig / !getgroupconfig
  if (lower.startsWith('!groupconfig') || lower.startsWith('!getgroupconfig')) {
    if (chatId && chatId.endsWith('@g.us')) {
      return '⚠️ The `!groupconfig` command can only be called via Direct Message (DM) with the bot.';
    }
    if (!groupsConfig.isSuperAdmin(senderJid)) {
      return '⚠️ Only the bot superadmin can view group configurations.';
    }
    const target = text.replace(/^!(?:groupconfig|getgroupconfig)\s*/i, '').trim();
    return groupsConfig.formatGroupConfig(target || null);
  }

  return null;
}

/**
 * Handles LLM tool calls for group configuration:
 * list_groups, add_group, remove_group, update_group_config, get_group_config
 */
async function executeGroupTool(sock, name, input, senderJid, chatId) {
  if (chatId && chatId.endsWith('@g.us')) {
    return '⚠️ Group configuration commands can only be called via Direct Message (DM) with the bot.';
  }
  if (!groupsConfig.isSuperAdmin(senderJid)) {
    return '⚠️ Only the bot superadmin can manage group configurations.';
  }

  if (name === 'list_groups' || name === 'get_groups') {
    return await handleListGroups(sock, senderJid);
  }

  if (name === 'add_group') {
    const { jid, name: gName, ...rest } = input;
    const target = (jid || gName || input.groupName || input.jidOrName || '').trim();
    if (!target) return 'Please provide the group name or JID (e.g. \'Bot-testing\' or \'120363403838804497@g.us\').';

    let finalJid = jid ? String(jid).trim() : null;
    let displayName = gName ? String(gName).trim() : null;
    let note = '';

    if (!finalJid || !finalJid.includes('@')) {
      const resolved = await resolveParticipatingGroup(sock, target);
      if (resolved?.multiple) {
        const list = resolved.matches.map((m, idx) => `${idx + 1}. *${m.subject}* (\`${m.id}\`)`).join('\n');
        return `⚠️ Multiple participating WhatsApp groups matched "${target}":\n\n${list}\n\nPlease specify the exact group name or JID.`;
      }
      if (resolved && resolved.id) {
        finalJid = resolved.id;
        displayName = displayName || resolved.subject;
      } else {
        finalJid = target;
        displayName = displayName || target;
        note = `\nℹ️ _Note: Bot is not currently in a participating WhatsApp group matching "${target}". When added to the group, the bot will recognize it by name._`;
      }
    } else if (!displayName) {
      const resolved = await resolveParticipatingGroup(sock, finalJid);
      if (resolved && resolved.subject) {
        displayName = resolved.subject;
      }
    }

    const res = groupsConfig.addGroup(finalJid, { name: displayName, ...rest });
    return `✅ Added group "${res.name}" (\`${res.jid}\`) to groups.json configuration.${note}`;
  }

  if (name === 'remove_group') {
    const { jidOrName } = input;
    if (!jidOrName) return 'Please provide the group JID or name to remove.';
    const res = groupsConfig.removeGroup(jidOrName);
    if (!res) return `⚠️ Group "${jidOrName}" was not found in groups.json.`;
    return `🗑️ Removed group "${res.name || res.jid}" (\`${res.jid}\`) from groups.json configuration.`;
  }

  if (name === 'update_group_config' || name === 'set_group_config') {
    const { jidOrName, ...updates } = input;
    if (!jidOrName) return 'Please provide the group JID or name to update.';
    const res = groupsConfig.updateGroupConfig(jidOrName, updates);
    if (!res) return `⚠️ Group "${jidOrName}" was not found in groups.json.`;
    return `✅ Updated configuration for "${res.name || res.jid}":\n${groupsConfig.formatGroupConfig(res.jid)}`;
  }

  if (name === 'get_group_config') {
    return groupsConfig.formatGroupConfig(input?.jidOrName || null);
  }

  return `Unknown group tool ${name}`;
}

module.exports = {
  isSameUser,
  parseConfigKeyValueArgs,
  fetchParticipatingGroups,
  resolveParticipatingGroup,
  getAdminGroupsForUser,
  getTargetGroupJid,
  setTargetGroupJid,
  getCachedTargetGroupJid,
  getGroupMetadata,
  getGroupMetadataCache,
  isUserAdmin,
  handleListGroups,
  handleGroupCommand,
  executeGroupTool
};
