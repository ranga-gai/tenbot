/**
 * Resolves a loosely-parsed day/time phrase (from extractPollDetails or Claude tools) into
 * an absolute Date -- used to know when a poll's scheduled play time is and when it has
 * passed, for expiry/cleanup purposes.
 *
 * Assumptions (San Jose, California / Pacific Time):
 *   - Both day and time given & in the past -> returns the past date (caller can reject).
 *   - No day given & time is in the past -> assumed to mean "tomorrow" at that time.
 *   - No day given & time is in the future -> assumed to mean "today".
 *   - No time given -> assumed to mean end of that day (23:59).
 *   - A weekday name means the next occurrence of that weekday on/after
 *     today (so saying "Saturday" on a Saturday means today).
 *   - Times need am/pm (e.g. 9am, 6:30pm).
 */

const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

/**
 * Returns current Date in San Jose, CA (Pacific Time: America/Los_Angeles).
 */
function getSanJoseNow(now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23'
    }).formatToParts(now);

    const map = {};
    for (const p of parts) map[p.type] = parseInt(p.value, 10);
    return new Date(map.year, map.month - 1, map.day, map.hour, map.minute, map.second);
  } catch (err) {
    return new Date(now);
  }
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
  const sjNow = getSanJoseNow(now);
  const target = new Date(sjNow);
  target.setSeconds(0, 0);

  let hasExplicitDay = false;
  if (dayWord) {
    const norm = normalizeDayWord(dayWord);
    if (norm === 'tomorrow') {
      target.setDate(target.getDate() + 1);
      hasExplicitDay = true;
    } else if (typeof norm === 'number') {
      const currentDow = target.getDay();
      let diff = norm - currentDow;
      if (diff < 0) diff += 7;
      target.setDate(target.getDate() + diff);
      hasExplicitDay = true;
    } else if (norm === 'today') {
      hasExplicitDay = true;
    }
  }

  let hour = 23;
  let minute = 59;
  let hasTime = false;
  if (timeWord) {
    const m = timeWord.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
    if (m) {
      hasTime = true;
      hour = parseInt(m[1], 10) % 12;
      minute = m[2] ? parseInt(m[2], 10) : 0;
      if (/pm/i.test(m[3])) hour += 12;
    }
  }

  target.setHours(hour, minute, 0, 0);

  // If only a time was specified (no day specified) and that time is already in the past today,
  // roll over to the next day (tomorrow) at that time.
  if (!hasExplicitDay && hasTime && target.getTime() <= sjNow.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  return target;
}

module.exports = {
  resolvePlayDateTime,
  getSanJoseNow,
  normalizeDayWord
};
