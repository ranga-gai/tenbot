/**
 * Recurring Polls module: manages creation, listing, cancellation, pausing,
 * modification, and automatic posting of recurring tennis match polls (daily or on specific days of the week).
 * Supports day-of-week configurable poll creation times and posting more than 24 hours in advance
 * (e.g., play at 7pm on Monday with poll created at Sunday 6pm or 2 days before).
 */

const pollTime = require('./pollTime');
const scvcc = require('./scvcc');
const groupsConfig = require('./groupsConfig');
const courtsConfig = require('./courtsConfig');
const messageHistory = require('./messageHistory');
const { parseTimeString, getSanJoseParts, WORD_TO_NUMBER, NUMBER_WORDS_PATTERN, parseLookAround, formatLookAround, getCandidateTimes } = pollTime;


/**
 * Extracts a JSON object or bracketed key-value map from user command text.
 * Returns the parsed map object and the text with the map removed.
 */
function extractJsonMap(text) {
  if (!text || typeof text !== 'string') return { map: null, remainingText: text };
  const match = text.match(/\{[\s\S]*?\}/);
  if (!match) return { map: null, remainingText: text };

  const rawJson = match[0];
  let parsedMap = null;
  try {
    parsedMap = JSON.parse(rawJson);
  } catch (err) {
    const inner = rawJson.slice(1, -1);
    const map = {};
    const kvRegex = /(?:["']?([a-zA-Z0-9_\-\s]+)["']?)\s*[:=]\s*(?:["']([^"']+)["']|([^,{}]+))/g;
    let m;
    while ((m = kvRegex.exec(inner)) !== null) {
      const key = m[1].trim();
      const val = (m[2] !== undefined ? m[2] : m[3]).trim();
      if (key && val) map[key] = val;
    }
    if (Object.keys(map).length > 0) {
      parsedMap = map;
    }
  }

  if (parsedMap && Object.keys(parsedMap).length > 0) {
    let remainingText = text.replace(rawJson, ' ');
    remainingText = remainingText.replace(/\b(?:post(?:ed)?|posting|at)\s*$/i, ' ');
    remainingText = remainingText.replace(/\s{2,}/g, ' ').trim();
    return { map: parsedMap, remainingText, rawJson };
  }
  return { map: null, remainingText: text };
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Sanitizes input text by removing zero-width characters and normalizing Unicode whitespace.
 */
function cleanIncomingText(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, '')
    .replace(/[\u00a0\u202f\u2000-\u200a]/g, ' ')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .trim();
}

/**
 * Extracts and strips command-line flags and key-value options from command text
 * so they don't interfere with positional size, matchTime, and day parsing.
 */
function extractCommonFlags(text, jsonMap = null) {
  let rem = text ? String(text) : '';
  const flags = {};

  // 1. bookingStrategy
  if (jsonMap) {
    const val = jsonMap['booking-strategy'] ?? jsonMap['bookingStrategy'] ?? jsonMap['strategy'];
    if (val !== undefined) flags.bookingStrategy = String(val).toLowerCase().trim();
  }
  const bsRegex = /(?:--(?:booking-?strategy|strategy)=([a-z-]+)|\b(?:booking\s*strategy|strategy)\s*[:=]\s*([a-z-]+))/i;
  const bsMatch = rem.match(bsRegex);
  if (bsMatch) {
    if (flags.bookingStrategy === undefined) flags.bookingStrategy = (bsMatch[1] || bsMatch[2]).toLowerCase().trim();
    rem = rem.replace(bsMatch[0], ' ');
  }

  // 2. bookingSchedule
  if (jsonMap) {
    const val = jsonMap['booking-schedule'] ?? jsonMap['bookingSchedule'] ?? jsonMap['schedule'];
    if (val !== undefined) flags.bookingSchedule = val;
  }
  const bSchedRegex = /(?:--(?:booking-?schedule|bookingSchedule)\s*=?\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))|\bbooking\s*schedule\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|(-?\d+\s*[a-z0-9:]+(?:\s*[a-z0-9:]+)?)))/i;
  const bSchedMatch = rem.match(bSchedRegex);
  if (bSchedMatch) {
    if (flags.bookingSchedule === undefined) flags.bookingSchedule = (bSchedMatch[1] || bSchedMatch[2] || bSchedMatch[3] || bSchedMatch[4] || bSchedMatch[5] || bSchedMatch[6]).trim();
    rem = rem.replace(bSchedMatch[0], ' ');
  }

  // 3. preBookCourts (parsed before courtBookingType so --pre-book-courts is not partially matched by --pre-book)
  const pbCourtsMatch = rem.match(/(?:--(?:pre-?book-?courts?|courts-?to-?book|prebook-?courts?)(?:=(\d+)|\s+(\d+))|(?<!-)\b(?:pre-?book|book)\s+(\d+)\s+courts?|(?<!-)\b(?:pre-?book-?courts?|preBookCourts)\s*[:=]\s*(\d+))/i);
  if (pbCourtsMatch) {
    const valStr = pbCourtsMatch[1] || pbCourtsMatch[2] || pbCourtsMatch[3] || pbCourtsMatch[4];
    if (valStr && parseInt(valStr, 10) > 0) {
      flags.preBookCourts = parseInt(valStr, 10);
    }
    rem = rem.replace(pbCourtsMatch[0], ' ');
  }

  // 4. courtBookingType
  const cbtRegex = /(?:^|\s)(?:--court-booking-type=(?:pre-?book|none)|--court-booking=(?:pre-?book|none)|--booking-type=(?:pre-?book|none)|--booking=(?:pre-?book|none)|--pre-?book|--prebook)(?![-\w])/i;
  const cbtMatch = rem.match(cbtRegex);
  if (cbtMatch) {
    const m = rem.match(/(?:--court-booking-type|--court-booking|--booking-type|--booking)=([a-z-]+)/i);
    if (m) {
      const val = m[1].toLowerCase();
      flags.courtBookingType = (val === 'prebook' || val === 'pre-book') ? 'pre-book' : (val === 'none' ? 'none' : val);
    } else {
      flags.courtBookingType = 'pre-book';
    }
    rem = rem.replace(cbtMatch[0], ' ');
  } else if (/(?:^|[^-])\b(?:court\s*booking\s*type\s*[:=]?\s*pre-?book|booking\s*type\s*[:=]?\s*pre-?book|pre-?book(?:ing)?\s+(?:a\s+)?courts?|book\s+(?:a\s+)?courts?\s+in\s+advance|advance\s+court\s+booking)\b/i.test(rem)) {
    flags.courtBookingType = 'pre-book';
    rem = rem.replace(/(?:^|[^-])\b(?:court\s*booking\s*type\s*[:=]?\s*pre-?book|booking\s*type\s*[:=]?\s*pre-?book|pre-?book(?:ing)?\s+(?:a\s+)?courts?|book\s+(?:a\s+)?courts?\s+in\s+advance|advance\s+court\s+booking)\b/i, ' ');
  } else if (/(?:^|[^-])\b(?:court\s*booking\s*type\s*[:=]?\s*none|booking\s*type\s*[:=]?\s*none|no\s+pre-?book(?:ing)?)\b/i.test(rem)) {
    flags.courtBookingType = 'none';
    rem = rem.replace(/(?:^|[^-])\b(?:court\s*booking\s*type\s*[:=]?\s*none|booking\s*type\s*[:=]?\s*none|no\s+pre-?book(?:ing)?)\b/i, ' ');
  }

  // 5. bookingPlayers
  const bpFlagMatch = rem.match(/(?:--(?:booking-?players?|booking-?names?|players?)\s*=?|(?:booking[-_\s]*players?|booking[-_\s]*names?|players?)\s*[:=]|\bwith\s+players?\s+)\s*(?:"([^"]+)"|'([^']+)'|(\[[^\]]+\](?:\s*,\s*\[[^\]]+\])*)|([^\n\r-]+?))(?=\s+--|$)/i);
  if (bpFlagMatch) {
    const rawVal = bpFlagMatch[1] || bpFlagMatch[2] || bpFlagMatch[3] || bpFlagMatch[4];
    if (rawVal && rawVal.trim()) {
      flags.bookingPlayers = groupsConfig.normalizeBookingPlayerLists(rawVal.trim());
    }
    rem = rem.replace(bpFlagMatch[0], ' ');
  } else {
    const bracketMatch = rem.match(/\b(?:with\s+players?|for\s+players?|using\s+players?|players?)\s*(\[[^\]]+\](?:\s*,\s*\[[^\]]+\])*)/i);
    if (bracketMatch && bracketMatch[1]) {
      flags.bookingPlayers = groupsConfig.normalizeBookingPlayerLists(bracketMatch[1].trim());
      rem = rem.replace(bracketMatch[0], ' ');
    }
  }

  // 6. checkCourts / noCourts
  const checkCourtsRegex = /(?:^|\s)(?:--courts?|--check-?courts?|--court-?avail(?:ability)?|--include-?courts?|--with-?courts?|--consider-?courts?|--consider-?court-?avail(?:ability)?)(?![-\w])/i;
  const naturalCourtsRegex = /\b(?:(?:consider|considering|check|checking|include|including)\s+(?:the\s+)?(?:courts?|court\s+availability|availability)|with\s+(?:the\s+)?(?:courts|court\s+availability)|(?:consider|check)\s+availability)\b/i;
  const noCourtsRegex = /(?:^|\s)(?:--no-?courts?|--without-?courts?|--no-?check-?courts?)(?![-\w])/i;
  if (checkCourtsRegex.test(rem)) {
    flags.checkCourts = true;
    rem = rem.replace(checkCourtsRegex, ' ');
  } else if (naturalCourtsRegex.test(rem)) {
    flags.checkCourts = true;
    rem = rem.replace(naturalCourtsRegex, ' ');
  } else if (noCourtsRegex.test(rem)) {
    flags.checkCourts = false;
    rem = rem.replace(noCourtsRegex, ' ');
  }

  // 7. matchups
  const noMatchRegex = /(?:^|\s)(?:--no-?matchups?|--no-?draw)(?![-\w])|\b(?:no[-_\s]*matchups?|no[-_\s]*draw|without\s+(?:auto[-_\s]*|automatic\s+)?matchups?|without\s+(?:auto[-_\s]*|automatic\s+)?draw|(?:do\s*not|don'?t)\s+(?:create|make|generate|post|auto-?generate)\s+(?:matchups?|draw|the\s+draw|the\s+matchups?)|no[-_\s]*(?:auto\s+|automatic\s+)?matchups?)\b/i;
  const autoMatchRegex = /(?:^|\s)(?:--auto-?matchups?|--auto-?draw)(?![-\w])|\b(?:auto-?matchups?|auto-?draw|with\s+matchups?|enable\s+matchups?)\b/i;
  if (noMatchRegex.test(rem)) {
    flags.autoMatchups = false;
    flags.noMatchups = true;
    rem = rem.replace(noMatchRegex, ' ');
  } else if (autoMatchRegex.test(rem)) {
    flags.autoMatchups = true;
    flags.noMatchups = false;
    rem = rem.replace(autoMatchRegex, ' ');
  }

  // 8. prebooked spots
  if (jsonMap) {
    const val = jsonMap['prebooked-spots'] ?? jsonMap['prebookedSpots'] ?? jsonMap['includePrebookedSpots'];
    if (val !== undefined) flags.includePrebookedSpots = String(val).toLowerCase() === 'true' || val === true || String(val).toLowerCase() === 'yes' || val === 1;
  }
  const noPrebookedRegex = /(?:^|\s)(?:--?no-?prebooked[-_]?spots?|no-?prebooked[-_]?spots?|--?no-?named-?spots?|--?prebooked[-_]?spots?=(?:false|no|0)|prebooked[-_]?spots?=(?:false|no|0))(?![-\w])|\b(?:without|no)\s+(?:named\s+|the\s+)?prebooked[-_]?spots?\b/i;
  const prebookedRegex = /(?:^|\s)(?:--?prebooked[-_]?spots?|prebooked[-_]?spots?)(?:=(?:true|yes|1))?(?![-\w])|(?:^|\s)(?:--with-?prebooked-?spots?|--named-?prebooked-?slots?|--prebooked-?slots?)(?![-\w])|\b(?:with|include)\s+(?:named\s+|the\s+)?prebooked[-_]?(?:spots?|slots?)\b/i;
  if (flags.includePrebookedSpots === undefined) {
    if (noPrebookedRegex.test(rem)) {
      flags.includePrebookedSpots = false;
      rem = rem.replace(noPrebookedRegex, ' ');
    } else if (prebookedRegex.test(rem)) {
      flags.includePrebookedSpots = true;
      rem = rem.replace(prebookedRegex, ' ');
    }
  }

  // 9. creator
  const incCreatorRegex = /\b(?:include\s+me|with\s+me|count\s+me\s+in|i'm\s+playing|im\s+playing)\b/i;
  const excCreatorRegex = /\b(?:exclude\s+me|without\s+me|not\s+playing|won't\s+play|wont\s+play)\b/i;
  if (incCreatorRegex.test(rem)) {
    flags.includeCreator = true;
    rem = rem.replace(incCreatorRegex, ' ');
  } else if (excCreatorRegex.test(rem)) {
    flags.includeCreator = false;
    rem = rem.replace(excCreatorRegex, ' ');
  }

  // 10. startDate & endDate
  if (jsonMap) {
    const sVal = jsonMap['start-date'] ?? jsonMap['startDate'] ?? jsonMap['start'] ?? jsonMap['from'];
    if (sVal !== undefined) flags.startDate = String(sVal).trim();
    const eVal = jsonMap['end-date'] ?? jsonMap['endDate'] ?? jsonMap['end'] ?? jsonMap['until'] ?? jsonMap['to'];
    if (eVal !== undefined) flags.endDate = String(eVal).trim();
  }

  // Explicit flags: --start-date=..., --start=..., --from=...
  const startFlagM = rem.match(/(?:--(?:start-?date|start|from)=(?:["']([^"']+)["']|([^\s]+))|-(?:s)\s+(?:["']([^"']+)["']|([^\s]+)))/i);
  if (startFlagM) {
    if (flags.startDate === undefined) flags.startDate = (startFlagM[1] || startFlagM[2] || startFlagM[3] || startFlagM[4]).trim();
    rem = rem.replace(startFlagM[0], ' ');
  }

  // Explicit flags: --end-date=..., --end=..., --until=...
  const endFlagM = rem.match(/(?:--(?:end-?date|end|until)=(?:["']([^"']+)["']|([^\s]+))|-(?:e)\s+(?:["']([^"']+)["']|([^\s]+)))/i);
  if (endFlagM) {
    if (flags.endDate === undefined) flags.endDate = (endFlagM[1] || endFlagM[2] || endFlagM[3] || endFlagM[4]).trim();
    rem = rem.replace(endFlagM[0], ' ');
  }

  // "from <start> to <end>" or "from <start> until <end>"
  const fromToM = rem.match(/\bfrom\s+([a-z0-9/\-]+(?:\s+[a-z0-9/\-]+)?)\s+(?:to|until|through|thru)\s+([a-z0-9/\-]+(?:\s+[a-z0-9/\-]+)?)\b/i);
  if (fromToM) {
    const candStart = parseDateToDateKey(fromToM[1]);
    const candEnd = parseDateToDateKey(fromToM[2]);
    if (candStart && candEnd) {
      if (flags.startDate === undefined) flags.startDate = fromToM[1].trim();
      if (flags.endDate === undefined) flags.endDate = fromToM[2].trim();
      rem = rem.replace(fromToM[0], ' ');
    }
  }

  const CONNECTIVES = new Set(['until', 'till', 'to', 'through', 'thru', 'and', 'at', 'on', 'for', 'with', 'everyday', 'weekdays', 'weekends']);
  function extractDateCandidate(str, prefixRegex) {
    const m = str.match(prefixRegex);
    if (!m) return null;
    const after = m[1].trim();
    if (/^(?:none|clear|remove|null)\b/i.test(after)) {
      return { matchStr: m[0], raw: 'none' };
    }
    const words = after.split(/\s+/);
    if (words.length >= 1) {
      const one = words[0];
      if (/^(?:today|tomorrow|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)$/i.test(one)) {
        return { matchStr: str.slice(m.index, m.index + m[0].indexOf(m[1]) + one.length), raw: one };
      }
    }
    if (words.length >= 2 && !CONNECTIVES.has(words[1].toLowerCase())) {
      const two = `${words[0]} ${words[1]}`;
      const cand2 = parseDateToDateKey(two);
      if (cand2) {
        return { matchStr: str.slice(m.index, m.index + m[0].indexOf(m[1]) + two.length), raw: two };
      }
    }
    if (words.length >= 1) {
      const one = words[0];
      const cand1 = parseDateToDateKey(one);
      if (cand1) {
        return { matchStr: str.slice(m.index, m.index + m[0].indexOf(m[1]) + one.length), raw: one };
      }
    }
    return null;
  }

  if (flags.startDate === undefined) {
    const res = extractDateCandidate(rem, /\b(?:start(?:ing)?\s*(?:date)?|starts)\s*[:=]?\s*(.+)$/i);
    if (res) {
      flags.startDate = res.raw;
      rem = rem.replace(res.matchStr, ' ');
    }
  }

  if (flags.endDate === undefined) {
    const res = extractDateCandidate(rem, /\b(?:end(?:ing)?\s*(?:date)?|ends)\s*[:=]?\s*(.+)$/i);
    if (res) {
      flags.endDate = res.raw;
      rem = rem.replace(res.matchStr, ' ');
    }
  }

  if (flags.endDate === undefined) {
    const res = extractDateCandidate(rem, /\b(?:until|till|through|thru)\s+(.+)$/i);
    if (res) {
      flags.endDate = res.raw;
      rem = rem.replace(res.matchStr, ' ');
    }
  }

  // 11. lookAround
  if (jsonMap) {
    const val = jsonMap['look-around'] ?? jsonMap['lookAround'] ?? jsonMap['lookaround'] ?? jsonMap['look-around-window'] ?? jsonMap['window'];
    if (val !== undefined) {
      const parsed = parseLookAround(val);
      if (parsed) flags.lookAround = parsed;
    }
  }

  const lookAroundRegex = /(?:--(?:look-?around(?:-?period|-?window)?|lookaround)\s*=?\s*(?:"([^"]+)"|'([^']+)'|([^\s]+))|(?:with\s+)?\blook[-_\s]*around(?:\s*(?:period|window))?\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|(\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m)\b|\b(?:one|two|three|four|half)\s+(?:an?\s+)?hours?\b|[^\s]+))|(?:with\s+)?\blook[-_\s]*around(?:\s*(?:period|window))?\s+of\s+(?:"([^"]+)"|'([^']+)'|(\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m)\b|\b(?:one|two|three|four|half)\s+(?:an?\s+)?hours?\b|[^\s]+))|(?:with\s+)?\blook[-_\s]*around(?:\s*(?:period|window))?\s+(?:(?:'([^"]+)"|'([^']+)')|(\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?|m)\b|\b(?:one|two|three|four|half)\s+(?:an?\s+)?hours?\b)))/i;

  const laMatch = rem.match(lookAroundRegex);
  if (laMatch) {
    const rawVal = laMatch[1] || laMatch[2] || laMatch[3] || laMatch[4] || laMatch[5] || laMatch[6] || laMatch[7] || laMatch[8] || laMatch[9] || laMatch[10] || laMatch[11] || laMatch[12];
    if (rawVal) {
      const parsed = parseLookAround(rawVal);
      if (parsed) flags.lookAround = parsed;
    }
    rem = rem.replace(laMatch[0], ' ');
  }

  rem = rem.replace(/\s+/g, ' ').trim();
  return { flags, remainingText: rem };
}


const DAY_LOOKUP = {
  sun: 0, sunday: 0, sundays: 0,
  mon: 1, monday: 1, mondays: 1,
  tue: 2, tues: 2, tuesday: 2, tuesdays: 2,
  wed: 3, weds: 3, wednesday: 3, wednesdays: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, thursdays: 4,
  fri: 5, friday: 5, fridays: 5,
  sat: 6, saturday: 6, saturdays: 6
};

/**
 * Parses days of the week from a string (e.g. "weekdays", "mon,wed,fri", "tuesdays and thursdays", "sat-sun", "everyday")
 * or array of numbers/strings into a normalized list of day indices (0=Sun .. 6=Sat) and human display text.
 */
function parseDaysOfWeek(input) {
  if (!input) return { days: [0, 1, 2, 3, 4, 5, 6], display: 'Every day', raw: 'everyday' };

  if (Array.isArray(input)) {
    const dayIndices = new Set();
    for (const item of input) {
      if (typeof item === 'number' && item >= 0 && item <= 6) {
        dayIndices.add(item);
      } else if (typeof item === 'string') {
        const sub = parseDaysOfWeek(item);
        for (const d of sub.days) dayIndices.add(d);
      }
    }
    if (dayIndices.size === 0) return { days: [0, 1, 2, 3, 4, 5, 6], display: 'Every day', raw: 'everyday' };
    const sorted = [...dayIndices].sort((a, b) => a - b);
    return formatDaysResult(sorted);
  }

  const str = String(input).toLowerCase().trim();
  if (!str || /^(?:everyday|every\s*day|daily|all|any)$/i.test(str)) {
    return { days: [0, 1, 2, 3, 4, 5, 6], display: 'Every day', raw: 'everyday' };
  }

  if (/\b(?:weekdays?|mon(?:day)?\s*(?:-|to|through)\s*fri(?:day)?)\b/i.test(str)) {
    return formatDaysResult([1, 2, 3, 4, 5], 'Weekdays (Mon–Fri)');
  }

  if (/\b(?:weekends?|sat(?:urday)?\s*(?:&|and)?\s*sun(?:day)?)\b/i.test(str)) {
    return formatDaysResult([0, 6], 'Weekends (Sat, Sun)');
  }

  const dayIndices = new Set();

  // Check for day ranges (e.g. mon-thu, monday-thursday, mon to thu, mon through thu, mon thru thu, fri-sun)
  const rangeRegex = /(?:\bfrom\s+)?\b(sun(?:day|days)?|mon(?:day|days)?|tue(?:s|sday|sdays)?|wed(?:nesday|nesdays)?|thu(?:r|rs|rsday|rsdays)?|fri(?:day|days)?|sat(?:urday|urdays)?)\s*(?:-|to|through|thru|until|till)\s*(sun(?:day|days)?|mon(?:day|days)?|tue(?:s|sday|sdays)?|wed(?:nesday|nesdays)?|thu(?:r|rs|rsday|rsdays)?|fri(?:day|days)?|sat(?:urday|urdays)?)\b/gi;
  let rMatch;
  while ((rMatch = rangeRegex.exec(str)) !== null) {
    const startIdx = DAY_LOOKUP[rMatch[1].toLowerCase()];
    const endIdx = DAY_LOOKUP[rMatch[2].toLowerCase()];
    if (startIdx !== undefined && endIdx !== undefined) {
      if (startIdx <= endIdx) {
        for (let i = startIdx; i <= endIdx; i++) dayIndices.add(i);
      } else {
        for (let i = startIdx; i <= 6; i++) dayIndices.add(i);
        for (let i = 0; i <= endIdx; i++) dayIndices.add(i);
      }
    }
  }

  // Check individual day words
  const singleRegex = /\b(sundays?|sun|mondays?|mon|tuesdays?|tues|tue|wednesdays?|weds|wed|thursdays?|thurs|thur|thu|fridays?|fri|saturdays?|sat)\b/gi;
  let sMatch;
  while ((sMatch = singleRegex.exec(str)) !== null) {
    const dIdx = DAY_LOOKUP[sMatch[1].toLowerCase()];
    if (dIdx !== undefined) dayIndices.add(dIdx);
  }

  if (dayIndices.size === 0) {
    return { days: [0, 1, 2, 3, 4, 5, 6], display: 'Every day', raw: 'everyday' };
  }

  const sorted = [...dayIndices].sort((a, b) => a - b);
  return formatDaysResult(sorted);
}

function formatDaysResult(sortedDays, explicitDisplay = null) {
  if (sortedDays.length === 7) {
    return { days: sortedDays, display: 'Every day', raw: 'everyday' };
  }
  if (sortedDays.length === 5 && [1, 2, 3, 4, 5].every((d) => sortedDays.includes(d))) {
    return { days: sortedDays, display: 'Weekdays (Mon–Fri)', raw: 'weekdays' };
  }
  if (sortedDays.length === 4 && [1, 2, 3, 4].every((d) => sortedDays.includes(d))) {
    return { days: sortedDays, display: 'Mon–Thu (Mon, Tue, Wed, Thu)', raw: 'mon-thu' };
  }
  if (sortedDays.length === 2 && [0, 6].every((d) => sortedDays.includes(d))) {
    return { days: sortedDays, display: 'Weekends (Sat, Sun)', raw: 'weekends' };
  }

  // If consecutive range of 3 or more days, show range label with expanded days
  const isConsecutive = sortedDays.length >= 3 && sortedDays.every((val, idx) => idx === 0 || val === sortedDays[idx - 1] + 1);
  let defaultDisplay = sortedDays.map((d) => DAY_SHORT[d]).join(', ');
  if (isConsecutive && sortedDays.length < 5) {
    defaultDisplay = `${DAY_SHORT[sortedDays[0]]}–${DAY_SHORT[sortedDays[sortedDays.length - 1]]} (${defaultDisplay})`;
  }

  const display = explicitDisplay || defaultDisplay;
  const raw = sortedDays.map((d) => DAY_SHORT[d].toLowerCase()).join(',');
  return { days: sortedDays, display, raw };
}

/**
 * Extracts days of the week phrases from user text.
 */
function extractDaysFromText(text) {
  if (!text) return null;
  const lower = cleanIncomingText(text).toLowerCase();

  if (/\b(?:weekdays?|mon(?:day)?\s*(?:-|to|through)\s*fri(?:day)?)\b/i.test(lower)) {
    return 'weekdays';
  }
  if (/\b(?:weekends?|sat(?:urday)?\s*(?:&|and)?\s*sun(?:day)?)\b/i.test(lower)) {
    return 'weekends';
  }
  if (/\b(?:everyday|every\s+day|daily)\b/i.test(lower)) {
    return 'everyday';
  }

  const dayTokens = [];
  let textForExtract = lower;
  const rangeRegex = /(?:\b(?:on|every|from)\s+)?\b(sun(?:days?)?|mon(?:days?)?|tue(?:s(?:days?)?)?|wed(?:nesdays?)?|thu(?:r(?:s(?:days?)?)?)?|fri(?:days?)?|sat(?:urdays?)?)\s*(?:-|to|through|thru|until|till)\s*(sun(?:days?)?|mon(?:days?)?|tue(?:s(?:days?)?)?|wed(?:nesdays?)?|thu(?:r(?:s(?:days?)?)?)?|fri(?:days?)?|sat(?:urdays?)?)\b/gi;
  let rMatch;
  while ((rMatch = rangeRegex.exec(textForExtract)) !== null) {
    dayTokens.push(`${rMatch[1]}-${rMatch[2]}`);
  }
  textForExtract = textForExtract.replace(rangeRegex, ' ');

  const singleRegex = /\b(?:on\s+|every\s+)?(sundays?|sun|mondays?|mon|tuesdays?|tues|tue|wednesdays?|weds|wed|thursdays?|thurs|thur|thu|fridays?|fri|saturdays?|sat)\b/gi;
  let sMatch;
  while ((sMatch = singleRegex.exec(textForExtract)) !== null) {
    dayTokens.push(sMatch[1]);
  }

  if (dayTokens.length > 0) {
    return dayTokens.join(',');
  }

  return null;
}

/**
 * Parses a single post time configuration string (e.g. "Sunday 6pm", "1 day before at 6pm", "8am", "25 hours before")
 * for a specific match day of week (0..6) and match time.
 */
function parseSinglePostConfig(str, matchDayIndex, matchTimeObj) {
  if (!str) return null;
  const s = String(str).trim();
  const matchMinutes = matchTimeObj ? (matchTimeObj.hour * 60 + matchTimeObj.minute) : (8 * 60);

  // Check for relative "X days before" or "day before" or "previous day"
  const daysBeforeMatch = s.match(/\b(\d+)\s*days?\s*before\b/i) ||
    (s.match(/\b(?:the\s+)?(?:day|evening|night)\s*before\b/i) ? [null, '1'] : null) ||
    (s.match(/\bprevious\s*day\b/i) ? [null, '1'] : null);

  // Check for "X hours before"
  const hoursBeforeMatch = s.match(/\b(\d+(?:\.\d+)?)\s*hours?\s*(?:before|prior|in\s+advance)\b/i);

  // Extract time of day
  const timeMatch = s.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b|\b(\d{1,2}:\d{2})\b/i);
  let parsedTime = null;
  if (timeMatch) {
    parsedTime = parseTimeString(timeMatch[1] || timeMatch[2]);
  }

  let explicitPostDay = null;
  const forMatch = s.match(/\b(sun[a-z]*|mon[a-z]*|tue[a-z]*|wed[a-z]*|thu[a-z]*|fri[a-z]*|sat[a-z]*)\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})\s+for\s+(sun[a-z]*|mon[a-z]*|tue[a-z]*|wed[a-z]*|thu[a-z]*|fri[a-z]*|sat[a-z]*)\b/i) ||
    s.match(/(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})\s+(sun[a-z]*|mon[a-z]*|tue[a-z]*|wed[a-z]*|thu[a-z]*|fri[a-z]*|sat[a-z]*)\s+for\s+(sun[a-z]*|mon[a-z]*|tue[a-z]*|wed[a-z]*|thu[a-z]*|fri[a-z]*|sat[a-z]*)\b/i);

  if (forMatch) {
    const postDayWord = forMatch[1].match(/^[a-z]+$/i) ? forMatch[1] : forMatch[2];
    explicitPostDay = DAY_LOOKUP[postDayWord.toLowerCase()];
  } else {
    const dayMatches = [...s.matchAll(/\b(sun(?:day|days)?|mon(?:day|days)?|tue(?:s|sday|sdays)?|wed(?:nesday|nesdays)?|thu(?:r|rs|rsday|rsdays)?|fri(?:day|days)?|sat(?:urday|urdays)?)\b/gi)];
    if (dayMatches.length > 0) {
      for (const dm of dayMatches) {
        const d = DAY_LOOKUP[dm[1].toLowerCase()];
        if (d !== undefined) {
          explicitPostDay = d;
          break;
        }
      }
    }
  }

  if (hoursBeforeMatch) {
    const hours = parseFloat(hoursBeforeMatch[1]);
    const totalMinutesBefore = Math.round(hours * 60);
    const matchMins = matchTimeObj ? (matchTimeObj.hour * 60 + matchTimeObj.minute) : (19 * 60);
    let postMinsTotal = matchMins - totalMinutesBefore;
    let daysBefore = 0;
    while (postMinsTotal < 0) {
      postMinsTotal += 24 * 60;
      daysBefore++;
    }
    const pHour = Math.floor(postMinsTotal / 60) % 24;
    const pMinute = postMinsTotal % 60;
    const period = pHour >= 12 ? 'PM' : 'AM';
    const dHour = pHour % 12 === 0 ? 12 : pHour % 12;
    const dMinute = pMinute > 0 ? `:${String(pMinute).padStart(2, '0')}` : '';
    parsedTime = {
      hour: pHour,
      minute: pMinute,
      formatted: `${dHour}${dMinute}${period.toLowerCase()}`,
      display: `${dHour}${dMinute} ${period}`
    };
    const postDayIndex = matchDayIndex !== null && matchDayIndex !== undefined ? ((matchDayIndex - daysBefore + 7) % 7) : 0;
    return {
      hour: parsedTime.hour,
      minute: parsedTime.minute,
      postHour: parsedTime.hour,
      postMinute: parsedTime.minute,
      formatted: parsedTime.formatted,
      display: parsedTime.display,
      daysBefore,
      postDayIndex,
      postDayName: DAY_SHORT[postDayIndex]
    };
  }

  if (!parsedTime) {
    parsedTime = parseTimeString('8am');
  }

  const postMinutes = parsedTime.hour * 60 + parsedTime.minute;
  let daysBefore = 0;

  if (daysBeforeMatch) {
    daysBefore = parseInt(daysBeforeMatch[1], 10);
  } else if (explicitPostDay !== null && explicitPostDay !== undefined && matchDayIndex !== null && matchDayIndex !== undefined) {
    daysBefore = (matchDayIndex - explicitPostDay + 7) % 7;
  } else {
    if (postMinutes >= matchMinutes) {
      daysBefore = 1;
    } else {
      daysBefore = 0;
    }
  }

  const postDayIndex = matchDayIndex !== null && matchDayIndex !== undefined ? ((matchDayIndex - daysBefore + 7) % 7) : 0;

  return {
    hour: parsedTime.hour,
    minute: parsedTime.minute,
    postHour: parsedTime.hour,
    postMinute: parsedTime.minute,
    formatted: parsedTime.formatted,
    display: parsedTime.display,
    daysBefore,
    postDayIndex,
    postDayName: DAY_SHORT[postDayIndex]
  };
}

