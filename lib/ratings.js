try { require('dotenv').config(); } catch (e) {}
function sanitizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  try {
    return encodeURI(decodeURI(trimmed));
  } catch (e) {
    return encodeURI(trimmed);
  }
}

/**
 * Per-player skill ratings: used to balance doubles pairings when a poll fills,
 * and moved by recorded set scores.
 *
 * Ratings are keyed by WhatsApp LID (<id>@lid) in ratings.json.
 * Names, phone numbers, and aliases are maintained separately in names.json.
 *
 * A rating is a two-decimal number between MIN_RATING and MAX_RATING, starting
 * from TennisRecord.com (or INITIAL_RATING 3.49 if not found).
 */

const fs = require('fs');
const path = require('path');
const tennisRecord = require('./tennisRecord');
const namesStore = require('./names');
const groupsConfig = require('./groupsConfig');
const messageHistory = require('./messageHistory');

const { DATA_DIR } = require('./paths');
const RATINGS_FILE = path.join(DATA_DIR, 'ratings.json');

const MIN_RATING = 2.5;
const MAX_RATING = 4.5;
const INITIAL_RATING = 3.49;

// An expected result moves each player by this much per game of the margin.
const RATING_STEP_PER_GAME = 0.01;

// An upset instead splits the pairing-rating gap, scaled by what fraction of
// this many games the margin was -- so a blowout upset transfers most of the
// gap and a tight one barely moves it.
const UPSET_GAME_SCALE = 12;

// The most a court's two pairing ratings should differ by. Matchup generation
// treats this as a target, not a hard rule: with a fixed group there isn't
// always a split that satisfies it.
const MAX_PAIR_RATING_GAP = 0.49;

// Refresh ratings bi-weekly (every 2 weeks / 14 days)
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

const toHundredths = (rating) => Math.round(rating * 100);
const fromHundredths = (hundredths) => hundredths / 100;

const MIN_H = toHundredths(MIN_RATING);
const MAX_H = toHundredths(MAX_RATING);
const INITIAL_H = toHundredths(INITIAL_RATING);
const STEP_PER_GAME_H = toHundredths(RATING_STEP_PER_GAME);

const clampH = (h) => Math.min(MAX_H, Math.max(MIN_H, h));

/** Case-insensitive lookup key for a player's display name or alias. */
function keyFor(name) {
  return String(name || '').trim().toLowerCase();
}

/** Formats a numeric rating to 2 decimal places. */
function formatRating(rating) {
  return Number(rating).toFixed(2);
}

/** Identifies generic placeholder player names (e.g. "Player 1", "Player 2", "Player (1234)"). */
function isPlaceholder(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return true;
  return (
    /^player(?:\s*\d+|\s*\(\d+\))?$/i.test(trimmed) ||
    /^(?:someone|me|creator)$/i.test(trimmed)
  );
}

function emptyRatings() {
  return { players: {} };
}

function loadFromDisk() {
  if (!fs.existsSync(RATINGS_FILE)) return emptyRatings();
  try {
    const parsed = JSON.parse(fs.readFileSync(RATINGS_FILE, 'utf-8'));
    return { players: parsed.players && typeof parsed.players === 'object' ? parsed.players : {} };
  } catch (err) {
    console.error('⚠️ Failed to read ratings.json, starting fresh:', err.message);
    return emptyRatings();
  }
}

// In-memory ratings store loaded once on startup
let ratingsData = loadFromDisk();

function load() {
  return ratingsData;
}

function save(data = null) {
  if (data) {
    ratingsData = data;
  }
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(RATINGS_FILE, JSON.stringify(ratingsData || emptyRatings(), null, 2));
  } catch (err) {
    console.error('⚠️ Failed to save ratings:', err.message);
  }
}

/**
 * Looks up a player's initial rating, profile URL, and location from TennisRecord.com.
 */

let botSockRef = null;

function setBotSocket(sock) {
  botSockRef = sock;
}

function getBotSocket() {
  return botSockRef;
}

const sentAlertsCache = new Set();

function clearAlertsCache() {
  sentAlertsCache.clear();
}

