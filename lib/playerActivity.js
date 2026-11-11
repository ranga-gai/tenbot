/**
 * Player Activity Tracker
 * -----------------------
 * Tracks player activity across three dimensions:
 *   - played: last time they played (were in a lineup)
 *   - voted: last time they voted in a poll
 *   - messaged: last time they sent a message
 *
 * Tracks weekly activity counts (messages, votes, lineups) per player.
 * Checks inactivity milestones (50% encouragement, 75% participation check, 100% inactive DM to notifications).
 * Persists to data/player-activity.json once a day and on process exit.
 */

const fs = require('fs');
const path = require('path');
const namesStore = require('./names');
const groupsConfig = require('./groupsConfig');
const messageHistory = require('./messageHistory');
const { DATA_DIR } = require('./paths');

const ACTIVITY_FILE = path.join(DATA_DIR, 'player-activity.json');

const GENERIC_NAMES = new Set(['someone', 'player', 'player 1', 'player 2', 'player 3', 'player 4', 'me', 'tenbot', '@tenbot']);

function isTenbot(idOrName) {
  if (!idOrName) return false;
  const s = String(idOrName).trim().toLowerCase().replace(/^@+/, "");
  return (
    s === "tenbot" ||
    s === "24104010813588@lid" ||
    s === "16693124812@s.whatsapp.net" ||
    s === "24104010813588" ||
    s === "16693124812"
  );
}

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const DEFAULT_INACTIVE_WEEKS = 12;
const DEFAULT_INACTIVE_DAYS = 30;

function cleanStr(s) {
  return typeof s === 'string' ? s.trim() : '';
}

function toIsoString(val) {
  if (!val) return null;
  if (val instanceof Date) {
    return Number.isNaN(val.getTime()) ? null : val.toISOString();
  }
  if (typeof val === 'number') {
    if (!Number.isFinite(val) || val <= 0) return null;
    const ms = val < 1e11 ? val * 1000 : val;
    return new Date(ms).toISOString();
  }
  if (typeof val === 'string') {
    const s = val.trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) {
      const num = parseInt(s, 10);
      const ms = num < 1e11 ? num * 1000 : num;
      return new Date(ms).toISOString();
    }
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function toMs(isoOrVal) {
  if (!isoOrVal) return 0;
  if (typeof isoOrVal === 'number') {
    if (!Number.isFinite(isoOrVal) || isoOrVal <= 0) return 0;
    return isoOrVal < 1e11 ? isoOrVal * 1000 : isoOrVal;
  }
  const d = new Date(isoOrVal);
  const ms = d.getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Returns the ISO week key 'YYYY-Www' for a given timestamp,
 * calculated according to America/Los_Angeles local date.
 */
function getWeekKey(val = Date.now()) {
  const ms = toMs(val) || Date.now();
  const d = new Date(ms);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric'
  });
  const parts = formatter.formatToParts(d);
  const yearVal = parseInt(parts.find((p) => p.type === 'year').value, 10);
  const monthVal = parseInt(parts.find((p) => p.type === 'month').value, 10);
  const dayVal = parseInt(parts.find((p) => p.type === 'day').value, 10);

  const localDate = new Date(Date.UTC(yearVal, monthVal - 1, dayVal));
  const dayNr = (localDate.getUTCDay() + 6) % 7; // Monday = 0, Sunday = 6
  localDate.setUTCDate(localDate.getUTCDate() - dayNr + 3);
  const firstThursday = localDate.valueOf();
  const year = new Date(firstThursday).getUTCFullYear();
  localDate.setUTCFullYear(year, 0, 4);
  const startDay = (localDate.getUTCDay() + 6) % 7;
  localDate.setUTCDate(localDate.getUTCDate() - startDay + 3);
  const weekNum = 1 + Math.round((firstThursday - localDate.valueOf()) / 604800000);
  return `${year}-W${String(weekNum).padStart(2, '0')}`;
}