/**
 * Parses post time input which can be:
 * - A simple time string: "8am", "7:30am", "19:00"
 * - A day-of-week mapped string: "7am on weekdays, 8am on weekends", "Sunday 6pm for Monday, Monday 6pm for Tuesday", "1 day before at 6pm"
 * - An advance posting string: "Sunday 6pm", "1 day before at 6pm", "2 days before at 8am", "25 hours before"
 * - An object: { weekdays: "7am", weekends: "8am" } or { mon: "sun 6pm", tue: "mon 6pm", ... } or { mon: { postDay: "sun", time: "6pm" } }
 */
function parsePostTimes(input, defaultMatchTime = null, scheduledDays = null) {
  let matchTimeObj = typeof defaultMatchTime === 'object' ? defaultMatchTime : parseTimeString(defaultMatchTime);
  const effectiveDays = Array.isArray(scheduledDays) && scheduledDays.length > 0 ? scheduledDays : [0, 1, 2, 3, 4, 5, 6];

  const postTimesByDay = {};
  let defaultPost = null;

  if (!input) {
    const fallback = matchTimeObj && matchTimeObj.hour < 8 ? '7pm' : '8am';
    defaultPost = parseSinglePostConfig(fallback, effectiveDays[0], matchTimeObj);
    for (const d of effectiveDays) {
      postTimesByDay[d] = parseSinglePostConfig(fallback, d, matchTimeObj);
    }
  } else if (typeof input === 'object' && !Array.isArray(input)) {
    for (const [key, val] of Object.entries(input)) {
      if (!val) continue;
      const targetMatchDays = parseDaysOfWeek(key).days;
      for (const matchDay of targetMatchDays) {
        const postCfg = typeof val === 'object'
          ? parseSinglePostConfig(val.postTime || val.time || `${val.postDay || ''} ${val.time || ''}` || `${val.daysBefore || ''} days before at ${val.time || '8am'}`, matchDay, matchTimeObj)
          : parseSinglePostConfig(String(val), matchDay, matchTimeObj);
        if (postCfg) {
          postTimesByDay[matchDay] = postCfg;
          if (!defaultPost) defaultPost = postCfg;
        }
      }
    }
  } else if (typeof input === 'string') {
    const raw = input.trim();
    const clauses = raw.split(/[,;]|\band\b/i);
    let parsedAnyClause = false;

    if (clauses.length > 1) {
      for (const clause of clauses) {
        const c = clause.trim();
        if (!c) continue;
        const targetDays = parseDaysOfWeek(c).days;
        if (targetDays.length > 0 && parseDaysOfWeek(c).raw !== 'everyday') {
          for (const d of targetDays) {
            const cfg = parseSinglePostConfig(c, d, matchTimeObj);
            if (cfg) {
              postTimesByDay[d] = cfg;
              if (!defaultPost) defaultPost = cfg;
              parsedAnyClause = true;
            }
          }
        } else {
          for (const d of effectiveDays) {
            const cfg = parseSinglePostConfig(c, d, matchTimeObj);
            if (cfg) {
              postTimesByDay[d] = cfg;
              if (!defaultPost) defaultPost = cfg;
              parsedAnyClause = true;
            }
          }
        }
      }
    }

    if (!parsedAnyClause) {
      for (const d of effectiveDays) {
        const cfg = parseSinglePostConfig(raw, d, matchTimeObj);
        if (cfg) {
          postTimesByDay[d] = cfg;
          if (!defaultPost) defaultPost = cfg;
        }
      }
    }
  }

  if (!defaultPost) {
    defaultPost = parseSinglePostConfig('8am', effectiveDays[0], matchTimeObj);
  }
  for (const d of effectiveDays) {
    if (!postTimesByDay[d]) {
      postTimesByDay[d] = parseSinglePostConfig(defaultPost.formatted, d, matchTimeObj);
    }
  }

  const groups = {};
  for (const d of effectiveDays) {
    const cfg = postTimesByDay[d];
    const key = `${cfg.formatted}|${cfg.daysBefore}`;
    if (!groups[key]) groups[key] = { cfg, matchDays: [] };
    groups[key].matchDays.push(d);
  }

  const groupKeys = Object.keys(groups);
  let display = '';
  if (groupKeys.length === 1) {
    const g = groups[groupKeys[0]];
    const beforeStr = g.cfg.daysBefore > 1
      ? ` (${g.cfg.daysBefore} days before)`
      : (g.cfg.daysBefore === 1 ? ' (1 day before)' : '');
    if (effectiveDays.length === 1) {
      display = `${g.cfg.postDayName} ${g.cfg.display}${beforeStr}`;
    } else {
      display = `${g.cfg.display}${beforeStr}`;
    }
  } else {
    const parts = groupKeys.map((k) => {
      const g = groups[k];
      const matchDaysLabel = parseDaysOfWeek(g.matchDays).display;
      const beforeStr = g.cfg.daysBefore > 1
        ? ` (${g.cfg.daysBefore} days before)`
        : (g.cfg.daysBefore === 1 ? ' (1 day before)' : '');
      const dayPrefix = g.matchDays.length === 1 && g.cfg.postDayName ? `${g.cfg.postDayName} ` : '';
      return `${dayPrefix}${g.cfg.display}${beforeStr} for ${matchDaysLabel}`;
    });
    display = parts.join(', ');
  }

  return { defaultPost, postTimesByDay, display };
}

