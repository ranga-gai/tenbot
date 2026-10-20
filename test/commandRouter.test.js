const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { routeCommand, executeTool, isAddressedToBot } = require('../lib/commands/index');
const { handleGroupLineup, getResponse } = require('../index');

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

    it('should return null for non-command messages so they fall through', async () => {
      const res = await routeCommand(null, 'hello everyone, who wants to hit today?', 'chat@g.us', 'Alice', {}, dummyContext);
      assert.equal(res, null);
    });

    it('should return null for unhandled queries to bot', async () => {
      const targetPoll = {
        remoteJid: 'chat@g.us',
        status: 'active'
      };
      const pollContext = {
        ...dummyContext,
        activePolls: new Map([['poll1', targetPoll]])
      };
      const res = await routeCommand(
        null,
        'who should I put my money on today for the win.',
        'chat@g.us',
        'PI',
        {},
        pollContext
      );
      assert.equal(res, null, 'Should return null for non-command queries so they fall through to general LLM');
    });
  });

  describe('handleGroupLineup in index.js', () => {
    it('should detect manual lineup, attribute to poll, record draw, and react with 🤖', async () => {
      const targetPoll = {
        remoteJid: 'chat@g.us',
        when: 'Today 9:00am',
        size: 4,
        type: 'fixed',
        status: 'resolved',
        lastPlayers: ['Alice', 'Bob', 'Charlie', 'Dave']
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

      const res = await handleGroupLineup(
        dummySock,
        'Court 1: Alice & Charlie vs Bob & Dave',
        'chat@g.us',
        'Alice',
        dummyMsg,
        pollContext
      );

      assert.equal(res, true); // Handled manual lineup returns true
      assert.deepEqual(targetPoll.lastPlayers, ['Alice', 'Charlie', 'Bob', 'Dave']);
      assert.ok(targetPoll.lastSchedule);
      const reactMsg = sentMessages.find((m) => m.payload?.react?.text === '🤖');
      assert.ok(reactMsg, 'Expected 🤖 bot emoji reaction to be sent for updated matchups');
      assert.equal(reactMsg.payload.react.key.id, 'upd_lineup_msg');
    });

    it('should return null for non-lineup messages', async () => {
      const targetPoll = {
        remoteJid: 'chat@g.us',
        status: 'active'
      };
      const pollContext = {
        ...dummyContext,
        activePolls: new Map([['poll1', targetPoll]])
      };
      const res = await handleGroupLineup(
        null,
        'hello everyone, who wants to hit today?',
        'chat@g.us',
        'Alice',
        {},
        pollContext
      );
      assert.equal(res, null);
    });
  });

  describe('isAddressedToBot', () => {
    const botJids = ['1234567890@s.whatsapp.net', '24104010813588@lid'];

    it('should recognize leading @tenbot trigger', () => {
      const res = isAddressedToBot('@tenbot create a poll for 9am', {}, botJids);
      assert.equal(res.addressed, true);
      assert.equal(res.promptText, 'create a poll for 9am');
    });

    it('should recognize @botNumber prefix directly in text without mentionedJid', () => {
      const res = isAddressedToBot('@24104010813588 who should I put my money on today for the win.', {}, botJids);
      assert.equal(res.addressed, true);
      assert.equal(res.promptText, 'who should I put my money on today for the win.');
    });

    it('should recognize @tenbot mentioned in contextInfo.mentionedJid', () => {
      const msg = {
        message: {
          extendedTextMessage: {
            contextInfo: {
              mentionedJid: ['1234567890@s.whatsapp.net']
            }
          }
        }
      };
      const res = isAddressedToBot('@1234567890 what is the schedule', msg, botJids);
      assert.equal(res.addressed, true);
      assert.equal(res.promptText, 'what is the schedule');
    });

    it('should not be addressed when another user is mentioned', () => {
      const msg = {
        message: {
          extendedTextMessage: {
            contextInfo: {
              mentionedJid: ['9999999999@s.whatsapp.net']
            }
          }
        }
      };
      const res = isAddressedToBot('hey @9999999999 are you playing today?', msg, botJids);
      assert.equal(res.addressed, false);
      assert.equal(res.promptText, 'hey @9999999999 are you playing today?');
    });
  });

  describe('executeTool', () => {
    it('should dispatch parse_lineup to executeLineupTool', async () => {
      const targetPoll = {
        remoteJid: 'chat@g.us',
        when: 'Today 9:00am',
        size: 4,
        status: 'active',
        lastPlayers: ['Alice', 'Bob', 'Charlie', 'Dave']
      };
      const pollContext = {
        ...dummyContext,
        activePolls: new Map([['poll_1', targetPoll]])
      };
      const res = await executeTool(
        null,
        'chat@g.us',
        'Alice',
        {
          name: 'parse_lineup',
          input: { text: 'Court 1: Alice & Bob vs Charlie & Dave at 9:00am' }
        },
        { key: { id: 'msg1', remoteJid: 'chat@g.us' } },
        pollContext
      );
      assert.match(res, /Successfully parsed and recorded lineup/);
    });

    it('should return error message for unknown tool', async () => {
      const res = await executeTool(null, 'chat@g.us', 'Alice', { name: 'non_existent_tool', input: {} }, {}, dummyContext);
      assert.match(res, /Unknown tool/);
    });
  });
});
