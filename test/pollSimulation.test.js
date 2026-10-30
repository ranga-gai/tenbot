const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const pollCommands = require('../lib/commands/pollCommands');
const recurringCommands = require('../lib/commands/recurringCommands');
const recurringPollsModule = require('../lib/recurringPolls');
const { routeCommand, executeTool } = require('../lib/commands/index');
const scvcc = require('../lib/scvcc');
const groupsConfig = require('../lib/groupsConfig');

describe('pollSimulation', () => {
  function createMockSock() {
    const sentMessages = [];
    return {
      sentMessages,
      sendMessage: async (jid, msg, opts) => {
        const id = `poll_msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const sent = { key: { id, remoteJid: jid }, message: msg };
        sentMessages.push({ jid, msg, sent, opts });
        return sent;
      }
    };
  }

  describe('createMatchPoll simulation mode', () => {
    it('should generate a mock throwaway poll without saving to activePolls or disk', async () => {
      const sock = createMockSock();
      const activePolls = new Map();
      const messageStore = new Map();
      const latestPollIdByChat = new Map();
      let persistCalled = false;
      const persistPolls = () => { persistCalled = true; };

      const context = {
        activePolls,
        messageStore,
        latestPollIdByChat,
        persistPolls
      };

      const res = await pollCommands.createMatchPoll(
        sock,
        '120363402559062529@g.us',
        8,
        'Tomorrow 7pm',
        'tomorrow',
        '7pm',
        'Alice',
        'alice@s.whatsapp.net',
        true,
        null,
        false,
        true,
        false, // noMatchups
        false, // checkCourts
        false,
        false, // isRecurring
        null,
        null,
        'none',
        null,
        null,
        null,
        null,
        context,
        { simulate: true, isSimulation: true }
      );

      assert.equal(res.err, null);
      assert.equal(res.isSimulation, true);
      assert.equal(res.size, 8);
      assert.equal(res.values.length, 7); // Creator included as Player 1, so 7 open voting slots
      assert.match(res.pollTitle, /\[Simulation\]/);

      // Verify a poll message was sent via sock
      assert.equal(sock.sentMessages.length, 1);
      const sentPoll = sock.sentMessages[0].msg.poll;
      assert.ok(sentPoll);
      assert.match(sentPoll.name, /\[Simulation\]/);
      assert.equal(sentPoll.values.length, 7);

      // CRITICAL: Must NOT be saved in activePolls, messageStore, latestPollIdByChat, or disk
      assert.equal(activePolls.size, 0);
      assert.equal(messageStore.size, 0);
      assert.equal(latestPollIdByChat.size, 0);
      assert.equal(persistCalled, false);
    });

    it('should not perform real court pre-bookings during simulation', async () => {
      const sock = createMockSock();
      const activePolls = new Map();
      let preBookExecuted = false;

      const res = await pollCommands.createMatchPoll(
        sock,
        '120363402559062529@g.us',
        4,
        'Tomorrow 6pm',
        'tomorrow',
        '6pm',
        'Alice',
        'alice@s.whatsapp.net',
        true,
        null,
        false,
        true,
        false,
        false,
        false,
        false,
        null,
        null,
        'pre-book', // courtBookingType
        null,
        1,
        null,
        null,
        { activePolls },
        {
          simulate: true,
          preBookCourtsForMatch: async () => {
            preBookExecuted = true;
            return { advanceBookedCourts: [], prebookedCourts: [] };
          }
        }
      );

      assert.equal(res.err, null);
      assert.equal(res.isSimulation, true);
      assert.equal(preBookExecuted, false);
      assert.equal(activePolls.size, 0);
    });
  });

  describe('direct poll simulation commands and flags', () => {
    it('should handle !simulatepoll command and return simulation summary', async () => {
      const sock = createMockSock();
      const activePolls = new Map();
      const context = { activePolls, recurringPolls: new Map() };

      const origCheck = scvcc.checkCourtAvailability;
      const origBookings = scvcc.getCourtBookings;
      scvcc.checkCourtAvailability = async () => ({
        slots: [{
          courts: [
            { court: 'Court 1', status: 'available', availableMinutes: 90 },
            { court: 'Court 2', status: 'available', availableMinutes: 90 }
          ]
        }]
      });
      scvcc.getCourtBookings = async () => ({ bookings: [] });

      try {
        const res = await routeCommand(
          sock,
          '!simulatepoll 8 7pm tomorrow --courts',
          '120363402559062529@g.us',
          'Alice',
          { key: { participant: 'alice@s.whatsapp.net', remoteJid: '120363402559062529@g.us' } },
          context
        );

        assert.match(res, /Mock Poll Simulation/i);
        assert.match(res, /Throwaway - Not Tracked/i);
        assert.match(res, /8 spots/i);
        assert.match(res, /2 courts available/i);

        // Verify poll was sent to WhatsApp
        assert.equal(sock.sentMessages.length, 1);
        assert.match(sock.sentMessages[0].msg.poll.name, /\[Simulation\]/);

        // Verify poll was NOT saved in activePolls
        assert.equal(activePolls.size, 0);
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.getCourtBookings = origBookings;
      }
    });

    it('should support !simpoll alias for auto-sized poll simulation', async () => {
      const sock = createMockSock();
      const activePolls = new Map();
      const context = { activePolls, recurringPolls: new Map() };

      const origCheck = scvcc.checkCourtAvailability;
      const origBookings = scvcc.getCourtBookings;
      scvcc.checkCourtAvailability = async () => ({
        slots: [{
          courts: [
            { court: 'Court 1', status: 'available', availableMinutes: 90 },
            { court: 'Court 2', status: 'available', availableMinutes: 90 },
            { court: 'Court 3', status: 'available', availableMinutes: 90 }
          ]
        }]
      });
      scvcc.getCourtBookings = async () => ({ bookings: [] });

      try {
        const res = await routeCommand(
          sock,
          '!simpoll auto 7pm tomorrow',
          '120363402559062529@g.us',
          'Bob',
          { key: { participant: 'bob@s.whatsapp.net', remoteJid: '120363402559062529@g.us' } },
          context
        );

        assert.match(res, /Mock Poll Simulation/i);
        assert.match(res, /12 spots/i); // 3 courts * 4 = 12 spots
        assert.match(res, /3 courts available/i);
        assert.equal(activePolls.size, 0);
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.getCourtBookings = origBookings;
      }
    });

    it('should support --simulate flag on regular !poll command', async () => {
      const sock = createMockSock();
      const activePolls = new Map();
      const context = { activePolls, recurringPolls: new Map() };

      const res = await routeCommand(
        sock,
        '!poll 4 6pm tomorrow --simulate',
        '120363402559062529@g.us',
        'Charlie',
        { key: { participant: 'charlie@s.whatsapp.net', remoteJid: '120363402559062529@g.us' } },
        context
      );

      assert.match(res, /Mock Poll Simulation/i);
      assert.equal(activePolls.size, 0);
    });

    it('should post simulation poll directly to DM when command is sent in DM', async () => {
      const sock = createMockSock();
      const activePolls = new Map();
      const dmChatId = '16028031085@s.whatsapp.net';
      const groupChatId = '120363402559062529@g.us';
      const context = {
        activePolls,
        recurringPolls: new Map(),
        targetGroupJid: groupChatId
      };

      const origCheck = scvcc.checkCourtAvailability;
      const origBookings = scvcc.getCourtBookings;
      scvcc.checkCourtAvailability = async () => ({
        slots: [{
          courts: [
            { court: 'Court 1', status: 'available', availableMinutes: 90 },
            { court: 'Court 2', status: 'available', availableMinutes: 90 }
          ]
        }]
      });
      scvcc.getCourtBookings = async () => ({ bookings: [] });

      try {
        const res = await routeCommand(
          sock,
          '!simulatepoll 8 7pm tomorrow',
          dmChatId,
          'Alice',
          { key: { participant: dmChatId, remoteJid: dmChatId } },
          context
        );

        assert.match(res, /Mock Poll Simulation/i);
        assert.match(res, /8 spots/i);

        // Verify the poll was sent to the DM chatId, NOT the group chatId!
        assert.equal(sock.sentMessages.length, 1);
        assert.equal(sock.sentMessages[0].jid, dmChatId);
        assert.match(sock.sentMessages[0].msg.poll.name, /\[Simulation\]/);

        // Verify poll was NOT saved in activePolls
        assert.equal(activePolls.size, 0);
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.getCourtBookings = origBookings;
      }
    });

        it('should return failure message if no courts are available when checking courts', async () => {
      const sock = createMockSock();
      const activePolls = new Map();
      const context = { activePolls, recurringPolls: new Map() };

      const origCheck = scvcc.checkCourtAvailability;
      const origBookings = scvcc.getCourtBookings;
      scvcc.checkCourtAvailability = async () => ({ slots: [{ courts: [] }] });
      scvcc.getCourtBookings = async () => ({ bookings: [] });

      try {
        const res = await routeCommand(
          sock,
          '!simulatepoll auto 7pm tomorrow',
          '120363402559062529@g.us',
          'Alice',
          { key: { participant: 'alice@s.whatsapp.net', remoteJid: '120363402559062529@g.us' } },
          context
        );

        assert.match(res, /No live or prebooked courts are available/i);
        assert.equal(sock.sentMessages.length, 0); // No mock poll was sent because no courts available
        assert.equal(activePolls.size, 0);
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.getCourtBookings = origBookings;
      }
    });
  });

  describe('recurring poll simulation on future dates', () => {
    it('should simulate how many slots an auto-sized recurring poll would have on a future date', async () => {
      const sock = createMockSock();
      const recurringPolls = new Map([
        ['rec_test_auto', {
          id: 'rec_test_auto',
          remoteJid: '120363402559062529@g.us',
          size: 'auto',
          matchTime: '7:00PM',
          matchHour: 19,
          matchMinute: 0,
          days: 'Mon-Thu',
          daysList: [1, 2, 3, 4],
          daysDisplay: 'Mon–Thu (Mon, Tue, Wed, Thu)',
          postDisplay: '8:00 AM',
          checkCourts: true,
          enabled: true,
          postedMatchDates: [],
          creator: { name: 'Alice', jid: 'alice@s.whatsapp.net' }
        }]
      ]);

      const activePolls = new Map();
      const context = { recurringPolls, activePolls };

      const origCheck = scvcc.checkCourtAvailability;
      const origBookings = scvcc.getCourtBookings;

      // Mock 2 courts available on the future date
      scvcc.checkCourtAvailability = async ({ when }) => {
        return {
          slots: [{
            courts: [
              { court: 'Court 1', status: 'available', availableMinutes: 90 },
              { court: 'Court 2', status: 'available', availableMinutes: 90 }
            ]
          }]
        };
      };
      scvcc.getCourtBookings = async () => ({ bookings: [] });

      try {
        const res = await routeCommand(
          sock,
          '!simulaterecurring rec_test_auto Friday',
          '120363402559062529@g.us',
          'Alice',
          { key: { participant: 'alice@s.whatsapp.net', remoteJid: '120363402559062529@g.us' } },
          context
        );

        assert.match(res, /Mock Poll Simulation/i);
        assert.match(res, /rec_test_auto/);
        assert.match(res, /8 spots/i); // 2 courts * 4 = 8 spots
        assert.match(res, /Court 1/);
        assert.match(res, /Court 2/);

        // Verify throwaway poll was sent via sock
        assert.equal(sock.sentMessages.length, 1);
        const pollMsg = sock.sentMessages[0].msg.poll;
        assert.match(pollMsg.name, /\[Simulation\]/);
        assert.match(pollMsg.name, /8 slots \/ 8/);
        assert.equal(pollMsg.values.length, 8);

        // Verify recurring schedule state is NOT mutated
        const sched = recurringPolls.get('rec_test_auto');
        assert.equal(sched.postedMatchDates.length, 0);

        // Verify poll is not stored in activePolls
        assert.equal(activePolls.size, 0);
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.getCourtBookings = origBookings;
      }
    });

    it('should simulate recurring poll for a specific future ISO date (e.g. 2026-11-06)', async () => {
      const sock = createMockSock();
      const recurringPolls = new Map([
        ['rec_nov', {
          id: 'rec_nov',
          remoteJid: '120363402559062529@g.us',
          size: 4,
          matchTime: '6:30PM',
          days: 'everyday',
          daysList: [0, 1, 2, 3, 4, 5, 6],
          daysDisplay: 'Every day',
          checkCourts: true,
          enabled: true,
          postedMatchDates: [],
          creator: { name: 'Bob', jid: 'bob@s.whatsapp.net' }
        }]
      ]);

      const activePolls = new Map();
      const context = { recurringPolls, activePolls };

      const origCheck = scvcc.checkCourtAvailability;
      const origBookings = scvcc.getCourtBookings;
      scvcc.checkCourtAvailability = async () => ({
        slots: [{
          courts: [
            { court: 'Court 3', status: 'available', availableMinutes: 90 }
          ]
        }]
      });
      scvcc.getCourtBookings = async () => ({ bookings: [] });

      try {
        const res = await routeCommand(
          sock,
          '!simulaterecurring rec_nov 2026-11-06',
          '120363402559062529@g.us',
          'Bob',
          { key: { participant: 'bob@s.whatsapp.net', remoteJid: '120363402559062529@g.us' } },
          context
        );

        assert.match(res, /Mock Poll Simulation/i);
        assert.match(res, /Nov 6, 2026/);
        assert.match(res, /4 spots/);
        assert.equal(sock.sentMessages.length, 1);
        assert.equal(activePolls.size, 0);
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.getCourtBookings = origBookings;
      }
    });

    it('should route !simulatepoll <scheduleId> <futureDate> to recurring simulation', async () => {
      const sock = createMockSock();
      const recurringPolls = new Map([
        ['rec_hybrid', {
          id: 'rec_hybrid',
          remoteJid: '120363402559062529@g.us',
          size: 8,
          matchTime: '7:00PM',
          days: 'mon-thu',
          daysList: [1, 2, 3, 4],
          daysDisplay: 'Mon–Thu',
          checkCourts: false,
          enabled: true,
          postedMatchDates: [],
          creator: { name: 'Alice', jid: 'alice@s.whatsapp.net' }
        }]
      ]);

      const activePolls = new Map();
      const context = { recurringPolls, activePolls };

      const res = await routeCommand(
        sock,
        '!simulatepoll rec_hybrid Monday',
        '120363402559062529@g.us',
        'Alice',
        { key: { participant: 'alice@s.whatsapp.net', remoteJid: '120363402559062529@g.us' } },
        context
      );

      assert.match(res, /Mock Poll Simulation/i);
      assert.match(res, /rec_hybrid/);
      assert.equal(activePolls.size, 0);
    });

    it('should automatically pick schedule when only 1 schedule exists in chat for !simulaterecurring', async () => {
      const sock = createMockSock();
      const recurringPolls = new Map([
        ['rec_single', {
          id: 'rec_single',
          remoteJid: '120363402559062529@g.us',
          size: 4,
          matchTime: '7:00PM',
          days: 'everyday',
          daysList: [0, 1, 2, 3, 4, 5, 6],
          daysDisplay: 'Every day',
          checkCourts: false,
          enabled: true,
          postedMatchDates: [],
          creator: { name: 'Alice', jid: 'alice@s.whatsapp.net' }
        }]
      ]);

      const activePolls = new Map();
      const context = { recurringPolls, activePolls };

      const res = await routeCommand(
        sock,
        '!simulaterecurring Friday',
        '120363402559062529@g.us',
        'Alice',
        { key: { participant: 'alice@s.whatsapp.net', remoteJid: '120363402559062529@g.us' } },
        context
      );

      assert.match(res, /Mock Poll Simulation/i);
      assert.match(res, /rec_single/);
      assert.equal(activePolls.size, 0);
    });
  });

  describe('executeTool integration', () => {
    it('should post simulation poll to DM when simulate_poll tool is called in DM', async () => {
      const sock = createMockSock();
      const activePolls = new Map();
      const dmChatId = '16028031085@s.whatsapp.net';
      const context = { activePolls, recurringPolls: new Map() };

      const origCheck = scvcc.checkCourtAvailability;
      const origBookings = scvcc.getCourtBookings;
      scvcc.checkCourtAvailability = async () => ({
        slots: [{
          courts: [
            { court: 'Court 1', status: 'available', availableMinutes: 90 }
          ]
        }]
      });
      scvcc.getCourtBookings = async () => ({ bookings: [] });

      try {
        const res = await executeTool(
          sock,
          dmChatId,
          'Alice',
          {
            name: 'simulate_poll',
            input: {
              size: 4,
              when: 'Tomorrow 7pm',
              checkCourts: true
            }
          },
          { key: { remoteJid: dmChatId } },
          context
        );

        assert.match(res, /Mock Poll Simulation/i);
        assert.equal(sock.sentMessages.length, 1);
        assert.equal(sock.sentMessages[0].jid, dmChatId);
        assert.match(sock.sentMessages[0].msg.poll.name, /\[Simulation\]/);
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.getCourtBookings = origBookings;
      }
    });

        it('should execute simulate_poll tool for direct poll', async () => {
      const sock = createMockSock();
      const activePolls = new Map();
      const context = { activePolls, recurringPolls: new Map() };

      const res = await executeTool(
        sock,
        '120363402559062529@g.us',
        'Alice',
        {
          name: 'simulate_poll',
          input: {
            size: 4,
            when: 'tomorrow 7pm',
            checkCourts: false
          }
        },
        { key: { participant: 'alice@s.whatsapp.net', remoteJid: '120363402559062529@g.us' } },
        context
      );

      assert.match(res, /Mock Poll Simulation/i);
      assert.equal(activePolls.size, 0);
    });

    it('should execute simulate_poll tool with scheduleId for recurring simulation', async () => {
      const sock = createMockSock();
      const recurringPolls = new Map([
        ['rec_tool_test', {
          id: 'rec_tool_test',
          remoteJid: '120363402559062529@g.us',
          size: 8,
          matchTime: '7:00PM',
          days: 'everyday',
          daysList: [0, 1, 2, 3, 4, 5, 6],
          daysDisplay: 'Every day',
          checkCourts: false,
          enabled: true,
          postedMatchDates: [],
          creator: { name: 'Alice', jid: 'alice@s.whatsapp.net' }
        }]
      ]);
      const activePolls = new Map();
      const context = { recurringPolls, activePolls };

      const res = await executeTool(
        sock,
        '120363402559062529@g.us',
        'Alice',
        {
          name: 'simulate_poll',
          input: {
            scheduleId: 'rec_tool_test',
            targetDayOrDate: 'Friday'
          }
        },
        { key: { participant: 'alice@s.whatsapp.net', remoteJid: '120363402559062529@g.us' } },
        context
      );

      assert.match(res, /Mock Poll Simulation/i);
      assert.match(res, /rec_tool_test/);
      assert.equal(activePolls.size, 0);
    });
  });
  describe("manual poll simulation prefix handling", () => {
    it("should recognize simulation prefix in poll titles", () => {
      assert.equal(pollCommands.hasSimulationPrefix("🎾 [Simulation] Monday 6:30pm (4 slots / 4)"), true);
      assert.equal(pollCommands.hasSimulationPrefix("[Simulation] Monday 6:30pm (4 slots / 4)"), true);
      assert.equal(pollCommands.hasSimulationPrefix("🎾 [simulation] Today 7pm"), true);
      assert.equal(pollCommands.hasSimulationPrefix("🎾 [Simulation]Monday 6:30pm"), false);
      assert.equal(pollCommands.hasSimulationPrefix("[Simulation]Monday"), false);
      assert.equal(pollCommands.hasSimulationPrefix("🎾 Monday 6:30pm (4 slots / 4)"), false);
      assert.equal(pollCommands.hasSimulationPrefix("Match tomorrow 7pm"), false);
      assert.equal(pollCommands.hasSimulationPrefix(null), false);
    });

    it("should return isMatchScheduling=false in isMatchSchedulingPoll when poll has simulation prefix", () => {
      const isSched = pollCommands.isMatchSchedulingPoll("🎾 [Simulation] Monday 6:30pm (4 slots / 4)", ["Player 1", "Player 2"]);
      assert.equal(isSched, false);
      const isSchedWithoutEmoji = pollCommands.isMatchSchedulingPoll("[Simulation] Monday 6:30pm (4 slots / 4)", ["Player 1", "Player 2"]);
      assert.equal(isSchedWithoutEmoji, false);
    });

    it("should create simulation polls with the simulation prefix", async () => {
      const sock = createMockSock();
      const activePolls = new Map();
      const context = { activePolls };

      const res = await pollCommands.createMatchPoll(
        sock,
        "120363402559062529@g.us",
        4,
        "Tomorrow 7pm",
        "tomorrow",
        "7pm",
        "Alice",
        "alice@s.whatsapp.net",
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
        "none",
        null,
        null,
        null,
        null,
        context,
        { simulate: true, isSimulation: true }
      );

      assert.equal(res.isSimulation, true);
      assert.equal(sock.sentMessages.length, 1);
      const pollMsg = sock.sentMessages[0].msg.poll;
      assert.ok(pollCommands.hasSimulationPrefix(pollMsg.name));
    });
  });
});
