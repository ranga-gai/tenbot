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
 * Ratings are keyed by WhatsApp JID/LID in ratings.json.
 * Names and aliases are maintained separately in names.json.
 *
 * A rating is a two-decimal number between MIN_RATING and MAX_RATING, starting
 * from TennisRecord.com (or INITIAL_RATING 3.49 if not found).
 */

const fs = require('fs');
const path = require('path');
const { fetchTennisRecordRating } = require('./tennisRecord');
const pollStore = require('./pollStore');
const namesStore = require('./names');

const RATINGS_FILE = path.join(__dirname, '..', 'ratings.json');

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

function load() {
  if (!fs.existsSync(RATINGS_FILE)) return emptyRatings();
  try {
    const parsed = JSON.parse(fs.readFileSync(RATINGS_FILE, 'utf-8'));
    return { players: parsed.players && typeof parsed.players === 'object' ? parsed.players : {} };
  } catch (err) {
    console.error('⚠️ Failed to read ratings.json, starting fresh:', err.message);
    return emptyRatings();
  }
}

function save(ratings) {
  try {
    fs.writeFileSync(RATINGS_FILE, JSON.stringify(ratings, null, 2));
  } catch (err) {
    console.error('⚠️ Failed to save ratings:', err.message);
  }
}

/**
 * Ensures all players in ratings.json have corresponding entries in names.json.
 * If an entry is missing, creates it with their name / JID and empty aliases.
 */
function syncRatingsWithNames() {
  if (!fs.existsSync(RATINGS_FILE)) return 0;
  const ratingsData = load();
  const players = Object.entries(ratingsData.players || {});
  if (players.length === 0) return 0;

  const namesData = namesStore.load();
  let createdCount = 0;

  for (const [key, p] of players) {
    if (!p) continue;
    const cleanId = (p.id || (key.includes('@') ? key : null))?.trim();
    const cleanName = (p.name || (!key.includes('@') ? key : null))?.trim();

    const idKey = cleanId || key;
    if (idKey && !namesData[idKey]) {
      const displayName = cleanName || idKey;
      namesData[idKey] = {
        name: displayName,
        aliases: []
      };
      createdCount++;
    }

    if (p.lid && !namesData[p.lid]) {
      const displayName = cleanName || namesData[idKey]?.name || p.lid;
      namesData[p.lid] = {
        name: displayName,
        aliases: []
      };
      createdCount++;
    }
  }

  if (createdCount > 0) {
    namesStore.save(namesData);
    console.log(`[names] Synchronized ${createdCount} missing player entry/entries from ratings.json to names.json.`);
  }

  return createdCount;
}

// Auto-sync on startup
syncRatingsWithNames();

/**
 * Finds a player entry in ratings by JID/ID, display name, or alias.
 * Also looks up names.json for names and aliases.
 */
function findPlayer(ratingsData, idOrName, jid = null) {
  if (!idOrName && !jid) return null;
  const players = ratingsData.players || {};

  const cleanId = jid ? String(jid).trim() : null;
  const raw = idOrName ? String(idOrName).trim() : '';
  const rawKey = keyFor(raw);

  // 1. Direct ID matches in ratings
  if (cleanId && players[cleanId]) return { key: cleanId, entry: players[cleanId] };
  if (raw && players[raw]) return { key: raw, entry: players[raw] };

  // 2. Lookup in names.json by name or alias
  const nameMatch = namesStore.findIdByNameOrAlias(raw || cleanId);
  if (nameMatch && nameMatch.id) {
    const matchedId = nameMatch.id;
    if (players[matchedId]) return { key: matchedId, entry: players[matchedId] };
  }

  // 3. Search through player entries
  for (const [key, p] of Object.entries(players)) {
    if (cleanId && (p.id === cleanId || p.jid === cleanId || p.lid === cleanId || key === cleanId)) {
      return { key, entry: p };
    }
    if (raw && (p.id === raw || p.jid === raw || p.lid === raw || key === raw)) {
      return { key, entry: p };
    }
    const registeredName = namesStore.getName(key) || namesStore.getName(p.id) || p.name;
    if (registeredName && keyFor(registeredName) === rawKey) {
      return { key, entry: p };
    }
    const registeredAliases = namesStore.getAliases(key);
    if (registeredAliases.some((a) => keyFor(a) === rawKey)) {
      return { key, entry: p };
    }
  }

  // 4. Check normalized key as fallback
  if (rawKey && players[rawKey]) return { key: rawKey, entry: players[rawKey] };

  return null;
}

/** A player's rating in hundredths, defaulting to the starting rating. */
function hundredthsFor(ratingsData, idOrName, jid = null) {
  const match = findPlayer(ratingsData, idOrName, jid);
  const stored = match && match.entry && toHundredths(match.entry.rating);
  return Number.isFinite(stored) ? clampH(stored) : INITIAL_H;
}

