const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isSamePlayerName,
  extractTimeFromLineupMessage,
  getPollMatchTime,
  findBestMatchingPollForLineup,
  handleManualLineup,
  executeLineupTool,
  LINEUP_PARSER_TOOL
} = require('../lib/commands/lineupCommands');

describe('lineupCommands', () => {
  describe('LINEUP_PARSER_TOOL', () => {
    it('should be defined with valid tool name and schema', () => {
      assert.equal(LINEUP_PARSER_TOOL.name, 'parse_lineup');
      assert.equal(typeof LINEUP_PARSER_TOOL.description, 'string');
      assert.ok(LINEUP_PARSER_TOOL.description.length > 0);
      assert.equal(LINEUP_PARSER_TOOL.input_schema.type, 'object');
      assert.ok(LINEUP_PARSER_TOOL.input_schema.properties.isLineup);
      assert.ok(LINEUP_PARSER_TOOL.input_schema.properties.players);
      assert.ok(LINEUP_PARSER_TOOL.input_schema.properties.sets);
      assert.deepEqual(LINEUP_PARSER_TOOL.input_schema.required, ['isLineup']);
    });
  });

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
    it('should match a resolved poll when updating matchups even if another poll is active in the same chat', () => {
      const activePolls = new Map([
        ['poll_resolved_today', {
          remoteJid: 'test_chat@g.us',
          when: 'Today 9:00am',
          size: 4,
          status: 'resolved',
          lastPlayers: ['Alice', 'Bob', 'Charlie', 'Dave']
        }],
        ['poll_active_tomorrow', {
          remoteJid: 'test_chat@g.us',
          when: 'Tomorrow 9:00am',
          size: 4,
          status: 'active',
          lastPlayers: ['Eve', 'Frank', 'Grace', 'Heidi']
        }]
      ]);

      const updatedLineup = {
        players: ['Alice', 'Charlie', 'Bob', 'Dave'],
        time: '9:00am'
      };

      const res = findBestMatchingPollForLineup({
        activePolls,
        chatId: 'test_chat@g.us',
        lineup: updatedLineup,
        messageText: 'Updated 9:00am matchups: Alice & Charlie vs Bob & Dave',
        mePn: 'bot@s.whatsapp.net'
      });

      assert.equal(res.targetPollId, 'poll_resolved_today');
      assert.match(res.matchInfo, /exact_players_and_time/);
    });

    it('should match a resolved poll on player overlap when updating matchups without time', () => {
      const activePolls = new Map([
        ['poll_resolved', {
          remoteJid: 'test_chat@g.us',
          when: '6:00pm',
          size: 4,
          status: 'resolved',
          lastPlayers: ['Alice', 'Bob', 'Charlie', 'Dave']
        }],
        ['poll_other_active', {
          remoteJid: 'test_chat@g.us',
          when: '8:00pm',
          size: 4,
          status: 'active',
          lastPlayers: ['PlayerX', 'PlayerY', 'PlayerZ', 'PlayerW']
        }]
      ]);

      const updatedLineup = {
        players: ['Alice', 'Charlie', 'Bob', 'Dave'],
        time: null
      };

      const res = findBestMatchingPollForLineup({
        activePolls,
        chatId: 'test_chat@g.us',
        lineup: updatedLineup,
        messageText: 'Updated matchups: Court 1: Alice & Charlie vs Bob & Dave',
        mePn: 'bot@s.whatsapp.net'
      });

      assert.equal(res.targetPollId, 'poll_resolved');
      assert.match(res.matchInfo, /qualifying_match/);
    });
  });

  describe('handleManualLineup', () => {
    it('should update lastPlayers, lastSchedule and send 🤖 reaction on a resolved poll', async () => {
      const targetPoll = {
        remoteJid: 'test_chat@g.us',
        when: 'Today 9:00am',
        size: 4,
        status: 'resolved',
        lastPlayers: ['Alice', 'Bob', 'Charlie', 'Dave'],
        lastSchedule: null
      };

      const activePolls = new Map([['poll_resolved', targetPoll]]);
      const sentMessages = [];
      const dummySock = {
        user: { id: 'bot@s.whatsapp.net' },
        sendMessage: async (jid, payload) => {
          sentMessages.push({ jid, payload });
          return { key: { id: 'msg1' } };
        }
      };

      const newLineup = {
        type: 'doubles',
        time: '9:00am',
        players: ['Alice', 'Charlie', 'Bob', 'Dave'],
        sets: [{
          set: 1,
          courts: [{ court: 1, teamA: ['Alice', 'Charlie'], teamB: ['Bob', 'Dave'] }]
        }]
      };

      let persisted = false;
      const context = {
        activePolls,
        persistPolls: () => { persisted = true; },
        messageStore: new Map()
      };

      const dummyMsg = {
        key: { remoteJid: 'test_chat@g.us', id: 'lineup_msg_123', fromMe: false }
      };

      await handleManualLineup(
        dummySock,
        'test_chat@g.us',
        'Alice',
        newLineup,
        dummyMsg,
        'Updated matchups: Court 1: Alice & Charlie vs Bob & Dave',
        context
      );

      assert.equal(targetPoll.status, 'resolved');
      assert.deepEqual(targetPoll.lastPlayers, ['Alice', 'Charlie', 'Bob', 'Dave']);
      assert.deepEqual(targetPoll.lastSchedule, newLineup);
      assert.equal(persisted, true);

      // Verify bot emoji 🤖 reaction was sent
      const reactMsg = sentMessages.find((m) => m.payload?.react?.text === '🤖');
      assert.ok(reactMsg, 'Expected 🤖 bot emoji reaction to be sent');
      assert.equal(reactMsg.payload.react.key.id, 'lineup_msg_123');
    });
  });

  describe('executeLineupTool', () => {
    it('should parse deterministic lineup text and record to matching poll', async () => {
      const targetPoll = {
        remoteJid: 'test_chat@g.us',
        name: 'Tennis 9am',
        when: 'Today 9:00am',
        size: 4,
        status: 'active',
        lastPlayers: ['Alice', 'Bob', 'Charlie', 'Dave']
      };
      const activePolls = new Map([['poll_9am', targetPoll]]);
      let persisted = false;
      const context = {
        activePolls,
        persistPolls: () => { persisted = true; },
        messageStore: new Map()
      };
      const dummySock = {
        user: { id: 'bot@s.whatsapp.net' },
        sendMessage: async () => ({ key: { id: 'msg1' } })
      };
      const dummyMsg = {
        key: { remoteJid: 'test_chat@g.us', id: 'tool_msg_1', fromMe: false }
      };

      const res = await executeLineupTool(
        dummySock,
        'parse_lineup',
        { text: 'Court 1: Alice & Bob vs Charlie & Dave at 9:00am' },
        'Alice',
        'test_chat@g.us',
        dummyMsg,
        context
      );

      assert.match(res, /Successfully parsed and recorded lineup/);
      assert.match(res, /Tennis 9am/);
      assert.equal(targetPoll.status, 'resolved');
      assert.deepEqual(targetPoll.lastPlayers, ['Alice', 'Bob', 'Charlie', 'Dave']);
      assert.equal(persisted, true);
    });

    it('should handle pre-structured lineup input directly', async () => {
      const targetPoll = {
        remoteJid: 'test_chat@g.us',
        when: 'Today 6:00pm',
        size: 4,
        status: 'active',
        lastPlayers: ['Alice', 'Bob', 'Charlie', 'Dave']
      };
      const activePolls = new Map([['poll_6pm', targetPoll]]);
      const context = {
        activePolls,
        persistPolls: () => {},
        messageStore: new Map()
      };

      const res = await executeLineupTool(
        null,
        'parse_lineup',
        {
          pollId: 'poll_6pm',
          lineup: {
            type: 'doubles',
            time: '6:00pm',
            players: ['Alice', 'Charlie', 'Bob', 'Dave'],
            sets: [{
              set: 1,
              courts: [{ court: 2, teamA: ['Alice', 'Charlie'], teamB: ['Bob', 'Dave'] }]
            }]
          }
        },
        'Alice',
        'test_chat@g.us',
        null,
        context
      );

      assert.match(res, /Successfully parsed and recorded lineup/);
      assert.equal(targetPoll.status, 'resolved');
      assert.deepEqual(targetPoll.lastPlayers, ['Alice', 'Charlie', 'Bob', 'Dave']);
    });

    it('should return helpful error message when input cannot be parsed', async () => {
      const context = {
        activePolls: new Map(),
        persistPolls: () => {},
        messageStore: new Map()
      };

      const res = await executeLineupTool(
        null,
        'parse_lineup',
        { text: 'Are we playing tennis today?' },
        'Alice',
        'test_chat@g.us',
        null,
        context
      );

      assert.match(res, /Could not parse a valid match lineup/);
    });
  });
});
