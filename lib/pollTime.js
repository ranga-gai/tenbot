/**
 * Resolves a loosely-parsed day/time phrase (from extractPollDetails) into
 * an absolute Date -- used to know when a poll's scheduled play time has
 * passed, for expiry/cleanup purposes.
 *
 * Assumptions (documented since this is a heuristic, not a full date
 * parser):
 *   - No day given -> assumed to mean "today".
 *   - No time given -> assumed to mean end of that day (23:59), since we'd
 *     rather expire a poll too late than delete it while still relevant.
 *   - A weekday name means the next occurrence of that weekday on/after
 *     today (so saying "Saturday" on a Saturday means today).
 *   - Times need am/pm (matches what extractPollDetails' TIME_REGEX accepts).
 */

const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function normalizeDayWord(word) {
  const w = word.toLowerCase();
  if (w === 'today' || w === 'tonight') return 'today';
  if (w === 'tomorrow') return 'tomorrow';
  const key = w.slice(0, 3);
  return key in DAY_INDEX ? DAY_INDEX[key] : null;
}

function resolvePlayDateTime(dayWord, timeWord, now = new Date()) {
  const target = new Date(now);
  target.setSeconds(0, 0);

  if (dayWord) {
    const norm = normalizeDayWord(dayWord);
    if (norm === 'tomorrow') {
      target.setDate(target.getDate() + 1);
    } else if (typeof norm === 'number') {
      const currentDow = target.getDay();
      let diff = norm - currentDow;
      if (diff < 0) diff += 7;
      target.setDate(target.getDate() + diff);
    }
    // norm === 'today' (or unrecognized) -> leave date as-is
  }

  let hour = 23;
  let minute = 59;
  if (timeWord) {
    const m = timeWord.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
    if (m) {
      hour = parseInt(m[1], 10) % 12;
      minute = m[2] ? parseInt(m[2], 10) : 0;
      if (/pm/i.test(m[3])) hour += 12;
    }
  }

  target.setHours(hour, minute, 0, 0);
  return target;
}

module.exports = { resolvePlayDateTime };
