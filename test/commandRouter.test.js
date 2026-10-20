const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { routeCommand, executeTool } = require('../lib/commands/index');

describe('commandRouter', () => {
  const dummyContext = {
    chatHistories: new Map(),
    groupMetadataCache: new Map(),
    messageStore: new Map(),
    activePolls: new Map(),
    latestPollIdByChat: new Map(),
    recurringPolls: new Map(),
    persistPolls: () => {},
    nameFor: (jid) => jid || 'Someone'
  };

  describe('routeCommand', () => {
    it('should reply to !ping with pong 🏓', async () => {
      const res = await routeCommand(null, '!ping', 'chat@g.us', 'Alice', {}, dummyContext);
      assert.equal(res, 'pong 🏓');
    });

    it('should reply to !help with help documentation', async () => {
      const res = await routeCommand(null, '!help', 'chat@g.us', 'Alice', {}, dummyContext);
      assert.match(res, /Tennis Group Bot/);
    });

    it('should handle !aliases', async () => {
      const res = await routeCommand(null, '!aliases', 'chat@g.us', 'Alice', {}, dummyContext);
      assert.match(res, /Player Names & Aliases|No player aliases/);
    });

    it('should handle !free and !notfree', async () => {
      const freeRes = await routeCommand(null, '!free tomorrow morning', 'chat@g.us', 'Alice', {}, dummyContext);
      assert.match(freeRes, /Alice is free tomorrow morning/);

      const notFreeRes = await routeCommand(null, '!notfree', 'chat@g.us', 'Alice', {}, dummyContext);
      assert.match(notFreeRes, /Removed Alice from the availability list/);
    });

    it('should detect and update matchups for an already resolved poll and send 🤖 reaction', async () => {
      const targetPoll = {
        remoteJid: 'chat@g.us',
        when: 'Today 9:00am',
        size: 4,
        status: 'resolved',
        lastPlayers: ['Alice', 'Bob', 'Charlie', 'Dave'],
        lastSchedule: null
      };

      const sentMessages = [];
      const dummySock = {
        user: { id: 'bot@s.whatsapp.net' },
        sendMessage: async (jid, payload) => {
          sentMessages.push({ jid, payload });
          return { key: { id: 'msg1' } };
        }
      };

      const pollContext = {
        ...dummyContext,
        activePolls: new Map([['poll_resolved_1', targetPoll]])
      };

      const dummyMsg = {
        key: { remoteJid: 'chat@g.us', id: 'upd_lineup_msg', fromMe: false }
      };

      const res = await routeCommand(
        dummySock,
        'Court 1: Alice & Charlie vs Bob & Dave',
        'chat@g.us',
        'Alice',
        dummyMsg,
        pollContext
      );

      assert.equal(res, null); // Handled manual lineup returns null (handled in chat with reaction)
      assert.deepEqual(targetPoll.lastPlayers, ['Alice', 'Charlie', 'Bob', 'Dave']);
      assert.ok(targetPoll.lastSchedule);
      const reactMsg = sentMessages.find((m) => m.payload?.react?.text === '🤖');
      assert.ok(reactMsg, 'Expected 🤖 bot emoji reaction to be sent for updated matchups');
      assert.equal(reactMsg.payload.react.key.id, 'upd_lineup_msg');
    });

    it('should return null for non-command messages so they fall through', async () => {
      const res = await routeCommand(null, 'hello everyone, who wants to hit today?', 'chat@g.us', 'Alice', {}, dummyContext);
      assert.equal(res, null);
    });
  });

  describe('executeTool', () => {
    it('should execute get_weather tool', async () => {
      const res = await executeTool(
        null,
        'chat@g.us',
        'Alice',
        { name: 'get_weather', input: { location: 'San Jose, CA' } },
        {},
        dummyContext
      );
      assert.equal(typeof res, 'string');
      assert.ok(res.length > 0);
    });

    it('should return Unknown tool for completely unknown tools', async () => {
      const res = await executeTool(
        null,
        'chat@g.us',
        'Alice',
        { name: 'completely_unknown_tool_xyz', input: {} },
        {},
        dummyContext
      );
      assert.equal(res, 'Unknown tool completely_unknown_tool_xyz');
    });
  });
});
