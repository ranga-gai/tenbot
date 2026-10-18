const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const {
  setAvailable,
  removeAvailable,
  clearAvailability,
  getAvailability,
  recordMatch,
  getLeaderboard,
  getRecentMatches,
  STATS_FILE
} = require('../lib/stats');

describe('stats', () => {
  let originalStats = null;

  before(() => {
    if (fs.existsSync(STATS_FILE)) {
      originalStats = fs.readFileSync(STATS_FILE, 'utf-8');
    }
  });

  after(() => {
    if (originalStats !== null) {
      fs.writeFileSync(STATS_FILE, originalStats);
    }
  });

  describe('availability', () => {
    it('should add, get, update, and remove availability', () => {
      clearAvailability();
      assert.deepEqual(getAvailability(), []);

      setAvailable('Alice', 'tomorrow 9am');
      const list1 = getAvailability();
      assert.equal(list1.length, 1);
      assert.equal(list1[0].player, 'Alice');
      assert.equal(list1[0].when, 'tomorrow 9am');

      // Update same player
      setAvailable('Alice', 'Saturday 10am');
      const list2 = getAvailability();
      assert.equal(list2.length, 1);
      assert.equal(list2[0].when, 'Saturday 10am');

      // Remove player
      removeAvailable('Alice');
      assert.deepEqual(getAvailability(), []);
    });
  });

  describe('match results & leaderboard', () => {
    it('should record matches and calculate leaderboard', () => {
      clearAvailability();
      // Record a match
      recordMatch('TestWinner', 'TestLoser', '6-4 6-2');

      const recent = getRecentMatches(5);
      assert.ok(recent.length > 0);
      assert.equal(recent[0].winner, 'TestWinner');
      assert.equal(recent[0].loser, 'TestLoser');

      const leaderboard = getLeaderboard();
      const winnerEntry = leaderboard.find((p) => p.name === 'TestWinner');
      const loserEntry = leaderboard.find((p) => p.name === 'TestLoser');

      assert.ok(winnerEntry);
      assert.ok(loserEntry);
      assert.ok(winnerEntry.wins >= 1);
      assert.ok(loserEntry.losses >= 1);
    });
  });
});
