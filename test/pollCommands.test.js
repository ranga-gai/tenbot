const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isValidPlayerCount,
  getNextValidPlayerCount,
  getFirstSlotNumber,
  extractFixedPairsFromText,
  parsePollCreationText,
  resolveManualPollPlayers,
  buildPollReminderText
} = require('../lib/commands/pollCommands');

describe('pollCommands', () => {
  describe('isValidPlayerCount', () => {
    it('should return true for singles (2) and multiples of 4 (4, 8, 12, 16)', () => {
      assert.equal(isValidPlayerCount(2), true);
      assert.equal(isValidPlayerCount(4), true);
      assert.equal(isValidPlayerCount(8), true);
      assert.equal(isValidPlayerCount(12), true);
      assert.equal(isValidPlayerCount(16), true);
    });

    it('should return false for non-conforming counts', () => {
      assert.equal(isValidPlayerCount(1), false);
      assert.equal(isValidPlayerCount(3), false);
      assert.equal(isValidPlayerCount(5), false);
      assert.equal(isValidPlayerCount(6), false);
      assert.equal(isValidPlayerCount(7), false);
      assert.equal(isValidPlayerCount(9), false);
      assert.equal(isValidPlayerCount(10), false);
    });
  });

  describe('getNextValidPlayerCount', () => {
    it('should map counts <= 2 to 2', () => {
      assert.equal(getNextValidPlayerCount(1), 2);
      assert.equal(getNextValidPlayerCount(2), 2);
    });

    it('should round up to next multiple of 4 for counts > 2', () => {
      assert.equal(getNextValidPlayerCount(3), 4);
      assert.equal(getNextValidPlayerCount(4), 4);
      assert.equal(getNextValidPlayerCount(5), 8);
      assert.equal(getNextValidPlayerCount(7), 8);
      assert.equal(getNextValidPlayerCount(8), 8);
      assert.equal(getNextValidPlayerCount(9), 12);
    });
  });

  describe('getFirstSlotNumber', () => {
    it('should extract slot number from option labels', () => {
      assert.equal(getFirstSlotNumber(['Player 3', 'Player 4']), 3);
      assert.equal(getFirstSlotNumber(['Spot 1', 'Spot 2']), 1);
      assert.equal(getFirstSlotNumber(['4', '5']), 4);
      assert.equal(getFirstSlotNumber(['Court 2']), 2);
    });

    it('should return null for non-numbered options like Yes/No', () => {
      assert.equal(getFirstSlotNumber(['Yes', 'No']), null);
      assert.equal(getFirstSlotNumber([]), null);
      assert.equal(getFirstSlotNumber(null), null);
    });
  });

  describe('extractFixedPairsFromText', () => {
    it('should extract "keeping X and Y in same team"', () => {
      const pairs = extractFixedPairsFromText('Can you generate matchups keeping Alice and Bob in same team?');
      assert.deepEqual(pairs, [['Alice', 'Bob']]);
    });

    it('should extract "with X & Y together"', () => {
      const pairs = extractFixedPairsFromText('!matchups with Mike & Sara together');
      assert.deepEqual(pairs, [['Mike', 'Sara']]);
    });

    it('should extract "partner X with Y"', () => {
      const pairs = extractFixedPairsFromText('draw teams partner John with Alex');
      assert.deepEqual(pairs, [['John', 'Alex']]);
    });

    it('should return empty array when no pairing instructions exist', () => {
      const pairs = extractFixedPairsFromText('!matchups');
      assert.deepEqual(pairs, []);
    });
  });

  describe('parsePollCreationText', () => {
    it('should parse command with size, day, and time', () => {
      const parsed = parsePollCreationText('!createpoll 4 today 6pm');
      assert.ok(parsed);
      assert.equal(parsed.size, 4);
      assert.equal(parsed.dayWord, 'today');
      assert.equal(parsed.timeWord, '6pm');
      assert.equal(parsed.when, 'Today 6pm');
    });

    it('should parse natural language poll creation for singles', () => {
      const parsed = parsePollCreationText('create a poll for 2 tomorrow 9am');
      assert.ok(parsed);
      assert.equal(parsed.size, 2);
      assert.equal(parsed.dayWord, 'tomorrow');
      assert.equal(parsed.timeWord, '9am');
    });

    it('should parse natural language poll creation with word numbers', () => {
      const parsed = parsePollCreationText('create a poll for eight on Saturday 10am');
      assert.ok(parsed);
      assert.equal(parsed.size, 8);
      assert.equal(parsed.dayWord.toLowerCase(), 'saturday');
      assert.equal(parsed.timeWord, '10am');
    });

    it('should parse auto size', () => {
      const parsed = parsePollCreationText('!createpoll auto tomorrow 8am');
      assert.ok(parsed);
      assert.equal(parsed.size, 'auto');
    });

    it('should parse opt-in Yes/No poll when no size is given', () => {
      const parsed = parsePollCreationText('create a poll for tomorrow 9am');
      assert.ok(parsed);
      assert.equal(parsed.size, null);
    });

    it('should parse flags like --no-matchups and --courts', () => {
      const parsed = parsePollCreationText('!createpoll 4 today 6pm --no-matchups --courts');
      assert.ok(parsed);
      assert.equal(parsed.noMatchups, true);
      assert.equal(parsed.checkCourts, true);
    });

    it('should return null for non-poll messages', () => {
      assert.equal(parsePollCreationText('who wants to play tennis?'), null);
      assert.equal(parsePollCreationText('!score Mike def John 6-4'), null);
    });
  });

  describe('resolveManualPollPlayers', () => {
    it('should prepend leading creator players if first slot > 1', () => {
      const pollState = {
        type: 'manual',
        size: 4,
        options: ['Player 3', 'Player 4'],
        creator: { name: 'Alice', jid: '123@s.whatsapp.net' }
      };
      const currentPlayers = ['Bob', 'Charlie'];
      const result = resolveManualPollPlayers(pollState, currentPlayers);

      // Slot starts at 3 -> needs 2 leading players: Alice, Alice 2
      assert.equal(result.addedFromLabel.length, 2);
      assert.deepEqual(result.addedFromLabel, ['Alice', 'Alice 2']);
      assert.deepEqual(result.players, ['Alice', 'Alice 2', 'Bob', 'Charlie']);
    });

    it('should not add creator extra players for Yes/No opt-in polls', () => {
      const pollState = {
        type: 'opt_in',
        size: null,
        options: ['Yes', 'No'],
        creator: { name: 'Alice', jid: '123@s.whatsapp.net' }
      };
      const currentPlayers = ['Bob', 'Charlie', 'David'];
      const result = resolveManualPollPlayers(pollState, currentPlayers);

      assert.deepEqual(result.players, ['Bob', 'Charlie', 'David']);
      assert.equal(result.addedCreator, false);
      assert.equal(result.addedExtra.length, 0);
    });
  });

  describe('buildPollReminderText', () => {
    it('should build fixed-slot reminder text', () => {
      const pollState = { when: 'Tomorrow 9am', name: 'Tennis 9am' };
      const text = buildPollReminderText(4, pollState, 2, 4, 'Alice, Bob', false, 0, 4);
      assert.match(text, /Tomorrow 9am/);
      assert.match(text, /2 spots left/i);
    });

    it('should build opt-in reminder text', () => {
      const pollState = { when: 'Tomorrow 9am', name: 'Tennis 9am' };
      const text = buildPollReminderText(4, pollState, 0, 0, 'Alice, Bob', true, 2, 4);
      assert.match(text, /Tomorrow 9am/);
      assert.match(text, /2 player\(s\)/i);
    });
  });
});
