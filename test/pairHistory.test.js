const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const {
  pairsInSchedule,
  recordDraw,
  getPairWeights,
  prune,
  load,
  save,
  pairKey,
  HISTORY_FILE,
  FRESHNESS_WINDOW_DAYS
} = require('../lib/pairHistory');

describe('pairHistory', () => {
  let originalHistory = null;

  before(() => {
    if (fs.existsSync(HISTORY_FILE)) {
      originalHistory = fs.readFileSync(HISTORY_FILE, 'utf-8');
    }
  });

  after(() => {
    if (originalHistory !== null) {
      fs.writeFileSync(HISTORY_FILE, originalHistory);
    }
  });

  describe('pairsInSchedule', () => {
    it('should extract partners and opponents when players are plain strings (manual lineups)', () => {
      const schedule = {
        type: 'doubles',
        sets: [
          {
            set: 1,
            courts: [
              {
                court: 1,
                teamA: ['Alice', 'Bob'],
                teamB: ['Charlie', 'Dave']
              }
            ]
          }
        ]
      };

      const { partners, opponents } = pairsInSchedule(schedule);

      assert.deepEqual(partners, [
        ['Alice', 'Bob'],
        ['Charlie', 'Dave']
      ]);

      assert.deepEqual(opponents, [
        ['Alice', 'Charlie'],
        ['Alice', 'Dave'],
        ['Bob', 'Charlie'],
        ['Bob', 'Dave']
      ]);
    });

    it('should extract partners and opponents when players are objects with id', () => {
      const schedule = {
        sets: [
          {
            courts: [
              {
                teamA: [{ id: 'p1', name: 'Alice' }, { id: 'p2', name: 'Bob' }],
                teamB: [{ id: 'p3', name: 'Charlie' }, { id: 'p4', name: 'Dave' }]
              }
            ]
          }
        ]
      };

      const { partners, opponents } = pairsInSchedule(schedule);

      assert.deepEqual(partners, [
        ['p1', 'p2'],
        ['p3', 'p4']
      ]);

      assert.deepEqual(opponents, [
        ['p1', 'p3'],
        ['p1', 'p4'],
        ['p2', 'p3'],
        ['p2', 'p4']
      ]);
    });

    it('should extract player name when player object lacks id property', () => {
      const schedule = {
        sets: [
          {
            courts: [
              {
                teamA: [{ name: 'Alice' }, { name: 'Bob' }],
                teamB: [{ name: 'Charlie' }, { name: 'Dave' }]
              }
            ]
          }
        ]
      };

      const { partners, opponents } = pairsInSchedule(schedule);

      assert.deepEqual(partners, [
        ['Alice', 'Bob'],
        ['Charlie', 'Dave']
      ]);
    });

    it('should extract opponents without partners for singles matches', () => {
      const schedule = {
        type: 'singles',
        sets: [
          {
            set: 1,
            courts: [
              {
                court: 1,
                teamA: ['Alice'],
                teamB: ['Bob']
              }
            ]
          }
        ]
      };

      const { partners, opponents } = pairsInSchedule(schedule);

      assert.deepEqual(partners, []);
      assert.deepEqual(opponents, [['Alice', 'Bob']]);
    });

    it('should never produce null or self-paired entries if players contain invalid data', () => {
      const schedule = {
        sets: [
          {
            courts: [
              {
                teamA: [null, undefined, '', 'Alice'],
                teamB: [{ id: '' }, { name: '   ' }, 'Bob']
              }
            ]
          }
        ]
      };

      const { partners, opponents } = pairsInSchedule(schedule);

      for (const pair of [...partners, ...opponents]) {
        assert.ok(pair[0] && pair[1], 'Pair elements must not be null/empty');
        assert.notEqual(pair[0], pair[1], 'Pair elements must not be equal');
      }
      assert.deepEqual(opponents, [['Alice', 'Bob']]);
    });
  });

  describe('prune and load sanitization', () => {
    it('should drop null pairs and discard empty draws from corrupted history', () => {
      const corruptedDraws = [
        {
          pollId: 'poll_corrupt',
          chatId: 'chat@g.us',
          at: new Date().toISOString(),
          partners: [[null, null], [null, null]],
          opponents: [[null, null], [null, null]]
        },
        {
          pollId: 'poll_mixed',
          chatId: 'chat@g.us',
          at: new Date().toISOString(),
          partners: [[null, null], ['Alice', 'Bob']],
          opponents: [['Alice', 'Charlie'], [null, null]]
        }
      ];

      const cleaned = prune(corruptedDraws);
      assert.equal(cleaned.length, 1);
      assert.equal(cleaned[0].pollId, 'poll_mixed');
      assert.deepEqual(cleaned[0].partners, [['Alice', 'Bob']]);
      assert.deepEqual(cleaned[0].opponents, [['Alice', 'Charlie']]);
    });

    it('should prune draws older than FRESHNESS_WINDOW_DAYS', () => {
      const now = Date.now();
      const oldTime = now - (FRESHNESS_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000;
      const recentTime = now - 2 * 24 * 60 * 60 * 1000;

      const draws = [
        {
          pollId: 'poll_old',
          at: new Date(oldTime).toISOString(),
          partners: [['Alice', 'Bob']],
          opponents: []
        },
        {
          pollId: 'poll_recent',
          at: new Date(recentTime).toISOString(),
          partners: [['Alice', 'Bob']],
          opponents: []
        }
      ];

      const cleaned = prune(draws, now);
      assert.equal(cleaned.length, 1);
      assert.equal(cleaned[0].pollId, 'poll_recent');
    });
  });

  describe('recordDraw and getPairWeights', () => {
    it('should record manual string lineups and reflect in getPairWeights', () => {
      const now = Date.now();
      const testPollId = 'test_manual_poll_123';
      const testChatId = 'test_group_pair@g.us';

      const schedule = {
        sets: [
          {
            courts: [
              {
                teamA: ['PlayerA', 'PlayerB'],
                teamB: ['PlayerC', 'PlayerD']
              }
            ]
          }
        ]
      };

      recordDraw(testPollId, schedule, now, testChatId);

      const { partner, opponent } = getPairWeights(now, testChatId);

      const abKey = pairKey('PlayerA', 'PlayerB');
      const acKey = pairKey('PlayerA', 'PlayerC');

      assert.ok(partner.has(abKey), 'PlayerA-PlayerB should have partner weight');
      assert.ok(partner.get(abKey) > 0.99, 'Recent partner weight should be ~1.0');
      assert.ok(opponent.has(acKey), 'PlayerA-PlayerC should have opponent weight');
      assert.ok(opponent.get(acKey) > 0.99, 'Recent opponent weight should be ~1.0');

      // Check group isolation
      const otherGroupWeights = getPairWeights(now, 'other_group@g.us');
      assert.equal(otherGroupWeights.partner.has(abKey), false, 'Should not leak to other group');
    });
  });
});
