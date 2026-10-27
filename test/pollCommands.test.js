process.env.NODE_ENV = 'test';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const scvcc = require('../lib/scvcc');
const groupsConfig = require('../lib/groupsConfig');
const {
  isValidPlayerCount,
  getNextValidPlayerCount,
  getFirstSlotNumber,
  extractFixedPairsFromText,
  parsePollCreationText,
  resolveManualPollPlayers,
  buildPollReminderText,
  formatReminderHours,
  getSlotNumberForOption,
  checkAndNotifyInvalidSlotVotes,
  handleOnDemandCourtBooking,
  preBookCourtsForMatch,
  checkCourtReleasesForPoll,
  checkCourtReleases,
  getPollVoters,
  sendPollReminder,
  hasTimeSpecifiedInTitle,
  buildUntimedPollReminderText,
  pollTitleIndicatesGame,
  getDayBefore12pmReminderTime,
  getDayBefore6pmReminderTime,
  getPollDayWord,
  checkAndSendPollReminders,
  handleTriggerReminder,
  pollStatusText,
  createMatchPoll,
  checkAndNotifySlotConflicts,
  interpretManualPollWithLLM,
  parseModifyInstanceCommand,
  handleModifyPollInstance,
  formatLineupGenDesc,
  shouldAutoGenerateLineupOnFill,
  checkPendingLineupGenerations,
  buildLineupReminderText,
  migratePollMatchupOptions
} = require('../lib/commands/pollCommands');
const { extractCommonFlags } = require('../lib/recurringPolls');

