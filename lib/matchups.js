/**
 * Matchup generation for tennis poll results (Singles and Doubles).
 *
 * Doubles sessions are scheduled as a whole rather than court-by-court: every
 * set re-draws the entire group, so players move between courts as well as
 * between teams instead of spending the session with the same three people.
 *
 * Picking a schedule is a small optimisation problem -- we score a candidate on
 * how many pairings it repeats (within this session, and against what the group
 * has played recently per lib/pairHistory.js), how many players are stuck on the
 * court they just came off, and how lopsided each court is by pairing rating
 * (lib/ratings.js), then keep the cheapest of many random starts.
 * Costs a few tens of milliseconds for a full group, which is fine for
 * something that runs once per poll, and reliably lands on the optimum at the
 * sizes this group actually plays.
 */

const { getPairWeights, pairKey } = require('./pairHistory');
const ratings = require('./ratings');

// Sets played per session. Rotation happens between sets, so this is also how
// many times each player changes partners.
const SETS_PER_SESSION = 2;

// Cost weights. The session penalties dwarf the history ones on purpose:
// playing with the same partner twice in one afternoon is far more noticeable
// than partnering with someone you also played with last week.
const COST_PARTNER_AGAIN_THIS_SESSION = 100;
const COST_OPPONENT_AGAIN_THIS_SESSION = 8;
const COST_PARTNER_IN_HISTORY = 10;
const COST_OPPONENT_IN_HISTORY = 1;
const COST_SAME_COURT_AS_PREVIOUS_SET = 6;

// Court balance, charged per 0.01 the two pairing ratings differ by. The gentle
// per-0.01 rate pulls courts level when nothing else is at stake; the flat
// penalty on top is what makes the search work to stay inside the tolerance.
// Sitting between the partner-repeat and opponent-repeat costs sets the
// priority: we'll hand out a repeat opponent to even up a court, but we won't
// make anyone partner the same person twice to do it.
const COST_PER_HUNDREDTH_OF_GAP = 0.1;
const COST_GAP_OVER_TOLERANCE = 40;

// Search effort. Restarts matter more than steps here -- the cost surface has
// plenty of local minima that a single hill climb settles into.
const SEARCH_RESTARTS = 40;
const SEARCH_STEPS_PER_RESTART = 300;

const PLAYERS_PER_COURT = 4;

