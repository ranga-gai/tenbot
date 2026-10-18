const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  keyFor,
  isPlaceholder,
  pairRating,
  formatRating,
  applyResult,
  MIN_RATING,
  MAX_RATING
} = require('../lib/ratings');

describe('ratings', () => {
  describe('keyFor', () => {
    it('should normalize and lowercase names', () => {
      assert.equal(keyFor('Roger Federer'), 'roger federer');
      assert.equal(keyFor('  ALICE  '), 'alice');
    });

    it('should return empty string for null/undefined/empty', () => {
      assert.equal(keyFor(''), '');
      assert.equal(keyFor(null), '');
      assert.equal(keyFor(undefined), '');
    });
  });

  describe('isPlaceholder', () => {
    it('should return true for generic placeholders', () => {
      assert.equal(isPlaceholder('Player 1'), true);
      assert.equal(isPlaceholder('player 2'), true);
      assert.equal(isPlaceholder('someone'), true);
      assert.equal(isPlaceholder('me'), true);
      assert.equal(isPlaceholder('creator'), true);
      assert.equal(isPlaceholder(''), true);
    });

    it('should return false for actual player names', () => {
      assert.equal(isPlaceholder('Roger'), false);
      assert.equal(isPlaceholder('Alice'), false);
      assert.equal(isPlaceholder('Pramod Immaneni'), false);
    });
  });

  describe('pairRating', () => {
    it('should sum ratings of players from ratingMap', () => {
      const map = new Map([
        ['Alice', 3.5],
        ['Bob', 4.0]
      ]);
      assert.equal(pairRating(['Alice', 'Bob'], map), 7.5);
    });
  });

  describe('formatRating', () => {
    it('should format numbers with 2 decimal places', () => {
      assert.equal(formatRating(3.5), '3.50');
      assert.equal(formatRating(4), '4.00');
      assert.equal(formatRating(3.75), '3.75');
    });
  });

  describe('applyResult', () => {
    it('should adjust ratings upward for winners and downward for losers', () => {
      const winners = ['Alice'];
      const losers = ['Bob'];
      const sets = [[6, 4]];

      const res = applyResult(winners, losers, sets);
      assert.ok(res);
      assert.ok(Array.isArray(res.sets));
      assert.ok(Array.isArray(res.changes));

      const aliceChange = res.changes.find((c) => c.name === 'Alice');
      const bobChange = res.changes.find((c) => c.name === 'Bob');

      assert.ok(aliceChange);
      assert.ok(bobChange);
      assert.ok(aliceChange.to >= aliceChange.from);
      assert.ok(bobChange.to <= bobChange.from);
    });
  });
});
