/**
 * Recurring Polls module: manages creation, listing, cancellation, pausing,
 * modification, and automatic posting of recurring tennis match polls (daily or on specific days of the week).
 * Supports day-of-week configurable poll creation times and posting more than 24 hours in advance
 * (e.g., play at 7pm on Monday with poll created at Sunday 6pm or 2 days before).
 */

const pollTime = require('./pollTime');
const { parseTimeString, getSanJoseParts } = pollTime;


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
  const matchMinutes = (sched.matchHour || 19) * 60 + (sched.matchMinute || 0);
  const postMinutes = (sched.postHour || 8) * 60 + (sched.postMinute || 0);
  const daysBefore = postMinutes >= matchMinutes ? 1 : 0;
  const postDayIndex = (matchDayIndex - daysBefore + 7) % 7;
  return {
    formatted: sched.postTime || '8am',
    display: sched.postDisplay || sched.postTime || '8 AM',
    hour: sched.postHour || 8,
    minute: sched.postMinute || 0,
    postHour: sched.postHour || 8,
    postMinute: sched.postMinute || 0,
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

  const pauseMatch = text.match(/^!(?:pauserecurringpoll|stoprecurringpoll)\s*(?:poll\s+)?(?:[`'"])?([^\s`'"]+)?(?:[`'"])?\s*$/i) ||
    text.match(/^!(?:recurringpoll|dailypoll|schedulepoll)\s+(?:pause|stop)\s*(?:poll\s+)?(?:[`'"])?([^\s`'"]+)?(?:[`'"])?\s*$/i) ||
    text.match(/\b(?:pause|stop)\s+(?:daily|recurring|scheduled)\s+poll\s+(?:[`'"])?([^\s`'"]+)(?:[`'"])?\b/i);
  if (pauseMatch) {
    return { action: 'pause', scheduleId: pauseMatch[1]?.trim() || null };
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

    const isExplicitOptIn = /\b(?:opt-?in|yes\s*\/\s*no|yesno|open)\b/i.test(rest);
    const daysString = extractDaysFromText(rest);

    let postTime = null;
    let postTimesByDay = null;

    // Check for day-of-week / advance post time phrase
    const postPhraseMatch = rest.match(/\b(?:post(?:ed)?|posting|at)\s+((?:(?:\d+\s*days?\s*before(?:\s+at\s+(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2}))?|\d+(?:\.\d+)?\s*hours?\s*(?:before|prior|in\s+advance)?|(?:the\s+)?(?:day|evening|night)\s*before|previous\s*day|(?:sun[a-z]*|mon[a-z]*|tue[a-z]*|wed[a-z]*|thu[a-z]*|fri[a-z]*|sat[a-z]*|weekdays?|weekends?|everyday)\s*(?:at\s+)?(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})|(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})\s*(?:on|for)?\s*(?:sun[a-z]*|mon[a-z]*|tue[a-z]*|wed[a-z]*|thu[a-z]*|fri[a-z]*|sat[a-z]*|weekdays?|weekends?|everyday)|(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2}))[\s,;&and]*)+)/i);
    let restForTimes = rest;
    if (postPhraseMatch) {
      postTime = postPhraseMatch[1].trim();
      restForTimes = rest.replace(postPhraseMatch[0], ' ');
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

    let size = null;
    if (!isExplicitOptIn) {
      const sizeExplicit = textCleaned.match(/\b(?:for|size|spots?|players?)\s*[:=]?\s*([1-9]|1[0-6])\b/i) ||
        textCleaned.match(/\b([1-9]|1[0-6])\s*(?:spots?|players?|people|courts?)\b/i) ||
        textCleaned.match(/\b([1-9]|1[0-6])\b/);
      if (sizeExplicit) {
        size = parseInt(sizeExplicit[1], 10);
      } else if (/\bsingles\b/i.test(textCleaned)) {
        size = 2;
      } else if (/\bdoubles\b/i.test(textCleaned)) {
        size = 4;
      }
    }

    let autoMatchups = undefined;
    let noMatchups = undefined;
    if (/(?:^|\s)(?:--no-?matchups?|--no-?draw)\b|\b(?:no[-_\s]*matchups?|no[-_\s]*draw|without\s+(?:auto[-_\s]*|automatic\s+)?matchups?|without\s+(?:auto[-_\s]*|automatic\s+)?draw|(?:do\s*not|don\x27?t)\s+(?:create|make|generate|post|auto-?generate)\s+(?:matchups?|draw|the\s+draw|the\s+matchups?)|no[-_\s]*(?:auto\s+|automatic\s+)?matchups?)\b/i.test(rest)) {
      autoMatchups = false;
      noMatchups = true;
    } else if (/\b(?:auto-?matchups?|auto-?draw|with\s+matchups?|enable\s+matchups?)\b/i.test(rest)) {
      autoMatchups = true;
      noMatchups = false;
    }

    let includeCreator = undefined;
    if (/\b(?:include\s+me|with\s+me|count\s+me\s+in|i'm\s+playing|im\s+playing)\b/i.test(rest)) {
      includeCreator = true;
    } else if (/\b(?:exclude\s+me|without\s+me|not\s+playing)\b/i.test(rest)) {
      includeCreator = false;
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
        autoMatchups,
        noMatchups,
        includeCreator
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
  let textForTimes = jsonExtraction.remainingText;

  let postPhraseMatch = null;
  if (!postTimesByDay) {
    postPhraseMatch = text.match(/\b(?:post(?:ed)?|posting|at)\s+((?:(?:\d+\s*days?\s*before(?:\s+at\s+(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2}))?|\d+(?:\.\d+)?\s*hours?\s*(?:before|prior|in\s+advance)?|(?:the\s+)?(?:day|evening|night)\s*before|previous\s*day|(?:sun[a-z]*|mon[a-z]*|tue[a-z]*|wed[a-z]*|thu[a-z]*|fri[a-z]*|sat[a-z]*|weekdays?|weekends?|everyday)\s*(?:at\s+)?(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})|(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2})\s*(?:on|for)?\s*(?:sun[a-z]*|mon[a-z]*|tue[a-z]*|wed[a-z]*|thu[a-z]*|fri[a-z]*|sat[a-z]*|weekdays?|weekends?|everyday)|(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2}))[\s,;&and]*)+)/i);
    if (postPhraseMatch) {
      postTime = postPhraseMatch[1].trim();
      textForTimes = text.replace(postPhraseMatch[0], ' ');
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

  let size = null;
  if (!isExplicitOptIn) {
    if (/\bauto\b/i.test(textCleaned) || /\bauto[-_\s]*(?:spots?|players?|courts?|size)\b/i.test(textCleaned)) {
      size = 'auto';
    } else {
      const sizeExplicit = textCleaned.match(/\b(?:for|size|spots?|players?)\s*[:=]?\s*([1-9]|1[0-6])\b/i) ||
        textCleaned.match(/^!(?:recurringpoll|dailypoll|schedulepoll)\s+([1-9]|1[0-6])\b/i) ||
        textCleaned.match(/\b([1-9]|1[0-6])\s*(?:spots?|players?|people|courts?)\b/i) ||
        textCleaned.match(/\bpoll\s+for\s+([1-9]|1[0-6])\b/i);
      if (sizeExplicit) {
        size = parseInt(sizeExplicit[1], 10);
      } else if (/\bsingles\b/i.test(textCleaned)) {
        size = 2;
      } else if (/\bdoubles\b/i.test(textCleaned)) {
        size = 4;
      }
    }
  }

  let includeCreator = false;
  if (/\b(?:include\s+me|with\s+me|count\s+me\s+in|i'm\s+playing|im\s+playing)\b/i.test(text)) {
    includeCreator = true;
  }

  // 7. Check if auto-matchup creation should be disabled
  const noMatchups = /(?:^|\s)(?:--no-?matchups?|--no-?draw)\b|\b(?:no[-_\s]*matchups?|no[-_\s]*draw|without\s+(?:auto[-_\s]*|automatic\s+)?matchups?|without\s+(?:auto[-_\s]*|automatic\s+)?draw|(?:do\s*not|don\x27?t)\s+(?:create|make|generate|post|auto-?generate)\s+(?:matchups?|draw|the\s+draw|the\s+matchups?)|no[-_\s]*(?:auto\s+|automatic\s+)?matchups?)\b/i.test(text);

  // 8. Check if court availability should be excluded from poll title
  const noCourts = /(?:^|\s)(?:--no-?courts?|--no-?court-?avail(?:ability)?|--no-?avail(?:ability)?)\b|\b(?:no[-_\s]*courts?|without[-_\s]*courts?|without[-_\s]*(?:court\s+)?availability|no[-_\s]*(?:court\s+)?availability|exclude[-_\s]*courts?|hide[-_\s]*courts?|dont\s+include\s+(?:the\s+)?court(?:s|\s+availability)?|do\s*not\s+include\s+(?:the\s+)?court(?:s|\s+availability)?)\b/i.test(text);

  return {
    action: 'create',
    size,
    matchTime,
    postTime,
    postTimesByDay,
    days: parsedDays.raw,
    daysList: parsedDays.days,
    daysDisplay: parsedDays.display,
    includeCreator,
    autoMatchups: !noMatchups,
    noMatchups,
    noCourts
  };
}

/**
 * Creates and registers a new recurring poll schedule.
 */
async function scheduleRecurringPoll({ recurringPolls, persistPolls, targetChatId, sender, senderJid, params }) {
  const { size, matchTime, postTime, postTimesByDay, days, includeCreator, autoMatchups, noMatchups, noCourts } = params || {};
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
    noCourts: Boolean(noCourts),
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

  return `📅 *Scheduled Recurring Poll (ID: \`${scheduleId}\`):*\n` +
    `• *Match Time:* ${parsedMatch.display}\n` +
    `• *Days:* ${parsedDays.display}\n` +
    `• *Post Time:* ${parsedPostTimes.display} in this group\n` +
    `• *Format:* ${spotDesc}${creatorDesc}\n` +
    `• *Matchups:* ${matchupDesc}\n` +
    `• *Status:* Active\n\n` +
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

  // Update noCourts if provided
  if (updates.noCourts !== undefined || updates.includeCourts !== undefined) {
    const newNoCourts = updates.noCourts !== undefined ? Boolean(updates.noCourts) : !Boolean(updates.includeCourts);
    if (sched.noCourts !== newNoCourts) {
      sched.noCourts = newNoCourts;
      changes.push(`Court availability in title: *${newNoCourts ? 'Disabled' : 'Enabled'}*`);
    }
  }

  if (changes.length === 0) {
    const spotDesc = sched.size ? `${sched.size} spots (${sched.size === 2 ? 'Singles' : 'Doubles'})` : 'Opt-in (Yes/No)';
    return `ℹ️ Schedule \`${targetKey}\` is already configured with those settings (no changes needed):\n` +
      `• *Match Time:* ${sched.matchDisplay}\n` +
      `• *Days:* ${sched.daysDisplay}\n` +
      `• *Post Time:* ${sched.postDisplay}\n` +
      `• *Format:* ${spotDesc}\n` +
      `• *Status:* ${sched.enabled ? 'Active' : 'Paused'}`;
  }

  sched.updatedAt = new Date().toISOString();
  persistPolls();

  const spotDesc = sched.size ? `${sched.size} spots (${sched.size === 2 ? 'Singles' : 'Doubles'})` : 'Opt-in (Yes/No)';
  const matchupDesc = sched.autoMatchups ? (sched.size ? 'Auto-generated when poll fills' : 'Manual on request (!matchups)') : 'Manual only (use !matchups)';

  console.log(`[recurring-poll] Modified recurring poll schedule ${targetKey} by ${sender}: ${changes.join(', ')}`);

  return `✏️ *Updated Recurring Poll Schedule (ID: \`${targetKey}\`):*\n` +
    changes.map(c => `• ${c}`).join('\n') +
    `\n\n📋 *Current Configuration:*\n` +
    `• *Match Time:* ${sched.matchDisplay}\n` +
    `• *Days:* ${sched.daysDisplay}\n` +
    `• *Post Time:* ${sched.postDisplay}\n` +
    `• *Format:* ${spotDesc}\n` +
    `• *Matchups:* ${matchupDesc}\n` +
    `• *Status:* ${sched.enabled ? 'Active' : 'Paused'}`;
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

  const lines = list.map((s, i) => {
    const spotDesc = s.size ? (s.size === 'auto' ? 'Auto spots (4/8/12)' : `${s.size} spots`) : 'Opt-in (Yes/No)';
    const statusStr = s.enabled ? '🟢 Active' : '⏸️ Paused';
    const lastPostedStr = s.lastPostedMatchDate
      ? ` (last posted for match: ${s.lastPostedMatchDate})`
      : (s.lastPostedDate ? ` (last posted: ${s.lastPostedDate})` : ' (not posted yet)');
    const matchupNote = s.noMatchups || s.autoMatchups === false ? ' (no auto-matchups)' : '';
    const daysStr = s.daysDisplay || (parseDaysOfWeek(s.days || s.daysList).display);
    const postTimeStr = s.postDisplay;
    return `${i + 1}. *ID: \`${s.id}\`* — ${spotDesc} for *${s.matchDisplay}* (${daysStr})${matchupNote}\n` +
      `   • Days: ${daysStr}\n` +
      `   • Posts: ${postTimeStr}\n` +
      `   • Status: ${statusStr}${lastPostedStr}\n` +
      `   • Created by: ${s.creator?.name || 'Player'}`;
  });

  return `📅 *Scheduled Recurring Polls:*\n\n${lines.join('\n\n')}\n\n_Manage with !modifyrecurringpoll <id> ..., !cancelrecurringpoll <id> (or !clearallrecurringpolls)_`;
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
 * Pauses a recurring poll schedule.
 */
async function pauseRecurringPoll({ recurringPolls, persistPolls, scheduleId }) {
  const cleanId = String(scheduleId || '').trim();
  if (!cleanId) {
    return 'Please provide the schedule ID to pause. Use "!recurringpolls" to view active IDs.';
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
    return `Schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view active IDs.`;
  }
  const sched = recurringPolls.get(targetKey);
  sched.enabled = false;
  persistPolls();
  return `⏸️ Paused recurring poll schedule \`${targetKey}\` (${sched.matchDisplay}). Use "!resumerecurringpoll ${targetKey}" to re-enable.`;
}

/**
 * Resumes a recurring poll schedule.
 */
async function resumeRecurringPoll({ recurringPolls, persistPolls, scheduleId }) {
  const cleanId = String(scheduleId || '').trim();
  if (!cleanId) {
    return 'Please provide the schedule ID to resume. Use "!recurringpolls" to view active IDs.';
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
    return `Schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view active IDs.`;
  }
  const sched = recurringPolls.get(targetKey);
  sched.enabled = true;
  persistPolls();
  return `▶️ Resumed recurring poll schedule \`${targetKey}\` (${sched.matchDisplay}). It will post at ${sched.postDisplay} on ${sched.daysDisplay || 'scheduled days'}.`;
}

/**
 * Sweeps all recurring poll schedules and automatically creates and posts polls whose post time has arrived on scheduled posting days.
 * Fully supports posting same day, 1 day before (e.g. Sunday 6pm for Monday 7pm), or more than 24 hours in advance (e.g. 2+ days before).
 */
async function checkAndPostRecurringPolls({ sock, recurringPolls, persistPolls, createMatchPoll, getTargetGroupJid, customSanJoseParts = null }) {
  if (!sock || recurringPolls.size === 0) return;
  try {
    const sj = customSanJoseParts || pollTime.getSanJoseParts();
    const todayKey = `${sj.year}-${String(sj.month + 1).padStart(2, '0')}-${String(sj.day).padStart(2, '0')}`;
    const currentMinutes = sj.hour * 60 + sj.minute;

    const DAY_MAP = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const currentDayIndex = DAY_MAP[sj.weekday] !== undefined ? DAY_MAP[sj.weekday] : (new Date(sj.year, sj.month, sj.day).getDay());

    for (const [scheduleId, sched] of recurringPolls.entries()) {
      if (!sched.enabled) continue;

      const schedDays = (Array.isArray(sched.daysList) && sched.daysList.length > 0)
        ? sched.daysList
        : parseDaysOfWeek(sched.days).days;

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

        if (!Array.isArray(sched.postedMatchDates)) {
          sched.postedMatchDates = [];
        }

        if (sched.postedMatchDates.includes(targetMatchDateKey) || sched.lastPostedMatchDate === targetMatchDateKey) {
          continue;
        }

        // If same-day posting and match time has already passed today
        if (daysBefore === 0 && currentMinutes >= schedMatchMinutes) {
          sched.postedMatchDates.push(targetMatchDateKey);
          sched.lastPostedMatchDate = targetMatchDateKey;
          sched.lastPostedDate = todayKey;
          persistPolls();
          console.log(`[recurring-poll] Match time already passed today for schedule ${scheduleId} (${sched.matchTime}). Marking today as handled.`);
          continue;
        }

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

        console.log(`[recurring-poll] Triggering recurring match poll for schedule ${scheduleId} (${whenStr} [Target: ${targetMatchDateKey}], ${sched.size || 'opt-in'} spots, postTime: ${postDisplay}, daysBefore: ${daysBefore}, autoMatchups: ${autoMatchups}) in ${targetChatId}`);

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
          sched.noCourts || false
        );

        sched.postedMatchDates.push(targetMatchDateKey);
        if (sched.postedMatchDates.length > 30) sched.postedMatchDates.shift();
        sched.lastPostedMatchDate = targetMatchDateKey;
        sched.lastPostedDate = todayKey;
        persistPolls();

        if (res?.err) {
          console.error(`[recurring-poll] Failed to create recurring poll ${scheduleId}:`, res.err);
        } else {
          console.log(`[recurring-poll] Successfully posted recurring poll for schedule ${scheduleId} in ${targetChatId}`);
        }
      }
    }
  } catch (err) {
    console.error(`⚠️ [${new Date().toISOString()}] Error in checkAndPostRecurringPolls:`, err);
  }
}

module.exports = {
  parseDaysOfWeek,
  formatDaysResult,
  extractDaysFromText,
  parsePostTimes,
  getPostTimeForSchedule,
  parseRecurringPollText,
  scheduleRecurringPoll,
  modifyRecurringPoll,
  listRecurringPolls,
  cancelRecurringPoll,
  clearAllRecurringPolls,
  cancelAllRecurringPolls: clearAllRecurringPolls,
  pauseRecurringPoll,
  resumeRecurringPoll,
  checkAndPostRecurringPolls
};
