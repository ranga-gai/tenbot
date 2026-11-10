process.env.NODE_ENV = 'test';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { parseMultiTimeSlots } = require('../lib/pollTime');
const {
  parsePollCreationText,
  createMatchPoll,
  resolveMultiTimePollRoster,
  processPollVoteEvent,
  generateMatchupsFromPoll,
  checkPendingLineupGenerations,
  handleSetPollSlots,
  pollStatusText
} = require('../lib/commands/pollCommands');
const {
  extractCommonFlags,
  parseRecurringPollText,
  scheduleRecurringPoll,
  checkAndPostRecurringPolls,
  simulateRecurringPoll
} = require('../lib/recurringPolls');
const scvcc = require('../lib/scvcc');
const groupsConfig = require('../lib/groupsConfig');
const namesStore = require('../lib/names');

function hashOptionName(optName) {
  return crypto.createHash('sha256').update(Buffer.from(optName, 'utf8')).digest();
}

describe('Multi-Time Poll Feature', () => {
  describe('parseMultiTimeSlots', () => {
    it('parses multiple times on the same day with global default size or unlimited', () => {
      const slotsUnlimited = parseMultiTimeSlots('Saturday 8am, 9:30am, 4pm', 'Saturday', null);
      assert.ok(Array.isArray(slotsUnlimited));
      assert.equal(slotsUnlimited.length, 3);
      assert.equal(slotsUnlimited[0].dayWord, 'Saturday');
      assert.equal(slotsUnlimited[0].timeWord, '8am');
      assert.equal(slotsUnlimited[0].size, null);
      assert.equal(slotsUnlimited[1].dayWord, 'Saturday');
      assert.equal(slotsUnlimited[1].timeWord, '9:30am');
      assert.equal(slotsUnlimited[2].timeWord, '4pm');

      const slotsSized = parseMultiTimeSlots('Saturday 8am, 9:30am', 'Saturday', 4);
      assert.equal(slotsSized.length, 2);
      assert.equal(slotsSized[0].size, 4);
      assert.equal(slotsSized[1].size, 4);
    });

    it('parses per-slot capacities including parenthetical, colon, unlimited, and auto', () => {
      const slots = parseMultiTimeSlots('Saturday 8am(4), 9:30am(8), 4pm(unlimited)', 'Saturday', 4);
      assert.ok(Array.isArray(slots));
      assert.equal(slots.length, 3);
      assert.equal(slots[0].size, 4);
      assert.equal(slots[0].explicitSize, true);
      assert.equal(slots[1].size, 8);
      assert.equal(slots[1].explicitSize, true);
      assert.equal(slots[2].size, null);
      assert.equal(slots[2].explicitSize, true);

      const colonSlots = parseMultiTimeSlots('Sat 8am:4, Sun 9:30am:8', null, null);
      assert.ok(Array.isArray(colonSlots));
      assert.equal(colonSlots.length, 2);
      assert.equal(colonSlots[0].dayWord, 'Sat');
      assert.equal(colonSlots[0].size, 4);
      assert.equal(colonSlots[1].dayWord, 'Sun');
      assert.equal(colonSlots[1].size, 8);
    });

    it('returns null when only a single time is present', () => {
      const single = parseMultiTimeSlots('Saturday 8am', 'Saturday', 4);
      assert.equal(single, null);
    });
  });

  describe('parsePollCreationText & extractCommonFlags for multi-time polls', () => {
    it('extracts timeSlots, multiVote, and multiSessionMode flags', () => {
      const p1 = parsePollCreationText('!poll Saturday 8am(4), 9:30am(8), 4pm(unlimited)');
      assert.ok(p1);
      assert.ok(Array.isArray(p1.timeSlots));
      assert.equal(p1.timeSlots.length, 3);
      assert.equal(p1.multiVote, true);
      assert.equal(p1.multiSessionMode, null);

      const p2 = parsePollCreationText('!poll 4 Saturday 8am, 9:30am --single-vote --single-session');
      assert.ok(p2);
      assert.ok(Array.isArray(p2.timeSlots));
      assert.equal(p2.timeSlots.length, 2);
      assert.equal(p2.multiVote, false);
      assert.equal(p2.multiSessionMode, 'single_session');
    });
  });

  describe('createMatchPoll for multi-time polls', () => {
    it('creates a multi-time poll with No / Can\'t play option, no creator auto-included, and selectableCount=0 by default', async () => {
      const sentMessages = [];
      const mockSock = {
        sendMessage: async (jid, content) => {
          sentMessages.push({ jid, content });
          return {
            key: { remoteJid: jid, id: 'multi_poll_1', fromMe: true },
            message: {
              pollCreationMessage: {
                name: content.poll.name,
                options: content.poll.values.map((v) => ({ optionName: v })),
                selectableOptionsCount: content.poll.selectableCount
              }
            }
          };
        }
      };
      const activePolls = new Map();
      const messageStore = new Map();
      const latestPollIdByChat = new Map();
      const context = {
        activePolls,
        messageStore,
        latestPollIdByChat,
        persistPolls: () => {}
      };

      const res = await createMatchPoll(
        mockSock,
        '120363403838804497@g.us',
        null,
        'Saturday 8am(4), 9:30am(8), 4pm',
        'Saturday',
        null,
        'Pramod',
        '11111@s.whatsapp.net',
        true, // even if true is passed, multi-time polls do not auto-include creator
        null,
        false,
        true,
        false,
        false, // checkCourts = false
        false,
        false,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        context,
        {}
      );

      assert.equal(res.err, null);
      assert.equal(res.isMultiTime, true);
      assert.equal(res.selectableCount, 0);
      assert.deepEqual(res.options, [
        '8 AM (4 spots)',
        '9:30 AM (8 spots)',
        '4 PM',
        "No / Can't play"
      ]);

      const state = activePolls.get('multi_poll_1');
      assert.ok(state);
      assert.equal(state.type, 'multi_time');
      assert.equal(state.creator, null);
      assert.equal(state.multiVote, true);
      assert.equal(state.multiSessionMode, 'independent');
      assert.equal(state.timeSlots.length, 3);
      assert.equal(state.timeSlots[0].slotLimit, 4);
      assert.equal(state.timeSlots[1].slotLimit, 8);
      assert.equal(state.timeSlots[2].slotLimit, null);
    });

    it('supports single-vote mode (selectableCount=1) and multi-day labels', async () => {
      const sentMessages = [];
      const mockSock = {
        sendMessage: async (jid, content) => {
          sentMessages.push({ jid, content });
          return { key: { remoteJid: jid, id: 'multi_poll_2', fromMe: true }, message: {} };
        }
      };
      const activePolls = new Map();
      const context = {
        activePolls,
        messageStore: new Map(),
        latestPollIdByChat: new Map(),
        persistPolls: () => {}
      };

      const res = await createMatchPoll(
        mockSock,
        '120363403838804497@g.us',
        4,
        'Friday 8am, Saturday 9:30am',
        null,
        null,
        'Pramod',
        '11111@s.whatsapp.net',
        false,
        null,
        false,
        true,
        false,
        false,
        false,
        false,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        context,
        { multiVote: false, multiSessionMode: 'single_session' }
      );

      assert.equal(res.err, null);
      assert.equal(res.selectableCount, 1);
      assert.equal(res.multiVote, false);
      assert.equal(res.multiSessionMode, 'single_session');
      assert.deepEqual(res.options, [
        'Friday 8 AM (4 spots)',
        'Saturday 9:30 AM (4 spots)',
        "No / Can't play"
      ]);
    });

    it('pre-seeds prebooked court players into slot.preseededPlayers when --pre-allocate-slots is enabled and court options are provided', async () => {
      const origCheckAvail = scvcc.checkCourtAvailability;
      const origGetBookings = scvcc.getCourtBookings;
      const origIsBookingEnabled = groupsConfig.isCourtBookingEnabled;
      try {
        groupsConfig.isCourtBookingEnabled = () => true;
        scvcc.checkCourtAvailability = async ({ time }) => ({
          slots: [{
            courts: [
              {
                court: time.toLowerCase().includes('8am') ? 'Court 2' : 'Court 3',
                status: 'prebooked',
                prebookedBy: time.toLowerCase().includes('8am') ? 'Conrad Rodricks' : 'Vijay Parthasarathy',
                prebookedFullName: time.toLowerCase().includes('8am') ? 'Conrad Rodricks' : 'Vijay Parthasarathy',
                durationMins: 90
              }
            ]
          }]
        });
        scvcc.getCourtBookings = async () => ({ bookings: [] });

        const activePolls = new Map();
        const context = {
          activePolls,
          messageStore: new Map(),
          latestPollIdByChat: new Map(),
          persistPolls: () => {}
        };
        const mockSock = {
          sendMessage: async (jid, content) => ({
            key: { remoteJid: jid, id: 'multi_poll_courts', fromMe: true },
            message: {}
          })
        };

        const res = await createMatchPoll(
          mockSock,
          '120363403838804497@g.us',
          4,
          'Saturday 8am, 9:30am',
          'Saturday',
          null,
          'Pramod',
          '11111@s.whatsapp.net',
          false,
          null,
          false,
          true,
          false,
          true, // checkCourts = true
          true, // includePrebookedSpots = true (--pre-allocate-slots)
          false,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          context,
          {}
        );

        assert.equal(res.err, null);
        const state = activePolls.get('multi_poll_courts');
        assert.ok(state);
        assert.equal(state.timeSlots[0].preseededPlayers.length, 1);
        assert.ok(state.timeSlots[0].preseededPlayers[0].defaultPlayer.toLowerCase().includes('conrad'));
        assert.equal(state.timeSlots[1].preseededPlayers.length, 1);
        assert.ok(state.timeSlots[1].preseededPlayers[0].defaultPlayer.toLowerCase().includes('vijay'));

        // Verify resolveMultiTimePollRoster includes preseededPlayers in the slot roster
        const rosters = resolveMultiTimePollRoster(state, []);
        assert.equal(rosters[0].players.length, 1);
        assert.ok(rosters[0].players[0].toLowerCase().includes('conrad'));
        assert.equal(rosters[1].players.length, 1);
        assert.ok(rosters[1].players[0].toLowerCase().includes('vijay'));
      } finally {
        scvcc.checkCourtAvailability = origCheckAvail;
        scvcc.getCourtBookings = origGetBookings;
        groupsConfig.isCourtBookingEnabled = origIsBookingEnabled;
      }
    });
  });

  describe('resolveMultiTimePollRoster & session modes', () => {
    it('supports independent mode (default) and single_session mode deduplication', () => {
      namesStore.setName('p1@s.whatsapp.net', 'Alice');
      namesStore.setName('p2@s.whatsapp.net', 'Bob');
      namesStore.setName('p3@s.whatsapp.net', 'Charlie');
      namesStore.setName('p4@s.whatsapp.net', 'Dave');
      namesStore.setName('p5@s.whatsapp.net', 'Eve');

      const baseSlots = () => [
        {
          label: '8:00am',
          optionLabel: '8:00am (4 spots)',
          size: 4,
          slotLimit: 4,
          status: 'active',
          preseededPlayers: []
        },
        {
          label: '9:30am',
          optionLabel: '9:30am (4 spots)',
          size: 4,
          slotLimit: 4,
          status: 'active',
          preseededPlayers: []
        }
      ];

      const aggregated = [
        {
          name: '8:00am (4 spots)',
          voters: ['p1@s.whatsapp.net', 'p2@s.whatsapp.net', 'p3@s.whatsapp.net', 'p4@s.whatsapp.net', 'p5@s.whatsapp.net']
        },
        {
          name: '9:30am (4 spots)',
          voters: ['p1@s.whatsapp.net', 'p2@s.whatsapp.net', 'p5@s.whatsapp.net']
        },
        {
          name: "No / Can't play",
          voters: []
        }
      ];

      // 1. Independent mode: Alice & Bob are in BOTH 8:00am and 9:30am; Eve is excess (5th) in 8:00am and active in 9:30am
      const pollIndependent = {
        type: 'multi_time',
        multiSessionMode: 'independent',
        timeSlots: baseSlots(),
        voteBuffer: new Map()
      };
      const rInd = resolveMultiTimePollRoster(pollIndependent, aggregated);
      assert.deepEqual(rInd[0].players, ['Alice', 'Bob', 'Charlie', 'Dave']);
      assert.deepEqual(rInd[0].excessPlayers, ['Eve']);
      assert.equal(rInd[0].isAllFilled, true);
      assert.deepEqual(rInd[1].players, ['Alice', 'Bob', 'Eve']);

      // 2. Single-session mode: Since 8:00am is filled with Alice, Bob, Charlie, Dave, Alice & Bob are deduplicated from 9:30am, leaving Eve in 9:30am!
      const pollSingleSession = {
        type: 'multi_time',
        multiSessionMode: 'single_session',
        timeSlots: baseSlots(),
        voteBuffer: new Map()
      };
      const rSingle = resolveMultiTimePollRoster(pollSingleSession, aggregated);
      assert.deepEqual(rSingle[0].players, ['Alice', 'Bob', 'Charlie', 'Dave']);
      assert.deepEqual(rSingle[1].players, ['Eve']);
      assert.deepEqual(rSingle[1].skippedForOtherSession, ['Alice', 'Bob']);
    });
  });

  describe('Lineup generation modes, !setslots, and !pollstatus for multi-time polls', () => {
    it('auto-generates matchups for a filled slot in filled mode and warns excess voters', async () => {
      namesStore.setName('u1@s.whatsapp.net', 'Alice');
      namesStore.setName('u2@s.whatsapp.net', 'Bob');
      namesStore.setName('u3@s.whatsapp.net', 'Charlie');
      namesStore.setName('u4@s.whatsapp.net', 'Dave');
      namesStore.setName('u5@s.whatsapp.net', 'Eve');

      const sentTexts = [];
      const mockSock = {
        user: { id: 'bot@s.whatsapp.net' },
        sendMessage: async (jid, content) => {
          if (content.text) sentTexts.push(content.text);
          return {
            key: { remoteJid: jid, id: 'mt_poll_vote_1', fromMe: true },
            message: {
              pollCreationMessage: {
                name: '🎾 Saturday (Vote for time(s))',
                options: [
                  { optionName: '8 AM (4 spots)' },
                  { optionName: '9:30 AM' },
                  { optionName: "No / Can't play" }
                ],
                selectableOptionsCount: 0
              }
            }
          };
        }
      };

      const activePolls = new Map();
      const messageStore = new Map();
      const latestPollIdByChat = new Map();
      const context = {
        activePolls,
        messageStore,
        latestPollIdByChat,
        persistPolls: () => {}
      };

      await createMatchPoll(
        mockSock,
        '120363403838804497@g.us',
        null,
        'Saturday 8am(4), 9:30am(unlimited)',
        'Saturday',
        null,
        'Pramod',
        '11111@s.whatsapp.net',
        false,
        null,
        false,
        true,
        false,
        false,
        false,
        false,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        context,
        { lineupGeneration: 'filled' }
      );

      const pollState = activePolls.get('mt_poll_vote_1');
      assert.ok(pollState);

      const opt8amHash = hashOptionName('8 AM (4 spots)');
      const opt930Hash = hashOptionName('9:30 AM');

      // 5 players vote for 8:00am (4 spots), and 2 players also vote for 9:30am
      const updates = [
        { pollUpdateMessageKey: { participant: 'u1@s.whatsapp.net' }, vote: { selectedOptions: [opt8amHash, opt930Hash] }, senderTimestampMs: 1000 },
        { pollUpdateMessageKey: { participant: 'u2@s.whatsapp.net' }, vote: { selectedOptions: [opt8amHash, opt930Hash] }, senderTimestampMs: 2000 },
        { pollUpdateMessageKey: { participant: 'u3@s.whatsapp.net' }, vote: { selectedOptions: [opt8amHash] }, senderTimestampMs: 3000 },
        { pollUpdateMessageKey: { participant: 'u4@s.whatsapp.net' }, vote: { selectedOptions: [opt8amHash] }, senderTimestampMs: 4000 },
        { pollUpdateMessageKey: { participant: 'u5@s.whatsapp.net' }, vote: { selectedOptions: [opt8amHash] }, senderTimestampMs: 5000 }
      ];

      await processPollVoteEvent(
        mockSock,
        { remoteJid: '120363403838804497@g.us', id: 'mt_poll_vote_1' },
        updates,
        context
      );

      // Should have sent an excess warning for Eve on 8:00am AND generated matchups for 8:00am
      assert.ok(sentTexts.some((t) => t.includes('already full') && t.includes('8 AM')));
      assert.ok(sentTexts.some((t) => t.includes('8 AM') && t.includes('Set 1')));
      assert.equal(pollState.timeSlots[0].status, 'resolved');
      assert.equal(pollState.timeSlots[1].status, 'active');

      // Test pollStatusText output
      const statusOut = pollStatusText('120363403838804497@g.us', {}, context);
      assert.ok(statusOut.includes('Multi-Time Poll'));
      assert.ok(statusOut.includes('*8 AM* [resolved] (4/4)'));
      assert.ok(statusOut.includes('Waitlist/Excess (1): Eve'));
      assert.ok(statusOut.includes('*9:30 AM* [active] (2 (unlimited))'));

      // Test !setslots on the 9:30am slot
      const setSlotsOut = await handleSetPollSlots(
        mockSock,
        '120363403838804497@g.us',
        'Pramod',
        '11111@s.whatsapp.net',
        '9:30 AM',
        '4',
        context
      );
      assert.ok(setSlotsOut.includes('Updated slot limit (4 spots)'));
      assert.equal(pollState.timeSlots[1].slotLimit, 4);
    });

    it('generates lineups at leadTime deadline for unlimited slots or fallback mode in checkPendingLineupGenerations', async () => {
      namesStore.setName('u1@s.whatsapp.net', 'Alice');
      namesStore.setName('u2@s.whatsapp.net', 'Bob');
      namesStore.setName('u3@s.whatsapp.net', 'Charlie');
      namesStore.setName('u4@s.whatsapp.net', 'Dave');

      const sentTexts = [];
      const mockSock = {
        user: { id: 'bot@s.whatsapp.net' },
        sendMessage: async (jid, content) => {
          if (content.text) sentTexts.push(content.text);
          return {
            key: { remoteJid: jid, id: 'mt_poll_deadline', fromMe: true },
            message: {
              pollCreationMessage: {
                name: '🎾 Saturday (Vote for time(s))',
                options: [
                  { optionName: '8 AM' },
                  { optionName: '9:30 AM' },
                  { optionName: "No / Can't play" }
                ],
                selectableOptionsCount: 0
              }
            }
          };
        }
      };

      const activePolls = new Map();
      const messageStore = new Map();
      const context = {
        activePolls,
        messageStore,
        latestPollIdByChat: new Map(),
        persistPolls: () => {}
      };

      await createMatchPoll(
        mockSock,
        '120363403838804497@g.us',
        null,
        'Saturday 8am, 9:30am',
        'Saturday',
        null,
        'Pramod',
        '11111@s.whatsapp.net',
        false,
        null,
        false,
        true,
        false,
        false,
        false,
        false,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        context,
        { lineupGeneration: 'filled', lineupLeadTime: 30 }
      );

      const pollState = activePolls.get('mt_poll_deadline');
      const opt8amHash = hashOptionName('8 AM');
      await processPollVoteEvent(
        mockSock,
        { remoteJid: '120363403838804497@g.us', id: 'mt_poll_deadline' },
        [
          { pollUpdateMessageKey: { participant: 'u1@s.whatsapp.net' }, vote: { selectedOptions: [opt8amHash] }, senderTimestampMs: 1000 },
          { pollUpdateMessageKey: { participant: 'u2@s.whatsapp.net' }, vote: { selectedOptions: [opt8amHash] }, senderTimestampMs: 2000 },
          { pollUpdateMessageKey: { participant: 'u3@s.whatsapp.net' }, vote: { selectedOptions: [opt8amHash] }, senderTimestampMs: 3000 },
          { pollUpdateMessageKey: { participant: 'u4@s.whatsapp.net' }, vote: { selectedOptions: [opt8amHash] }, senderTimestampMs: 4000 }
        ],
        context
      );

      // Unlimited slot does not auto-generate immediately on 4th vote (since more players may vote)
      assert.equal(pollState.timeSlots[0].status, 'active');

      // Advance clock to 20 mins before 8:00am slot playAt (inside 30m lead time)
      const slot0PlayAtMs = new Date(pollState.timeSlots[0].playAt).getTime();
      const resIds = await checkPendingLineupGenerations(mockSock, context, slot0PlayAtMs - 20 * 60 * 1000);
      assert.ok(resIds.includes('mt_poll_deadline'));
      assert.equal(pollState.timeSlots[0].status, 'resolved');
      assert.ok(sentTexts.some((t) => t.includes('8 AM') && t.includes('Set 1')));
    });
  });

  describe('Recurring Multi-Time Polls', () => {
    it('schedules, formats, simulates, and posts a multi-time recurring poll', async () => {
      const parsed = parseRecurringPollText('!recurringpoll Saturday 8am(4), 9:30am(8) post at Friday 6pm --single-session');
      assert.ok(parsed);
      assert.equal(parsed.action, 'create');
      assert.ok(Array.isArray(parsed.timeSlots));
      assert.equal(parsed.timeSlots.length, 2);
      assert.equal(parsed.timeSlots[0].size, 4);
      assert.equal(parsed.timeSlots[1].size, 8);
      assert.equal(parsed.multiSessionMode, 'single_session');

      const recurringPolls = new Map();
      const cardMsg = await scheduleRecurringPoll({
        recurringPolls,
        persistPolls: () => {},
        targetChatId: '120363403838804497@g.us',
        sender: 'Pramod',
        senderJid: '11111@s.whatsapp.net',
        params: parsed
      });

      assert.ok(cardMsg.includes('Multi-time (2 time slots'));
      assert.ok(cardMsg.includes('1 session/player'));
      const sched = [...recurringPolls.values()][0];
      assert.ok(sched);
      assert.equal(sched.isMultiTime, true);
      assert.equal(sched.timeSlots.length, 2);

      // Simulate the recurring multi-time poll
      const simOut = await simulateRecurringPoll({
        sock: null,
        recurringPolls,
        scheduleId: sched.id,
        chatId: '120363403838804497@g.us',
        sender: 'Pramod',
        senderJid: '11111@s.whatsapp.net'
      });
      assert.ok(simOut.includes('Multi-time (2 time options'));
    });
  });
});
