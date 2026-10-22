/**
 * Resolves a loosely-parsed day/time phrase (from extractPollDetails or Claude tools) into
 * an absolute Date in San Jose, California (Pacific Time: America/Los_Angeles).
 * Completely timezone-independent so it works consistently regardless of whether the host system
 * is running in UTC, PST, EST, etc.
 */

const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const WORD_TO_NUMBER = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fourteen: 14,
  sixteen: 16
};

const NUMBER_WORDS_PATTERN = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fourteen|sixteen';

/**
 * Extracts wall-clock date/time components in America/Los_Angeles for a given Date.
 */
function getSanJoseParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    weekday: 'short',
    hourCycle: 'h23'
  });

  const parts = formatter.formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;

  const year = parseInt(map.year, 10);
  const month = parseInt(map.month, 10) - 1; // 0-indexed
  const day = parseInt(map.day, 10);
  const hour = parseInt(map.hour, 10);
  const minute = parseInt(map.minute, 10);
  const second = parseInt(map.second, 10);
  const weekday = map.weekday ? map.weekday.toLowerCase() : null;

  return { year, month, day, hour, minute, second, weekday };
}

/**
 * Returns current Date in San Jose, CA (Pacific Time).
 */
function getSanJoseNow(now = new Date()) {
  const parts = getSanJoseParts(now);
  return createSanJoseDate(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second);
}

/**
 * Creates an exact absolute Date object representing the given wall-clock time
 * in San Jose, CA (America/Los_Angeles), handling Daylight Saving Time (PDT vs PST) properly.
 */
function createSanJoseDate(year, monthIndex, day, hour, minute, second = 0) {
  const pad = (n) => String(n).padStart(2, '0');
  const month = pad(monthIndex + 1);
  const d = pad(day);
  const h = pad(hour);
  const m = pad(minute);
  const s = pad(second);

  const isoGuess = `${year}-${month}-${d}T${h}:${m}:${s}Z`;
  const tempDate = new Date(isoGuess);

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'shortOffset',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23'
  });

  const parts = formatter.formatToParts(tempDate);
  const tzPart = parts.find((p) => p.type === 'timeZoneName');
  const offsetMatch = tzPart?.value.match(/GMT([+-]\d+)(?::(\d+))?/);

  let offsetMinutes = -7 * 60; // default to PDT (-7)
  if (offsetMatch) {
    const hours = parseInt(offsetMatch[1], 10);
    const mins = offsetMatch[2] ? parseInt(offsetMatch[2], 10) : 0;
    offsetMinutes = hours * 60 + (hours < 0 ? -mins : mins);
  }

  const utcMs = Date.UTC(year, monthIndex, day, hour, minute, second) - (offsetMinutes * 60 * 1000);
  return new Date(utcMs);
}

function normalizeDayWord(word) {
  if (!word || typeof word !== 'string') return null;
  const w = word.toLowerCase().trim();
  if (w === 'today' || w === 'tonight' || /\b(?:today|tonight)\b/.test(w)) return 'today';
  if (w === 'tomorrow' || /\btomorrow\b/.test(w)) return 'tomorrow';

  // Check for day of the week keyword anywhere in the word/phrase
  const m = w.match(/\b(sun(?:days?)?|mon(?:days?)?|tue(?:s(?:days?)?)?|wed(?:nesdays?)?|thu(?:r(?:s(?:days?)?)?)?|fri(?:days?)?|sat(?:urdays?)?)\b/);
  if (m) {
    const key = m[1].slice(0, 3);
    if (key in DAY_INDEX) return DAY_INDEX[key];
  }

  const key = w.slice(0, 3);
  return key in DAY_INDEX ? DAY_INDEX[key] : null;
}

/**
 * Parses a time string (e.g. "7pm", "7:30pm", "19:00", "8am", "8:30 AM") into hour, minute, and display strings.
 */
function parseTimeString(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const m = timeStr.trim().match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let rawHour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  let hour = rawHour;
  const ampm = m[3] ? m[3].toLowerCase() : null;

  if (ampm) {
    hour = rawHour % 12;
    if (ampm === 'pm') hour += 12;
  } else {
    if (hour >= 1 && hour <= 6) hour += 12;
  }

  const period = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  const displayMinute = minute > 0 ? `:${String(minute).padStart(2, '0')}` : '';
  const formatted = `${displayHour}${displayMinute}${period.toLowerCase()}` ;

  return { hour, minute, formatted, display: `${displayHour}${displayMinute} ${period}` };
}

