/**
 * Resolves a loosely-parsed day/time phrase (from extractPollDetails or Claude tools) into
 * an absolute Date in San Jose, California (Pacific Time: America/Los_Angeles).
 * Completely timezone-independent so it works consistently regardless of whether the host system
 * is running in UTC, PST, EST, etc.
 */

const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

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
  if (!word) return null;
  const w = word.toLowerCase();
  if (w === 'today' || w === 'tonight') return 'today';
  if (w === 'tomorrow') return 'tomorrow';
  const key = w.slice(0, 3);
  return key in DAY_INDEX ? DAY_INDEX[key] : null;
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
    const m = String(timeWord).trim().match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?$/i);
    if (m) {
      hasTime = true;
      hour = parseInt(m[1], 10) % 12;
      minute = m[2] ? parseInt(m[2], 10) : 0;
      if (m[3]) {
        hasAmPm = true;
        if (/pm/i.test(m[3])) hour += 12;
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

module.exports = {
  resolvePlayDateTime,
  getSanJoseNow,
  getSanJoseParts,
  createSanJoseDate,
  normalizeDayWord
};