/**
 * Sets hundredths rating for a player, updating or creating their entry by JID or Name.
 * Automatically syncs names.json with display name and aliases.
 */
function setHundredths(ratingsData, idOrName, hundredths, extra = {}) {
  const name = extra.name || (idOrName && !idOrName.includes('@') ? idOrName : null);
  if (name && isPlaceholder(name)) return;

  const cleanJid = extra.jid || (idOrName && idOrName.includes('@') ? idOrName : null);
  const match = findPlayer(ratingsData, idOrName, cleanJid);
  const newRating = fromHundredths(clampH(hundredths));
  const now = new Date().toISOString();

  const primaryKey = match ? match.key : (cleanJid || keyFor(name || idOrName));

  // Sync names.json
  if (primaryKey && name && !isPlaceholder(name)) {
    namesStore.setName(primaryKey, name, extra.aliases || []);
  }
  if (extra.lid && name && !isPlaceholder(name)) {
    namesStore.setName(extra.lid, name, extra.aliases || []);
  }

  if (match) {
    match.entry.rating = newRating;
    match.entry.updatedAt = now;
    if (extra.locallyModified !== undefined) match.entry.locallyModified = extra.locallyModified;
    if (cleanJid && !match.entry.id) match.entry.id = cleanJid;
    if (extra.lid && !match.entry.lid) match.entry.lid = extra.lid;
    if (extra.tennisRecordUrl) match.entry.tennisRecordUrl = sanitizeUrl(extra.tennisRecordUrl);
    if (extra.tennisRecordLocation) match.entry.tennisRecordLocation = extra.tennisRecordLocation;
    if (extra.lastRefreshedAt) match.entry.lastRefreshedAt = extra.lastRefreshedAt;
  } else {
    ratingsData.players[primaryKey] = {
      id: cleanJid || null,
      lid: extra.lid || null,
      rating: newRating,
      locallyModified: extra.locallyModified || false,
      tennisRecordUrl: sanitizeUrl(extra.tennisRecordUrl),
      tennisRecordLocation: extra.tennisRecordLocation || null,
      lastRefreshedAt: extra.lastRefreshedAt || now,
      updatedAt: now
    };
  }
}

/** A player's current rating. Unrated players start at INITIAL_RATING. */
function getRating(nameOrJid, jid = null) {
  return fromHundredths(hundredthsFor(load(), nameOrJid, jid));
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
  const r = load();
  setHundredths(r, nameOrJid, toHundredths(clamped), { locallyModified: true, ...extra });
  save(r);
  return clamped;
}

/**
 * Ratings for specific player ids, keyed by the id exactly as given, so callers
 * with their own ids (matchup generation) don't need to know how names are
 * normalised in here.
 */
function getRatingMap(namesOrJids) {
  const ratingsData = load();
  return new Map(namesOrJids.map((idOrName) => [idOrName, fromHundredths(hundredthsFor(ratingsData, idOrName))]));
}

/**
 * Writes the starting rating for any of these players we haven't rated yet.
 * Queries TennisRecord to find their estimated or NTRP rating and saves their
 * unique TennisRecord profile URL and location.
 */
