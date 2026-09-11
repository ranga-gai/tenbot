/**
 * Reads set results out of ordinary chat messages, so people can report a
 * result the way they'd say it ("Mike & Sara beat John & Alex 6-4") instead of
 * having to remember the "!score" syntax.
 *
 * This runs against every message in the group, including ones not addressed to
 * the bot, so the bar for a match is deliberately high -- a false positive
 * silently moves people's ratings, which is worse than missing a report that
 * can be re-sent as a command. Three things keep it honest:
 *
 *   - Questions are ignored outright, so "did Mike beat John?" isn't a result.
 *   - Every name has to resolve to someone the bot already knows (a rated
 *     player, a poll player, the availability list). "Mike won the lottery"
 *     doesn't parse, and neither does a result about strangers.
 *   - Anything left over after the names has to be filler ("in the first set"),
 *     not arbitrary text.
 *
 * Scores are read winner-first, matching both the "!score" command and how
 * results are normally written down. A message naming a winner but no score at
 * all is taken as a 6-3 set, which is the group's convention for "we played a
 * set and this is who won".
 */

// Assumed score when someone reports a win without giving one.
const DEFAULT_SET = [6, 3];

// Words allowed to surround the names without invalidating the report, so
// "beat John in the first set" and "won our match today" still parse.
const FILLER_WORDS = new Set([
  'a', 'at', 'by', 'first', 'for', 'in', 'it', 'just', 'last', 'match', 'now',
  'of', 'on', 'one', 'out', 'second', 'set', 'sets', 'that', 'the',
  'their', 'third', 'this', 'today', 'tonight', 'up', 'yesterday',
  '1st', '2nd', '3rd'
]);

// "6-4", "6 - 4", "7-6(5)", "6:4" -- one or more, at the end of the message.
const SCORE_TAIL = /((?:\d{1,2}\s*[-–—:]\s*\d{1,2}(?:\s*\(\d{1,2}\))?[\s,]*)+)$/;

const WINNER_FIRST = /^(.+?)\s+(?:beat|beats|beaten|defeated|defeats|def\.?|d\.|downed|downs|thrashed|smashed|crushed|took\s+down|won\s+against|beat\s+out)\s+(.+)$/i;
const LOSER_FIRST = /^(.+?)\s+(?:lost\s+to|lose\s+to|loses\s+to|fell\s+to|went\s+down\s+to)\s+(.+)$/i;
const NEUTRAL = /^(.+?)\s+(?:vs\.?|versus|v\.?)\s+(.+)$/i;
const WIN_ONLY = /^(.+?)\s+(?:won|win|wins|took\s+it)\b(.*)$/i;

const SIDE_SEPARATOR = /\s*(?:&|\+|,|\band\b|\bwith\b)\s*/i;

/** Drops leading/trailing filler words from a side, e.g. "John in the first set". */
function trimFiller(side) {
  const words = side.trim().split(/\s+/);
  while (words.length && FILLER_WORDS.has(words[0].toLowerCase())) words.shift();
  while (words.length && FILLER_WORDS.has(words[words.length - 1].toLowerCase())) words.pop();
  return words.join(' ');
}

/** True if the leftover text after the pattern is nothing but filler. */
function isOnlyFiller(text) {
  const words = (text || '').trim().split(/\s+/).filter(Boolean);
  return words.every((w) => FILLER_WORDS.has(w.replace(/[.!]+$/, '').toLowerCase()));
}

/**
 * Resolves a side to canonical player names, or null if any part of it isn't
 * someone the bot knows. Rejecting the whole side on one unknown name is what
 * stops ordinary sentences from being read as results.
 *
 * `resolveName` may return several names for one part, which is how "we"
 * becomes the sender's pairing.
 */
function resolveSide(side, resolveName) {
  const parts = trimFiller(side)
    .split(SIDE_SEPARATOR)
    .map((part) => trimFiller(part))
    .filter(Boolean);

  if (parts.length === 0 || parts.length > 2) return null;

  const names = [];
  for (const part of parts) {
    const resolved = resolveName(part);
    if (!resolved) return null;
    names.push(...(Array.isArray(resolved) ? resolved : [resolved]));
  }

  return names.length > 0 && names.length <= 2 ? names : null;
}

/** Parses a trailing score into per-set game pairs, e.g. "6-4 4-6" -> [[6,4],[4,6]]. */
function parseSets(scoreText) {
  return scoreText
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((set) => set.replace(/\s*\(\d{1,2}\)$/, '').split(/\s*[-–—:]\s*/).map(Number))
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
}

/** Which side won more sets, then more games; null if genuinely level. */
function leaderOf(sets) {
  let setsA = 0;
  let setsB = 0;
  let gamesA = 0;
  let gamesB = 0;

  for (const [a, b] of sets) {
    gamesA += a;
    gamesB += b;
    if (a > b) setsA++;
    else if (b > a) setsB++;
  }

  if (setsA !== setsB) return setsA > setsB ? 'A' : 'B';
  if (gamesA !== gamesB) return gamesA > gamesB ? 'A' : 'B';
  return null;
}

