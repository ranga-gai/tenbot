const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSide,
  parseSetRatingCommand,
  parseUnsetRatingCommand,
  handleUnsetRating,
  parseFullNameCommand,
  parseAliasCommand,
  handleScoreCommand,
  handlePlayerCommand,
  nameFor,
  canUserManagePlayerAlias
} = require('../lib/commands/playerCommands');

describe('playerCommands', () => {
  describe('parseSide', () => {
    it('should split partners separated by & or and', () => {
      assert.deepEqual(parseSide('Mike & Sara'), ['Mike', 'Sara']);
      assert.deepEqual(parseSide('Mike and Sara'), ['Mike', 'Sara']);
      assert.deepEqual(parseSide('Mike + Sara'), ['Mike', 'Sara']);
    });

    it('should return a single player when no delimiter exists', () => {
      assert.deepEqual(parseSide('Roger'), ['Roger']);
    });
  });

  describe('parseUnsetRatingCommand', () => {
    it('should parse command with player name only', () => {
      const res = parseUnsetRatingCommand('!unsetrating Bob');
      assert.deepEqual(res, { name: 'Bob', rating: null });
    });

    it('should parse command with player name and explicit rating', () => {
      const res = parseUnsetRatingCommand('!unsetrating Bob = 3.5');
      assert.deepEqual(res, { name: 'Bob', rating: 3.5 });

      const res2 = parseUnsetRatingCommand('!unsetrating Bob 3.75');
      assert.deepEqual(res2, { name: 'Bob', rating: 3.75 });
    });

    it('should parse self unsetrating', () => {
      const res = parseUnsetRatingCommand('!unsetrating', 'Alice');
      assert.deepEqual(res, { name: 'Alice', rating: null });

      const res2 = parseUnsetRatingCommand('!unsetrating 3.5', 'Alice');
      assert.deepEqual(res2, { name: 'Alice', rating: 3.5 });
    });
  });

  describe('parseFullNameCommand', () => {
    it('should parse command with player name and full name', () => {
      const res = parseFullNameCommand('!setfullname John = Johnathan Smith');
      assert.deepEqual(res, { name: 'John', fullName: 'Johnathan Smith' });

      const res2 = parseFullNameCommand('!fullname John = Johnathan Smith');
      assert.deepEqual(res2, { name: 'John', fullName: 'Johnathan Smith' });
    });

    it('should parse command for sender when only full name provided', () => {
      const res = parseFullNameCommand('!fullname Johnathan Smith', 'John');
      assert.deepEqual(res, { name: 'John', fullName: 'Johnathan Smith' });
    });
  });

  describe('parseAliasCommand', () => {
    it('should parse alias addition for self', () => {
      const res = parseAliasCommand('!alias Johnny', 'John');
      assert.deepEqual(res, { name: 'John', alias: 'Johnny' });
    });

    it('should parse alias addition for another player', () => {
      const res = parseAliasCommand('!alias John = Johnny');
      assert.deepEqual(res, { name: 'John', alias: 'Johnny' });
    });
  });

  describe('parseSetRatingCommand', () => {
    it('should parse "!setrating 4.0" as self rating', () => {
      const res = parseSetRatingCommand('!setrating 4.0', 'Alice');
      assert.deepEqual(res, { name: 'Alice', rating: 4.0 });
    });

    it('should parse "!setrating John = 3.75"', () => {
      const res = parseSetRatingCommand('!setrating John = 3.75');
      assert.deepEqual(res, { name: 'John', rating: 3.75 });
    });

    it('should parse "!setrating for John 3.5"', () => {
      const res = parseSetRatingCommand('!setrating for John 3.5');
      assert.deepEqual(res, { name: 'John', rating: 3.5 });
    });

    it('should return null for invalid text', () => {
      assert.equal(parseSetRatingCommand('!setrating'), null);
      assert.equal(parseSetRatingCommand('!setrating abc'), null);
    });
  });

  describe('handleScoreCommand', () => {
    it('should reject score reports where sides have different numbers of players', () => {
      const res = handleScoreCommand('!score Mike & Sara def John 6-4 6-2');
      assert.match(res, /Both sides need the same number of players/);
    });

    it('should reject invalid syntax', () => {
      const res = handleScoreCommand('!score Mike won against John');
      assert.match(res, /Couldn't parse that/);
    });
  });

  describe('nameFor', () => {
    it('should format phone number digits if no registered name exists', () => {
      const formatted = nameFor('14085551234@s.whatsapp.net');
      assert.match(formatted, /1234/);
    });

    it('should return "Player" or digits for bare numbers', () => {
      const formatted = nameFor('9999@s.whatsapp.net');
      assert.match(formatted, /9999/);
    });
  });

  describe('canUserManagePlayerAlias', () => {
    it('should allow user to manage alias for themselves', async () => {
      const sock = {};
      const res = await canUserManagePlayerAlias(sock, '120363@g.us', '123@s.whatsapp.net', 'Alice', 'Alice');
      assert.equal(res, true);

      const res2 = await canUserManagePlayerAlias(sock, '120363@g.us', '123@s.whatsapp.net', 'Alice', 'me');
      assert.equal(res2, true);
    });
  });

  describe('tennisRecord configuration commands', () => {
    it('should display configuration via !trconfig', async () => {
      const sock = {
        groupMetadata: async () => ({ participants: [] })
      };
      const res = await handlePlayerCommand(sock, '!trconfig', '120363@g.us', 'Alice', '123@s.whatsapp.net');
      assert.ok(res);
      assert.match(res, /TennisRecord Configuration/);
      assert.match(res, /URL/);
      assert.match(res, /Timeout/);
    });

    it('should display cert status via !certstatus', async () => {
      const sock = {
        groupMetadata: async () => ({ participants: [] })
      };
      const res = await handlePlayerCommand(sock, '!certstatus', '120363@g.us', 'Alice', '123@s.whatsapp.net');
      assert.ok(res);
      assert.match(res, /TennisRecord SSL certificate check status/);
    });
  });
});