function formatSuperAdminAlert(playerName, reason, details = {}) {
  const currentRatingNote = (details?.currentRating !== undefined && details?.currentRating !== null)
    ? `• Rating kept at current *${formatRating(details.currentRating)}*`
    : `• Rating set to default *3.49*`;

  switch (reason) {
    case "not_in_area": {
      const locStr = details?.locations?.length ? ` (found in: ${details.locations.join(", ")})` : "";
      return `⚠️ *TennisRecord Alert*: Player "*${playerName}*" was found on TennisRecord.com, but not within San Jose or nearby areas${locStr}.\n` +
        `${currentRatingNote}\n` +
        `• \`tennisRecord: false\` flag set (automatic updates paused)\n\n` +
        `To correct this, please update their full name or rating:\n` +
        `• \`!fullname ${playerName} = <Real Full Name>\`\n` +
        `• \`!setrating ${playerName} = <rating>\``;
    }
    case "multiple_in_san_jose": {
      const count = details?.sanJoseCount || details?.candidates?.length || 2;
      const candidateList = (details?.candidates || [])
        .map((c) => `  - ${c.pName} (${c.location || "San Jose, CA"})`)
        .join("\n");
      const listStr = candidateList ? `\n${candidateList}\n` : "";
      return `⚠️ *TennisRecord Alert*: Multiple players (${count}) with the name "*${playerName}*" were found in San Jose on TennisRecord.com.${listStr}\n` +
        `${currentRatingNote}\n` +
        `• \`tennisRecord: false\` flag set (automatic updates paused due to ambiguity)\n\n` +
        `To correct this, please update their full name or rating:\n` +
        `• \`!fullname ${playerName} = <Real Full Name>\`\n` +
        `• \`!setrating ${playerName} = <rating>\``;
    }
    case "not_found":
    default:
      return `⚠️ *TennisRecord Alert*: Profile not found on TennisRecord.com for player "*${playerName}*".\n` +
        `${currentRatingNote}\n` +
        `• \`tennisRecord: false\` flag set (automatic updates paused)\n\n` +
        `To correct this, please update their full name or rating:\n` +
        `• \`!fullname ${playerName} = <Real Full Name>\`\n` +
        `• \`!setrating ${playerName} = <rating>\``;
  }
}

async function sendSuperAdminAlert(playerName, reason, details = {}, explicitSock = null) {
  const cacheKey = `${String(playerName).toLowerCase()}:${reason}`;
  if (sentAlertsCache.has(cacheKey)) {
    console.log(`[ratings] Skipping duplicate superadmin alert for "${playerName}" (${reason}).`);
    return false;
  }

  const sock = explicitSock || botSockRef;
  const message = formatSuperAdminAlert(playerName, reason, details);
  console.warn(`[ratings] TennisRecord issue for "${playerName}" (${reason}): alerting superadmin.`);

  if (!sock) {
    console.warn(`[ratings] Socket not available to send superadmin alert for "${playerName}".`);
    return false;
  }

  const superAdminJids = groupsConfig.getSuperAdminJids();
  if (!superAdminJids || superAdminJids.length === 0) {
    console.warn("[ratings] No superadmin accounts configured in .env (SUPERADMIN_ACCOUNT).");
    return false;
  }

  let sent = false;
  for (const targetJid of superAdminJids) {
    try {
      messageHistory.recordMessage(targetJid, "tenbot", message, Date.now(), true);
      await sock.sendMessage(targetJid, { text: message });
      console.log(`[ratings] Sent TennisRecord alert for "${playerName}" to superadmin ${targetJid} (configured in .env)`);
      sent = true;
    } catch (err) {
      console.error(`[ratings] Failed to send alert to superadmin ${targetJid}:`, err.message);
    }
  }

  if (sent) {
    sentAlertsCache.add(cacheKey);
  }
  return sent;
}