function loadFromDisk() {
  if (!fs.existsSync(ACTIVITY_FILE)) return {};
  try {
    const raw = fs.readFileSync(ACTIVITY_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    for (const [key, val] of Object.entries(parsed)) {
      if (isTenbot(key) || isTenbot(val?.name)) {
        delete parsed[key];
      }
    }
    return parsed;
  } catch (err) {
    console.error('⚠️ Failed to read player-activity.json:', err.message);
    return {};
  }
}

let store = loadFromDisk();

function load() {
  return store;
}

function save(data = null) {
  if (data && typeof data === 'object') {
    store = data;
  }
  try {
    pruneAllWeeklyActivity();
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(ACTIVITY_FILE, JSON.stringify(store || {}, null, 2));
  } catch (err) {
    console.error('⚠️ Failed to save player-activity.json:', err.message);
  }
}


/**
 * Prunes weekly activity entries older than the configured inactivity period (e.g. 12 weeks).
 */
function pruneWeeklyActivity(entry, maxWeeks = null, now = Date.now()) {
  if (!entry || !entry.weekly || typeof entry.weekly !== 'object') return;
  const weeks = maxWeeks !== null && maxWeeks !== undefined ? maxWeeks : groupsConfig.getInactivityPeriodWeeks();
  const cutoffMs = now - (weeks * 7 * MS_PER_DAY);
  const cutoffWeekKey = getWeekKey(cutoffMs);

  for (const weekKey of Object.keys(entry.weekly)) {
    if (weekKey < cutoffWeekKey) {
      delete entry.weekly[weekKey];
    }
  }
}

/**
 * Prunes old weekly activity entries across all players in store.
 */
function pruneAllWeeklyActivity(maxWeeks = null, now = Date.now()) {
  const weeks = maxWeeks !== null && maxWeeks !== undefined ? maxWeeks : groupsConfig.getInactivityPeriodWeeks();
  for (const entry of Object.values(store)) {
    pruneWeeklyActivity(entry, weeks, now);
  }
}

function reset() {
  store = {};
}

/**
 * Resolves a player identifier (LID, PN, or name) to a canonical key and display name.
 */
function resolveCanonicalPlayerKey(playerOrJid, chatId = null) {
  if (!playerOrJid) return null;
  let target = playerOrJid;
  if (typeof target === 'object') {
    target = target.lid || target.id || target.jid || target.name || '';
  }
  target = cleanStr(target);
  if (!target) return null;

  target = target.replace(/^@+/, '').trim();
  if (target.includes(':') && (target.endsWith('@lid') || target.endsWith('@s.whatsapp.net'))) {
    target = target.replace(/:\d+@/, '@');
  }

  if (isTenbot(target)) return null;

  // 1. WhatsApp LID or PN
  if (target.endsWith('@lid') || target.endsWith('@s.whatsapp.net')) {
    const canonical = namesStore.resolveCanonicalId(target);
    let resolvedName = namesStore.getName(canonical) || namesStore.getName(target);
    if (!resolvedName || resolvedName === 'Player') {
      const pn = namesStore.getPnByLid(canonical || target);
      resolvedName = pn ? `Player (${pn.split('@')[0].slice(-4)})` : target;
    }
    return {
      key: canonical || target,
      name: resolvedName,
      id: canonical || target
    };
  }

  // 1b. Pure digits: check if it resolves to a registered player's LID or phone number
  if (/^\d+$/.test(target)) {
    const canonical = namesStore.resolveCanonicalId(target);
    if (canonical && (canonical.endsWith('@lid') || canonical.endsWith('@s.whatsapp.net'))) {
      let resolvedName = namesStore.getName(canonical) || namesStore.getName(target);
      if (!resolvedName || resolvedName === 'Player') {
        const pn = namesStore.getPnByLid(canonical);
        resolvedName = pn ? `Player (${pn.split('@')[0].slice(-4)})` : target;
      }
      return {
        key: canonical,
        name: resolvedName,
        id: canonical
      };
    }
    const match = namesStore.findIdByNameOrAlias(target, chatId);
    if (match && match.id) {
      const canon = namesStore.resolveCanonicalId(match.id);
      let resolvedName = match.entry?.name || match.entry?.fullName || namesStore.getName(canon);
      if (!resolvedName || resolvedName === 'Player') {
        resolvedName = target;
      }
      return {
        key: canon || match.id,
        name: resolvedName,
        id: canon || match.id
      };
    }
  }

  // 2. Name or alias lookup in namesStore
  const match = namesStore.findIdByNameOrAlias(target, chatId);
  if (match && match.id) {
    const canonical = namesStore.resolveCanonicalId(match.id);
    let resolvedName = match.entry?.name || match.entry?.fullName;
    if (!resolvedName || resolvedName === 'Player') {
      resolvedName = target;
    }
    return {
      key: canonical || match.id,
      name: resolvedName,
      id: canonical || match.id
    };
  }

  // 3. Fallback: normalized clean name
  return {
    key: target.toLowerCase(),
    name: target,
    id: null
  };
}

function getOrCreateEntry(resolved) {
  const { key, name, id } = resolved;
  let entry = store[key];

  // If keyed by name earlier and now have canonical ID, migrate/merge
  if (id && id !== key && store[id]) {
    entry = store[id];
  } else if (!entry && name && store[name.toLowerCase()]) {
    entry = store[name.toLowerCase()];
    delete store[name.toLowerCase()];
    store[key] = entry;
  }

  if (!entry) {
    entry = {
      name: (name && name !== 'Player') ? name : key,
      played: null,
      voted: null,
      messaged: null,
      weekly: {},
      status: 'active',
      warnings: {
        halfwaySent: false,
        threeQuarterSent: false,
        inactiveSent: false
      },
      created: new Date().toISOString()
    };
    store[key] = entry;
  }

  if (!entry.weekly) entry.weekly = {};
  if (!entry.status) entry.status = 'active';
  if (!entry.warnings) {
    entry.warnings = {
      halfwaySent: false,
      threeQuarterSent: false,
      inactiveSent: false
    };
  }
  if (!entry.created) {
    entry.created = entry.createdAt || entry.played || entry.voted || entry.messaged || new Date().toISOString();
  }

  if (name && name !== 'Player' && (!entry.name || entry.name.toLowerCase() === key.toLowerCase() || entry.name === 'Player')) {
    entry.name = name;
  }

  return entry;
}

function computeLatest(played, voted, messaged) {
  const pMs = toMs(played);
  const vMs = toMs(voted);
  const mMs = toMs(messaged);

  const maxMs = Math.max(pMs, vMs, mMs);
  if (maxMs <= 0) {
    return { time: null, timeMs: 0, type: null };
  }

  // Priority if equal: played > voted > messaged
  if (maxMs === pMs) {
    return { time: played, timeMs: pMs, type: 'played' };
  }
  if (maxMs === vMs) {
    return { time: voted, timeMs: vMs, type: 'voted' };
  }
  return { time: messaged, timeMs: mMs, type: 'messaged' };
}

/**
 * Records activity of a specific type ('played', 'voted', 'messaged').
 * Only updates if the new timestamp is >= the existing timestamp for that type.
 * Also increments weekly activity counts (messages, votes, lineups) and reactivates the player.
 */
function recordActivity(playerOrJid, type, timestamp = Date.now(), chatId = null) {
  if (!['played', 'voted', 'messaged'].includes(type)) return null;
  if (isTenbot(playerOrJid)) return null;

  const resolved = resolveCanonicalPlayerKey(playerOrJid, chatId);
  if (!resolved || !resolved.key) return null;
  if (GENERIC_NAMES.has(resolved.key.toLowerCase()) || isTenbot(resolved.key) || isTenbot(resolved.name)) return null;

  const entry = getOrCreateEntry(resolved);
  const newIso = toIsoString(timestamp);
  const newMs = toMs(newIso);
  if (newMs <= 0) return entry;

  const currentMs = toMs(entry[type]);
  if (newMs >= currentMs) {
    entry[type] = newIso;
  }

  // Update weekly activity count
  const weekKey = getWeekKey(newMs);
  if (!entry.weekly) entry.weekly = {};
  if (!entry.weekly[weekKey]) {
    entry.weekly[weekKey] = { messages: 0, votes: 0, lineups: 0 };
  }
  if (type === 'messaged') {
    entry.weekly[weekKey].messages = (entry.weekly[weekKey].messages || 0) + 1;
  } else if (type === 'voted') {
    entry.weekly[weekKey].votes = (entry.weekly[weekKey].votes || 0) + 1;
  } else if (type === 'played') {
    entry.weekly[weekKey].lineups = (entry.weekly[weekKey].lineups || 0) + 1;
  }

  // Prune weekly entries older than inactivity period
  const configuredWeeks = chatId ? groupsConfig.getInactivityPeriodWeeks(chatId) : groupsConfig.getInactivityPeriodWeeks();
  pruneWeeklyActivity(entry, configuredWeeks, newMs);

  // Reactivate player and reset milestone warnings upon any activity
  entry.status = 'active';
  delete entry.inactiveAt;
  if (!entry.warnings) {
    entry.warnings = { halfwaySent: false, threeQuarterSent: false, inactiveSent: false };
  } else {
    entry.warnings.halfwaySent = false;
    entry.warnings.threeQuarterSent = false;
    entry.warnings.inactiveSent = false;
  }

  return entry;
}

/**
 * Records that player(s) played (were in a lineup).
 * Accepts a single player or an array of players.
 */
function recordPlayed(playerOrPlayers, timestamp = Date.now(), chatId = null) {
  if (Array.isArray(playerOrPlayers)) {
    const results = [];
    for (const p of playerOrPlayers) {
      if (p) results.push(recordActivity(p, 'played', timestamp, chatId));
    }
    return results;
  }
  return recordActivity(playerOrPlayers, 'played', timestamp, chatId);
}

/**
 * Records that a player voted in a poll.
 */
function recordVoted(playerOrJid, timestamp = Date.now(), chatId = null) {
  return recordActivity(playerOrJid, 'voted', timestamp, chatId);
}

/**
 * Records that a player sent a message.
 */
function recordMessaged(playerOrJid, timestamp = Date.now(), chatId = null) {
  return recordActivity(playerOrJid, 'messaged', timestamp, chatId);
}

/**
 * Returns the detailed activity record for a player.
 */
function getPlayerActivity(playerOrJid, chatId = null) {
  const resolved = resolveCanonicalPlayerKey(playerOrJid, chatId);
  if (!resolved || !resolved.key) return null;

  let raw = store[resolved.key];
  if (!raw && resolved.id) {
    raw = store[resolved.id];
  }
  if (!raw && resolved.name) {
    raw = store[resolved.name.toLowerCase()];
  }
  if (!raw && resolved.name) {
    for (const [, v] of Object.entries(store)) {
      if (v.name && v.name.toLowerCase() === resolved.name.toLowerCase()) {
        raw = v;
        break;
      }
    }
  }

  const played = raw?.played || null;
  const voted = raw?.voted || null;
  const messaged = raw?.messaged || null;

  const latest = computeLatest(played, voted, messaged);
  let displayName = raw?.name;
  if (!displayName || displayName === 'Player' || displayName.toLowerCase() === resolved.key.toLowerCase()) {
    displayName = resolved.name && resolved.name !== 'Player' ? resolved.name : (raw?.name || resolved.key);
  }

  return {
    id: resolved.id || resolved.key,
    key: resolved.key,
    name: displayName,
    played,
    voted,
    messaged,
    playedAt: played,
    votedAt: voted,
    messagedAt: messaged,
    latestTime: latest.time,
    latestTimeMs: latest.timeMs,
    latestType: latest.type,
    latestActivityAt: latest.time,
    weekly: raw?.weekly || {},
    status: raw?.status || 'active',
    warnings: raw?.warnings || { halfwaySent: false, threeQuarterSent: false, inactiveSent: false },
    created: raw?.created || null,
    inactiveAt: raw?.inactiveAt || null
  };
}

/**
 * Returns the weekly activity map for a player.
 */
function getWeeklyActivity(playerOrJid, chatId = null) {
  const act = getPlayerActivity(playerOrJid, chatId);
  return act?.weekly || {};
}

/**
 * Returns an object with the single latest activity time and type for a player,
 * or null if no activity has been recorded for them.
 */
function getLatestActivity(playerOrJid, chatId = null) {
  const act = getPlayerActivity(playerOrJid, chatId);
  if (!act || !act.latestTime) return null;
  return {
    id: act.id,
    key: act.key,
    name: act.name,
    latestTime: act.latestTime,
    latestTimeMs: act.latestTimeMs,
    latestType: act.latestType,
    time: act.latestTime,
    type: act.latestType,
    status: act.status || 'active'
  };
}

/**
 * Returns just the single latest activity ISO string (or null) for a player.
 */
function getLatestActivityTime(playerOrJid, chatId = null) {
  const act = getPlayerActivity(playerOrJid, chatId);
  return act?.latestTime || null;
}

/**
 * Returns all player activity records, sorted by latest activity descending.
 * If chatId is provided, filters to members of that group.
 */
function getAllActivity(chatId = null) {
  const results = [];
  const seenKeys = new Set();
  const seenNames = new Set();

  for (const key of Object.keys(store)) {
    if (isTenbot(key) || isTenbot(store[key]?.name)) {
      continue;
    }
    if (chatId && !namesStore.isMemberOfGroup(chatId, key)) {
      continue;
    }
    const act = getPlayerActivity(key, chatId);
    if (!act || isTenbot(act.key) || isTenbot(act.id) || isTenbot(act.name)) {
      continue;
    }
    const nKey = (act?.name || '').toLowerCase();
    if (!seenKeys.has(act.key) && (!nKey || !seenNames.has(nKey))) {
      seenKeys.add(act.key);
      if (nKey) seenNames.add(nKey);
      results.push(act);
    }
  }

  results.sort((a, b) => b.latestTimeMs - a.latestTimeMs);
  return results;
}

/**
 * Parses duration strings into milliseconds.
 * Supports: '30d', '30 days', '2w', '2 weeks', '1m', '1 month', '24h', '1y', or numeric days.
 */
function parsePeriod(periodStrOrNum) {
  if (typeof periodStrOrNum === 'number') {
    if (!Number.isFinite(periodStrOrNum) || periodStrOrNum <= 0) {
      return DEFAULT_INACTIVE_DAYS * MS_PER_DAY;
    }
    return periodStrOrNum > 1e7 ? periodStrOrNum : periodStrOrNum * MS_PER_DAY;
  }

  if (!periodStrOrNum || typeof periodStrOrNum !== 'string') {
    return DEFAULT_INACTIVE_DAYS * MS_PER_DAY;
  }

  const clean = periodStrOrNum.trim().toLowerCase();
  if (/^\d+$/.test(clean)) {
    const days = parseInt(clean, 10);
    return (days > 0 ? days : DEFAULT_INACTIVE_DAYS) * MS_PER_DAY;
  }

  const match = clean.match(/^(\d+(?:\.\d+)?)\s*(d|days?|w|weeks?|m|months?|y|years?|h|hours?)$/i);
  if (match) {
    const num = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    if (unit.startsWith('h')) return Math.round(num * MS_PER_HOUR);
    if (unit.startsWith('d')) return Math.round(num * MS_PER_DAY);
    if (unit.startsWith('w')) return Math.round(num * 7 * MS_PER_DAY);
    if (unit.startsWith('m')) return Math.round(num * 30 * MS_PER_DAY);
    if (unit.startsWith('y')) return Math.round(num * 365 * MS_PER_DAY);
  }

  return DEFAULT_INACTIVE_DAYS * MS_PER_DAY;
}

/**
 * Resolves all candidate players for a group.
 */
function getGroupPlayerCandidates(chatId = null) {
  const playersMap = new Map(); // canonicalKey -> { id, name }

  const groupSet = chatId ? namesStore.getGroupMembers(chatId) : null;
  const hasGroupSet = Boolean(groupSet && groupSet.size > 0);

  if (chatId) {
    // A. If namesStore has group members for this chatId
    if (hasGroupSet) {
      const allNames = namesStore.getAllEntries ? namesStore.getAllEntries() : [];
      for (const entry of allNames) {
        const canonicalId = entry.id || entry.lid || (entry.pn ? namesStore.getLidByPn(entry.pn) : null);
        if (canonicalId && !isTenbot(canonicalId) && !isTenbot(entry.name) && namesStore.isMemberOfGroup(chatId, canonicalId)) {
          playersMap.set(canonicalId, {
            id: canonicalId,
            name: entry.name || entry.fullName || namesStore.getName(canonicalId)
          });
        }
      }
    }

    // B. Default booking players and direct accounts for this group from groups.json
    const defaultPlayers = groupsConfig.getDefaultBookingPlayers(chatId) || [];
    const directAccounts = groupsConfig.getDirectCourtBookingAccounts(chatId);
    for (const p of defaultPlayers) {
      if (isTenbot(p)) continue;
      const resolved = resolveCanonicalPlayerKey(p, chatId);
      if (resolved && resolved.key && !playersMap.has(resolved.key)) {
        playersMap.set(resolved.key, {
          id: resolved.id || resolved.key,
          name: resolved.name || p
        });
      }
    }
    if (directAccounts && typeof directAccounts.forEach === 'function') {
      directAccounts.forEach((acc) => {
        const resolved = resolveCanonicalPlayerKey(acc, chatId);
        if (resolved && resolved.key && !playersMap.has(resolved.key)) {
          playersMap.set(resolved.key, {
            id: resolved.id || resolved.key,
            name: resolved.name || acc
          });
        }
      });
    }

    // C. Tracked players in store that belong to this group
    for (const [key, val] of Object.entries(store)) {
      if (isTenbot(key) || isTenbot(val?.name)) continue;
      if (hasGroupSet && !namesStore.isMemberOfGroup(chatId, key)) {
        continue;
      }
      if (!playersMap.has(key)) {
        playersMap.set(key, {
          id: key,
          name: val.name || namesStore.getName(key) || key
        });
      }
    }
  } else {
    // If no chatId provided, include all tracked players in store
    for (const [key, val] of Object.entries(store)) {
      if (isTenbot(key) || isTenbot(val?.name)) continue;
      playersMap.set(key, {
        id: key,
        name: val.name || namesStore.getName(key) || key
      });
    }
  }

  // Deduplicate candidates by name and key
  const deduped = [];
  const seenKeys = new Set();
  const seenNames = new Set();
  for (const player of playersMap.values()) {
    const k = (player.id || player.name || '').toLowerCase();
    const n = (player.name || '').toLowerCase();
    if (seenKeys.has(k) || (n && seenNames.has(n))) {
      continue;
    }
    seenKeys.add(k);
    if (n) seenNames.add(n);
    deduped.push(player);
  }

  return deduped;
}

/**
 * Lists inactive players whose last activity time is before the configured time period
 * for the group from the latest time across players.
 */
function getInactivePlayers({ groupJid = null, period = null, referenceTime = null } = {}) {
  const groupPlayers = getGroupPlayerCandidates(groupJid);

  // 1. Calculate the latest activity time across the group as reference anchor
  let maxTimeMs = 0;
  for (const player of groupPlayers) {
    const act = getPlayerActivity(player.id || player.name, groupJid);
    if (act && act.latestTimeMs > maxTimeMs) {
      maxTimeMs = act.latestTimeMs;
    }
  }

  const referenceTimeMs = referenceTime
    ? toMs(referenceTime)
    : (maxTimeMs > 0 ? maxTimeMs : Date.now());

  // 2. Determine period and cutoff
  let periodMs;
  let periodWeeks;
  if (period) {
    periodMs = parsePeriod(period);
    periodWeeks = Math.max(1, Math.round(periodMs / (7 * MS_PER_DAY)));
  } else if (groupJid) {
    periodWeeks = groupsConfig.getInactivityPeriodWeeks(groupJid);
    periodMs = periodWeeks * 7 * MS_PER_DAY;
  } else {
    periodWeeks = DEFAULT_INACTIVE_WEEKS;
    periodMs = periodWeeks * 7 * MS_PER_DAY;
  }
  const cutoffMs = referenceTimeMs - periodMs;

  // 3. Identify inactive players
  const inactivePlayers = [];

  for (const player of groupPlayers) {
    const act = getPlayerActivity(player.id || player.name, groupJid);
    const lastMs = act?.latestTimeMs || 0;

    if (lastMs <= 0 || lastMs < cutoffMs) {
      const inactiveDurationMs = lastMs > 0 ? Math.max(0, referenceTimeMs - lastMs) : null;
      inactivePlayers.push({
        id: player.id,
        name: player.name || act?.name || player.id,
        status: act?.status || 'inactive',
        latestTime: act?.latestTime || null,
        latestTimeMs: lastMs > 0 ? lastMs : null,
        latestType: act?.latestType || null,
        neverActive: lastMs <= 0,
        inactiveDurationMs,
        inactiveDays: inactiveDurationMs !== null ? Math.floor(inactiveDurationMs / MS_PER_DAY) : null,
        inactiveWeeks: inactiveDurationMs !== null ? Math.floor(inactiveDurationMs / (7 * MS_PER_DAY)) : null
      });
    }
  }

  // Sort: never active first, then longest inactive first (lowest latestTimeMs)
  inactivePlayers.sort((a, b) => {
    if (a.neverActive && !b.neverActive) return -1;
    if (!a.neverActive && b.neverActive) return 1;
    return (a.latestTimeMs || 0) - (b.latestTimeMs || 0);
  });

  return {
    referenceTime: toIsoString(referenceTimeMs),
    referenceTimeMs,
    periodMs,
    periodDays: Math.round(periodMs / MS_PER_DAY),
    periodWeeks,
    cutoff: toIsoString(cutoffMs),
    cutoffMs,
    totalPlayersCount: groupPlayers.length,
    inactiveCount: inactivePlayers.length,
    inactivePlayers
  };
}

/**
 * Checks player inactivity milestones for a group:
 * - 50% mark: Encourage player to play or participate by tagging them in the group.
 * - 75% mark: Tag player asking if they still want to be part of the group.
 * - 100% mark: Mark inactive and send a DM to those specified under notifications.
 */
async function checkInactivityMilestones(sock, chatId, context = {}, now = Date.now()) {
  if (!sock || !chatId) return { checked: 0, halfway: [], threeQuarter: [], inactive: [] };

  const weeks = groupsConfig.getInactivityPeriodWeeks(chatId);
  const periodMs = weeks * 7 * MS_PER_DAY;
  const halfwayMs = 0.5 * periodMs;
  const threeQuarterMs = 0.75 * periodMs;
  const fullMs = periodMs;

  const groupPlayers = getGroupPlayerCandidates(chatId);
  const halfwayPlayers = [];
  const threeQuarterPlayers = [];
  const inactivePlayers = [];
  let changed = false;

  for (const player of groupPlayers) {
    const resolved = resolveCanonicalPlayerKey(player.id || player.name, chatId);
    if (!resolved || !resolved.key) continue;
    if (GENERIC_NAMES.has(resolved.key.toLowerCase())) continue;

    const entry = getOrCreateEntry(resolved);
    const act = getPlayerActivity(resolved.key, chatId);
    const lastActivityMs = act?.latestTimeMs || 0;

    let elapsedMs = 0;
    if (lastActivityMs > 0) {
      elapsedMs = Math.max(0, now - lastActivityMs);
    } else {
      if (!entry.created) {
        entry.created = new Date(now).toISOString();
        changed = true;
      }
      elapsedMs = Math.max(0, now - toMs(entry.created));
    }

    const playerName = entry.name || resolved.name || resolved.key;
    const playerPn = namesStore.getPnByLid(resolved.key) || (resolved.key.endsWith('@s.whatsapp.net') ? resolved.key : null);
    const playerLid = namesStore.resolveCanonicalId(resolved.key) || (resolved.key.endsWith('@lid') ? resolved.key : null);
    const phoneDigits = (playerPn || resolved.key).split('@')[0].replace(/\D/g, '');
    const tagStr = phoneDigits ? `@${phoneDigits}` : `@${playerName}`;
    const mentions = [playerPn, playerLid, resolved.key].filter(Boolean);

    pruneWeeklyActivity(entry, weeks, now);

    const playerObj = {
      key: resolved.key,
      name: playerName,
      tagStr,
      mentions,
      elapsedMs,
      entry
    };

    // 100% mark: Inactive
    if (elapsedMs >= fullMs) {
      if (!entry.warnings.inactiveSent) {
        entry.status = 'inactive';
        entry.inactiveAt = new Date(now).toISOString();
        entry.warnings.inactiveSent = true;
        changed = true;
        inactivePlayers.push(playerObj);
      }
    }
    // 75% mark: ask if they still want to be part of the group
    else if (elapsedMs >= threeQuarterMs && elapsedMs < fullMs) {
      if (!entry.warnings.threeQuarterSent && entry.status !== 'inactive') {
        threeQuarterPlayers.push(playerObj);
      }
    }
    // Halfway mark (50%): encourage to play or participate
    else if (elapsedMs >= halfwayMs && elapsedMs < threeQuarterMs) {
      if (!entry.warnings.halfwaySent && entry.status !== 'inactive') {
        halfwayPlayers.push(playerObj);
      }
    }
  }

  // 1. Send halfway (50%) encouragement in the group tagging the player(s)
  if (halfwayPlayers.length > 0) {
    for (const p of halfwayPlayers) {
      const encourageMsg = `👋 Hi ${p.tagStr}! We've missed you on the court! We'd love to see you play or participate in the group. Join an upcoming match or drop a message! 🎾⚡`;
      try {
        messageHistory.recordMessage(chatId, 'tenbot', encourageMsg, now, true);
        await sock.sendMessage(chatId, { text: encourageMsg, mentions: p.mentions });
        console.log(`[inactivity] Sent 50% encouragement for ${p.name} in ${chatId}`);
        p.entry.warnings.halfwaySent = true;
        changed = true;
      } catch (err) {
        console.error(`[inactivity] Error sending 50% encouragement for ${p.name}:`, err.message);
      }
    }
  }

  // 2. Send 75% participation question in the group tagging the player(s)
  if (threeQuarterPlayers.length > 0) {
    for (const p of threeQuarterPlayers) {
      const checkMsg = `⚠️ Hi ${p.tagStr}, we noticed you haven't been participating in play or posting in the group recently. Do you still want to be part of the group? Please let us know!`;
      try {
        messageHistory.recordMessage(chatId, 'tenbot', checkMsg, now, true);
        await sock.sendMessage(chatId, { text: checkMsg, mentions: p.mentions });
        console.log(`[inactivity] Sent 75% participation check for ${p.name} in ${chatId}`);
        p.entry.warnings.threeQuarterSent = true;
        changed = true;
      } catch (err) {
        console.error(`[inactivity] Error sending 75% check message for ${p.name}:`, err.message);
      }
    }
  }

  // 3. 100% mark: Send DM to those specified under notifications that the player is inactive
  if (inactivePlayers.length > 0) {
    const notifRecipients = groupsConfig.getNotifications(chatId);
    const groupName = groupsConfig.getGroupConfig(chatId)?.name || chatId;

    for (const p of inactivePlayers) {
      const dmText = `⚠️ *Player Inactivity Alert*\nPlayer *${p.name}* (${p.tagStr}) is now marked as inactive in *${groupName}* (no matches, votes, or messages for ${weeks} weeks).`;

      for (const recipient of notifRecipients) {
        if (recipient.toLowerCase() === chatId.toLowerCase()) continue;
        try {
          messageHistory.recordMessage(recipient, 'tenbot', dmText, now, true);
          await sock.sendMessage(recipient, { text: dmText });
          console.log(`[inactivity] Sent inactivity DM for ${p.name} to ${recipient}`);
        } catch (err) {
          console.error(`[inactivity] Failed to send inactivity DM to ${recipient}:`, err.message);
        }
      }
    }
  }

  if (changed) {
    save();
  }

  return {
    checked: groupPlayers.length,
    halfway: halfwayPlayers.map((p) => p.name),
    threeQuarter: threeQuarterPlayers.map((p) => p.name),
    inactive: inactivePlayers.map((p) => p.name)
  };
}

/**
 * Sweeps inactivity milestones across all configured groups.
 */
async function checkInactivityMilestonesForAllGroups(sock, context = {}, now = Date.now()) {
  if (!sock) return [];
  const cfg = groupsConfig.loadRawConfig();
  if (!cfg?.groups) return [];
  const results = [];
  for (const jid of Object.keys(cfg.groups)) {
    if (jid && jid.endsWith('@g.us')) {
      try {
        const res = await checkInactivityMilestones(sock, jid, context, now);
        results.push({ jid, ...res });
      } catch (err) {
        console.error(`[inactivity] Error checking group ${jid}:`, err.message);
      }
    }
  }
  return results;
}

/**
 * Helper to format an ISO string or timestamp in Pacific Time.
 */
function formatActivityDate(isoOrMs, options = {}) {
  const ms = toMs(isoOrMs);
  if (!ms) return 'Never';

  const date = new Date(ms);
  const showTime = options.showTime !== false;

  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date);

  if (!showTime) return dateParts;

  const timeParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(date);

  return `${dateParts}, ${timeParts}`;
}

// Auto-save on process exit / termination
let exitHandlersRegistered = false;
function registerExitHandlers() {
  if (exitHandlersRegistered) return;
  exitHandlersRegistered = true;

  const onExit = () => {
    try {
      save();
    } catch (e) {}
  };

  process.on('SIGINT', onExit);
  process.on('SIGTERM', onExit);
  process.on('beforeExit', onExit);
  process.on('exit', onExit);
}

registerExitHandlers();

module.exports = {
  ACTIVITY_FILE,
  recordActivity,
  recordPlayed,
  recordVoted,
  recordMessaged,
  getPlayerActivity,
  getLatestActivity,
  getLatestActivityTime,
  getAllActivity,
  getWeeklyActivity,
  getWeekKey,
  pruneWeeklyActivity,
  pruneAllWeeklyActivity,
  getInactivePlayers,
  getGroupPlayerCandidates,
  checkInactivityMilestones,
  checkInactivityMilestonesForAllGroups,
  parsePeriod,
  formatActivityDate,
  resolveCanonicalPlayerKey,
  computeLatest,
  load,
  save,
  reset,
  toIsoString,
  toMs,
  isTenbot
};
