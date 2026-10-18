const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDaysOfWeek,
  extractCommonFlags,
  extractSkipArgs,
  extractPauseArgs,
  parseRecurringPollText
} = require('../lib/recurringPolls');

describe('recurringPolls', () => {
  describe('parseDaysOfWeek', () => {
    it('should parse "everyday"', () => {
      const res = parseDaysOfWeek('everyday');
      assert.ok(res);
      assert.deepEqual(res.days, [0, 1, 2, 3, 4, 5, 6]);
    });

    it('should parse "weekdays"', () => {
      const res = parseDaysOfWeek('weekdays');
      assert.ok(res);
      assert.deepEqual(res.days, [1, 2, 3, 4, 5]);
    });

    it('should parse "weekends"', () => {
      const res = parseDaysOfWeek('weekends');
      assert.ok(res);
      assert.deepEqual(res.days, [0, 6]);
    });

    it('should parse day range "mon-thu"', () => {
      const res = parseDaysOfWeek('mon-thu');
      assert.ok(res);
      assert.deepEqual(res.days, [1, 2, 3, 4]);
    });

    it('should parse comma-separated days "mon,wed,fri"', () => {
      const res = parseDaysOfWeek('mon,wed,fri');
      assert.ok(res);
      assert.deepEqual(res.days, [1, 3, 5]);
    });
  });

  describe('extractCommonFlags', () => {
    it('should extract common CLI flags and return cleaned remaining text', () => {
      const text = '8 Mon-Thu 7pm --no-matchups --courts --pre-book-courts=2 --court-booking-type=pre-book';
      const { flags, remainingText } = extractCommonFlags(text);

      assert.equal(flags.noMatchups, true);
      assert.equal(flags.checkCourts, true);
      assert.equal(flags.preBookCourts, 2);
      assert.equal(flags.courtBookingType, 'pre-book');
      assert.match(remainingText, /8 Mon-Thu 7pm/);
    });
  });

  describe('extractSkipArgs', () => {
    it('should extract schedule ID and target date from skip args', () => {
      const res = extractSkipArgs('rec_test 2026-10-05');
      assert.equal(res.scheduleId, 'rec_test');
      assert.equal(res.targetDayOrDate, '2026-10-05');
    });

    it('should extract count when number is passed', () => {
      const res = extractSkipArgs('rec_test 2');
      assert.equal(res.scheduleId, 'rec_test');
      assert.equal(res.count, 2);
    });
  });

  describe('extractPauseArgs', () => {
    it('should extract schedule ID and untilDate', () => {
      const res = extractPauseArgs('rec_test until 2026-10-25');
      assert.equal(res.scheduleId, 'rec_test');
      assert.equal(res.untilDate, '2026-10-25');
    });
  });

  describe('parseRecurringPollText', () => {
    it('should parse recurring poll creation command', () => {
      const parsed = parseRecurringPollText('!recurringpoll 8 Mon-Thu 7pm at 1:15pm');
      assert.ok(parsed);
      assert.equal(parsed.size, 8);
      assert.equal(parsed.matchTime, '7pm');
      assert.equal(parsed.days.toLowerCase(), 'mon-thu');
    });

    it('should parse modify recurring poll command', () => {
      const parsed = parseRecurringPollText('!modifyrecurringpoll rec_1 4 6pm');
      assert.ok(parsed);
      assert.equal(parsed.action, 'modify');
      assert.equal(parsed.scheduleId, 'rec_1');
      assert.equal(parsed.updates.size, 4);
      assert.equal(parsed.updates.matchTime, '6pm');
    });

    it('should parse recurring poll list/status commands', () => {
      const parsed1 = parseRecurringPollText('!recurringpolls');
      assert.ok(parsed1);
      assert.equal(parsed1.action, 'list');

      const parsed2 = parseRecurringPollText('!recurringpoll status rec_1');
      assert.ok(parsed2);
      assert.equal(parsed2.action, 'status');
      assert.equal(parsed2.scheduleId, 'rec_1');
    });
  });
});
