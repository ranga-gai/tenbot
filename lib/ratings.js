/**
 * Per-player skill ratings: used to balance doubles pairings when a poll fills,
 * and moved by recorded set scores.
 *
 * Ratings are keyed by WhatsApp JID (phone number JID or LID) when available,
 * with fallback to normalized name keys for legacy records or guest players.
 *
 * A rating is a two-decimal number between MIN_RATING and MAX_RATING, starting
 * from TennisRecord.com (or INITIAL_RATING 3.49 if not found).
 */

const fs = require('fs');
const path = require('path');
const { fetchTennisRecordRating } = require('./tennisRecord');

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

const toHundredths = (rating) => Math.round(rating * 100);
const fromHundredths = (hundredths) => hundredths / 100;

const MIN_H = toHundredths(MIN_RATING);
const MAX_H = toHundredths(MAX_RATING);
const INITIAL_H = toHundredths(INITIAL_RATING);
const STEP_PER_GAME_H = toHundredths(RATING_STEP_PER_GAME);

const clampH = (h) => Math.min(MAX_H, Math.max(MIN_H, h));

/** Case-insensitive lookup key for a player's display name. */
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
    console.error('⚠️  Failed to read ratings.json, starting fresh:', err.message);
    return emptyRatings();
  }
}

function save(ratings) {
  try {
    fs.writeFileSync(RATINGS_FILE, JSON.stringify(ratings, null, 2));
  } catch (err) {
    console.error('⚠️  Failed to save ratings:', err.message);
  }
}

/**
 * Finds a player entry in ratings by JID, LID, or display name.
 */
function findPlayer(ratingsData, idOrName, jid = null) {
  if (!idOrName && !jid) return null;
  const players = ratingsData.players || {};

  const cleanId = jid ? String(jid).trim() : null;
  const raw = idOrName ? String(idOrName).trim() : '';
  const rawKey = keyFor(raw);

  // 1. Check exact key in store (JID key or legacy name key)
  if (cleanId && players[cleanId]) return { key: cleanId, entry: players[cleanId] };
  if (raw && players[raw]) return { key: raw, entry: players[raw] };
  if (rawKey && players[rawKey]) return { key: rawKey, entry: players[rawKey] };

  // 2. Search through player entries by JID/LID or name match
  for (const [key, p] of Object.entries(players)) {
    if (cleanId && (p.id === cleanId || p.jid === cleanId || p.lid === cleanId)) {
      return { key, entry: p };
    }
    if (raw && (p.id === raw || p.jid === raw || p.lid === raw)) {
      return { key, entry: p };
    }
    if (p.name && keyFor(p.name) === rawKey) {
      return { key, entry: p };
    }
  }

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
 */
function setHundredths(ratingsData, idOrName, hundredths, extra = {}) {
  const name = extra.name || (idOrName && !idOrName.includes('@') ? idOrName : null);
  if (name && isPlaceholder(name)) return;

  const match = findPlayer(ratingsData, idOrName, extra.jid);
  const newRating = fromHundredths(clampH(hundredths));
  const now = new Date().toISOString();

  if (match) {
    match.entry.rating = newRating;
    match.entry.updatedAt = now;
    if (name && !isPlaceholder(name)) match.entry.name = String(name).trim();
    if (extra.jid && !match.entry.id) match.entry.id = extra.jid;
    if (extra.lid && !match.entry.lid) match.entry.lid = extra.lid;
    if (extra.tennisRecordUrl) match.entry.tennisRecordUrl = extra.tennisRecordUrl;
    if (extra.tennisRecordLocation) match.entry.tennisRecordLocation = extra.tennisRecordLocation;
  } else {
    const primaryKey = extra.jid || (idOrName && idOrName.includes('@') ? idOrName : keyFor(name || idOrName));
    ratingsData.players[primaryKey] = {
      id: extra.jid || (idOrName && idOrName.includes('@') ? idOrName : null),
      lid: extra.lid || null,
      name: String(name || idOrName).trim(),
      rating: newRating,
      tennisRecordUrl: extra.tennisRecordUrl || null,
      tennisRecordLocation: extra.tennisRecordLocation || null,
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
  setHundredths(r, nameOrJid, toHundredths(clamped), extra);
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
      setHundredths(current, jid || name, toHundredths(initialVal), {
        name,
        jid,
        lid,
        tennisRecordUrl: trProfileUrl,
        tennisRecordLocation: trLocation
      });
      save(current);
    }
  }
  return missing.length;
}

/** Every rated player, strongest first. */
function getAllRatings() {
  const { players } = load();
  return Object.values(players)
    .filter((p) => p && p.name && !isPlaceholder(p.name))
    .map((p) => ({
      id: p.id || null,
      name: p.name,
      rating: fromHundredths(clampH(toHundredths(p.rating))),
      tennisRecordUrl: p.tennisRecordUrl || null,
      tennisRecordLocation: p.tennisRecordLocation || null
    }))
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
  const deltaH = upset
    ? Math.round((loserRating - winnerRating) * margin / UPSET_GAME_SCALE)
    : STEP_PER_GAME_H * margin;

  for (const name of winners) setHundredths(ratingsData, name, hundredthsFor(ratingsData, name) + deltaH);
  for (const name of losers) setHundredths(ratingsData, name, hundredthsFor(ratingsData, name) - deltaH);

  return {
    winners,
    losers,
    gamesWon: Math.max(gamesA, gamesB),
    gamesLost: Math.min(gamesA, gamesB),
    delta: fromHundredths(deltaH),
    upset
  };
}

/**
 * Updates ratings for a full match and returns a summary of what moved.
 */
function applyResult(winners, losers, sets) {
  const ratingsData = load();
  const before = {};
  for (const name of [...winners, ...losers]) {
    before[name] = fromHundredths(hundredthsFor(ratingsData, name));
  }

  const setResults = [];
  for (const [gamesA, gamesB] of sets) {
    const res = applySet(ratingsData, winners, losers, gamesA, gamesB);
    if (res) setResults.push(res);
  }

  save(ratingsData);

  const changes = [...winners, ...losers]
    .filter((name) => !isPlaceholder(name))
    .map((name) => {
      const from = before[name];
      const to = fromHundredths(hundredthsFor(ratingsData, name));
      return { name, from, to };
    });

  return { sets: setResults, changes };
}

module.exports = {
  MIN_RATING,
  MAX_RATING,
  INITIAL_RATING,
  MAX_PAIR_RATING_GAP,
  keyFor,
  formatRating,
  isPlaceholder,
  getRating,
  setRating,
  getRatingMap,
  ensureRated,
  getAllRatings,
  pairRating,
  applySet,
  applyResult
};
