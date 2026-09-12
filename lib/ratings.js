/**
 * Per-player skill ratings: used to balance doubles pairings when a poll fills,
 * and moved by recorded set scores.
 *
 * A rating is a two-decimal number between MIN_RATING and MAX_RATING, starting
 * from TennisRecord.com (or INITIAL_RATING 3.49 if not found). A pairing's rating
 * is the sum of its two players', so an even court is one where the two sums are
 * within MAX_PAIR_RATING_GAP of each other.
 *
 * All arithmetic runs in integer hundredths and converts back only at the
 * edges. Ratings move in steps as small as 0.01 and are rewritten after every
 * set, so accumulating those as floats would drift off the two-decimal grid --
 * integers keep "two decimals" exactly true rather than approximately true.
 *
 * Players are keyed case-insensitively by display name, matching how
 * lib/storage.js keys the leaderboard and lib/pairHistory.js keys pairs.
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

/** A player's rating in hundredths, defaulting to the starting rating. */
function hundredthsFor(ratings, name) {
  const entry = ratings.players[keyFor(name)];
  const stored = entry && toHundredths(entry.rating);
  return Number.isFinite(stored) ? clampH(stored) : INITIAL_H;
}

function setHundredths(ratings, name, hundredths) {
  ratings.players[keyFor(name)] = {
    name: String(name).trim(),
    rating: fromHundredths(clampH(hundredths))
  };
}

/** A player's current rating. Unrated players start at INITIAL_RATING. */
function getRating(name) {
  return fromHundredths(hundredthsFor(load(), name));
}

/**
 * Explicitly sets or changes a player's rating.
 * Clamps rating between MIN_RATING and MAX_RATING.
 */
function setRating(name, rating) {
  if (!name) return null;
  const num = parseFloat(rating);
  if (!Number.isFinite(num)) return null;
  const clamped = fromHundredths(clampH(toHundredths(num)));
  const r = load();
  setHundredths(r, name, toHundredths(clamped));
  save(r);
  return clamped;
}

/**
 * Ratings for specific player ids, keyed by the id exactly as given, so callers
 * with their own ids (matchup generation) don't need to know how names are
 * normalised in here.
 */
function getRatingMap(names) {
  const ratings = load();
  return new Map(names.map((name) => [name, fromHundredths(hundredthsFor(ratings, name))]));
}

/**
 * Writes the starting rating for any of these players we haven't rated yet.
 * Queries TennisRecord to find their estimated or NTRP rating, falling back
 * to INITIAL_RATING (3.49) if not found.
 */
async function ensureRated(names) {
  const ratings = load();
  const missing = names.filter((name) => !ratings.players[keyFor(name)]);
  if (missing.length === 0) return 0;

  for (const name of missing) {
    let initialVal = INITIAL_RATING;
    try {
      const trRating = await fetchTennisRecordRating(name);
      if (trRating !== null && trRating >= MIN_RATING && trRating <= MAX_RATING) {
        initialVal = trRating;
        console.log(`[ratings] Initialized rating for "${name}" from TennisRecord: ${initialVal}`);
      } else {
        console.log(`[ratings] TennisRecord rating not found for "${name}", defaulting to ${INITIAL_RATING}`);
      }
    } catch (err) {
      console.error(`[ratings] TennisRecord error for "${name}":`, err.message);
    }
    setHundredths(ratings, name, toHundredths(initialVal));
  }
  save(ratings);
  return missing.length;
}

/** Every rated player, strongest first. */
function getAllRatings() {
  const { players } = load();
  return Object.values(players)
    .map((p) => ({ name: p.name, rating: fromHundredths(clampH(toHundredths(p.rating))) }))
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
 * pairing ratings going into that set:
 *
 *   - Favourite wins: everyone moves 0.01 per game of the margin.
 *   - Underdog wins:  the underdog takes gap * (margin / 12) off the favourite.
 *
 * Equal pairing ratings count as a favourite win -- there's no gap for the
 * upset formula to divide up, so it would otherwise move nobody at all.
 * Deltas are rounded to the nearest 0.01 to stay on the two-decimal grid.
 */
function applySet(ratings, sideA, sideB, gamesA, gamesB) {
  const margin = Math.abs(gamesA - gamesB);
  if (margin === 0) return null; // tied or unplayed set: nothing to award

  const sum = (side) => side.reduce((total, name) => total + hundredthsFor(ratings, name), 0);
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

  for (const name of winners) setHundredths(ratings, name, hundredthsFor(ratings, name) + deltaH);
  for (const name of losers) setHundredths(ratings, name, hundredthsFor(ratings, name) - deltaH);

  return {
    games: [gamesA, gamesB],
    margin,
    upset,
    delta: fromHundredths(deltaH),
    winners: [...winners],
    winnerPairRating: fromHundredths(winnerRating),
    loserPairRating: fromHundredths(loserRating)
  };
}

/**
 * Applies a whole match, set by set. Sets are scored in order and each one sees
 * the ratings the previous set left behind, since who counts as the favourite
 * can change partway through a match.
 *
 * `sets` are games from sideA's point of view, e.g. [[6, 4], [4, 6]].
 */
function applyResult(sideA, sideB, sets) {
  const ratings = load();
  const before = new Map(
    [...sideA, ...sideB].map((name) => [keyFor(name), hundredthsFor(ratings, name)])
  );

  const applied = [];
  for (const [gamesA, gamesB] of sets) {
    const result = applySet(ratings, sideA, sideB, gamesA, gamesB);
    if (result) applied.push(result);
  }

  // Everyone involved gets stored, so even a player whose only sets were ties
  // ends up rated rather than silently missing.
  for (const name of [...sideA, ...sideB]) {
    setHundredths(ratings, name, hundredthsFor(ratings, name));
  }
  save(ratings);

  const changes = [...sideA, ...sideB].map((name) => ({
    name: String(name).trim(),
    from: fromHundredths(before.get(keyFor(name))),
    to: fromHundredths(hundredthsFor(ratings, name))
  }));

  return { sets: applied, changes };
}

/** Formats a rating for display, always at two decimals. */
const formatRating = (rating) => rating.toFixed(2);

module.exports = {
  getRating,
  setRating,
  getRatingMap,
  getAllRatings,
  ensureRated,
  pairRating,
  applyResult,
  formatRating,
  keyFor,
  RATINGS_FILE,
  MIN_RATING,
  MAX_RATING,
  INITIAL_RATING,
  RATING_STEP_PER_GAME,
  UPSET_GAME_SCALE,
  MAX_PAIR_RATING_GAP
};
