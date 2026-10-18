const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseConfigKeyValueArgs,
  isSameUser,
  handleGroupCommand,
  executeGroupTool
} = require('../lib/commands/groupCommands');

describe('groupCommands', () => {
  describe('parseConfigKeyValueArgs', () => {
    it('should parse simple unquoted key-value pairs', () => {
      const res = parseConfigKeyValueArgs('sport=tennis courtBookingEnabled=true');
      assert.deepEqual(res, {
        sport: 'tennis',
        courtBookingEnabled: 'true'
      });
    });

    it('should parse double-quoted and single-quoted values with spaces', () => {
      const res = parseConfigKeyValueArgs('name="Tennis Group" alias=\'TG\' preBookCourts=2');
      assert.deepEqual(res, {
        name: 'Tennis Group',
        alias: 'TG',
        preBookCourts: '2'
      });
    });

    it('should handle empty or whitespace-only strings', () => {
      assert.deepEqual(parseConfigKeyValueArgs(''), {});
      assert.deepEqual(parseConfigKeyValueArgs('   '), {});
      assert.deepEqual(parseConfigKeyValueArgs(null), {});
    });
  });

  describe('isSameUser', () => {
    it('should return true for identical JIDs', () => {
      assert.equal(isSameUser('12345@s.whatsapp.net', '12345@s.whatsapp.net', 'Alice', 'Bob'), true);
    });

    it('should return true for identical non-generic names', () => {
      assert.equal(isSameUser(null, null, 'Pramod Immaneni', 'Pramod Immaneni'), true);
      assert.equal(isSameUser('111@s.whatsapp.net', '222@s.whatsapp.net', 'John Smith', 'John Smith'), true);
    });

    it('should return false for generic names like someone or player 1 if JIDs differ', () => {
      assert.equal(isSameUser('111@s.whatsapp.net', '222@s.whatsapp.net', 'Someone', 'Someone'), false);
      assert.equal(isSameUser('111@s.whatsapp.net', '222@s.whatsapp.net', 'Player 1', 'Player 1'), false);
    });

    it('should return false for different JIDs and different names', () => {
      assert.equal(isSameUser('111@s.whatsapp.net', '222@s.whatsapp.net', 'Alice', 'Bob'), false);
    });
  });

  describe('handleGroupCommand DM restriction', () => {
    it('should reject !groups when called in a group chat ending with @g.us', async () => {
      const sock = {};
      const msg = { key: { participant: '12345@s.whatsapp.net' } };
      const res = await handleGroupCommand(sock, '!groups', '120363403838804497@g.us', 'Alice', msg);
      assert.match(res, /Direct Message/);
    });

    it('should reject !addgroup when called in a group chat ending with @g.us', async () => {
      const sock = {};
      const msg = { key: { participant: '12345@s.whatsapp.net' } };
      const res = await handleGroupCommand(sock, '!addgroup TestGroup', '120363403838804497@g.us', 'Alice', msg);
      assert.match(res, /Direct Message/);
    });

    it('should reject !removegroup when called in a group chat ending with @g.us', async () => {
      const sock = {};
      const msg = { key: { participant: '12345@s.whatsapp.net' } };
      const res = await handleGroupCommand(sock, '!removegroup TestGroup', '120363403838804497@g.us', 'Alice', msg);
      assert.match(res, /Direct Message/);
    });

    it('should return null for non-group commands', async () => {
      const res = await handleGroupCommand(null, '!score Mike def John 6-4', '12345@s.whatsapp.net', 'Alice', {});
      assert.equal(res, null);
    });
  });

  describe('executeGroupTool', () => {
    it('should return error if executed in a group chat (@g.us)', async () => {
      const res = await executeGroupTool(null, 'list_groups', {}, '12345@s.whatsapp.net', '120363403838804497@g.us');
      assert.match(res, /Direct Message/);
    });

    it('should reject if sender is not superadmin', async () => {
      const res = await executeGroupTool(null, 'list_groups', {}, 'non_superadmin@s.whatsapp.net', '12345@s.whatsapp.net');
      assert.match(res, /superadmin/);
    });

    it('should return unknown message for unrecognized tool name when called by superadmin', async () => {
      // Find or mock superadmin
      const groupsConfig = require('../lib/groupsConfig');
      const originalIsSuper = groupsConfig.isSuperAdmin;
      groupsConfig.isSuperAdmin = () => true;
      try {
        const res = await executeGroupTool(null, 'nonexistent_group_tool', {}, 'super@s.whatsapp.net', '12345@s.whatsapp.net');
        assert.equal(res, 'Unknown group tool nonexistent_group_tool');
      } finally {
        groupsConfig.isSuperAdmin = originalIsSuper;
      }
    });
  });
});
