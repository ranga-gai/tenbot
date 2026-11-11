const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const groupsConfig = require('../lib/groupsConfig');
const {
  extractGroupFlag,
  resolveAllowedGroup,
  resolveTargetChat,
  getGroupMetadataCache
} = require('../lib/commands/groupCommands');
const { routeCommand } = require('../lib/commands');
const pollCommands = require('../lib/commands/pollCommands');
const ratings = require('../lib/ratings');
const recurringCommands = require('../lib/commands/recurringCommands');

describe('Uniform --group option across all command types', () => {
  const allowedJid = '120363403838804497@g.us';
  const allowedName = 'Bot-testing';
  const unallowedJid = '120363999999999999@g.us';
  const unallowedName = 'Random-Group';
  const adminJid = '11111111111@s.whatsapp.net';
  const nonAdminJid = '22222222222@s.whatsapp.net';

  beforeEach(() => {
    getGroupMetadataCache().clear();
    ratings.setRating('Admin', 4.0);
    ratings.setRating('NonAdmin', 3.5);
  });

  const mockSock = {
    groupMetadata: async (jid) => {
      if (jid === allowedJid) {
        return {
          id: allowedJid,
          subject: allowedName,
          participants: [
            { id: adminJid, admin: 'admin' },
            { id: nonAdminJid, admin: null }
          ]
        };
      }
      if (jid === unallowedJid) {
        return {
          id: unallowedJid,
          subject: unallowedName,
          participants: [
            { id: adminJid, admin: 'admin' },
            { id: nonAdminJid, admin: null }
          ]
        };
      }
      return null;
    },
    groupFetchAllParticipating: async () => ({
      [allowedJid]: {
        id: allowedJid,
        subject: allowedName,
        participants: [
          { id: adminJid, admin: 'admin' },
          { id: nonAdminJid, admin: null }
        ]
      },
      [unallowedJid]: {
        id: unallowedJid,
        subject: unallowedName,
        participants: [
          { id: adminJid, admin: 'admin' },
          { id: nonAdminJid, admin: null }
        ]
      }
    }),
    sendMessage: async (jid, content) => ({
      key: { id: `msg_${Date.now()}`, remoteJid: jid },
      message: content
    })
  };

  describe('extractGroupFlag', () => {
    it('should extract --group="<name>" with double quotes', () => {
      const { groupQuery, cleanText, remainingText } = extractGroupFlag('!poll 4 7pm --group="Bot-testing"');
      assert.equal(groupQuery, 'Bot-testing');
      assert.equal(cleanText, '!poll 4 7pm');
      assert.equal(remainingText, '!poll 4 7pm');
    });

    it('should extract --group=\'<name>\' with single quotes', () => {
      const { groupQuery, cleanText } = extractGroupFlag('!poll 4 7pm --group=\'Bot-testing\'');
      assert.equal(groupQuery, 'Bot-testing');
      assert.equal(cleanText, '!poll 4 7pm');
    });

    it('should extract --group=<name> without quotes', () => {
      const { groupQuery, cleanText } = extractGroupFlag('!poll 4 7pm --group=Bot-testing');
      assert.equal(groupQuery, 'Bot-testing');
      assert.equal(cleanText, '!poll 4 7pm');
    });

    it('should extract -g "<name>" shorthand', () => {
      const { groupQuery, cleanText } = extractGroupFlag('!poll 4 7pm -g "Bot-testing"');
      assert.equal(groupQuery, 'Bot-testing');
      assert.equal(cleanText, '!poll 4 7pm');
    });

    it('should extract -g <name> shorthand without quotes', () => {
      const { groupQuery, cleanText } = extractGroupFlag('!poll 4 7pm -g Bot-testing');
      assert.equal(groupQuery, 'Bot-testing');
      assert.equal(cleanText, '!poll 4 7pm');
    });

    it('should extract --group when placed at the beginning or middle', () => {
      const { groupQuery, cleanText } = extractGroupFlag('!poll --group="Bot-testing" 4 7pm');
      assert.equal(groupQuery, 'Bot-testing');
      assert.equal(cleanText, '!poll 4 7pm');
    });

    it('should return null groupQuery when no group flag is present', () => {
      const { groupQuery, cleanText } = extractGroupFlag('!poll 4 7pm');
      assert.equal(groupQuery, null);
      assert.equal(cleanText, '!poll 4 7pm');
    });
  });

  describe('resolveAllowedGroup', () => {
    it('should resolve allowed group by name from groups.json', async () => {
      const res = await resolveAllowedGroup(mockSock, 'Bot-testing');
      assert.equal(res.id, allowedJid);
      assert.equal(res.subject, allowedName);
    });

    it('should resolve allowed group by exact JID from groups.json', async () => {
      const res = await resolveAllowedGroup(mockSock, allowedJid);
      assert.equal(res.id, allowedJid);
    });

    it('should reject unallowed group even if the bot is a participating member', async () => {
      // unallowedJid is returned by mockSock.groupFetchAllParticipating, but NOT in groups.json
      const res = await resolveAllowedGroup(mockSock, unallowedName);
      assert.ok(res.error);
      assert.match(res.error, /not found or is not in the allowed list/);
    });

    it('should reject unallowed JID even if the bot is in that group', async () => {
      const res = await resolveAllowedGroup(mockSock, unallowedJid);
      assert.ok(res.error);
      assert.match(res.error, /not found or is not in the allowed list/);
    });

    it('should reject arbitrary non-existent group name', async () => {
      const res = await resolveAllowedGroup(mockSock, 'CompletelyUnknownGroup');
      assert.ok(res.error);
      assert.match(res.error, /not found or is not in the allowed list/);
    });
  });

  describe('resolveTargetChat authorization', () => {
    it('should succeed for admin targeting allowed group from DM', async () => {
      const res = await resolveTargetChat(mockSock, 'dm_user@s.whatsapp.net', adminJid, 'Bot-testing', {}, {
        requireAdmin: true,
        actionDesc: 'create polls'
      });
      assert.equal(res.targetChatId, allowedJid);
      assert.equal(res.error, undefined);
    });

    it('should reject non-admin targeting allowed group from DM when requireAdmin=true', async () => {
      const res = await resolveTargetChat(mockSock, 'dm_user@s.whatsapp.net', nonAdminJid, 'Bot-testing', {}, {
        requireAdmin: true,
        actionDesc: 'create polls'
      });
      assert.ok(res.error);
      assert.match(res.error, /Only group admins.*can create polls for "Bot-testing"/);
    });

    it('should allow non-admin targeting allowed group when requireAdmin=false (e.g. status check)', async () => {
      const res = await resolveTargetChat(mockSock, 'dm_user@s.whatsapp.net', nonAdminJid, 'Bot-testing', {}, {
        requireAdmin: false
      });
      assert.equal(res.targetChatId, allowedJid);
      assert.equal(res.error, undefined);
    });

    it('should reject unallowed group regardless of admin status', async () => {
      const res = await resolveTargetChat(mockSock, 'dm_user@s.whatsapp.net', adminJid, 'Random-Group', {}, {
        requireAdmin: false
      });
      assert.ok(res.error);
      assert.match(res.error, /not found or is not in the allowed list/);
    });
  });

  describe('Poll commands with --group', () => {
    it('should reject poll creation from DM if sender is not an admin of the target group', async () => {
      const context = {
        activePolls: new Map(),
        latestPollIdByChat: new Map(),
        persistPolls: () => {}
      };
      const msg = { key: { participant: nonAdminJid, remoteJid: 'dm@s.whatsapp.net' } };
      const res = await routeCommand(
        mockSock,
        '!createpoll 4 tomorrow 7pm --group="Bot-testing"',
        'dm@s.whatsapp.net',
        'NonAdmin',
        msg,
        context
      );
      assert.ok(res);
      assert.match(res, /Only group admins.*can create polls for "Bot-testing"/);
    });

    it('should reject poll creation with unallowed group', async () => {
      const context = {
        activePolls: new Map(),
        latestPollIdByChat: new Map(),
        persistPolls: () => {}
      };
      const msg = { key: { participant: adminJid, remoteJid: 'dm@s.whatsapp.net' } };
      const res = await routeCommand(
        mockSock,
        '!createpoll 4 tomorrow 7pm --group="UnallowedGroup"',
        'dm@s.whatsapp.net',
        'Admin',
        msg,
        context
      );
      assert.ok(res);
      assert.match(res, /Group "UnallowedGroup" was not found or is not in the allowed list/);
    });

    it('should allow poll creation from DM when sender is admin of allowed group', async () => {
      const context = {
        activePolls: new Map(),
        latestPollIdByChat: new Map(),
        messageStore: new Map(),
        persistPolls: () => {}
      };
      const msg = { key: { participant: adminJid, remoteJid: 'dm@s.whatsapp.net' } };
      const res = await routeCommand(
        mockSock,
        '!createpoll 4 tomorrow 7pm --group="Bot-testing"',
        'dm@s.whatsapp.net',
        'Admin',
        msg,
        context
      );
      assert.ok(!res || !res.includes('⚠️'), `Expected success but got: ${res}`);
      assert.equal(context.activePolls.size, 1);
      const createdPoll = [...context.activePolls.values()][0];
      assert.equal(createdPoll.remoteJid, allowedJid);
    });

    it('should reject !pollstatus with unallowed group', async () => {
      const context = {
        activePolls: new Map(),
        recurringPolls: new Map(),
        latestPollIdByChat: new Map(),
        persistPolls: () => {}
      };
      const res = await pollCommands.handlePollCommand(
        mockSock,
        '!pollstatus -g "UnallowedGroup"',
        'dm@s.whatsapp.net',
        'User',
        nonAdminJid,
        {},
        context
      );
      assert.ok(res);
      assert.match(res, /Group "UnallowedGroup" was not found or is not in the allowed list/);
    });

    it('should allow !pollstatus with allowed group', async () => {
      const context = {
        activePolls: new Map(),
        recurringPolls: new Map(),
        latestPollIdByChat: new Map(),
        persistPolls: () => {}
      };
      const res = await pollCommands.handlePollCommand(
        mockSock,
        '!pollstatus --group="Bot-testing"',
        'dm@s.whatsapp.net',
        'User',
        nonAdminJid,
        {},
        context
      );
      assert.ok(res);
      assert.match(res, /No poll on record/);
    });
  });

  describe('Quiet hours with --group', () => {
    it('should reject !quiethours with unallowed group', async () => {
      const res = await pollCommands.handlePollCommand(
        mockSock,
        '!quiethours 10pm-7am --group="UnallowedGroup"',
        'dm@s.whatsapp.net',
        'Admin',
        adminJid,
        {},
        {}
      );
      assert.ok(res);
      assert.match(res, /Group "UnallowedGroup" was not found or is not in the allowed list/);
    });

    it('should reject !quiethours update from DM if sender is non-admin', async () => {
      const res = await pollCommands.handlePollCommand(
        mockSock,
        '!quiethours 10pm-7am --group="Bot-testing"',
        'dm@s.whatsapp.net',
        'NonAdmin',
        nonAdminJid,
        {},
        {}
      );
      assert.ok(res);
      assert.match(res, /Only group admins/);
    });

    it('should allow !quiethours update from DM if sender is admin of allowed group', async () => {
      const res = await pollCommands.handlePollCommand(
        mockSock,
        '!quiethours 10pm-7am --group="Bot-testing"',
        'dm@s.whatsapp.net',
        'Admin',
        adminJid,
        {},
        {}
      );
      assert.ok(res);
      assert.match(res, /Reminder quiet hours for \*Bot-testing\* updated to/);
    });
  });

  describe('Recurring poll commands with --group', () => {
    it('should reject !recurringpolls with unallowed group', async () => {
      const context = {
        recurringPolls: new Map(),
        persistPolls: () => {}
      };
      const res = await recurringCommands.handleRecurringCommand(
        mockSock,
        '!recurringpolls --group="UnallowedGroup"',
        'dm@s.whatsapp.net',
        'User',
        nonAdminJid,
        context
      );
      assert.ok(res);
      assert.match(res, /Group "UnallowedGroup" was not found or is not in the allowed list/);
    });

    it('should reject !recurringpoll schedule from DM if sender is not an admin', async () => {
      const context = {
        recurringPolls: new Map(),
        persistPolls: () => {}
      };
      const res = await recurringCommands.handleRecurringCommand(
        mockSock,
        '!recurringpoll 4 7pm on weekdays --group="Bot-testing"',
        'dm@s.whatsapp.net',
        'NonAdmin',
        nonAdminJid,
        context
      );
      assert.ok(res);
      assert.match(res, /Only group admins.*can schedule recurring polls for "Bot-testing"/);
    });

    it('should allow !recurringpoll schedule from DM if sender is an admin', async () => {
      const context = {
        recurringPolls: new Map(),
        persistPolls: () => {}
      };
      const res = await recurringCommands.handleRecurringCommand(
        mockSock,
        '!recurringpoll 4 7pm on weekdays --group="Bot-testing"',
        'dm@s.whatsapp.net',
        'Admin',
        adminJid,
        context
      );
      assert.ok(res);
      assert.match(res, /Scheduled Recurring Poll/);
      assert.equal(context.recurringPolls.size, 1);
      const sched = [...context.recurringPolls.values()][0];
      assert.equal(sched.remoteJid, allowedJid);
    });

    it('should support -g shorthand on recurring polls list and creation', async () => {
      const context = {
        recurringPolls: new Map(),
        persistPolls: () => {}
      };
      const res = await recurringCommands.handleRecurringCommand(
        mockSock,
        '!recurringpolls -g Bot-testing',
        'dm@s.whatsapp.net',
        'User',
        nonAdminJid,
        context
      );
      assert.ok(res);
      assert.match(res, /No recurring match polls scheduled yet/);
    });
  });
  describe("Disallow --group flag when sending commands from within group chat", () => {
    it("resolveTargetChat should reject --group when chatId is a group chat", async () => {
      const res = await resolveTargetChat(mockSock, allowedJid, adminJid, "Bot-testing", {}, { requireAdmin: false });
      assert.ok(res.error);
      assert.match(res.error, /The --group option can only be used when sending commands in a direct message \(DM\)/);
    });

    it("should reject poll creation with --group from within a group chat", async () => {
      const context = {
        activePolls: new Map(),
        latestPollIdByChat: new Map(),
        persistPolls: () => {}
      };
      const msg = { key: { participant: adminJid, remoteJid: allowedJid } };
      const res = await routeCommand(
        mockSock,
        '!createpoll 4 tomorrow 7pm --group="Bot-testing"',
        allowedJid,
        "Admin",
        msg,
        context
      );
      assert.ok(res);
      assert.match(res, /The --group option can only be used when sending commands in a direct message \(DM\)/);
    });

    it("should reject !pollstatus with --group from within a group chat", async () => {
      const context = {
        activePolls: new Map(),
        recurringPolls: new Map(),
        latestPollIdByChat: new Map(),
        persistPolls: () => {}
      };
      const res = await pollCommands.handlePollCommand(
        mockSock,
        '!pollstatus --group="Bot-testing"',
        allowedJid,
        "Admin",
        adminJid,
        {},
        context
      );
      assert.ok(res);
      assert.match(res, /The --group option can only be used when sending commands in a direct message \(DM\)/);
    });

    it("should reject !quiethours with --group from within a group chat", async () => {
      const res = await pollCommands.handlePollCommand(
        mockSock,
        '!quiethours 10pm-7am --group="Bot-testing"',
        allowedJid,
        "Admin",
        adminJid,
        {},
        {}
      );
      assert.ok(res);
      assert.match(res, /The --group option can only be used when sending commands in a direct message \(DM\)/);
    });

    it("should reject !recurringpolls with --group from within a group chat", async () => {
      const context = {
        recurringPolls: new Map(),
        persistPolls: () => {}
      };
      const res = await recurringCommands.handleRecurringCommand(
        mockSock,
        '!recurringpolls --group="Bot-testing"',
        allowedJid,
        "Admin",
        adminJid,
        context
      );
      assert.ok(res);
      assert.match(res, /The --group option can only be used when sending commands in a direct message \(DM\)/);
    });
  });
});