function resolvePlayDateTime(dayWord, timeWord, now = new Date()) {
  const nowParts = getSanJoseParts(now);

  let targetYear = nowParts.year;
  let targetMonth = nowParts.month;
  let targetDay = nowParts.day;

  let hasExplicitDay = false;
  if (dayWord) {
    const norm = normalizeDayWord(dayWord);
    if (norm === 'tomorrow') {
      const temp = new Date(Date.UTC(targetYear, targetMonth, targetDay + 1));
      targetYear = temp.getUTCFullYear();
      targetMonth = temp.getUTCMonth();
      targetDay = temp.getUTCDate();
      hasExplicitDay = true;
    } else if (typeof norm === 'number') {
      const currentDow = DAY_INDEX[nowParts.weekday] !== undefined ? DAY_INDEX[nowParts.weekday] : (new Date(now).getDay());
      let diff = norm - currentDow;
      if (diff < 0) diff += 7;
      const temp = new Date(Date.UTC(targetYear, targetMonth, targetDay + diff));
      targetYear = temp.getUTCFullYear();
      targetMonth = temp.getUTCMonth();
      targetDay = temp.getUTCDate();
      hasExplicitDay = true;
    } else if (norm === 'today') {
      hasExplicitDay = true;
    }
  }

  let hour = 23;
  let minute = 59;
  let hasTime = false;
  let hasAmPm = false;

  if (timeWord) {
    const rawTime = String(timeWord).trim();
    const m = rawTime.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\b/i);
    if (m) {
      hasTime = true;
      hour = parseInt(m[1], 10) % 12;
      minute = m[2] ? parseInt(m[2], 10) : 0;
      const ampm = m[3] ? m[3].toLowerCase() : (rawTime.match(/\b(am|pm)\b/i)?.[1]?.toLowerCase() || null);
      if (ampm) {
        hasAmPm = true;
        if (ampm === "pm") hour += 12;
      } else {
        if (hour >= 1 && hour <= 6) hour += 12;
      }
    }
  }

  let targetDate = createSanJoseDate(targetYear, targetMonth, targetDay, hour, minute, 0);

  // If no explicit AM/PM was given, and the target is in the past today,
  // but the PM version (hour + 12) is upcoming today, resolve to today evening!
  if (hasTime && !hasAmPm && hour < 12 && targetDate.getTime() <= now.getTime()) {
    const pmDate = createSanJoseDate(targetYear, targetMonth, targetDay, hour + 12, minute, 0);
    if (pmDate.getTime() > now.getTime()) {
      targetDate = pmDate;
    }
  }

  // If no day was specified and the time has already passed today, roll over to tomorrow!
  if (!hasExplicitDay && hasTime && targetDate.getTime() <= now.getTime()) {
    const temp = new Date(Date.UTC(targetYear, targetMonth, targetDay + 1));
    targetDate = createSanJoseDate(temp.getUTCFullYear(), temp.getUTCMonth(), temp.getUTCDate(), hour, minute, 0);
  }

  return targetDate;
}

/**
 * Parses look-around period/window string or number into total minutes.
 * Supports: "1 hour", "1h", "1.5 hours", "60m", "30 mins", 60, "half an hour", "one hour", etc.
 */
function parseLookAround(val) {
  if (val === undefined || val === null) return null;
  if (typeof val === 'number') {
    return val > 0 ? val : null;
  }
  const str = String(val).trim().toLowerCase();
  if (!str || str === 'none' || str === '0' || str === 'false') return null;

  const hrMatch = str.match(/^(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/) ||
    str.match(/\b(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/) ||
    (str.match(/\b(one|two|three|four)\s+hours?\b/) ? [null, WORD_TO_NUMBER[str.match(/\b(one|two|three|four)\s+hours?\b/)[1]]] : null) ||
    (str.match(/\bhalf\s+(?:an?\s+)?hour\b/) ? [null, '0.5'] : null);

  if (hrMatch) {
    const hours = parseFloat(hrMatch[1]);
    return Math.round(hours * 60);
  }

  const minMatch = str.match(/^(\d+)\s*(?:minutes?|mins?|m)\b/) || str.match(/\b(\d+)\s*(?:minutes?|mins?|m)\b/);
  if (minMatch) {
    return parseInt(minMatch[1], 10);
  }

  if (/^\d+$/.test(str)) {
    return parseInt(str, 10);
  }

  return null;
}

/**
 * Formats look-around minutes into a human-readable display string (e.g. "1 hour", "30 mins", "1.5 hours").
 */
function formatLookAround(mins) {
  const num = parseInt(mins, 10);
  if (!Number.isFinite(num) || num <= 0) return null;
  if (num % 60 === 0) {
    const hrs = num / 60;
    return hrs + ' hour' + (hrs === 1 ? '' : 's');
  }
  if (num === 30) return '30 mins';
  if (num === 90) return '1.5 hours';
  return num + ' mins';
}

/**
 * Generates an array of start time strings beginning at timeStr and stepping
 * forward in 30-minute intervals across the lookAround period.
 * For example: '6:30pm' with 60 mins look around -> ['6:30pm', '7pm', '7:30pm'].
 */
function getCandidateTimes(timeStr, lookAroundMinutes = 0) {
  if (!timeStr) return [];
  const parsed = parseTimeString(timeStr);
  if (!parsed) return [timeStr];

  const candidateTimes = [parsed.formatted];
  const lookAround = parseLookAround(lookAroundMinutes) || 0;
  if (lookAround <= 0) {
    return candidateTimes;
  }

  const baseMinutes = parsed.hour * 60 + parsed.minute;
  for (let offset = 30; offset <= lookAround; offset += 30) {
    const totalMins = (baseMinutes + offset) % (24 * 60);
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    const period = h >= 12 ? 'pm' : 'am';
    const displayH = h % 12 === 0 ? 12 : h % 12;
    const displayM = m > 0 ? (':' + String(m).padStart(2, '0')) : '';
    const formatted = displayH + displayM + period;
    if (!candidateTimes.includes(formatted)) {
      candidateTimes.push(formatted);
    }
  }

  return candidateTimes;
}

module.exports = {
  resolvePlayDateTime,
  getSanJoseNow,
  getSanJoseParts,
  createSanJoseDate,
  normalizeDayWord,
  parseTimeString,
  parseLookAround,
  formatLookAround,
  getCandidateTimes,
  WORD_TO_NUMBER,
  NUMBER_WORDS_PATTERN
};
