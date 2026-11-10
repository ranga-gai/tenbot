process.env.NODE_ENV = 'test';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const recurringPollsModule = require('../lib/recurringPolls');
const recurringCommands = require('../lib/commands/recurringCommands');
const pollCommands = require('../lib/commands/pollCommands');
const scvcc = require('../lib/scvcc');
const groupsConfig = require('../lib/groupsConfig');
const tennisrecord = require('../lib/tennisrecord');

describe('overrideRecurringPollSlots', () => {
  describe('extractOverrideSlotsArgs', () => {
    it('should parse scheduleId, day, and slots count', () => {
      const res = recurringPollsModule.extractOverrideSlotsArgs('rec_1 Friday 8');
      assert.equal(res.scheduleId, 'rec_1');
      assert.equal(res.targetDayOrDate, 'Friday');
      assert.equal(res.slots, 8);
    });

    it('should parse scheduleId, date, and slots count', () => {
      const res = recurringPollsModule.extractOverrideSlotsArgs('rec_1 11/13 12');
      assert.equal(res.scheduleId, 'rec_1');
      assert.equal(res.targetDayOrDate, '11/13');
      assert.equal(res.slots, 12);
    });

    it('should parse scheduleId and slots count defaulting target to null (next instance)', () => {
      const res = recurringPollsModule.extractOverrideSlotsArgs('rec_1 8');
      assert.equal(res.scheduleId, 'rec_1');
      assert.equal(res.targetDayOrDate, null);
      assert.equal(res.slots, 8);
    });

    it('should parse day and slots count with no scheduleId', () => {
      const res = recurringPollsModule.extractOverrideSlotsArgs('Friday 8');
      assert.equal(res.scheduleId, null);
      assert.equal(res.targetDayOrDate, 'Friday');
      assert.equal(res.slots, 8);
    });

    it('should parse reset for specific day', () => {
      const res = recurringPollsModule.extractOverrideSlotsArgs('rec_1 Friday reset');
      assert.equal(res.scheduleId, 'rec_1');
      assert.equal(res.targetDayOrDate, 'Friday');
      assert.equal(res.slots, 'reset');
    });

    it('should parse reset all', () => {
      const res = recurringPollsModule.extractOverrideSlotsArgs('rec_1 all reset');
      assert.equal(res.scheduleId, 'rec_1');
      assert.equal(res.targetDayOrDate, 'all');
      assert.equal(res.slots, 'reset');
    });

    it('should parse opt-in override', () => {
      const res = recurringPollsModule.extractOverrideSlotsArgs('rec_1 Friday opt-in');
      assert.equal(res.scheduleId, 'rec_1');
      assert.equal(res.targetDayOrDate, 'Friday');
      assert.equal(res.slots, 'opt-in');
    });

    it('should parse --slots and slots= flags', () => {
      const res1 = recurringPollsModule.extractOverrideSlotsArgs('rec_1 --slots=8 Friday');
      assert.equal(res1.scheduleId, 'rec_1');
      assert.equal(res1.targetDayOrDate, 'Friday');
      assert.equal(res1.slots, 8);

      const res2 = recurringPollsModule.extractOverrideSlotsArgs('rec_1 Friday slots=12');
      assert.equal(res2.scheduleId, 'rec_1');
      assert.equal(res2.targetDayOrDate, 'Friday');
      assert.equal(res2.slots, 12);
    });

    it('should parse word numbers like eight, twelve, sixteen', () => {
      const res = recurringPollsModule.extractOverrideSlotsArgs('rec_1 Friday eight');
      assert.equal(res.scheduleId, 'rec_1');
      assert.equal(res.targetDayOrDate, 'Friday');
      assert.equal(res.slots, 8);
    });
  });

  describe('overrideRecurringPollInstanceSlots handler', () => {
    it('should set slot override for upcoming instance and format card with override note', async () => {
      const recurringPolls = new Map();
      const schedId = 'rec_override_test';
      const sched = {
        id: schedId,
        remoteJid: '120363402559062529@g.us',
        matchTime: '7pm',
        matchDisplay: '7 PM',
        days: 'friday',
        daysList: [5], // Friday
        size: 'auto',
        enabled: true,
        creator: { name: 'Alice', jid: 'alice@s.whatsapp.net' }
      };
      recurringPolls.set(schedId, sched);

      let persisted = false;
      const res = await recurringPollsModule.overrideRecurringPollInstanceSlots({
        recurringPolls,
        persistPolls: () => { persisted = true; },
        scheduleId: schedId,
        targetDayOrDate: 'Friday',
        slots: 8,
        chatId: '120363402559062529@g.us',
        sender: 'Alice',
        customSanJoseParts: { year: 2026, month: 10, day: 9, hour: 10, minute: 0 } // Mon Nov 9, 2026
      });

      assert.equal(persisted, true);
      assert.match(res, /Future Instance Slot Override Set/i);
      assert.match(res, /8 slots/);
      assert.match(res, /2026-11-13/);

      assert.ok(sched.instanceSlotOverrides);
      assert.equal(sched.instanceSlotOverrides['2026-11-13'], 8);

      // Verify card formatting includes the override
      const card = recurringPollsModule.formatRecurringScheduleCard(sched);
      assert.match(card, /Slot Override\(s\):.*2026-11-13 → 8 slots/);
    });

    it('should remove slot override for a specific date when reset is passed', async () => {
      const recurringPolls = new Map();
      const schedId = 'rec_reset_test';
      const sched = {
        id: schedId,
        remoteJid: '120363402559062529@g.us',
        matchTime: '7pm',
        matchDisplay: '7 PM',
        days: 'friday',
        daysList: [5],
        size: 'auto',
        enabled: true,
        instanceSlotOverrides: { '2026-11-13': 8 },
        creator: { name: 'Alice', jid: 'alice@s.whatsapp.net' }
      };
      recurringPolls.set(schedId, sched);

      let persisted = false;
      const res = await recurringPollsModule.overrideRecurringPollInstanceSlots({
        recurringPolls,
        persistPolls: () => { persisted = true; },
        scheduleId: schedId,
        targetDayOrDate: 'Friday',
        slots: 'reset',
        chatId: '120363402559062529@g.us',
        sender: 'Alice',
        customSanJoseParts: { year: 2026, month: 10, day: 9, hour: 10, minute: 0 }
      });

      assert.equal(persisted, true);
      assert.match(res, /Removed Slot Override/i);
      assert.equal(sched.instanceSlotOverrides, undefined);
    });

    it('should clear all future instance overrides when all reset is passed', async () => {
      const recurringPolls = new Map();
      const schedId = 'rec_clear_all_test';
      const sched = {
        id: schedId,
        remoteJid: '120363402559062529@g.us',
        matchTime: '7pm',
        days: 'friday',
        daysList: [5],
        size: 'auto',
        enabled: true,
        instanceSlotOverrides: { '2026-11-13': 8, '2026-11-20': 12 },
        creator: { name: 'Alice', jid: 'alice@s.whatsapp.net' }
      };
      recurringPolls.set(schedId, sched);

      const res = await recurringPollsModule.overrideRecurringPollInstanceSlots({
        recurringPolls,
        persistPolls: () => {},
        scheduleId: schedId,
        targetDayOrDate: 'all',
        slots: 'reset',
        chatId: '120363402559062529@g.us',
        sender: 'Alice'
      });

      assert.match(res, /Cleared All Future Instance Slot Overrides/i);
      assert.equal(sched.instanceSlotOverrides, undefined);
    });
  });

  describe('checkAndPostRecurringPolls with instance slot override', () => {
    it('should override size auto and court calculations with exact overridden slots when posted', async () => {
      const origCheck = scvcc.checkCourtAvailability;
      const origBookings = scvcc.getCourtBookings;
      const origGetConfig = groupsConfig.getGroupConfig;

      try {
        groupsConfig.getGroupConfig = () => ({
          sport: 'tennis',
          courtBookingEnabled: true,
          courtConfig: 'SCVCC'
        });

        // Mock 3 courts available (which would normally yield 12 slots for size auto)
        scvcc.checkCourtAvailability = async () => ({
          slots: [{
            time: '7:00 PM',
            courts: [
              { court: 'Court 1', status: 'available', availableMinutes: 90 },
              { court: 'Court 2', status: 'available', availableMinutes: 90 },
              { court: 'Court 3', status: 'available', availableMinutes: 90 }
            ]
          }]
        });
        scvcc.getCourtBookings = async () => ({ bookings: [] });

        let sentPayload = null;
        const mockSock = {
          sendMessage: async (jid, payload) => {
            sentPayload = payload;
            return { key: { id: 'poll_overridden_post', remoteJid: jid } };
          }
        };

        const activePolls = new Map();
        const schedId = 'rec_auto_override';
        const sched = {
          id: schedId,
          remoteJid: '120363402559062529@g.us',
          matchTime: '7pm',
          matchHour: 19,
          matchMinute: 0,
          days: 'friday',
          daysList: [5],
          size: 'auto',
          includeCreator: false,
          checkCourts: true,
          enabled: true,
          postTime: '8am',
          postHour: 8,
          postMinute: 0,
          daysBefore: 0,
          instanceSlotOverrides: { '2026-11-13': 8 }, // Overridden to 8 slots!
          postedMatchDates: [],
          lastPostedDate: null
        };
        const recurringPolls = new Map([[schedId, sched]]);

        // Run sweep at 8:05 AM on Friday Nov 13, 2026 (matching post time)
        const friday805am = { year: 2026, month: 10, day: 13, hour: 8, minute: 5, weekday: "fri" };
        await recurringPollsModule.checkAndPostRecurringPolls({
          sock: mockSock,
          recurringPolls,
          persistPolls: () => {},
          activePolls,
          createMatchPoll: pollCommands.createMatchPoll,
          getTargetGroupJid: async () => "120363402559062529@g.us",
          customSanJoseParts: friday805am
        });

        assert.ok(sentPayload?.poll, 'Poll should be posted');
        // Overridden to 8 slots: should have exactly 8 options (Player 1 to Player 8), NOT 12!
        assert.equal(sentPayload.poll.values.length, 8, 'Should have exactly 8 player slots despite 3 courts available');
        assert.match(sentPayload.poll.values[0], /^Player 1/);
        assert.match(sentPayload.poll.values[7], /^Player 8/);

        const stored = activePolls.get('poll_overridden_post');
        assert.ok(stored);
        assert.equal(stored.size, 8);
        assert.equal(stored.slotOverride, 8);
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.getCourtBookings = origBookings;
        groupsConfig.getGroupConfig = origGetConfig;
      }
    });

    it('should override maxCourts cap when instance slot override is set', async () => {
      const origCheck = scvcc.checkCourtAvailability;
      const origBookings = scvcc.getCourtBookings;
      const origGetConfig = groupsConfig.getGroupConfig;

      try {
        groupsConfig.getGroupConfig = () => ({
          sport: 'tennis',
          courtBookingEnabled: true,
          courtConfig: 'SCVCC'
        });

        scvcc.checkCourtAvailability = async () => ({
          slots: [{
            time: '7:00 PM',
            courts: [
              { court: 'Court 1', status: 'available', availableMinutes: 90 },
              { court: 'Court 2', status: 'available', availableMinutes: 90 }
            ]
          }]
        });
        scvcc.getCourtBookings = async () => ({ bookings: [] });

        let sentPayload = null;
        const mockSock = {
          sendMessage: async (jid, payload) => {
            sentPayload = payload;
            return { key: { id: 'poll_maxcourts_overridden', remoteJid: jid } };
          }
        };

        const activePolls = new Map();
        const schedId = 'rec_max_override';
        const sched = {
          id: schedId,
          remoteJid: '120363402559062529@g.us',
          matchTime: '7pm',
          matchHour: 19,
          matchMinute: 0,
          days: 'friday',
          daysList: [5],
          size: 'auto',
          includeCreator: false,
          maxCourts: 1, // Normally capped to 1 court = 4 slots
          checkCourts: true,
          enabled: true,
          postTime: '8am',
          postHour: 8,
          postMinute: 0,
          daysBefore: 0,
          instanceSlotOverrides: { '2026-11-13': 8 }, // Overridden to 8 slots!
          postedMatchDates: [],
          lastPostedDate: null
        };
        const recurringPolls = new Map([[schedId, sched]]);

        const friday805am = { year: 2026, month: 10, day: 13, hour: 8, minute: 5, weekday: "fri" };
        await recurringPollsModule.checkAndPostRecurringPolls({
          sock: mockSock,
          recurringPolls,
          persistPolls: () => {},
          activePolls,
          createMatchPoll: pollCommands.createMatchPoll,
          getTargetGroupJid: async () => "120363402559062529@g.us",
          customSanJoseParts: friday805am
        });

        assert.ok(sentPayload?.poll);
        // Overrides maxCourts: 1 -> creates 8 slots
        assert.equal(sentPayload.poll.values.length, 8);
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.getCourtBookings = origBookings;
        groupsConfig.getGroupConfig = origGetConfig;
      }
    });

    it('should still create poll with overridden slots even if 0 courts are available at SCVCC', async () => {
      const origCheck = scvcc.checkCourtAvailability;
      const origBookings = scvcc.getCourtBookings;
      const origGetConfig = groupsConfig.getGroupConfig;

      try {
        groupsConfig.getGroupConfig = () => ({
          sport: 'tennis',
          courtBookingEnabled: true,
          courtConfig: 'SCVCC'
        });

        // 0 courts available
        scvcc.checkCourtAvailability = async () => ({
          slots: [{
            time: '7:00 PM',
            courts: [
              { court: 'Court 1', status: 'unavailable', availableMinutes: 0 },
              { court: 'Court 2', status: 'unavailable', availableMinutes: 0 }
            ]
          }]
        });
        scvcc.getCourtBookings = async () => ({ bookings: [] });

        let sentPayload = null;
        const mockSock = {
          sendMessage: async (jid, payload) => {
            sentPayload = payload;
            return { key: { id: 'poll_nocourts_override', remoteJid: jid } };
          }
        };

        const activePolls = new Map();
        const schedId = 'rec_nocourts_override';
        const sched = {
          id: schedId,
          remoteJid: '120363402559062529@g.us',
          matchTime: '7pm',
          matchHour: 19,
          matchMinute: 0,
          days: 'friday',
          daysList: [5],
          size: 'auto',
          includeCreator: false,
          checkCourts: true,
          enabled: true,
          postTime: '8am',
          postHour: 8,
          postMinute: 0,
          daysBefore: 0,
          instanceSlotOverrides: { '2026-11-13': 8 }, // Overridden to 8 slots!
          postedMatchDates: [],
          lastPostedDate: null
        };
        const recurringPolls = new Map([[schedId, sched]]);

        const friday805am = { year: 2026, month: 10, day: 13, hour: 8, minute: 5, weekday: "fri" };
        await recurringPollsModule.checkAndPostRecurringPolls({
          sock: mockSock,
          recurringPolls,
          persistPolls: () => {},
          activePolls,
          createMatchPoll: pollCommands.createMatchPoll,
          getTargetGroupJid: async () => "120363402559062529@g.us",
          customSanJoseParts: friday805am
        });

        assert.ok(sentPayload?.poll, 'Poll should still be created despite 0 available courts at SCVCC');
        assert.equal(sentPayload.poll.values.length, 8);
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.getCourtBookings = origBookings;
        groupsConfig.getGroupConfig = origGetConfig;
      }
    });
  });

  describe('checkAndExecuteAdvanceBookings with instance slot override', () => {
    it('should target courts needed for overridden slots (e.g. 8 slots -> 2 courts) instead of schedule default', async () => {
      const origBookCourt = scvcc.bookCourt;
      const origDetect = recurringPollsModule.detectManualPlayerBookings;
      recurringPollsModule.detectManualPlayerBookings = async () => [];
      const origFetchRating = tennisrecord.fetchTennisRecordRating;
      tennisrecord.fetchTennisRecordRating = async () => ({ rating: 3.5, location: "San Jose, CA" });

      let bookCalledCount = 0;
      scvcc.bookCourt = async (params) => {
        bookCalledCount++;
        return {
          success: true,
          court: `Court ${bookCalledCount}`,
          reservationId: `res_${bookCalledCount}`,
          message: 'Court booked'
        };
      };

      try {
        const schedId = 'rec_adv_override';
        const sched = {
          id: schedId,
          remoteJid: '120363402559062529@g.us',
          matchTime: '7pm',
          matchHour: 19,
          matchMinute: 0,
          days: 'friday',
          daysList: [5],
          size: 4, // Default schedule is 4 spots = 1 court
          preBookCourts: 1,
          courtBookingType: 'pre-book',
          bookingStrategy: 'advanced',
          bookingSchedule: '-7days 7:00AM',
          bookingScheduleParsed: { daysBefore: 7, hour: 7, minute: 0, display: '7:00 AM' },
          startDate: '2026-11-07',
          enabled: true,
          instanceSlotOverrides: { '2026-11-13': 8 }, // Overridden to 8 slots for Nov 13 -> needs 2 courts!
          advanceBookings: {}
        };
        const recurringPolls = new Map([[schedId, sched]]);

        // Sweep 7 days before at 7:05 AM (Nov 6, 2026 7:05 AM)
        const nov6_705am = { year: 2026, month: 10, day: 6, hour: 7, minute: 5, weekday: "fri" };
        await recurringPollsModule.checkAndExecuteAdvanceBookings({
          sock: { sendMessage: async () => {} },
          recurringPolls,
          persistPolls: () => {},
          preBookCourtsForMatch: pollCommands.preBookCourtsForMatch,
          customSanJoseParts: nov6_705am
        });

        assert.equal(bookCalledCount, 2, 'Should pre-book 2 courts for the 8 overridden slots');
        const advEntry = sched.advanceBookings['2026-11-13'];
        assert.ok(advEntry);
        assert.equal(advEntry.targetCourtsCount, 2);
        assert.equal(advEntry.autoBookedCourts.length, 2);
      } finally {
        scvcc.bookCourt = origBookCourt;
        recurringPollsModule.detectManualPlayerBookings = origDetect;
        tennisrecord.fetchTennisRecordRating = origFetchRating;
      }
    });
  });

  describe('simulateRecurringPoll with instance slot override', () => {
    it('should reflect overridden slots in simulation card', async () => {
      const origCheck = scvcc.checkCourtAvailability;
      const origBookings = scvcc.getCourtBookings;

      try {
        scvcc.checkCourtAvailability = async () => ({
          slots: [{
            time: '7:00 PM',
            courts: [
              { court: 'Court 1', status: 'available', availableMinutes: 90 }
            ]
          }]
        });
        scvcc.getCourtBookings = async () => ({ bookings: [] });

        const schedId = 'rec_sim_override';
        const sched = {
          id: schedId,
          remoteJid: '120363402559062529@g.us',
          matchTime: '7pm',
          matchDisplay: '7 PM',
          days: 'friday',
          daysList: [5],
          size: 4,
          enabled: true,
          instanceSlotOverrides: { '2026-11-13': 8 } // Overridden to 8 slots
        };
        const recurringPolls = new Map([[schedId, sched]]);

        const res = await recurringPollsModule.simulateRecurringPoll({
          recurringPolls,
          scheduleId: schedId,
          targetDayOrDate: 'Friday',
          chatId: '120363402559062529@g.us',
          customSanJoseParts: { year: 2026, month: 10, day: 9, hour: 10, minute: 0 }
        });

        assert.match(res, /8 spots/);
        assert.match(res, /overridden for this instance/i);
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.getCourtBookings = origBookings;
      }
    });
  });

  describe('command invocation for instance slot override', () => {
    it('should handle !recurringpoll setslots command in recurringCommands', async () => {
      const schedId = 'rec_cmd_test';
      const sched = {
        id: schedId,
        remoteJid: '120363402559062529@g.us',
        matchTime: '7pm',
        matchDisplay: '7 PM',
        days: 'friday',
        daysList: [5],
        size: 'auto',
        enabled: true,
        creator: { name: 'Alice', jid: 'alice@s.whatsapp.net' }
      };
      const recurringPolls = new Map([[schedId, sched]]);
      const context = {
        recurringPolls,
        activePolls: new Map(),
        persistPolls: () => {}
      };

      const res = await recurringCommands.handleRecurringCommand(
        null,
        '!recurringpoll setslots rec_cmd_test Friday 8',
        '120363402559062529@g.us',
        'Alice',
        'alice@s.whatsapp.net',
        context
      );

      assert.match(res, /Future Instance Slot Override Set/i);
      assert.match(res, /8 slots/);
      assert.equal(sched.instanceSlotOverrides['2026-11-13'], 8);
    });

    it('should delegate !setslots to instance slot override when target is recurring schedule with future day', async () => {
      const schedId = 'rec_setslots_test';
      const sched = {
        id: schedId,
        remoteJid: '120363402559062529@g.us',
        matchTime: '7pm',
        matchDisplay: '7 PM',
        days: 'friday',
        daysList: [5],
        size: 'auto',
        enabled: true,
        creator: { name: 'Alice', jid: 'alice@s.whatsapp.net' }
      };
      const recurringPolls = new Map([[schedId, sched]]);
      const context = {
        recurringPolls,
        activePolls: new Map(),
        persistPolls: () => {}
      };

      const res = await pollCommands.handleSetPollSlots(
        null,
        '120363402559062529@g.us',
        'Alice',
        'alice@s.whatsapp.net',
        schedId,
        'Friday',
        context,
        '8'
      );

      assert.match(res, /Future Instance Slot Override Set/i);
      assert.match(res, /8 slots/);
      assert.equal(sched.instanceSlotOverrides['2026-11-13'], 8);
    });

    it('should delegate !setslots with only day when 1 recurring schedule exists in chat', async () => {
      const schedId = 'rec_oneday_test';
      const sched = {
        id: schedId,
        remoteJid: '120363402559062529@g.us',
        matchTime: '7pm',
        matchDisplay: '7 PM',
        days: 'friday',
        daysList: [5],
        size: 'auto',
        enabled: true,
        creator: { name: 'Alice', jid: 'alice@s.whatsapp.net' }
      };
      const recurringPolls = new Map([[schedId, sched]]);
      const context = {
        recurringPolls,
        activePolls: new Map(),
        persistPolls: () => {}
      };

      const res = await pollCommands.handleSetPollSlots(
        null,
        '120363402559062529@g.us',
        'Alice',
        'alice@s.whatsapp.net',
        'Friday',
        '8',
        context
      );

      assert.match(res, /Future Instance Slot Override Set/i);
      assert.match(res, /8 slots/);
      assert.equal(sched.instanceSlotOverrides['2026-11-13'], 8);
    });

    it('should delegate !setslots to reset future instance slot override', async () => {
      const schedId = 'rec_reset_setslots';
      const sched = {
        id: schedId,
        remoteJid: '120363402559062529@g.us',
        matchTime: '7pm',
        matchDisplay: '7 PM',
        days: 'friday',
        daysList: [5],
        size: 'auto',
        instanceSlotOverrides: { '2026-11-13': 8 },
        enabled: true,
        creator: { name: 'Alice', jid: 'alice@s.whatsapp.net' }
      };
      const recurringPolls = new Map([[schedId, sched]]);
      const context = {
        recurringPolls,
        activePolls: new Map(),
        persistPolls: () => {}
      };

      const res = await pollCommands.handleSetPollSlots(
        null,
        '120363402559062529@g.us',
        'Alice',
        'alice@s.whatsapp.net',
        schedId,
        'Friday',
        context,
        'reset'
      );

      assert.match(res, /Removed Slot Override/i);
      assert.equal(sched.instanceSlotOverrides, undefined);
    });

    it('should delegate !modifyinstance to instance slot override when target is recurring schedule with no active poll', async () => {
      const schedId = 'rec_mod_test';
      const sched = {
        id: schedId,
        remoteJid: '120363402559062529@g.us',
        matchTime: '7pm',
        matchDisplay: '7 PM',
        days: 'friday',
        daysList: [5],
        size: 'auto',
        enabled: true,
        creator: { name: 'Alice', jid: 'alice@s.whatsapp.net' }
      };
      const recurringPolls = new Map([[schedId, sched]]);
      const context = {
        recurringPolls,
        activePolls: new Map(),
        persistPolls: () => {}
      };

      const res = await pollCommands.handleModifyPollInstance(
        null,
        '120363402559062529@g.us',
        'Alice',
        'alice@s.whatsapp.net',
        schedId,
        { size: 12, dayWord: 'Friday' },
        context
      );

      assert.match(res, /Future Instance Slot Override Set/i);
      assert.match(res, /12 slots/);
      assert.equal(sched.instanceSlotOverrides['2026-11-13'], 12);
    });

    it('should delegate !modifyinstance with reset to clear instance slot override', async () => {
      const schedId = 'rec_mod_reset';
      const sched = {
        id: schedId,
        remoteJid: '120363402559062529@g.us',
        matchTime: '7pm',
        matchDisplay: '7 PM',
        days: 'friday',
        daysList: [5],
        size: 'auto',
        instanceSlotOverrides: { '2026-11-13': 12 },
        enabled: true,
        creator: { name: 'Alice', jid: 'alice@s.whatsapp.net' }
      };
      const recurringPolls = new Map([[schedId, sched]]);
      const context = {
        recurringPolls,
        activePolls: new Map(),
        persistPolls: () => {}
      };

      const res = await pollCommands.handleModifyPollInstance(
        null,
        '120363402559062529@g.us',
        'Alice',
        'alice@s.whatsapp.net',
        schedId,
        { size: 'reset', dayWord: 'Friday' },
        context
      );

      assert.match(res, /Removed Slot Override/i);
      assert.equal(sched.instanceSlotOverrides, undefined);
    });
  });

  describe('pruning expired instance slot overrides', () => {
    it('should retain instance slot overrides during 14-day grace period and prune them 14 days later', () => {
      const schedId = 'rec_prune_test';
      const sched = {
        id: schedId,
        remoteJid: '120363402559062529@g.us',
        matchTime: '7:00 PM',
        instanceSlotOverrides: {
          '2026-10-20': 8,  // 21 days ago relative to Nov 10 (exceeded 14 days -> prune)
          '2026-11-05': 8,  // 5 days ago relative to Nov 10 (within 14 days -> retain)
          '2026-11-20': 12  // 10 days in the future (retain)
        }
      };
      const recurringPolls = new Map([[schedId, sched]]);
      let persistedChat = null;
      const persistPolls = (chatId) => { persistedChat = chatId; };

      // Current time: Nov 10, 2026 12:00 PM
      const nowMs = new Date('2026-11-10T20:00:00Z').getTime();
      const pruned = recurringPollsModule.pruneExpiredAdvanceBookings(recurringPolls, nowMs, persistPolls);

      assert.equal(pruned, 1);
      assert.equal(sched.instanceSlotOverrides['2026-10-20'], undefined, 'Should prune override older than 14 days');
      assert.equal(sched.instanceSlotOverrides['2026-11-05'], 8, 'Should retain override within 14-day grace period');
      assert.equal(sched.instanceSlotOverrides['2026-11-20'], 12, 'Should retain future override');
      assert.equal(persistedChat, '120363402559062529@g.us');
    });

    it('should prune instance slot override from recurring poll when the poll instance is deleted 14 days later by cleanupExpiredPolls', () => {
      const schedId = 'rec_cleanup_override_test';
      const sched = {
        id: schedId,
        remoteJid: '120363402559062529@g.us',
        matchTime: '7:00 PM',
        instanceSlotOverrides: {
          '2026-10-25': 8,
          '2026-11-05': 12
        }
      };
      const recurringPolls = new Map([[schedId, sched]]);

      // Poll instance for Oct 25 match (16 days ago relative to Nov 10 -> will be deleted)
      const oldPollId = 'poll_old_overridden';
      const oldPoll = {
        name: 'Tennis Match Oct 25',
        status: 'expired',
        scheduleId: schedId,
        targetDateKey: '2026-10-25',
        playAt: '2026-10-26T02:00:00.000Z', // Oct 25 7:00 PM PDT
        size: 8,
        slotOverride: 8,
        remoteJid: '120363402559062529@g.us'
      };

      // Poll instance for Nov 5 match (5 days ago relative to Nov 10 -> status expired, but retained)
      const recentPollId = 'poll_recent_overridden';
      const recentPoll = {
        name: 'Tennis Match Nov 5',
        status: 'active',
        scheduleId: schedId,
        targetDateKey: '2026-11-05',
        playAt: '2026-11-06T03:00:00.000Z', // Nov 5 7:00 PM PST
        size: 12,
        slotOverride: 12,
        remoteJid: '120363402559062529@g.us'
      };

      const activePolls = new Map([
        [oldPollId, oldPoll],
        [recentPollId, recentPoll]
      ]);

      let persisted = false;
      const context = {
        activePolls,
        recurringPolls,
        messageStore: new Map(),
        latestPollIdByChat: new Map([['120363402559062529@g.us', recentPollId]]),
        persistPolls: () => { persisted = true; }
      };

      // Run cleanup on Nov 10
      const nowMs = new Date('2026-11-10T20:00:00Z').getTime();
      const removed = pollCommands.cleanupExpiredPolls(context, nowMs);

      // Old poll deleted from activePolls
      assert.deepEqual(removed, [oldPollId]);
      assert.equal(activePolls.has(oldPollId), false);
      assert.equal(activePolls.has(recentPollId), true);
      assert.equal(recentPoll.status, 'expired');

      // Override for Oct 25 pruned from recurring schedule, Nov 5 retained
      assert.equal(sched.instanceSlotOverrides['2026-10-25'], undefined, 'Oct 25 override must be pruned when poll instance is deleted');
      assert.equal(sched.instanceSlotOverrides['2026-11-05'], 12, 'Nov 5 override must be retained during grace period');
      assert.equal(persisted, true);
    });
  });
});
