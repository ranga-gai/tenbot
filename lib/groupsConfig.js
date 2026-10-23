const fs = require('fs');
const path = require('path');
const courtsConfig = require('./courtsConfig');
const { GROUPS_FILE, CONFIG_DIR } = require('./paths');

function loadRawConfig() {
  try {
    if (!fs.existsSync(GROUPS_FILE)) return null;
    const raw = fs.readFileSync(GROUPS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('⚠️ Failed to read groups.json:', err.message);
    return null;
  }
}

let cachedConfig = loadRawConfig();

function reloadConfig() {
  cachedConfig = loadRawConfig();
  return cachedConfig;
}

/**
 * Returns list of whitelisted group identifiers (names/subjects, aliases, or JIDs),
 * or null if no whitelist is active (meaning all groups the bot is added to are allowed).
 * Automatically uses the groups configured in groups.json (and allowedGroups if specified).
 */
function getWhitelistedGroups() {
  const list = [];
  const cfg = cachedConfig || loadRawConfig();

  if (cfg) {
    // 1. From groups configured in groups.json
    if (cfg.groups && typeof cfg.groups === 'object') {
      for (const [key, gVal] of Object.entries(cfg.groups)) {
        if (key && key.trim()) list.push(key.trim());
        if (gVal?.name && String(gVal.name).trim()) list.push(String(gVal.name).trim());
        if (gVal?.alias && String(gVal.alias).trim()) list.push(String(gVal.alias).trim());
      }
    }

    // 2. From explicit allowedGroups in groups.json (if specified)
    if (Array.isArray(cfg.allowedGroups) && cfg.allowedGroups.length > 0) {
      list.push(...cfg.allowedGroups);
    }
  }

  // If nothing specified, return null (open mode: all groups allowed)
  if (list.length === 0) return null;

  // Deduplicate case-insensitively
  const seen = new Set();
  const deduped = [];
  for (const item of list) {
    const key = item.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(item);
    }
  }

  return deduped;
}

/**
 * Checks if a message sender or group is authorized.
 * Whitelists are group-based. If sender is in an allowed group, they are authorized.
 */
function hasWhitelist() {
  const list = getWhitelistedGroups();
  return list !== null && list.length > 0;
}

function isGroupWhitelisted(jid, subject = null) {
  const allowed = getWhitelistedGroups();
  if (!allowed || allowed.length === 0) return true; // Whitelist disabled / open mode

  const cleanJid = (jid || '').toLowerCase().trim();
  const cleanSubject = (subject || '').toLowerCase().trim();

  return allowed.some(a => {
    const cleanA = a.toLowerCase().trim();
    return cleanJid === cleanA || (cleanSubject && cleanSubject === cleanA);
  });
}

/**
 * Helper to normalize booking player lists.
 * Each list represents players for one court booking.
 * Accepts:
 *   - Array of arrays: [["P1", "P2"], ["P3", "P4"]]
 *   - Array of strings: ["P1", "P2", "P3", "P4"] -> [["P1", "P2", "P3", "P4"]]
 *   - String: "P1, P2; P3, P4" -> [["P1", "P2"], ["P3", "P4"]]
 *   - Bracketed lists: "[P1, P2], [P3, P4]" -> [["P1", "P2"], ["P3", "P4"]]
 */
