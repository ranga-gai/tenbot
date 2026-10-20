process.env.NODE_ENV = 'test';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const scvcc = require('../lib/scvcc');
const {
  isValidPlayerCount,
  getNextValidPlayerCount,
  getFirstSlotNumber,
  extractFixedPairsFromText,
  parsePollCreationText,
  resolveManualPollPlayers,
  buildPollReminderText,
  getSlotNumberForOption,
  checkAndNotifyInvalidSlotVotes,
  handleOnDemandCourtBooking,
  getPollVoters,
  sendPollReminder
} = require('../lib/commands/pollCommands');

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

    it('should notify and tag voters voting beyond slotLimit with quoted poll', async () => {
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
      const aggregated = [
        { name: 'Player 1', voters: ['voter1@s.whatsapp.net'] },
        { name: 'Player 8', voters: ['voter8@s.whatsapp.net'] },
        { name: 'Player 9', voters: ['1234567890@s.whatsapp.net'] },
        { name: 'Player 10', voters: ['9876543210@s.whatsapp.net'] }
      ];

      const notified = await checkAndNotifyInvalidSlotVotes(mockSock, 'poll123', pollState, aggregated, {
        messageStore: new Map([['group1@g.us:poll123', { pollCreation: true }]])
      });

      assert.equal(notified, true);
      assert.equal(messagesSent.length, 2);

      // Verify Player 9 notification
      const msg9 = messagesSent[0];
      assert.equal(msg9.jid, 'group1@g.us');
      assert.match(msg9.msg.text, /@1234567890/);
      assert.match(msg9.msg.text, /Player 9.*is no longer valid/);
      assert.match(msg9.msg.text, /Only \*8 voting slots\* are valid/);
      assert.ok(msg9.opts?.quoted?.key?.id === 'poll123');

      // Verify Player 10 notification
      const msg10 = messagesSent[1];
      assert.match(msg10.msg.text, /@9876543210/);
      assert.match(msg10.msg.text, /Player 10.*is no longer valid/);

      // Verify tracking
      assert.deepEqual(pollState.invalidSlotVotesNotified, [
        '1234567890@s.whatsapp.net:9',
        '9876543210@s.whatsapp.net:10'
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
        { name: 'Player 9', voters: ['1234567890@s.whatsapp.net'] }
      ];

      try {
        await handleOnDemandCourtBooking(mockSock, 'poll102', pollState, aggregated, {});

        assert.equal(attempts, 3, 'Should have retried 2 times (3 attempts total)');
        // Court 1 removed from unbooked
        assert.equal(pollState.unbookedCourts.length, 0);
        // Valid slots count = 2 courts * 4 = 8
        assert.equal(pollState.slotLimit, 8);
        assert.equal(pollState.size, 8);
        assert.equal(pollState.onDemandBookingInProgress, false);

        // Group was notified Court 1 is unavailable and only 8 voting slots valid
        const courtFailMsg = messagesSent.find(m => m.msg?.text?.includes('Court 1') && m.msg?.text?.includes('8 voting slots'));
        assert.ok(courtFailMsg, 'Group was notified of court unavailability with valid slots count');
        assert.equal(courtFailMsg.msg.text, '⚠️ *Court 1* is no longer available. Only *8 voting slots* are valid for this match poll.');

        // Voter on Player 9 was tagged that slot is no longer valid
        const invalidSlotMsg = messagesSent.find(m => m.msg?.text?.includes('Player 9'));
        assert.ok(invalidSlotMsg, 'Voter on invalid slot 9 was notified');
        assert.match(invalidSlotMsg.msg.text, /@1234567890.*Player 9.*is no longer valid/);
      } finally {
        scvcc.bookCourt = originalBookCourt;
        scvcc.checkCourtAvailability = originalCheckAvail;
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
});