async function lookupInitialPlayerRating(playerName, profileUrl = null) {
  let initialVal = INITIAL_RATING;
  let trProfileUrl = profileUrl ? sanitizeUrl(profileUrl) : null;
  let trLocation = null;
  let tennisRecordFlag = true;
  let failureReason = null;
  let failureDetails = null;

  try {
    const trResult = await tennisRecord.fetchTennisRecordRating(playerName, profileUrl);
    if (!trResult || trResult.tennisRecord === false || !trResult.profileUrl) {
      tennisRecordFlag = false;
      initialVal = INITIAL_RATING;
      trProfileUrl = null;
      trLocation = null;
      failureReason = trResult?.reason || "not_found";
      failureDetails = trResult?.details || null;
      console.log(`[ratings] TennisRecord lookup failed for "${playerName}" (${failureReason}): tennisRecord set to false, rating defaulted to ${INITIAL_RATING}`);
    } else {
      tennisRecordFlag = true;
      if (trResult.rating !== null && trResult.rating >= MIN_RATING && trResult.rating <= MAX_RATING) {
        initialVal = trResult.rating;
        trProfileUrl = sanitizeUrl(trResult.profileUrl);
        trLocation = trResult.location || null;
        console.log(`[ratings] Initialized rating for "${playerName}" from TennisRecord: ${initialVal} (${trLocation || "San Jose"}) -> ${trProfileUrl}`);
      } else {
        initialVal = INITIAL_RATING;
        trProfileUrl = sanitizeUrl(trResult.profileUrl);
        trLocation = trResult.location || null;
        console.log(`[ratings] TennisRecord profile found for "${playerName}" (${trLocation || "Unrated"}), defaulting rating to ${INITIAL_RATING}`);
      }
    }
  } catch (err) {
    tennisRecordFlag = false;
    initialVal = INITIAL_RATING;
    failureReason = "not_found";
    console.error(`[ratings] TennisRecord error for "${playerName}":`, err.message);
  }

  return {
    rating: initialVal,
    tennisRecord: tennisRecordFlag,
    tennisRecordUrl: trProfileUrl,
    tennisRecordLocation: trLocation,
    failureReason,
    failureDetails
  };
}

let inFlightSync = null;

/**
 * Ensures all players in names.json have corresponding rating entries in ratings.json.
 * For any newly added players, attempts to fetch their rating from TennisRecord.com.
 */
async function syncRatingsWithNames() {
  if (inFlightSync) return inFlightSync;

  inFlightSync = (async () => {
    try {
      const namesData = namesStore.load();
      let createdRatingsCount = 0;
      let removedCount = 0;

      for (const key of Object.keys(ratingsData.players || {})) {
        if (key.endsWith('@s.whatsapp.net')) {
          const canonical = namesStore.resolveCanonicalId(key, namesData);
          if ((canonical && canonical !== key && ratingsData.players[canonical]) || !namesData[key]) {
            delete ratingsData.players[key];
            removedCount++;
            console.log(`[ratings] Removed stale phone-number rating entry "${key}"`);
          }
        }
      }

      const nowIso = new Date().toISOString();
      for (const [lid, entry] of Object.entries(namesData)) {
        if (!entry || !entry.name || isPlaceholder(entry.name)) continue;
        if (!ratingsData.players[lid]) {
          const searchName = entry.fullName || entry.name;
          const lookup = await lookupInitialPlayerRating(searchName);
          ratingsData.players[lid] = {
            rating: lookup.rating,
            locallyModified: false,
            tennisRecord: lookup.tennisRecord,
            tennisRecordUrl: lookup.tennisRecordUrl,
            tennisRecordLocation: lookup.tennisRecordLocation,
            lastRefreshedAt: nowIso,
            updatedAt: nowIso
          };
          createdRatingsCount++;
          if (lookup.tennisRecord === false) {
            await sendSuperAdminAlert(searchName, lookup.failureReason, lookup.failureDetails);
          }
        }
      }

      if (createdRatingsCount > 0 || removedCount > 0) {
        save();
        if (createdRatingsCount > 0) {
          console.log(`[ratings] Created ${createdRatingsCount} missing rating entry/entries for players in names.json.`);
        }
        if (removedCount > 0) {
          console.log(`[ratings] Removed ${removedCount} stale phone-number rating entry/entries.`);
        }
      }

      return { createdRatingsCount };
    } finally {
      inFlightSync = null;
    }
  })();

  return inFlightSync;
}

