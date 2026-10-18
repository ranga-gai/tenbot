const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isSamePlayerName,
  extractTimeFromLineupMessage,
  getPollMatchTime,
  findBestMatchingPollForLineup
} = require('../lib/commands/lineupCommands');

describe('lineupCommands', () => {
  describe('isSamePlayerName', () => {
    it('should match identical names case-insensitively', () => {
      assert.equal(isSamePlayerName('Roger Federer', 'roger federer'), true);
      assert.equal(isSamePlayerName('Alice', 'ALICE'), true);
    });

    it('should match first name and full name prefixes', () => {
      assert.equal(isSamePlayerName('Pramod Immaneni', 'Pramod'), true);
      assert.equal(isSamePlayerName('Pramod', 'Pramod Immaneni'), true);
    });

    it('should return false for different names', () => {
      assert.equal(isSamePlayerName('Alice', 'Bob'), false);
    });

    it('should return false for placeholders', () => {
      assert.equal(isSamePlayerName('Player 1', 'Player 1'), false);
      assert.equal(isSamePlayerName('Someone', 'Someone'), false);
      assert.equal(isSamePlayerName('me', 'me'), false);
    });
  });

  describe('extractTimeFromLineupMessage', () => {
    it('should extract 12-hour formatted times', () => {
      const t1 = extractTimeFromLineupMessage('@Alice @Bob @Charlie @Dave - Court 6 7.00 pm');
      assert.ok(t1);
      assert.equal(t1.hour, 19);
      assert.equal(t1.minute, 0);

      const t2 = extractTimeFromLineupMessage('Court 2 at 10:30am');
      assert.ok(t2);
      assert.equal(t2.hour, 10);
      assert.equal(t2.minute, 30);
    });

    it('should extract 24-hour formatted times', () => {
      const t = extractTimeFromLineupMessage('Lineup for 19:30 on Court 1');
      assert.ok(t);
      assert.equal(t.hour, 19);
      assert.equal(t.minute, 30);
    });

    it('should return null if no time is mentioned', () => {
      assert.equal(extractTimeFromLineupMessage('Alice & Bob vs Charlie & Dave'), null);
    });
  });

  describe('getPollMatchTime', () => {
    it('should extract time from playAt ISO string', () => {
      const pollState = { playAt: '2026-10-18T19:00:00.000Z' };
      const time = getPollMatchTime(pollState);
      assert.ok(time);
      assert.equal(typeof time.hour, 'number');
      assert.equal(typeof time.minute, 'number');
    });

    it('should extract time from when string', () => {
      const pollState = { when: 'Today 6:30pm' };
      const time = getPollMatchTime(pollState);
      assert.ok(time);
      assert.equal(time.hour, 18);
      assert.equal(time.minute, 30);
    });
  });

  describe('findBestMatchingPollForLineup', () => {
    it('should match Tier 1 poll when both players and time match exactly', () => {
      const activePolls = new Map([
        ['poll_7pm', {
          remoteJid: 'test_chat@g.us',
          when: '7:00pm',
          size: 4,
          status: 'active',
          lastPlayers: ['Alice', 'Bob', 'Charlie', 'Dave']
        }],
        ['poll_8am', {
          remoteJid: 'test_chat@g.us',
          when: '8:00am',
          size: 4,
          status: 'active',
          lastPlayers: ['Eve', 'Frank', 'Grace', 'Heidi']
        }]
      ]);

      const lineup = {
        players: ['Alice', 'Bob', 'Charlie', 'Dave'],
        time: '7:00pm'
      };

      const res = findBestMatchingPollForLineup({
        activePolls,
        chatId: 'test_chat@g.us',
        lineup,
        messageText: 'Lineup at 7:00pm: Alice, Bob, Charlie, Dave',
        mePn: 'bot@s.whatsapp.net'
      });

      assert.equal(res.targetPollId, 'poll_7pm');
      assert.match(res.matchInfo, /exact_players_and_time/);
    });

    it('should match Tier 2 poll when message has no time but player overlap is >= 50%', () => {
      const activePolls = new Map([
        ['poll_active', {
          remoteJid: 'test_chat@g.us',
          when: '6:00pm',
          size: 4,
          status: 'active',
          lastPlayers: ['Alice', 'Bob', 'Charlie', 'Dave']
        }]
      ]);

      const lineup = {
        players: ['Alice', 'Bob', 'Charlie', 'Stranger'],
        time: null
      };

      const res = findBestMatchingPollForLineup({
        activePolls,
        chatId: 'test_chat@g.us',
        lineup,
        messageText: 'Alice, Bob, Charlie, Stranger',
        mePn: 'bot@s.whatsapp.net'
      });

      assert.equal(res.targetPollId, 'poll_active');
      assert.match(res.matchInfo, /qualifying_match/);
    });

    it('should reject match when player overlap is below 50%', () => {
      const activePolls = new Map([
        ['poll_active', {
          remoteJid: 'test_chat@g.us',
          when: '6:00pm',
          size: 4,
          status: 'active',
          lastPlayers: ['Alice', 'Bob', 'Charlie', 'Dave']
        }]
      ]);

      const lineup = {
        players: ['Alice', 'P2', 'P3', 'P4'], // only 1/4 matches (25% < 50%)
        time: null
      };

      const res = findBestMatchingPollForLineup({
        activePolls,
        chatId: 'test_chat@g.us',
        lineup,
        messageText: 'Alice, P2, P3, P4',
        mePn: 'bot@s.whatsapp.net'
      });

      assert.equal(res.targetPollId, null);
      assert.equal(res.matchInfo, 'none');
    });
  });
});
