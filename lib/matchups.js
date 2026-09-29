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
function normalizePrebookedCourts(input) {
  if (!input) return { courts: [], playerCourtMap: new Map() };
  const list = Array.isArray(input) ? input : [input];
  const courts = [];
  const playerCourtMap = new Map();

  for (const item of list) {
    if (!item) continue;
    let courtStr = "";
    let playerName = null;

    if (typeof item === "string") {
      courtStr = item.trim();
    } else if (typeof item === "number") {
      courtStr = `Court ${item}`;
    } else if (typeof item === "object") {
      courtStr = item.court || item.courtName || item.name || "";
      playerName = item.player || item.defaultPlayer || item.fullName || null;
    }

    if (courtStr) {
      if (/^\d+$/.test(courtStr.trim())) {
        courtStr = `Court ${courtStr.trim()}`;
      } else if (/^ct\s*(\d+)$/i.test(courtStr.trim())) {
        courtStr = `Court ${courtStr.trim().replace(/^ct\s*/i, "")}`;
      }
      courtStr = courtStr.replace(/^court\s*(\d+)/i, (_, num) => `Court ${num}`);
      courtStr = courtStr.replace(/^pickleball\s*(\d+)/i, (_, num) => `Pickleball ${num}`);
      courtStr = courtStr.replace(/^pb\s*(\d+)/i, (_, num) => `PB ${num}`);

      courts.push(courtStr);
      if (playerName) {
        playerCourtMap.set(ratings.keyFor(playerName), courtStr);
      }
    }
  }

  const uniqueCourts = [];
  for (const c of courts) {
    if (!uniqueCourts.some(existing => existing.toLowerCase() === c.toLowerCase())) {
      uniqueCourts.push(c);
    }
  }

  return { courts: uniqueCourts, playerCourtMap };
}

function resolveCourtTitles(numCourts, prebookedCourtsList) {
  const titles = [];
  const hasPrebooked = Array.isArray(prebookedCourtsList) && prebookedCourtsList.length > 0;

  if (hasPrebooked) {
    let mCounter = 1;
    for (let i = 0; i < numCourts; i++) {
      if (i < prebookedCourtsList.length) {
        titles.push(prebookedCourtsList[i]);
      } else {
        titles.push(`M${mCounter}`);
        mCounter++;
      }
    }
  } else {
    for (let i = 0; i < numCourts; i++) {
      titles.push(`M${i + 1}`);
    }
  }

  return titles;
}

function courtsFromOrder(order, courtTitles = []) {
  const courts = [];
  let courtIdx = 0;
  for (let i = 0; i < order.length; i += PLAYERS_PER_COURT) {
    const title = (courtTitles && courtTitles[courtIdx] !== undefined)
      ? courtTitles[courtIdx]
      : (courts.length + 1);
    courts.push({
      court: title,
      teamA: [order[i], order[i + 1]],
      teamB: [order[i + 2], order[i + 3]]
    });
    courtIdx++;
  }
  return courts;
}

function buildSchedule(orders, courtTitles = []) {
  return {
    type: 'doubles',
    sets: orders.map((order, index) => ({ set: index + 1, courts: courtsFromOrder(order, courtTitles) }))
  };
}

/**
 * Charges for a pairing: the session weight for each time we've already used it
 * in this schedule, plus the history weight scaled by how recently the group
 * played it. Mutates `seen` so later sets know what earlier ones used.
 */
function normalizeFixedPairsInput(raw) {
  if (!raw) return [];
  const pairs = [];

  const extractPairFromString = (str) => {
    if (typeof str !== "string") return null;
    const parts = str.split(/\s*(?:&|\band\b|\bwith\b|\b,\b)\s*/i).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      return [parts[0], parts[1]];
    }
    return null;
  };

  if (typeof raw === "string") {
    const p = extractPairFromString(raw);
    if (p) pairs.push(p);
    return pairs;
  }

  if (Array.isArray(raw)) {
    if (raw.length === 2 && typeof raw[0] === "string" && typeof raw[1] === "string" && !raw[0].includes("&") && !raw[0].toLowerCase().includes(" and ")) {
      pairs.push([raw[0], raw[1]]);
      return pairs;
    }

    for (const item of raw) {
      if (Array.isArray(item) && item.length >= 2) {
        pairs.push([item[0], item[1]]);
      } else if (typeof item === "string") {
        const p = extractPairFromString(item);
        if (p) pairs.push(p);
      } else if (item && typeof item === "object") {
        const p1 = item.player1 || item.p1 || item.first || (Array.isArray(item.team) ? item.team[0] : null) || (Array.isArray(item.players) ? item.players[0] : null);
        const p2 = item.player2 || item.p2 || item.second || (Array.isArray(item.team) ? item.team[1] : null) || (Array.isArray(item.players) ? item.players[1] : null);
        if (p1 && p2) {
          pairs.push([p1, p2]);
        }
      }
    }
  }

  return pairs;
}

