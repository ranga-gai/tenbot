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
  checkAndExecuteAdvanceBookings
} = require('../lib/recurringPolls');
const scvcc = require('../lib/scvcc');

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
    it('should extract common CLI flags and return cleaned remaining text', () => {
      const text = '8 Mon-Thu 7pm --no-matchups --courts --pre-book-courts=2 --court-booking-type=pre-book';
      const { flags, remainingText } = extractCommonFlags(text);

      assert.equal(flags.noMatchups, true);
      assert.equal(flags.checkCourts, true);
      assert.equal(flags.preBookCourts, 2);
      assert.equal(flags.courtBookingType, 'pre-book');
      assert.match(remainingText, /8 Mon-Thu 7pm/);
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
    it('should parse recurring poll creation command', () => {
      const parsed = parseRecurringPollText('!recurringpoll 8 Mon-Thu 7pm at 1:15pm');
      assert.ok(parsed);
      assert.equal(parsed.size, 8);
      assert.equal(parsed.matchTime, '7pm');
      assert.equal(parsed.days.toLowerCase(), 'mon-thu');
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

});
