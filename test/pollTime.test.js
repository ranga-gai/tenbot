const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseTimeString,
  resolvePlayDateTime,
  getSanJoseNow,
  getSanJoseParts,
  normalizeDayWord,
  WORD_TO_NUMBER
} = require('../lib/pollTime');

describe('pollTime', () => {
  describe('parseTimeString', () => {
    it('should parse 12-hour AM/PM times', () => {
      const t1 = parseTimeString('9am');
      assert.equal(t1.hour, 9);
      assert.equal(t1.minute, 0);
      assert.equal(t1.formatted, '9am');
      assert.equal(t1.display, '9 AM');

      const t2 = parseTimeString('6:30pm');
      assert.equal(t2.hour, 18);
      assert.equal(t2.minute, 30);
      assert.equal(t2.formatted, '6:30pm');
      assert.equal(t2.display, '6:30 PM');

      const t3 = parseTimeString('12pm');
      assert.equal(t3.hour, 12);
      assert.equal(t3.minute, 0);
      assert.equal(t3.formatted, '12pm');

      const t4 = parseTimeString('12am');
      assert.equal(t4.hour, 0);
      assert.equal(t4.minute, 0);
      assert.equal(t4.formatted, '12am');
    });

    it('should parse 24-hour times without AM/PM', () => {
      const t = parseTimeString('19:30');
      assert.equal(t.hour, 19);
      assert.equal(t.minute, 30);
      assert.equal(t.formatted, '7:30pm');
      assert.equal(t.display, '7:30 PM');
    });

    it('should return null for invalid time strings', () => {
      assert.equal(parseTimeString('abc'), null);
      assert.equal(parseTimeString(''), null);
      assert.equal(parseTimeString(null), null);
    });
  });

  describe('normalizeDayWord', () => {
    it('should normalize abbreviations to day numbers', () => {
      assert.equal(normalizeDayWord('sun'), 0);
      assert.equal(normalizeDayWord('mon'), 1);
      assert.equal(normalizeDayWord('tue'), 2);
      assert.equal(normalizeDayWord('wed'), 3);
      assert.equal(normalizeDayWord('thu'), 4);
      assert.equal(normalizeDayWord('fri'), 5);
      assert.equal(normalizeDayWord('sat'), 6);
    });

    it('should return null for unrecognized days', () => {
      assert.equal(normalizeDayWord('someday'), null);
    });
  });

  describe('WORD_TO_NUMBER', () => {
    it('should map words to numeric values', () => {
      assert.equal(WORD_TO_NUMBER.two, 2);
      assert.equal(WORD_TO_NUMBER.four, 4);
      assert.equal(WORD_TO_NUMBER.eight, 8);
      assert.equal(WORD_TO_NUMBER.twelve, 12);
      assert.equal(WORD_TO_NUMBER.sixteen, 16);
    });
  });

  describe('getSanJoseNow and getSanJoseParts', () => {
    it('should return current date in San Jose timezone', () => {
      const now = getSanJoseNow();
      assert.ok(now instanceof Date);
      assert.equal(Number.isNaN(now.getTime()), false);

      const parts = getSanJoseParts(now);
      assert.equal(typeof parts.year, 'number');
      assert.equal(typeof parts.month, 'number');
      assert.equal(typeof parts.day, 'number');
      assert.equal(typeof parts.hour, 'number');
      assert.equal(typeof parts.minute, 'number');
    });
  });

  describe('resolvePlayDateTime', () => {
    it('should resolve tomorrow 9am correctly', () => {
      const playAt = resolvePlayDateTime('tomorrow', '9am');
      assert.ok(playAt instanceof Date);
      const parts = getSanJoseParts(playAt);
      assert.equal(parts.hour, 9);
      assert.equal(parts.minute, 0);
    });
  });
});