function resolveFixedPairs(roster, rawFixedPairs) {
  const normalized = normalizeFixedPairsInput(rawFixedPairs);
  if (normalized.length === 0) return [];

  const findPlayerId = (nameQuery) => {
    if (!nameQuery) return null;
    const cleanQuery = String(nameQuery).trim().toLowerCase();
    const qKey = ratings.keyFor(nameQuery);

    const exact = roster.find(
      (p) => p.name.toLowerCase() === cleanQuery || p.id.toLowerCase() === cleanQuery
    );
    if (exact) return exact.id;

    if (qKey) {
      const keyMatch = roster.find(
        (p) => ratings.keyFor(p.name) === qKey || ratings.keyFor(p.id) === qKey
      );
      if (keyMatch) return keyMatch.id;
    }

    const subMatch = roster.find((p) => {
      const pNameLower = p.name.toLowerCase();
      const pKey = ratings.keyFor(p.name);
      return (
        pNameLower.includes(cleanQuery) ||
        cleanQuery.includes(pNameLower) ||
        (qKey && pKey && (pKey.includes(qKey) || qKey.includes(pKey)))
      );
    });
    if (subMatch) return subMatch.id;

    return null;
  };

  const resolved = [];
  for (const pair of normalized) {
    if (Array.isArray(pair) && pair.length >= 2) {
      const id1 = findPlayerId(pair[0]);
      const id2 = findPlayerId(pair[1]);
      if (id1 && id2 && id1 !== id2) {
        resolved.push([id1, id2]);
      }
    }
  }
  return resolved;
}