/**
 * Finds a player entry in ratings by LID, PN, display name, or alias.
 */
function findPlayer(idOrName, jid = null, customRatings = null) {
  if (!idOrName && !jid) return null;
  const currentData = customRatings || ratingsData;
  const players = currentData.players || {};

  const cleanJid = jid ? String(jid).trim() : null;
  const raw = idOrName ? String(idOrName).trim() : '';
  const rawKey = keyFor(raw);

  // 1. Direct LID match or canonical ID lookup
  const canonicalLid = namesStore.resolveCanonicalId(cleanJid || raw);
  if (canonicalLid && players[canonicalLid]) {
    return { key: canonicalLid, entry: players[canonicalLid] };
  }
  if (cleanJid && players[cleanJid]) return { key: cleanJid, entry: players[cleanJid] };
  if (raw && players[raw]) return { key: raw, entry: players[raw] };

  // 2. Lookup in names.json by name, PN, or alias
  const nameMatch = namesStore.findIdByNameOrAlias(raw || cleanJid);
  if (nameMatch && nameMatch.id) {
    const matchedId = nameMatch.id;
    if (players[matchedId]) return { key: matchedId, entry: players[matchedId] };
  }

  // 3. Search through entries by namesStore
  for (const [key, p] of Object.entries(players)) {
    const registeredName = namesStore.getName(key);
    if (registeredName && keyFor(registeredName) === rawKey) {
      return { key, entry: p };
    }
    const registeredAliases = namesStore.getAliases(key);
    if (registeredAliases.some((a) => keyFor(a) === rawKey)) {
      return { key, entry: p };
    }
  }

  // 4. Normalized key fallback
  if (rawKey && players[rawKey]) return { key: rawKey, entry: players[rawKey] };

  return null;
}

/** A player's rating in hundredths, defaulting to the starting rating. */
function hundredthsFor(idOrName, jid = null, customRatings = null) {
  const match = findPlayer(idOrName, jid, customRatings);
  const stored = match && match.entry && toHundredths(match.entry.rating);
  return Number.isFinite(stored) ? clampH(stored) : INITIAL_H;
}

/**
 * Sets hundredths rating for a player, updating or creating their entry by LID.
 */
function setHundredths(idOrName, hundredths, extra = {}, customRatings = null) {
  const name = extra.name || (idOrName && !idOrName.includes('@') ? idOrName : null);
  if (name && isPlaceholder(name)) return;

  const targetData = customRatings || ratingsData;
  if (!targetData.players) targetData.players = {};

  const cleanJid = extra.jid || (idOrName && idOrName.includes('@') ? idOrName : null);
  const nameMatch = namesStore.findIdByNameOrAlias(idOrName || name || cleanJid);
  const cleanLid = extra.lid || (nameMatch && nameMatch.id?.endsWith('@lid') ? nameMatch.id : null) || (cleanJid ? namesStore.resolveCanonicalId(cleanJid) : null) || (idOrName?.includes('@lid') ? idOrName : null);
  const match = findPlayer(idOrName, cleanLid || cleanJid, targetData);
  const newRating = fromHundredths(clampH(hundredths));
  const now = new Date().toISOString();

  const primaryKey = cleanLid || (match ? match.key : (nameMatch ? nameMatch.id : (cleanJid || keyFor(name || idOrName))));

  if (match) {
    match.entry.rating = newRating;
    match.entry.updatedAt = now;
    if (extra.locallyModified !== undefined) match.entry.locallyModified = extra.locallyModified;
    if (extra.tennisRecord !== undefined) match.entry.tennisRecord = extra.tennisRecord;
    if (extra.tennisRecordUrl !== undefined) match.entry.tennisRecordUrl = sanitizeUrl(extra.tennisRecordUrl);
    if (extra.tennisRecordLocation !== undefined) match.entry.tennisRecordLocation = extra.tennisRecordLocation;
    if (extra.lastRefreshedAt) match.entry.lastRefreshedAt = extra.lastRefreshedAt;
  } else {
    targetData.players[primaryKey] = {
      rating: newRating,
      locallyModified: extra.locallyModified || false,
      tennisRecord: extra.tennisRecord !== undefined ? extra.tennisRecord : true,
      tennisRecordUrl: sanitizeUrl(extra.tennisRecordUrl),
      tennisRecordLocation: extra.tennisRecordLocation || null,
      lastRefreshedAt: extra.lastRefreshedAt || now,
      updatedAt: now
    };
  }
}