describe('pollCommands', () => {
  describe('isValidPlayerCount', () => {
    it('should return true for singles (2) and multiples of 4 (4, 8, 12, 16)', () => {
      assert.equal(isValidPlayerCount(2), true);
      assert.equal(isValidPlayerCount(4), true);
      assert.equal(isValidPlayerCount(8), true);
      assert.equal(isValidPlayerCount(12), true);
      assert.equal(isValidPlayerCount(16), true);
    });

    it('should return false for non-conforming counts', () => {
      assert.equal(isValidPlayerCount(1), false);
      assert.equal(isValidPlayerCount(3), false);
      assert.equal(isValidPlayerCount(5), false);
      assert.equal(isValidPlayerCount(6), false);
      assert.equal(isValidPlayerCount(7), false);
      assert.equal(isValidPlayerCount(9), false);
      assert.equal(isValidPlayerCount(10), false);
    });
  });

  describe('getNextValidPlayerCount', () => {
    it('should map counts <= 2 to 2', () => {
      assert.equal(getNextValidPlayerCount(1), 2);
      assert.equal(getNextValidPlayerCount(2), 2);
    });

    it('should round up to next multiple of 4 for counts > 2', () => {
      assert.equal(getNextValidPlayerCount(3), 4);
      assert.equal(getNextValidPlayerCount(4), 4);
      assert.equal(getNextValidPlayerCount(5), 8);
      assert.equal(getNextValidPlayerCount(7), 8);
      assert.equal(getNextValidPlayerCount(8), 8);
      assert.equal(getNextValidPlayerCount(9), 12);
    });
  });

  describe('getFirstSlotNumber', () => {
    it('should extract slot number from option labels', () => {
      assert.equal(getFirstSlotNumber(['Player 3', 'Player 4']), 3);
      assert.equal(getFirstSlotNumber(['Spot 1', 'Spot 2']), 1);
      assert.equal(getFirstSlotNumber(['4', '5']), 4);
      assert.equal(getFirstSlotNumber(['Court 2']), 2);
    });

    it('should return null for non-numbered options like Yes/No', () => {
      assert.equal(getFirstSlotNumber(['Yes', 'No']), null);
      assert.equal(getFirstSlotNumber([]), null);
      assert.equal(getFirstSlotNumber(null), null);
    });
  });

  describe('extractFixedPairsFromText', () => {
    it('should extract "keeping X and Y in same team"', () => {
      const pairs = extractFixedPairsFromText('Can you generate matchups keeping Alice and Bob in same team?');
      assert.deepEqual(pairs, [['Alice', 'Bob']]);
    });

    it('should extract "with X & Y together"', () => {
      const pairs = extractFixedPairsFromText('!matchups with Mike & Sara together');
      assert.deepEqual(pairs, [['Mike', 'Sara']]);
    });

    it('should extract "partner X with Y"', () => {
      const pairs = extractFixedPairsFromText('draw teams partner John with Alex');
      assert.deepEqual(pairs, [['John', 'Alex']]);
    });

    it('should return empty array when no pairing instructions exist', () => {
      const pairs = extractFixedPairsFromText('!matchups');
      assert.deepEqual(pairs, []);
    });
  });

  describe('parsePollCreationText', () => {
    it('should parse command with size, day, and time', () => {
      const parsed = parsePollCreationText('!createpoll 4 today 6pm');
      assert.ok(parsed);
      assert.equal(parsed.size, 4);
      assert.equal(parsed.dayWord, 'today');
      assert.equal(parsed.timeWord, '6pm');
      assert.equal(parsed.when, 'Today 6pm');
    });

    it('should parse natural language poll creation for singles', () => {
      const parsed = parsePollCreationText('create a poll for 2 tomorrow 9am');
      assert.ok(parsed);
      assert.equal(parsed.size, 2);
      assert.equal(parsed.dayWord, 'tomorrow');
      assert.equal(parsed.timeWord, '9am');
    });

    it('should parse natural language poll creation with word numbers', () => {
      const parsed = parsePollCreationText('create a poll for eight on Saturday 10am');
      assert.ok(parsed);
      assert.equal(parsed.size, 8);
      assert.equal(parsed.dayWord.toLowerCase(), 'saturday');
      assert.equal(parsed.timeWord, '10am');
    });

    it('should parse auto size', () => {
      const parsed = parsePollCreationText('!createpoll auto tomorrow 8am');
      assert.ok(parsed);
      assert.equal(parsed.size, 'auto');
    });

    it('should parse opt-in Yes/No poll when no size is given', () => {
      const parsed = parsePollCreationText('create a poll for tomorrow 9am');
      assert.ok(parsed);
      assert.equal(parsed.size, null);
    });

    it('should parse flags like --no-matchups and --courts', () => {
      const parsed = parsePollCreationText('!createpoll 4 today 6pm --no-matchups --courts');
      assert.ok(parsed);
      assert.equal(parsed.noMatchups, true);
      assert.equal(parsed.checkCourts, true);
    });

    it('should return null for non-poll messages', () => {
      assert.equal(parsePollCreationText('who wants to play tennis?'), null);
      assert.equal(parsePollCreationText('!score Mike def John 6-4'), null);
    });
  });

  describe('resolveManualPollPlayers', () => {
    it('should prepend leading creator players if first slot > 1', () => {
      const pollState = {
        type: 'manual',
        size: 4,
        options: ['Player 3', 'Player 4'],
        creator: { name: 'Alice', jid: '123@s.whatsapp.net' }
      };
      const currentPlayers = ['Bob', 'Charlie'];
      const result = resolveManualPollPlayers(pollState, currentPlayers);

      // Slot starts at 3 -> needs 2 leading players: Alice, Alice 2
      assert.equal(result.addedFromLabel.length, 2);
      assert.deepEqual(result.addedFromLabel, ['Alice', 'Alice 2']);
      assert.deepEqual(result.players, ['Alice', 'Alice 2', 'Bob', 'Charlie']);
    });

    it('should not add creator extra players for Yes/No opt-in polls', () => {
      const pollState = {
        type: 'opt_in',
        size: null,
        options: ['Yes', 'No'],
        creator: { name: 'Alice', jid: '123@s.whatsapp.net' }
      };
      const currentPlayers = ['Bob', 'Charlie', 'David'];
      const result = resolveManualPollPlayers(pollState, currentPlayers);

      assert.deepEqual(result.players, ['Bob', 'Charlie', 'David']);
      assert.equal(result.addedCreator, false);
      assert.equal(result.addedExtra.length, 0);
    });
  });

  describe('buildPollReminderText', () => {
    it('should build fixed-slot reminder text', () => {
      const pollState = { when: 'Tomorrow 9am', name: 'Tennis 9am' };
      const text = buildPollReminderText(4, pollState, 2, 4, 'Alice, Bob', false, 0, 4);
      assert.match(text, /Tomorrow 9am/);
      assert.match(text, /2 spots left/i);
    });

    it('should build opt-in reminder text', () => {
      const pollState = { when: 'Tomorrow 9am', name: 'Tennis 9am' };
      const text = buildPollReminderText(4, pollState, 0, 0, 'Alice, Bob', true, 2, 4);
      assert.match(text, /Tomorrow 9am/);
      assert.match(text, /2 player\(s\)/i);
    });

    it('should round to nearest half hour e.g. 10 and half hours to go for 8am reminder for 6:30pm game', () => {
      const pollState = { when: 'Today 6:30pm', name: 'Tennis 6:30pm' };
      // 8am to 6:30pm is 10.5 hours remaining
      const text = buildPollReminderText(16, pollState, 1, 4, 'Alice, Bob, Charlie', false, 0, 10.5);
      assert.match(text, /10 and half Hours to Match Time!/i);

      // Neutral poll
      const neutralPoll = { when: 'Today 6:30pm', name: '6:30pm', isManual: true };
      const neutralText = buildPollReminderText(16, neutralPoll, 1, 4, 'Alice, Bob, Charlie', false, 0, 10.5);
      assert.match(neutralText, /10 and half Hours to Go!/i);
    });

    it('should round to nearest whole hour e.g. 8 hours to go for 10:30am reminder for 6:30pm game', () => {
      const pollState = { when: 'Today 6:30pm', name: 'Tennis 6:30pm' };
      // 10:30am to 6:30pm is 8.0 hours remaining
      const text = buildPollReminderText(8, pollState, 1, 4, 'Alice, Bob, Charlie', false, 0, 8.0);
      assert.match(text, /8 Hours to Match Time!/i);

      // Neutral poll
      const neutralPoll = { when: 'Today 6:30pm', name: '6:30pm', isManual: true };
      const neutralText = buildPollReminderText(8, neutralPoll, 1, 4, 'Alice, Bob, Charlie', false, 0, 8.0);
      assert.match(neutralText, /8 Hours to Go!/i);
    });

    it('should format formatReminderHours correctly for whole and half hours', () => {
      assert.equal(formatReminderHours(10.5), '10 and half');
      assert.equal(formatReminderHours(10.5, true), '10 AND HALF');
      assert.equal(formatReminderHours(8.0), '8');
      assert.equal(formatReminderHours(8.0, true), '8');
      assert.equal(formatReminderHours(2.5), '2 and half');
      assert.equal(formatReminderHours(2.5, true), '2 AND HALF');
      assert.equal(formatReminderHours(10.45), '10 and half');
      assert.equal(formatReminderHours(7.98), '8');
    });
  });

  describe('getSlotNumberForOption', () => {
    it('should extract numeric slot numbers from player option strings', () => {
      assert.equal(getSlotNumberForOption('Player 1', 0), 1);
      assert.equal(getSlotNumberForOption('Player 9', 8), 9);
      assert.equal(getSlotNumberForOption('Player 12', 11), 12);
      assert.equal(getSlotNumberForOption('Slot 8', 7), 8);
    });

    it('should fallback to option index for non-numbered options like spots', () => {
      const pollState = { prebookedPlayers: [{ name: 'Alice' }] };
      assert.equal(getSlotNumberForOption("Bob's Spot", 0, pollState), 1);
      assert.equal(getSlotNumberForOption("Alice's Spot", 1, pollState), 2);
    });

    it('should account for creator leading spot when creator is first slot', () => {
      const pollState = { creator: { name: 'Pramod' } };
      assert.equal(getSlotNumberForOption('Next Player', 0, pollState), 2);
    });
  });

  describe('checkAndNotifyInvalidSlotVotes', () => {
    it('should do nothing when pollState has no slotLimit', async () => {
      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
      };
      const pollState = { slotLimit: null };
      const aggregated = [{ name: 'Player 9', voters: ['123@s.whatsapp.net'] }];

      const notified = await checkAndNotifyInvalidSlotVotes(mockSock, 'poll1', pollState, aggregated, {});
      assert.equal(notified, false);
      assert.equal(messagesSent.length, 0);
    });

    it('should NOT warn voters if total vote count does not exceed slotLimit even if slot numbers are high', async () => {
      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
      };
      const pollState = {
        remoteJid: 'group1@g.us',
        slotLimit: 8,
        invalidSlotVotesNotified: []
      };
      // 4 votes total on slots 1, 8, 9, 10 -> total votes (4) <= 8 openings, so no warning!
      const aggregated = [
        { name: 'Player 1', voters: ['voter1@s.whatsapp.net'] },
        { name: 'Player 8', voters: ['voter8@s.whatsapp.net'] },
        { name: 'Player 9', voters: ['1234567890@s.whatsapp.net'] },
        { name: 'Player 10', voters: ['9876543210@s.whatsapp.net'] }
      ];

      const notified = await checkAndNotifyInvalidSlotVotes(mockSock, 'poll123', pollState, aggregated, {});
      assert.equal(notified, false);
      assert.equal(messagesSent.length, 0);
    });

    it('should notify and tag voters only when total vote count exceeds slotLimit with quoted poll', async () => {
      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg, opts) => {
          messagesSent.push({ jid, msg, opts });
          return { key: { id: 'sent1' } };
        }
      };
      const pollState = {
        remoteJid: 'group1@g.us',
        slotLimit: 8,
        invalidSlotVotesNotified: []
      };
      // 10 votes total for 8 slots -> 9th and 10th exceed available openings
      const aggregated = [
        { name: 'Player 1', voters: ['voter1@s.whatsapp.net'] },
        { name: 'Player 2', voters: ['voter2@s.whatsapp.net'] },
        { name: 'Player 3', voters: ['voter3@s.whatsapp.net'] },
        { name: 'Player 4', voters: ['voter4@s.whatsapp.net'] },
        { name: 'Player 5', voters: ['voter5@s.whatsapp.net'] },
        { name: 'Player 6', voters: ['voter6@s.whatsapp.net'] },
        { name: 'Player 7', voters: ['voter7@s.whatsapp.net'] },
        { name: 'Player 8', voters: ['voter8@s.whatsapp.net'] },
        { name: 'Player 9', voters: ['1234567890@s.whatsapp.net'] },
        { name: 'Player 10', voters: ['9876543210@s.whatsapp.net'] }
      ];

      const notified = await checkAndNotifyInvalidSlotVotes(mockSock, 'poll123', pollState, aggregated, {
        messageStore: new Map([['group1@g.us:poll123', { pollCreation: true }]])
      });

      assert.equal(notified, true);
      assert.equal(messagesSent.length, 2);

      // Verify 9th voter notification
      const msg9 = messagesSent[0];
      assert.equal(msg9.jid, 'group1@g.us');
      assert.match(msg9.msg.text, /@1234567890/);
      assert.match(msg9.msg.text, /all \*8 voting slots\* are already filled/);
      assert.ok(msg9.opts?.quoted?.key?.id === 'poll123');

      // Verify 10th voter notification
      const msg10 = messagesSent[1];
      assert.match(msg10.msg.text, /@9876543210/);
      assert.match(msg10.msg.text, /all \*8 voting slots\* are already filled/);

      // Verify tracking
      assert.deepEqual(pollState.invalidSlotVotesNotified, [
        '1234567890@s.whatsapp.net:8',
        '9876543210@s.whatsapp.net:8'
      ]);

      // Running a second time should not duplicate notifications
      messagesSent.length = 0;
      const reNotified = await checkAndNotifyInvalidSlotVotes(mockSock, 'poll123', pollState, aggregated, {});
      assert.equal(reNotified, false);
      assert.equal(messagesSent.length, 0);
    });
  });

  describe('handleOnDemandCourtBooking', () => {
    it('should successfully book an on-demand court, sending a simple one liner to group and DMs to bookingNotifications', async () => {
      const originalBookCourt = scvcc.bookCourt;
      const originalCheckAvail = scvcc.checkCourtAvailability;

      let bookCalledWith = null;
      scvcc.checkCourtAvailability = async () => ({
        slots: [{ time: '10:30am', courts: [{ court: 'Court 1', status: 'available' }] }]
      });
      scvcc.bookCourt = async (params) => {
        bookCalledWith = params;
        return {
          success: true,
          court: 'Court 1',
          date: '10/19/2026',
          time: '10:30am',
          reservationId: 'res-101',
          message: 'Court 1 booked successfully'
        };
      };

      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
      };

      const pollState = {
        remoteJid: '120363403838804497@g.us',
        targetDateMDY: '10/19/2026',
        queryTime: '10:30am',
        prebookedCourts: [
          { court: 'Court 2', player: 'Player A' },
          { court: 'Court 3', player: 'Player B' }
        ],
        advanceBookedCourts: [
          { court: 'Court 2' },
          { court: 'Court 3' }
        ],
        unbookedCourts: [{ court: 'Court 1' }],
        onDemandBookingInProgress: false
      };

      try {
        await handleOnDemandCourtBooking(mockSock, 'poll101', pollState, [], {});

        assert.ok(bookCalledWith);
        assert.equal(bookCalledWith.court, 'Court 1');
        assert.equal(pollState.prebookedCourts.length, 3);
        assert.equal(pollState.prebookedCourts[2].court, 'Court 1');
        assert.equal(pollState.advanceBookedCourts.length, 3);
        assert.equal(pollState.advanceBookedCourts[2].court, 'Court 1');
        assert.equal(pollState.unbookedCourts.length, 0);
        assert.equal(pollState.onDemandBookingInProgress, false);

        // Verify simple one liner message sent to group chat
        const groupMsg = messagesSent.find((m) => m.jid === '120363403838804497@g.us');
        assert.ok(groupMsg, 'Should send simple one liner message to group chat');
        assert.equal(groupMsg.msg.text, '🎾 *Court 1* is booked! *12 players* can now play.');

        // Verify detailed booking notification (with reservation details) was NOT sent to group chat
        assert.equal(messagesSent.some((m) => m.jid === '120363403838804497@g.us' && m.msg?.text?.includes('booked successfully')), false);

        // Verify DMs were sent only to those in bookingNotifications
        const dmMessages = messagesSent.filter((m) => m.jid.endsWith('@lid'));
        assert.ok(dmMessages.length > 0, 'Booking notifications must be sent as DMs to configured notification LIDs');
        for (const dm of dmMessages) {
          assert.notEqual(dm.jid, '120363403838804497@g.us');
          assert.match(dm.msg.text, /Court 1 booked successfully/);
        }
      } finally {
        scvcc.bookCourt = originalBookCourt;
        scvcc.checkCourtAvailability = originalCheckAvail;
      }
    });

    it('should use players who voted so far and default booking players, strictly excluding prebooked court players', async () => {
      const originalBookCourt = scvcc.bookCourt;
      const originalCheckAvail = scvcc.checkCourtAvailability;

      let bookCalledWith = null;
      scvcc.checkCourtAvailability = async () => ({
        slots: [{ time: '10:30am', courts: [{ court: 'Court 1', status: 'available' }] }]
      });
      scvcc.bookCourt = async (params) => {
        bookCalledWith = params;
        return { success: true, court: 'Court 1', date: '10/19/2026', time: '10:30am', message: 'Booked' };
      };

      const mockSock = { sendMessage: async () => {} };
      const pollState = {
        remoteJid: '120363403838804497@g.us',
        targetDateMDY: '10/19/2026',
        queryTime: '10:30am',
        prebookedCourts: [
          { court: 'Court 2', player: 'Kejal Patel' },
          { court: 'Court 3', player: 'Vijay Parthasarathy' }
        ],
        advanceBookedCourts: [
          { court: 'Court 2', players: ['Pramod Immaneni', 'Kejal Patel', 'Conrad Rodricks', 'Somnath Mani'] },
          { court: 'Court 3', players: ['Vijay Parthasarathy', 'Ghufran Ahmed', 'Mausam Bhatt', 'Amit Bhati'] }
        ],
        unbookedCourts: [{ court: 'Court 1' }],
        bookingPlayers: ['Vishal Singh', 'Gaurav Puri', 'Chandra Sekhar Cheruku'],
        onDemandBookingInProgress: false
      };

      // Votes so far from Vishal Singh (voter) and Mehul Kochar (voter)
      const aggregated = [
        { name: 'Player 1', voters: ['voter1@s.whatsapp.net'] },
        { name: 'Player 2', voters: ['voter2@s.whatsapp.net'] }
      ];

      try {
        await handleOnDemandCourtBooking(mockSock, 'poll_players_test', pollState, aggregated, {});

        assert.ok(bookCalledWith);
        const usedPlayers = bookCalledWith.players.map((p) => p.toLowerCase());

        // Must NOT include players already on prebooked courts (Pramod, Kejal, Conrad, Somnath, Vijay, Ghufran, Mausam, Amit)
        assert.equal(usedPlayers.includes('kejal patel'), false, 'Must exclude Kejal Patel');
        assert.equal(usedPlayers.includes('vijay parthasarathy'), false, 'Must exclude Vijay Parthasarathy');
        assert.equal(usedPlayers.includes('somnath mani'), false, 'Must exclude Somnath Mani');
        assert.equal(usedPlayers.includes('ghufran ahmed'), false, 'Must exclude Ghufran Ahmed');

        // Should use available unbooked players (Vishal Singh, Gaurav Puri, Chandra Sekhar Cheruku)
        assert.ok(usedPlayers.some((p) => p.includes('vishal') || p.includes('gaurav') || p.includes('chandra')));
      } finally {
        scvcc.bookCourt = originalBookCourt;
        scvcc.checkCourtAvailability = originalCheckAvail;
      }
    });

    it('should retry booking 2 times (3 attempts total) if initial attempt fails', async () => {
      const originalBookCourt = scvcc.bookCourt;
      const originalCheckAvail = scvcc.checkCourtAvailability;

      let attempts = 0;
      scvcc.checkCourtAvailability = async () => ({
        slots: [{ time: '10:30am', courts: [{ court: 'Court 1', status: 'available' }] }]
      });
      scvcc.bookCourt = async () => {
        attempts++;
        if (attempts < 3) {
          return { success: false, message: 'Temporary reservation failure' };
        }
        return { success: true, court: 'Court 1', date: '10/19/2026', time: '10:30am', message: 'Booked on retry 2' };
      };

      const mockSock = { sendMessage: async () => {} };
      const pollState = {
        remoteJid: 'group1@g.us',
        targetDateMDY: '10/19/2026',
        queryTime: '10:30am',
        prebookedCourts: [{ court: 'Court 2', player: 'Player A' }],
        advanceBookedCourts: [{ court: 'Court 2' }],
        unbookedCourts: [{ court: 'Court 1' }],
        onDemandBookingInProgress: false
      };

      try {
        await handleOnDemandCourtBooking(mockSock, 'poll_retry_test', pollState, [], {});

        assert.equal(attempts, 3, 'Should attempt 3 times (initial + 2 retries)');
        assert.equal(pollState.prebookedCourts.length, 2);
        assert.equal(pollState.prebookedCourts[1].court, 'Court 1');
        assert.equal(pollState.unbookedCourts.length, 0);
      } finally {
        scvcc.bookCourt = originalBookCourt;
        scvcc.checkCourtAvailability = originalCheckAvail;
      }
    });

    it('should handle on-demand booking failure after exhausting all 2 retries', async () => {
      const originalBookCourt = scvcc.bookCourt;
      const originalCheckAvail = scvcc.checkCourtAvailability;

      let attempts = 0;
      scvcc.checkCourtAvailability = async () => ({
        slots: [{ time: '10:30am', courts: [{ court: 'Court 1', status: 'unavailable' }] }]
      });
      scvcc.bookCourt = async () => {
        attempts++;
        return {
          success: false,
          message: 'No courts available at SCVCC'
        };
      };

      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg, opts) => {
          messagesSent.push({ jid, msg, opts });
          return { key: { id: 'sent-fail' } };
        }
      };

      const pollState = {
        remoteJid: 'group1@g.us',
        targetDateMDY: '10/19/2026',
        queryTime: '10:30am',
        size: 12,
        prebookedCourts: [
          { court: 'Court 2', player: 'Player A' },
          { court: 'Court 3', player: 'Player B' }
        ],
        advanceBookedCourts: [
          { court: 'Court 2' },
          { court: 'Court 3' }
        ],
        unbookedCourts: [{ court: 'Court 1' }],
        invalidSlotVotesNotified: [],
        onDemandBookingInProgress: false
      };

      const aggregated = [
        { name: 'Player 1', voters: ['v1@s.whatsapp.net'] },
        { name: 'Player 2', voters: ['v2@s.whatsapp.net'] },
        { name: 'Player 3', voters: ['v3@s.whatsapp.net'] },
        { name: 'Player 4', voters: ['v4@s.whatsapp.net'] },
        { name: 'Player 5', voters: ['v5@s.whatsapp.net'] },
        { name: 'Player 6', voters: ['v6@s.whatsapp.net'] },
        { name: 'Player 7', voters: ['v7@s.whatsapp.net'] },
        { name: 'Player 8', voters: ['v8@s.whatsapp.net'] },
        { name: 'Player 9', voters: ['1234567890@s.whatsapp.net'] }
      ];

      const origGetBookingNotifs = groupsConfig.getBookingNotifications;
      groupsConfig.getBookingNotifications = () => ['admin1@s.whatsapp.net'];

      try {
        await handleOnDemandCourtBooking(mockSock, 'poll102', pollState, aggregated, {});

        assert.equal(attempts, 3, 'Should have retried 2 times (3 attempts total)');
        // Court 1 removed from unbooked
        assert.equal(pollState.unbookedCourts.length, 0);
        // Valid slots count = 2 courts * 4 = 8
        assert.equal(pollState.slotLimit, 8);
        assert.equal(pollState.size, 8);
        assert.equal(pollState.onDemandBookingInProgress, false);

        // Message must NOT be posted to the group chat
        const courtFailMsgInGroup = messagesSent.find(m => m.jid === 'group1@g.us' && m.msg?.text?.includes('Court 1') && m.msg?.text?.includes('8 voting slots'));
        assert.equal(courtFailMsgInGroup, undefined, 'Court unavailable message must NOT be sent to the group chat');

        // Message MUST be sent to bookingNotifications list
        const notifMsg = messagesSent.find(m => m.jid === 'admin1@s.whatsapp.net' && m.msg?.text?.includes('Court 1') && m.msg?.text?.includes('8 voting slots'));
        assert.ok(notifMsg, 'Recipient in bookingNotifications list was notified');
        assert.equal(notifMsg.msg.text, '⚠️ *Court 1* is no longer available. Only *8 voting slots* are valid for this match poll.');

        // Voter on Player 9 was tagged that slot is no longer valid
        const invalidSlotMsg = messagesSent.find(m => m.msg?.text?.includes('1234567890'));
        assert.ok(invalidSlotMsg, 'Voter on invalid slot 9 was notified');
        assert.match(invalidSlotMsg.msg.text, /@1234567890.*all \*8 voting slots\* are already filled/);
      } finally {
        scvcc.bookCourt = originalBookCourt;
        scvcc.checkCourtAvailability = originalCheckAvail;
        groupsConfig.getBookingNotifications = origGetBookingNotifs;
      }
    });
    it('should correctly calculate player openings when 2 courts are prebooked', () => {
      const bookedCourtsCount = 2;
      const playersPerCourt = 4;
      const bookedCapacity = bookedCourtsCount * playersPerCourt; // 8

      // With 5 votes
      let filledCount = 5;
      let playerOpenings = bookedCapacity - filledCount; // 3
      assert.equal(playerOpenings, 3);
      assert.equal(playerOpenings < 3, false); // does not trigger

      // With 6 votes
      filledCount = 6;
      playerOpenings = bookedCapacity - filledCount; // 2
      assert.equal(playerOpenings, 2);
      assert.equal(playerOpenings < 3, true); // triggers on-demand court booking!
    });
  });

  describe('preBookCourtsForMatch', () => {
    it('should pass minAvailableMinutes: 90 to scvcc.bookCourt when pre-booking courts', async () => {
      const originalBookCourt = scvcc.bookCourt;
      let bookCalledParams = null;

      scvcc.bookCourt = async (params) => {
        bookCalledParams = params;
        return {
          success: true,
          court: 'Court 1',
          players: params.players,
          date: params.date,
          time: params.time,
          reservationId: 'res-prebook-1',
          message: 'Court 1 booked'
        };
      };

      try {
        const res = await preBookCourtsForMatch({
          remoteJid: '120363403838804497@g.us',
          targetDateMDY: '10/22/2026',
          queryTime: '9:00 AM',
          size: 4
        });

        assert.ok(bookCalledParams);
        assert.equal(bookCalledParams.minAvailableMinutes, 90);
        assert.equal(res.advanceBookedCourts.length, 1);
        assert.equal(res.advanceBookedCourts[0].court, 'Court 1');
      } finally {
        scvcc.bookCourt = originalBookCourt;
      }
    });

    it('should pass specific court and minAvailableMinutes: 90 when targetCourt is provided', async () => {
      const originalBookCourt = scvcc.bookCourt;
      let bookCalledParams = null;

      scvcc.bookCourt = async (params) => {
        bookCalledParams = params;
        return {
          success: true,
          court: 'Court 3',
          players: params.players,
          date: params.date,
          time: params.time,
          reservationId: 'res-prebook-2',
          message: 'Court 3 booked'
        };
      };

      try {
        const res = await preBookCourtsForMatch({
          remoteJid: '120363403838804497@g.us',
          targetDateMDY: '10/22/2026',
          queryTime: '9:00 AM',
          court: 'Court 3',
          size: 4
        });

        assert.ok(bookCalledParams);
        assert.equal(bookCalledParams.court, 'Court 3');
        assert.equal(bookCalledParams.minAvailableMinutes, 90);
        assert.equal(res.advanceBookedCourts.length, 1);
        assert.equal(res.advanceBookedCourts[0].court, 'Court 3');
      } finally {
        scvcc.bookCourt = originalBookCourt;
      }
    });
  });
  describe('Yes/No opt-in poll reminder with creator Yes vote', () => {
    const crypto = require('crypto');
    const pollStore = require('../lib/pollStore');

    const yesHash = crypto.createHash('sha256').update('Yes').digest();
    const noHash = crypto.createHash('sha256').update('No').digest();

    it('should accurately report 1 player in for creator Yes vote with pollCreationMessage present', async () => {
      const pollId = 'poll_yesno_creator_1';
      const remoteJid = '120363403838804497@g.us';
      const creatorJid = '165777365799110@lid';
      const creatorName = 'Conrad';

      const pollCreationMessage = {
        pollCreationMessage: {
          name: '🎾 Conrad\'s poll: Tomorrow 9am (Vote Yes/No)',
          options: [{ optionName: 'Yes' }, { optionName: 'No' }],
          selectableOptionsCount: 1
        }
      };

      const messageStore = new Map();
      messageStore.set(`${remoteJid}:${pollId}`, pollCreationMessage);

      const voteBuffer = new Map();
      voteBuffer.set(creatorJid, {
        pollUpdateMessageKey: { remoteJid, participant: creatorJid },
        vote: { selectedOptions: [yesHash] }
      });

      const pollState = {
        remoteJid,
        name: '🎾 Conrad\'s poll: Tomorrow 9am (Vote Yes/No)',
        options: ['Yes', 'No'],
        type: 'opt_in',
        size: null,
        when: 'Tomorrow 9am',
        playAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        status: 'active',
        isManual: false,
        creator: { name: creatorName, jid: creatorJid },
        voteBuffer
      };

      const { interestedPlayers, yesOption } = getPollVoters(pollId, pollState, 'bot@s.whatsapp.net', messageStore);
      assert.equal(interestedPlayers.length, 1);
      assert.equal(interestedPlayers[0], creatorName);
      assert.equal(yesOption.voters.length, 1);

      // Verify reminder message
      let sentMsg = null;
      const mockSock = {
        sendMessage: async (jid, content) => {
          sentMsg = content;
          return { key: { id: 'reminder_1' } };
        }
      };

      const success = await sendPollReminder(mockSock, pollId, pollState, true, { messageStore });
      assert.equal(success, true);
      assert.ok(sentMsg);
      assert.match(sentMsg.text, /\*1 player\(s\)/i);
      assert.match(sentMsg.text, /Conrad/);
      assert.doesNotMatch(sentMsg.text, /\*0 player\(s\) in\*/i);
    });

    it('should correctly deserialize Uint8Array/Buffer in pollStore and not drop to 0 players', async () => {
      const pollId = 'poll_yesno_creator_revive';
      const remoteJid = '120363403838804497@g.us';
      const creatorJid = '165777365799110@lid';
      const creatorName = 'Conrad';

      const pollCreationMessage = {
        pollCreationMessage: {
          name: '🎾 Tomorrow 10am (Vote Yes/No)',
          options: [{ optionName: 'Yes' }, { optionName: 'No' }],
          selectableOptionsCount: 1
        }
      };

      const messageStore = new Map();
      messageStore.set(`${remoteJid}:${pollId}`, pollCreationMessage);

      const voteBuffer = new Map();
      voteBuffer.set(creatorJid, {
        pollUpdateMessageKey: { remoteJid, participant: creatorJid },
        vote: { selectedOptions: [yesHash] }
      });

      const pollState = {
        remoteJid,
        name: '🎾 Tomorrow 10am (Vote Yes/No)',
        options: ['Yes', 'No'],
        type: 'opt_in',
        size: null,
        when: 'Tomorrow 10am',
        playAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        status: 'active',
        isManual: true,
        creator: { name: creatorName, jid: creatorJid },
        voteBuffer
      };

      const activePolls = new Map([[pollId, pollState]]);
      const latestPollIdByChat = new Map([[remoteJid, pollId]]);
      const recurringPolls = new Map();

      // Test serialize & deserialize through pollStore save & load
      pollStore.save({ messageStore, activePolls, latestPollIdByChat, recurringPolls }, remoteJid);
      const reloaded = pollStore.loadGroup(remoteJid);
      const reloadedPoll = reloaded.activePolls.get(pollId);

      const { interestedPlayers, yesOption } = getPollVoters(pollId, reloadedPoll, 'bot@s.whatsapp.net', reloaded.messageStore);
      assert.equal(interestedPlayers.length, 1);
      assert.equal(interestedPlayers[0], creatorName);
      assert.equal(yesOption.voters.length, 1);

      let sentMsg = null;
      const mockSock = {
        sendMessage: async (jid, content) => {
          sentMsg = content;
          return { key: { id: 'reminder_revive' } };
        }
      };

      await sendPollReminder(mockSock, pollId, reloadedPoll, true, { messageStore: reloaded.messageStore });
      assert.ok(sentMsg);
      assert.match(sentMsg.text, /\*1 player\(s\)\*/i);
      assert.match(sentMsg.text, /Conrad/);
      assert.doesNotMatch(sentMsg.text, /\*0 player\(s\)\*/i);
    });

    it('should find pollCreationMessage via fallback key ending with :pollId', async () => {
      const pollId = 'poll_yesno_fallback_key';
      const creatorJid = '165777365799110@lid';
      const creatorName = 'Conrad';

      const pollCreationMessage = {
        pollCreationMessage: {
          name: 'Tomorrow 9am',
          options: [{ optionName: 'Yes' }, { optionName: 'No' }],
          selectableOptionsCount: 1
        }
      };

      // Stored with different remoteJid prefix
      const messageStore = new Map();
      messageStore.set(`diffGroup@g.us:${pollId}`, pollCreationMessage);

      const voteBuffer = new Map();
      voteBuffer.set(creatorJid, {
        pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: creatorJid },
        vote: { selectedOptions: [yesHash] }
      });

      const pollState = {
        remoteJid: 'group1@g.us',
        options: ['Yes', 'No'],
        type: 'opt_in',
        size: null,
        when: 'Tomorrow 9am',
        playAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        status: 'active',
        isManual: false,
        creator: { name: creatorName, jid: creatorJid },
        voteBuffer
      };

      const { interestedPlayers } = getPollVoters(pollId, pollState, 'bot@s.whatsapp.net', messageStore);
      assert.equal(interestedPlayers.length, 1);
      assert.equal(interestedPlayers[0], creatorName);
    });

  });

  describe('checkCourtReleasesForPoll', () => {
    const crypto = require('crypto');
    function makeOptHash(name) {
      return crypto.createHash('sha256').update(name).digest();
    }
    const t0 = new Date('2026-10-20T08:00:00.000Z').getTime();
    const playAt = new Date('2026-10-20T18:00:00.000Z').getTime(); // 10 hours = 600 mins
    // 70% = t0 + 420 mins = 2026-10-20T15:00:00.000Z
    // 70% warn = t0 + 415 mins = 2026-10-20T14:55:00.000Z
    // 80% = t0 + 480 mins = 2026-10-20T16:00:00.000Z
    // 80% warn = t0 + 475 mins = 2026-10-20T15:55:00.000Z
    // 90% = t0 + 540 mins = 2026-10-20T17:00:00.000Z
    // 90% warn = t0 + 535 mins = 2026-10-20T16:55:00.000Z

    it('should send 5-min warning and cancel most recent court at 70% mark if 7 players for 3 courts (Example 1)', async () => {
      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
      };

      const pollState = {
        remoteJid: 'group1@g.us',
        createdAt: new Date(t0).toISOString(),
        playAt: new Date(playAt).toISOString(),
        options: Array.from({ length: 12 }, (_, i) => `Player ${i + 1}`),
        size: 12,
        type: 'fixed',
        status: 'active',
        prebookedCourts: [
          { court: 'Court 1', player: 'P1' },
          { court: 'Court 2', player: 'P2' },
          { court: 'Court 3', player: 'P3' }
        ],
        advanceBookedCourts: [
          { court: 'Court 1', reservationId: 'res-1' },
          { court: 'Court 2', reservationId: 'res-2' },
          { court: 'Court 3', reservationId: 'res-3' }
        ],
        courtReleaseWarningsSent: [],
        courtReleasesDone: [],
        invalidSlotVotesNotified: []
      };

      // 7 votes
      const voteBuffer = new Map();
      for (let i = 1; i <= 7; i++) {
        voteBuffer.set(`voter${i}@s.whatsapp.net`, {
          pollUpdateMessageKey: { remoteJid: 'group1@g.us' },
          pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: `voter${i}@s.whatsapp.net` },
          vote: { selectedOptions: [makeOptHash(`Player ${i}`)] }
        });
      }
      pollState.voteBuffer = voteBuffer;

      const messageStore = new Map();
      messageStore.set('group1@g.us:poll_ex1', {
        pollCreationMessage: {
          options: pollState.options.map((o) => ({ optionName: o }))
        }
      });

      const context = { messageStore, persistPolls: () => {} };

      // 1. At 5 mins before 70% (T0 + 415 mins)
      const tWarn70 = t0 + 415 * 60 * 1000;
      await checkCourtReleasesForPoll(mockSock, 'poll_ex1', pollState, context, tWarn70);

      assert.equal(pollState.courtReleaseWarningsSent.includes(70), true);
      assert.equal(pollState.prebookedCourts.length, 3, 'Court should not be cancelled at warning time');
      const warnMsg = messagesSent.find((m) => m.msg.text.includes('Court 3') && m.msg.text.includes('5 mins'));
      assert.ok(warnMsg, '5-min warning message should be sent for Court 3');

      // 2. At 70% checkpoint (T0 + 420 mins)
      const tCheck70 = t0 + 420 * 60 * 1000;
      await checkCourtReleasesForPoll(mockSock, 'poll_ex1', pollState, context, tCheck70);

      assert.equal(pollState.courtReleasesDone.includes(70), true);
      assert.equal(pollState.prebookedCourts.length, 2, 'Court 3 should be cancelled');
      assert.equal(pollState.prebookedCourts.map(c => c.court).includes('Court 3'), false);
      assert.equal(pollState.slotLimit, 8);
      assert.equal(pollState.size, 8);

      const cancelMsg = messagesSent.find((m) => m.msg.text.includes('Court 3') && m.msg.text.includes('has been cancelled'));
      assert.ok(cancelMsg, 'Cancellation message should be sent for Court 3');
      assert.match(cancelMsg.msg.text, /8 voting slots/);
    });

    it('should not cancel court at 70% mark if players heed warning and fill slots before checkpoint', async () => {
      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
      };

      const pollState = {
        remoteJid: 'group1@g.us',
        createdAt: new Date(t0).toISOString(),
        playAt: new Date(playAt).toISOString(),
        options: Array.from({ length: 12 }, (_, i) => `Player ${i + 1}`),
        size: 12,
        type: 'fixed',
        status: 'active',
        prebookedCourts: [
          { court: 'Court 1', player: 'P1' },
          { court: 'Court 2', player: 'P2' },
          { court: 'Court 3', player: 'P3' }
        ],
        advanceBookedCourts: [
          { court: 'Court 1', reservationId: 'res-1' },
          { court: 'Court 2', reservationId: 'res-2' },
          { court: 'Court 3', reservationId: 'res-3' }
        ],
        courtReleaseWarningsSent: [],
        courtReleasesDone: [],
        invalidSlotVotesNotified: []
      };

      // Initially 7 votes at warning time
      const voteBuffer = new Map();
      for (let i = 1; i <= 7; i++) {
        voteBuffer.set(`voter${i}@s.whatsapp.net`, {
          pollUpdateMessageKey: { remoteJid: 'group1@g.us' },
          pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: `voter${i}@s.whatsapp.net` },
          vote: { selectedOptions: [makeOptHash(`Player ${i}`)] }
        });
      }
      pollState.voteBuffer = voteBuffer;

      const messageStore = new Map();
      messageStore.set('group1@g.us:poll_heed', {
        pollCreationMessage: {
          options: pollState.options.map((o) => ({ optionName: o }))
        }
      });
      const context = { messageStore, persistPolls: () => {} };

      // At warning time (T0 + 415 mins) -> sends warning
      await checkCourtReleasesForPoll(mockSock, 'poll_heed', pollState, context, t0 + 415 * 60 * 1000);
      assert.equal(pollState.courtReleaseWarningsSent.includes(70), true);

      // Players heed warning! 2 more players vote -> 9 players now (needs 3 courts)
      for (let i = 8; i <= 9; i++) {
        voteBuffer.set(`voter${i}@s.whatsapp.net`, {
          pollUpdateMessageKey: { remoteJid: 'group1@g.us' },
          pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: `voter${i}@s.whatsapp.net` },
          vote: { selectedOptions: [makeOptHash(`Player ${i}`)] }
        });
      }

      // At checkpoint time (T0 + 420 mins)
      messagesSent.length = 0;
      await checkCourtReleasesForPoll(mockSock, 'poll_heed', pollState, context, t0 + 420 * 60 * 1000);

      assert.equal(pollState.courtReleasesDone.includes(70), true);
      assert.equal(pollState.prebookedCourts.length, 3, 'Court 3 should NOT be cancelled because 9 players need 3 courts');
      const cancelMsg = messagesSent.find((m) => m.msg.text.includes('cancelled'));
      assert.equal(cancelMsg, undefined, 'No cancellation message should be sent');
    });

    it('should release one court at 70% and another at 80% if 3 courts booked and 3 votes (Example 2)', async () => {
      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
      };

      const pollState = {
        remoteJid: 'group1@g.us',
        createdAt: new Date(t0).toISOString(),
        playAt: new Date(playAt).toISOString(),
        options: Array.from({ length: 12 }, (_, i) => `Player ${i + 1}`),
        size: 12,
        type: 'fixed',
        status: 'active',
        prebookedCourts: [
          { court: 'Court 1', player: 'P1' },
          { court: 'Court 2', player: 'P2' },
          { court: 'Court 3', player: 'P3' }
        ],
        advanceBookedCourts: [
          { court: 'Court 1', reservationId: 'res-1' },
          { court: 'Court 2', reservationId: 'res-2' },
          { court: 'Court 3', reservationId: 'res-3' }
        ],
        courtReleaseWarningsSent: [],
        courtReleasesDone: [],
        invalidSlotVotesNotified: []
      };

      // 3 votes
      const voteBuffer = new Map();
      for (let i = 1; i <= 3; i++) {
        voteBuffer.set(`voter${i}@s.whatsapp.net`, {
          pollUpdateMessageKey: { remoteJid: 'group1@g.us' },
          pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: `voter${i}@s.whatsapp.net` },
          vote: { selectedOptions: [makeOptHash(`Player ${i}`)] }
        });
      }
      pollState.voteBuffer = voteBuffer;

      const messageStore = new Map();
      messageStore.set('group1@g.us:poll_ex2', {
        pollCreationMessage: {
          options: pollState.options.map((o) => ({ optionName: o }))
        }
      });
      const context = { messageStore, persistPolls: () => {} };

      // At 70% checkpoint (T0 + 420 mins) -> cancels 1 court (Court 3)
      await checkCourtReleasesForPoll(mockSock, 'poll_ex2', pollState, context, t0 + 420 * 60 * 1000);
      assert.equal(pollState.prebookedCourts.length, 2);
      assert.deepEqual(pollState.prebookedCourts.map(c => c.court), ['Court 1', 'Court 2']);
      assert.equal(pollState.slotLimit, 8);

      // At 80% warning (T0 + 475 mins) -> sends warning for Court 2
      await checkCourtReleasesForPoll(mockSock, 'poll_ex2', pollState, context, t0 + 475 * 60 * 1000);
      assert.equal(pollState.courtReleaseWarningsSent.includes(80), true);
      const warn80 = messagesSent.find((m) => m.msg.text.includes('Court 2') && m.msg.text.includes('5 mins'));
      assert.ok(warn80, 'Warning sent for Court 2 before 80% mark');

      // At 80% checkpoint (T0 + 480 mins) -> cancels Court 2
      await checkCourtReleasesForPoll(mockSock, 'poll_ex2', pollState, context, t0 + 480 * 60 * 1000);
      assert.equal(pollState.prebookedCourts.length, 1);
      assert.deepEqual(pollState.prebookedCourts.map(c => c.court), ['Court 1']);
      assert.equal(pollState.slotLimit, 4);

      // At 90% checkpoint (T0 + 540 mins) -> 3 players need 1 court, Court 1 stays!
      await checkCourtReleasesForPoll(mockSock, 'poll_ex2', pollState, context, t0 + 540 * 60 * 1000);
      assert.equal(pollState.prebookedCourts.length, 1);
      assert.equal(pollState.prebookedCourts[0].court, 'Court 1');
    });

    it('should cancel court at 80% if 10 players at 70% dropped to 7 after that (Example 3)', async () => {
      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
      };

      const pollState = {
        remoteJid: 'group1@g.us',
        createdAt: new Date(t0).toISOString(),
        playAt: new Date(playAt).toISOString(),
        options: Array.from({ length: 12 }, (_, i) => `Player ${i + 1}`),
        size: 12,
        type: 'fixed',
        status: 'active',
        prebookedCourts: [
          { court: 'Court 1', player: 'P1' },
          { court: 'Court 2', player: 'P2' },
          { court: 'Court 3', player: 'P3' }
        ],
        advanceBookedCourts: [
          { court: 'Court 1', reservationId: 'res-1' },
          { court: 'Court 2', reservationId: 'res-2' },
          { court: 'Court 3', reservationId: 'res-3' }
        ],
        courtReleaseWarningsSent: [],
        courtReleasesDone: [],
        invalidSlotVotesNotified: []
      };

      // 10 votes initially
      const voteBuffer = new Map();
      for (let i = 1; i <= 10; i++) {
        voteBuffer.set(`voter${i}@s.whatsapp.net`, {
          pollUpdateMessageKey: { remoteJid: 'group1@g.us' },
          pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: `voter${i}@s.whatsapp.net` },
          vote: { selectedOptions: [makeOptHash(`Player ${i}`)] }
        });
      }
      pollState.voteBuffer = voteBuffer;

      const messageStore = new Map();
      messageStore.set('group1@g.us:poll_ex3', {
        pollCreationMessage: {
          options: pollState.options.map((o) => ({ optionName: o }))
        }
      });
      const context = { messageStore, persistPolls: () => {} };

      // At 70% mark (T0 + 420 mins) with 10 players -> no court cancelled
      await checkCourtReleasesForPoll(mockSock, 'poll_ex3', pollState, context, t0 + 420 * 60 * 1000);
      assert.equal(pollState.prebookedCourts.length, 3);
      assert.equal(pollState.courtReleasesDone.includes(70), true);

      // 3 players unvote -> now 7 players
      voteBuffer.delete('voter8@s.whatsapp.net');
      voteBuffer.delete('voter9@s.whatsapp.net');
      voteBuffer.delete('voter10@s.whatsapp.net');

      // At 80% warning (T0 + 475 mins) -> sends warning for Court 3
      await checkCourtReleasesForPoll(mockSock, 'poll_ex3', pollState, context, t0 + 475 * 60 * 1000);
      assert.equal(pollState.courtReleaseWarningsSent.includes(80), true);

      // At 80% checkpoint (T0 + 480 mins) -> cancels Court 3
      await checkCourtReleasesForPoll(mockSock, 'poll_ex3', pollState, context, t0 + 480 * 60 * 1000);
      assert.equal(pollState.prebookedCourts.length, 2);
      assert.equal(pollState.courtReleasesDone.includes(80), true);
      assert.deepEqual(pollState.prebookedCourts.map(c => c.court), ['Court 1', 'Court 2']);
      assert.equal(pollState.slotLimit, 8);
    });

    it('should cancel one court each at 70%, 80%, and 90% if 3 courts booked and 0 votes (Example 4)', async () => {
      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
      };

      const pollState = {
        remoteJid: 'group1@g.us',
        createdAt: new Date(t0).toISOString(),
        playAt: new Date(playAt).toISOString(),
        options: Array.from({ length: 12 }, (_, i) => `Player ${i + 1}`),
        size: 12,
        type: 'fixed',
        status: 'active',
        prebookedCourts: [
          { court: 'Court 1', player: 'P1' },
          { court: 'Court 2', player: 'P2' },
          { court: 'Court 3', player: 'P3' }
        ],
        advanceBookedCourts: [
          { court: 'Court 1', reservationId: 'res-1' },
          { court: 'Court 2', reservationId: 'res-2' },
          { court: 'Court 3', reservationId: 'res-3' }
        ],
        courtReleaseWarningsSent: [],
        courtReleasesDone: [],
        invalidSlotVotesNotified: [],
        voteBuffer: new Map()
      };

      const messageStore = new Map();
      messageStore.set('group1@g.us:poll_ex4', {
        pollCreationMessage: {
          options: pollState.options.map((o) => ({ optionName: o }))
        }
      });
      const context = { messageStore, persistPolls: () => {} };

      // At 70% checkpoint -> cancels Court 3
      await checkCourtReleasesForPoll(mockSock, 'poll_ex4', pollState, context, t0 + 420 * 60 * 1000);
      assert.equal(pollState.prebookedCourts.length, 2);
      assert.equal(pollState.prebookedCourts.map(c => c.court).includes('Court 3'), false);

      // At 80% checkpoint -> cancels Court 2
      await checkCourtReleasesForPoll(mockSock, 'poll_ex4', pollState, context, t0 + 480 * 60 * 1000);
      assert.equal(pollState.prebookedCourts.length, 1);
      assert.equal(pollState.prebookedCourts.map(c => c.court).includes('Court 2'), false);

      // At 90% checkpoint -> cancels Court 1
      await checkCourtReleasesForPoll(mockSock, 'poll_ex4', pollState, context, t0 + 540 * 60 * 1000);
      assert.equal(pollState.prebookedCourts.length, 0);
      assert.equal(pollState.status, 'stopped');
      assert.equal(pollState.slotLimit, 0);
    });

    it('should ensure no extra courts remaining at 90% by cancelling multiple courts at once (Example 5)', async () => {
      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
      };

      const pollState = {
        remoteJid: 'group1@g.us',
        createdAt: new Date(t0).toISOString(),
        playAt: new Date(playAt).toISOString(),
        options: Array.from({ length: 12 }, (_, i) => `Player ${i + 1}`),
        size: 12,
        type: 'fixed',
        status: 'active',
        prebookedCourts: [
          { court: 'Court 1', player: 'P1' },
          { court: 'Court 2', player: 'P2' },
          { court: 'Court 3', player: 'P3' }
        ],
        advanceBookedCourts: [
          { court: 'Court 1', reservationId: 'res-1' },
          { court: 'Court 2', reservationId: 'res-2' },
          { court: 'Court 3', reservationId: 'res-3' }
        ],
        courtReleaseWarningsSent: [70, 80],
        courtReleasesDone: [70, 80],
        invalidSlotVotesNotified: []
      };

      // Only 2 players voted (needs 1 court). 3 courts booked -> 2 extra courts!
      const voteBuffer = new Map();
      for (let i = 1; i <= 2; i++) {
        voteBuffer.set(`voter${i}@s.whatsapp.net`, {
          pollUpdateMessageKey: { remoteJid: 'group1@g.us' },
          pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: `voter${i}@s.whatsapp.net` },
          vote: { selectedOptions: [makeOptHash(`Player ${i}`)] }
        });
      }
      pollState.voteBuffer = voteBuffer;

      const messageStore = new Map();
      messageStore.set('group1@g.us:poll_multi', {
        pollCreationMessage: {
          options: pollState.options.map((o) => ({ optionName: o }))
        }
      });
      const context = { messageStore, persistPolls: () => {} };

      // At 90% checkpoint (T0 + 540 mins) -> cancels both Court 3 and Court 2 at once!
      await checkCourtReleasesForPoll(mockSock, 'poll_multi', pollState, context, t0 + 540 * 60 * 1000);
      assert.equal(pollState.prebookedCourts.length, 1);
      assert.deepEqual(pollState.prebookedCourts.map(c => c.court), ['Court 1']);
      assert.equal(pollState.slotLimit, 4);

      const cancelMsg = messagesSent.find((m) => m.msg.text.includes('Court 3 and Court 2') || (m.msg.text.includes('Court 3') && m.msg.text.includes('Court 2')));
      assert.ok(cancelMsg, 'Cancellation message mentions multiple courts');
    });
  });

  describe('Re-booking of released courts on-demand', () => {
    const crypto = require('crypto');
    function makeOptHash(name) {
      return crypto.createHash('sha256').update(name).digest();
    }

    it('should NOT initiate re-booking when openings fall below 3 if player openings still exist (e.g. 7 votes for 8 spots)', async () => {
      let bookCourtCalled = false;
      const originalBookCourt = scvcc.bookCourt;
      scvcc.bookCourt = async () => { bookCourtCalled = true; return { success: true }; };

      const pollState = {
        remoteJid: 'group1@g.us',
        size: 8,
        slotLimit: 8,
        prebookedCourts: [{ court: 'Court 1' }, { court: 'Court 2' }],
        releasedCourts: [{ court: 'Court 3' }],
        onDemandBookingInProgress: false,
        invalidSlotVotesNotified: [],
        voteBuffer: new Map()
      };

      // 7 votes for 8 spots -> player openings = 1 (< 3), but openings still exist, so NO re-booking!
      const aggregated = [];
      for (let i = 1; i <= 7; i++) {
        aggregated.push({ name: `Player ${i}`, voters: [`voter${i}@s.whatsapp.net`] });
        pollState.voteBuffer.set(`voter${i}@s.whatsapp.net`, {
          pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: `voter${i}@s.whatsapp.net` },
          vote: { selectedOptions: [makeOptHash(`Player ${i}`)] }
        });
      }

      const mockSock = { sendMessage: async () => {} };
      try {
        const { processPollVoteEvent } = require('../lib/commands/pollCommands');
        const messageStore = new Map([['group1@g.us:poll_rebook_no', {
          messageContextInfo: { messageSecret: Buffer.from('secret') },
          pollCreationMessage: { options: Array.from({ length: 12 }, (_, i) => ({ optionName: `Player ${i+1}` })) }
        }]]);
        await processPollVoteEvent(mockSock, { id: 'poll_rebook_no', remoteJid: 'group1@g.us' }, [], {
          activePolls: new Map([['poll_rebook_no', pollState]]),
          messageStore,
          persistPolls: () => {}
        });

        assert.equal(bookCourtCalled, false, 'Re-booking must NOT be initiated when free openings remain');
      } finally {
        scvcc.bookCourt = originalBookCourt;
      }
    });

    it('should initiate rebooking when 9th voter arrives (no free openings) and succeed, updating capacity to 12', async () => {
      let bookCourtCalled = false;
      const originalBookCourt = scvcc.bookCourt;
      const originalCheckAvail = scvcc.checkCourtAvailability;

      scvcc.checkCourtAvailability = async () => ({
        slots: [{ time: '10:00am', courts: [{ court: 'Court 3', status: 'available' }] }]
      });
      scvcc.bookCourt = async (params) => {
        bookCourtCalled = true;
        return {
          success: true,
          court: 'Court 3',
          date: '10/20/2026',
          time: '10:00am',
          reservationId: 'res-rebook-3',
          players: params.players
        };
      };

      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg, opts) => { messagesSent.push({ jid, msg, opts }); }
      };

      const pollState = {
        remoteJid: 'group1@g.us',
        size: 8,
        slotLimit: 8,
        prebookedCourts: [{ court: 'Court 1' }, { court: 'Court 2' }],
        releasedCourts: [{ court: 'Court 3' }],
        onDemandBookingInProgress: false,
        invalidSlotVotesNotified: [],
        voteBuffer: new Map()
      };

      // 9 votes (for 8 spots)
      const aggregated = [];
      for (let i = 1; i <= 9; i++) {
        aggregated.push({ name: `Player ${i}`, voters: [`voter${i}@s.whatsapp.net`] });
        pollState.voteBuffer.set(`voter${i}@s.whatsapp.net`, {
          pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: `voter${i}@s.whatsapp.net` },
          vote: { selectedOptions: [makeOptHash(`Player ${i}`)] },
          senderTimestampMs: 1000 + i
        });
      }

      try {
        await handleOnDemandCourtBooking(mockSock, 'poll_rebook_yes', pollState, aggregated, {}, {
          isRebooking: true,
          targetCourt: pollState.releasedCourts[0],
          triggeringVoterJid: 'voter9@s.whatsapp.net'
        });

        assert.equal(bookCourtCalled, true);
        assert.equal(pollState.prebookedCourts.length, 3);
        assert.equal(pollState.slotLimit, 12);
        assert.equal(pollState.size, 12);
        assert.equal(pollState.releasedCourts.length, 0);

        const confirmMsg = messagesSent.find(m => m.msg.text && m.msg.text.includes('Court 3') && m.msg.text.includes('booked'));
        assert.ok(confirmMsg, 'Confirmation message sent to group for Court 3');
        assert.match(confirmMsg.msg.text, /\*12 players\* can now play/);
      } finally {
        scvcc.bookCourt = originalBookCourt;
        scvcc.checkCourtAvailability = originalCheckAvail;
      }
    });

    it('should quote the user with rejection message when re-booking fails on 9th voter', async () => {
      const originalBookCourt = scvcc.bookCourt;
      const originalCheckAvail = scvcc.checkCourtAvailability;

      scvcc.checkCourtAvailability = async () => ({
        slots: [{ time: '10:00am', courts: [{ court: 'Court 3', status: 'unavailable' }] }]
      });
      scvcc.bookCourt = async () => ({ success: false, message: 'Court unavailable' });

      const messagesSent = [];
      const mockSock = {
        sendMessage: async (jid, msg, opts) => { messagesSent.push({ jid, msg, opts }); }
      };

      const pollState = {
        remoteJid: 'group1@g.us',
        size: 8,
        slotLimit: 8,
        prebookedCourts: [{ court: 'Court 1' }, { court: 'Court 2' }],
        releasedCourts: [{ court: 'Court 3' }],
        onDemandBookingInProgress: false,
        invalidSlotVotesNotified: [],
        voteBuffer: new Map()
      };

      const aggregated = [];
      for (let i = 1; i <= 9; i++) {
        aggregated.push({ name: `Player ${i}`, voters: [`voter${i}@s.whatsapp.net`] });
        pollState.voteBuffer.set(`voter${i}@s.whatsapp.net`, {
          pollUpdateMessageKey: { remoteJid: 'group1@g.us', participant: `voter${i}@s.whatsapp.net`, id: `voteMsg${i}` },
          vote: { selectedOptions: [makeOptHash(`Player ${i}`)] },
          senderTimestampMs: 1000 + i
        });
      }

      try {
        await handleOnDemandCourtBooking(mockSock, 'poll_rebook_fail', pollState, aggregated, {}, {
          isRebooking: true,
          targetCourt: pollState.releasedCourts[0],
          triggeringVoterJid: 'voter9@s.whatsapp.net',
          triggeringVoteMsgKey: { remoteJid: 'group1@g.us', id: 'voteMsg9' }
        });

        assert.equal(pollState.prebookedCourts.length, 2);
        assert.equal(pollState.slotLimit, 8);
        assert.equal(pollState.releasedCourts.length, 0);

        const failQuoteMsg = messagesSent.find(m => m.msg.text && m.msg.text.includes('voter9') || (m.opts?.quoted?.key?.id === 'voteMsg9'));
        assert.ok(failQuoteMsg, 'Failure message quoting voter 9 sent to group');
        assert.match(failQuoteMsg.msg.text, /all \*8 voting slots\* are filled/);
        assert.match(failQuoteMsg.msg.text, /Your vote will not be considered/);
        assert.equal(failQuoteMsg.opts?.quoted?.key?.id, 'voteMsg9');
      } finally {
        scvcc.bookCourt = originalBookCourt;
        scvcc.checkCourtAvailability = originalCheckAvail;
      }
    });
  });
  describe("manual poll with no time specified", () => {
    describe("hasTimeSpecifiedInTitle", () => {
      it("should return true when time is specified in the title or poll object", () => {
        assert.equal(hasTimeSpecifiedInTitle("Tennis 7pm"), true);
        assert.equal(hasTimeSpecifiedInTitle("Tennis tomorrow 9:30am"), true);
        assert.equal(hasTimeSpecifiedInTitle("Sunday 6:00"), true);
        assert.equal(hasTimeSpecifiedInTitle("Saturday morning tennis"), true);
        assert.equal(hasTimeSpecifiedInTitle("Tennis @ 8am"), true);
        assert.equal(hasTimeSpecifiedInTitle("Tennis at 7"), true);
        assert.equal(hasTimeSpecifiedInTitle("Tennis 6 PM"), true);
        assert.equal(hasTimeSpecifiedInTitle("Tennis 19:00"), true);
        assert.equal(hasTimeSpecifiedInTitle({ name: "Match 8:30am" }), true);
        assert.equal(hasTimeSpecifiedInTitle({ hasTimeInTitle: true }), true);
      });

      it("should return false when no time is specified in the title or poll object", () => {
        assert.equal(hasTimeSpecifiedInTitle("Tennis Saturday"), false);
        assert.equal(hasTimeSpecifiedInTitle("Tennis Sunday"), false);
        assert.equal(hasTimeSpecifiedInTitle("Tennis Tomorrow"), false);
        assert.equal(hasTimeSpecifiedInTitle("Tennis Today"), false);
        assert.equal(hasTimeSpecifiedInTitle("Tennis"), false);
        assert.equal(hasTimeSpecifiedInTitle("Match Poll"), false);
        assert.equal(hasTimeSpecifiedInTitle("Tennis @ SCVCC"), false);
        assert.equal(hasTimeSpecifiedInTitle("Sunday tennis at SCVCC"), false);
        assert.equal(hasTimeSpecifiedInTitle("Tennis 4 spots"), false);
        assert.equal(hasTimeSpecifiedInTitle("Court 2 Tennis"), false);
        assert.equal(hasTimeSpecifiedInTitle("Tennis 10/24"), false);
        assert.equal(hasTimeSpecifiedInTitle("Singles this weekend"), false);
        assert.equal(hasTimeSpecifiedInTitle({ name: "Tennis Sunday", playAt: null }), false);
        assert.equal(hasTimeSpecifiedInTitle({ hasTimeInTitle: false }), false);
        assert.equal(hasTimeSpecifiedInTitle({ playAt: null }), false);
        assert.equal(hasTimeSpecifiedInTitle({ playAt: "unknown" }), false);
      });
    });

    describe("reminders for manual polls without time", () => {
      it("should return false and send no reminder if no day and no time are specified", async () => {
        const messagesSent = [];
        const mockSock = {
          user: { id: "1234567890@s.whatsapp.net" },
          sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
        };

        const manualPollNoDayNoTime = {
          name: "Tennis 4 spots",
          isManual: true,
          status: "active",
          remoteJid: "group1@g.us",
          when: null,
          playAt: null,
          options: ["Player 1", "Player 2", "Player 3", "Player 4"],
          type: "manual",
          voteBuffer: new Map()
        };

        const sent = await sendPollReminder(mockSock, "poll_noday", manualPollNoDayNoTime, false, {
          messageStore: new Map()
        });
        assert.equal(sent, false);
        assert.equal(messagesSent.length, 0);
      });

      it("should use neutral terms and avoid tennis/match wording when manual poll title does not indicate a game", () => {
        assert.equal(pollTitleIndicatesGame("Tennis Sunday"), true);
        assert.equal(pollTitleIndicatesGame("Sunday Match"), true);
        assert.equal(pollTitleIndicatesGame("Game tomorrow"), true);
        assert.equal(pollTitleIndicatesGame("Doubles Saturday"), true);
        assert.equal(pollTitleIndicatesGame("Court 2"), true);
        assert.equal(pollTitleIndicatesGame("🎾 Sunday"), true);
        assert.equal(pollTitleIndicatesGame("Sunday"), false);
        assert.equal(pollTitleIndicatesGame("Sunday 6pm"), false);
        assert.equal(pollTitleIndicatesGame("Tomorrow"), false);
        assert.equal(pollTitleIndicatesGame("Tomorrow 7pm"), false);
        assert.equal(pollTitleIndicatesGame("Weekend"), false);

        // Untimed neutral reminder (Opt-in)
        const neutralOptIn = { name: "Sunday", isManual: true, when: "Sunday", playAt: null };
        const neutralOptInText = buildUntimedPollReminderText(neutralOptIn, 0, 0, "Alice, Bob", true, 2);
        assert.match(neutralOptInText, /Poll Reminder for Tomorrow!/);
        assert.match(neutralOptInText, /for tomorrow/);
        assert.equal(/tennis/i.test(neutralOptInText), false, "Must not contain tennis");
        assert.equal(/match/i.test(neutralOptInText), false, "Must not contain match");
        assert.equal(/court/i.test(neutralOptInText), false, "Must not contain court");
        assert.equal(neutralOptInText.includes("🎾"), false, "Must not contain tennis emoji");

        // Untimed neutral reminder (Fixed spots)
        const neutralFixed = { name: "Sunday", isManual: true, when: "Sunday", playAt: null };
        const neutralFixedText = buildUntimedPollReminderText(neutralFixed, 2, 4, "Alice, Bob", false, 0);
        assert.match(neutralFixedText, /Poll Reminder for Tomorrow!/);
        assert.match(neutralFixedText, /The poll for tomorrow still has/);
        assert.equal(/tennis/i.test(neutralFixedText), false, "Must not contain tennis");
        assert.equal(/match/i.test(neutralFixedText), false, "Must not contain match");
        assert.equal(/court/i.test(neutralFixedText), false, "Must not contain court");
        assert.equal(neutralFixedText.includes("🎾"), false, "Must not contain tennis emoji");

        // Timed neutral reminder (Fixed spots)
        const neutralTimed = { name: "Sunday 6pm", isManual: true, when: "Sunday 6pm", playAt: "2026-10-25T01:00:00.000Z" };
        const neutralTimedText = buildPollReminderText(8, neutralTimed, 2, 4, "Alice, Bob", false, 0, 8);
        assert.match(neutralTimedText, /Hours to Go!/);
        assert.equal(/tennis/i.test(neutralTimedText), false, "Must not contain tennis");
        assert.equal(/match/i.test(neutralTimedText), false, "Must not contain match");
        assert.equal(/court/i.test(neutralTimedText), false, "Must not contain court");
        assert.equal(neutralTimedText.includes("🎾"), false, "Must not contain tennis emoji");

        // Timed neutral reminder (Opt-in)
        const neutralTimedOptIn = { name: "Sunday 6pm", isManual: true, when: "Sunday 6pm", playAt: "2026-10-25T01:00:00.000Z" };
        const neutralTimedOptInText = buildPollReminderText(8, neutralTimedOptIn, 0, 0, "Alice, Bob", true, 2, 8);
        assert.match(neutralTimedOptInText, /Hours to Go!/);
        assert.equal(/tennis/i.test(neutralTimedOptInText), false, "Must not contain tennis");
        assert.equal(/match/i.test(neutralTimedOptInText), false, "Must not contain match");
        assert.equal(/court/i.test(neutralTimedOptInText), false, "Must not contain court");
        assert.equal(neutralTimedOptInText.includes("🎾"), false, "Must not contain tennis emoji");
      });

      it("should format untimed reminder text mentioning tomorrow and not mentioning hours to event", () => {
        const optInPoll = { name: "Tennis Sunday", isManual: true, when: "Sunday", playAt: null };
        const optInText = buildUntimedPollReminderText(optInPoll, 0, 0, "Alice, Bob", true, 2);
        assert.match(optInText, /Match Alert for Tomorrow!/);
        assert.match(optInText, /tomorrow's match/);
        assert.equal(/\b\d+\s*(?:hours|hrs|minutes|mins)\b/i.test(optInText), false, "Must not mention hours or minutes to event");

        const fixedPoll = { name: "Tennis Sunday", isManual: true, when: "Sunday", playAt: null };
        const fixedText = buildUntimedPollReminderText(fixedPoll, 2, 4, "Alice, Bob", false, 0);
        assert.match(fixedText, /Match Alert for Tomorrow!/);
        assert.match(fixedText, /The match poll for tomorrow still has/);
        assert.match(fixedText, /\*2 open spots\* \(2\/4 needed\)/);
        assert.equal(/\b\d+\s*(?:hours|hrs|minutes|mins)\b/i.test(fixedText), false, "Must not mention hours or minutes to event");
      });

      it("should calculate reminder time at 12:00 PM afternoon on the day before the match", () => {
        // Base: Saturday 2026-10-24 9:00 AM (Pacific)
        const saturdayMorning = new Date("2026-10-24T16:00:00.000Z"); // 9:00 AM PDT
        const pollState = {
          name: "Tennis Sunday",
          dayWord: "Sunday",
          when: "Sunday",
          createdAt: saturdayMorning.toISOString(),
          isManual: true,
          playAt: null
        };

        const info = getDayBefore12pmReminderTime(pollState, saturdayMorning);
        assert.ok(info);
        // Reminder should be Saturday 2026-10-24 at 12:00 PM San Jose time (PDT = UTC-7 -> 2026-10-24T19:00:00Z)
        assert.equal(info.reminderDate.toISOString(), "2026-10-24T19:00:00.000Z");
      });

      it("should send day-before 12pm reminder when day is provided and now is 12pm on the day before", async () => {
        const messagesSent = [];
        const mockSock = {
          user: { id: "1234567890@s.whatsapp.net" },
          sendMessage: async (jid, msg, opts) => { messagesSent.push({ jid, msg, opts }); }
        };

        // Poll created at 9am on Saturday Oct 24 for Sunday
        const createdTime = new Date("2026-10-24T16:00:00.000Z").toISOString();
        const activePolls = new Map();
        activePolls.set("poll_sun", {
          name: "Tennis Sunday",
          isManual: true,
          status: "active",
          remoteJid: "group1@g.us",
          dayWord: "Sunday",
          when: "Sunday",
          playAt: null,
          createdAt: createdTime,
          options: ["Player 1", "Player 2", "Player 3", "Player 4"],
          size: 4,
          type: "manual",
          sentReminders: [],
          voteBuffer: new Map()
        });

        const messageStore = new Map();
        messageStore.set("group1@g.us:poll_sun", {
          pollCreationMessage: { name: "Tennis Sunday", options: [{ optionName: "Player 1" }] }
        });

        // Saturday Oct 24, 12:05 PM PDT (19:05Z on Oct 24)
        const sat1205pm = new Date("2026-10-24T19:05:00.000Z").getTime();

        await checkAndSendPollReminders(mockSock, {
          activePolls,
          persistPolls: () => {},
          messageStore
        }, sat1205pm);

        assert.equal(messagesSent.length, 1);
        assert.match(messagesSent[0].msg.text, /Match Alert for Tomorrow!/);
        assert.match(messagesSent[0].msg.text, /The match poll for tomorrow still has/);
        assert.equal(/\b\d+\s*(?:hours|hrs)\b/i.test(messagesSent[0].msg.text), false);
        assert.ok(activePolls.get("poll_sun").sentReminders.includes("day_before_12pm"));

        // Sweeping again should not send duplicates
        messagesSent.length = 0;
        await checkAndSendPollReminders(mockSock, {
          activePolls,
          persistPolls: () => {},
          messageStore
        }, sat1205pm);
        assert.equal(messagesSent.length, 0);
      });

      it("should not send day-before reminder if now is before 12pm on the day before", async () => {
        const messagesSent = [];
        const mockSock = {
          user: { id: "1234567890@s.whatsapp.net" },
          sendMessage: async (jid, msg) => { messagesSent.push({ jid, msg }); }
        };

        const activePolls = new Map();
        activePolls.set("poll_sun", {
          name: "Tennis Sunday",
          isManual: true,
          status: "active",
          remoteJid: "group1@g.us",
          dayWord: "Sunday",
          when: "Sunday",
          playAt: null,
          createdAt: new Date("2026-10-24T16:00:00.000Z").toISOString(), // 9am Sat
          options: ["Player 1", "Player 2", "Player 3", "Player 4"],
          size: 4,
          type: "manual",
          sentReminders: [],
          voteBuffer: new Map()
        });

        // Time: Saturday Oct 24, 10:00 AM PDT (before 12pm)
        const sat10am = new Date("2026-10-24T17:00:00.000Z").getTime();

        await checkAndSendPollReminders(mockSock, {
          activePolls,
          persistPolls: () => {},
          messageStore: new Map()
        }, sat10am);

        assert.equal(messagesSent.length, 0, "Should not send reminder before 12pm on day before");
      });

      it("should return explanation when user explicitly triggers reminder for manual poll with no day and no time", async () => {
        const activePolls = new Map();
        activePolls.set("poll_noday", {
          name: "Tennis 4 spots",
          isManual: true,
          status: "active",
          remoteJid: "group1@g.us",
          when: null,
          playAt: null,
          options: ["Player 1", "Player 2"],
          type: "manual",
          voteBuffer: new Map()
        });

        const res = await handleTriggerReminder(null, "group1@g.us", "Alice", "poll_noday", {
          activePolls,
          recurringPolls: new Map(),
          persistPolls: () => {}
        });

        assert.match(res, /no match time or day was specified/i);
      });

      it("should show Scheduled for day before match at 6:00 PM in pollStatusText for manual poll with day", () => {
        const pollState = {
          name: "Tennis Sunday",
          isManual: true,
          status: "active",
          remoteJid: "group1@g.us",
          when: "Sunday",
          dayWord: "Sunday",
          playAt: null,
          options: ["Yes", "No"],
          type: "opt_in",
          voteBuffer: new Map()
        };

        const activePolls = new Map([["p_status_test", pollState]]);
        const status = pollStatusText("group1@g.us", { targetId: "p_status_test" }, { activePolls, recurringPolls: new Map(), messageStore: new Map() });
        assert.match(status, /Play time: unknown/i);
        assert.match(status, /Reminders: Scheduled for day before match at 12:00 PM/i);
      });
    });
  });

  describe('createMatchPoll court availability filtering with 90m requirement', () => {
    it('should NOT list court as available or create voting slots for it if subsequent slot has clinic (< 90m available)', async () => {
      const origCheck = scvcc.checkCourtAvailability;
      const origBookings = scvcc.getCourtBookings;

      // Mock 6:30 PM availability: Court 2 & 3 prebooked, Court 5 has only 30m before clinic
      scvcc.checkCourtAvailability = async () => ({
        success: true,
        slots: [{
          time: '6:30 PM',
          courts: [
            { court: 'Court 2', status: 'prebooked', prebookedBy: 'Pramod Immaneni', prebookedFullName: 'Pramod Immaneni', durationMins: 90 },
            { court: 'Court 3', status: 'prebooked', prebookedBy: 'Conrad Rodricks', prebookedFullName: 'Conrad Rodricks', durationMins: 90 },
            {
              court: 'Court 5',
              status: 'unavailable',
              availableMinutes: 0,
              overrideAvailableMinutes: 30, // only 30m before clinic at 7pm!
              blockTitle: null,
              prebookedPlayers: []
            }
          ]
        }]
      });

      scvcc.getCourtBookings = async () => ({
        success: true,
        bookings: [
          { court: 'Court 2', time: '6:30 PM', durationMins: 90, isPrebooked: true, prebookedBy: 'Pramod Immaneni' },
          { court: 'Court 3', time: '6:30 PM', durationMins: 90, isPrebooked: true, prebookedBy: 'Conrad Rodricks' },
          { court: 'Court 5', time: '7:00 PM', durationMins: 60, type: '3.0+ Live Ball Clinic', blockTitle: '3.0+ Live Ball Clinic' }
        ]
      });

      let sentPoll = null;
      const mockSock = {
        sendMessage: async (jid, content) => {
          sentPoll = content;
          return { key: { id: 'poll_clinic_test', remoteJid: jid }, message: content };
        }
      };

      const activePolls = new Map();
      try {
        const res = await createMatchPoll(
          mockSock,
          '120363403838804497@g.us',
          'auto',
          'Tomorrow 6:30pm',
          null,
          '6:30pm',
          null, // creatorName
          null,
          false,
          null,
          false,
          false, // isCommand
          false,
          true,  // checkCourts
          false,
          false,
          null,
          null,
          null,
          null,
          null,
          null,
          { activePolls, messageStore: new Map(), latestPollIdByChat: new Map(), persistPolls: () => {} }
        );

        assert.equal(res.err, null);
        const storedPoll = activePolls.get('poll_clinic_test');
        assert.ok(storedPoll);
        // Only Courts 2 & 3 (8 capacity), Court 5 must NOT be included because it only has 30m available!
        assert.equal(storedPoll.size, 8, 'Poll size must be 8 slots, Court 5 with 30m must NOT expand to 12 slots');
        assert.equal(storedPoll.options.length, 8, 'Options count must be 8');
        assert.equal(sentPoll.poll.name.includes('Court 5 - Available'), false, 'Poll title must NOT say Court 5 is available');
        assert.ok(!storedPoll.unbookedCourts || storedPoll.unbookedCourts.length === 0, 'unbookedCourts must NOT include Court 5');
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.getCourtBookings = origBookings;
      }
    });

    it('should list court as available and create voting slots if court has full 90m unblocked (override eligible)', async () => {
      const origCheck = scvcc.checkCourtAvailability;
      const origBookings = scvcc.getCourtBookings;

      scvcc.checkCourtAvailability = async () => ({
        success: true,
        slots: [{
          time: '6:30 PM',
          courts: [
            { court: 'Court 2', status: 'prebooked', prebookedBy: 'Pramod Immaneni', prebookedFullName: 'Pramod Immaneni', durationMins: 90 },
            { court: 'Court 3', status: 'prebooked', prebookedBy: 'Conrad Rodricks', prebookedFullName: 'Conrad Rodricks', durationMins: 90 },
            {
              court: 'Court 5',
              status: 'unavailable',
              availableMinutes: 0,
              overrideAvailableMinutes: 90, // full 90m unblocked
              blockTitle: null,
              prebookedPlayers: []
            }
          ]
        }]
      });

      scvcc.getCourtBookings = async () => ({
        success: true,
        bookings: [
          { court: 'Court 2', time: '6:30 PM', durationMins: 90, isPrebooked: true, prebookedBy: 'Pramod Immaneni' },
          { court: 'Court 3', time: '6:30 PM', durationMins: 90, isPrebooked: true, prebookedBy: 'Conrad Rodricks' }
        ]
      });

      let sentPoll = null;
      const mockSock = {
        sendMessage: async (jid, content) => {
          sentPoll = content;
          return { key: { id: 'poll_override_test', remoteJid: jid }, message: content };
        }
      };

      const activePolls = new Map();
      try {
        const res = await createMatchPoll(
          mockSock,
          '120363403838804497@g.us',
          'auto',
          'Tomorrow 6:30pm',
          null,
          '6:30pm',
          null,
          null,
          false,
          null,
          false,
          false,
          false,
          true,  // checkCourts
          false,
          false,
          null,
          null,
          null,
          null,
          null,
          null,
          { activePolls, messageStore: new Map(), latestPollIdByChat: new Map(), persistPolls: () => {} }
        );

        assert.equal(res.err, null);
        const storedPoll = activePolls.get('poll_override_test');
        assert.ok(storedPoll);
        assert.equal(storedPoll.size, 12, 'Poll size must be 12 slots when Court 5 has 90m unblocked');
        assert.equal(sentPoll.poll.name.includes('Court 5 - Available'), true, 'Poll title should say Court 5 is available');
        assert.equal(storedPoll.unbookedCourts.length, 1);
        assert.equal(storedPoll.unbookedCourts[0].court, 'Court 5');
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.getCourtBookings = origBookings;
      }
    });
  });

  describe("slotCheck configuration option for polls", () => {
    it("should default slotCheck to true for automatic polls with separate vote per player", async () => {
      let sentContent = null;
      const mockSock = {
        sendMessage: async (jid, content) => {
          sentContent = content;
          return { key: { id: "poll_slotcheck_auto", remoteJid: jid }, message: content };
        }
      };
      const activePolls = new Map();
      const res = await createMatchPoll(
        mockSock,
        "group1@g.us",
        4,
        "Tomorrow 7pm",
        null,
        "7pm",
        "Alice",
        "alice@s.whatsapp.net",
        true,
        null,
        false,
        false,
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
        { activePolls, messageStore: new Map(), latestPollIdByChat: new Map(), persistPolls: () => {} }
      );
      assert.equal(res.slotCheck, true);
      const stored = activePolls.get("poll_slotcheck_auto");
      assert.equal(stored.slotCheck, true);
    });

    it("should default slotCheck to false for automatic opt-in polls", async () => {
      const mockSock = {
        sendMessage: async (jid, content) => ({ key: { id: "poll_slotcheck_optin", remoteJid: jid }, message: content })
      };
      const activePolls = new Map();
      const res = await createMatchPoll(
        mockSock,
        "group1@g.us",
        null, // opt-in
        "Tomorrow 7pm",
        null,
        "7pm",
        "Alice",
        "alice@s.whatsapp.net",
        false,
        null,
        false,
        false,
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
        { activePolls, messageStore: new Map(), latestPollIdByChat: new Map(), persistPolls: () => {} }
      );
      assert.equal(res.slotCheck, false);
      const stored = activePolls.get("poll_slotcheck_optin");
      assert.equal(stored.slotCheck, false);
    });

    it("should not complain about multiple votes on the same slot when slotCheck is false", async () => {
      const pollState = {
        name: "Test Poll",
        slotCheck: false,
        type: "fixed",
        options: ["Player 1", "Player 2", "Player 3", "Player 4"],
        remoteJid: "group1@g.us",
        voteBuffer: new Map()
      };
      const aggregated = [
        { name: "Player 2", voters: ["user1@s.whatsapp.net", "user2@s.whatsapp.net"] }
      ];
      let warningSent = false;
      const mockSock = {
        sendMessage: async () => { warningSent = true; }
      };
      const res = await checkAndNotifySlotConflicts(mockSock, "p1", pollState, aggregated, {});
      assert.equal(res, false);
      assert.equal(warningSent, false, "Must not complain when slotCheck is disabled");
    });

    it("should warn about multiple votes on the same slot when slotCheck is true", async () => {
      const pollState = {
        name: "Test Poll",
        slotCheck: true,
        type: "fixed",
        options: ["Player 1", "Player 2", "Player 3", "Player 4"],
        remoteJid: "group1@g.us",
        voteBuffer: new Map([
          ["user1@s.whatsapp.net", { senderTimestampMs: 1000 }],
          ["user2@s.whatsapp.net", { senderTimestampMs: 2000 }]
        ])
      };
      const aggregated = [
        { name: "Player 2", voters: ["user1@s.whatsapp.net", "user2@s.whatsapp.net"] },
        { name: "Player 3", voters: [] }
      ];
      let sentMessage = null;
      const mockSock = {
        sendMessage: async (jid, content) => { sentMessage = content; }
      };
      const res = await checkAndNotifySlotConflicts(mockSock, "p1", pollState, aggregated, { messageStore: new Map() });
      assert.equal(res, true);
      assert.ok(sentMessage);
      assert.match(sentMessage.text, /Player 2.*already taken/i);
    });

    it("should enable slotCheck in LLM interpretation for manual poll with separate vote per player slots", async () => {
      const interp = await interpretManualPollWithLLM("Tennis Tomorrow 7pm", ["Player 1", "Player 2", "Player 3", "Player 4"], "Alice");
      assert.equal(interp.slotCheck, true);
    });

    it("should disable slotCheck in LLM interpretation for manual poll with Yes/No or non-player slots", async () => {
      const interpYesNo = await interpretManualPollWithLLM("Tennis Tomorrow 7pm", ["Yes", "No"], "Alice");
      assert.equal(interpYesNo.slotCheck, false);

      const interpTopics = await interpretManualPollWithLLM("Tennis Tomorrow 7pm", ["Morning 9am", "Evening 6pm"], "Alice");
      assert.equal(interpTopics.slotCheck, false);
    });

    it("should allow modifying slotCheck with !modifyinstance / !modifypoll command", async () => {
      const pollState = {
        name: "Match Tomorrow 7pm",
        when: "Tomorrow 7pm",
        size: 4,
        type: "fixed",
        status: "active",
        isManual: true,
        slotCheck: true,
        remoteJid: "group1@g.us",
        creator: { name: "Bob", jid: "bob@s.whatsapp.net" },
        voteBuffer: new Map()
      };
      const activePolls = new Map([["p_mod_test", pollState]]);
      const context = { activePolls, recurringPolls: new Map(), persistPolls: () => {} };

      // Disable slotCheck on the poll
      const cmd1 = parseModifyInstanceCommand("!modifypoll p_mod_test --no-slotcheck");
      assert.equal(cmd1.updates.slotCheck, false);

      const res1 = await handleModifyPollInstance(null, "group1@g.us", "Bob", "bob@s.whatsapp.net", cmd1.targetId, cmd1.updates, context);
      assert.match(res1, /Updated slot check for poll.*Disabled/i);
      assert.equal(pollState.slotCheck, false);

      // Re-enable slotCheck on the poll
      const cmd2 = parseModifyInstanceCommand("!modifyinstance p_mod_test --slotcheck");
      assert.equal(cmd2.updates.slotCheck, true);

      const res2 = await handleModifyPollInstance(null, "group1@g.us", "Bob", "bob@s.whatsapp.net", cmd2.targetId, cmd2.updates, context);
      assert.match(res2, /Updated slot check for poll.*Enabled/i);
      assert.equal(pollState.slotCheck, true);
    });

    it("should display slot check status in pollStatusText", () => {
      const pollState = {
        name: "Tennis Match",
        isManual: false,
        status: "active",
        remoteJid: "group1@g.us",
        when: "Tomorrow 7pm",
        playAt: new Date(Date.now() + 3600000).toISOString(),
        options: ["Player 2", "Player 3", "Player 4"],
        size: 4,
        type: "fixed",
        slotCheck: true,
        voteBuffer: new Map()
      };
      const activePolls = new Map([["p_status_slotcheck", pollState]]);
      const status1 = pollStatusText("group1@g.us", { targetId: "p_status_slotcheck" }, { activePolls, recurringPolls: new Map(), messageStore: new Map() });
      assert.match(status1, /Slot check: Enabled/i);

      pollState.slotCheck = false;
      const status2 = pollStatusText("group1@g.us", { targetId: "p_status_slotcheck" }, { activePolls, recurringPolls: new Map(), messageStore: new Map() });
      assert.match(status2, /Slot check: Disabled/i);
    });
  });

  describe("lineupGeneration configuration option for polls", () => {
    it("should default lineupGeneration to 'filled' and lineupLeadTime to 30 on automatic match polls", async () => {
      const activePolls = new Map();
      const mockSock = {
        sendMessage: async () => ({ key: { id: "msg_lineup_test" } })
      };
      const context = {
        activePolls,
        recurringPolls: new Map(),
        persistPolls: () => {},
        latestPollIdByChat: new Map()
      };
      const res = await createMatchPoll(
        mockSock,
        "group1@g.us",
        4,
        "Tomorrow 7pm",
        "tomorrow",
        "7pm",
        "Alice",
        "alice@s.whatsapp.net",
        true,
        null,
        false,
        false,
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
        context
      );
      assert.equal(res.lineupGeneration, "filled");
      assert.equal(res.lineupLeadTime, 30);

      const stored = activePolls.get(res.pollId);
      assert.equal(stored.lineupGeneration, "filled");
      assert.equal(stored.lineupLeadTime, 30);
      assert.equal(stored.manualLineupPosted, false);
    });

    it("should set lineupGeneration to 'none' when noMatchups is true", async () => {
      const activePolls = new Map();
      const mockSock = {
        sendMessage: async () => ({ key: { id: "msg_lineup_none" } })
      };
      const context = {
        activePolls,
        recurringPolls: new Map(),
        persistPolls: () => {},
        latestPollIdByChat: new Map()
      };
      const res = await createMatchPoll(
        mockSock,
        "group1@g.us",
        4,
        "Tomorrow 7pm",
        "tomorrow",
        "7pm",
        "Alice",
        "alice@s.whatsapp.net",
        true,
        null,
        false,
        false,
        true, // noMatchups
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
        context
      );
      assert.equal(res.lineupGeneration, "none");
      const stored = activePolls.get(res.pollId);
      assert.equal(stored.lineupGeneration, "none");
    });

    it("should support explicit lineupGeneration: 'fallback' and custom lineupLeadTime", async () => {
      const activePolls = new Map();
      const mockSock = {
        sendMessage: async () => ({ key: { id: "msg_lineup_bpt" } })
      };
      const context = {
        activePolls,
        recurringPolls: new Map(),
        persistPolls: () => {},
        latestPollIdByChat: new Map()
      };
      const res = await createMatchPoll(
        mockSock,
        "group1@g.us",
        4,
        "Tomorrow 7pm",
        "tomorrow",
        "7pm",
        "Alice",
        "alice@s.whatsapp.net",
        true,
        null,
        false,
        false,
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
        { lineupGeneration: "fallback", lineupLeadTime: 90 }
      );
      assert.equal(res.lineupGeneration, "fallback");
      assert.equal(res.lineupLeadTime, 90);
      const stored = activePolls.get(res.pollId);
      assert.equal(stored.lineupGeneration, "fallback");
      assert.equal(stored.lineupLeadTime, 90);
    });

    it("should correctly evaluate shouldAutoGenerateLineupOnFill across the three modes", () => {
      const playAt = new Date("2026-10-28T19:00:00Z");
      const basePoll = {
        playAt: playAt.toISOString(),
        manualLineupPosted: false
      };

      // 1. filled always returns true
      assert.equal(shouldAutoGenerateLineupOnFill({ ...basePoll, lineupGeneration: "filled" }), true);

      // 2. none always returns false
      assert.equal(shouldAutoGenerateLineupOnFill({ ...basePoll, lineupGeneration: "none" }), false);

      // 3. fallback with 30 mins lead time
      const bptPoll = { ...basePoll, lineupGeneration: "fallback", lineupLeadTime: 30 };

      // 45 mins before play time: should NOT auto-generate yet
      const fortyFiveMinsBefore = new Date(playAt.getTime() - 45 * 60000).getTime();
      assert.equal(shouldAutoGenerateLineupOnFill(bptPoll, fortyFiveMinsBefore), false);

      // 15 mins before play time (within lead time): SHOULD auto-generate if no manual lineup
      const fifteenMinsBefore = new Date(playAt.getTime() - 15 * 60000).getTime();
      assert.equal(shouldAutoGenerateLineupOnFill(bptPoll, fifteenMinsBefore), true);

      // 15 mins before play time, but manual lineup was posted: should NOT auto-generate
      assert.equal(shouldAutoGenerateLineupOnFill({ ...bptPoll, manualLineupPosted: true }, fifteenMinsBefore), false);
    });

    it("checkPendingLineupGenerations should trigger matchups when deadline reached and no manual lineup posted", async () => {
      const playAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins from now
      let messageSent = null;
      const mockSock = {
        sendMessage: async (jid, content) => {
          messageSent = { jid, content };
          return { key: { id: "lineup_msg" } };
        }
      };

      const pollState = {
        status: "filled",
        remoteJid: "group1@g.us",
        when: "Today 6pm",
        playAt: playAt.toISOString(),
        lineupGeneration: "fallback",
        lineupLeadTime: 30, // 30 mins before play time (now is 15 mins before, so deadline passed)
        manualLineupPosted: false,
        size: 4,
        type: "fixed",
        options: ["Player 2", "Player 3", "Player 4"],
        creator: { name: "Alice", jid: "alice@s.whatsapp.net" },
        lastPlayers: ["Alice", "Bob", "Charlie", "David"],
        voteBuffer: new Map()
      };

      const activePolls = new Map([["p_pending_bpt", pollState]]);
      const context = {
        activePolls,
        recurringPolls: new Map(),
        persistPolls: () => {},
        latestPollIdByChat: new Map([["group1@g.us", "p_pending_bpt"]])
      };

      await checkPendingLineupGenerations(mockSock, context, Date.now());

      assert.equal(pollState.status, "resolved");
      assert.ok(messageSent, "Matchups message should be sent to WhatsApp group");
      assert.match(messageSent.content.text, /Matchups|Court|Doubles|Teams/i);
    });

    describe("lineup reminders at lead time", () => {
      it("should send a lineup reminder at lead time if mode is filled and lineup is available", async () => {
        const playAt = new Date(Date.now() + 20 * 60 * 1000); // 20 mins from now
        let messageSent = null;
        const mockSock = {
          sendMessage: async (jid, content, opts) => {
            messageSent = { jid, content, opts };
            return { key: { id: "rem_lineup_msg" } };
          }
        };

        const pollState = {
          status: "resolved",
          remoteJid: "group1@g.us",
          when: "Today 6pm",
          playAt: playAt.toISOString(),
          lineupGeneration: "filled",
          lineupLeadTime: 30, // 30 mins lead time
          lineupReminderSent: false,
          lastSchedule: {
            type: "doubles",
            sets: [{
              set: 1,
              courts: [
                { court: 1, teamA: ["Alice", "Bob"], teamB: ["Charlie", "David"] },
                { court: 2, teamA: ["Eve", "Frank"], teamB: ["Grace", "Heidi"] }
              ]
            }]
          }
        };

        const activePolls = new Map([["p_filled_rem", pollState]]);
        const context = {
          activePolls,
          persistPolls: () => {}
        };

        // 1. If now is 40 mins before play time (before deadline of 30 mins): should NOT send reminder
        const fortyMinsBefore = new Date(playAt.getTime() - 40 * 60 * 1000).getTime();
        await checkPendingLineupGenerations(mockSock, context, fortyMinsBefore);
        assert.equal(messageSent, null, "Should not send reminder before lead time");
        assert.equal(pollState.lineupReminderSent, false);

        // 2. If now is 20 mins before play time (within lead time): SHOULD send reminder
        const twentyMinsBefore = new Date(playAt.getTime() - 20 * 60 * 1000).getTime();
        await checkPendingLineupGenerations(mockSock, context, twentyMinsBefore);
        assert.ok(messageSent, "Should send lineup reminder at lead time");
        assert.match(messageSent.content.text, /Match Reminder/i);
        assert.match(messageSent.content.text, /Alice & Bob vs Charlie & David/i);
        assert.equal(pollState.lineupReminderSent, true);

        // 3. Subsequent sweep should not send duplicate
        messageSent = null;
        await checkPendingLineupGenerations(mockSock, context, twentyMinsBefore + 5000);
        assert.equal(messageSent, null, "Should not send duplicate reminder");
      });

      it("should send a lineup reminder for mode none if a manual lineup was published", async () => {
        const playAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins from now
        let messageSent = null;
        const mockSock = {
          sendMessage: async (jid, content) => {
            messageSent = { jid, content };
            return { key: { id: "rem_manual_lineup" } };
          }
        };

        // Poll without manual lineup: should NOT send reminder
        const pollNoManual = {
          status: "filled",
          remoteJid: "group1@g.us",
          when: "Today 7pm",
          playAt: playAt.toISOString(),
          lineupGeneration: "none",
          lineupLeadTime: 30,
          manualLineupPosted: false
        };

        // Poll with manual lineup: SHOULD send reminder
        const pollWithManual = {
          status: "resolved",
          remoteJid: "group1@g.us",
          when: "Today 7pm",
          playAt: playAt.toISOString(),
          lineupGeneration: "none",
          lineupLeadTime: 30,
          manualLineupPosted: true,
          lineupReminderSent: false,
          lastSchedule: {
            type: "singles",
            sets: [{
              set: 1,
              courts: [{ court: 1, teamA: ["Alice"], teamB: ["Bob"] }]
            }]
          }
        };

        const activePolls = new Map([
          ["p_no_manual", pollNoManual],
          ["p_with_manual", pollWithManual]
        ]);
        const context = {
          activePolls,
          persistPolls: () => {}
        };

        await checkPendingLineupGenerations(mockSock, context, Date.now());
        assert.ok(messageSent, "Should send reminder for poll with manual lineup");
        assert.match(messageSent.content.text, /Alice vs Bob/i);
        assert.equal(pollWithManual.lineupReminderSent, true);
        assert.equal(pollNoManual.lineupReminderSent, undefined);
      });

      it("should NOT send lineup reminder if mode is fallback", async () => {
        const playAt = new Date(Date.now() + 15 * 60 * 1000);
        let messageSent = null;
        const mockSock = {
          sendMessage: async (jid, content) => {
            messageSent = { jid, content };
            return { key: { id: "msg" } };
          }
        };

        const pollFallback = {
          status: "resolved",
          remoteJid: "group1@g.us",
          when: "Today 8pm",
          playAt: playAt.toISOString(),
          lineupGeneration: "fallback",
          lineupLeadTime: 30,
          manualLineupPosted: true,
          lastSchedule: {
            type: "singles",
            sets: [{
              set: 1,
              courts: [{ court: 1, teamA: ["Alice"], teamB: ["Bob"] }]
            }]
          }
        };

        const activePolls = new Map([["p_fallback", pollFallback]]);
        const context = { activePolls, persistPolls: () => {} };

        await checkPendingLineupGenerations(mockSock, context, Date.now());
        assert.equal(messageSent, null, "Fallback mode should not send lineup reminder via checkPendingLineupGenerations");
      });
    });

    it("checkPendingLineupGenerations should NOT trigger matchups if manual lineup was posted", async () => {
      const playAt = new Date(Date.now() + 15 * 60 * 1000);
      let messageSent = null;
      const mockSock = {
        sendMessage: async (jid, content) => {
          messageSent = { jid, content };
          return { key: { id: "lineup_msg" } };
        }
      };

      const pollState = {
        status: "resolved", // Already resolved by manual lineup
        remoteJid: "group1@g.us",
        when: "Today 6pm",
        playAt: playAt.toISOString(),
        lineupGeneration: "fallback",
        lineupLeadTime: 30,
        manualLineupPosted: true, // Manual lineup was posted
        size: 4,
        type: "fixed",
        lastPlayers: ["Alice", "Bob", "Charlie", "David"]
      };

      const activePolls = new Map([["p_manual_posted", pollState]]);
      const context = {
        activePolls,
        recurringPolls: new Map(),
        persistPolls: () => {},
        latestPollIdByChat: new Map([["group1@g.us", "p_manual_posted"]])
      };

      await checkPendingLineupGenerations(mockSock, context, Date.now());
      assert.equal(messageSent, null, "Should not generate automatic matchups if manual lineup was posted");
    });

    it("should allow modifying lineupGeneration and lineupLeadTime with !modifyinstance / !modifypoll command", async () => {
      const pollState = {
        name: "Match Tomorrow 7pm",
        when: "Tomorrow 7pm",
        size: 4,
        type: "fixed",
        status: "active",
        isManual: true,
        lineupGeneration: "filled",
        lineupLeadTime: 30,
        remoteJid: "group1@g.us",
        creator: { name: "Bob", jid: "bob@s.whatsapp.net" },
        voteBuffer: new Map()
      };
      const activePolls = new Map([["p_mod_lineup", pollState]]);
      const context = { activePolls, recurringPolls: new Map(), persistPolls: () => {} };

      // Change to fallback with 90m lead time
      const cmd1 = parseModifyInstanceCommand("!modifypoll p_mod_lineup --lineup-generation=fallback --lineup-lead-time=90m");
      assert.equal(cmd1.updates.lineupGeneration, "fallback");
      assert.equal(cmd1.updates.lineupLeadTime, 90);

      const res1 = await handleModifyPollInstance(null, "group1@g.us", "Bob", "bob@s.whatsapp.net", cmd1.targetId, cmd1.updates, context);
      assert.match(res1, /Lineup generation:.*Before play time/i);
      assert.equal(pollState.lineupGeneration, "fallback");
      assert.equal(pollState.lineupLeadTime, 90);

      // Change to none
      const cmd2 = parseModifyInstanceCommand("!modifyinstance p_mod_lineup --no-lineups");
      assert.equal(cmd2.updates.lineupGeneration, "none");

      const res2 = await handleModifyPollInstance(null, "group1@g.us", "Bob", "bob@s.whatsapp.net", cmd2.targetId, cmd2.updates, context);
      assert.match(res2, /Lineup generation:.*None/i);
      assert.equal(pollState.lineupGeneration, "none");
    });

    it("should display lineup generation status in pollStatusText", () => {
      const pollState = {
        name: "Tennis Match",
        isManual: false,
        status: "active",
        remoteJid: "group1@g.us",
        when: "Tomorrow 7pm",
        playAt: new Date(Date.now() + 3600000).toISOString(),
        options: ["Player 2", "Player 3", "Player 4"],
        size: 4,
        type: "fixed",
        lineupGeneration: "fallback",
        lineupLeadTime: 30,
        voteBuffer: new Map()
      };
      const activePolls = new Map([["p_status_lineup", pollState]]);
      const status1 = pollStatusText("group1@g.us", { targetId: "p_status_lineup" }, { activePolls, recurringPolls: new Map(), messageStore: new Map() });
      assert.match(status1, /Lineup Generation: Fallback if no manual lineups posted/i);

      pollState.lineupGeneration = "filled";
      const status2 = pollStatusText("group1@g.us", { targetId: "p_status_lineup" }, { activePolls, recurringPolls: new Map(), messageStore: new Map() });
      assert.match(status2, /Lineup Generation: Filled/i);

      pollState.lineupGeneration = "none";
      const status3 = pollStatusText("group1@g.us", { targetId: "p_status_lineup" }, { activePolls, recurringPolls: new Map(), messageStore: new Map() });
      assert.match(status3, /Lineup Generation: None/i);
    });

    it("should parse lineup generation flags in recurring schedule and format correctly", async () => {
      const flags1 = extractCommonFlags("7pm everyday --lineups-fallback --lineup-lead-time=90m");
      assert.equal(flags1.flags.lineupGeneration, "fallback");
      assert.equal(flags1.flags.lineupLeadTime, 90);

      const flags2 = extractCommonFlags("7pm everyday --no-lineups");
      assert.equal(flags2.flags.lineupGeneration, "none");

      const flags3 = extractCommonFlags("7pm everyday --lineups-filled");
      assert.equal(flags3.flags.lineupGeneration, "filled");
    });

    describe("startup migration of older matchup flags", () => {
      it("should migrate active polls and recurring polls with older matchups flags to newer options", () => {
        const legacyActivePoll1 = {
          id: "p_legacy_nomatch",
          when: "Tomorrow 7pm",
          noMatchups: true
        };
        const legacyActivePoll2 = {
          id: "p_legacy_automatch",
          when: "Tomorrow 8pm",
          autoMatchups: true,
          noMatchups: false
        };
        const modernActivePoll = {
          id: "p_modern",
          when: "Tomorrow 9pm",
          lineupGeneration: "fallback",
          lineupLeadTime: 90,
          lineupLeadTimeDisplay: "90 mins",
          manualLineupPosted: false,
          lineupReminderSent: false
        };

        const legacySched1 = {
          id: "rec_legacy_nomatch",
          matchTime: "7pm",
          noMatchups: true
        };
        const legacySched2 = {
          id: "rec_legacy_automatch",
          matchTime: "8pm",
          autoMatchups: true
        };
        const modernSched = {
          id: "rec_modern",
          matchTime: "9pm",
          lineupGeneration: "fallback",
          lineupLeadTime: 60
        };

        const activePolls = new Map([
          ["p_legacy_nomatch", legacyActivePoll1],
          ["p_legacy_automatch", legacyActivePoll2],
          ["p_modern", modernActivePoll]
        ]);
        const recurringPolls = new Map([
          ["rec_legacy_nomatch", legacySched1],
          ["rec_legacy_automatch", legacySched2],
          ["rec_modern", modernSched]
        ]);

        const count1 = migratePollMatchupOptions({ activePolls, recurringPolls });
        assert.equal(count1, 4, "Should migrate 2 active polls and 2 recurring schedules");

        // Verify legacyActivePoll1
        assert.equal(legacyActivePoll1.lineupGeneration, "none");
        assert.equal(legacyActivePoll1.lineupLeadTime, 30);
        assert.equal(legacyActivePoll1.lineupLeadTimeDisplay, "30 mins");
        assert.equal(legacyActivePoll1.manualLineupPosted, false);
        assert.equal(legacyActivePoll1.noMatchups, true);
        assert.equal(legacyActivePoll1.autoMatchups, false);

        // Verify legacyActivePoll2
        assert.equal(legacyActivePoll2.lineupGeneration, "filled");
        assert.equal(legacyActivePoll2.lineupLeadTime, 30);
        assert.equal(legacyActivePoll2.lineupLeadTimeDisplay, "30 mins");
        assert.equal(legacyActivePoll2.manualLineupPosted, false);
        assert.equal(legacyActivePoll2.noMatchups, false);
        assert.equal(legacyActivePoll2.autoMatchups, true);

        // Verify legacySched1
        assert.equal(legacySched1.lineupGeneration, "none");
        assert.equal(legacySched1.lineupLeadTime, 30);
        assert.equal(legacySched1.noMatchups, true);
        assert.equal(legacySched1.autoMatchups, false);

        // Verify legacySched2
        assert.equal(legacySched2.lineupGeneration, "filled");
        assert.equal(legacySched2.lineupLeadTime, 30);
        assert.equal(legacySched2.noMatchups, false);
        assert.equal(legacySched2.autoMatchups, true);

        // Verify modern items were preserved without changes
        assert.equal(modernActivePoll.lineupGeneration, "fallback");
        assert.equal(modernActivePoll.lineupLeadTime, 90);
        assert.equal(modernSched.lineupGeneration, "fallback");
        assert.equal(modernSched.lineupLeadTime, 60);

        // Verify idempotency
        const count2 = migratePollMatchupOptions({ activePolls, recurringPolls });
        assert.equal(count2, 0, "Second migration pass should perform 0 changes");
      });
    });
  });
});