function normalizeBookingPlayerLists(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    if (input.length === 0) return [];
    if (Array.isArray(input[0])) {
      return input
        .map((list) => {
          if (Array.isArray(list)) {
            return list.map((s) => String(s).trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
          }
          return [String(list).trim().replace(/^['"]|['\"]$/g, '')].filter(Boolean);
        })
        .filter((l) => l.length > 0);
    }
    const cleaned = input.map((s) => String(s).trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    return cleaned.length > 0 ? [cleaned] : [];
  }
  if (typeof input === "string") {
    const raw = input.trim();
    if (!raw) return [];
    if (raw.startsWith("[") && raw.endsWith("]")) {
      try {
        const parsed = JSON.parse(raw);
        return normalizeBookingPlayerLists(parsed);
      } catch (e) {}
    }
    // Bracket-delimited lists: [P1, P2], [P3, P4]
    const bracketMatches = Array.from(raw.matchAll(/\[(.*?)\]/g)).map(m => m[1].trim()).filter(Boolean);
    if (bracketMatches.length > 0) {
      return bracketMatches
        .map((part) => part.split(/[,&+]|\band\b/i).map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean))
        .filter((l) => l.length > 0);
    }
    if (raw.includes(";") || raw.includes("|")) {
      const parts = raw.split(/[;|]+/).map((s) => s.trim()).filter(Boolean);
      return parts
        .map((part) => part.split(/[,&+]|\band\b/i).map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean))
        .filter((l) => l.length > 0);
    }
    const names = raw.split(/[,&+]|\band\b/i).map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    return names.length > 0 ? [names] : [];
  }
  return [];
}

/**
 * Helper to parse booking schedule string or object.
 * Examples:
 *   "-7days 7:00AM", "-7 days 7:00AM", "-7d 7am", "7 days before at 7am", "-1week 7:00AM"
 *   { daysBefore: 7, time: "7:00 AM" }
 * Returns normalized object:
 *   { daysBefore: 7, time: "7:00 AM", hour: 7, minute: 0, formatted: "7am", display: "7:00 AM", raw: "-7days 7:00AM" }
 */
function parseBookingSchedule(input) {
  if (!input) return null;
  let daysBefore = 7;
  let rawTime = "7:00 AM";
  let rawStr = "";

  if (typeof input === "object" && !Array.isArray(input)) {
    daysBefore = Math.abs(parseInt(input.daysBefore ?? input.days ?? input.offsetDays ?? 7, 10)) || 7;
    if (input.time) {
      rawTime = String(input.time);
    } else if (input.hour !== undefined) {
      const h = parseInt(input.hour, 10);
      const m = parseInt(input.minute || 0, 10);
      rawTime = `${h}:${String(m).padStart(2, "0")}`;
    }
    rawStr = typeof input.raw === "string" ? input.raw : JSON.stringify(input);
  } else {
    rawStr = String(input).trim();
    if (!rawStr) return null;

    if (rawStr.startsWith("{") && rawStr.endsWith("}")) {
      try {
        const parsedObj = JSON.parse(rawStr);
        return parseBookingSchedule(parsedObj);
      } catch (e) {}
    }

    let text = rawStr;
    const daysRegex = /(?:-\s*(\d+)\s*(?:weeks?|w)\b)|(?:(\d+)\s*weeks?\s*before\b)|(?:-\s*(\d+)\s*(?:days?|d)\b)|(?:(\d+)\s*days?\s*before\b)|(?:-\s*(\d+)\b)/i;
    const dMatch = text.match(daysRegex);
    if (dMatch) {
      if (dMatch[1] || dMatch[2]) {
        daysBefore = (parseInt(dMatch[1] || dMatch[2], 10) || 1) * 7;
      } else {
        daysBefore = parseInt(dMatch[3] || dMatch[4] || dMatch[5], 10) || 7;
      }
      text = text.replace(dMatch[0], " ").trim();
    } else {
      const positiveDaysMatch = text.match(/\b(\d+)\s*(?:days?|d)\b/i);
      if (positiveDaysMatch) {
        daysBefore = parseInt(positiveDaysMatch[1], 10) || 7;
        text = text.replace(positiveDaysMatch[0], " ").trim();
      }
    }

    text = text.replace(/\b(?:at|prior|before|advance|in)\b/gi, " ").trim();
    const timeMatch = text.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})/i);
    if (timeMatch) {
      rawTime = timeMatch[1].trim();
    }
  }

  let parsedTime = null;
  try {
    const pollTime = require("./pollTime");
    parsedTime = pollTime.parseTimeString(rawTime);
  } catch (e) {}

  if (!parsedTime) {
    const tm = rawTime.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (tm) {
      let h = parseInt(tm[1], 10);
      const m = tm[2] ? parseInt(tm[2], 10) : 0;
      const isPm = tm[3] && tm[3].toLowerCase() === "pm";
      const isAm = tm[3] && tm[3].toLowerCase() === "am";
      if (isPm && h < 12) h += 12;
      if (isAm && h === 12) h = 0;
      const period = h >= 12 ? "PM" : "AM";
      const dH = h % 12 === 0 ? 12 : h % 12;
      const dM = m > 0 ? `:${String(m).padStart(2, "0")}` : ":00";
      parsedTime = {
        hour: h,
        minute: m,
        formatted: `${dH}${m > 0 ? `:${String(m).padStart(2, "0")}` : ""}${period.toLowerCase()}`,
        display: `${dH}${dM} ${period}`
      };
    } else {
      parsedTime = { hour: 7, minute: 0, formatted: "7am", display: "7:00 AM" };
    }
  }

  const dHour = parsedTime.hour % 12 === 0 ? 12 : parsedTime.hour % 12;
  const dMin = String(parsedTime.minute).padStart(2, "0");
  const period = parsedTime.hour >= 12 ? "PM" : "AM";
  const standardDisplay = `${dHour}:${dMin} ${period}`;

  return {
    daysBefore,
    time: standardDisplay,
    hour: parsedTime.hour,
    minute: parsedTime.minute,
    formatted: parsedTime.formatted,
    display: standardDisplay,
    raw: rawStr
  };
}

/**
 * Returns merged configuration for a given group.
 * Reads defaults from groups.json and overlays group-specific settings.
 */