/** A player's current rating. Unrated players start at INITIAL_RATING. */
function getRating(nameOrJid, jid = null) {
  return fromHundredths(hundredthsFor(nameOrJid, jid));
}

/**
 * Explicitly sets or changes a player's rating.
 * Clamps rating between MIN_RATING and MAX_RATING.
 */
function setRating(nameOrJid, rating, extra = {}) {
  if (!nameOrJid || isPlaceholder(nameOrJid)) return null;
  const num = parseFloat(rating);
  if (!Number.isFinite(num)) return null;
  const clamped = fromHundredths(clampH(toHundredths(num)));
  setHundredths(nameOrJid, toHundredths(clamped), { locallyModified: true, ...extra });
  save();
  return clamped;
}

/**
 * Ratings for specific player ids, keyed by the id exactly as given, so callers
 * with their own ids (matchup generation) don't need to know how names are
 * normalised in here.
 */
function getRatingMap(namesOrJids) {
  return new Map(namesOrJids.map((idOrName) => [idOrName, fromHundredths(hundredthsFor(idOrName))]));
}

/**
 * Writes the starting rating for any of these players we haven't rated yet.
 * Queries TennisRecord to find their estimated or NTRP rating and saves their
 * unique TennisRecord profile URL and location.
 */
async function ensureRated(players, jidMap = new Map()) {
  const playerList = Array.isArray(players) ? players : [players];

  const missing = [];
  for (const item of playerList) {
    const name = typeof item === 'object' && item !== null ? item.name : item;
    const jid = (typeof item === 'object' && item !== null ? item.jid : null) || (jidMap instanceof Map ? jidMap.get(name) : null);
    const lid = (typeof item === 'object' && item !== null ? item.lid : null) || (jid ? namesStore.resolveCanonicalId(jid) : null);
    const pn = (typeof item === 'object' && item !== null ? item.pn : null) || (jid && jid.endsWith('@s.whatsapp.net') ? jid : null);

    if (!name || isPlaceholder(name)) continue;
    const match = findPlayer(name, lid || jid);
    if (!match) {
      missing.push({ name, jid, lid, pn });
    }
  }

  if (missing.length === 0) return 0;

  for (const { name, jid, lid, pn } of missing) {
    const fullName = namesStore.getFullName(lid || jid || name);
    const searchName = (fullName && !isPlaceholder(fullName)) ? fullName : name;
    const lookup = await lookupInitialPlayerRating(searchName);

    const existing = findPlayer(name, lid || jid);
    if (!existing) {
      const now = new Date().toISOString();
      setHundredths(lid || jid || name, toHundredths(lookup.rating), {
        name,
        jid,
        lid,
        pn,
        locallyModified: false,
        tennisRecord: lookup.tennisRecord,
        tennisRecordUrl: lookup.tennisRecordUrl,
        tennisRecordLocation: lookup.tennisRecordLocation,
        lastRefreshedAt: now
      });
      save();
      if (lookup.tennisRecord === false) {
        await sendSuperAdminAlert(searchName, lookup.failureReason, lookup.failureDetails);
      }
    }
  }
  return missing.length;
}

/**
 * Periodically refreshes player ratings from TennisRecord once every 2 weeks (14 days).
 * If a player's rating was modified locally from reported matches, the new rating is
 * the higher of the refreshed TennisRecord rating and the current local rating (Math.max).
 * If the rating was not locally modified, the refreshed TennisRecord rating is applied directly.
 */
