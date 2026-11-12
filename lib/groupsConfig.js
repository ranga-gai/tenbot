try { require('dotenv').config(); } catch (e) {}
const fs = require('fs');
const path = require('path');
const courtsConfig = require('./courtsConfig');
const { GROUPS_FILE, CONFIG_DIR } = require('./paths');
const { parseTimeString, getSanJoseParts } = require('./pollTime');

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
          return [String(list).trim().replace(/^['"]|['"]$/g, '')].filter(Boolean);
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

const DEFAULT_QUIET_HOURS = '22:00-07:00';

/**
 * Helper to parse a time for quiet hours (supports 12h "10pm", "7am", "6:30am" or 24h "22:00", "07:00", "22", "7").
 */
function parseQuietHourTime(timeStr) {
  if (!timeStr || typeof timeStr !== "string") return null;
  const s = timeStr.trim();
  if (/[a-z]/i.test(s)) {
    return parseTimeString(s);
  }
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  const period = h >= 12 ? "PM" : "AM";
  const displayHour = h % 12 === 0 ? 12 : h % 12;
  const displayMinute = min > 0 ? ":" + String(min).padStart(2, "0") : ":00";
  return {
    hour: h,
    minute: min,
    formatted: `${displayHour}${min > 0 ? ":" + String(min).padStart(2, "0") : ""}${period.toLowerCase()}`,
    display: `${displayHour}${displayMinute} ${period}`
  };
}

/**
 * Parses quiet hours window string or object.
 * Examples:
 *   "10pm-7am", "10pm to 7am", "22:00-07:00", "10:30pm - 6:30am"
 *   "off", "none", "disable", "disabled", false
 * Returns:
 *   { enabled: true, start: "22:00", end: "07:00", startHour: 22, startMinute: 0, endHour: 7, endMinute: 0, raw: "22:00-07:00", display: "10:00 PM – 7:00 AM" }
 *   or { enabled: false, raw: "off", display: "Disabled (Off)" }
 */
function parseQuietHours(val) {
  if (val === undefined || val === null) {
    return parseQuietHours(DEFAULT_QUIET_HOURS);
  }
  if (val === false || val === 0) {
    return { enabled: false, raw: "off", display: "Disabled (Off)" };
  }
  if (typeof val === "object") {
    if (val.enabled === false) {
      return { enabled: false, raw: "off", display: "Disabled (Off)" };
    }
    if (val.start && val.end) {
      return parseQuietHours(`${val.start}-${val.end}`);
    }
    if (val.raw) {
      return parseQuietHours(val.raw);
    }
    return parseQuietHours(DEFAULT_QUIET_HOURS);
  }
  if (typeof val === "string") {
    const s = val.trim().toLowerCase();
    if (["off", "none", "disabled", "disable", "false", "0"].includes(s)) {
      return { enabled: false, raw: "off", display: "Disabled (Off)" };
    }
    const parts = s.split(/\s*(?:-|–|—|\bto\b)\s*/i).map(p => p.trim()).filter(Boolean);
    if (parts.length === 2) {
      const t1 = parseQuietHourTime(parts[0]);
      const t2 = parseQuietHourTime(parts[1]);
      if (t1 && t2) {
        const startStr = `${String(t1.hour).padStart(2, "0")}:${String(t1.minute).padStart(2, "0")}`;
        const endStr = `${String(t2.hour).padStart(2, "0")}:${String(t2.minute).padStart(2, "0")}`;
        const dStartH = t1.hour % 12 === 0 ? 12 : t1.hour % 12;
        const dEndH = t2.hour % 12 === 0 ? 12 : t2.hour % 12;
        const dStartM = String(t1.minute).padStart(2, "0");
        const dEndM = String(t2.minute).padStart(2, "0");
        const pStart = t1.hour >= 12 ? "PM" : "AM";
        const pEnd = t2.hour >= 12 ? "PM" : "AM";
        return {
          enabled: true,
          start: startStr,
          end: endStr,
          startHour: t1.hour,
          startMinute: t1.minute,
          endHour: t2.hour,
          endMinute: t2.minute,
          raw: `${startStr}-${endStr}`,
          display: `${dStartH}:${dStartM} ${pStart} – ${dEndH}:${dEndM} ${pEnd}`
        };
      }
    }
  }
  return null;
}

/**
 * Returns the parsed quiet hours configuration for a group, or the global default.
 */
function getQuietHours(jidOrName = null) {
  if (jidOrName && typeof jidOrName === "object") {
    const rawVal = jidOrName.quietHours !== undefined
      ? jidOrName.quietHours
      : (jidOrName.quietHoursWindow !== undefined ? jidOrName.quietHoursWindow : DEFAULT_QUIET_HOURS);
    return parseQuietHours(rawVal) || parseQuietHours(DEFAULT_QUIET_HOURS);
  }

  const getCfgFn = module.exports?.getGroupConfig || getGroupConfig;
  let groupCfg = null;
  try {
    groupCfg = getCfgFn(jidOrName);
  } catch (_) {}

  if (groupCfg && (groupCfg.quietHours !== undefined || groupCfg.quietHoursWindow !== undefined)) {
    return parseQuietHours(groupCfg.quietHours !== undefined ? groupCfg.quietHours : groupCfg.quietHoursWindow) || parseQuietHours(DEFAULT_QUIET_HOURS);
  }

  const cfg = cachedConfig || loadRawConfig() || {};
  let groupVal = null;
  if (jidOrName && cfg.groups && typeof cfg.groups === "object") {
    const key = findConfigGroupKey(cfg, jidOrName);
    if (key) {
      groupVal = cfg.groups[key];
    }
  }
  const defaults = cfg.defaults || {};

  const rawVal = groupVal?.quietHours !== undefined
    ? groupVal.quietHours
    : (groupVal?.quietHoursWindow !== undefined
      ? groupVal.quietHoursWindow
      : (defaults.quietHours !== undefined
        ? defaults.quietHours
        : (defaults.quietHoursWindow !== undefined ? defaults.quietHoursWindow : DEFAULT_QUIET_HOURS)));

  const parsed = parseQuietHours(rawVal);
  return parsed || parseQuietHours(DEFAULT_QUIET_HOURS);
}

function isInQuietHours(now = Date.now(), jidOrName = null) {
  const getQhFn = module.exports?.getQuietHours || getQuietHours;
  const qh = getQhFn(jidOrName);
  if (!qh || !qh.enabled) return false;

  const parts = getSanJoseParts(new Date(now));
  const currentMinute = parts.hour * 60 + parts.minute;
  const startMinute = qh.startHour * 60 + qh.startMinute;
  const endMinute = qh.endHour * 60 + qh.endMinute;

  if (startMinute === endMinute) return false;

  if (startMinute > endMinute) {
    return currentMinute >= startMinute || currentMinute < endMinute;
  } else {
    return currentMinute >= startMinute && currentMinute < endMinute;
  }
}

/**
 * Checks if now falls within the 60-minute wake-up window immediately after quiet hours end.
 * Used to bypass missed reminders if another reminder is already scheduled within 1 hour.
 */
function isQuietHoursWakeUpWindow(now = Date.now(), jidOrName = null) {
  const getQhFn = module.exports?.getQuietHours || getQuietHours;
  const qh = getQhFn(jidOrName);
  if (!qh || !qh.enabled) return false;

  const parts = getSanJoseParts(new Date(now));
  const currentMinute = parts.hour * 60 + parts.minute;
  const endMinute = qh.endHour * 60 + qh.endMinute;

  const diff = (currentMinute - endMinute + 1440) % 1440;
  return diff >= 0 && diff < 60;
}

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
    const tm = rawTime.match(/(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?/i);
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
 * Parses an inactivity period into a number of weeks.
 * Supports numbers (e.g. 12), or strings ('12', '12w', '12 weeks', '84d').
 * Defaults to 12 weeks.
 */
function parseInactivityWeeks(val) {
  if (typeof val === 'number') {
    if (val > 0 && val < 500) return val;
    return Math.max(1, Math.round(val / (7 * 24 * 60 * 60 * 1000)));
  }
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    const wMatch = s.match(/^(\d+(?:\.\d+)?)\s*(w|weeks?)$/i);
    if (wMatch) return parseFloat(wMatch[1]);
    const dMatch = s.match(/^(\d+(?:\.\d+)?)\s*(d|days?)$/i);
    if (dMatch) return Math.max(1, Math.round(parseFloat(dMatch[1]) / 7));
    const mMatch = s.match(/^(\d+(?:\.\d+)?)\s*(m|months?)$/i);
    if (mMatch) return Math.max(1, Math.round(parseFloat(mMatch[1]) * 4.33));
    if (/^\d+$/.test(s)) {
      const num = parseInt(s, 10);
      return num > 0 ? num : 12;
    }
  }
  return 12;
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

  const rawDefaultNotifications = defaults.notifications;
  const cleanDefaultNotifications = Array.isArray(rawDefaultNotifications)
    ? rawDefaultNotifications
    : (typeof rawDefaultNotifications === "string" ? rawDefaultNotifications.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean) : []);

  const rawDefaultInactivity = defaults.inactivityPeriodWeeks !== undefined
    ? defaults.inactivityPeriodWeeks
    : (defaults.inactivityPeriod !== undefined
      ? defaults.inactivityPeriod
      : (defaults.inactivePlayerPeriod !== undefined
        ? defaults.inactivePlayerPeriod
        : defaults.inactivePeriod));
  const defaultInactivityWeeks = parseInactivityWeeks(rawDefaultInactivity);
  const rawDefaultQuietHours = defaults.quietHours !== undefined
    ? defaults.quietHours
    : (defaults.quietHoursWindow !== undefined ? defaults.quietHoursWindow : DEFAULT_QUIET_HOURS);
  const defaultQh = parseQuietHours(rawDefaultQuietHours) || parseQuietHours(DEFAULT_QUIET_HOURS);

  if (!jidOrName) {
    return {
      sport: defaults.sport || 'tennis',
      quietHours: defaultQh.raw,
      quietHoursParsed: defaultQh,
      reminderQuietHours: defaultQh.display,
      courtBookingEnabled: defaults.courtBookingEnabled !== undefined ? defaults.courtBookingEnabled : true,
      courtConfig: defaults.courtConfig || defaults.court || defaults.venue || null,
      venue: defaults.courtConfig || defaults.court || defaults.venue || null,
      autoMatchups: defaults.autoMatchups !== undefined ? defaults.autoMatchups : true,
      directCourtBookingAccounts: Array.isArray(defaults.directCourtBookingAccounts) ? defaults.directCourtBookingAccounts : [],
      defaultBookingPlayers: Array.isArray(defaults.defaultBookingPlayers) ? defaults.defaultBookingPlayers : (Array.isArray(defaults.bookingPlayers) ? defaults.bookingPlayers : []),
      bookingPlayers: Array.isArray(defaults.defaultBookingPlayers) ? defaults.defaultBookingPlayers : (Array.isArray(defaults.bookingPlayers) ? defaults.bookingPlayers : []),
      ignoredCourts: Array.isArray(defaults.ignoredCourts) ? defaults.ignoredCourts : [],
      tentativeBookingTitles: Array.isArray(defaults.tentativeBookingTitles)
        ? defaults.tentativeBookingTitles
        : (typeof defaults.tentativeBookingTitles === "string" ? defaults.tentativeBookingTitles.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean) : []),
      notifications: cleanDefaultNotifications,
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
      bookingScheduleParsed: parsedDefaultBookingSchedule,
      inactivityPeriodWeeks: defaultInactivityWeeks,
      inactivityPeriod: defaultInactivityWeeks,
      inactivePlayerPeriod: `${defaultInactivityWeeks}w`,
      inactivePeriod: `${defaultInactivityWeeks}w`,
      multiVote: defaults.multiVote !== undefined ? Boolean(defaults.multiVote) : true,
      multiSessionMode: defaults.multiSessionMode || "single_session"
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
  const courtTentativeTitles = targetCourtConfig ? (courtsConfig.getTentativeBookingTitles ? courtsConfig.getTentativeBookingTitles(targetCourtConfig) : []) : [];

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

  const rawNotifications = groupSpecific?.notifications !== undefined
    ? groupSpecific.notifications
    : (defaults.notifications !== undefined ? defaults.notifications : []);

  const cleanNotifications = Array.isArray(rawNotifications)
    ? rawNotifications
    : (typeof rawNotifications === "string" ? rawNotifications.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean) : []);

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

  const rawTentativeTitles = groupSpecific?.tentativeBookingTitles !== undefined
    ? groupSpecific.tentativeBookingTitles
    : (groupSpecific?.tentativeCourtBookingTitles !== undefined
      ? groupSpecific.tentativeCourtBookingTitles
      : (defaults.tentativeBookingTitles !== undefined
        ? defaults.tentativeBookingTitles
        : (defaults.tentativeCourtBookingTitles !== undefined ? defaults.tentativeCourtBookingTitles : courtTentativeTitles)));

  const cleanTentativeTitles = Array.isArray(rawTentativeTitles)
    ? rawTentativeTitles
    : (typeof rawTentativeTitles === "string" ? rawTentativeTitles.split(/[,;\n]+/).map(s => s.trim()).filter(Boolean) : []);

  const rawInactivity = groupSpecific?.inactivityPeriodWeeks !== undefined
    ? groupSpecific.inactivityPeriodWeeks
    : (groupSpecific?.inactivityPeriod !== undefined
      ? groupSpecific.inactivityPeriod
      : (groupSpecific?.inactivePlayerPeriod !== undefined
        ? groupSpecific.inactivePlayerPeriod
        : (groupSpecific?.inactivePeriod !== undefined
          ? groupSpecific.inactivePeriod
          : rawDefaultInactivity)));

  const inactivityWeeks = parseInactivityWeeks(rawInactivity);

  const rawGrpQh = groupSpecific?.quietHours !== undefined ? groupSpecific.quietHours : (groupSpecific?.quietHoursWindow !== undefined ? groupSpecific.quietHoursWindow : rawDefaultQuietHours);
  const groupQh = parseQuietHours(rawGrpQh) || defaultQh;
  return {
    name: groupSpecific?.name || jidOrName,
    quietHours: groupQh.raw,
    quietHoursParsed: groupQh,
    reminderQuietHours: groupQh.display,
    sport: groupSpecific?.sport || defaults.sport || 'tennis',
    courtBookingEnabled,
    courtConfig: targetCourtConfig,
    venue: targetCourtConfig, // alias for backwards compatibility
    ignoredCourts: targetCourtConfig ? (Array.isArray(groupSpecific?.ignoredCourts)
      ? groupSpecific.ignoredCourts
      : (Array.isArray(defaults.ignoredCourts) ? defaults.ignoredCourts : fallbackIgnored)) : [],
    tentativeBookingTitles: cleanTentativeTitles,
    tentativeCourtBookingTitles: cleanTentativeTitles,
    autoMatchups: groupSpecific?.autoMatchups !== undefined
      ? groupSpecific.autoMatchups
      : (defaults.autoMatchups !== undefined ? defaults.autoMatchups : true),
    directCourtBookingAccounts: cleanDirectAccounts,
    defaultBookingPlayers: cleanDefaultBookingPlayers,
    bookingPlayers: cleanDefaultBookingPlayers,
    preBookCourts: cleanPreBookCourts,
    preBookCourtsCount: cleanPreBookCourts,
    notifications: cleanNotifications,
    bookingCourtPreference: cleanCourtPreference,
    bookingStrategy: cleanBookingStrategy,
    bookingSchedule: rawBookingSchedule,
    bookingScheduleParsed: parsedBookingSchedule,
    inactivityPeriodWeeks: inactivityWeeks,
    inactivityPeriod: inactivityWeeks,
    inactivePlayerPeriod: `${inactivityWeeks}w`,
    inactivePeriod: `${inactivityWeeks}w`,
    multiVote: defaults.multiVote !== undefined ? Boolean(defaults.multiVote) : true,
    multiSessionMode: defaults.multiSessionMode || "single_session",
    ...groupSpecific,
    courtBookingEnabled,
    courtConfig: targetCourtConfig,
    venue: targetCourtConfig,
    defaultBookingPlayers: cleanDefaultBookingPlayers,
    bookingPlayers: cleanDefaultBookingPlayers,
    preBookCourts: cleanPreBookCourts,
    preBookCourtsCount: cleanPreBookCourts,
    notifications: cleanNotifications,
    bookingCourtPreference: cleanCourtPreference,
    bookingStrategy: cleanBookingStrategy,
    bookingSchedule: rawBookingSchedule,
    bookingScheduleParsed: parsedBookingSchedule,
    inactivityPeriodWeeks: inactivityWeeks,
    inactivityPeriod: inactivityWeeks,
    inactivePlayerPeriod: `${inactivityWeeks}w`,
    inactivePeriod: `${inactivityWeeks}w`,
    quietHours: groupQh.raw,
    quietHoursParsed: groupQh,
    reminderQuietHours: groupQh.display
  };
}

/**
 * Returns the preferred list of courts to book for a group (e.g. [2, 3, 1, 5, 6]).
 */
function getTentativeBookingTitles(jidOrName = null) {
  const groupCfg = (module.exports.getGroupConfig || getGroupConfig)(jidOrName);
  return groupCfg?.tentativeBookingTitles || [];
}

/**
 * Returns the configured inactivity period in weeks for a group (default 4).
 */
function getInactivityPeriodWeeks(jidOrName = null) {
  const groupCfg = (module.exports.getGroupConfig || getGroupConfig)(jidOrName);
  const raw = groupCfg?.inactivityPeriodWeeks !== undefined
    ? groupCfg.inactivityPeriodWeeks
    : (groupCfg?.inactivityPeriod !== undefined
      ? groupCfg.inactivityPeriod
      : (groupCfg?.inactivePlayerPeriod !== undefined
        ? groupCfg.inactivePlayerPeriod
        : groupCfg?.inactivePeriod));
  return parseInactivityWeeks(raw);
}

/**
 * Returns the configured inactivity period for a group (e.g. '4w'). Defaults to '4w'.
 */
function getInactivePlayerPeriod(jidOrName = null) {
  const weeks = getInactivityPeriodWeeks(jidOrName);
  return `${weeks}w`;
}

/**
 * Matches a booking title against a pattern, which can be:
 * - A RegExp instance
 * - A regex literal string in /pattern/flags format (e.g. "/^Team Practice/i")
 * - A plain substring (case-insensitive)
 * - A raw regex pattern string (e.g. "^Clinic.*Practice$", "Junior.*Clinic")
 */
function matchesTentativePattern(title, pattern) {
  if (!title || !pattern) return false;
  const titleStr = String(title).trim();
  if (!titleStr) return false;

  if (pattern instanceof RegExp) {
    try {
      pattern.lastIndex = 0;
      return pattern.test(titleStr);
    } catch (_) {
      return false;
    }
  }

  const rawPattern = String(pattern).trim();
  if (!rawPattern) return false;

  // Check if string is in /pattern/flags format (e.g. "/^Team Practice/i")
  const slashMatch = rawPattern.match(/^\/(.+)\/([a-z]*)$/i);
  if (slashMatch) {
    try {
      const regexPattern = slashMatch[1];
      const flags = slashMatch[2] !== "" ? slashMatch[2].replace(/[gy]/g, "") : "i";
      const re = new RegExp(regexPattern, flags);
      return re.test(titleStr);
    } catch (_) {
      return false;
    }
  }

  // Plain string match (case-insensitive substring or exact match)
  const cleanTitle = titleStr.toLowerCase();
  const cleanPattern = rawPattern.toLowerCase();
  if (cleanTitle === cleanPattern || cleanTitle.includes(cleanPattern)) {
    return true;
  }

  // Raw regex string fallback (e.g. "^Clinic.*Practice$", "Junior.*Clinic")
  try {
    const re = new RegExp(rawPattern, "i");
    return re.test(titleStr);
  } catch (_) {
    return false;
  }
}

function isTentativeBookingTitle(title, jidOrName = null) {
  if (!title) return false;
  const titles = (module.exports.getTentativeBookingTitles || getTentativeBookingTitles)(jidOrName);
  if (!titles || titles.length === 0) return false;
  return titles.some((pattern) => matchesTentativePattern(title, pattern));
}

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
 * Returns list of normalized recipient LIDs for notifications (booking, cancellations, inactivity) for a group.
 */
function getNotifications(jidOrName = null) {
  if (module.exports && typeof module.exports.getBookingNotifications === "function" && module.exports.getBookingNotifications !== getBookingNotifications && module.exports.getBookingNotifications !== module.exports.getNotifications) {
    return module.exports.getBookingNotifications(jidOrName);
  }
  const groupCfg = getGroupConfig(jidOrName);
  const rawList = groupCfg?.notifications || [];
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

function getBookingNotifications(jidOrName = null) {
  return (module.exports?.getNotifications || getNotifications)(jidOrName);
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
    const clean = t.replace(/['\"]/g, '');
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
 * Retrieves the list of superadmin destination JIDs explicitly configured in .env (SUPERADMIN_ACCOUNT).
 */
function getSuperAdminJids() {
  const raw = process.env.SUPERADMIN_ACCOUNT || process.env.SUPERADMIN_LID || process.env.SUPERADMIN_LIDS || process.env.SUPERADMIN || "";
  if (!raw || !raw.trim()) return [];
  const tokens = raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  const jids = [];
  const seen = new Set();
  for (const t of tokens) {
    let clean = t.replace(/['\"]/g, "").trim();
    if (!clean) continue;
    if (!clean.includes("@")) {
      clean = `${clean}@s.whatsapp.net`;
    }
    const lower = clean.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      jids.push(clean);
    }
  }
  return jids;
}

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
  if (options.notifications !== undefined) {
    const raw = options.notifications;
    groupData.notifications = Array.isArray(raw)
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
  if (options.tentativeBookingTitles !== undefined || options.tentativeCourtBookingTitles !== undefined) {
    const raw = options.tentativeBookingTitles !== undefined ? options.tentativeBookingTitles : options.tentativeCourtBookingTitles;
    groupData.tentativeBookingTitles = Array.isArray(raw)
      ? raw
      : String(raw).split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
  }
  if (options.preBookCourts !== undefined || options.preBookCourtsCount !== undefined) {
    const rawVal = options.preBookCourts !== undefined ? options.preBookCourts : options.preBookCourtsCount;
    const val = parseInt(rawVal, 10);
    if (!Number.isNaN(val) && val > 0) groupData.preBookCourts = val;
  }
  if (options.bookingStrategy) {
    groupData.bookingStrategy = String(options.bookingStrategy).trim().toLowerCase();
  }
  if (options.bookingSchedule) {
    groupData.bookingSchedule = options.bookingSchedule;
  }
  if (options.inactivityPeriod !== undefined || options.inactivityPeriodWeeks !== undefined || options.inactivePlayerPeriod !== undefined) {
    const raw = options.inactivityPeriod !== undefined
      ? options.inactivityPeriod
      : (options.inactivityPeriodWeeks !== undefined ? options.inactivityPeriodWeeks : options.inactivePlayerPeriod);
    groupData.inactivityPeriod = parseInactivityWeeks(raw);
  }
  if (options.quietHours !== undefined || options.quietHoursWindow !== undefined || options.reminderQuietHours !== undefined) {
    const rawQh = options.quietHours !== undefined ? options.quietHours : (options.quietHoursWindow !== undefined ? options.quietHoursWindow : options.reminderQuietHours);
    const parsedQh = parseQuietHours(rawQh);
    if (parsedQh) {
      groupData.quietHours = parsedQh.raw;
    }
  }

  cfg.groups[cleanJid] = groupData;
  saveRawConfig(cfg);
  return { jid: cleanJid, ...groupData };
}

/**
 * Removes a group from groups.json.
 */
function removeGroup(jidOrName) {
  const cfg = loadRawConfig();
  if (!cfg || !cfg.groups) return null;

  let foundKey = findConfigGroupKey(cfg, jidOrName);
  if (!foundKey) {
    if (typeof jidOrName === "string" && jidOrName.endsWith("@g.us")) {
      foundKey = jidOrName;
      cfg.groups[foundKey] = { name: jidOrName };
    } else {
      return null;
    }
  }

  const removed = { jid: foundKey, ...cfg.groups[foundKey] };
  delete cfg.groups[foundKey];
  saveRawConfig(cfg);
  return removed;
}

/**
 * Updates settings for an existing group in groups.json.
 */
function updateGroupConfig(jidOrName, updates = {}) {
  const cfg = loadRawConfig();
  if (!cfg || !cfg.groups) throw new Error('No groups configuration found.');

  const foundKey = findConfigGroupKey(cfg, jidOrName);
  if (!foundKey) return null;

  const existing = cfg.groups[foundKey];
  const processed = { ...updates };

  if (processed.defaultBookingPlayers !== undefined || processed.bookingPlayers !== undefined) {
    const rawBP = processed.defaultBookingPlayers !== undefined ? processed.defaultBookingPlayers : processed.bookingPlayers;
    processed.defaultBookingPlayers = Array.isArray(rawBP) ? rawBP : (typeof rawBP === "string" ? rawBP.split(/[,;]+/).map(s => s.trim()).filter(Boolean) : []);
    delete processed.bookingPlayers;
  }

  if (processed.directCourtBookingAccounts !== undefined) {
    const raw = processed.directCourtBookingAccounts;
    processed.directCourtBookingAccounts = Array.isArray(raw)
      ? raw
      : String(raw).split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  }

  if (processed.notifications !== undefined) {
    const raw = processed.notifications;
    processed.notifications = Array.isArray(raw)
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

  if (processed.tentativeBookingTitles !== undefined || processed.tentativeCourtBookingTitles !== undefined) {
    const raw = processed.tentativeBookingTitles !== undefined ? processed.tentativeBookingTitles : processed.tentativeCourtBookingTitles;
    if (typeof raw === "string" && (raw.trim().toLowerCase() === "none" || raw.trim().toLowerCase() === "null" || raw.trim().toLowerCase() === "[]")) {
      processed.tentativeBookingTitles = [];
      delete existing.tentativeBookingTitles;
      delete existing.tentativeCourtBookingTitles;
    } else {
      processed.tentativeBookingTitles = Array.isArray(raw)
        ? raw
        : String(raw).split(/[,;\n]+/).map(s => s.trim()).filter(Boolean);
    }
    delete processed.tentativeCourtBookingTitles;
  }

  if (processed.courtConfig !== undefined || processed.venue !== undefined || processed.court !== undefined) {
    const target = processed.courtConfig || processed.venue || processed.court;
    processed.courtConfig = target;
    delete processed.venue;
    delete processed.court;
  }

  if (processed.preBookCourts !== undefined || processed.preBookCourtsCount !== undefined) {
    const rawVal = processed.preBookCourts !== undefined ? processed.preBookCourts : processed.preBookCourtsCount;
    const val = parseInt(rawVal, 10);
    if (!Number.isNaN(val) && val > 0) {
      processed.preBookCourts = val;
    }
    delete processed.preBookCourtsCount;
  }

  if (processed.bookingStrategy !== undefined) {
    processed.bookingStrategy = String(processed.bookingStrategy).trim().toLowerCase();
  }

  if (processed.inactivityPeriod !== undefined || processed.inactivityPeriodWeeks !== undefined || processed.inactivePlayerPeriod !== undefined) {
    const raw = processed.inactivityPeriod !== undefined
      ? processed.inactivityPeriod
      : (processed.inactivityPeriodWeeks !== undefined ? processed.inactivityPeriodWeeks : processed.inactivePlayerPeriod);
    processed.inactivityPeriod = parseInactivityWeeks(raw);
    delete processed.inactivityPeriodWeeks;
    delete processed.inactivePlayerPeriod;
  }

  if (processed.quietHours !== undefined || processed.quietHoursWindow !== undefined || processed.reminderQuietHours !== undefined) {
    const rawQh = processed.quietHours !== undefined
      ? processed.quietHours
      : (processed.quietHoursWindow !== undefined ? processed.quietHoursWindow : processed.reminderQuietHours);
    const parsedQh = parseQuietHours(rawQh);
    if (parsedQh) {
      processed.quietHours = parsedQh.raw;
    }
    delete processed.quietHoursWindow;
    delete processed.reminderQuietHours;
  }

  cfg.groups[foundKey] = {
    ...existing,
    ...processed
  };

  saveRawConfig(cfg);
  return { jid: foundKey, ...cfg.groups[foundKey] };
}

/**
 * Formats a single group's configuration for display.
 */
function formatGroupConfig(jid, config = null) {
  const c = config || getGroupConfig(jid);
  if (!c) return `Group not found: ${jid}`;

  const lines = [
    `*Group:* ${c.name || jid} (\`${jid}\`)`,
    `*Sport:* ${c.sport || 'tennis'}`,
    `*Court Booking Enabled:* ${c.courtBookingEnabled ? 'Yes' : 'No'}`
  ];

  if (c.alias) lines.push(`*Alias:* ${c.alias}`);
  if (c.courtConfig || c.venue) lines.push(`*Court Config:* ${c.courtConfig || c.venue}`);
  if (c.autoMatchups !== undefined) lines.push(`*Auto Matchups:* ${c.autoMatchups ? 'Yes' : 'No'}`);

  if (c.directCourtBookingAccounts && c.directCourtBookingAccounts.length > 0) {
    lines.push(`*Direct Court Booking Accounts:* ${c.directCourtBookingAccounts.join(', ')}`);
  }

  if (c.defaultBookingPlayers && c.defaultBookingPlayers.length > 0) {
    lines.push(`*Default Booking Players:* ${c.defaultBookingPlayers.join(', ')}`);
  }

  if (c.ignoredCourts && c.ignoredCourts.length > 0) {
    lines.push(`*Ignored Courts:* ${c.ignoredCourts.join(', ')}`);
  }

  if (c.tentativeBookingTitles && c.tentativeBookingTitles.length > 0) {
    lines.push(`*Tentative Court Booking Titles:* ${c.tentativeBookingTitles.join(', ')}`);
  }

  if (c.preBookCourts) {
    lines.push(`*Pre-Book Courts (Auto):* ${c.preBookCourts}`);
  }

  const notifs = c.notifications;
  if (notifs && notifs.length > 0) {
    lines.push(`*Notifications:* ${notifs.join(", ")}`);
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

  if (c.inactivityPeriod !== undefined || c.inactivityPeriodWeeks !== undefined) {
    const weeks = c.inactivityPeriodWeeks || c.inactivityPeriod;
    lines.push(`*Inactivity Period:* ${weeks} week${weeks === 1 ? '' : 's'}`);
  }

  const qh = parseQuietHours(c.quietHours || c.quietHoursWindow) || parseQuietHours(DEFAULT_QUIET_HOURS);
  lines.push(`*Reminder Quiet Hours:* ${qh.display}`);

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
    const defNotifs = cfg.defaults.notifications;
    if (defNotifs && defNotifs.length > 0) {
      sections.push(`• Notifications: ${defNotifs.join(', ')}`);
    }
    if (cfg.defaults.inactivityPeriod || cfg.defaults.inactivityPeriodWeeks) {
      const weeks = cfg.defaults.inactivityPeriodWeeks || cfg.defaults.inactivityPeriod;
      sections.push(`• Inactivity Period: ${weeks} week${weeks === 1 ? '' : 's'}`);
    }
    const defQh = parseQuietHours(cfg.defaults?.quietHours || cfg.defaults?.quietHoursWindow) || parseQuietHours(DEFAULT_QUIET_HOURS);
    sections.push(`• Reminder Quiet Hours: ${defQh.display}`);
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
 * Returns { all: true, affected: [...] } or { all: false, jid, name }._
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
  getNotifications,
  getBookingNotifications,
  getTentativeBookingTitles,
  matchesTentativePattern,
  isTentativeBookingTitle,
  getBookingCourtPreference,
  getBookingStrategy,
  getBookingSchedule,
  getBookingScheduleParsed,
  parseBookingSchedule,
  normalizeBookingPlayerLists,
  getDirectCourtBookingAccounts,
  getSuperAdminAccounts,
  getSuperAdminLids,
  getSuperAdminJids,
  isSuperAdmin,
  saveRawConfig,
  addGroup,
  removeGroup,
  updateGroupConfig,
  formatGroupConfig,
  formatAllGroupsConfig,
  getGroupJid,
  pauseCourtBookings,
  resumeCourtBookings,
  getInactivityPeriodWeeks,
  getInactivePlayerPeriod,
  parseInactivityWeeks,
  DEFAULT_QUIET_HOURS,
  parseQuietHours,
  getQuietHours,
  isInQuietHours,
  isQuietHoursWakeUpWindow
};