function getGroupConfig(jidOrName = null) {
  const cfg = cachedConfig || loadRawConfig() || {};
  const defaults = cfg.defaults || {};

  const rawDefaultBookingStrategy = defaults.bookingStrategy !== undefined ? defaults.bookingStrategy : null;
  const cleanDefaultBookingStrategy = rawDefaultBookingStrategy ? String(rawDefaultBookingStrategy).trim().toLowerCase() : null;
  const rawDefaultBookingSchedule = defaults.bookingSchedule !== undefined ? defaults.bookingSchedule : null;
  const parsedDefaultBookingSchedule = parseBookingSchedule(rawDefaultBookingSchedule);

  if (!jidOrName) {
    return {
      sport: defaults.sport || 'tennis',
      courtBookingEnabled: defaults.courtBookingEnabled !== undefined ? defaults.courtBookingEnabled : true,
      courtConfig: defaults.courtConfig || defaults.court || defaults.venue || null,
      venue: defaults.courtConfig || defaults.court || defaults.venue || null,
      autoMatchups: defaults.autoMatchups !== undefined ? defaults.autoMatchups : true,
      directCourtBookingAccounts: Array.isArray(defaults.directCourtBookingAccounts) ? defaults.directCourtBookingAccounts : [],
      defaultBookingPlayers: Array.isArray(defaults.defaultBookingPlayers) ? defaults.defaultBookingPlayers : (Array.isArray(defaults.bookingPlayers) ? defaults.bookingPlayers : []),
      bookingPlayers: Array.isArray(defaults.defaultBookingPlayers) ? defaults.defaultBookingPlayers : (Array.isArray(defaults.bookingPlayers) ? defaults.bookingPlayers : []),
      ignoredCourts: Array.isArray(defaults.ignoredCourts) ? defaults.ignoredCourts : [],
      bookingNotifications: Array.isArray(defaults.bookingNotifications) ? defaults.bookingNotifications : (typeof defaults.bookingNotifications === "string" ? defaults.bookingNotifications.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean) : []),
      bookingCourtPreference: Array.isArray(defaults.bookingCourtPreference) ? defaults.bookingCourtPreference : (typeof defaults.bookingCourtPreference === "string" ? defaults.bookingCourtPreference.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean) : []),
      preBookCourts: (defaults.preBookCourts !== undefined && parseInt(defaults.preBookCourts, 10) > 0)
        ? parseInt(defaults.preBookCourts, 10)
        : (defaults.preBookCourtsCount !== undefined && parseInt(defaults.preBookCourtsCount, 10) > 0
          ? parseInt(defaults.preBookCourtsCount, 10)
          : 1),
      preBookCourtsCount: (defaults.preBookCourts !== undefined && parseInt(defaults.preBookCourts, 10) > 0)
        ? parseInt(defaults.preBookCourts, 10)
        : (defaults.preBookCourtsCount !== undefined && parseInt(defaults.preBookCourtsCount, 10) > 0
          ? parseInt(defaults.preBookCourtsCount, 10)
          : 1),
      bookingStrategy: cleanDefaultBookingStrategy,
      bookingSchedule: rawDefaultBookingSchedule,
      bookingScheduleParsed: parsedDefaultBookingSchedule
    };
  }

  const cleanJid = (jidOrName || '').toLowerCase().trim();
  const cleanSubject = cleanJid;

  let groupSpecific = null;

  if (cfg.groups && typeof cfg.groups === 'object') {
    for (const [key, gVal] of Object.entries(cfg.groups)) {
      const cleanKey = key.toLowerCase().trim();
      const gName = (gVal.name || '').toLowerCase().trim();
      const gAlias = (gVal.alias || '').toLowerCase().trim();
      if (cleanJid === cleanKey || cleanSubject === cleanKey || (gName && cleanSubject === gName) || (gAlias && cleanSubject === gAlias)) {
        groupSpecific = gVal;
        break;
      }
    }
  }

  const courtBookingEnabled = groupSpecific?.courtBookingEnabled !== undefined
    ? groupSpecific.courtBookingEnabled
    : (defaults.courtBookingEnabled !== undefined ? defaults.courtBookingEnabled : true);

  // Each group will have a reference to the court configuration name to use, if court functionality is available
  const targetCourtConfig = courtBookingEnabled
    ? (groupSpecific?.courtConfig || groupSpecific?.court || groupSpecific?.venue || defaults.courtConfig || defaults.court || defaults.venue || null)
    : null;

  // Fallbacks: if no groups.json overrides, use courts.json or .env
  const courtIgnoredCourts = targetCourtConfig ? courtsConfig.getIgnoredCourts(targetCourtConfig) : [];
  const envIgnoredCourts = (process.env.IGNORED_COURTS || process.env.IGNORED_COURT || '')
    .split(/[,;]+/)
    .map(s => s.trim())
    .filter(Boolean);
  const fallbackIgnored = courtIgnoredCourts.length > 0 ? courtIgnoredCourts : envIgnoredCourts;

  const rawDefaultBookingPlayers = groupSpecific?.defaultBookingPlayers !== undefined
    ? groupSpecific.defaultBookingPlayers
    : (groupSpecific?.bookingPlayers !== undefined
      ? groupSpecific.bookingPlayers
      : (defaults.defaultBookingPlayers !== undefined ? defaults.defaultBookingPlayers : (defaults.bookingPlayers || [])));

  const cleanDefaultBookingPlayers = Array.isArray(rawDefaultBookingPlayers)
    ? rawDefaultBookingPlayers
    : (typeof rawDefaultBookingPlayers === "string" ? rawDefaultBookingPlayers.split(/[,;]+/).map(s => s.trim()).filter(Boolean) : []);

  const rawDirectAccounts = groupSpecific?.directCourtBookingAccounts !== undefined
    ? groupSpecific.directCourtBookingAccounts
    : (defaults.directCourtBookingAccounts !== undefined ? defaults.directCourtBookingAccounts : []);

  const cleanDirectAccounts = Array.isArray(rawDirectAccounts)
    ? rawDirectAccounts
    : (typeof rawDirectAccounts === 'string' ? rawDirectAccounts.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean) : []);

  const rawCourtPreference = groupSpecific?.bookingCourtPreference !== undefined
    ? groupSpecific.bookingCourtPreference
    : (defaults.bookingCourtPreference !== undefined ? defaults.bookingCourtPreference : []);

  const cleanCourtPreference = Array.isArray(rawCourtPreference)
    ? rawCourtPreference
    : (typeof rawCourtPreference === "string" ? rawCourtPreference.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean) : []);

  const rawBookingNotifications = groupSpecific?.bookingNotifications !== undefined
    ? groupSpecific.bookingNotifications
    : (defaults.bookingNotifications !== undefined ? defaults.bookingNotifications : []);

  const cleanBookingNotifications = Array.isArray(rawBookingNotifications)
    ? rawBookingNotifications
    : (typeof rawBookingNotifications === "string" ? rawBookingNotifications.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean) : []);

  const rawPreBookCourts = groupSpecific?.preBookCourts !== undefined
    ? groupSpecific.preBookCourts
    : (groupSpecific?.preBookCourtsCount !== undefined
      ? groupSpecific.preBookCourtsCount
      : (defaults.preBookCourts !== undefined
        ? defaults.preBookCourts
        : (defaults.preBookCourtsCount !== undefined ? defaults.preBookCourtsCount : null)));

  const cleanPreBookCourts = (rawPreBookCourts !== null && rawPreBookCourts !== undefined && parseInt(rawPreBookCourts, 10) > 0)
    ? parseInt(rawPreBookCourts, 10)
    : 1;

  const rawBookingStrategy = groupSpecific?.bookingStrategy !== undefined
    ? groupSpecific.bookingStrategy
    : (defaults.bookingStrategy !== undefined ? defaults.bookingStrategy : null);
  const cleanBookingStrategy = rawBookingStrategy ? String(rawBookingStrategy).trim().toLowerCase() : null;

  const rawBookingSchedule = groupSpecific?.bookingSchedule !== undefined
    ? groupSpecific.bookingSchedule
    : (defaults.bookingSchedule !== undefined ? defaults.bookingSchedule : null);
  const parsedBookingSchedule = parseBookingSchedule(rawBookingSchedule);

  return {
    name: groupSpecific?.name || jidOrName,
    sport: groupSpecific?.sport || defaults.sport || 'tennis',
    courtBookingEnabled,
    courtConfig: targetCourtConfig,
    venue: targetCourtConfig, // alias for backwards compatibility
    ignoredCourts: targetCourtConfig ? (Array.isArray(groupSpecific?.ignoredCourts)
      ? groupSpecific.ignoredCourts
      : (Array.isArray(defaults.ignoredCourts) ? defaults.ignoredCourts : fallbackIgnored)) : [],
    autoMatchups: groupSpecific?.autoMatchups !== undefined
      ? groupSpecific.autoMatchups
      : (defaults.autoMatchups !== undefined ? defaults.autoMatchups : true),
    directCourtBookingAccounts: cleanDirectAccounts,
    defaultBookingPlayers: cleanDefaultBookingPlayers,
    bookingPlayers: cleanDefaultBookingPlayers,
    preBookCourts: cleanPreBookCourts,
    preBookCourtsCount: cleanPreBookCourts,
    bookingNotifications: cleanBookingNotifications,
    bookingCourtPreference: cleanCourtPreference,
    bookingStrategy: cleanBookingStrategy,
    bookingSchedule: rawBookingSchedule,
    bookingScheduleParsed: parsedBookingSchedule,
    ...groupSpecific,
    courtBookingEnabled,
    courtConfig: targetCourtConfig,
    venue: targetCourtConfig,
    defaultBookingPlayers: cleanDefaultBookingPlayers,
    bookingPlayers: cleanDefaultBookingPlayers,
    preBookCourts: cleanPreBookCourts,
    preBookCourtsCount: cleanPreBookCourts,
    bookingNotifications: cleanBookingNotifications,
    bookingCourtPreference: cleanCourtPreference,
    bookingStrategy: cleanBookingStrategy,
    bookingSchedule: rawBookingSchedule,
    bookingScheduleParsed: parsedBookingSchedule
  };
}

