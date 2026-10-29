const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDaysOfWeek,
  extractCommonFlags,
  extractSkipArgs,
  extractPauseArgs,
  parseRecurringPollText,
  isPollCreatedForMatchDate,
  detectManualPlayerBookings,
  checkAndExecuteAdvanceBookings,
  checkAndPostRecurringPolls
} = require('../lib/recurringPolls');
const scvcc = require('../lib/scvcc');
const pollTime = require('../lib/pollTime');
const pollCommands = require('../lib/commands/pollCommands');
const recurringPollsModule = require('../lib/recurringPolls');

describe('recurringPolls', () => {
  describe('parseDaysOfWeek', () => {
    it('should parse "everyday"', () => {
      const res = parseDaysOfWeek('everyday');
      assert.ok(res);
      assert.deepEqual(res.days, [0, 1, 2, 3, 4, 5, 6]);
    });

    it('should parse "weekdays"', () => {
      const res = parseDaysOfWeek('weekdays');
      assert.ok(res);
      assert.deepEqual(res.days, [1, 2, 3, 4, 5]);
    });

    it('should parse "weekends"', () => {
      const res = parseDaysOfWeek('weekends');
      assert.ok(res);
      assert.deepEqual(res.days, [0, 6]);
    });

    it('should parse day range "mon-thu"', () => {
      const res = parseDaysOfWeek('mon-thu');
      assert.ok(res);
      assert.deepEqual(res.days, [1, 2, 3, 4]);
    });

    it('should parse comma-separated days "mon,wed,fri"', () => {
      const res = parseDaysOfWeek('mon,wed,fri');
      assert.ok(res);
      assert.deepEqual(res.days, [1, 3, 5]);
    });
  });

  describe('extractCommonFlags', () => {
    it('should extract --max-courts flag', () => {
      const res1 = extractCommonFlags('auto 7pm mon-thu --max-courts=3');
      assert.equal(res1.flags.maxCourts, 3);
      assert.match(res1.remainingText, /auto 7pm mon-thu/);

      const res2 = extractCommonFlags('auto 7pm mon-thu --max-courts 4');
      assert.equal(res2.flags.maxCourts, 4);

      const res3 = extractCommonFlags('auto 7pm mon-thu max-courts=2');
      assert.equal(res3.flags.maxCourts, 2);
    });

    it('should extract common CLI flags and return cleaned remaining text', () => {
      const text = '8 Mon-Thu 7pm --no-matchups --courts --pre-book-courts=2 --court-booking-type=pre-book';
      const { flags, remainingText } = extractCommonFlags(text);

      assert.equal(flags.noMatchups, true);
      assert.equal(flags.checkCourts, true);
      assert.equal(flags.preBookCourts, 2);
      assert.equal(flags.courtBookingType, 'pre-book');
      assert.match(remainingText, /8 Mon-Thu 7pm/);
    });

    it('should extract --pre-allocate-slots flag', () => {
      const text = 'auto 7pm mon-thu --pre-allocate-slots';
      const { flags, remainingText } = extractCommonFlags(text);
      assert.equal(flags.includePrebookedSpots, true);
      assert.equal(flags['--pre-allocate-slots'], true);
      assert.equal(flags['pre-allocate-slots'], true);
      assert.match(remainingText, /auto 7pm mon-thu/);
    });

    it('should extract --no-pre-allocate-slots flag', () => {
      const text = 'auto 7pm mon-thu --no-pre-allocate-slots';
      const { flags, remainingText } = extractCommonFlags(text);
      assert.equal(flags.includePrebookedSpots, false);
      assert.equal(flags['--pre-allocate-slots'], false);
      assert.equal(flags['pre-allocate-slots'], false);
    });

    it('should extract --reminders and --no-reminders flags', () => {
      const res1 = extractCommonFlags('auto 7pm mon-thu --reminders');
      assert.equal(res1.flags.reminders, true);
      assert.match(res1.remainingText, /auto 7pm mon-thu/);

      const res2 = extractCommonFlags('auto 7pm mon-thu --no-reminders');
      assert.equal(res2.flags.reminders, false);
      assert.match(res2.remainingText, /auto 7pm mon-thu/);

      const res3 = extractCommonFlags('auto 7pm mon-thu --reminders=off');
      assert.equal(res3.flags.reminders, false);

      const res4 = extractCommonFlags('auto 7pm mon-thu --reminders=on');
      assert.equal(res4.flags.reminders, true);
    });
  });

  describe('extractSkipArgs', () => {
    it('should extract schedule ID and target date from skip args', () => {
      const res = extractSkipArgs('rec_test 2026-10-05');
      assert.equal(res.scheduleId, 'rec_test');
      assert.equal(res.targetDayOrDate, '2026-10-05');
    });

    it('should extract count when number is passed', () => {
      const res = extractSkipArgs('rec_test 2');
      assert.equal(res.scheduleId, 'rec_test');
      assert.equal(res.count, 2);
    });
  });

  describe('extractPauseArgs', () => {
    it('should extract schedule ID and untilDate', () => {
      const res = extractPauseArgs('rec_test until 2026-10-25');
      assert.equal(res.scheduleId, 'rec_test');
      assert.equal(res.untilDate, '2026-10-25');
    });
  });

  describe('parseRecurringPollText', () => {
    it('should parse --max-courts in recurring poll creation and modification', () => {
      const parsedCreate = parseRecurringPollText('!recurringpoll auto 7pm mon-thu --max-courts=3');
      assert.ok(parsedCreate);
      assert.equal(parsedCreate.maxCourts, 3);

      const parsedMod = parseRecurringPollText('!modifyrecurringpoll rec_1 --max-courts=4');
      assert.ok(parsedMod);
      assert.equal(parsedMod.updates.maxCourts, 4);

      const parsedModNone = parseRecurringPollText('!modifyrecurringpoll rec_1 --max-courts=none');
      assert.ok(parsedModNone);
      assert.equal(parsedModNone.updates.maxCourts, null);
    });

    it('should parse recurring poll creation command', () => {
      const parsed = parseRecurringPollText('!recurringpoll 8 Mon-Thu 7pm at 1:15pm');
      assert.ok(parsed);
      assert.equal(parsed.size, 8);
      assert.equal(parsed.matchTime, '7pm');
      assert.equal(parsed.days.toLowerCase(), 'mon-thu');
    });

    it('should parse --pre-allocate-slots in recurring poll command', () => {
      const parsed = parseRecurringPollText('!recurringpoll auto 7pm mon-thu --pre-allocate-slots');
      assert.ok(parsed);
      assert.equal(parsed.includePrebookedSpots, true);
      assert.equal(parsed['--pre-allocate-slots'], true);
      assert.equal(parsed['pre-allocate-slots'], true);
    });

    it('should default reminders to true in recurring poll command, or false if --no-reminders is passed', () => {
      const parsedDefault = parseRecurringPollText('!recurringpoll auto 7pm mon-thu');
      assert.ok(parsedDefault);
      assert.equal(parsedDefault.reminders, true);

      const parsedNoRemind = parseRecurringPollText('!recurringpoll auto 7pm mon-thu --no-reminders');
      assert.ok(parsedNoRemind);
      assert.equal(parsedNoRemind.reminders, false);
    });

    it('should parse modify recurring poll command', () => {
      const parsed = parseRecurringPollText('!modifyrecurringpoll rec_1 4 6pm');
      assert.ok(parsed);
      assert.equal(parsed.action, 'modify');
      assert.equal(parsed.scheduleId, 'rec_1');
      assert.equal(parsed.updates.size, 4);
      assert.equal(parsed.updates.matchTime, '6pm');
    });

    it('should parse recurring poll list/status commands', () => {
      const parsed1 = parseRecurringPollText('!recurringpolls');
      assert.ok(parsed1);
      assert.equal(parsed1.action, 'list');

      const parsed2 = parseRecurringPollText('!recurringpoll status rec_1');
      assert.ok(parsed2);
      assert.equal(parsed2.action, 'status');
      assert.equal(parsed2.scheduleId, 'rec_1');
    });
  });

  describe('checkAndExecuteAdvanceBookings periodic checks and manual bookings', () => {
    it('should run initial attempt at scheduled time and then periodic checks at 9:30am and 3:30pm daily until completed', async () => {
      const scheduleId = 'sched_adv_test';
      const targetMatchDate = '2026-10-26'; // Monday
      const recurringPolls = new Map();
      const sched = {
        id: scheduleId,
        remoteJid: '120363402559062529@g.us',
        matchTime: '6:30PM',
        matchHour: 18,
        matchMinute: 30,
        days: 'mon',
        daysList: [1],
        size: '8', // 2 courts (8 / 4 = 2)
        enabled: true,
        bookingStrategy: 'advanced',
        bookingSchedule: '-7days 7:00AM',
        postTime: '8:15PM',
        postDaysBefore: 1
      };
      recurringPolls.set(scheduleId, sched);

      const notificationsSent = [];
      const sendBookingNotifications = async (sock, remoteJid, msg) => {
        notificationsSent.push({ remoteJid, msg });
      };

      let bookedCourtsCount = 0;
      let preBookCalls = 0;
      const preBookCourtsForMatch = async (args) => {
        preBookCalls++;
        const advCourts = Array.isArray(args.existingAdvanceBookedCourts) ? [...args.existingAdvanceBookedCourts] : [];
        const preCourts = Array.isArray(args.existingPrebookedCourts) ? [...args.existingPrebookedCourts] : [];

        // First call at 7am: books 1 court
        if (preBookCalls === 1) {
          advCourts.push({ court: 'Court 1', players: ['Player 1', 'Player 2', 'Player 3', 'Player 4'], duration: '90 Minutes' });
          preCourts.push({ court: 'Court 1', player: 'Player 1' });
        } else if (preBookCalls === 4) {
          // On 4th call (Day 2 9:30am): court 2 becomes available and is booked!
          advCourts.push({ court: 'Court 2', players: ['Player 5', 'Player 6', 'Player 7', 'Player 8'], duration: '90 Minutes' });
          preCourts.push({ court: 'Court 2', player: 'Player 5' });
        }
        return { advanceBookedCourts: advCourts, prebookedCourts: preCourts };
      };

      const originalCheckAvail = scvcc.checkCourtAvailability;
      const originalGetBookings = scvcc.getCourtBookings;
      scvcc.checkCourtAvailability = async () => ({ slots: [] });
      scvcc.getCourtBookings = async () => ({ bookings: [] });

      try {
        // Step 1: Monday Oct 19 at 7:00 AM -> Initial booking attempt
        const monday7am = { year: 2026, month: 9, day: 19, weekday: 'mon', hour: 7, minute: 0 };
        await checkAndExecuteAdvanceBookings({
          sock: {},
          recurringPolls,
          persistPolls: () => {},
          preBookCourtsForMatch,
          customSanJoseParts: monday7am,
          sendBookingNotifications
        });

        assert.equal(preBookCalls, 1);
        const entry1 = sched.advanceBookings[targetMatchDate];
        assert.ok(entry1);
        assert.equal(entry1.advanceBookedCourts.length, 1);
        assert.equal(entry1.completed, false);
        assert.equal(entry1.targetCourtsCount, 2);

        // Step 2: Monday Oct 19 at 8:00 AM -> Outside initial window & before 9:30am, no check should run
        const monday8am = { year: 2026, month: 9, day: 19, weekday: 'mon', hour: 8, minute: 0 };
        await checkAndExecuteAdvanceBookings({
          sock: {},
          recurringPolls,
          persistPolls: () => {},
          preBookCourtsForMatch,
          customSanJoseParts: monday8am,
          sendBookingNotifications
        });
        assert.equal(preBookCalls, 1); // No new call

        // Step 3: Monday Oct 19 at 9:30 AM -> Periodic check slot 1 runs
        const monday930am = { year: 2026, month: 9, day: 19, weekday: 'mon', hour: 9, minute: 30 };
        await checkAndExecuteAdvanceBookings({
          sock: {},
          recurringPolls,
          persistPolls: () => {},
          preBookCourtsForMatch,
          customSanJoseParts: monday930am,
          sendBookingNotifications
        });
        assert.equal(preBookCalls, 2);
        const entry2 = sched.advanceBookings[targetMatchDate];
        assert.ok(entry2.periodicChecks.includes('2026-10-19:09:30'));
        assert.equal(entry2.completed, false);

        // Step 4: Monday Oct 19 at 9:31 AM -> Slot 9:30am already executed, should skip
        const monday931am = { year: 2026, month: 9, day: 19, weekday: 'mon', hour: 9, minute: 31 };
        await checkAndExecuteAdvanceBookings({
          sock: {},
          recurringPolls,
          persistPolls: () => {},
          preBookCourtsForMatch,
          customSanJoseParts: monday931am,
          sendBookingNotifications
        });
        assert.equal(preBookCalls, 2); // No new call

        // Step 5: Monday Oct 19 at 3:30 PM -> Periodic check slot 2 runs
        const monday330pm = { year: 2026, month: 9, day: 19, weekday: 'mon', hour: 15, minute: 30 };
        await checkAndExecuteAdvanceBookings({
          sock: {},
          recurringPolls,
          persistPolls: () => {},
          preBookCourtsForMatch,
          customSanJoseParts: monday330pm,
          sendBookingNotifications
        });
        assert.equal(preBookCalls, 3);
        const entry3 = sched.advanceBookings[targetMatchDate];
        assert.ok(entry3.periodicChecks.includes('2026-10-19:15:30'));
        assert.equal(entry3.completed, false);

        // Step 6: Tuesday Oct 20 at 9:30 AM -> Next day periodic check runs, court 2 becomes available
        const tuesday930am = { year: 2026, month: 9, day: 20, weekday: 'tue', hour: 9, minute: 30 };
        await checkAndExecuteAdvanceBookings({
          sock: {},
          recurringPolls,
          persistPolls: () => {},
          preBookCourtsForMatch,
          customSanJoseParts: tuesday930am,
          sendBookingNotifications
        });
        assert.equal(preBookCalls, 4);
        const entry4 = sched.advanceBookings[targetMatchDate];
        assert.ok(entry4.periodicChecks.includes('2026-10-20:09:30'));
        assert.equal(entry4.advanceBookedCourts.length, 2);
        assert.equal(entry4.completed, true);
        assert.equal(notificationsSent.length, 1);
        assert.ok(notificationsSent[0].msg.includes('2 of 2 courts'));

        // Step 7: Tuesday Oct 20 at 3:30 PM -> Completed, should skip
        const tuesday330pm = { year: 2026, month: 9, day: 20, weekday: 'tue', hour: 15, minute: 30 };
        await checkAndExecuteAdvanceBookings({
          sock: {},
          recurringPolls,
          persistPolls: () => {},
          preBookCourtsForMatch,
          customSanJoseParts: tuesday330pm,
          sendBookingNotifications
        });
        assert.equal(preBookCalls, 4); // Still 4, no new call
      } finally {
        scvcc.checkCourtAvailability = originalCheckAvail;
        scvcc.getCourtBookings = originalGetBookings;
      }
    });

    it('should account for manual player bookings and mark completed when target count is reached', async () => {
      const scheduleId = 'sched_manual_test';
      const targetMatchDate = '2026-10-26';
      const recurringPolls = new Map();
      const sched = {
        id: scheduleId,
        remoteJid: '120363402559062529@g.us',
        matchTime: '6:30PM',
        matchHour: 18,
        matchMinute: 30,
        days: 'mon',
        daysList: [1],
        size: '8', // 2 courts
        enabled: true,
        bookingStrategy: 'advanced',
        bookingSchedule: '-7days 7:00AM',
        postTime: '8:15PM',
        postDaysBefore: 1
      };
      recurringPolls.set(scheduleId, sched);

      const notificationsSent = [];
      const sendBookingNotifications = async (sock, remoteJid, msg) => {
        notificationsSent.push({ remoteJid, msg });
      };

      let preBookCalls = 0;
      const preBookCourtsForMatch = async (args) => {
        preBookCalls++;
        const advCourts = Array.isArray(args.existingAdvanceBookedCourts) ? [...args.existingAdvanceBookedCourts] : [];
        const preCourts = Array.isArray(args.existingPrebookedCourts) ? [...args.existingPrebookedCourts] : [];
        if (preBookCalls === 1) {
          advCourts.push({ court: 'Court 1', players: ['Player 1', 'Player 2'], duration: '90 Minutes' });
          preCourts.push({ court: 'Court 1', player: 'Player 1' });
        }
        return { advanceBookedCourts: advCourts, prebookedCourts: preCourts };
      };

      const originalCheckAvail = scvcc.checkCourtAvailability;
      const originalGetBookings = scvcc.getCourtBookings;
      const originalDetectPrebooked = scvcc.detectPrebookedCourt;

      try {
        // At 7am on Oct 19: bot books Court 1
        scvcc.checkCourtAvailability = async () => ({ slots: [] });
        scvcc.getCourtBookings = async () => ({ bookings: [] });

        const monday7am = { year: 2026, month: 9, day: 19, weekday: 'mon', hour: 7, minute: 0 };
        await checkAndExecuteAdvanceBookings({
          sock: {},
          recurringPolls,
          persistPolls: () => {},
          preBookCourtsForMatch,
          customSanJoseParts: monday7am,
          sendBookingNotifications
        });

        assert.equal(preBookCalls, 1);
        assert.equal(sched.advanceBookings[targetMatchDate].completed, false);

        // Before 9:30am: a player manually booked Court 2 on SCVCC
        scvcc.getCourtBookings = async () => ({
          bookings: [
            {
              court: 'Court 2',
              time: '6:30 PM',
              durationMins: 90,
              players: ['Vijay Parthasarathy', 'Vishal Singh']
            }
          ]
        });
        scvcc.detectPrebookedCourt = (booking) => {
          if (booking.court === 'Court 2') {
            return { isPrebooked: true, player: 'Vijay', fullName: 'Vijay Parthasarathy' };
          }
          return null;
        };

        // At 9:30am: periodic check detects player booking for Court 2
        const monday930am = { year: 2026, month: 9, day: 19, weekday: 'mon', hour: 9, minute: 30 };
        await checkAndExecuteAdvanceBookings({
          sock: {},
          recurringPolls,
          persistPolls: () => {},
          preBookCourtsForMatch,
          customSanJoseParts: monday930am,
          sendBookingNotifications
        });

        // preBookCourtsForMatch was NOT called because manual booking completed the count!
        assert.equal(preBookCalls, 1);
        const entry = sched.advanceBookings[targetMatchDate];
        assert.equal(entry.completed, true);
        assert.equal(entry.advanceBookedCourts.length, 1);
        assert.ok(entry.prebookedCourts.some(c => c.court === 'Court 2'));
        // No new court was booked by the bot during periodic checking, so NO summary notification is sent
        assert.equal(notificationsSent.length, 0);
      } finally {
        scvcc.checkCourtAvailability = originalCheckAvail;
        scvcc.getCourtBookings = originalGetBookings;
        scvcc.detectPrebookedCourt = originalDetectPrebooked;
      }
    });

    it('should not send summary booking notification during periodic checking if no new courts were booked by the bot', async () => {
      const scheduleId = 'sched_no_new_courts_test';
      const targetMatchDate = '2026-10-26';
      const recurringPolls = new Map();
      const sched = {
        id: scheduleId,
        remoteJid: '120363402559062529@g.us',
        matchTime: '6:30PM',
        matchHour: 18,
        matchMinute: 30,
        days: 'mon',
        daysList: [1],
        size: '8', // 2 courts
        enabled: true,
        bookingStrategy: 'advanced',
        bookingSchedule: '-7days 7:00AM',
        postTime: '8:15PM',
        postDaysBefore: 1,
        advanceBookings: {
          [targetMatchDate]: {
            advanceBookedCourts: [{ court: 'Court 1', players: ['P1', 'P2'] }],
            prebookedCourts: [{ court: 'Court 1', player: 'P1' }],
            firstAttemptAt: Date.now() - 3600000,
            lastAttemptAt: Date.now() - 3600000,
            completed: false,
            targetCourtsCount: 2,
            periodicChecks: []
          }
        }
      };
      recurringPolls.set(scheduleId, sched);

      const notificationsSent = [];
      const sendBookingNotifications = async (sock, remoteJid, msg) => {
        notificationsSent.push({ remoteJid, msg });
      };

      // preBookCourtsForMatch returns no new courts booked
      const preBookCourtsForMatch = async (args) => {
        return {
          advanceBookedCourts: args.existingAdvanceBookedCourts,
          prebookedCourts: args.existingPrebookedCourts
        };
      };

      const originalCheckAvail = scvcc.checkCourtAvailability;
      const originalGetBookings = scvcc.getCourtBookings;
      scvcc.checkCourtAvailability = async () => ({ slots: [] });
      scvcc.getCourtBookings = async () => ({ bookings: [] });

      try {
        const monday930am = { year: 2026, month: 9, day: 19, weekday: 'mon', hour: 9, minute: 30 };
        await checkAndExecuteAdvanceBookings({
          sock: {},
          recurringPolls,
          persistPolls: () => {},
          preBookCourtsForMatch,
          customSanJoseParts: monday930am,
          sendBookingNotifications
        });

        // Periodic check executed
        assert.ok(sched.advanceBookings[targetMatchDate].periodicChecks.includes('2026-10-19:09:30'));
        // No new court booked -> NO summary notification sent
        assert.equal(notificationsSent.length, 0);
      } finally {
        scvcc.checkCourtAvailability = originalCheckAvail;
        scvcc.getCourtBookings = originalGetBookings;
      }
    });

        it('should stop checking once the poll is created', async () => {
      const scheduleId = 'sched_poll_created_test';
      const targetMatchDate = '2026-10-26';
      const recurringPolls = new Map();
      const sched = {
        id: scheduleId,
        remoteJid: '120363402559062529@g.us',
        matchTime: '6:30PM',
        matchHour: 18,
        matchMinute: 30,
        days: 'mon',
        daysList: [1],
        size: '8', // 2 courts
        enabled: true,
        bookingStrategy: 'advanced',
        bookingSchedule: '-7days 7:00AM',
        postTime: '8:15PM',
        postDaysBefore: 1,
        postedMatchDates: [targetMatchDate] // Poll was already created!
      };
      recurringPolls.set(scheduleId, sched);

      let preBookCalls = 0;
      const preBookCourtsForMatch = async () => {
        preBookCalls++;
        return { advanceBookedCourts: [], prebookedCourts: [] };
      };

      assert.equal(isPollCreatedForMatchDate(sched, targetMatchDate), true);

      // Sweep at 9:30am on Monday Oct 19
      const monday930am = { year: 2026, month: 9, day: 19, weekday: 'mon', hour: 9, minute: 30 };
      await checkAndExecuteAdvanceBookings({
        sock: {},
        recurringPolls,
        persistPolls: () => {},
        preBookCourtsForMatch,
        customSanJoseParts: monday930am
      });

      assert.equal(preBookCalls, 0); // No check run because poll is already created
    });

    it('should ignore manual bookings with less than 90 minutes availability', async () => {
      const originalCheckAvail = scvcc.checkCourtAvailability;
      const originalGetBookings = scvcc.getCourtBookings;
      const originalDetectPrebooked = scvcc.detectPrebookedCourt;

      try {
        scvcc.checkCourtAvailability = async () => ({ slots: [] });
        scvcc.getCourtBookings = async () => ({
          bookings: [
            { court: 'Court 1', durationMins: 60, players: ['Player A'] },
            { court: 'Court 2', durationMins: 90, players: ['Player B'] }
          ]
        });
        scvcc.detectPrebookedCourt = (b) => ({
          isPrebooked: true,
          player: b.court === 'Court 1' ? 'A' : 'B'
        });

        const detected = await detectManualPlayerBookings({
          remoteJid: '120363402559062529@g.us',
          targetDateMDY: '10/26/2026',
          queryTime: '6:30PM'
        });

        assert.equal(detected.length, 1);
        assert.equal(detected[0].court, 'Court 2');
      } finally {
        scvcc.checkCourtAvailability = originalCheckAvail;
        scvcc.getCourtBookings = originalGetBookings;
        scvcc.detectPrebookedCourt = originalDetectPrebooked;
      }
    });
  });


  describe('checkAndPostRecurringPolls retry and notification handling when no courts available', () => {
    it('should retry a couple of times before sending a single failure notification and marking handled', async () => {
      const scheduleId = 'sched_retry_test';
      const targetMatchDate = '2026-10-22';
      const recurringPolls = new Map();
      const sched = {
        id: scheduleId,
        remoteJid: '120363402559062529@g.us',
        matchTime: '7:00PM',
        matchHour: 19,
        matchMinute: 0,
        days: 'thu',
        daysList: [4],
        size: '8',
        enabled: true,
        postTime: '8:15PM',
        postHour: 20,
        postMinute: 15,
        postDaysBefore: 1
      };
      recurringPolls.set(scheduleId, sched);

      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, content) => {
          messagesSent.push({ jid, text: content.text });
          return {};
        }
      };

      let createPollCalls = 0;
      const createMatchPoll = async () => {
        createPollCalls++;
        return {
          err: '⚠️ Cannot create poll for *Thursday 7pm*: No live or prebooked courts are available at SCVCC (all courts are reserved or blocked).',
          noCourtsAvailable: true
        };
      };

      const wednesday815pm = { year: 2026, month: 9, day: 21, weekday: 'wed', hour: 20, minute: 15 };

      // Sweep 1: Initial attempt at 8:15pm
      await checkAndPostRecurringPolls({
        sock: mockSock,
        recurringPolls,
        persistPolls: () => {},
        createMatchPoll,
        getTargetGroupJid: async () => '120363402559062529@g.us',
        customSanJoseParts: wednesday815pm
      });

      assert.equal(createPollCalls, 1);
      assert.equal(messagesSent.length, 0); // No message sent on attempt 1
      assert.equal(sched.postedMatchDates?.includes(targetMatchDate) || false, false);

      // Sweep 2: Next sweep tick (Retry 1)
      await checkAndPostRecurringPolls({
        sock: mockSock,
        recurringPolls,
        persistPolls: () => {},
        createMatchPoll,
        getTargetGroupJid: async () => '120363402559062529@g.us',
        customSanJoseParts: wednesday815pm
      });

      assert.equal(createPollCalls, 2);
      assert.equal(messagesSent.length, 0); // Still no message sent on retry 1
      assert.equal(sched.postedMatchDates?.includes(targetMatchDate) || false, false);

      // Sweep 3: Next sweep tick (Retry 2 - retries exhausted)
      await checkAndPostRecurringPolls({
        sock: mockSock,
        recurringPolls,
        persistPolls: () => {},
        createMatchPoll,
        getTargetGroupJid: async () => '120363402559062529@g.us',
        customSanJoseParts: wednesday815pm
      });

      assert.equal(createPollCalls, 3);
      assert.equal(messagesSent.length, 1); // Exactly ONE notification sent!
      assert.ok(messagesSent[0].text.includes('No live or prebooked courts are available'));
      assert.equal(sched.postedMatchDates.includes(targetMatchDate), true); // Marked posted so it stops retrying!

      // Sweep 4: Subsequent sweep tick
      await checkAndPostRecurringPolls({
        sock: mockSock,
        recurringPolls,
        persistPolls: () => {},
        createMatchPoll,
        getTargetGroupJid: async () => '120363402559062529@g.us',
        customSanJoseParts: wednesday815pm
      });

      assert.equal(createPollCalls, 3); // No new call!
      assert.equal(messagesSent.length, 1); // Still only 1 message sent!
    });
  });

  describe('look around period for court search and booking', () => {
    it('should generate candidate start times in 30-min intervals across the look around window', () => {
      assert.deepEqual(pollTime.getCandidateTimes('6:30pm', 60), ['6:30pm', '7pm', '7:30pm']);
      assert.deepEqual(pollTime.getCandidateTimes('6:30pm', '1 hour'), ['6:30pm', '7pm', '7:30pm']);
      assert.deepEqual(pollTime.getCandidateTimes('6:30pm', 30), ['6:30pm', '7pm']);
      assert.deepEqual(pollTime.getCandidateTimes('6:30pm', 0), ['6:30pm']);
      assert.deepEqual(pollTime.getCandidateTimes('7:00pm', 60), ['7pm', '7:30pm', '8pm']);
    });

    it('should extract lookAround flag from text in CLI and natural language formats', () => {
      const r1 = extractCommonFlags('4 6:30pm weekdays with look around of 1 hour');
      assert.equal(r1.flags.lookAround, 60);
      assert.equal(r1.remainingText, '4 6:30pm weekdays');

      const r2 = extractCommonFlags('4 6:30pm --look-around=1h');
      assert.equal(r2.flags.lookAround, 60);

      const r3 = extractCommonFlags('4 6:30pm look around: 30m');
      assert.equal(r3.flags.lookAround, 30);

      const r4 = extractCommonFlags('4 6:30pm', { 'look-around': '1 hour' });
      assert.equal(r4.flags.lookAround, 60);
    });

    it('should search 6:30pm, 7pm, and 7:30pm for prebooked courts when look around of 1 hour is specified', async () => {
      const originalCheckAvail = scvcc.checkCourtAvailability;
      const originalGetBookings = scvcc.getCourtBookings;
      const originalDetectPrebooked = scvcc.detectPrebookedCourt;
      const queriedTimes = [];

      try {
        scvcc.checkCourtAvailability = async ({ time }) => {
          queriedTimes.push(time);
          return { slots: [] };
        };
        scvcc.getCourtBookings = async ({ time }) => {
          if (time === '7pm') {
            return {
              bookings: [
                { court: 'Court 2', durationMins: 90, players: ['Player B'] }
              ]
            };
          }
          return { bookings: [] };
        };
        scvcc.detectPrebookedCourt = (b) => {
          if (b.court === 'Court 2') return { isPrebooked: true, player: 'B' };
          return null;
        };

        const detected = await detectManualPlayerBookings({
          remoteJid: '120363402559062529@g.us',
          targetDateMDY: '10/26/2026',
          queryTime: '6:30pm',
          lookAround: 60
        });

        assert.deepEqual(queriedTimes, ['6:30pm', '7pm', '7:30pm']);
        assert.equal(detected.length, 1);
        assert.equal(detected[0].court, 'Court 2');
        assert.equal(detected[0].time, '7pm');
      } finally {
        scvcc.checkCourtAvailability = originalCheckAvail;
        scvcc.getCourtBookings = originalGetBookings;
        scvcc.detectPrebookedCourt = originalDetectPrebooked;
      }
    });

    it('should try 7pm followed by 7:30pm when prebooking courts if required number is not reached at 6:30pm', async () => {
      const originalBookCourt = scvcc.bookCourt;
      const bookingAttempts = [];

      try {
        scvcc.bookCourt = async ({ time, court }) => {
          bookingAttempts.push({ time, court });
          // At 6:30pm, 1 court succeeds, but 2nd court fails
          if (time === '6:30pm') {
            if (bookingAttempts.filter(b => b.time === '6:30pm').length === 1) {
              return {
                success: true,
                court: 'Court 1',
                time: '6:30pm',
                duration: '90 Minutes',
                players: ['Player 1', 'Player 2', 'Player 3', 'Player 4']
              };
            }
            return { success: false, message: 'No courts available at 6:30pm' };
          }
          // At 7pm, 2nd court succeeds!
          if (time === '7pm') {
            return {
              success: true,
              court: 'Court 2',
              time: '7pm',
              duration: '90 Minutes',
              players: ['Player 5', 'Player 6', 'Player 7', 'Player 8']
            };
          }
          return { success: false, message: 'No courts available' };
        };

        const res = await pollCommands.preBookCourtsForMatch({
          sock: { sendMessage: async () => ({}) },
          remoteJid: '120363402559062529@g.us',
          targetDateMDY: '10/26/2026',
          queryTime: '6:30pm',
          size: 8, // 2 courts required
          isAuto: false,
          lookAround: 60,
          isAdvanceBooking: true,
          retryDelayMs: 1
        });

        // Verifies 2 courts secured: Court 1 at 6:30pm, Court 2 at 7pm
        assert.equal(res.advanceBookedCourts.length, 2);
        assert.equal(res.advanceBookedCourts[0].court, 'Court 1');
        assert.equal(res.advanceBookedCourts[0].time, '6:30pm');
        assert.equal(res.advanceBookedCourts[1].court, 'Court 2');
        assert.equal(res.advanceBookedCourts[1].time, '7pm');

        // Verifies attempts were made at 6:30pm, and then proceeded to 7pm, and did NOT need 7:30pm
        const bookedTimes = bookingAttempts.map(b => b.time);
        assert.ok(bookedTimes.includes('6:30pm'));
        assert.ok(bookedTimes.includes('7pm'));
        assert.ok(!bookedTimes.includes('7:30pm'));
      } finally {
        scvcc.bookCourt = originalBookCourt;
      }
    });

    it('should search prebooked courts across candidate times when creating a poll with checkCourts and lookAround', async () => {
      const originalCheckAvail = scvcc.checkCourtAvailability;
      const originalGetBookings = scvcc.getCourtBookings;
      const originalDetectPrebooked = scvcc.detectPrebookedCourt;
      const queriedTimes = [];

      try {
        scvcc.checkCourtAvailability = async ({ time }) => {
          queriedTimes.push(time);
          return { slots: [] };
        };
        scvcc.getCourtBookings = async ({ time }) => {
          if (time === '7pm') {
            return {
              bookings: [
                { court: 'Court 3', durationMins: 90, players: ['Player C'] }
              ]
            };
          }
          return { bookings: [] };
        };
        scvcc.detectPrebookedCourt = (b) => {
          if (b.court === 'Court 3') return { isPrebooked: true, player: 'Player C' };
          return null;
        };

        const activePolls = new Map();
        const res = await pollCommands.createMatchPoll(
          {
            sendMessage: async (jid, content) => ({
              key: { id: 'poll_lookaround_test', remoteJid: jid },
              message: content
            })
          },
          '120363402559062529@g.us',
          4,
          'Tomorrow 6:30pm',
          null,
          '6:30pm',
          'Creator',
          null,
          true,
          null,
          false,
          true,
          false,
          true, // checkCourts
          false,
          false,
          null,
          null,
          null,
          null,
          null,
          null,
          { activePolls, messageStore: new Map(), latestPollIdByChat: new Map(), persistPolls: () => {} },
          60 // lookAround: 1 hour
        );

        assert.equal(res.err, null);
        assert.deepEqual(queriedTimes, ['6:30pm', '7pm', '7:30pm']);
        const storedPoll = activePolls.get('poll_lookaround_test');
        assert.ok(storedPoll);
        assert.equal(storedPoll.lookAround, 60);
        assert.equal(storedPoll.lookAroundDisplay, '1 hour');
        assert.ok(storedPoll.prebookedCourts.some(c => c.court === 'Court 3'));
      } finally {
        scvcc.checkCourtAvailability = originalCheckAvail;
        scvcc.getCourtBookings = originalGetBookings;
        scvcc.detectPrebookedCourt = originalDetectPrebooked;
      }
    });

    it('should format poll title with time for courts booked at different times within look around window', async () => {
      const originalCheckAvail = scvcc.checkCourtAvailability;
      const originalGetBookings = scvcc.getCourtBookings;
      const originalDetectPrebooked = scvcc.detectPrebookedCourt;

      try {
        scvcc.checkCourtAvailability = async () => ({ slots: [] });
        scvcc.getCourtBookings = async ({ time }) => {
          if (time === '6:30pm') {
            return {
              bookings: [
                { court: 'Court 2', durationMins: 90, players: ['Player 2'] },
                { court: 'Court 3', durationMins: 90, players: ['Player 3'] }
              ]
            };
          }
          if (time === '7pm') {
            return {
              bookings: [
                { court: 'Court 6', durationMins: 90, players: ['Player 6'] }
              ]
            };
          }
          return { bookings: [] };
        };
        scvcc.detectPrebookedCourt = (b) => {
          if (b.court === 'Court 2') return { isPrebooked: true, player: 'Player 2' };
          if (b.court === 'Court 3') return { isPrebooked: true, player: 'Player 3' };
          if (b.court === 'Court 6') return { isPrebooked: true, player: 'Player 6' };
          return null;
        };

        const activePolls = new Map();
        const res = await pollCommands.createMatchPoll(
          {
            sendMessage: async (jid, content) => ({
              key: { id: 'poll_lookaround_title_test', remoteJid: jid },
              message: content
            })
          },
          '120363402559062529@g.us',
          12,
          'Tomorrow 6:30pm',
          null,
          '6:30pm',
          'Creator',
          null,
          false,
          null,
          false,
          true,
          false,
          true, // checkCourts
          false,
          false,
          null,
          null,
          null,
          null,
          null,
          null,
          { activePolls, messageStore: new Map(), latestPollIdByChat: new Map(), persistPolls: () => {} },
          30 // lookAround: 30 mins
        );

        assert.equal(res.err, null);
        const storedPoll = activePolls.get('poll_lookaround_title_test');
        assert.ok(storedPoll);

        const pollName = storedPoll.name;
        // Verify Court 2 and Court 3 are mentioned as earlier (without time)
        assert.ok(pollName.includes('Court 2 - Booked'), 'Expected "Court 2 - Booked" in poll title: ' + pollName);
        assert.ok(pollName.includes('Court 3 - Booked'), 'Expected "Court 3 - Booked" in poll title: ' + pollName);
        assert.ok(!pollName.includes('Court 2 (6:30pm)'), 'Court 2 should not have time: ' + pollName);
        assert.ok(!pollName.includes('Court 3 (6:30pm)'), 'Court 3 should not have time: ' + pollName);

        // Verify Court 6 mentions the time (7pm) since it differs from 6:30pm
        assert.ok(pollName.includes('Court 6 (7pm) - Booked'), 'Expected "Court 6 (7pm) - Booked" in poll title: ' + pollName);

        // Verify reading back prebooked courts from stored poll name works seamlessly
        const readBackCourts = await pollCommands.getPrebookedCourtsForPoll({ name: pollName });
        const courtNames = readBackCourts.map(c => c.court);
        assert.ok(courtNames.includes('Court 2'));
        assert.ok(courtNames.includes('Court 3'));
        assert.ok(courtNames.includes('Court 6'));

        // Also verify auto poll format
        const autoPolls = new Map();
        const autoRes = await pollCommands.createMatchPoll(
          {
            sendMessage: async (jid, content) => ({
              key: { id: 'poll_auto_lookaround_test', remoteJid: jid },
              message: content
            })
          },
          '120363402559062529@g.us',
          'auto',
          'Tomorrow 6:30pm',
          null,
          '6:30pm',
          'Creator',
          null,
          false,
          null,
          false,
          true,
          false,
          true, // checkCourts
          false,
          false,
          null,
          null,
          null,
          null,
          null,
          null,
          { activePolls: autoPolls, messageStore: new Map(), latestPollIdByChat: new Map(), persistPolls: () => {} },
          30 // lookAround: 30 mins
        );

        assert.equal(autoRes.err, null);
        const autoPoll = autoPolls.get('poll_auto_lookaround_test');
        assert.ok(autoPoll);
        assert.ok(autoPoll.name.includes('Court 2 - Booked'));
        assert.ok(autoPoll.name.includes('Court 3 - Booked'));
        assert.ok(autoPoll.name.includes('Court 6 (7pm) - Booked'));
      } finally {
        scvcc.checkCourtAvailability = originalCheckAvail;
        scvcc.getCourtBookings = originalGetBookings;
        scvcc.detectPrebookedCourt = originalDetectPrebooked;
      }
    });
  });

  describe('recurring poll reminders option', () => {
    it('should default reminders to true when scheduling recurring poll and reflect in card', async () => {
      const recurringPolls = new Map();
      const res = await recurringPollsModule.scheduleRecurringPoll({
        recurringPolls,
        persistPolls: () => {},
        targetChatId: '120363402559062529@g.us',
        sender: 'Alice',
        senderJid: 'alice@s.whatsapp.net',
        params: {
          size: 4,
          matchTime: '7pm',
          days: 'mon-thu'
        }
      });
      assert.ok(typeof res === 'string');
      const sched = [...recurringPolls.values()][0];
      assert.equal(sched.reminders, true);
      assert.ok(res.includes('Reminders:* On'));
    });

    it('should allow setting reminders to false and modify reminders on recurring schedule', async () => {
      const recurringPolls = new Map();
      await recurringPollsModule.scheduleRecurringPoll({
        recurringPolls,
        persistPolls: () => {},
        targetChatId: '120363402559062529@g.us',
        sender: 'Alice',
        senderJid: 'alice@s.whatsapp.net',
        params: {
          size: 4,
          matchTime: '7pm',
          days: 'mon-thu',
          reminders: false
        }
      });
      const sched = [...recurringPolls.values()][0];
      assert.equal(sched.reminders, false);
      const card = recurringPollsModule.formatRecurringScheduleCard(sched);
      assert.ok(card.includes('• *Reminders:* Off'));

      const modRes = await recurringPollsModule.modifyRecurringPoll({
        recurringPolls,
        persistPolls: () => {},
        sender: 'Alice',
        scheduleId: sched.id,
        updates: { reminders: true }
      });
      assert.equal(sched.reminders, true);
      assert.ok(modRes.includes('Reminders for poll instances: *On*'));
    });
  });

});