function shuffle(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Accepts players as display names or as `{ id, name }` and normalises to the
 * latter. History is keyed by id, so ids have to be unique within a session --
 * two guests both showing as "Alex" get distinct ids rather than being treated
 * as one person who somehow partnered themselves.
 */
function normalizePlayers(players) {
  const seen = new Set();

  return players.map((p, index) => {
    const name = (typeof p === 'string' ? p : p?.name) || `Player ${index + 1}`;
    let id = String((typeof p === 'string' ? p : p?.id ?? p?.name) || name);
    while (seen.has(id)) id += `#${index + 1}`;
    seen.add(id);
    return { id, name };
  });
}

/**
 * Splits one set's player ordering into courts. Players sit four to a court in
 * the order given -- first two are team A, next two are team B -- so a plain
 * permutation is enough to describe an entire set.
 */
function courtsFromOrder(order) {
  const courts = [];
  for (let i = 0; i < order.length; i += PLAYERS_PER_COURT) {
    courts.push({
      court: courts.length + 1,
      teamA: [order[i], order[i + 1]],
      teamB: [order[i + 2], order[i + 3]]
    });
  }
  return courts;
}

function buildSchedule(orders) {
  return {
    type: 'doubles',
    sets: orders.map((order, index) => ({ set: index + 1, courts: courtsFromOrder(order) }))
  };
}

/**
 * Charges for a pairing: the session weight for each time we've already used it
 * in this schedule, plus the history weight scaled by how recently the group
 * played it. Mutates `seen` so later sets know what earlier ones used.
 */
function pairCost(seen, history, a, b, sessionWeight, historyWeight) {
  const key = pairKey(a.id, b.id);
  const usedBefore = seen.get(key) || 0;
  seen.set(key, usedBefore + 1);
  return usedBefore * sessionWeight + (history.get(key) || 0) * historyWeight;
}

/**
 * Charges for how lopsided a court is, in whole 0.01s of pairing-rating gap so
 * the comparison stays on the two-decimal grid.
 */
function balanceCost(court, ratingMap) {
  const gap = Math.abs(
    Math.round(ratings.pairRating(court.teamA.map((p) => p.id), ratingMap) * 100) -
    Math.round(ratings.pairRating(court.teamB.map((p) => p.id), ratingMap) * 100)
  );
  const tolerance = Math.round(ratings.MAX_PAIR_RATING_GAP * 100);
  return gap * COST_PER_HUNDREDTH_OF_GAP + (gap > tolerance ? COST_GAP_OVER_TOLERANCE : 0);
}

/** Total repeat/staleness/imbalance cost of a candidate schedule. Lower is better. */
function scheduleCost(schedule, weights, ratingMap) {
  const partnerSeen = new Map();
  const opponentSeen = new Map();
  let previousCourtOf = new Map();
  let cost = 0;

  for (const set of schedule.sets) {
    const courtOf = new Map();

    for (const court of set.courts) {
      for (const team of [court.teamA, court.teamB]) {
        for (let i = 0; i < team.length; i++) {
          for (let j = i + 1; j < team.length; j++) {
            cost += pairCost(
              partnerSeen, weights.partner, team[i], team[j],
              COST_PARTNER_AGAIN_THIS_SESSION, COST_PARTNER_IN_HISTORY
            );
          }
        }
      }

      for (const a of court.teamA) {
        for (const b of court.teamB) {
          cost += pairCost(
            opponentSeen, weights.opponent, a, b,
            COST_OPPONENT_AGAIN_THIS_SESSION, COST_OPPONENT_IN_HISTORY
          );
        }
      }

      for (const player of [...court.teamA, ...court.teamB]) {
        courtOf.set(player.id, court.court);
        if (previousCourtOf.get(player.id) === court.court) {
          cost += COST_SAME_COURT_AS_PREVIOUS_SET;
        }
      }

      cost += balanceCost(court, ratingMap);
    }

    previousCourtOf = courtOf;
  }

  return cost;
}

/**
 * Hill-climbs from many random starts, where a step swaps two players within
 * one set. Equal-cost swaps are accepted so the climb can drift along plateaus
 * (very common with few courts) instead of stalling at the first one it hits.
 */
function searchSchedule(players, weights, ratingMap) {
  const setCount = SETS_PER_SESSION;
  const pickIndex = (n) => Math.floor(Math.random() * n);

  let best = null;
  let bestCost = Infinity;

  for (let restart = 0; restart < SEARCH_RESTARTS; restart++) {
    const orders = Array.from({ length: setCount }, () => shuffle(players));
    let cost = scheduleCost(buildSchedule(orders), weights, ratingMap);

    for (let step = 0; step < SEARCH_STEPS_PER_RESTART; step++) {
      const order = orders[pickIndex(setCount)];
      const i = pickIndex(order.length);
      const j = pickIndex(order.length);
      if (i === j) continue;

      [order[i], order[j]] = [order[j], order[i]];
      const candidateCost = scheduleCost(buildSchedule(orders), weights, ratingMap);
      if (candidateCost <= cost) {
        cost = candidateCost;
      } else {
        [order[i], order[j]] = [order[j], order[i]];
      }
    }

    if (cost < bestCost) {
      bestCost = cost;
      best = orders.map((order) => [...order]);
    }
  }

  return buildSchedule(best);
}

/**
 * Builds a session schedule for a filled poll: one singles court for 2 players,
 * or SETS_PER_SESSION rotating doubles sets for any positive multiple of 4.
 *
 * Pass `pairWeights`/`playerRatings` to score against a specific history or set
 * of ratings (tests do this); otherwise both are loaded from disk.
 */
function generateMatchups(players, { pairWeights, playerRatings } = {}) {
  if (!Array.isArray(players) || players.length === 0) {
    throw new Error('Player list must not be empty');
  }

  const roster = normalizePlayers(players);
  const ids = roster.map((p) => p.id);

  if (roster.length === 2) {
    return {
      type: 'singles',
      ratings: playerRatings || ratings.getRatingMap(ids),
      sets: [{ set: 1, courts: [{ court: 1, teamA: [roster[0]], teamB: [roster[1]] }] }]
    };
  }

  if (roster.length % PLAYERS_PER_COURT !== 0) {
    throw new Error('Player count must be 2 for singles or a positive multiple of 4 for doubles');
  }

  const ratingMap = playerRatings || ratings.getRatingMap(ids);
  const schedule = searchSchedule(roster, pairWeights || getPairWeights(), ratingMap);
  schedule.ratings = ratingMap;
  return schedule;
}

const namesOf = (team) => team.map((p) => p.name).join(' & ');

/** "Mike & Sara (6.98)" -- the side's players plus their pairing rating. */
function describeTeam(team, ratingMap) {
  const rating = ratings.pairRating(team.map((p) => p.id), ratingMap);
  return `${namesOf(team)} (${ratings.formatRating(rating)})`;
}

/** Formats a generated schedule into a WhatsApp-friendly message. */
function formatMatchups(schedule) {
  const lines = ["🎾 All spots filled! Here are today's matchups:", ''];

  const ratingMap = schedule.ratings || new Map();

  if (schedule.type === 'singles') {
    const court = schedule.sets[0].courts[0];
    lines.push(`Court ${court.court} (Singles):`);
    lines.push(`  ${describeTeam(court.teamA, ratingMap)} vs ${describeTeam(court.teamB, ratingMap)}`);
    return lines.join('\n').trim();
  }

  // Grouped by set rather than by court: players change courts between sets, so
  // a court heading would no longer describe a fixed group of four.
  for (const set of schedule.sets) {
    lines.push(`Set ${set.set}:`);
    for (const court of set.courts) {
      const label = schedule.sets[0].courts.length > 1 ? `Court ${court.court}: ` : '';
      lines.push(`  ${label}${describeTeam(court.teamA, ratingMap)} vs ${describeTeam(court.teamB, ratingMap)}`);
    }
    lines.push('');
  }

  lines.push('(numbers are pairing ratings -- the sum of both players\' ratings)');

  return lines.join('\n').trim();
}

module.exports = { generateMatchups, formatMatchups, SETS_PER_SESSION };