async function refreshPeriodicRatings({ force = false, delayMs = 500 } = {}) {
  const now = Date.now();
  let updatedCount = 0;
  let checkedCount = 0;

  const players = Object.entries(ratingsData.players || {});

  for (const [key, p] of players) {
    // If tennisRecord is set to false in the rating record, don't try to update the rating from tennisrecord.com
    if (p.tennisRecord === false) {
      continue;
    }

    const playerName = namesStore.getFullName(key) || namesStore.getName(key);
    if (!playerName || isPlaceholder(playerName)) continue;

    const lastTime = p.lastRefreshedAt ? new Date(p.lastRefreshedAt).getTime() : 0;
    const isDue = force || !lastTime || (now - lastTime >= TWO_WEEKS_MS);

    if (!isDue) continue;

    checkedCount++;
    try {
      const trResult = await tennisRecord.fetchTennisRecordRating(playerName, p.tennisRecordUrl);
      const isoNow = new Date().toISOString();
      p.lastRefreshedAt = isoNow;

      if (!trResult || trResult.tennisRecord === false || !trResult.profileUrl) {
        p.tennisRecord = false;
        // Keep old rating already in the file if fetching rating fails
        p.updatedAt = isoNow;
        save();
        await sendSuperAdminAlert(playerName, trResult?.reason || "not_found", {
          ...(trResult?.details || {}),
          currentRating: p.rating
        });
        continue;
      }

      p.tennisRecord = true;
      if (trResult.profileUrl) p.tennisRecordUrl = trResult.profileUrl;
      if (trResult.location) p.tennisRecordLocation = trResult.location;

      if (trResult.rating !== null && trResult.rating >= MIN_RATING && trResult.rating <= MAX_RATING) {
        const oldRating = p.rating;
        const trRating = trResult.rating;

        let targetRating;
        if (p.locallyModified) {
          targetRating = Math.max(oldRating, trRating);
        } else {
          targetRating = trRating;
        }

        if (oldRating !== targetRating) {
          p.rating = targetRating;
          p.updatedAt = isoNow;
          const note = p.locallyModified ? ` (locally modified; kept higher of ${oldRating} vs TR ${trRating})` : '';
          console.log(`[ratings-refresh] Updated rating for "${playerName}": ${oldRating} -> ${targetRating}${note}`);
          updatedCount++;
        }
      }

      save();

      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    } catch (err) {
      console.error(`[ratings-refresh] Error refreshing rating for "${playerName}":`, err.message);
    }
  }

  if (checkedCount > 0) {
    console.log(`[ratings-refresh] Completed 2-week rating sweep: ${checkedCount} checked, ${updatedCount} updated.`);
  }

  return { checkedCount, updatedCount };
}