/**
 * Returns the preferred list of courts to book for a group (e.g. [2, 3, 1, 5, 6]).
 */
function getBookingCourtPreference(jidOrName = null) {
  const groupCfg = getGroupConfig(jidOrName);
  return groupCfg?.bookingCourtPreference || [];
}

/**
 * Returns the configured booking strategy for a group (e.g. 'advanced', 'instant', or null).
 */
function getBookingStrategy(jidOrName = null) {
  const groupCfg = getGroupConfig(jidOrName);
  return groupCfg?.bookingStrategy || null;
}

/**
 * Returns the raw configured booking schedule for a group (e.g. '-7days 7:00AM').
 */
function getBookingSchedule(jidOrName = null) {
  const groupCfg = getGroupConfig(jidOrName);
  return groupCfg?.bookingSchedule || null;
}

/**
 * Returns the parsed booking schedule object for a group.
 */
function getBookingScheduleParsed(jidOrName = null) {
  const groupCfg = getGroupConfig(jidOrName);
  return groupCfg?.bookingScheduleParsed || null;
}

/**
 * Returns list of normalized recipient LIDs for court booking & cancellation notifications for a group.
 */
function getBookingNotifications(jidOrName = null) {
  const groupCfg = getGroupConfig(jidOrName);
  const rawList = groupCfg?.bookingNotifications || [];
  if (!rawList || rawList.length === 0) return [];

  const recipients = [];
  const seen = new Set();

  for (const item of rawList) {
    if (!item) continue;
    const raw = String(item).replace(/['"]/g, "").trim();
    if (!raw) continue;

    let targetLid = null;

    if (raw.toLowerCase().endsWith("@lid")) {
      targetLid = raw.toLowerCase();
    } else if (raw.toLowerCase().endsWith("@s.whatsapp.net")) {
      try {
        const namesStore = require("./names");
        const lid = namesStore.resolveCanonicalId(raw.toLowerCase());
        if (lid && lid.endsWith("@lid")) {
          targetLid = lid.toLowerCase();
        } else {
          targetLid = raw.toLowerCase();
        }
      } catch (e) {
        targetLid = raw.toLowerCase();
      }
    } else if (/^\d{10,}$/.test(raw)) {
      targetLid = `${raw}@lid`.toLowerCase();
    } else {
      try {
        const namesStore = require("./names");
        const match = namesStore.findIdByNameOrAlias(raw);
        if (match?.id && match.id.endsWith("@lid")) {
          targetLid = match.id.toLowerCase();
        } else if (match?.entry?.pn) {
          targetLid = match.entry.pn.toLowerCase();
        }
      } catch (e) {}
    }

    if (targetLid && !seen.has(targetLid)) {
      seen.add(targetLid);
      recipients.push(targetLid);
    }
  }

  return recipients;
}

/**
 * Returns the court configuration name for a group (e.g. 'SCVCC'),
 * or null if court functionality is disabled for the group.
 */
function getCourtConfigName(jidOrName = null) {
  const groupCfg = getGroupConfig(jidOrName);
  return groupCfg?.courtBookingEnabled ? (groupCfg?.courtConfig || null) : null;
}

/**
 * Returns full court configuration object from courtsConfig for a group,
 * or null if court functionality is disabled for the group.
 */
function getCourtConfig(jidOrName = null) {
  const configName = getCourtConfigName(jidOrName);
  if (!configName) return null;
  return courtsConfig.getCourtConfig(configName);
}

/**
 * Checks whether court functionality is enabled for a given group.
 */
function isCourtBookingEnabled(jidOrName = null) {
  const groupCfg = getGroupConfig(jidOrName);
  return groupCfg?.courtBookingEnabled !== false;
}

/**
 * Returns the default booking player lists for a group (e.g. [["P1", "P2"]]).
 */
function getDefaultBookingPlayers(jidOrName = null) {
  const groupCfg = getGroupConfig(jidOrName);
  return groupCfg?.defaultBookingPlayers || [];
}

/**
 * Returns the configured number of courts to pre-book for a group when size is 'auto' (default: 1).
 */
function getPreBookCourts(jidOrName = null) {
  const groupCfg = getGroupConfig(jidOrName);
  return groupCfg?.preBookCourts || 1;
}

function normalizeAccountsSet(rawItems) {
  const accounts = new Set();
  const addToken = (token) => {
    if (!token) return;
    const raw = String(token).replace(/['"]/g, '').trim().toLowerCase();
    if (!raw) return;
    accounts.add(raw);

    try {
      const namesStore = require('./names');
      const match = namesStore.findIdByNameOrAlias(raw);
      if (match) {
        if (match.id) {
          const lidNorm = match.id.toLowerCase();
          accounts.add(lidNorm);
          accounts.add(lidNorm.replace(/@lid$/i, ''));
        }
        if (match.entry?.pn) {
          const pnNorm = match.entry.pn.toLowerCase();
          accounts.add(pnNorm);
          accounts.add(pnNorm.replace(/@s\.whatsapp\.net$/i, ''));
        }
        if (match.entry?.fullName) {
          accounts.add(match.entry.fullName.toLowerCase().trim());
        }
        if (match.entry?.name) {
          accounts.add(match.entry.name.toLowerCase().trim());
        }
      }
    } catch (e) {}
  };

  if (Array.isArray(rawItems)) {
    rawItems.forEach(addToken);
  } else if (typeof rawItems === 'string') {
    rawItems.split(/[,;\n]+/).forEach(addToken);
  }
  return accounts;
}

/**
 * Returns the set of direct court booking accounts for a specific group (or across all groups if jid is null).
 */
function getDirectCourtBookingAccounts(jid = null) {
  const cfg = cachedConfig || loadRawConfig() || {};
  const defaults = cfg.defaults || {};

  if (jid) {
    const groupCfg = getGroupConfig(jid);
    if (groupCfg && groupCfg.directCourtBookingAccounts && groupCfg.directCourtBookingAccounts.length > 0) {
      return normalizeAccountsSet(groupCfg.directCourtBookingAccounts);
    }
  }

  // If no group-specific or jid was null, collect from all groups and defaults
  const allAccounts = [];
  if (defaults.directCourtBookingAccounts) {
    allAccounts.push(defaults.directCourtBookingAccounts);
  }
  if (cfg.groups && typeof cfg.groups === 'object') {
    for (const gVal of Object.values(cfg.groups)) {
      if (gVal && gVal.directCourtBookingAccounts) {
        allAccounts.push(gVal.directCourtBookingAccounts);
      }
    }
  }

  const result = new Set();
  for (const item of allAccounts) {
    const s = normalizeAccountsSet(item);
    for (const acc of s) result.add(acc);
  }
  return result;
}


/**
 * Retrieves the set of superadmin accounts (LIDs or phone JIDs) configured in .env.
 */
function getSuperAdminAccounts() {
  const raw = process.env.SUPERADMIN_ACCOUNT || process.env.SUPERADMIN_LID || process.env.SUPERADMIN_LIDS || process.env.SUPERADMIN || '';
  if (!raw || !raw.trim()) return new Set();
  const tokens = raw.split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const set = new Set();
  for (const t of tokens) {
    const clean = t.replace(/['"]/g, '');
    set.add(clean);
    if (!clean.endsWith('@lid')) {
      set.add(`${clean}@lid`);
    } else {
      set.add(clean.replace(/@lid$/i, ''));
    }
  }
  return set;
}

const getSuperAdminLids = getSuperAdminAccounts;

/**
 * Checks whether a sender JID is an authorized bot superadmin.
 */
function isSuperAdmin(senderJid) {
  if (!senderJid) return false;
  const superAccounts = getSuperAdminAccounts();
  if (superAccounts.size === 0) return false;

  const rawUser = String(senderJid).trim().toLowerCase();
  const numOnly = rawUser.split('@')[0];

  if (superAccounts.has(rawUser) || superAccounts.has(numOnly)) return true;

  try {
    const namesStore = require('./names');
    const lid = namesStore.resolveCanonicalId(rawUser);
    const pn = namesStore.getPnByLid(rawUser);

    if (lid && (superAccounts.has(lid.toLowerCase()) || superAccounts.has(lid.split('@')[0]))) return true;
    if (pn && (superAccounts.has(pn.toLowerCase()) || superAccounts.has(pn.split('@')[0]))) return true;
  } catch (err) {}

  return false;
}

/**
 * Persists raw configuration directly to groups.json and refreshes memory cache.
 */
function saveRawConfig(cfg) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(GROUPS_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
    cachedConfig = cfg;
    return true;
  } catch (err) {
    console.error('⚠️ Failed to save groups.json:', err.message);
    return false;
  }
}

/**
 * Helper to locate an existing group key in cfg.groups by JID, name, or alias.
 */
function findConfigGroupKey(cfg, jidOrName) {
  if (!cfg || !cfg.groups || typeof cfg.groups !== 'object' || !jidOrName) return null;
  const target = String(jidOrName).trim().toLowerCase();
  if (cfg.groups[target]) return target;

  for (const [key, val] of Object.entries(cfg.groups)) {
    if (key.toLowerCase() === target) return key;
    if (val?.name && String(val.name).trim().toLowerCase() === target) return key;
    if (val?.alias && String(val.alias).trim().toLowerCase() === target) return key;
  }
  return null;
}

/**
 * Adds a new group to groups.json.
 */
function addGroup(jid, name, options = {}) {
  if (!jid) throw new Error('Group JID is required to add a group.');
  const cfg = loadRawConfig() || { groups: {} };
  if (!cfg.groups) cfg.groups = {};

  const cleanJid = String(jid).trim();
  const cleanName = name ? String(name).trim() : cleanJid;

  const groupData = {
    name: cleanName,
    courtBookingEnabled: options.courtBookingEnabled !== undefined ? Boolean(options.courtBookingEnabled) : true
  };

  if (groupData.courtBookingEnabled && (options.courtConfig || options.venue || options.court)) {
    groupData.courtConfig = options.courtConfig || options.venue || options.court;
  }

  if (options.sport) groupData.sport = options.sport;
  if (options.alias) groupData.alias = options.alias;
  if (options.autoMatchups !== undefined) groupData.autoMatchups = Boolean(options.autoMatchups);
  if (options.defaultBookingPlayers !== undefined || options.bookingPlayers !== undefined) {
    const rawBP = options.defaultBookingPlayers !== undefined ? options.defaultBookingPlayers : options.bookingPlayers;
    groupData.defaultBookingPlayers = Array.isArray(rawBP) ? rawBP : (typeof rawBP === "string" ? rawBP.split(/[,;]+/).map(s => s.trim()).filter(Boolean) : []);
  }
  if (options.directCourtBookingAccounts) {
    const raw = options.directCourtBookingAccounts;
    groupData.directCourtBookingAccounts = Array.isArray(raw)
      ? raw
      : String(raw).split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
  }
  if (options.bookingNotifications) {
    const raw = options.bookingNotifications;
    groupData.bookingNotifications = Array.isArray(raw)
      ? raw
      : String(raw).split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
  }
  if (options.bookingCourtPreference !== undefined) {
    const raw = options.bookingCourtPreference;
    groupData.bookingCourtPreference = Array.isArray(raw)
      ? raw
      : String(raw).split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  }
  if (options.ignoredCourts) {
    const raw = options.ignoredCourts;
    groupData.ignoredCourts = Array.isArray(raw)
      ? raw
      : String(raw).split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
  }
  if (options.preBookCourts !== undefined || options.preBookCourtsCount !== undefined) {
    const rawVal = options.preBookCourts !== undefined ? options.preBookCourts : options.preBookCourtsCount;
    const val = parseInt(rawVal, 10);
    if (Number.isInteger(val) && val > 0) {
      groupData.preBookCourts = val;
    }
  }
  if (options.bookingStrategy !== undefined) {
    groupData.bookingStrategy = String(options.bookingStrategy).trim().toLowerCase();
  }
  if (options.bookingSchedule !== undefined) {
    groupData.bookingSchedule = options.bookingSchedule;
  }

  cfg.groups[cleanJid] = groupData;
  saveRawConfig(cfg);
  return groupData;
}

/**
 * Removes a group from groups.json.
 */
function removeGroup(jidOrName) {
  const cfg = loadRawConfig();
  if (!cfg || !cfg.groups) return false;

  const foundKey = findConfigGroupKey(cfg, jidOrName);
  if (!foundKey) return false;

  const removed = cfg.groups[foundKey];
  delete cfg.groups[foundKey];
  saveRawConfig(cfg);
  return removed;
}

/**
 * Updates configuration settings for an existing group.
 */
function updateGroupConfig(jidOrName, updates = {}) {
  const cfg = loadRawConfig();
  if (!cfg || !cfg.groups) throw new Error('No groups configuration found.');

  const foundKey = findConfigGroupKey(cfg, jidOrName);
  if (!foundKey) {
    throw new Error(`Group '${jidOrName}' not found in configuration.`);
  }

  const existing = cfg.groups[foundKey] || {};
  const processed = { ...updates };

  if (processed.courtBookingEnabled !== undefined) {
    processed.courtBookingEnabled = (processed.courtBookingEnabled === true || processed.courtBookingEnabled === 'true');
  }

  if (processed.courtBookingEnabled !== false && (processed.courtConfig || processed.venue || processed.court)) {
    processed.courtConfig = processed.courtConfig || processed.venue || processed.court;
    delete processed.venue;
    delete processed.court;
  }

  if (processed.autoMatchups !== undefined) {
    processed.autoMatchups = (processed.autoMatchups === true || processed.autoMatchups === 'true');
  }

  if (processed.defaultBookingPlayers !== undefined || processed.bookingPlayers !== undefined) {
    const rawVal = processed.defaultBookingPlayers !== undefined ? processed.defaultBookingPlayers : processed.bookingPlayers;
    processed.defaultBookingPlayers = Array.isArray(rawVal) ? rawVal : (typeof rawVal === "string" ? rawVal.split(/[,;]+/).map(s => s.trim()).filter(Boolean) : []);
    delete processed.bookingPlayers;
  }

  if (processed.directCourtBookingAccounts !== undefined) {
    const raw = processed.directCourtBookingAccounts;
    processed.directCourtBookingAccounts = Array.isArray(raw)
      ? raw
      : String(raw).split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  }

  if (processed.bookingNotifications !== undefined) {
    const raw = processed.bookingNotifications;
    processed.bookingNotifications = Array.isArray(raw)
      ? raw
      : String(raw).split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
  }
  if (processed.bookingCourtPreference !== undefined) {
    const raw = processed.bookingCourtPreference;
    processed.bookingCourtPreference = Array.isArray(raw)
      ? raw
      : String(raw).split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  }
  if (processed.ignoredCourts !== undefined) {
    const raw = processed.ignoredCourts;
    processed.ignoredCourts = Array.isArray(raw)
      ? raw
      : String(raw).split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  }

  if (processed.preBookCourts !== undefined || processed.preBookCourtsCount !== undefined) {
    const rawVal = processed.preBookCourts !== undefined ? processed.preBookCourts : processed.preBookCourtsCount;
    const val = parseInt(rawVal, 10);
    if (Number.isInteger(val) && val > 0) {
      processed.preBookCourts = val;
    } else {
      delete processed.preBookCourts;
      delete existing.preBookCourts;
      delete existing.preBookCourtsCount;
    }
    delete processed.preBookCourtsCount;
  }

  if (processed.bookingStrategy !== undefined) {
    const rawVal = processed.bookingStrategy;
    if (rawVal && String(rawVal).trim().toLowerCase() !== 'none' && String(rawVal).trim().toLowerCase() !== 'null') {
      processed.bookingStrategy = String(rawVal).trim().toLowerCase();
    } else {
      delete processed.bookingStrategy;
      delete existing.bookingStrategy;
    }
  }

  if (processed.bookingSchedule !== undefined) {
    const rawVal = processed.bookingSchedule;
    if (rawVal && String(rawVal).trim() !== '' && String(rawVal).trim().toLowerCase() !== 'null') {
      processed.bookingSchedule = rawVal;
    } else {
      delete processed.bookingSchedule;
      delete existing.bookingSchedule;
    }
  }

  cfg.groups[foundKey] = {
    ...existing,
    ...processed
  };

  saveRawConfig(cfg);
  return cfg.groups[foundKey];
}

/**
 * Formats a single group's configuration for display.
 */
function formatGroupConfig(jid, conf = null) {
  const c = conf || getGroupConfig(jid);
  const lines = [
    `*Group:* ${c.name || jid}`,
    `*JID:* \`${jid}\``,
    `*Sport:* ${c.sport || 'tennis'}`,
    `*Court Booking Enabled:* ${c.courtBookingEnabled ? 'Yes' : 'No'}`
  ];

  if (c.courtBookingEnabled && c.courtConfig) {
    lines.push(`*Court Config:* ${c.courtConfig}`);
  }

  if (c.alias) {
    lines.push(`*Alias:* ${c.alias}`);
  }

  lines.push(`*Auto Matchups:* ${c.autoMatchups ? 'Yes' : 'No'}`);

  if (c.defaultBookingPlayers && c.defaultBookingPlayers.length > 0) {
    lines.push(`*Default Booking Players:* ${c.defaultBookingPlayers.join(', ')}`);
  }

  if (c.directCourtBookingAccounts && c.directCourtBookingAccounts.length > 0) {
    lines.push(`*Direct Court Booking Accounts:* ${c.directCourtBookingAccounts.join(', ')}`);
  }

  if (c.ignoredCourts && c.ignoredCourts.length > 0) {
    lines.push(`*Ignored Courts:* ${c.ignoredCourts.join(', ')}`);
  }

  if (c.preBookCourts) {
    lines.push(`*Pre-Book Courts (Auto):* ${c.preBookCourts}`);
  }

  if (c.bookingNotifications && c.bookingNotifications.length > 0) {
    lines.push(`*Booking Notifications:* ${c.bookingNotifications.join(", ")}`);
  }

  if (c.bookingCourtPreference && c.bookingCourtPreference.length > 0) {
    lines.push(`*Booking Court Preference:* ${c.bookingCourtPreference.join(", ")}`);
  }

  if (c.bookingStrategy) {
    lines.push(`*Booking Strategy:* ${c.bookingStrategy}`);
  }

  if (c.bookingSchedule) {
    lines.push(`*Booking Schedule:* ${typeof c.bookingSchedule === 'object' ? JSON.stringify(c.bookingSchedule) : c.bookingSchedule}`);
  }

  return lines.join('\n');
}

/**
 * Formats all groups' configuration for display.
 */
function formatAllGroupsConfig() {
  const cfg = loadRawConfig();
  if (!cfg || !cfg.groups || Object.keys(cfg.groups).length === 0) {
    return '📋 No groups configured in groups.json.';
  }

  const sections = ['⚙️ *Configured WhatsApp Groups:*\n'];
  for (const [jid, gVal] of Object.entries(cfg.groups)) {
    sections.push(formatGroupConfig(jid, gVal));
    sections.push('---');
  }

  if (cfg.defaults) {
    sections.push('*Global Defaults:*');
    sections.push(`• Sport: ${cfg.defaults.sport || 'tennis'}`);
    sections.push(`• Court Booking Enabled: ${cfg.defaults.courtBookingEnabled ? 'Yes' : 'No'}`);
    if (cfg.defaults.courtConfig || cfg.defaults.venue) {
      sections.push(`• Court Config: ${cfg.defaults.courtConfig || cfg.defaults.venue}`);
    }
    if (cfg.defaults.defaultBookingPlayers && cfg.defaults.defaultBookingPlayers.length > 0) {
      sections.push(`• Default Booking Players: ${cfg.defaults.defaultBookingPlayers.join(', ')}`);
    }
    if (cfg.defaults.preBookCourts) {
      sections.push(`• Pre-Book Courts (Auto): ${cfg.defaults.preBookCourts}`);
    }
    if (cfg.defaults.bookingStrategy) {
      sections.push(`• Booking Strategy: ${cfg.defaults.bookingStrategy}`);
    }
    if (cfg.defaults.bookingSchedule) {
      sections.push(`• Booking Schedule: ${typeof cfg.defaults.bookingSchedule === 'object' ? JSON.stringify(cfg.defaults.bookingSchedule) : cfg.defaults.bookingSchedule}`);
    }
  }

  return sections.join('\n');
}


/**
 * Resolves a group JID from a given JID, name, or alias.
 */
function getGroupJid(jidOrName) {
  const cfg = cachedConfig || loadRawConfig();
  return findConfigGroupKey(cfg, jidOrName);
}

/**
 * Pauses court bookings for a specific group or for all groups.
 * If target === 'all', pauses for all groups and sets defaults.courtBookingEnabled = false.
 * Returns { all: true, affected: [...] } or { all: false, jid, name }.
 */
function pauseCourtBookings(target = 'all') {
  const cfg = loadRawConfig();
  if (!cfg || !cfg.groups) throw new Error('No groups configuration found.');

  const cleanTarget = String(target || 'all').trim().toLowerCase();
  if (cleanTarget === 'all') {
    if (!cfg.defaults) cfg.defaults = {};
    cfg.defaults.courtBookingEnabled = false;
    const affected = [];
    for (const [key, gVal] of Object.entries(cfg.groups)) {
      gVal.courtBookingEnabled = false;
      affected.push({ jid: key, name: gVal.name || key });
    }
    saveRawConfig(cfg);
    return { all: true, affected };
  }

  const foundKey = findConfigGroupKey(cfg, target);
  if (!foundKey) return null;

  const group = cfg.groups[foundKey];
  group.courtBookingEnabled = false;
  saveRawConfig(cfg);
  return { all: false, jid: foundKey, name: group.name || foundKey };
}

/**
 * Resumes court bookings for a specific group or for all groups.
 * If target === 'all', resumes for all groups and sets defaults.courtBookingEnabled = true.
 * Returns { all: true, affected: [...] } or { all: false, jid, name }.
 */
function resumeCourtBookings(target = 'all') {
  const cfg = loadRawConfig();
  if (!cfg || !cfg.groups) throw new Error('No groups configuration found.');

  const cleanTarget = String(target || 'all').trim().toLowerCase();
  if (cleanTarget === 'all') {
    if (!cfg.defaults) cfg.defaults = {};
    cfg.defaults.courtBookingEnabled = true;
    const affected = [];
    for (const [key, gVal] of Object.entries(cfg.groups)) {
      gVal.courtBookingEnabled = true;
      affected.push({ jid: key, name: gVal.name || key });
    }
    saveRawConfig(cfg);
    return { all: true, affected };
  }

  const foundKey = findConfigGroupKey(cfg, target);
  if (!foundKey) return null;

  const group = cfg.groups[foundKey];
  group.courtBookingEnabled = true;
  saveRawConfig(cfg);
  return { all: false, jid: foundKey, name: group.name || foundKey };
}

module.exports = {
  loadRawConfig,
  reloadConfig,
  getWhitelistedGroups,
  hasWhitelist,
  isGroupWhitelisted,
  isGroupAllowed: isGroupWhitelisted,
  getGroupConfig,
  getCourtConfigName,
  getCourtConfig,
  isCourtBookingEnabled,
  getDefaultBookingPlayers,
  getPreBookCourts,
  getBookingNotifications,
  getBookingCourtPreference,
  getBookingStrategy,
  getBookingSchedule,
  getBookingScheduleParsed,
  parseBookingSchedule,
  normalizeBookingPlayerLists,
  getDirectCourtBookingAccounts,
  getSuperAdminAccounts,
  getSuperAdminLids,
  isSuperAdmin,
  saveRawConfig,
  addGroup,
  removeGroup,
  updateGroupConfig,
  formatGroupConfig,
  formatAllGroupsConfig,
  getGroupJid,
  pauseCourtBookings,
  resumeCourtBookings
};