async function ensureRated(players, jidMap = new Map()) {
  const rBefore = load();
  const playerList = Array.isArray(players) ? players : [players];

  const missing = [];
  for (const item of playerList) {
    const name = typeof item === 'object' && item !== null ? item.name : item;
    const jid = (typeof item === 'object' && item !== null ? item.jid : null) || (jidMap instanceof Map ? jidMap.get(name) : null);
    const lid = (typeof item === 'object' && item !== null ? item.lid : null);

    if (!name || isPlaceholder(name)) continue;
    const match = findPlayer(rBefore, name, jid);
    if (!match) {
      missing.push({ name, jid, lid });
    }
  }

  if (missing.length === 0) return 0;

  for (const { name, jid, lid } of missing) {
    let initialVal = INITIAL_RATING;
    let trProfileUrl = null;
    let trLocation = null;

    try {
      const trResult = await fetchTennisRecordRating(name);
      if (trResult && typeof trResult === 'object') {
        if (trResult.rating !== null && trResult.rating >= MIN_RATING && trResult.rating <= MAX_RATING) {
          initialVal = trResult.rating;
          trProfileUrl = trResult.profileUrl;
          trLocation = trResult.location;
          console.log(`[ratings] Initialized rating for "${name}" from TennisRecord: ${initialVal} (${trLocation || 'San Jose'}) -> ${trProfileUrl}`);
        } else {
          trProfileUrl = trResult.profileUrl;
          trLocation = trResult.location;
          console.log(`[ratings] TennisRecord profile found for "${name}" (${trLocation || 'Unrated'}), defaulting rating to ${INITIAL_RATING}`);
        }
      } else if (typeof trResult === 'number' && trResult >= MIN_RATING && trResult <= MAX_RATING) {
        initialVal = trResult;
      }
    } catch (err) {
      console.error(`[ratings] TennisRecord error for "${name}":`, err.message);
    }

    const current = load();
    const existing = findPlayer(current, name, jid);
    if (!existing) {
      const now = new Date().toISOString();
      setHundredths(current, jid || name, toHundredths(initialVal), {
        name,
        jid,
        lid,
        locallyModified: false,
        tennisRecordUrl: trProfileUrl,
        tennisRecordLocation: trLocation,
        lastRefreshedAt: now
      });
      save(current);
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
  const ratingsData = load();
  const now = Date.now();
  let updatedCount = 0;
  let checkedCount = 0;

  // Include all players from names.json and knownNames in pollStore
  try {
    const { knownNames, lidToPn, pnToLid } = pollStore.load();
    if (knownNames instanceof Map) {
      for (const [jid, name] of knownNames.entries()) {
        if (!name || isPlaceholder(name)) continue;
        const normJid = String(jid).trim();
        const pn = lidToPn.get(normJid) || (normJid.endsWith('@s.whatsapp.net') ? normJid : null);
        const lid = pnToLid.get(normJid) || (normJid.endsWith('@lid') ? normJid : null);

        namesStore.setName(normJid, name);
        if (pn) namesStore.setName(pn, name);
        if (lid) namesStore.setName(lid, name);

        const match = findPlayer(ratingsData, name, normJid);
        if (!match) {
          const primaryKey = pn || normJid;
          ratingsData.players[primaryKey] = {
            id: pn || normJid,
            lid: lid || null,
            rating: INITIAL_RATING,
            locallyModified: false,
            tennisRecordUrl: null,
            tennisRecordLocation: null,
            lastRefreshedAt: null,
            updatedAt: new Date().toISOString()
          };
        } else {
          if (pn && !match.entry.id) match.entry.id = pn;
          if (lid && !match.entry.lid) match.entry.lid = lid;
        }
      }
    }
  } catch (err) {
    console.error('⚠️ Failed to load knownNames during rating refresh:', err.message);
  }

  const players = Object.entries(ratingsData.players || {});

  for (const [key, p] of players) {
    const playerName = namesStore.getName(key) || namesStore.getName(p.id) || p.name;
    if (!playerName || isPlaceholder(playerName)) continue;

    const lastTime = p.lastRefreshedAt ? new Date(p.lastRefreshedAt).getTime() : 0;
    const isDue = force || !lastTime || (now - lastTime >= TWO_WEEKS_MS);

    if (!isDue) continue;

    checkedCount++;
    try {
      const trResult = await fetchTennisRecordRating(playerName, p.tennisRecordUrl);
      const isoNow = new Date().toISOString();
      p.lastRefreshedAt = isoNow;

      if (trResult && typeof trResult === 'object') {
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
      }

      save(ratingsData);

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
  const { players } = load();
  return Object.entries(players)
    .map(([key, p]) => {
      const name = namesStore.getName(key) || namesStore.getName(p.id) || p.name || key;
      if (!name || isPlaceholder(name)) return null;
      return {
        id: p.id || key,
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
function applySet(ratingsData, sideA, sideB, gamesA, gamesB) {
  const margin = Math.abs(gamesA - gamesB);
  if (margin === 0) return null; // tied or unplayed set: nothing to award

  const sum = (side) => side.reduce((total, name) => total + hundredthsFor(ratingsData, name), 0);
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
    const h = hundredthsFor(ratingsData, name);
    setHundredths(ratingsData, name, h + moveH, { locallyModified: true });
  }
  for (const name of losers) {
    const h = hundredthsFor(ratingsData, name);
    setHundredths(ratingsData, name, h - moveH, { locallyModified: true });
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
  const ratingsData = load();
  const allNames = [...winners, ...losers];
  const before = new Map(allNames.map((n) => [n, fromHundredths(hundredthsFor(ratingsData, n))]));

  const appliedSets = [];
  for (const [gamesA, gamesB] of sets) {
    const res = applySet(ratingsData, winners, losers, gamesA, gamesB);
    if (res) appliedSets.push(res);
  }

  save(ratingsData);

  const after = new Map(allNames.map((n) => [n, fromHundredths(hundredthsFor(ratingsData, n))]));
  const changes = allNames.map((name) => ({
    name,
    from: before.get(name),
    to: after.get(name)
  }));

  return { sets: appliedSets, changes };
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
  pairRating,
  ensureRated,
  refreshPeriodicRatings,
  getAllRatings,
  applySet,
  applyResult,
  syncRatingsWithNames
};