function getPostTimeForSchedule(sched, matchDayIndex) {
  if (sched.postTimesByDay) {
    if (sched.postTimesByDay[matchDayIndex]) return sched.postTimesByDay[matchDayIndex];
    if (sched.postTimesByDay[String(matchDayIndex)]) return sched.postTimesByDay[String(matchDayIndex)];
  }
  let postHour = sched.postHour;
  let postMinute = sched.postMinute;
  if (postHour === undefined && sched.postTime) {
    const pt = parseTimeString(sched.postTime);
    if (pt) {
      postHour = pt.hour;
      postMinute = pt.minute;
    }
  }
  postHour = postHour !== undefined ? postHour : 8;
  postMinute = postMinute !== undefined ? postMinute : 0;
  const matchMinutes = (sched.matchHour || 19) * 60 + (sched.matchMinute || 0);
  const postMinutes = postHour * 60 + postMinute;
  const daysBefore = sched.postDaysBefore !== undefined ? sched.postDaysBefore : (postMinutes >= matchMinutes ? 1 : 0);
  const postDayIndex = (matchDayIndex - daysBefore + 7) % 7;
  return {
    formatted: sched.postTime || '8am',
    display: sched.postDisplay || sched.postTime || '8 AM',
    hour: postHour,
    minute: postMinute,
    postHour,
    postMinute,
    daysBefore,
    postDayIndex,
    postDayName: DAY_SHORT[postDayIndex]
  };
}

/**
 * Parses user input to detect recurring/daily poll commands or natural language phrases.
 */