/** Every rated player, strongest first. */
function getAllRatings() {
  const { players } = ratingsData;
  return Object.entries(players || {})
    .map(([key, p]) => {
      const name = namesStore.getName(key) || key;
      if (!name || isPlaceholder(name)) return null;
      return {
        id: key,
        name,
        rating: fromHundredths(clampH(toHundredths(p.rating))),
        locallyModified: Boolean(p.locallyModified),
        tennisRecordUrl: p.tennisRecordUrl || null,
        tennisRecordLocation: p.tennisRecordLocation || null,
        lastRefreshedAt: p.lastRefreshedAt || null
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name));
}

/** Sum of a side's ratings -- one player for singles, two for doubles. */
function pairRating(names, ratingMap) {
  return fromHundredths(
    names.reduce((sum, name) => sum + toHundredths(ratingMap.get(name) ?? INITIAL_RATING), 0)
  );
}

/**
 * Applies one set's score. Both the movement and who moves depend on the
 * pairing ratings going into that set.
 */
function applySet(sideA, sideB, gamesA, gamesB) {
  const margin = Math.abs(gamesA - gamesB);
  if (margin === 0) return null; // tied or unplayed set: nothing to award

  const sum = (side) => side.reduce((total, name) => total + hundredthsFor(name), 0);
  const ratingA = sum(sideA);
  const ratingB = sum(sideB);

  const winners = gamesA > gamesB ? sideA : sideB;
  const losers = gamesA > gamesB ? sideB : sideA;
  const winnerRating = gamesA > gamesB ? ratingA : ratingB;
  const loserRating = gamesA > gamesB ? ratingB : ratingA;

  const upset = winnerRating < loserRating;
  let moveH;

  if (upset) {
    const gapH = loserRating - winnerRating;
    const fraction = Math.min(1, margin / UPSET_GAME_SCALE);
    moveH = Math.max(1, Math.round((gapH / 2) * fraction));
  } else {
    moveH = margin * STEP_PER_GAME_H;
  }

  for (const name of winners) {
    const h = hundredthsFor(name);
    setHundredths(name, h + moveH, { locallyModified: true });
  }
  for (const name of losers) {
    const h = hundredthsFor(name);
    setHundredths(name, h - moveH, { locallyModified: true });
  }

  return {
    winners,
    losers,
    upset,
    gamesA,
    gamesB,
    margin,
    move: fromHundredths(moveH)
  };
}

/**
 * Applies a full match (one or more sets) to player ratings and saves the
 * changes. Returns a description of what moved.
 */
function applyResult(winners, losers, sets) {
  const allNames = [...winners, ...losers];
  const before = new Map(allNames.map((n) => [n, fromHundredths(hundredthsFor(n))]));

  const appliedSets = [];
  for (const [gamesA, gamesB] of sets) {
    const res = applySet(winners, losers, gamesA, gamesB);
    if (res) appliedSets.push(res);
  }

  save();

  const after = new Map(allNames.map((n) => [n, fromHundredths(hundredthsFor(n))]));
  const changes = allNames.map((name) => ({
    name,
    from: before.get(name),
    to: after.get(name)
  }));

  return { sets: appliedSets, changes };
}

/**
 * Updates a player's rating by looking up their initial rating from TennisRecord using their new full name.
 */
async function updateRatingFromFullName(playerOrId, fullName, extra = {}) {
  if (!fullName || isPlaceholder(fullName)) return null;
  // Clear any existing alert cache for this name so superadmin receives new status if needed
  sentAlertsCache.delete(`${String(fullName).toLowerCase()}:not_found`);
  sentAlertsCache.delete(`${String(fullName).toLowerCase()}:not_in_area`);
  sentAlertsCache.delete(`${String(fullName).toLowerCase()}:multiple_in_san_jose`);

  const lookup = await lookupInitialPlayerRating(fullName);
  const cleanJid = extra.jid || (playerOrId && playerOrId.includes("@") ? playerOrId : null);
  const nameMatch = namesStore.findIdByNameOrAlias(playerOrId || fullName || cleanJid);
  const cleanLid = extra.lid || (nameMatch && nameMatch.id?.endsWith("@lid") ? nameMatch.id : null) || (cleanJid ? namesStore.resolveCanonicalId(cleanJid) : null) || (playerOrId?.includes("@lid") ? playerOrId : null);
  const match = findPlayer(playerOrId, cleanLid || cleanJid);

  const primaryKey = cleanLid || (match ? match.key : (nameMatch ? nameMatch.id : (cleanJid || keyFor(playerOrId || fullName))));
  const now = new Date().toISOString();

  if (match) {
    match.entry.rating = lookup.rating;
    match.entry.locallyModified = false;
    match.entry.tennisRecord = lookup.tennisRecord;
    match.entry.tennisRecordUrl = lookup.tennisRecordUrl;
    match.entry.tennisRecordLocation = lookup.tennisRecordLocation;
    match.entry.lastRefreshedAt = now;
    match.entry.updatedAt = now;
  } else {
    ratingsData.players[primaryKey] = {
      rating: lookup.rating,
      locallyModified: false,
      tennisRecord: lookup.tennisRecord,
      tennisRecordUrl: lookup.tennisRecordUrl,
      tennisRecordLocation: lookup.tennisRecordLocation,
      lastRefreshedAt: now,
      updatedAt: now
    };
  }
  save();

  if (lookup.tennisRecord === false) {
    await sendSuperAdminAlert(fullName, lookup.failureReason, lookup.failureDetails, extra.sock);
  }

  return {
    rating: lookup.rating,
    tennisRecord: lookup.tennisRecord,
    tennisRecordUrl: lookup.tennisRecordUrl,
    tennisRecordLocation: lookup.tennisRecordLocation,
    failureReason: lookup.failureReason
  };
}

/**
 * Resets a player's rating back to their baseline TennisRecord.com rating (or INITIAL_RATING if not found),
 * clearing locally modified match score adjustments.
 */
async function resetRating(playerOrId, extra = {}) {
  if (!playerOrId || isPlaceholder(playerOrId)) return null;
  const cleanJid = extra.jid || (playerOrId && playerOrId.includes("@") ? playerOrId : null);
  const nameMatch = namesStore.findIdByNameOrAlias(playerOrId || cleanJid);
  const cleanLid = extra.lid || (nameMatch && nameMatch.id?.endsWith("@lid") ? nameMatch.id : null) || (cleanJid ? namesStore.resolveCanonicalId(cleanJid) : null) || (playerOrId?.includes("@lid") ? playerOrId : null);
  const match = findPlayer(playerOrId, cleanLid || cleanJid);

  const matchedName = nameMatch?.entry?.fullName || nameMatch?.entry?.name || (match ? namesStore.getName(match.key) : null) || playerOrId;
  const now = new Date().toISOString();

  // If tennisRecord is set to false in the rating record, don't try to update the rating from tennisrecord.com
  if (match && match.entry.tennisRecord === false) {
    match.entry.rating = INITIAL_RATING;
    match.entry.locallyModified = false;
    match.entry.updatedAt = now;
    save();
    return {
      name: nameMatch?.entry?.name || matchedName,
      rating: INITIAL_RATING,
      tennisRecord: false,
      tennisRecordUrl: null,
      tennisRecordLocation: null
    };
  }

  const profileUrl = match?.entry?.tennisRecordUrl || null;
  const lookup = await lookupInitialPlayerRating(matchedName, profileUrl);

  const primaryKey = cleanLid || (match ? match.key : (nameMatch ? nameMatch.id : (cleanJid || keyFor(playerOrId))));

  if (match) {
    match.entry.rating = lookup.rating;
    match.entry.locallyModified = false;
    match.entry.tennisRecord = lookup.tennisRecord;
    match.entry.tennisRecordUrl = lookup.tennisRecordUrl;
    match.entry.tennisRecordLocation = lookup.tennisRecordLocation;
    match.entry.lastRefreshedAt = now;
    match.entry.updatedAt = now;
  } else {
    ratingsData.players[primaryKey] = {
      rating: lookup.rating,
      locallyModified: false,
      tennisRecord: lookup.tennisRecord,
      tennisRecordUrl: lookup.tennisRecordUrl,
      tennisRecordLocation: lookup.tennisRecordLocation,
      lastRefreshedAt: now,
      updatedAt: now
    };
  }
  save();

  if (lookup.tennisRecord === false) {
    await sendSuperAdminAlert(matchedName, lookup.failureReason, lookup.failureDetails, extra.sock);
  }

  return {
    name: nameMatch?.entry?.name || matchedName,
    rating: lookup.rating,
    tennisRecord: lookup.tennisRecord,
    tennisRecordUrl: lookup.tennisRecordUrl,
    tennisRecordLocation: lookup.tennisRecordLocation
  };
}

module.exports = {
  MIN_RATING,
  MAX_RATING,
  INITIAL_RATING,
  MAX_PAIR_RATING_GAP,
  formatRating,
  isPlaceholder,
  keyFor,
  getRating,
  setRating,
  getRatingMap,
  ensureRated,
  refreshPeriodicRatings,
  getAllRatings,
  pairRating,
  applyResult,
  updateRatingFromFullName,
  syncRatingsWithNames,
  resetRating,
  load,
  save,
  DATA_DIR,
  RATINGS_FILE,
  setBotSocket,
  getBotSocket,
  sendSuperAdminAlert,
  formatSuperAdminAlert,
  clearAlertsCache
};