function pairCost(seen, history, a, b, sessionWeight, historyWeight, isFixed = false) {
  const key = pairKey(a.id, b.id);
  const usedBefore = seen.get(key) || 0;
  seen.set(key, usedBefore + 1);
  if (isFixed) return 0;
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
function scheduleCost(schedule, weights, ratingMap, resolvedFixedPairs = [], fixedPairKeySet = new Set(), playerCourtMap = new Map()) {
  const partnerSeen = new Map();
  const opponentSeen = new Map();
  let previousCourtOf = new Map();
  let cost = 0;

  for (const set of schedule.sets) {
    const courtOf = new Map();

    for (const [id1, id2] of resolvedFixedPairs) {
      let pairedInThisSet = false;
      for (const court of set.courts) {
        const teamAIds = court.teamA.map((p) => p.id);
        const teamBIds = court.teamB.map((p) => p.id);
        if (
          (teamAIds.includes(id1) && teamAIds.includes(id2)) ||
          (teamBIds.includes(id1) && teamBIds.includes(id2))
        ) {
          pairedInThisSet = true;
          break;
        }
      }
      if (!pairedInThisSet) {
        cost += 50000;
      }
    }

    for (const court of set.courts) {
      const courtStr = String(court.court || "");
      const isMCourt = courtStr.startsWith("M");

      if (playerCourtMap && playerCourtMap.size > 0) {
        for (const player of [...court.teamA, ...court.teamB]) {
          const key = ratings.keyFor(player.name) || ratings.keyFor(player.id);
          const bookedCourt = playerCourtMap.get(key);
          if (bookedCourt) {
            if (isMCourt) {
              // Penalize assigning booking player to an unbooked M court
              cost += 20000;
            } else if (set.set === 1 && courtStr !== bookedCourt) {
              // Prioritize starting on their booked court in Set 1
              cost += 5000;
            }
          }
        }
      }

      for (const team of [court.teamA, court.teamB]) {
        for (let i = 0; i < team.length; i++) {
          for (let j = i + 1; j < team.length; j++) {
            const isFixed = fixedPairKeySet.has(pairKey(team[i].id, team[j].id));
            cost += pairCost(
              partnerSeen, weights.partner, team[i], team[j],
              COST_PARTNER_AGAIN_THIS_SESSION, COST_PARTNER_IN_HISTORY, isFixed
            );
          }
        }
      }

      for (const a of court.teamA) {
        for (const b of court.teamB) {
          cost += pairCost(
            opponentSeen, weights.opponent, a, b,
            COST_OPPONENT_AGAIN_THIS_SESSION, COST_OPPONENT_IN_HISTORY, false
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
function searchSchedule(players, weights, ratingMap, fixedPairs = [], courtTitles = [], playerCourtMap = new Map()) {
  const setCount = SETS_PER_SESSION;
  const pickIndex = (n) => Math.floor(Math.random() * n);
  const resolvedFixedPairs = resolveFixedPairs(players, fixedPairs);
  const fixedPairKeySet = new Set();
  for (const [id1, id2] of resolvedFixedPairs) {
    fixedPairKeySet.add(pairKey(id1, id2));
  }

  const createInitialOrder = () => {
    let unassigned = [...players];
    const order = [];

    // Prioritize fixed pairs first
    for (const [id1, id2] of resolvedFixedPairs) {
      const idx1 = unassigned.findIndex((p) => p.id === id1);
      const p1 = idx1 !== -1 ? unassigned.splice(idx1, 1)[0] : null;
      const idx2 = unassigned.findIndex((p) => p.id === id2);
      const p2 = idx2 !== -1 ? unassigned.splice(idx2, 1)[0] : null;
      if (p1 && p2) {
        order.push(p1, p2);
      }
    }

    // Place players with prebooked courts onto their prebooked courts in Set 1
    if (playerCourtMap && playerCourtMap.size > 0 && courtTitles.length > 0) {
      for (let cIdx = 0; cIdx < courtTitles.length; cIdx++) {
        const cTitle = courtTitles[cIdx];
        if (typeof cTitle === "string" && !cTitle.startsWith("M")) {
          const matchIdx = unassigned.findIndex((p) => {
            const key = ratings.keyFor(p.name) || ratings.keyFor(p.id);
            return playerCourtMap.get(key) === cTitle;
          });
          if (matchIdx !== -1) {
            order.unshift(unassigned.splice(matchIdx, 1)[0]);
          }
        }
      }
    }

    const remaining = shuffle(unassigned);
    order.push(...remaining);
    return order;
  };

  let best = null;
  let bestCost = Infinity;

  for (let restart = 0; restart < SEARCH_RESTARTS; restart++) {
    const orders = Array.from({ length: setCount }, () => createInitialOrder());
    let cost = scheduleCost(buildSchedule(orders, courtTitles), weights, ratingMap, resolvedFixedPairs, fixedPairKeySet, playerCourtMap);

    for (let step = 0; step < SEARCH_STEPS_PER_RESTART; step++) {
      const order = orders[pickIndex(setCount)];
      const i = pickIndex(order.length);
      const j = pickIndex(order.length);
      if (i === j) continue;

      [order[i], order[j]] = [order[j], order[i]];
      const candidateCost = scheduleCost(buildSchedule(orders, courtTitles), weights, ratingMap, resolvedFixedPairs, fixedPairKeySet, playerCourtMap);
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

  return buildSchedule(best, courtTitles);
}

/**
 * Builds a session schedule for a filled poll: one singles court for 2 players,
 * or SETS_PER_SESSION rotating doubles sets for any positive multiple of 4.
 *
 * Pass `pairWeights`/`playerRatings` to score against a specific history or set
 * of ratings (tests do this); otherwise both are loaded from disk.
 */
function generateMatchups(players, options = {}) {
  if (!Array.isArray(players) || players.length === 0) {
    throw new Error('Player list must not be empty');
  }

  const { pairWeights, playerRatings, fixedPairs = [], prebookedCourts = [] } = (options && typeof options === 'object' && !Array.isArray(options)) ? options : {};

  const { courts: prebookedCourtsList, playerCourtMap } = normalizePrebookedCourts(prebookedCourts);

  const roster = normalizePlayers(players);
  const ids = roster.map((p) => p.id);

  // Singles has only one possible court, so there's nothing to balance and no
  // need to look any ratings up.
  if (roster.length === 2) {
    const courtTitle = prebookedCourtsList.length > 0 ? prebookedCourtsList[0] : 'M1';
    return {
      type: 'singles',
      sets: [{ set: 1, courts: [{ court: courtTitle, teamA: [roster[0]], teamB: [roster[1]] }] }]
    };
  }

  if (roster.length % PLAYERS_PER_COURT !== 0) {
    throw new Error('Player count must be 2 for singles or a positive multiple of 4 for doubles');
  }

  const numCourts = roster.length / PLAYERS_PER_COURT;
  const courtTitles = resolveCourtTitles(numCourts, prebookedCourtsList);

  const ratingMap = playerRatings || ratings.getRatingMap(ids);
  return searchSchedule(roster, pairWeights || getPairWeights(), ratingMap, fixedPairs, courtTitles, playerCourtMap);
}

/**
 * Strips a schedule down to plain names, cheap enough to keep on poll state so
 * it survives a restart. The rating map is dropped on purpose: it's a snapshot
 * that goes stale the moment a score is recorded, and anything reading this
 * back wants the draw, not the ratings it was drawn with.
 */
function summarizeSchedule(schedule) {
  return {
    type: schedule.type,
    sets: schedule.sets.map((set) => ({
      set: set.set,
      courts: set.courts.map((court) => ({
        court: court.court,
        teamA: court.teamA.map((p) => p.name),
        teamB: court.teamB.map((p) => p.name)
      }))
    }))
  };
}

const keysOf = (names) => names.map((n) => String(n).toLowerCase()).sort();
const sameNames = (a, b) => a.length === b.length && keysOf(a).every((n, i) => n === keysOf(b)[i]);

/**
 * Looks a side up in a summarized schedule and returns the matchup it was
 * drawn into, for result reports that don't spell out both pairings ("we won",
 * "Mike beat John & Alex").
 *
 * A full pairing is always unambiguous -- the draw guarantees a pairing plays
 * together at most once per session. A single name usually isn't: across two
 * sets a doubles player has two different partners, so "Mike won" could mean
 * either team. Rather than guess and quietly move the wrong ratings, one name
 * only resolves when exactly one team fits, which `versus` often settles when
 * the opponents were named.
 *
 * Returns `{ team, opponents }`, or null when nothing fits or too much does.
 */
function findMatchupFor(summary, names, versus = null) {
  if (!summary || !Array.isArray(summary.sets) || names.length === 0) return null;

  const candidates = [];
  for (const set of summary.sets) {
    for (const court of set.courts || []) {
      for (const [team, opponents] of [[court.teamA, court.teamB], [court.teamB, court.teamA]]) {
        const fits = names.length === team.length
          ? sameNames(team, names)
          : names.every((n) => keysOf(team).includes(String(n).toLowerCase()));
        if (fits && (!versus || sameNames(opponents, versus))) {
          candidates.push({ team: [...team], opponents: [...opponents] });
        }
      }
    }
  }

  return candidates.length === 1 ? candidates[0] : null;
}

const namesOf = (team) => team.map((p) => p.name).join(' & ');

/**
 * Formats a generated schedule into a WhatsApp-friendly message.
 *
 * Ratings shape the draw but stay out of the announcement -- "!ratings" is
 * where to look them up.
 */
function formatMatchups(schedule) {
  const lines = ["🎾 All spots filled! Here are today's matchups:", ''];

  if (schedule.type === 'singles') {
    const court = schedule.sets[0].courts[0];
    const cStr = String(court.court || "Court 1").trim();
    const title = /^(?:court|pb|pickleball|m\d+|match)/i.test(cStr) ? cStr : `Court ${cStr}`;
    lines.push(`${title} (Singles):`);
    lines.push(`  ${namesOf(court.teamA)} vs ${namesOf(court.teamB)}`);
    return lines.join('\n').trim();
  }

  // Grouped by set rather than by court: players change courts between sets, so
  // a court heading would no longer describe a fixed group of four.
  for (const set of schedule.sets) {
    lines.push(`Set ${set.set}:`);
    for (const court of set.courts) {
      let label = "";
      const cStr = String(court.court || "").trim();
      const isCustomTitle = /^(?:court|pb|pickleball|m\d+|match)/i.test(cStr);
      if (schedule.sets[0].courts.length > 1 || (isCustomTitle && !/^(?:court\s*1)$/i.test(cStr))) {
        label = isCustomTitle ? `${cStr}: ` : `Court ${cStr}: `;
      }
      lines.push(`  ${label}${namesOf(court.teamA)} vs ${namesOf(court.teamB)}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

module.exports = {
  generateMatchups,
  formatMatchups,
  summarizeSchedule,
  findMatchupFor,
  resolveCourtTitles,
  normalizePrebookedCourts,
  SETS_PER_SESSION
};