/**
 * Attempts to read a result out of `text`.
 *
 * `resolveName(raw)` returns a known player's canonical display name (or names,
 * for something like "we") or null. `findMatchup(names, versus)` looks a side
 * up in the current session's draw and returns `{ team, opponents }`, which is
 * what lets a report skip the opponents ("we won") or a partner ("Mike beat
 * John & Alex"); it returns null when the draw doesn't settle it.
 *
 * Returns null when the message isn't a result report, otherwise
 * `{ winners, losers, sets, assumedScore, inferredOpponents }`.
 */
function parseScoreReport(text, { resolveName, findMatchup = () => null } = {}) {
  if (!text || typeof text !== 'string') return null;

  const trimmed = text.trim();
  if (!trimmed || trimmed.includes('?')) return null; // a question, not a result

  const direct = parseOneSentence(trimmed, { resolveName, findMatchup });
  if (direct) return direct;

  // "Great match! Mike & Sara beat John & Alex 6-4" -- the result is one
  // sentence of several, so try them individually. Each still has to clear
  // every check on its own, so this widens what's understood without widening
  // what counts as a result. Commas aren't split on: they separate a score
  // ("6-3, 6-2") and the players on a side, so cutting there would lose sets.
  const sentences = trimmed.split(/[.!\n;]+/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length < 2) return null;

  for (const sentence of sentences) {
    const parsed = parseOneSentence(sentence, { resolveName, findMatchup });
    if (parsed) return parsed;
  }
  return null;
}

/**
 * Expands a lone name to the pairing it was drawn in, so "Mike beat John &
 * Alex" and "we won 6-2" line up against a two-player side. Only fires when
 * the sides are uneven and the draw picks out one team unambiguously.
 */
function balanceSides(winners, losers, findMatchup) {
  if (winners.length === losers.length) return [winners, losers];

  if (winners.length === 1 && losers.length === 2) {
    const found = findMatchup(winners, losers);
    return [found ? found.team : winners, losers];
  }
  if (losers.length === 1 && winners.length === 2) {
    const found = findMatchup(losers, winners);
    return [winners, found ? found.team : losers];
  }
  return [winners, losers];
}

/** Runs the patterns against a single sentence. See parseScoreReport. */
function parseOneSentence(trimmed, { resolveName, findMatchup }) {

  const scoreMatch = trimmed.match(SCORE_TAIL);
  const sets = scoreMatch ? parseSets(scoreMatch[1]) : [];
  if (scoreMatch && sets.length === 0) return null;

  const body = (scoreMatch ? trimmed.slice(0, scoreMatch.index) : trimmed)
    .replace(/[.!,;]+$/, '')
    .trim();
  if (!body) return null;

  const withScore = (winners, losers, inferredOpponents = false) => ({
    winners,
    losers,
    sets: sets.length ? sets : [DEFAULT_SET],
    assumedScore: sets.length === 0,
    inferredOpponents
  });

  /** Both sides named: even them up if one is a lone player, then accept. */
  const twoSided = (rawWinners, rawLosers) => {
    const resolvedWinners = resolveSide(rawWinners, resolveName);
    const resolvedLosers = resolveSide(rawLosers, resolveName);
    if (!resolvedWinners || !resolvedLosers) return null;

    const [winners, losers] = balanceSides(resolvedWinners, resolvedLosers, findMatchup);
    return winners.length === losers.length ? withScore(winners, losers) : null;
  };

  // "Mike & Sara beat John & Alex"
  const winnerFirst = body.match(WINNER_FIRST);
  if (winnerFirst) return twoSided(winnerFirst[1], winnerFirst[2]);

  // "John & Alex lost to Mike & Sara" -- same thing, sides swapped.
  const loserFirst = body.match(LOSER_FIRST);
  if (loserFirst) return twoSided(loserFirst[2], loserFirst[1]);

  // "Mike & Sara vs John & Alex 6-4" -- neutral, so the score picks the winner.
  const neutral = body.match(NEUTRAL);
  if (neutral) {
    if (sets.length === 0) return null; // nothing to say who won

    const sideA = resolveSide(neutral[1], resolveName);
    const sideB = resolveSide(neutral[2], resolveName);
    if (!sideA || !sideB) return null;

    const [balancedA, balancedB] = balanceSides(sideA, sideB, findMatchup);
    if (balancedA.length !== balancedB.length) return null;

    const leader = leaderOf(sets);
    if (!leader) return null;
    return leader === 'A'
      ? withScore(balancedA, balancedB)
      : { ...withScore(balancedB, balancedA), sets: sets.map(([a, b]) => [b, a]) };
  }

  // "Mike & Sara won" -- both the pairing and its opponents come from the draw.
  const winOnly = body.match(WIN_ONLY);
  if (winOnly && isOnlyFiller(winOnly[2])) {
    const side = resolveSide(winOnly[1], resolveName);
    if (!side) return null;

    const found = findMatchup(side);
    if (!found) return null;
    return withScore(found.team, found.opponents, true);
  }

  return null;
}

module.exports = { parseScoreReport, DEFAULT_SET };
