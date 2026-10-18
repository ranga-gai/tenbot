const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSide,
  parseSetRatingCommand,
  parseFullNameCommand,
  parseAliasCommand,
  handleScoreCommand,
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

  describe('parseSetRatingCommand', () => {
    it('should parse simple numeric rating for sender', () => {
      const res = parseSetRatingCommand('!setrating 3.5', 'Alice');
      assert.deepEqual(res, { name: 'Alice', rating: 3.5 });
    });

    it('should parse rating with "for <player> = <rating>"', () => {
      const res = parseSetRatingCommand('!setrating for Bob = 4.0');
      assert.deepEqual(res, { name: 'Bob', rating: 4.0 });
    });

    it('should parse rating with "<player> to <rating>"', () => {
      const res = parseSetRatingCommand('!setrating Charlie to 3.75');
      assert.deepEqual(res, { name: 'Charlie', rating: 3.75 });
    });

    it('should return null for invalid text or non-numeric ratings', () => {
      assert.equal(parseSetRatingCommand('!setrating abc'), null);
      assert.equal(parseSetRatingCommand('!setrating'), null);
    });
  });

  describe('parseFullNameCommand', () => {
    it('should parse full name for sender', () => {
      const res = parseFullNameCommand('!fullname Roger Federer', 'Roger');
      assert.deepEqual(res, { name: 'Roger', fullName: 'Roger Federer' });
    });

    it('should parse "for" syntax with target player', () => {
      const res = parseFullNameCommand('!setfullname Johnathan Smith for John');
      assert.deepEqual(res, { name: 'John', fullName: 'Johnathan Smith' });
    });

    it('should parse delimiter syntax with target player', () => {
      const res = parseFullNameCommand('!setfullname John = Johnathan Smith');
      assert.deepEqual(res, { name: 'John', fullName: 'Johnathan Smith' });
    });

    it('should return null if no full name is provided', () => {
      assert.equal(parseFullNameCommand('!fullname'), null);
    });
  });

  describe('parseAliasCommand', () => {
    it('should parse single alias for sender', () => {
      const res = parseAliasCommand('!alias PK', 'Pramod');
      assert.deepEqual(res, { name: 'Pramod', alias: 'PK' });
    });

    it('should parse "for" syntax with target player', () => {
      const res = parseAliasCommand('!alias PK for Pramod');
      assert.deepEqual(res, { name: 'Pramod', alias: 'PK' });
    });

    it('should parse delimiter syntax with target player', () => {
      const res = parseAliasCommand('!alias Jonathan Doe = JD');
      assert.deepEqual(res, { name: 'Jonathan Doe', alias: 'JD' });
    });

    it('should parse quoted alias', () => {
      const res = parseAliasCommand('!alias "The Ace"', 'Bob');
      assert.deepEqual(res, { name: 'Bob', alias: 'The Ace' });
    });

    it('should return null for empty alias command', () => {
      assert.equal(parseAliasCommand('!alias'), null);
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
});