function parseRecurringPollText(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const text = cleanIncomingText(rawText);

  // 1. Check sub-commands (cancel/clear all, list, cancel, pause, resume, modify/edit)
  if (/^!(?:clearallrecurringpolls|clearrecurringpolls|cancelallrecurringpolls|deleteallrecurringpolls|removeallrecurringpolls|clearallrecurring|cancelallrecurring)\b/i.test(text) ||
      /^!(?:clearallrecurringpoll|cancelallrecurringpoll)\b/i.test(text) ||
      /^!(?:cancelrecurringpoll|deleterecurringpoll|removerecurringpoll|recurringpoll|dailypoll|schedulepoll|recurringpolls|dailypolls)\s+(?:all|clearall|cancelall|deleteall|clear|cancel\s+all|delete\s+all)\b/i.test(text) ||
      /\b(?:clear|cancel|delete|remove)\s+all\s+(?:daily|recurring|scheduled)\s+polls\b/i.test(text)) {
    return { action: 'clear_all' };
  }

  const statusMatch = text.match(/^!(?:recurringpoll|dailypoll|schedulepoll|recurringpolls|scheduledpolls)\s+status\s*(?:poll\s+)?(?:[`'"])?([^`'"\s]+)?(?:[`'"])?\s*$/i) ||
    text.match(/^!(?:recurringpoll|dailypoll|schedulepoll)\s+(?:[`'"])(rec_[^`'"\s]+)(?:[`'"])?\s+status\s*$/i) ||
    text.match(/\b(?:status\s+of\s+(?:the\s+)?(?:daily|recurring|scheduled)\s+poll|recurring\s+poll\s+status)\s+(?:[`'"])?([^`'"\s]+)(?:[`'"])?\b/i);
  if (statusMatch && statusMatch[1]) {
    return { action: 'status', scheduleId: statusMatch[1].trim() };
  }

  if (/^!(?:recurringpolls|scheduledpolls|dailypolls)\b/i.test(text) ||
      /^!(?:recurringpoll|dailypoll|schedulepoll)\s+(?:list|status|show)\b/i.test(text) ||
      /\b(?:list|show|view|display)\s+(?:all\s+)?(?:daily|recurring|scheduled)\s+polls\b/i.test(text)) {
    return { action: 'list' };
  }

  const cancelMatch = text.match(/^!(?:cancelrecurringpoll|deleterecurringpoll|removerecurringpoll|rmrecurringpoll|clearrecurringpoll)\s*(?:poll\s+)?(?:[`'"])?([^\s`'"]+)?(?:[`'"])?\s*$/i) ||
    text.match(/^!(?:recurringpoll|dailypoll|schedulepoll)\s+(?:cancel|delete|remove|rm|clear)\s*(?:poll\s+)?(?:[`'"])?([^\s`'"]+)?(?:[`'"])?\s*$/i) ||
    text.match(/\b(?:cancel|delete|remove|clear)\s+(?:daily|recurring|scheduled)\s+poll\s+(?:[`'"])?([^\s`'"]+)(?:[`'"])?\b/i);
  if (cancelMatch) {
    const rawId = String(cancelMatch[1] || '').trim();
    if (/^all$/i.test(rawId)) {
      return { action: 'clear_all' };
    }
    return { action: 'cancel', scheduleId: rawId || null };
  }

  const unskipMatch = text.match(/^!(?:unskipinstance|unskiprecurringinstance|unskiprecurringpoll|unskiprecurring|resumeskip)\s*(?:poll\s+)?(?:[`'"])?([^\s`'"]+)?(?:[`'"])?(?:\s+(.*))?$/i) ||
    text.match(/^!(?:recurringpoll|dailypoll|schedulepoll)\s+(?:unskip|resumeskip)\s*(?:poll\s+)?(?:[`'"])?([^\s`'"]+)?(?:[`'"])?(?:\s+(.*))?$/i) ||
    text.match(/\b(?:unskip|restore)\s+(?:the\s+)?(?:skipped\s+)?(?:instance|poll)\s+(?:of|for)?\s*(?:daily|recurring|scheduled)?\s*(?:poll)?\s+(?:[`'"])?([^\s`'"]+)(?:[`'"])?(?:\s+(.*))?\b/i);
  if (unskipMatch) {
    return {
      action: 'unskip_instance',
      scheduleId: unskipMatch[1]?.trim() || null,
      targetDayOrDate: unskipMatch[2]?.trim() || null
    };
  }

  const skipMatch = text.match(/^!(?:skipinstances|skipinstance|skiprecurringinstances|skiprecurringinstance|skiprecurringpoll|skiprecurring|skippoll)\s*(?:poll\s+)?(.*)$/i) ||
    text.match(/^!(?:recurringpoll|dailypoll|schedulepoll)\s+(?:skip|skipinstance|skipinstances)\s*(?:poll\s+)?(.*)$/i) ||
    text.match(/\b(?:skip)\s+(?:the\s+)?(?:next\s+)?(\d+\s+)?(?:instances?|polls?)\s+(?:of|for)?\s*(?:daily|recurring|scheduled)?\s*(?:poll)?\s*(.*)$/i);
  if (skipMatch) {
    const rawRest = (skipMatch[1] || '').trim() + ' ' + (skipMatch[2] || '').trim();
    const { scheduleId, targetDayOrDate, count } = extractSkipArgs(rawRest.trim());
    return {
      action: 'skip_instance',
      scheduleId,
      targetDayOrDate,
      count
    };
  }

  const pauseMatch = text.match(/^!(?:pauserecurringpoll|stoprecurringpoll|pauserecurringpolls|pauseallrecurring|stopallrecurring)\s*(?:poll\s+)?(.*)$/i) ||
    text.match(/^!(?:recurringpoll|dailypoll|schedulepoll|recurringpolls)\s+(?:pause|stop)\s*(?:poll\s+)?(.*)$/i) ||
    text.match(/\b(?:pause|stop)\s+(?:the\s+)?(?:daily|recurring|scheduled)\s+polls?\s+(.*)$/i);
  if (pauseMatch) {
    const rawRest = pauseMatch[1]?.trim() || '';
    const { scheduleId, untilDate } = extractPauseArgs(rawRest);
    return { action: 'pause', scheduleId, untilDate };
  }

  const resumeMatch = text.match(/^!(?:resumerecurringpoll|startrecurringpoll)\s*(?:poll\s+)?(?:[`'"])?([^\s`'"]+)?(?:[`'"])?\s*$/i) ||
    text.match(/^!(?:recurringpoll|dailypoll|schedulepoll)\s+(?:resume|start)\s*(?:poll\s+)?(?:[`'"])?([^\s`'"]+)?(?:[`'"])?\s*$/i) ||
    text.match(/\b(?:resume|start)\s+(?:daily|recurring|scheduled)\s+poll\s+(?:[`'"])?([^\s`'"]+)(?:[`'"])?\b/i);
  if (resumeMatch) {
    return { action: 'resume', scheduleId: resumeMatch[1]?.trim() || null };
  }

  const modifyMatch = text.match(/^!(?:modifyrecurringpoll|editrecurringpoll|updaterecurringpoll|changerecurringpoll|modifyrecurring|editrecurring|updaterecurring)\s+(?:poll\s+)?(?:[`'"])?([^\s`'"]+)?(?:[`'"])?\s*(.*)$/i) ||
    text.match(/^!(?:recurringpoll|dailypoll|schedulepoll)\s+(?:modify|edit|update|change)\s+(?:poll\s+)?(?:[`'"])?([^\s`'"]+)?(?:[`'"])?\s*(.*)$/i) ||
    text.match(/\b(?:modify|edit|update|change)\s+(?:daily|recurring|scheduled)\s+poll\s+(?:[`'"])?([^\s`'"]+)(?:[`'"])?\s*(.*)$/i);
  if (modifyMatch) {
    const scheduleId = modifyMatch[1]?.trim() || null;
    const rest = modifyMatch[2]?.trim() || '';

    const jsonExtraction = extractJsonMap(rest);
    let postTimesByDay = jsonExtraction.map || null;
    let postTime = null;

    // Extract all flags and strip them from remainingText
    const { flags, remainingText: restAfterFlags } = extractCommonFlags(jsonExtraction.remainingText, jsonExtraction.map);
    let restForTimes = restAfterFlags;

    const isExplicitOptIn = /\b(?:opt-?in|yes\s*\/\s*no|yesno|open)\b/i.test(restForTimes);
    const daysString = extractDaysFromText(restForTimes);

    // Check for day-of-week / advance post time phrase
    let postPhraseMatch = null;
    if (!postTimesByDay) {
      postPhraseMatch = restForTimes.match(/\b(?:post(?:ed)?|posting|at)\s+((?:(?:\d+\s*days?\s*before(?:\s+at\s+(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2}))?|\d+(?:\.\d+)?\s*hours?\s*(?:before|prior|in\s+advance)?|(?:the\s+)?(?:day|evening|night)\s*before|previous\s*day|(?:sun[a-z]*|mon[a-z]*|tue[a-z]*|wed[a-z]*|thu[a-z]*|fri[a-z]*|sat[a-z]*|weekdays?|weekends?|everyday)\s*(?:at\s+)?(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})|(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})\s*(?:on|for)?\s*(?:sun[a-z]*|mon[a-z]*|tue[a-z]*|wed[a-z]*|thu[a-z]*|fri[a-z]*|sat[a-z]*|weekdays?|weekends?|everyday)|(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2}))[\s,;&and]*)+)/i);
      if (postPhraseMatch) {
        postTime = postPhraseMatch[1].trim();
        restForTimes = restForTimes.replace(postPhraseMatch[0], ' ');
      }
    }

    const timeRegex = /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b|\b(\d{1,2}:\d{2})\b/gi;
    const timeTokens = [];
    let tm;
    while ((tm = timeRegex.exec(restForTimes)) !== null) {
      timeTokens.push({ token: (tm[1] || tm[2]).trim(), index: tm.index });
    }

    let matchTime = null;
    if (timeTokens.length === 1) {
      if (!postTime) {
        const before = restForTimes.slice(Math.max(0, timeTokens[0].index - 15), timeTokens[0].index);
        if (/\b(?:post(?:ed)?|posting|at)\s*$/i.test(before)) {
          postTime = timeTokens[0].token;
        } else {
          matchTime = timeTokens[0].token;
        }
      } else {
        matchTime = timeTokens[0].token;
      }
    } else if (timeTokens.length >= 2) {
      const postIdx = timeTokens.findIndex((t) => {
        const before = restForTimes.slice(Math.max(0, t.index - 15), t.index);
        return /\b(?:post(?:ed)?|posting)\s*(?:at)?\s*$/i.test(before);
      });
      if (postIdx !== -1) {
        if (!postTime) postTime = timeTokens[postIdx].token;
        matchTime = timeTokens[postIdx === 0 ? 1 : 0].token;
      } else {
        matchTime = timeTokens[0].token;
        if (!postTime) postTime = timeTokens[1].token;
      }
    }

    let textCleaned = restForTimes.replace(timeRegex, ' ');
    textCleaned = textCleaned.replace(/\b(?:weekdays?|weekends?|everyday|every\s+day|daily|sundays?|sun|mondays?|mon|tuesdays?|tues|tue|wednesdays?|weds|wed|thursdays?|thurs|thur|thu|fridays?|fri|saturdays?|sat)\b/gi, ' ');
    textCleaned = textCleaned.replace(/\b(?:on\s+|at\s+|for\s+)?(?:the\s+)?(?:courts?|pickleball|pb)\s*#?\s*\d+\b/gi, ' ');

    let size = undefined;
    if (isExplicitOptIn) {
      size = null;
    } else if (/\bauto\b/i.test(textCleaned) || /\bauto[-_\s]*(?:spots?|players?|courts?|size)\b/i.test(textCleaned)) {
      size = 'auto';
    } else {
      const sizeExplicit = textCleaned.match(new RegExp(`\\b(?:for|size|spots?|players?)\\s*[:=]?\\s*(\\d+|${NUMBER_WORDS_PATTERN})\\b`, 'i')) ||
        textCleaned.match(new RegExp(`\\b(\\d+|${NUMBER_WORDS_PATTERN})\\s*(?:spots?|players?|people)\\b`, 'i')) ||
        textCleaned.match(new RegExp(`\\b([1-9]|1[0-6]|two|four|eight|twelve|sixteen)\\b`, 'i'));
      if (sizeExplicit) {
        const raw = sizeExplicit[1].toLowerCase();
        size = WORD_TO_NUMBER[raw] || parseInt(raw, 10);
      } else if (/\bsingles\b/i.test(textCleaned)) {
        size = 2;
      } else if (/\bdoubles\b/i.test(textCleaned)) {
        size = 4;
      }
    }

    return {
      action: 'modify',
      scheduleId,
      updates: {
        size,
        matchTime,
        postTime,
        postTimesByDay,
        days: daysString,
        isExplicitOptIn,
        autoMatchups: flags.autoMatchups,
        noMatchups: flags.noMatchups,
        includeCreator: flags.includeCreator,
        checkCourts: flags.checkCourts,
        includeCourts: flags.checkCourts,
        includePrebookedSpots: flags.includePrebookedSpots,
        'prebooked-spots': flags.includePrebookedSpots,
        prebookedSpots: flags.includePrebookedSpots,
        courtBookingType: flags.courtBookingType,
        bookingPlayers: flags.bookingPlayers,
        preBookCourts: flags.preBookCourts,
        bookingStrategy: flags.bookingStrategy,
        bookingSchedule: flags.bookingSchedule,
        lookAround: flags.lookAround,
        startDate: flags.startDate,
        endDate: flags.endDate
      }
    };
  }

  // 2. Check creation command or phrase
  const isCommand = /^!(?:recurringpoll|dailypoll|schedulepoll|everydaypoll|repeatingpoll|recurringoptinpoll|dailyoptinpoll|recurringyesnopoll|dailyyesnopoll)\b/i.test(text);
  const isPhrase = /\b(?:schedule|create|set\s*up|setup|start|post)\s+(?:a\s+)?(?:new\s+)?(?:daily\s+|recurring\s+|repeating\s+|every\s*day\s+)(?:match\s+)?(?:singles\s+|doubles\s+|yes\/no\s+|yesno\s+|opt-?in\s+)?poll\b|\b(?:daily|recurring|repeating)\s+(?:match\s+)?(?:yes\/no\s+|yesno\s+|opt-?in\s+)?poll\b|\bpoll\s+every\s*day\b|\b(?:schedule|create|set\s*up|setup|post)\s+(?:a\s+)?(?:match\s+)?poll\s+(?:every|on)\s+(?:weekdays?|weekends?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?)\b/i.test(text);

  if (!isCommand && !isPhrase) {
    return null;
  }

  const isExplicitOptIn = /\b(?:opt-?in|yes\s*\/\s*no|yesno|open)\b/i.test(text) ||
    /^!(?:recurringoptinpoll|dailyoptinpoll|recurringyesnopoll|dailyyesnopoll)\b/i.test(text);

  // 3. Extract JSON map or day-of-week / advance post time phrase if present
  const jsonExtraction = extractJsonMap(text);
  let postTimesByDay = jsonExtraction.map || null;
  let postTime = null;

  // Extract all flags and strip them from remainingText
  const { flags, remainingText: textAfterFlags } = extractCommonFlags(jsonExtraction.remainingText, jsonExtraction.map);
  let textForTimes = textAfterFlags;

  let postPhraseMatch = null;
  if (!postTimesByDay) {
    postPhraseMatch = text.match(/\b(?:post(?:ed)?|posting|at)\s+((?:(?:\d+\s*days?\s*before(?:\s+at\s+(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2}))?|\d+(?:\.\d+)?\s*hours?\s*(?:before|prior|in\s+advance)?|(?:the\s+)?(?:day|evening|night)\s*before|previous\s*day|(?:sun[a-z]*|mon[a-z]*|tue[a-z]*|wed[a-z]*|thu[a-z]*|fri[a-z]*|sat[a-z]*|weekdays?|weekends?|everyday)\s*(?:at\s+)?(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})|(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})\s*(?:on|for)?\s*(?:sun[a-z]*|mon[a-z]*|tue[a-z]*|wed[a-z]*|thu[a-z]*|fri[a-z]*|sat[a-z]*|weekdays?|weekends?|everyday)|(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2}))[\s,;&and]*)+)/i);
    if (postPhraseMatch) {
      postTime = postPhraseMatch[1].trim();
      textForTimes = textForTimes.replace(postPhraseMatch[0], ' ');
    }
  }

  // 4. Extract days of week
  const daysString = extractDaysFromText(textForTimes) || (postPhraseMatch ? extractDaysFromText(text) : null) || 'everyday';
  const parsedDays = parseDaysOfWeek(daysString);

  // 5. Extract times (matchTime, postTime)
  const timeRegex = /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b|\b(\d{1,2}:\d{2})\b/gi;
  const timeTokens = [];
  let tm;
  while ((tm = timeRegex.exec(textForTimes)) !== null) {
    timeTokens.push({
      token: (tm[1] || tm[2]).trim(),
      index: tm.index
    });
  }

  let matchTime = null;
  if (timeTokens.length === 1) {
    matchTime = timeTokens[0].token;
  } else if (timeTokens.length >= 2) {
    const postIdx = timeTokens.findIndex((t) => {
      const before = textForTimes.slice(Math.max(0, t.index - 15), t.index);
      return /\b(?:post(?:ed)?|posting)\s*(?:at)?\s*$/i.test(before);
    });
    if (postIdx !== -1) {
      if (!postTime) postTime = timeTokens[postIdx].token;
      matchTime = timeTokens[postIdx === 0 ? 1 : 0].token;
    } else {
      matchTime = timeTokens[0].token;
      if (!postTime) postTime = timeTokens[1].token;
    }
  }

  // 6. Extract player count / spots AFTER removing time tokens and day tokens
  let textCleaned = textForTimes.replace(timeRegex, ' ');
  textCleaned = textCleaned.replace(/\b(?:weekdays?|weekends?|everyday|every\s+day|daily|sundays?|sun|mondays?|mon|tuesdays?|tues|tue|wednesdays?|weds|wed|thursdays?|thurs|thur|thu|fridays?|fri|saturdays?|sat)\b/gi, ' ');
  textCleaned = textCleaned.replace(/\b(?:on\s+|at\s+|for\s+)?(?:the\s+)?(?:courts?|pickleball|pb)\s*#?\s*\d+\b/gi, ' ');

  let size = null;
  if (!isExplicitOptIn) {
    if (/\bauto\b/i.test(textCleaned) || /\bauto[-_\s]*(?:spots?|players?|courts?|size)\b/i.test(textCleaned)) {
      size = 'auto';
    } else {
      const sizeExplicit = textCleaned.match(new RegExp(`\\b(?:for|size|spots?|players?)\\s*[:=]?\\s*(\\d+|${NUMBER_WORDS_PATTERN})\\b`, 'i')) ||
        textCleaned.match(new RegExp(`^!(?:recurringpoll|dailypoll|schedulepoll)\\s+(\\d+|${NUMBER_WORDS_PATTERN})\\b`, 'i')) ||
        textCleaned.match(new RegExp(`\\b(\\d+|${NUMBER_WORDS_PATTERN})\\s*(?:spots?|players?|people)\\b`, 'i')) ||
        textCleaned.match(new RegExp(`\\bpoll\\s+for\\s+(\\d+|${NUMBER_WORDS_PATTERN})\\b`, 'i')) ||
        textCleaned.match(new RegExp(`\\b([1-9]|1[0-6]|two|four|eight|twelve|sixteen)\\b`, 'i'));
      if (sizeExplicit) {
        const raw = sizeExplicit[1].toLowerCase();
        size = WORD_TO_NUMBER[raw] || parseInt(raw, 10);
      } else if (/\bsingles\b/i.test(textCleaned)) {
        size = 2;
      } else if (/\bdoubles\b/i.test(textCleaned)) {
        size = 4;
      }
    }
  }

  const finalCheckCourts = flags.checkCourts !== undefined ? flags.checkCourts : false;
  const finalIncludePrebooked = flags.includePrebookedSpots !== undefined ? flags.includePrebookedSpots : false;
  const finalNoMatchups = flags.noMatchups !== undefined ? flags.noMatchups : false;
  const finalAutoMatchups = flags.autoMatchups !== undefined ? flags.autoMatchups : !finalNoMatchups;
  const finalIncludeCreator = flags.includeCreator !== undefined ? flags.includeCreator : false;

  return {
    action: 'create',
    size,
    matchTime,
    postTime,
    postTimesByDay,
    days: parsedDays.raw,
    daysList: parsedDays.days,
    daysDisplay: parsedDays.display,
    includeCreator: finalIncludeCreator,
    autoMatchups: finalAutoMatchups,
    noMatchups: finalNoMatchups,
    checkCourts: finalCheckCourts,
    includeCourts: finalCheckCourts,
    includePrebookedSpots: finalIncludePrebooked,
    'prebooked-spots': finalIncludePrebooked,
    prebookedSpots: finalIncludePrebooked,
    courtBookingType: flags.courtBookingType || null,
    bookingPlayers: flags.bookingPlayers || null,
    preBookCourts: flags.preBookCourts || null,
    bookingStrategy: flags.bookingStrategy || null,
    bookingSchedule: flags.bookingSchedule || null,
    lookAround: flags.lookAround || null,
    startDate: flags.startDate || null,
    endDate: flags.endDate || null
  };
}

function formatRecurringScheduleCard(s, idx = null, total = 1, customSanJoseParts = null) {
  const spotDesc = s.size
    ? (s.size === "auto" ? "auto spots (Doubles)" : `${s.size} spots (${s.size === 2 ? "Singles" : "Doubles"})`)
    : "Opt-in (Yes/No)";
  const creatorDesc = s.includeCreator
    ? ` (auto-including ${s.creator?.name || "creator"} as Player 1)`
    : (s.size ? " (all spots open)" : "");
  const matchupDesc = (s.autoMatchups !== false && !s.noMatchups)
    ? (s.size ? "Auto-generated when poll fills" : "Manual on request (!matchups)")
    : "Manual only (use !matchups)";
  const daysStr = s.daysDisplay || (parseDaysOfWeek(s.days || s.daysList).display);
  const sj = customSanJoseParts || pollTime.getSanJoseParts();
  const todayKey = `${sj.year}-${String(sj.month + 1).padStart(2, '0')}-${String(sj.day).padStart(2, '0')}`;

  let statusStr = s.enabled ? "✅ Active" : (s.pausedUntilDisplay ? `⏸️ Paused (until ${s.pausedUntilDisplay})` : (s.pausedUntil ? `⏸️ Paused (until ${s.pausedUntil})` : "⏸️ Paused"));
  if ((s.endDate && todayKey > s.endDate) || s.ended) {
    statusStr = `🏁 Ended (${s.endDateDisplay || s.endDate})`;
  } else if (s.startDate && todayKey < s.startDate && s.enabled) {
    statusStr = `⏳ Scheduled (starts ${s.startDateDisplay || s.startDate})`;
  }

  let dateRangeLines = '';
  if (s.startDateDisplay || s.startDate) {
    dateRangeLines += `\n• *Start Date:* ${s.startDateDisplay || s.startDate}`;
  }
  if (s.endDateDisplay || s.endDate) {
    dateRangeLines += `\n• *End Date:* ${s.endDateDisplay || s.endDate}`;
  }
  const postTimeStr = (s.postDisplay || s.postTime || "8:00 AM").includes("in this group")
    ? (s.postDisplay || s.postTime || "8:00 AM")
    : `${s.postDisplay || s.postTime || "8:00 AM"} in this group`;

  const titlePrefix = total > 1 && idx !== null ? `${idx + 1}. ` : "";

  const isPrebooked = Boolean(s.includePrebookedSpots || s['prebooked-spots'] || s.prebookedSpots);
  const prebookedDesc = isPrebooked ? "Enabled" : "Disabled";

  let skippedNote = '';
  if (Array.isArray(s.skippedMatchDates) && s.skippedMatchDates.length > 0) {
    const sj = pollTime.getSanJoseParts();
    const todayKey = `${sj.year}-${String(sj.month + 1).padStart(2, '0')}-${String(sj.day).padStart(2, '0')}`;
    const upcomingSkipped = s.skippedMatchDates.filter((d) => d >= todayKey);
    if (upcomingSkipped.length > 0) {
      skippedNote = `\n• *Skipped Instance(s):* ⏭️ ${upcomingSkipped.join(', ')}`;
    }
  }

  const effStrategy = s.bookingStrategy || null;
  const isPreBook = s.courtBookingType === 'pre-book' || effStrategy === 'advanced' || Boolean(s.bookingSchedule);
  const bookingTypeDesc = isPreBook ? 'Pre-book' : 'None';

  let courtBookingLine = '';
  if (effStrategy === 'advanced' || s.bookingSchedule) {
    const schedStr = s.bookingSchedule || (s.bookingScheduleParsed?.display ? `${s.bookingScheduleParsed.daysBefore} days before at ${s.bookingScheduleParsed.display}` : '-7days 7:00AM');
    courtBookingLine = `\n• *Court Booking:* Advanced (${schedStr})${s.preBookCourts ? ` (${s.preBookCourts} courts)` : ''}${s.bookingPlayers && s.bookingPlayers.length > 0 ? ` (${s.bookingPlayers.map((l, i) => `Court ${i + 1}: [${l.join(", ")}]`).join(", ")})` : " (group default)"}`;
  } else if (isPreBook) {
    courtBookingLine = `\n• *Court Booking:* Pre-book in advance${s.preBookCourts ? ` (${s.preBookCourts} courts)` : ''}${s.bookingPlayers && s.bookingPlayers.length > 0 ? ` (${s.bookingPlayers.map((l, i) => `Court ${i + 1}: [${l.join(", ")}]`).join(", ")})` : " (group default)"}`;
  }

  return `📅 *${titlePrefix}Scheduled Recurring Poll (ID: \`${s.id}\`):*\n` +
    `• *Match Time:* ${s.matchDisplay}\n` +
    `• *Days:* ${daysStr}` +
    dateRangeLines +
    `\n` +
    `• *Post Time:* ${postTimeStr}\n` +
    `• *Format:* ${spotDesc}${creatorDesc}\n` +
    `• *Matchups:* ${matchupDesc}\n` +
    `• *Prebooked Spots:* ${prebookedDesc}\n` +
    `• *Court Booking Type:* ${bookingTypeDesc}` +
    courtBookingLine +
    (s.lookAround ? `\n• *Look Around:* ${s.lookAroundDisplay || formatLookAround(s.lookAround)}` : '') +
    `\n• *Status:* ${statusStr}${skippedNote}`;
}

/**
 * Creates and registers a new recurring poll schedule.
 */
async function scheduleRecurringPoll({ recurringPolls, persistPolls, targetChatId, sender, senderJid, params }) {
  const { size, matchTime, postTime, postTimesByDay, days, includeCreator, autoMatchups, noMatchups, checkCourts, includeCourts, considerCourts, courtBookingType, bookingType, bookingPlayers, bookingNames, bookingStrategy, bookingSchedule, startDate, endDate, lookAround } = params || {};

  let cleanStartDate = null;
  let cleanStartDateDisplay = null;
  if (startDate) {
    const parsedStart = parseDateToDateKey(startDate);
    if (!parsedStart) {
      return `Could not understand start date "${startDate}". Please specify a valid date (e.g. "10/15/2026", "2026-10-15", "Oct 15", "tomorrow").`;
    }
    cleanStartDate = parsedStart.dateKey;
    cleanStartDateDisplay = parsedStart.display;
  }

  let cleanEndDate = null;
  let cleanEndDateDisplay = null;
  if (endDate) {
    const parsedEnd = parseDateToDateKey(endDate);
    if (!parsedEnd) {
      return `Could not understand end date "${endDate}". Please specify a valid date (e.g. "11/15/2026", "2026-11-15", "Nov 15").`;
    }
    if (parsedEnd.isPast) {
      return `The specified end date (${parsedEnd.display}) has already passed in San Jose. Please specify an upcoming date.`;
    }
    cleanEndDate = parsedEnd.dateKey;
    cleanEndDateDisplay = parsedEnd.display;
  }

  if (cleanStartDate && cleanEndDate && cleanStartDate > cleanEndDate) {
    return `The start date (${cleanStartDateDisplay}) cannot be after the end date (${cleanEndDateDisplay}).`;
  }
  const groupCfg = groupsConfig.getGroupConfig(targetChatId);
  const rawBookingType = courtBookingType || bookingType || null;
  const normalizedBookingType = (rawBookingType && String(rawBookingType).trim().toLowerCase().replace(/_/g, '-')) || 'none';
  const cleanBookingType = (normalizedBookingType === 'pre-book' || normalizedBookingType === 'prebook') ? 'pre-book' : 'none';
  const cleanBookingPlayers = groupsConfig.normalizeBookingPlayerLists(bookingPlayers || bookingNames);
  const cleanPreBookCourts = (params?.preBookCourts !== undefined && params?.preBookCourts !== null && parseInt(params.preBookCourts, 10) > 0)
    ? parseInt(params.preBookCourts, 10)
    : (params?.preBookCourtsCount !== undefined && params?.preBookCourtsCount !== null && parseInt(params.preBookCourtsCount, 10) > 0
      ? parseInt(params.preBookCourtsCount, 10)
      : (groupCfg?.preBookCourts || 1));
  const effectiveStrategy = bookingStrategy || params?.bookingStrategy || groupCfg?.bookingStrategy || (cleanBookingType === 'pre-book' ? 'poll-creation' : null);
  const effectiveBookingSchedule = bookingSchedule || params?.bookingSchedule || groupCfg?.bookingSchedule || null;
  const parsedBookingSchedule = groupsConfig.parseBookingSchedule(effectiveBookingSchedule);
  const cleanLookAround = parseLookAround(lookAround || params?.lookAround || flags.lookAround || groupCfg?.lookAround || null);
  const effectiveCheckCourts = Boolean(checkCourts ?? includeCourts ?? considerCourts);
  const includePrebookedSpots = params?.['prebooked-spots'] !== undefined
    ? (String(params['prebooked-spots']).toLowerCase() === 'true' || params['prebooked-spots'] === true || String(params['prebooked-spots']).toLowerCase() === 'yes' || params['prebooked-spots'] === 1)
    : (params?.prebookedSpots !== undefined
      ? Boolean(params.prebookedSpots)
      : Boolean(params?.includePrebookedSpots));
  if (!matchTime) {
    return 'Please provide a match time for the recurring poll (e.g. "!recurringpoll 4 7pm at 8am on weekdays" or "!recurringpoll 4 7pm monday at sunday 6pm").';
  }

  const parsedMatch = parseTimeString(matchTime);
  if (!parsedMatch) {
    return `Could not understand match time "${matchTime}". Please specify a time like "7pm", "9am", or "6:30pm".`;
  }

  const parsedDays = parseDaysOfWeek(days || params?.daysList || 'everyday');
  const parsedPostTimes = parsePostTimes(postTimesByDay || postTime, parsedMatch, parsedDays.days);
  if (!parsedPostTimes) {
    return `Could not understand post time "${postTime}". Please specify a time like "8am", "sunday 6pm", or "1 day before at 6pm".`;
  }

  let validSize = null;
  if (size === 'auto' || String(size).toLowerCase() === 'auto') {
    validSize = 'auto';
  } else if (size !== undefined && size !== null) {
    const num = parseInt(size, 10);
    if (Number.isFinite(num) && num > 0) {
      validSize = num;
    }
  }

  const effectiveAutoMatchups = autoMatchups !== undefined ? Boolean(autoMatchups) : !Boolean(noMatchups);

  const scheduleId = `rec_${Date.now().toString(36)}`;
  const scheduleObj = {
    id: scheduleId,
    remoteJid: targetChatId,
    size: validSize,
    matchTime: parsedMatch.formatted,
    matchDisplay: parsedMatch.display,
    matchHour: parsedMatch.hour,
    matchMinute: parsedMatch.minute,
    postTime: parsedPostTimes.defaultPost.formatted,
    postDisplay: parsedPostTimes.display,
    postHour: parsedPostTimes.defaultPost.hour,
    postMinute: parsedPostTimes.defaultPost.minute,
    postTimesByDay: parsedPostTimes.postTimesByDay,
    days: parsedDays.raw,
    daysList: parsedDays.days,
    daysDisplay: parsedDays.display,
    includeCreator: Boolean(includeCreator),
    autoMatchups: effectiveAutoMatchups,
    noMatchups: !effectiveAutoMatchups,
    checkCourts: effectiveCheckCourts,
    courtBookingType: cleanBookingType,
    preBookCourts: cleanPreBookCourts,
    bookingPlayers: cleanBookingPlayers,
    bookingStrategy: effectiveStrategy ? String(effectiveStrategy).toLowerCase() : null,
    bookingSchedule: effectiveBookingSchedule,
    bookingScheduleParsed: parsedBookingSchedule,
    lookAround: cleanLookAround,
    lookAroundDisplay: formatLookAround(cleanLookAround),
    advanceBookings: {},
    startDate: cleanStartDate,
    startDateDisplay: cleanStartDateDisplay,
    endDate: cleanEndDate,
    endDateDisplay: cleanEndDateDisplay,
    includePrebookedSpots: Boolean(includePrebookedSpots),
    'prebooked-spots': Boolean(includePrebookedSpots),
    prebookedSpots: Boolean(includePrebookedSpots),
    enabled: true,
    createdAt: new Date().toISOString(),
    lastPostedDate: null,
    lastPostedMatchDate: null,
    postedMatchDates: [],
    creator: { name: sender !== 'Someone' ? sender : 'Player', jid: senderJid || null }
  };

  recurringPolls.set(scheduleId, scheduleObj);
  persistPolls();

  const spotDesc = validSize ? `${validSize} spots (${validSize === 2 ? 'Singles' : 'Doubles'})` : 'Opt-in (Yes/No)';
  const creatorDesc = includeCreator ? ` (auto-including ${sender} as Player 1)` : (validSize ? ' (all spots open)' : '');
  const matchupDesc = effectiveAutoMatchups ? (validSize ? 'Auto-generated when poll fills' : 'Manual on request (!matchups)') : 'Manual only (use !matchups)';
  console.log(`[recurring-poll] Created recurring poll schedule ${scheduleId}: ${spotDesc} for ${parsedMatch.display} (${parsedDays.display}), posting at ${parsedPostTimes.display} in ${targetChatId}, autoMatchups: ${effectiveAutoMatchups}`);

  return `${formatRecurringScheduleCard(scheduleObj)}\n\n` +
    `Use "!recurringpolls" to view all schedules, "!modifyrecurringpoll ${scheduleId} ..." to modify, or "!cancelrecurringpoll ${scheduleId}" to cancel.`;
}

/**
 * Modifies an existing recurring poll schedule.
 */
async function modifyRecurringPoll({ recurringPolls, persistPolls, sender, scheduleId, updates = {} }) {
  const cleanId = String(scheduleId || '').trim();
  if (!cleanId) {
    return 'Please provide the schedule ID to modify, e.g. "!modifyrecurringpoll rec_1 8 6pm at 7am mon-thu" (see "!recurringpolls" for active IDs).';
  }

  let targetKey = cleanId;
  if (!recurringPolls.has(targetKey)) {
    for (const key of recurringPolls.keys()) {
      if (key.toLowerCase() === cleanId.toLowerCase()) {
        targetKey = key;
        break;
      }
    }
  }

  if (!recurringPolls.has(targetKey)) {
    return `Schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view active schedules.`;
  }

  const sched = recurringPolls.get(targetKey);
  const changes = [];

  // Update match time if provided
  if (updates.matchTime) {
    const parsedMatch = parseTimeString(updates.matchTime);
    if (!parsedMatch) {
      return `Could not understand match time "${updates.matchTime}". Please specify a time like "7pm", "9am", or "6:30pm".`;
    }
    const oldDisplay = sched.matchDisplay;
    sched.matchTime = parsedMatch.formatted;
    sched.matchDisplay = parsedMatch.display;
    sched.matchHour = parsedMatch.hour;
    sched.matchMinute = parsedMatch.minute;
    if (oldDisplay !== sched.matchDisplay) {
      changes.push(`Match Time: ${oldDisplay} → *${sched.matchDisplay}*`);
    }
  }

  // Update days if provided
  if (updates.days || updates.daysList) {
    const parsedDays = parseDaysOfWeek(updates.days || updates.daysList);
    const oldDisplay = sched.daysDisplay || sched.days;
    sched.days = parsedDays.raw;
    sched.daysList = parsedDays.days;
    sched.daysDisplay = parsedDays.display;
    if (oldDisplay !== sched.daysDisplay) {
      changes.push(`Days: ${oldDisplay} → *${sched.daysDisplay}*`);
    }
  }

  // Update post time if provided
  if (updates.postTime || updates.postTimesByDay) {
    const parsedPostTimes = parsePostTimes(updates.postTimesByDay || updates.postTime, sched, sched.daysList);
    if (!parsedPostTimes) {
      return `Could not understand post time "${updates.postTime}". Please specify a time like "8am", "sunday 6pm", or "1 day before at 6pm".`;
    }
    const oldDisplay = sched.postDisplay;
    sched.postTime = parsedPostTimes.defaultPost.formatted;
    sched.postDisplay = parsedPostTimes.display;
    sched.postHour = parsedPostTimes.defaultPost.hour;
    sched.postMinute = parsedPostTimes.defaultPost.minute;
    sched.postTimesByDay = parsedPostTimes.postTimesByDay;
    if (oldDisplay !== sched.postDisplay) {
      changes.push(`Post Time: ${oldDisplay} → *${sched.postDisplay}*`);
    }
  } else if ((updates.days || updates.daysList) && sched.postTimesByDay) {
    // Refresh postDisplay with new scheduled days
    const refreshed = parsePostTimes(sched.postTimesByDay, sched, sched.daysList);
    if (refreshed && refreshed.display !== sched.postDisplay) {
      sched.postDisplay = refreshed.display;
    }
  }

  // Update size if provided
  if (updates.isExplicitOptIn || updates.type === 'opt_in') {
    const oldSizeDesc = sched.size ? `${sched.size} spots` : 'Opt-in';
    sched.size = null;
    if (oldSizeDesc !== 'Opt-in') {
      changes.push(`Format: ${oldSizeDesc} → *Opt-in (Yes/No)*`);
    }
  } else if (updates.size === 'auto' || String(updates.size).toLowerCase() === 'auto') {
    const oldSizeDesc = sched.size ? (sched.size === 'auto' ? 'Auto-calculated' : `${sched.size} spots`) : 'Opt-in';
    sched.size = 'auto';
    changes.push(`Format: ${oldSizeDesc} → *Auto-calculated spots (4, 8, or 12 based on prebooked/free courts)*`);
  } else if (updates.size !== undefined && updates.size !== null) {
    const num = parseInt(updates.size, 10);
    if (Number.isFinite(num) && num > 0) {
      const oldSizeDesc = sched.size ? (sched.size === 'auto' ? 'Auto-calculated' : `${sched.size} spots`) : 'Opt-in';
      sched.size = num;
      const newSizeDesc = `${num} spots (${num === 2 ? 'Singles' : 'Doubles'})`;
      if (oldSizeDesc !== newSizeDesc) {
        changes.push(`Format: ${oldSizeDesc} → *${newSizeDesc}*`);
      }
    }
  }

  // Update courtBookingType / bookingPlayers if provided
  if (updates.courtBookingType !== undefined || updates.bookingType !== undefined) {
    const rawBT = updates.courtBookingType !== undefined ? updates.courtBookingType : updates.bookingType;
    const normBT = (rawBT && String(rawBT).trim().toLowerCase().replace(/_/g, '-')) || 'none';
    const newBT = (normBT === 'pre-book' || normBT === 'prebook') ? 'pre-book' : 'none';
    if (sched.courtBookingType !== newBT) {
      sched.courtBookingType = newBT;
      changes.push(`Court Booking Type: *${newBT}*`);
    }
  }
  if (updates.bookingPlayers !== undefined || updates.bookingNames !== undefined) {
    sched.bookingPlayers = groupsConfig.normalizeBookingPlayerLists(updates.bookingPlayers !== undefined ? updates.bookingPlayers : updates.bookingNames);
    changes.push(`Booking Players: *${sched.bookingPlayers.map((l, i) => `Court ${i + 1}: [${l.join(", ")}]`).join(", ")}*`);
  }
  if (updates.preBookCourts !== undefined || updates.preBookCourtsCount !== undefined) {
    const rawVal = updates.preBookCourts !== undefined ? updates.preBookCourts : updates.preBookCourtsCount;
    const val = parseInt(rawVal, 10);
    if (Number.isInteger(val) && val > 0) {
      sched.preBookCourts = val;
      changes.push(`Pre-book Courts: *${val}*`);
    } else {
      delete sched.preBookCourts;
      changes.push(`Pre-book Courts: *default*`);
    }
  }

  if (updates.bookingStrategy !== undefined) {
    const rawVal = updates.bookingStrategy;
    const newStrategy = (rawVal && String(rawVal).trim().toLowerCase() !== 'none' && String(rawVal).trim().toLowerCase() !== 'null') ? String(rawVal).trim().toLowerCase() : null;
    if (sched.bookingStrategy !== newStrategy) {
      sched.bookingStrategy = newStrategy;
      changes.push(`Booking Strategy: *${newStrategy || 'default'}*`);
    }
  }

  if (updates.bookingSchedule !== undefined) {
    const rawVal = updates.bookingSchedule;
    if (rawVal && String(rawVal).trim() !== '' && String(rawVal).trim().toLowerCase() !== 'null') {
      sched.bookingSchedule = rawVal;
      sched.bookingScheduleParsed = groupsConfig.parseBookingSchedule(rawVal);
      changes.push(`Booking Schedule: *${rawVal}*`);
    } else {
      delete sched.bookingSchedule;
      delete sched.bookingScheduleParsed;
      changes.push(`Booking Schedule: *default*`);
    }
  }

  if (updates.lookAround !== undefined) {
    const rawVal = updates.lookAround;
    if (rawVal === null || /^(?:none|clear|remove|null|0|false)$/i.test(String(rawVal).trim())) {
      if (sched.lookAround) {
        delete sched.lookAround;
        delete sched.lookAroundDisplay;
        changes.push('Look Around: *Removed*');
      }
    } else {
      const parsedLA = parseLookAround(rawVal);
      if (parsedLA) {
        sched.lookAround = parsedLA;
        sched.lookAroundDisplay = formatLookAround(parsedLA);
        changes.push(`Look Around: *${sched.lookAroundDisplay}*`);
      }
    }
  }

  // Update autoMatchups / noMatchups if provided
  if (updates.autoMatchups !== undefined || updates.noMatchups !== undefined) {
    const newAuto = updates.autoMatchups !== undefined ? Boolean(updates.autoMatchups) : !Boolean(updates.noMatchups);
    if (sched.autoMatchups !== newAuto) {
      sched.autoMatchups = newAuto;
      sched.noMatchups = !newAuto;
      changes.push(`Auto-matchups: *${newAuto ? 'Enabled' : 'Disabled (manual !matchups)'}*`);
    }
  }

  // Update includeCreator if provided
  if (updates.includeCreator !== undefined) {
    const newInclude = Boolean(updates.includeCreator);
    if (sched.includeCreator !== newInclude) {
      sched.includeCreator = newInclude;
      changes.push(`Auto-include creator: *${newInclude ? 'Yes' : 'No'}*`);
    }
  }

  // Update checkCourts if provided
  if (updates.checkCourts !== undefined || updates.includeCourts !== undefined || updates.considerCourts !== undefined) {
    const newCheckCourts = Boolean(updates.checkCourts ?? updates.includeCourts ?? updates.considerCourts);
    if (sched.checkCourts !== newCheckCourts) {
      sched.checkCourts = newCheckCourts;
      delete sched.noCourts;
      changes.push(`Court availability check: *${newCheckCourts ? 'Enabled' : 'Disabled'}*`);
    }
  }

  // Update startDate if provided
  if (updates.startDate !== undefined) {
    const rawVal = updates.startDate;
    if (rawVal === null || /^(?:none|clear|remove|null)$/i.test(String(rawVal).trim())) {
      if (sched.startDate) {
        delete sched.startDate;
        delete sched.startDateDisplay;
        changes.push('Start Date: *Removed*');
      }
    } else {
      const parsedStart = parseDateToDateKey(rawVal);
      if (!parsedStart) {
        return `Could not understand start date "${rawVal}". Please specify a valid date (e.g. "10/15/2026", "2026-10-15", "Oct 15").`;
      }
      const effEndKey = (updates.endDate !== undefined && updates.endDate !== null && !/^(?:none|clear|remove|null)$/i.test(String(updates.endDate).trim()))
        ? (parseDateToDateKey(updates.endDate)?.dateKey || sched.endDate)
        : sched.endDate;

      if (effEndKey && parsedStart.dateKey > effEndKey) {
        return `The start date (${parsedStart.display}) cannot be after the end date (${sched.endDateDisplay || effEndKey}).`;
      }
      sched.startDate = parsedStart.dateKey;
      sched.startDateDisplay = parsedStart.display;
      changes.push(`Start Date: *${parsedStart.display}*`);
    }
  }

  // Update endDate if provided
  if (updates.endDate !== undefined) {
    const rawVal = updates.endDate;
    if (rawVal === null || /^(?:none|clear|remove|null)$/i.test(String(rawVal).trim())) {
      if (sched.endDate) {
        delete sched.endDate;
        delete sched.endDateDisplay;
        changes.push('End Date: *Removed*');
      }
    } else {
      const parsedEnd = parseDateToDateKey(rawVal);
      if (!parsedEnd) {
        return `Could not understand end date "${rawVal}". Please specify a valid date (e.g. "11/15/2026", "2026-11-15", "Nov 15").`;
      }
      if (parsedEnd.isPast) {
        return `The specified end date (${parsedEnd.display}) has already passed in San Jose. Please specify an upcoming date.`;
      }
      const effStartKey = sched.startDate;
      if (effStartKey && effStartKey > parsedEnd.dateKey) {
        return `The end date (${parsedEnd.display}) cannot be before the start date (${sched.startDateDisplay || effStartKey}).`;
      }
      sched.endDate = parsedEnd.dateKey;
      sched.endDateDisplay = parsedEnd.display;
      changes.push(`End Date: *${parsedEnd.display}*`);
    }
  }

  // Update includePrebookedSpots if provided
  const prebookedUpdate = updates?.['prebooked-spots'] !== undefined
    ? updates['prebooked-spots']
    : (updates?.prebookedSpots !== undefined
      ? updates.prebookedSpots
      : updates?.includePrebookedSpots);

  if (prebookedUpdate !== undefined) {
    const newPrebooked = String(prebookedUpdate).toLowerCase() === 'true' || prebookedUpdate === true || String(prebookedUpdate).toLowerCase() === 'yes' || prebookedUpdate === 1;
    if (sched.includePrebookedSpots !== newPrebooked || sched['prebooked-spots'] !== newPrebooked) {
      sched.includePrebookedSpots = newPrebooked;
      sched['prebooked-spots'] = newPrebooked;
      sched.prebookedSpots = newPrebooked;
      changes.push(`Named prebooked spots in poll: *${newPrebooked ? 'Enabled' : 'Disabled'}*`);
    }
  }

  if (changes.length === 0) {
    return `ℹ️ Schedule \`${targetKey}\` is already configured with those settings (no changes needed):\n\n` +
      formatRecurringScheduleCard(sched);
  }

  sched.updatedAt = new Date().toISOString();
  persistPolls();

  const spotDesc = sched.size ? `${sched.size} spots (${sched.size === 2 ? 'Singles' : 'Doubles'})` : 'Opt-in (Yes/No)';
  const matchupDesc = sched.autoMatchups ? (sched.size ? 'Auto-generated when poll fills' : 'Manual on request (!matchups)') : 'Manual only (use !matchups)';

  console.log(`[recurring-poll] Modified recurring poll schedule ${targetKey} by ${sender}: ${changes.join(', ')}`);

  return `✏️ *Updated Recurring Poll Schedule (ID: \`${targetKey}\`):*\n` +
    changes.map(c => `• ${c}`).join('\n') +
    `\n\n` +
    formatRecurringScheduleCard(sched);
}

/**
 * Lists all recurring poll schedules for the given chat.
 */
function listRecurringPolls({ recurringPolls, chatId }) {
  const isAll = !chatId || !chatId.endsWith('@g.us');
  let list = [...recurringPolls.values()];
  if (!isAll) {
    list = list.filter((s) => s.remoteJid === chatId);
  }

  if (list.length === 0) {
    return '📅 No recurring match polls scheduled yet. Use "!recurringpoll [size] <matchTime> [at <postTime>] [days] [no-matchups]" (e.g. "!recurringpoll 4 7pm at 8am on weekdays" or "!recurringpoll 4 7pm monday at sunday 6pm") to schedule one.';
  }

  const cards = list.map((s, i) => formatRecurringScheduleCard(s, i, list.length));

  return `${cards.join('\n\n')}\n\n_Manage with !modifyrecurringpoll <id> ..., !cancelrecurringpoll <id> (or !clearallrecurringpolls)_`;
}

/**
 * Gets and formats status information for a specific recurring poll schedule.
 * Returns only the schedule configuration card and not the instance.
 */
function getRecurringPollStatus({ recurringPolls, scheduleId, chatId }) {
  const cleanId = String(scheduleId || '').replace(/^["']|["']$/g, '').trim();
  if (!cleanId) {
    return listRecurringPolls({ recurringPolls, chatId });
  }

  let targetSched = null;
  for (const [key, sched] of recurringPolls.entries()) {
    const sid = sched.id || sched.scheduleId || key;
    if (key.toLowerCase() === cleanId.toLowerCase() || sid.toLowerCase() === cleanId.toLowerCase()) {
      targetSched = sched;
      break;
    }
  }

  if (!targetSched) {
    return `⚠️ Recurring schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view all active schedule IDs.`;
  }

  const actionCmd = targetSched.enabled ? `!pauserecurringpoll ${targetSched.id || cleanId}` : `!resumerecurringpoll ${targetSched.id || cleanId}`;
  return `${formatRecurringScheduleCard(targetSched)}\n\n_Manage with ${actionCmd}, !modifyrecurringpoll ${targetSched.id || cleanId} ..., !cancelrecurringpoll ${targetSched.id || cleanId}_`;
}

/**
 * Cancels and deletes a recurring poll schedule.
 */
async function cancelRecurringPoll({ recurringPolls, persistPolls, sender, scheduleId }) {
  const cleanId = String(scheduleId || '').trim();
  if (!cleanId) {
    return 'Please provide the schedule ID to cancel, e.g. "!cancelrecurringpoll rec_1" (see "!recurringpolls" for IDs) or "!clearallrecurringpolls" to clear all.';
  }

  let targetKey = cleanId;
  if (!recurringPolls.has(targetKey)) {
    for (const key of recurringPolls.keys()) {
      if (key.toLowerCase() === cleanId.toLowerCase()) {
        targetKey = key;
        break;
      }
    }
  }

  if (!recurringPolls.has(targetKey)) {
    return `Schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view all scheduled IDs.`;
  }

  const sched = recurringPolls.get(targetKey);
  recurringPolls.delete(targetKey);
  persistPolls();

  console.log(`[recurring-poll] Deleted recurring poll schedule ${targetKey} (${sched.matchDisplay}) by ${sender}`);
  return `🗑️ Cancelled and deleted recurring poll schedule \`${targetKey}\` (Match time: ${sched.matchDisplay} ${sched.daysDisplay || ''}).`;
}

/**
 * Clears and cancels all recurring poll schedules for the given chat.
 */
async function clearAllRecurringPolls({ recurringPolls, persistPolls, sender, chatId }) {
  const isAll = !chatId || !chatId.endsWith('@g.us');
  const toDelete = [];

  for (const [id, sched] of recurringPolls.entries()) {
    if (isAll || sched.remoteJid === chatId) {
      toDelete.push(id);
    }
  }

  if (toDelete.length === 0) {
    return '📅 No scheduled recurring polls found to clear.';
  }

  for (const id of toDelete) {
    recurringPolls.delete(id);
  }
  persistPolls();

  console.log(`[recurring-poll] Cleared all ${toDelete.length} recurring poll schedules by ${sender} in ${chatId}`);
  return `🗑️ Cleared and deleted all ${toDelete.length} recurring poll schedule(s).`;
}

/**
 * Pauses a recurring poll schedule (or all schedules).
 */
async function pauseRecurringPoll({ recurringPolls, persistPolls, scheduleId, chatId = null, untilDate = null }) {
  const extracted = extractPauseArgs(scheduleId);
  let cleanId = extracted.scheduleId ? String(extracted.scheduleId).replace(/^["']|["']$/g, '').trim() : '';
  const effUntilRaw = untilDate || extracted.untilDate || null;

  let parsedUntil = null;
  if (effUntilRaw) {
    parsedUntil = parseDateToDateKey(effUntilRaw);
    if (!parsedUntil) {
      return `⚠️ Could not parse the pause date "${effUntilRaw}". Please specify a valid date (e.g. "10/25/2026", "2026-10-25", "Oct 25", "Monday", "tomorrow").`;
    }
    if (parsedUntil.isPast) {
      return `⚠️ The pause date (${parsedUntil.display}) has already passed in San Jose. Please specify an upcoming date or day.`;
    }
  }

  const untilNote = parsedUntil ? ` until ${parsedUntil.display}` : '';
  const autoResumeNote = parsedUntil ? ` It will automatically resume on ${parsedUntil.display}.` : ' Use "!resumerecurringpolls all" to re-enable them.';

  if (cleanId === 'all') {
    const isAll = !chatId || !chatId.endsWith('@g.us');
    let count = 0;
    for (const [, sched] of recurringPolls.entries()) {
      if (isAll || sched.remoteJid === chatId) {
        sched.enabled = false;
        if (parsedUntil) {
          sched.pausedUntil = parsedUntil.dateKey;
          sched.pausedUntilDisplay = parsedUntil.display;
        } else {
          delete sched.pausedUntil;
          delete sched.pausedUntilDisplay;
        }
        count++;
      }
    }
    if (count === 0) {
      return '📅 No scheduled recurring polls found to pause.';
    }
    persistPolls();
    return `⏸️ Paused all ${count} recurring match poll schedule(s)${untilNote}.${autoResumeNote}`;
  }

  if (!cleanId) {
    return 'Please provide the schedule ID to pause, e.g. "!pauserecurringpoll rec_1" or "!pauserecurringpoll all" (optionally with "until <date>"). Use "!recurringpolls" to view active IDs.';
  }

  let targetKey = cleanId;
  if (!recurringPolls.has(targetKey)) {
    for (const key of recurringPolls.keys()) {
      if (key.toLowerCase() === cleanId.toLowerCase()) {
        targetKey = key;
        break;
      }
    }
  }
  if (!recurringPolls.has(targetKey)) {
    return `⚠️ Schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view active IDs.`;
  }
  const sched = recurringPolls.get(targetKey);
  sched.enabled = false;
  if (parsedUntil) {
    sched.pausedUntil = parsedUntil.dateKey;
    sched.pausedUntilDisplay = parsedUntil.display;
  } else {
    delete sched.pausedUntil;
    delete sched.pausedUntilDisplay;
  }
  persistPolls();

  const singleAutoResume = parsedUntil
    ? ` It will resume automatically on *${parsedUntil.display}*.`
    : ` It will not automatically post polls until resumed with "!resumerecurringpoll ${targetKey}".`;

  return `⏸️ Paused recurring poll schedule \`${targetKey}\` (${sched.matchDisplay})${untilNote}.${singleAutoResume}`;
}

/**
 * Resumes a recurring poll schedule (or all schedules).
 */
async function resumeRecurringPoll({ recurringPolls, persistPolls, scheduleId, chatId = null }) {
  const cleanId = String(scheduleId || '').replace(/^["']|["']$/g, '').trim();
  if (cleanId === 'all') {
    const isAll = !chatId || !chatId.endsWith('@g.us');
    let count = 0;
    for (const [, sched] of recurringPolls.entries()) {
      if (isAll || sched.remoteJid === chatId) {
        sched.enabled = true;
        delete sched.pausedUntil;
        delete sched.pausedUntilDisplay;
        count++;
      }
    }
    if (count === 0) {
      return '📅 No scheduled recurring polls found to resume.';
    }
    persistPolls();
    return `▶️ Resumed all ${count} recurring match poll schedule(s).`;
  }

  if (!cleanId) {
    return 'Please provide the schedule ID to resume, e.g. "!resumerecurringpoll rec_1" or "!resumerecurringpoll all". Use "!recurringpolls" to view active IDs.';
  }

  let targetKey = cleanId;
  if (!recurringPolls.has(targetKey)) {
    for (const key of recurringPolls.keys()) {
      if (key.toLowerCase() === cleanId.toLowerCase()) {
        targetKey = key;
        break;
      }
    }
  }
  if (!recurringPolls.has(targetKey)) {
    return `⚠️ Schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view active IDs.`;
  }
  const sched = recurringPolls.get(targetKey);
  sched.enabled = true;
  delete sched.pausedUntil;
  delete sched.pausedUntilDisplay;
  persistPolls();
  return `▶️ Resumed recurring poll schedule \`${targetKey}\` (${sched.matchDisplay}). It will post at ${sched.postDisplay} on ${sched.daysDisplay || 'scheduled days'}.`;
}



const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const MONTH_MAP = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11
};

/**
 * Parses a date or day string into a normalized dateKey ("YYYY-MM-DD") and display string in San Jose timezone.
 * Supports: YYYY-MM-DD, MM/DD/YYYY, MM/DD, "Oct 25", "October 25th", "25th Oct", "tomorrow", "today", weekdays ("Monday", "next Wednesday").
 */
function parseDateToDateKey(rawStr, customSanJoseParts = null) {
  if (!rawStr || typeof rawStr !== "string") return null;
  let str = rawStr.toLowerCase()
    .replace(/^!(?:pauserecurringpoll|pauserecurring|pausepoll|pause)\s*/i, "")
    .replace(/\b(?:until|till|through|thru|to|after)\b/gi, "")
    .replace(/(\d+)(?:st|nd|rd|th)\b/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!str) return null;

  const sj = customSanJoseParts || pollTime.getSanJoseParts();
  let year = sj.year;
  let month = null;
  let day = null;

  // 1. YYYY-MM-DD
  const mIso = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (mIso) {
    year = parseInt(mIso[1], 10);
    month = parseInt(mIso[2], 10) - 1;
    day = parseInt(mIso[3], 10);
  }

  // 2. MM/DD/YYYY or MM/DD
  if (month === null) {
    const mSlash = str.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if (mSlash) {
      month = parseInt(mSlash[1], 10) - 1;
      day = parseInt(mSlash[2], 10);
      if (mSlash[3]) {
        year = parseInt(mSlash[3], 10);
        if (year < 100) year += 2000;
      } else {
        year = sj.year;
        if (month < sj.month || (month === sj.month && day < sj.day)) {
          year += 1;
        }
      }
    }
  }

  // 3. Month Day (e.g. "oct 25", "october 25 2026")
  if (month === null) {
    const mMonthDay = str.match(/^([a-z]+)\s+(\d{1,2})(?:[,\s]+(\d{4}))?$/);
    if (mMonthDay && MONTH_MAP[mMonthDay[1]] !== undefined) {
      month = MONTH_MAP[mMonthDay[1]];
      day = parseInt(mMonthDay[2], 10);
      year = mMonthDay[3] ? parseInt(mMonthDay[3], 10) : sj.year;
      if (!mMonthDay[3] && (month < sj.month || (month === sj.month && day < sj.day))) {
        year += 1;
      }
    }
  }

  // 4. Day Month (e.g. "25 oct", "25 october 2026")
  if (month === null) {
    const mDayMonth = str.match(/^(\d{1,2})\s+([a-z]+)(?:[,\s]+(\d{4}))?$/);
    if (mDayMonth && MONTH_MAP[mDayMonth[2]] !== undefined) {
      day = parseInt(mDayMonth[1], 10);
      month = MONTH_MAP[mDayMonth[2]];
      year = mDayMonth[3] ? parseInt(mDayMonth[3], 10) : sj.year;
      if (!mDayMonth[3] && (month < sj.month || (month === sj.month && day < sj.day))) {
        year += 1;
      }
    }
  }

  // 5. tomorrow
  if (month === null && str === "tomorrow") {
    const d = new Date(Date.UTC(sj.year, sj.month, sj.day + 1));
    year = d.getUTCFullYear();
    month = d.getUTCMonth();
    day = d.getUTCDate();
  }

  // 6. today
  if (month === null && str === "today") {
    year = sj.year;
    month = sj.month;
    day = sj.day;
  }

  // 7. Weekdays (e.g. "monday", "next wednesday")
  if (month === null) {
    const mDay = str.match(/^(?:next\s+)?(sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)$/);
    if (mDay) {
      const targetDow = DAY_LOOKUP[mDay[1].slice(0, 3)];
      const currentDow = new Date(Date.UTC(sj.year, sj.month, sj.day)).getUTCDay();
      let diff = targetDow - currentDow;
      if (diff <= 0) diff += 7;
      if (/^next\s+/.test(str) && diff < 7) diff += 7;
      const d = new Date(Date.UTC(sj.year, sj.month, sj.day + diff));
      year = d.getUTCFullYear();
      month = d.getUTCMonth();
      day = d.getUTCDate();
    }
  }

  if (month === null || day === null) return null;

  const dateObj = new Date(Date.UTC(year, month, day));
  const finalYear = dateObj.getUTCFullYear();
  const finalMonth = dateObj.getUTCMonth();
  const finalDay = dateObj.getUTCDate();
  const dateKey = `${finalYear}-${String(finalMonth + 1).padStart(2, "0")}-${String(finalDay).padStart(2, "0")}`;
  const dayName = DAY_NAMES[dateObj.getUTCDay()];
  const monthName = MONTH_NAMES[finalMonth];
  const display = `${dayName}, ${monthName} ${finalDay}, ${finalYear}`;
  const todayKey = `${sj.year}-${String(sj.month + 1).padStart(2, "0")}-${String(sj.day).padStart(2, "0")}`;
  const isPast = dateKey < todayKey;

  return { dateKey, display, dateObj, year: finalYear, month: finalMonth, day: finalDay, isPast };
}

/**
 * Extracts scheduleId and untilDate from command text for pause operations.
 */
function extractPauseArgs(rawInput) {
  let str = (rawInput || "").trim();
  let untilDate = null;

  // 1. Check for --until=... or -u ...
  const flagM = str.match(/(?:--(?:until|till|resume-date|resumedate)=|-(?:u)\s+)(["']?)([^"'\s]+)\1/i);
  if (flagM) {
    untilDate = flagM[2].trim();
    str = str.replace(flagM[0], " ").trim();
  }

  // 2. Check for "until <date>", "till <date>", "through <date>"
  if (!untilDate) {
    const untilM = str.match(/\b(?:until|till|through|thru)\s+([a-z0-9\/\-,\s]+)$/i);
    if (untilM) {
      untilDate = untilM[1].trim();
      str = str.slice(0, untilM.index).trim();
    }
  }

  let scheduleId = str.trim() || null;

  // 3. If scheduleId has 2 tokens and 2nd token is a date:
  if (scheduleId && !untilDate) {
    const parts = scheduleId.split(/\s+/);
    if (parts.length >= 2) {
      const candidateDate = parts.slice(1).join(" ").trim();
      if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(candidateDate) ||
          /^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/.test(candidateDate) ||
          /^(?:tomorrow|today|sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)/i.test(candidateDate) ||
          /^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(candidateDate)) {
        scheduleId = parts[0].trim();
        untilDate = candidateDate;
      }
    }
  }

  // 4. If single token and it looks like a date:
  if (scheduleId && !untilDate) {
    const isDate = /^\d{4}-\d{1,2}-\d{1,2}$/.test(scheduleId) ||
      /^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/.test(scheduleId) ||
      /^(?:today|tomorrow|sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)$/i.test(scheduleId);
    if (isDate) {
      untilDate = scheduleId;
      scheduleId = null;
    }
  }

  return { scheduleId, untilDate };
}

/**
 * Extracts scheduleId, targetDayOrDate, and count for skip operations.
 */
function extractSkipArgs(scheduleIdArg, targetDayOrDateArg) {
  let scheduleId = String(scheduleIdArg || "").replace(/^["']|["']$/g, "").trim() || null;
  let target = String(targetDayOrDateArg || "").replace(/^["']|["']$/g, "").trim() || null;
  let count = 1;

  if (scheduleId && !target) {
    const parts = scheduleId.split(/\s+/);
    if (parts.length >= 2) {
      scheduleId = parts[0].trim();
      target = parts.slice(1).join(" ").trim();
    }
  }

  const combined = `${scheduleId || ""} ${target || ""}`.trim();
  const countFlagM = combined.match(/(?:--(?:count|instances?|num)=|-(?:n|c)\s+)(\d+)/i);
  if (countFlagM) {
    count = parseInt(countFlagM[1], 10);
    if (scheduleId) scheduleId = scheduleId.replace(countFlagM[0], "").trim() || null;
    if (target) target = target.replace(countFlagM[0], "").trim() || null;
  }

  if (target) {
    const numM = target.match(/^(?:next\s+)?(\d+)(?:\s*instances?)?$/i);
    if (numM) {
      count = parseInt(numM[1], 10);
      target = null;
    }
  }

  if (scheduleId) {
    const numM = scheduleId.match(/^(?:next\s+)?(\d+)(?:\s*instances?)?$/i);
    if (numM) {
      count = parseInt(numM[1], 10);
      scheduleId = null;
    }
  }

  return { scheduleId, targetDayOrDate: target, count: Math.max(1, count) };
}

/**
 * Returns an array of the next upcoming instance dates for a recurring schedule.
 * Scans up to 90 days ahead and skips dates already in sched.skippedMatchDates.
 */
function getUpcomingInstanceDates(sched, customSanJoseParts = null, count = 1, filterTarget = null) {
  const sj = customSanJoseParts || pollTime.getSanJoseParts();
    const todayKey = `${sj.year}-${String(sj.month + 1).padStart(2, '0')}-${String(sj.day).padStart(2, '0')}`;
    const currentMinutes = sj.hour * 60 + sj.minute;
  const schedMatchMinutes = (sched.matchHour !== undefined ? sched.matchHour : 19) * 60 + (sched.matchMinute || 0);

  const schedDays = (Array.isArray(sched.daysList) && sched.daysList.length > 0)
    ? [...new Set(sched.daysList)]
    : [...new Set(parseDaysOfWeek(sched.days).days)];

  let filterDayIndex = null;
  let filterDateKey = null;

  if (filterTarget && typeof filterTarget === "string") {
    const clean = filterTarget.trim().toLowerCase();
    if (DAY_LOOKUP[clean] !== undefined) {
      filterDayIndex = DAY_LOOKUP[clean];
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(clean)) {
      filterDateKey = clean;
    } else if (clean === "today") {
      const todayObj = new Date(Date.UTC(sj.year, sj.month, sj.day));
      filterDateKey = `${todayObj.getUTCFullYear()}-${String(todayObj.getUTCMonth() + 1).padStart(2, "0")}-${String(todayObj.getUTCDate()).padStart(2, "0")}`;
    } else if (clean === "tomorrow") {
      const tomObj = new Date(Date.UTC(sj.year, sj.month, sj.day + 1));
      filterDateKey = `${tomObj.getUTCFullYear()}-${String(tomObj.getUTCMonth() + 1).padStart(2, "0")}-${String(tomObj.getUTCDate()).padStart(2, "0")}`;
    } else {
      const slashM = clean.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
      if (slashM) {
        const m = parseInt(slashM[1], 10);
        const d = parseInt(slashM[2], 10);
        let y = slashM[3] ? parseInt(slashM[3], 10) : sj.year;
        if (y < 100) y += 2000;
        filterDateKey = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      }
    }
  }

  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const skippedList = Array.isArray(sched.skippedMatchDates) ? sched.skippedMatchDates : [];

  const results = [];
  const targetCount = Math.max(1, count || 1);

  for (let offset = 0; offset <= 90; offset++) {
    const candidateDate = new Date(Date.UTC(sj.year, sj.month, sj.day + offset));
    const dayIndex = candidateDate.getUTCDay();
    const year = candidateDate.getUTCFullYear();
    const month = candidateDate.getUTCMonth();
    const day = candidateDate.getUTCDate();
    const dateKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

    if (!schedDays.includes(dayIndex)) continue;
    if (offset === 0 && currentMinutes >= schedMatchMinutes) continue;

    if (filterDayIndex !== null && dayIndex !== filterDayIndex) continue;
    if (filterDateKey !== null && dateKey !== filterDateKey) continue;

    if (sched.startDate && dateKey < sched.startDate) continue;
    if (sched.endDate && dateKey > sched.endDate) break;

    if (filterDayIndex === null && filterDateKey === null && skippedList.includes(dateKey)) {
      continue;
    }

    const dayName = DAY_NAMES[dayIndex];
    const monthName = MONTH_NAMES[month];
    const display = `${dayName}, ${monthName} ${day} (${dateKey}) at ${sched.matchDisplay || sched.matchTime}`;

    results.push({ dateKey, dayIndex, dayName, display, dateObj: candidateDate, offset });

    if (results.length >= targetCount) {
      break;
    }
  }

  return results;
}

/**
 * Resolves the upcoming match date and display info for an instance of a recurring schedule.
 * Scans candidate dates starting from current day up to 28 days in advance.
 */
function getNextInstanceDate(sched, customSanJoseParts = null, targetDayOrDate = null) {
  const list = getUpcomingInstanceDates(sched, customSanJoseParts, 1, targetDayOrDate);
  return list.length > 0 ? list[0] : null;
}

/**
 * Skips a single scheduled instance for a recurring poll (e.g. next instance or a specific date/day).
 * If the instance was already created as an active poll on WhatsApp, cancels and deletes it.
 * Subsequent future instances remain active and scheduled.
 */
async function skipRecurringPollInstance({
  recurringPolls,
  activePolls = null,
  persistPolls,
  cancelOrDeletePoll = null,
  sock = null,
  scheduleId,
  targetDayOrDate = null,
  count = 1,
  chatId = null,
  sender = 'User'
}) {
  const extracted = extractSkipArgs(scheduleId, targetDayOrDate);
  let cleanId = extracted.scheduleId || '';
  let effTarget = extracted.targetDayOrDate;
  let effCount = (count && parseInt(count, 10) > 1) ? parseInt(count, 10) : extracted.count;

  if (!cleanId) {
    return 'Please provide the schedule ID to skip an instance for, e.g. "!skipinstance rec_1" or "!skipinstance rec_1 3". Use "!recurringpolls" to view active IDs.';
  }

  let targetKey = cleanId;
  if (!recurringPolls.has(targetKey)) {
    for (const key of recurringPolls.keys()) {
      if (key.toLowerCase() === cleanId.toLowerCase()) {
        targetKey = key;
        break;
      }
    }
  }
  if (!recurringPolls.has(targetKey)) {
    return `⚠️ Schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view active schedule IDs.`;
  }

  const sched = recurringPolls.get(targetKey);
  const targetInstances = getUpcomingInstanceDates(sched, null, effCount, effTarget);
  if (!targetInstances || targetInstances.length === 0) {
    const filterDesc = effTarget ? ` matching "${effTarget}"` : '';
    return `⚠️ No upcoming match instance found${filterDesc} for schedule \`${targetKey}\` (${sched.matchDisplay} on ${sched.daysDisplay || 'scheduled days'}).`;
  }

  if (!Array.isArray(sched.skippedMatchDates)) {
    sched.skippedMatchDates = [];
  }
  if (!Array.isArray(sched.postedMatchDates)) {
    sched.postedMatchDates = [];
  }

  const deletedPollNotes = [];

  for (const targetInstance of targetInstances) {
    let activeInstancePollId = null;
    let activeInstancePollState = null;
    if (activePolls) {
      for (const [id, state] of activePolls.entries()) {
        if (state.status === 'cancelled' || state.status === 'expired') continue;
        const sId = state.scheduleId;
        if (sId && sId.toLowerCase() === targetKey.toLowerCase()) {
          if (state.playAt) {
            const playDate = new Date(state.playAt);
            if (!Number.isNaN(playDate.getTime())) {
              const sjParts = pollTime.getSanJoseParts(playDate);
              const pKey = `${sjParts.year}-${String(sjParts.month + 1).padStart(2, '0')}-${String(sjParts.day).padStart(2, '0')}`;
              if (pKey === targetInstance.dateKey) {
                activeInstancePollId = id;
                activeInstancePollState = state;
                break;
              }
            }
          }
        }
      }
    }

    if (activeInstancePollId && typeof cancelOrDeletePoll === 'function') {
      try {
        await cancelOrDeletePoll(sock, activeInstancePollState.remoteJid || chatId, activeInstancePollId);
        deletedPollNotes.push(`The active poll for ${targetInstance.display} was deleted from WhatsApp.`);
      } catch (err) {
        console.error(`[recurring-poll] Failed to delete active poll ${activeInstancePollId} when skipping instance:`, err.message);
      }
    }

    if (!sched.skippedMatchDates.includes(targetInstance.dateKey)) {
      sched.skippedMatchDates.push(targetInstance.dateKey);
    }
    if (!sched.postedMatchDates.includes(targetInstance.dateKey)) {
      sched.postedMatchDates.push(targetInstance.dateKey);
    }
  }

  persistPolls();
  console.log(`[recurring-poll] Skipped ${targetInstances.length} instance(s) for schedule ${targetKey} by ${sender}: [${targetInstances.map(ti => ti.dateKey).join(', ')}]`);

  let instancesDesc = '';
  if (targetInstances.length === 1) {
    instancesDesc = `• *Skipped Match:* ${targetInstances[0].display}\n`;
  } else {
    instancesDesc = `• *Skipped ${targetInstances.length} Upcoming Instances:*\n` + targetInstances.map(ti => `  - ${ti.display}`).join('\n') + '\n';
  }

  const deletedText = deletedPollNotes.length > 0 ? `• *Active WhatsApp Poll(s) Deleted:*\n${deletedPollNotes.map(n => `  - ${n}`).join('\n')}\n` : '';

  return `⏭️ *Skipped ${targetInstances.length > 1 ? `${targetInstances.length} Poll Instances` : 'Poll Instance'} for Recurring Schedule \`${targetKey}\` (${sched.matchDisplay}):*\n` +
    instancesDesc +
    deletedText +
    `• *Schedule Status:* Remains active. Subsequent instances after these will post automatically as scheduled.\n` +
    `_(To undo, run "!unskipinstance ${targetKey} ${targetInstances.length > 1 ? targetInstances.length : targetInstances[0].dateKey}")_`;
}

/**
 * Restores a skipped instance for a recurring poll schedule.
 */
async function unskipRecurringPollInstance({
  recurringPolls,
  persistPolls,
  scheduleId,
  targetDayOrDate = null,
  chatId = null,
  sender = 'User'
}) {
  const cleanId = String(scheduleId || '').replace(/^["']|["']$/g, '').trim();
  if (!cleanId) {
    return 'Please provide the schedule ID to unskip, e.g. "!unskipinstance rec_1". Use "!recurringpolls" to view active IDs.';
  }

  let targetKey = cleanId;
  if (!recurringPolls.has(targetKey)) {
    for (const key of recurringPolls.keys()) {
      if (key.toLowerCase() === cleanId.toLowerCase()) {
        targetKey = key;
        break;
      }
    }
  }
  if (!recurringPolls.has(targetKey)) {
    return `⚠️ Schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view active schedule IDs.`;
  }

  const sched = recurringPolls.get(targetKey);
  if (!Array.isArray(sched.skippedMatchDates) || sched.skippedMatchDates.length === 0) {
    return `ℹ️ No skipped instances recorded for recurring schedule \`${targetKey}\`.`;
  }

  let datesToUnskip = [];
  const cleanTarget = targetDayOrDate ? String(targetDayOrDate).trim().toLowerCase() : '';

  if (cleanTarget === 'all') {
    datesToUnskip = [...sched.skippedMatchDates];
  } else if (/^\d+$/.test(cleanTarget)) {
    const unskipCount = Math.min(sched.skippedMatchDates.length, parseInt(cleanTarget, 10));
    datesToUnskip = sched.skippedMatchDates.slice(0, unskipCount);
  } else if (cleanTarget) {
    const matched = getNextInstanceDate(sched, null, cleanTarget);
    if (matched && sched.skippedMatchDates.includes(matched.dateKey)) {
      datesToUnskip = [matched.dateKey];
    } else {
      for (const d of sched.skippedMatchDates) {
        if (d.includes(cleanTarget) || cleanTarget.includes(d)) {
          datesToUnskip = [d];
          break;
        }
      }
    }
  }

  if (datesToUnskip.length === 0) {
    datesToUnskip = [sched.skippedMatchDates[0]];
  }

  sched.skippedMatchDates = sched.skippedMatchDates.filter((d) => !datesToUnskip.includes(d));
  if (Array.isArray(sched.postedMatchDates)) {
    sched.postedMatchDates = sched.postedMatchDates.filter((d) => !datesToUnskip.includes(d));
  }
  if (datesToUnskip.includes(sched.lastPostedMatchDate)) {
    sched.lastPostedMatchDate = sched.postedMatchDates[sched.postedMatchDates.length - 1] || null;
  }

  persistPolls();
  console.log(`[recurring-poll] Unskipped ${datesToUnskip.length} instance(s) for schedule ${targetKey}: [${datesToUnskip.join(', ')}] by ${sender}`);

  return `▶️ *Restored ${datesToUnskip.length > 1 ? `${datesToUnskip.length} Skipped Instances` : 'Skipped Instance'} for Recurring Schedule \`${targetKey}\`:*\n` +
    `• *Restored Match Date(s):* ${datesToUnskip.join(', ')}\n` +
    `• Polls for these matches will post automatically as scheduled.`;
}

let isPostingSweepRunning = false;
const inFlightTriggers = new Set();

/**
 * Sweeps all recurring poll schedules and automatically creates and posts polls whose post time has arrived on scheduled posting days.
 * Fully supports posting same day, 1 day before (e.g. Sunday 6pm for Monday 7pm), or more than 24 hours in advance (e.g. 2+ days before).
 */
const inFlightAdvanceTriggers = new Set();
let isAdvanceBookingSweepRunning = false;

/**
 * Checks if a match poll has already been created for a given recurring schedule and match date.
 */
function isPollCreatedForMatchDate(sched, targetMatchDateKey, activePolls = null) {
  if (!sched || !targetMatchDateKey) return false;
  if (Array.isArray(sched.postedMatchDates) && sched.postedMatchDates.includes(targetMatchDateKey)) {
    return true;
  }
  if (sched.lastPostedMatchDate === targetMatchDateKey) {
    return true;
  }
  if (sched.advanceBookings?.[targetMatchDateKey]?.pollCreated) {
    return true;
  }
  if (activePolls) {
    for (const [id, state] of activePolls.entries()) {
      if (state.status === 'cancelled') continue;
      if (state.remoteJid === sched.remoteJid) {
        if (!state.scheduleId || state.scheduleId.toLowerCase() === sched.id?.toLowerCase()) {
          if (state.playAt) {
            const playDate = new Date(state.playAt);
            if (!Number.isNaN(playDate.getTime())) {
              const sjParts = pollTime.getSanJoseParts(playDate);
              const pKey = `${sjParts.year}-${String(sjParts.month + 1).padStart(2, '0')}-${String(sjParts.day).padStart(2, '0')}`;
              if (pKey === targetMatchDateKey) {
                return true;
              }
            }
          }
        }
      }
    }
  }
  return false;
}

/**
 * Queries SCVCC for any courts manually booked by players for a specific match date and time.
 * Only courts with at least 90 minutes availability / duration qualify.
 */
async function detectManualPlayerBookings({ remoteJid, targetDateMDY, queryTime, sport = 'tennis', lookAround = 0 }) {
  const manualCourts = [];
  const seenCourts = new Set();
  const candidateTimes = getCandidateTimes(queryTime, lookAround);

  try {
    for (const t of candidateTimes) {
      const [avail, bookingsRes] = await Promise.all([
        scvcc.checkCourtAvailability({ when: targetDateMDY, time: t, sport, chatId: remoteJid }).catch((err) => {
          console.warn(`[advance-booking] Error checking court availability for manual bookings at ${t}:`, err.message);
          return null;
        }),
        scvcc.getCourtBookings({ when: targetDateMDY, time: t, sport, chatId: remoteJid }).catch((err) => {
          console.warn(`[advance-booking] Error checking court bookings for manual bookings at ${t}:`, err.message);
          return null;
        })
      ]);

      const bookings = bookingsRes?.bookings || [];
      for (const b of bookings) {
        if (!b.court || courtsConfig.isIgnoredCourt(b.court, remoteJid)) continue;
        const courtKey = b.court.toLowerCase().trim();
        if (seenCourts.has(courtKey)) continue;
        if (b.durationMins && b.durationMins < 90) continue;

        const prebookedMatch = scvcc.detectPrebookedCourt(b, remoteJid);
        if (prebookedMatch) {
          seenCourts.add(courtKey);
          manualCourts.push({
            court: b.court,
            player: prebookedMatch.player || 'Member',
            fullName: prebookedMatch.fullName || prebookedMatch.player || 'Member',
            duration: b.durationMins ? `${b.durationMins} Minutes` : '90 Minutes',
            time: t
          });
        }
      }

      if (avail?.slots && avail.slots.length > 0) {
        const slot = avail.slots[0];
        for (const c of slot.courts || []) {
          if (!c.court || courtsConfig.isIgnoredCourt(c.court, remoteJid)) continue;
          const courtKey = c.court.toLowerCase().trim();
          if (seenCourts.has(courtKey)) continue;
          const durationMins = c.durationMins || c.totalDurationMins || null;
          if (durationMins && durationMins < 90) continue;
          if (c.status === 'prebooked') {
            seenCourts.add(courtKey);
            manualCourts.push({
              court: c.court,
              player: c.prebookedBy || 'Member',
              fullName: c.prebookedFullName || c.prebookedBy || 'Member',
              duration: c.availableMinutes ? `${c.availableMinutes} Minutes` : '90 Minutes',
              time: t
            });
          }
        }
      }
    }
  } catch (err) {
    console.warn('[advance-booking] Error in detectManualPlayerBookings:', err.message);
  }
  return manualCourts;
}

/**
 * Checks and automatically books courts in advance for recurring polls configured with
 * bookingStrategy = 'advanced' and bookingSchedule (e.g. '-7days 7:00AM').
 * If insufficient courts are booked at the initial booking time, checks periodically
 * twice a day at 9:30am and 3:30pm until the poll is created.
 * Also accounts for any courts booked manually by players.
 */
async function checkAndExecuteAdvanceBookings({
  sock,
  recurringPolls,
  persistPolls,
  preBookCourtsForMatch,
  activePolls = null,
  customSanJoseParts = null,
  sendBookingNotifications = null
}) {
  if (!sock || !recurringPolls || recurringPolls.size === 0 || !preBookCourtsForMatch) return;
  if (isAdvanceBookingSweepRunning) return;
  isAdvanceBookingSweepRunning = true;

  try {
    const sj = customSanJoseParts || pollTime.getSanJoseParts();
    const todayKey = `${sj.year}-${String(sj.month + 1).padStart(2, '0')}-${String(sj.day).padStart(2, '0')}`;
    const currentMinutes = sj.hour * 60 + sj.minute;
    const nowMs = Date.now();
    const RETRY_INTERVAL_MS = 10 * 60 * 1000;
    const MAX_RETRY_WINDOW_MS = 60 * 60 * 1000;
    const CHECK_SLOT_1_MINUTES = 9 * 60 + 30; // 570 (9:30 AM)
    const CHECK_SLOT_2_MINUTES = 15 * 60 + 30; // 930 (3:30 PM)

    for (const [scheduleId, sched] of recurringPolls.entries()) {
      if (sched.endDate && todayKey > sched.endDate) {
        if (sched.enabled) {
          console.log(`[recurring-poll] Recurring schedule ${scheduleId} reached end date ${sched.endDate}; disabling schedule.`);
          sched.enabled = false;
          sched.ended = true;
          persistPolls();
        }
        continue;
      }
      if (sched.pausedUntil) {
        if (todayKey >= sched.pausedUntil) {
          console.log(`[recurring-poll] Auto-resuming recurring schedule ${scheduleId}: reached pause date ${sched.pausedUntil}`);
          sched.enabled = true;
          delete sched.pausedUntil;
          delete sched.pausedUntilDisplay;
          persistPolls();
        }
      }
      if (!sched.enabled) continue;

      const groupCfg = groupsConfig.getGroupConfig(sched.remoteJid);
      if (!groupsConfig.isCourtBookingEnabled(sched.remoteJid)) continue;

      const strategy = sched.bookingStrategy || groupCfg?.bookingStrategy || null;
      if (strategy !== 'advanced') continue;

      const rawSchedule = sched.bookingSchedule || groupCfg?.bookingSchedule || '-7days 7:00AM';
      const parsedSchedule = groupsConfig.parseBookingSchedule(rawSchedule);
      if (!parsedSchedule) continue;

      const bookingDaysBefore = parsedSchedule.daysBefore;
      const bookingTimeMinutes = parsedSchedule.hour * 60 + parsedSchedule.minute;

      const schedDays = (Array.isArray(sched.daysList) && sched.daysList.length > 0)
        ? [...new Set(sched.daysList)]
        : [...new Set(parseDaysOfWeek(sched.days).days)];

      const schedMatchMinutes = sched.matchHour * 60 + sched.matchMinute;

      // Calculate required court count
      let targetCourtsCount = 1;
      const isAuto = sched.size === 'auto' || !sched.size;
      if (!isAuto && sched.size && parseInt(sched.size, 10) > 0) {
        targetCourtsCount = Math.max(1, Math.ceil(parseInt(sched.size, 10) / 4));
      } else {
        const explicitCourts = (sched.preBookCourts !== undefined && sched.preBookCourts !== null && parseInt(sched.preBookCourts, 10) > 0)
          ? parseInt(sched.preBookCourts, 10)
          : null;
        const cfgCourts = (groupCfg?.preBookCourts !== undefined && groupCfg?.preBookCourts !== null && parseInt(groupCfg.preBookCourts, 10) > 0)
          ? parseInt(groupCfg.preBookCourts, 10)
          : (groupCfg?.preBookCourtsCount !== undefined && groupCfg?.preBookCourtsCount !== null && parseInt(groupCfg.preBookCourtsCount, 10) > 0
            ? parseInt(groupCfg.preBookCourtsCount, 10)
            : 1);
        targetCourtsCount = explicitCourts || cfgCourts || 1;
      }

      // Collect all candidate match dates from bookingDaysBefore down to 0, plus any pending entries
      const candidateMatchDates = new Map();
      for (let offset = bookingDaysBefore; offset >= 0; offset--) {
        const dObj = new Date(Date.UTC(sj.year, sj.month, sj.day + offset));
        const tYear = dObj.getUTCFullYear();
        const tMonth = dObj.getUTCMonth();
        const tDay = dObj.getUTCDate();
        const tKey = `${tYear}-${String(tMonth + 1).padStart(2, '0')}-${String(tDay).padStart(2, '0')}`;
        const tDayIndex = dObj.getUTCDay();
        candidateMatchDates.set(tKey, { targetDateObj: dObj, daysOffset: offset, targetDayIndex: tDayIndex });
      }

      if (sched.advanceBookings) {
        for (const tKey of Object.keys(sched.advanceBookings)) {
          if (tKey >= todayKey && !candidateMatchDates.has(tKey)) {
            const parts = tKey.split('-').map(Number);
            if (parts.length === 3) {
              const dObj = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
              const tDayIndex = dObj.getUTCDay();
              const diffDays = Math.round((dObj.getTime() - Date.UTC(sj.year, sj.month, sj.day)) / (24 * 3600 * 1000));
              candidateMatchDates.set(tKey, { targetDateObj: dObj, daysOffset: diffDays, targetDayIndex: tDayIndex });
            }
          }
        }
      }

      for (const [targetMatchDateKey, { targetDateObj, daysOffset, targetDayIndex }] of candidateMatchDates.entries()) {
        if (!schedDays.includes(targetDayIndex)) continue;
        if (sched.startDate && targetMatchDateKey < sched.startDate) continue;
        if (sched.endDate && targetMatchDateKey > sched.endDate) continue;

        if (Array.isArray(sched.skippedMatchDates) && sched.skippedMatchDates.includes(targetMatchDateKey)) {
          continue;
        }

        // Stop checking if poll is already created for this match date
        if (isPollCreatedForMatchDate(sched, targetMatchDateKey, activePolls)) {
          continue;
        }

        const postConfig = getPostTimeForSchedule(sched, targetDayIndex);
        const postDaysBefore = postConfig.daysBefore !== undefined ? postConfig.daysBefore : 0;
        const postHour = postConfig.postHour !== undefined ? postConfig.postHour : (postConfig.hour || 8);
        const postMinute = postConfig.postMinute !== undefined ? postConfig.postMinute : (postConfig.minute || 0);
        const postMinutes = postHour * 60 + postMinute;

        // Stop checking if poll posting time has arrived or passed for this match date
        if (daysOffset < postDaysBefore) continue;
        if (daysOffset === postDaysBefore && currentMinutes >= postMinutes) continue;

        if (targetMatchDateKey < todayKey) continue;
        if (targetMatchDateKey === todayKey && currentMinutes >= schedMatchMinutes) continue;

        // Has booking window opened?
        if (daysOffset > bookingDaysBefore) continue;
        if (daysOffset === bookingDaysBefore && currentMinutes < bookingTimeMinutes) continue;

        if (!sched.advanceBookings) sched.advanceBookings = {};
        const existingEntry = sched.advanceBookings[targetMatchDateKey];
        const existingAdvanceCourts = Array.isArray(existingEntry?.advanceBookedCourts) ? existingEntry.advanceBookedCourts : [];
        const existingPrebookedCourts = Array.isArray(existingEntry?.prebookedCourts) ? existingEntry.prebookedCourts : [];

        const currentSecuredCourtNames = new Set([
          ...existingAdvanceCourts.map((b) => b.court?.toLowerCase().trim()).filter(Boolean),
          ...existingPrebookedCourts.map((b) => b.court?.toLowerCase().trim()).filter(Boolean)
        ]);

        if (existingEntry?.completed && currentSecuredCourtNames.size >= targetCourtsCount) {
          continue;
        }

        // Determine what action is due:
        const isInitialAttempt = !existingEntry || !existingEntry.firstAttemptAt;
        const isInitialRetry = Boolean(
          existingEntry?.firstAttemptAt &&
          (nowMs - existingEntry.firstAttemptAt < MAX_RETRY_WINDOW_MS) &&
          (nowMs - (existingEntry.lastAttemptAt || 0) >= RETRY_INTERVAL_MS)
        );

        let periodicSlotKey = null;
        if (currentMinutes >= CHECK_SLOT_2_MINUTES) {
          periodicSlotKey = `${todayKey}:15:30`;
        } else if (currentMinutes >= CHECK_SLOT_1_MINUTES) {
          periodicSlotKey = `${todayKey}:09:30`;
        }

        const executedSlots = Array.isArray(existingEntry?.periodicChecks) ? existingEntry.periodicChecks : [];
        const isPeriodicCheckDue = Boolean(
          periodicSlotKey &&
          !executedSlots.includes(periodicSlotKey) &&
          (existingEntry?.firstAttemptAt || daysOffset < bookingDaysBefore || (daysOffset === bookingDaysBefore && currentMinutes >= bookingTimeMinutes))
        );

        if (!isInitialAttempt && !isInitialRetry && !isPeriodicCheckDue) {
          continue;
        }

        const targetMonth = targetDateObj.getUTCMonth();
        const targetDay = targetDateObj.getUTCDate();
        const targetYear = targetDateObj.getUTCFullYear();
        const targetDateMDY = `${String(targetMonth + 1).padStart(2, '0')}/${String(targetDay).padStart(2, '0')}/${targetYear}`;

        // Step 1: Detect any manual player bookings
        const manualPlayerBookings = await detectManualPlayerBookings({
          remoteJid: sched.remoteJid,
          targetDateMDY,
          queryTime: sched.matchTime,
          sport: sched.sport || 'tennis',
          lookAround: sched.lookAround || groupCfg?.lookAround || null
        });

        const seenPrebookedCourtNames = new Set(existingPrebookedCourts.map((b) => b.court?.toLowerCase().trim()).filter(Boolean));
        for (const pb of manualPlayerBookings) {
          const cKey = pb.court?.toLowerCase().trim();
          if (cKey && !seenPrebookedCourtNames.has(cKey)) {
            seenPrebookedCourtNames.add(cKey);
            existingPrebookedCourts.push(pb);
          }
        }

        const updatedSecuredCourtNames = new Set([
          ...existingAdvanceCourts.map((b) => b.court?.toLowerCase().trim()).filter(Boolean),
          ...existingPrebookedCourts.map((b) => b.court?.toLowerCase().trim()).filter(Boolean)
        ]);

        const periodicChecksArr = Array.isArray(existingEntry?.periodicChecks) ? [...existingEntry.periodicChecks] : [];
        if (periodicSlotKey && !periodicChecksArr.includes(periodicSlotKey)) {
          periodicChecksArr.push(periodicSlotKey);
        }

        // If target count reached via manual player bookings:
        if (updatedSecuredCourtNames.size >= targetCourtsCount) {
          console.log(`[advance-booking] Target courts count (${targetCourtsCount}) reached for schedule ${scheduleId} on ${targetDateMDY} with manual player bookings (${updatedSecuredCourtNames.size} secured).`);
          sched.advanceBookings[targetMatchDateKey] = {
            advanceBookedCourts: existingAdvanceCourts,
            prebookedCourts: existingPrebookedCourts,
            targetDateMDY,
            matchTime: sched.matchTime,
            targetCourtsCount,
            firstAttemptAt: existingEntry?.firstAttemptAt || nowMs,
            lastAttemptAt: nowMs,
            retryCount: existingEntry?.retryCount || 0,
            completed: true,
            bookedAt: existingEntry?.bookedAt || new Date().toISOString(),
            periodicChecks: periodicChecksArr,
            summarySent: Boolean(existingEntry?.summarySent)
          };
          const shouldSendSummary = !isPeriodicCheckDue;
          if (shouldSendSummary && !sched.advanceBookings[targetMatchDateKey].summarySent && typeof sendBookingNotifications === 'function') {
            sched.advanceBookings[targetMatchDateKey].summarySent = true;
            const summaryMsg = scvcc.buildBookingSummaryMessage({
              targetDateMDY,
              queryTime: sched.matchTime,
              sport: sched.sport || 'tennis',
              targetCourtsCount,
              advanceBookedCourts: existingAdvanceCourts,
              prebookedCourts: existingPrebookedCourts,
              isExhausted: false
            });
            await sendBookingNotifications(sock, sched.remoteJid, summaryMsg);
          }
          persistPolls(sched.remoteJid);
          continue;
        }

        // Step 2: Book remaining needed courts
        const triggerKey = `${scheduleId}:${targetMatchDateKey}`;
        if (inFlightAdvanceTriggers.has(triggerKey)) continue;
        inFlightAdvanceTriggers.add(triggerKey);

        const retryNum = (existingEntry?.retryCount || 0) + (existingEntry ? 1 : 0);
        const periodicLabel = isPeriodicCheckDue ? ` [periodic check ${periodicSlotKey}]` : (isInitialRetry ? ` (retry #${retryNum})` : ' (initial attempt)');
        console.log(`[advance-booking] Triggering advance court booking for schedule ${scheduleId} on ${targetDateMDY} (${DAY_NAMES[targetDayIndex]} ${sched.matchTime})${periodicLabel} in ${sched.remoteJid}`);

        try {
          const bookRes = await preBookCourtsForMatch({
            sock,
            remoteJid: sched.remoteJid,
            targetDateMDY,
            queryTime: sched.matchTime,
            court: sched.court || sched.targetCourt || null,
            targetCourt: sched.court || sched.targetCourt || null,
            size: sched.size,
            isAuto,
            preBookCourts: sched.preBookCourts,
            bookingPlayers: sched.bookingPlayers,
            creatorName: sched.creator?.name || 'Daily Poll',
            creatorJid: sched.creator?.jid || null,
            existingAdvanceBookedCourts: existingAdvanceCourts,
            existingPrebookedCourts: existingPrebookedCourts,
            isAdvanceBooking: true,
            minAvailableMinutes: 90,
            lookAround: sched.lookAround || groupCfg?.lookAround || null
          });

          const prevAdvanceCount = existingAdvanceCourts.length;
          const allAdvanceBooked = (bookRes && Array.isArray(bookRes.advanceBookedCourts)) ? bookRes.advanceBookedCourts : existingAdvanceCourts;
          const allPrebooked = (bookRes && Array.isArray(bookRes.prebookedCourts)) ? bookRes.prebookedCourts : existingPrebookedCourts;
          const newCourtsBookedByBot = allAdvanceBooked.length - prevAdvanceCount;

          const totalSecuredCourts = new Set([
            ...allAdvanceBooked.map((b) => b.court?.toLowerCase().trim()).filter(Boolean),
            ...allPrebooked.map((b) => b.court?.toLowerCase().trim()).filter(Boolean)
          ]);
          const isComplete = totalSecuredCourts.size >= targetCourtsCount;

          sched.advanceBookings[targetMatchDateKey] = {
            advanceBookedCourts: allAdvanceBooked,
            prebookedCourts: allPrebooked,
            targetDateMDY,
            matchTime: sched.matchTime,
            targetCourtsCount,
            firstAttemptAt: existingEntry?.firstAttemptAt || nowMs,
            lastAttemptAt: nowMs,
            retryCount: retryNum,
            completed: isComplete,
            bookedAt: existingEntry?.bookedAt || (allAdvanceBooked.length > 0 ? new Date().toISOString() : null),
            periodicChecks: periodicChecksArr,
            summarySent: Boolean(existingEntry?.summarySent)
          };
          persistPolls(sched.remoteJid);

          if (isComplete) {
            console.log(`[advance-booking] Successfully secured all ${totalSecuredCourts.size}/${targetCourtsCount} court(s) for schedule ${scheduleId} [Match: ${targetMatchDateKey}]:`, { advance: allAdvanceBooked, prebooked: allPrebooked });
            const shouldSendSummary = !isPeriodicCheckDue || newCourtsBookedByBot > 0;
            if (shouldSendSummary && !sched.advanceBookings[targetMatchDateKey].summarySent && typeof sendBookingNotifications === 'function') {
              sched.advanceBookings[targetMatchDateKey].summarySent = true;
              persistPolls(sched.remoteJid);
              const summaryMsg = scvcc.buildBookingSummaryMessage({
                targetDateMDY,
                queryTime: sched.matchTime,
                sport: sched.sport || 'tennis',
                targetCourtsCount,
                advanceBookedCourts: allAdvanceBooked,
                prebookedCourts: allPrebooked,
                isExhausted: false
              });
              await sendBookingNotifications(sock, sched.remoteJid, summaryMsg);
            }
          } else {
            console.warn(`[advance-booking] Schedule ${scheduleId} on ${targetMatchDateKey}: ${totalSecuredCourts.size}/${targetCourtsCount} court(s) secured so far. Will continue periodic checks (9:30am & 3:30pm) until poll is created.`);
          }

          if (activePolls && (allAdvanceBooked.length > 0 || allPrebooked.length > 0)) {
            for (const [pollId, pollState] of activePolls.entries()) {
              if (pollState.remoteJid === sched.remoteJid && (pollState.scheduleId === sched.id || pollState.when?.includes(DAY_NAMES[targetDayIndex]))) {
                pollState.advanceBookedCourts = allAdvanceBooked;
                pollState.prebookedCourts = allPrebooked;
                persistPolls(sched.remoteJid);
                console.log(`[advance-booking] Updated existing active poll ${pollId} with booked courts.`);
                break;
              }
            }
          }
        } catch (err) {
          console.error(`[advance-booking] Error during advance booking execution for schedule ${scheduleId}:`, err.message);
          if (!sched.advanceBookings[targetMatchDateKey]) {
            sched.advanceBookings[targetMatchDateKey] = {
              advanceBookedCourts: existingAdvanceCourts,
              prebookedCourts: existingPrebookedCourts,
              targetDateMDY,
              matchTime: sched.matchTime,
              targetCourtsCount,
              firstAttemptAt: existingEntry?.firstAttemptAt || nowMs,
              lastAttemptAt: nowMs,
              retryCount: retryNum,
              completed: false,
              bookedAt: existingEntry?.bookedAt || null,
              periodicChecks: periodicChecksArr,
              summarySent: false
            };
          } else {
            sched.advanceBookings[targetMatchDateKey].lastAttemptAt = nowMs;
            sched.advanceBookings[targetMatchDateKey].retryCount = retryNum;
            sched.advanceBookings[targetMatchDateKey].periodicChecks = periodicChecksArr;
          }
          persistPolls(sched.remoteJid);
        } finally {
          inFlightAdvanceTriggers.delete(triggerKey);
        }
      }
    }
  } catch (err) {
    console.error('⚠️ [advance-booking] Error in checkAndExecuteAdvanceBookings:', err);
  } finally {
    isAdvanceBookingSweepRunning = false;
  }
}

async function checkAndPostRecurringPolls({ sock, recurringPolls, persistPolls, createMatchPoll, getTargetGroupJid, customSanJoseParts = null, preBookCourtsForMatch = null, activePolls = null, sendBookingNotifications = null }) {
  if (preBookCourtsForMatch) {
    await checkAndExecuteAdvanceBookings({ sock, recurringPolls, persistPolls, preBookCourtsForMatch, activePolls, customSanJoseParts, sendBookingNotifications });
  }
  if (!sock || recurringPolls.size === 0) return;
  if (isPostingSweepRunning) {
    return;
  }
  isPostingSweepRunning = true;
  try {
    const sj = customSanJoseParts || pollTime.getSanJoseParts();
    const todayKey = `${sj.year}-${String(sj.month + 1).padStart(2, '0')}-${String(sj.day).padStart(2, '0')}`;
    const currentMinutes = sj.hour * 60 + sj.minute;

    const DAY_MAP = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const currentDayIndex = DAY_MAP[sj.weekday] !== undefined ? DAY_MAP[sj.weekday] : (new Date(sj.year, sj.month, sj.day).getDay());

    for (const [scheduleId, sched] of recurringPolls.entries()) {
      if (sched.endDate && todayKey > sched.endDate) {
        if (sched.enabled) {
          console.log(`[recurring-poll] Recurring schedule ${scheduleId} reached end date ${sched.endDate}; disabling schedule.`);
          sched.enabled = false;
          sched.ended = true;
          persistPolls();
        }
        continue;
      }
      if (sched.pausedUntil) {
        if (todayKey >= sched.pausedUntil) {
          console.log(`[recurring-poll] Auto-resuming recurring schedule ${scheduleId}: reached pause date ${sched.pausedUntil}`);
          sched.enabled = true;
          delete sched.pausedUntil;
          delete sched.pausedUntilDisplay;
          persistPolls();
        }
      }
      if (!sched.enabled) continue;

      const schedDays = (Array.isArray(sched.daysList) && sched.daysList.length > 0)
        ? [...new Set(sched.daysList)]
        : [...new Set(parseDaysOfWeek(sched.days).days)];

      const schedMatchMinutes = sched.matchHour * 60 + sched.matchMinute;

      for (const targetMatchDayIndex of schedDays) {
        const postConfig = getPostTimeForSchedule(sched, targetMatchDayIndex);
        const postDayIndex = postConfig.postDayIndex;
        const postHour = postConfig.hour !== undefined ? postConfig.hour : (postConfig.postHour !== undefined ? postConfig.postHour : 8);
        const postMinute = postConfig.minute !== undefined ? postConfig.minute : (postConfig.postMinute !== undefined ? postConfig.postMinute : 0);
        const daysBefore = postConfig.daysBefore !== undefined ? postConfig.daysBefore : 0;
        const postDisplay = postConfig.display || '';

        // Check if today is the scheduled posting day for this match day
        if (postDayIndex !== currentDayIndex) continue;

        const postMinutes = postHour * 60 + postMinute;
        if (currentMinutes < postMinutes) continue;

        // Compute exact target match date in San Jose
        const targetDateObj = new Date(Date.UTC(sj.year, sj.month, sj.day + daysBefore));
        const targetYear = targetDateObj.getUTCFullYear();
        const targetMonth = targetDateObj.getUTCMonth();
        const targetDay = targetDateObj.getUTCDate();
        const targetMatchDateKey = `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;

        if (sched.startDate && targetMatchDateKey < sched.startDate) continue;
        if (sched.endDate && targetMatchDateKey > sched.endDate) continue;

        const triggerKey = `${scheduleId}:${targetMatchDateKey}`;
        if (inFlightTriggers.has(triggerKey)) continue;

        if (!Array.isArray(sched.postedMatchDates)) {
          sched.postedMatchDates = [];
        }

        // Check if this specific match date has been explicitly skipped
        if (Array.isArray(sched.skippedMatchDates) && sched.skippedMatchDates.includes(targetMatchDateKey)) {
          console.log(`[recurring-poll] Skipping instance for schedule ${scheduleId} on ${targetMatchDateKey} as requested.`);
          continue;
        }

        if (sched.postedMatchDates.includes(targetMatchDateKey) || sched.lastPostedMatchDate === targetMatchDateKey) {
          continue;
        }

        if (!sched.postAttempts) sched.postAttempts = {};
        const attemptEntry = sched.postAttempts[targetMatchDateKey] || { count: 0, lastAttemptAt: 0, notified: false };
        const nowMs = Date.now();
        const MAX_POST_RETRIES = 2; // Initial attempt + 2 retries = 3 attempts total (retries on each 30s sweep)

        // If same-day posting and match time has already passed today
        if (daysBefore === 0 && currentMinutes >= schedMatchMinutes) {
          sched.postedMatchDates.push(targetMatchDateKey);
          sched.lastPostedMatchDate = targetMatchDateKey;
          sched.lastPostedDate = todayKey;
          delete sched.postAttempts[targetMatchDateKey];
          persistPolls();
          console.log(`[recurring-poll] Match time already passed today for schedule ${scheduleId} (${sched.matchTime}). Marking today as handled.`);
          continue;
        }

        inFlightTriggers.add(triggerKey);
        attemptEntry.count = (attemptEntry.count || 0) + 1;
        attemptEntry.lastAttemptAt = nowMs;
        sched.postAttempts[targetMatchDateKey] = attemptEntry;
        persistPolls();

        const targetChatId = sched.remoteJid.endsWith('@g.us') ? sched.remoteJid : (await getTargetGroupJid(sock) || sched.remoteJid);
        const creatorName = sched.creator?.name || 'Daily Poll';
        const creatorJid = sched.creator?.jid || null;
        const targetDayName = DAY_NAMES[targetMatchDayIndex];

        let whenStr;
        let dayWord;
        if (daysBefore === 0) {
          dayWord = 'today';
          whenStr = `Today ${sched.matchTime}`;
        } else {
          dayWord = targetDayName;
          whenStr = `${targetDayName} ${sched.matchTime}`;
        }

        const autoMatchups = sched.autoMatchups !== undefined ? sched.autoMatchups : !sched.noMatchups;
        const isCommand = !autoMatchups;
        const noMatchups = !autoMatchups;

        const retryLabel = attemptEntry.count > 1 ? ` (retry #${attemptEntry.count - 1}/${MAX_POST_RETRIES})` : '';
        console.log(`[recurring-poll] Triggering recurring match poll for schedule ${scheduleId}${retryLabel} (${whenStr} [Target: ${targetMatchDateKey}], ${sched.size || 'opt-in'} spots, postTime: ${postDisplay}, daysBefore: ${daysBefore}, autoMatchups: ${autoMatchups}) in ${targetChatId}`);

        try {
          const preExistingBookings = (sched.advanceBookings && sched.advanceBookings[targetMatchDateKey]) || null;
          const res = await createMatchPoll(
            sock,
            targetChatId,
            sched.size,
            whenStr,
            dayWord,
            sched.matchTime,
            creatorName,
            creatorJid,
            sched.includeCreator,
            null,
            false,
            isCommand,
            noMatchups,
            Boolean(sched.checkCourts),
            sched.includePrebookedSpots || sched['prebooked-spots'] || false,
            true,
            scheduleId,
            null,
            sched.courtBookingType || 'none',
            sched.bookingPlayers || null,
            sched.preBookCourts || null,
            sched.bookingStrategy || null,
            preExistingBookings,
            sched.lookAround || null
          );

          if (res?.err) {
            console.error(`[recurring-poll] Failed to create recurring poll ${scheduleId} (attempt ${attemptEntry.count}/${MAX_POST_RETRIES + 1}):`, res.err);
            if (attemptEntry.count > MAX_POST_RETRIES) {
              const failureMsg = res.message || res.err || `⚠️ Cannot create poll for *${whenStr}*: No live or prebooked courts are available at SCVCC (all courts are reserved or blocked).`;
              console.log(`[recurring-poll] Retries exhausted for schedule ${scheduleId} on ${targetMatchDateKey}. Sending one-time failure notification to ${targetChatId}`);
              if (sock && targetChatId && !attemptEntry.notified) {
                try {
                  messageHistory.recordMessage(targetChatId, 'tenbot', failureMsg, Date.now(), true);
                  await sock.sendMessage(targetChatId, { text: failureMsg });
                } catch (sendErr) {
                  console.error('[recurring-poll] Error sending poll failure notification:', sendErr.message);
                }
                attemptEntry.notified = true;
              }
              sched.postedMatchDates.push(targetMatchDateKey);
              if (sched.postedMatchDates.length > 30) sched.postedMatchDates.shift();
              sched.lastPostedMatchDate = targetMatchDateKey;
              sched.lastPostedDate = todayKey;
              persistPolls();
            } else {
              console.log(`[recurring-poll] Schedule ${scheduleId} on ${targetMatchDateKey} will retry on next sweep (attempt ${attemptEntry.count}/${MAX_POST_RETRIES + 1}).`);
              persistPolls();
            }
          } else {
            console.log(`[recurring-poll] Successfully posted recurring poll for schedule ${scheduleId} in ${targetChatId}`);
            delete sched.postAttempts[targetMatchDateKey];
            sched.postedMatchDates.push(targetMatchDateKey);
            if (sched.postedMatchDates.length > 30) sched.postedMatchDates.shift();
            sched.lastPostedMatchDate = targetMatchDateKey;
            sched.lastPostedDate = todayKey;
            if (preExistingBookings) {
              preExistingBookings.completed = true;
              preExistingBookings.pollCreated = true;
            }
            persistPolls();
          }
        } catch (pollErr) {
          console.error(`[recurring-poll] Exception creating recurring poll ${scheduleId} (attempt ${attemptEntry.count}/${MAX_POST_RETRIES + 1}):`, pollErr.message);
          if (attemptEntry.count > MAX_POST_RETRIES) {
            sched.postedMatchDates.push(targetMatchDateKey);
            if (sched.postedMatchDates.length > 30) sched.postedMatchDates.shift();
            sched.lastPostedMatchDate = targetMatchDateKey;
            sched.lastPostedDate = todayKey;
            persistPolls();
          } else {
            persistPolls();
          }
        } finally {
          inFlightTriggers.delete(triggerKey);
        }
      }
    }
  } catch (err) {
    console.error(`⚠️ [${new Date().toISOString()}] Error in checkAndPostRecurringPolls:`, err);
  } finally {
    isPostingSweepRunning = false;
  }
}

module.exports = {
  DAY_LOOKUP,
  parseDaysOfWeek,
  formatDaysResult,
  extractDaysFromText,
  parsePostTimes,
  getPostTimeForSchedule,
  extractCommonFlags,
  parseRecurringPollText,
  scheduleRecurringPoll,
  modifyRecurringPoll,
  listRecurringPolls,
  getRecurringPollStatus,
  cancelRecurringPoll,
  clearAllRecurringPolls,
  cancelAllRecurringPolls: clearAllRecurringPolls,
  pauseRecurringPoll,
  resumeRecurringPoll,
  getNextInstanceDate,
  skipRecurringPollInstance,
  unskipRecurringPollInstance,
  isPollCreatedForMatchDate,
  detectManualPlayerBookings,
  checkAndExecuteAdvanceBookings,
  checkAndPostRecurringPolls,
  formatRecurringScheduleCard,
  parseDateToDateKey,
  extractPauseArgs,
  extractSkipArgs,
  getUpcomingInstanceDates
};
