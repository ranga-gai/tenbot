const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const scvcc = require('../lib/scvcc');
const courtCommands = require('../lib/commands/courtCommands');
const pollCommands = require('../lib/commands/pollCommands');

describe('modifyCourtBooking & Poll State Updates', () => {
  describe('parseModifyCourtCommand', () => {
    it('should parse reservation ID and new court', () => {
      const parsed = scvcc.parseModifyCourtCommand('!modifycourt 194617 Court 1');
      assert.equal(parsed.reservationId, '194617');
      assert.equal(parsed.court, 'Court 1');
    });

    it('should parse reservation ID, court, time, and players', () => {
      const parsed = scvcc.parseModifyCourtCommand('!modifycourt 194617 Court 1 7pm with Alice, Bob');
      assert.equal(parsed.reservationId, '194617');
      assert.equal(parsed.court, 'Court 1');
      assert.equal(parsed.time, '7pm');
      assert.deepEqual(parsed.players, ['Alice', 'Bob']);
    });

    it('should parse "Court X to Court Y" syntax without reservation ID', () => {
      const parsed = scvcc.parseModifyCourtCommand('!modifycourt Court 2 tomorrow 6:30pm to Court 1 7pm');
      assert.equal(parsed.targetCourt, 'Court 2');
      assert.equal(parsed.court, 'Court 1');
      assert.equal(parsed.time, '7pm');
    });

    it('should parse !modifybooking, !modifyreservation, !updatecourt aliases', () => {
      const p1 = scvcc.parseModifyCourtCommand('!modifybooking 194617 Court 4');
      assert.equal(p1.reservationId, '194617');
      assert.equal(p1.court, 'Court 4');

      const p2 = scvcc.parseModifyCourtCommand('!updatecourt 194617 7:00 PM');
      assert.equal(p2.reservationId, '194617');
      assert.equal(p2.time, '7:00 PM');
    });
  });

  describe('updatePollStateForModifiedBooking', () => {
    it('should update advanceBookedCourts, prebookedCourts, autoBookedCourts, and poll title in activePolls', () => {
      const pollState = {
        name: '🎾 Tuesday 6:30pm (12 slots / 12)\n\nCourt 2 - Booked\nCourt 3 - Booked\n',
        when: 'Tuesday 6:30pm',
        queryTime: '6:30pm',
        court: 'Court 2',
        advanceBookedCourts: [
          {
            court: 'Court 2',
            players: ['Pramod Immaneni', 'Mausam Bhatt', 'Gaurav Puri', 'Ghufran Ahmed'],
            date: '11/4/2026',
            time: '6:30 PM',
            reservationId: '194617',
            duration: '90 Minutes',
            partySize: 'Doubles'
          },
          {
            court: 'Court 3',
            players: ['Conrad Rodricks', 'Amit Bhati', 'Vijay Parthasarathy', 'Vishal Singh'],
            date: '11/4/2026',
            time: '6:30 PM',
            reservationId: '194618',
            duration: '90 Minutes',
            partySize: 'Doubles'
          }
        ],
        prebookedCourts: [
          { court: 'Court 2', player: 'Pramod Immaneni', fullName: 'Pramod, Mausam, Gaurav, Ghufran', time: '6:30 PM', bookingType: 'auto' },
          { court: 'Court 3', player: 'Conrad Rodricks', fullName: 'Conrad, Amit, Vijay, Vishal', time: '6:30 PM', bookingType: 'auto' }
        ],
        autoBookedCourts: [
          { court: 'Court 2', players: ['Pramod Immaneni'], time: '6:30 PM' },
          { court: 'Court 3', players: ['Conrad Rodricks'], time: '6:30 PM' }
        ]
      };

      const activePolls = new Map([['poll_123', pollState]]);
      let persistCalled = false;
      const context = {
        activePolls,
        recurringPolls: new Map(),
        persistPolls: () => { persistCalled = true; }
      };

      const res = courtCommands.updatePollStateForModifiedBooking(context, {
        reservationId: '194617',
        oldCourt: 'Court 2',
        newCourt: 'Court 1',
        newTime: '7:00 PM',
        newDate: '11/4/2026',
        newPlayers: ['Pramod Immaneni', 'Mausam Bhatt', 'Vijay Parthasarathy', 'Roger Federer']
      });

      assert.equal(res.updated, true);
      assert.equal(persistCalled, true);

      // Verify advanceBookedCourts updated
      const adv2 = pollState.advanceBookedCourts.find(b => b.reservationId === '194617');
      assert.equal(adv2.court, 'Court 1');
      assert.equal(adv2.time, '7:00 PM');
      assert.deepEqual(adv2.players, ['Pramod Immaneni', 'Mausam Bhatt', 'Vijay Parthasarathy', 'Roger Federer']);

      // Verify other booking untouched
      const adv3 = pollState.advanceBookedCourts.find(b => b.reservationId === '194618');
      assert.equal(adv3.court, 'Court 3');

      // Verify prebookedCourts updated
      const pb1 = pollState.prebookedCourts.find(p => p.court === 'Court 1');
      assert.ok(pb1, 'Court 1 should be in prebookedCourts');
      assert.equal(pb1.time, '7:00 PM');
      assert.equal(pb1.player, 'Pramod Immaneni');

      // Verify poll title updated
      assert.ok(pollState.name.includes('Court 1 (7:00 PM) - Booked') || pollState.name.includes('Court 1 (7pm) - Booked'), `Poll title should have Court 1: ${pollState.name}`);
      assert.ok(!pollState.name.includes('Court 2 - Booked'), `Old court should not be Booked: ${pollState.name}`);
    });

    it('should update recurringPolls advanceBookings', () => {
      const sched = {
        id: 'rec_test',
        advanceBookings: {
          '2026-11-04': {
            advanceBookedCourts: [
              { court: 'Court 2', reservationId: '194617', date: '11/4/2026', time: '6:30 PM' }
            ],
            prebookedCourts: [
              { court: 'Court 2', time: '6:30 PM' }
            ],
            autoBookedCourts: [
              { court: 'Court 2', time: '6:30 PM' }
            ]
          }
        }
      };

      const recurringPolls = new Map([['rec_test', sched]]);
      const context = {
        activePolls: new Map(),
        recurringPolls,
        messageStore: new Map(),
      latestPollIdByChat: new Map(),
      persistPolls: () => {}
      };

      const res = courtCommands.updatePollStateForModifiedBooking(context, {
        reservationId: '194617',
        newCourt: 'Court 5',
        newTime: '8:00 PM'
      });

      assert.equal(res.updated, true);
      const adv = sched.advanceBookings['2026-11-04'].advanceBookedCourts[0];
      assert.equal(adv.court, 'Court 5');
      assert.equal(adv.time, '8:00 PM');
      const pb = sched.advanceBookings['2026-11-04'].prebookedCourts[0];
      assert.equal(pb.court, 'Court 5');
    });
  });

  describe('findAdvanceBookingInPolls', () => {
    it('should find booking by court name when reservationId is unknown', () => {
      const pollState = {
        advanceBookedCourts: [
          { court: 'Court 2', date: '11/4/2026', time: '6:30 PM', reservationId: '194617' }
        ]
      };
      const context = {
        activePolls: new Map([['p1', pollState]]),
        recurringPolls: new Map()
      };

      const found = courtCommands.findAdvanceBookingInPolls(context, { court: 'Court 2', date: '11/4/2026' });
      assert.ok(found);
      assert.equal(found.reservationId, '194617');
    });
  });

  describe('handleCourtCommand and executeCourtTool for modify', () => {
    it('should handle !modifycourt command and update poll state', async () => {
      const originalModify = scvcc.modifyCourtBooking;
      let modifyCalledWith = null;
      scvcc.modifyCourtBooking = async (params) => {
        modifyCalledWith = params;
        return {
          success: true,
          reservationId: params.reservationId,
          court: params.court || 'Court 1',
          time: params.time || '6:30 PM',
          date: '11/4/2026',
          players: ['Pramod Immaneni', 'Mausam Bhatt'],
          duration: '90 Minutes',
          partySize: 'Doubles',
          message: '✅ Successfully updated court reservation `194617` at SCVCC.'
        };
      };

      const pollState = {
        advanceBookedCourts: [
          { court: 'Court 2', reservationId: '194617', date: '11/4/2026', time: '6:30 PM' }
        ],
        prebookedCourts: [{ court: 'Court 2', time: '6:30 PM' }]
      };
      let persistCalled = false;
      const context = {
        activePolls: new Map([['p1', pollState]]),
        recurringPolls: new Map(),
        persistPolls: () => { persistCalled = true; }
      };

      try {
        const res = await courtCommands.handleCourtCommand(
          null,
          '!modifycourt 194617 Court 1',
          'test_chat',
          'Tester',
          'tester@lid',
          null,
          context
        );

        assert.ok(res.includes('Successfully updated'));
        assert.equal(modifyCalledWith.reservationId, '194617');
        assert.equal(modifyCalledWith.court, 'Court 1');
        assert.equal(pollState.advanceBookedCourts[0].court, 'Court 1');
        assert.equal(persistCalled, true);
      } finally {
        scvcc.modifyCourtBooking = originalModify;
      }
    });

    it('should handle modify_court_reservation tool', async () => {
      const originalModify = scvcc.modifyCourtBooking;
      scvcc.modifyCourtBooking = async (params) => ({
        success: true,
        reservationId: params.reservationId,
        court: params.court,
        time: '7:00 PM',
        date: '11/4/2026',
        players: [],
        duration: '90 Minutes',
        partySize: 'Doubles',
        message: 'Court reservation updated.'
      });

      const pollState = {
        advanceBookedCourts: [
          { court: 'Court 3', reservationId: '194618', date: '11/4/2026', time: '6:30 PM' }
        ]
      };
      const context = {
        activePolls: new Map([['p2', pollState]]),
        recurringPolls: new Map(),
        persistPolls: () => {}
      };

      try {
        const res = await courtCommands.executeCourtTool(
          null,
          'modify_court_reservation',
          { reservationId: '194618', court: 'Court 5', time: '7:00 PM' },
          'Tester',
          'test_chat',
          'tester@lid',
          context
        );

        assert.equal(res, 'Court reservation updated.');
        assert.equal(pollState.advanceBookedCourts[0].court, 'Court 5');
        assert.equal(pollState.advanceBookedCourts[0].time, '7:00 PM');
      } finally {
        scvcc.modifyCourtBooking = originalModify;
      }
    });
  });

  describe('removePollStateForCancelledBooking', () => {
    it('should remove cancelled booking from advanceBookedCourts and mark released', () => {
      const pollState = {
        name: '🎾 Tuesday 6:30pm (12 slots / 12)\n\nCourt 2 - Booked\nCourt 3 - Booked\n',
        advanceBookedCourts: [
          { court: 'Court 2', reservationId: '194617', date: '11/4/2026', time: '6:30 PM' },
          { court: 'Court 3', reservationId: '194618', date: '11/4/2026', time: '6:30 PM' }
        ],
        prebookedCourts: [
          { court: 'Court 2', time: '6:30 PM' },
          { court: 'Court 3', time: '6:30 PM' }
        ]
      };

      let persistCalled = false;
      const context = {
        activePolls: new Map([['p_cancel', pollState]]),
        recurringPolls: new Map(),
        persistPolls: () => { persistCalled = true; }
      };

      const res = courtCommands.removePollStateForCancelledBooking(context, { reservationId: '194617' });
      assert.equal(res.removed, true);
      assert.equal(persistCalled, true);
      assert.equal(pollState.advanceBookedCourts.length, 1);
      assert.equal(pollState.advanceBookedCourts[0].court, 'Court 3');
      assert.equal(pollState.prebookedCourts.length, 1);
      assert.equal(pollState.prebookedCourts[0].court, 'Court 3');
      assert.ok(pollState.releasedCourts.some(rc => rc.court === 'Court 2'));
      assert.ok(pollState.name.includes('Court 2 - Cancelled'));
    });
  });
});

describe('scvcc.modifyCourtBooking API execution', () => {
  it('should reject when reservationId is missing', async () => {
    const res = await scvcc.modifyCourtBooking({});
    assert.equal(res.success, false);
    assert.ok(res.message.includes('Reservation ID is required'));
  });

  it('should post update with lbBook to dialogUrl and return updated details', async () => {
    const originalAuthFetch = scvcc.authFetch;
    let postCall = null;

    scvcc.authFetch = async (url, options, retries, chatId) => {
      if (!options || !options.method || options.method === 'GET') {
        const sampleHtml = `
          <html><body>
            <input type="hidden" name="__VIEWSTATE" value="vs123" />
            <input type="hidden" name="__EVENTVALIDATION" value="ev123" />
            <input name="ctl00$ctrl_MakeBookingTime$drpStartResource$tCombo" value="Court 2" />
            <input name="ctl00$ctrl_MakeBookingTime$rdDate$tMDateBox" value="11/4/2026" />
            <input name="ctl00$ctrl_MakeBookingTime$drpTime$tCombo" value="6:30 PM" />
            <input name="ctl00$ctrl_MakeBookingTime$drpDuration$tCombo" value="90 Minutes" />
            <input name="ctl00$ctrl_MakeBookingTime$drpPartySize$tCombo" value="Doubles" />
            <input name="ctl00$ctrl_MakeBookingTime$P1$PCombo$PlayerName" value="Immaneni, Pramod" />
            <input name="ctl00$ctrl_MakeBookingTime$P1$PCombo$PlayerID" value="8916615" />
            <input name="ctl00$ctrl_MakeBookingTime$P2$PCombo$PlayerName" value="Bhatt, Mausam" />
            <input name="ctl00$ctrl_MakeBookingTime$P3$PCombo$PlayerName" value="Puri, Gaurav" />
            <input name="ctl00$ctrl_MakeBookingTime$P4$PCombo$PlayerName" value="Ahmed, Ghufran" />
          </body></html>
        `;
        return {
          ok: true,
          status: 200,
          text: async () => sampleHtml
        };
      }

      if (options.method === 'POST') {
        postCall = { url, body: options.body };
        return {
          ok: true,
          status: 200,
          text: async () => '1|#||4|28|pageRedirect||%2fdialog.aspx%3fp%3drbmPop%26tt%3dReturnbookingTime(194617)|'
        };
      }
    };

    try {
      const res = await scvcc.modifyCourtBooking({
        reservationId: '194617',
        court: 'Court 1',
        time: '7:00 PM',
        chatId: 'test_chat'
      });

      assert.equal(res.success, true);
      assert.equal(res.reservationId, '194617');
      assert.equal(res.court, 'Court 1');
      assert.equal(res.time, '7:00 PM');
      assert.ok(postCall);
      assert.ok(postCall.body.includes('ctl00%24ctrl_MakeBookingTime%24lbBook'));
      assert.ok(postCall.body.includes('Court+1'));
      assert.ok(postCall.body.includes('7%3A00+PM'));
    } finally {
      scvcc.authFetch = originalAuthFetch;
    }
  });

  it('should handle administrative override if restriction notice is returned', async () => {
    const originalAuthFetch = scvcc.authFetch;
    let overrideTriggered = false;

    scvcc.authFetch = async (url, options) => {
      if (!options || !options.method || options.method === 'GET') {
        return {
          ok: true,
          status: 200,
          text: async () => '<input type="hidden" name="__VIEWSTATE" value="vs1" /><input name="ctl00$ctrl_MakeBookingTime$P1$PCombo$PlayerName" value="Tester" />'
        };
      }

      if (options.method === 'POST') {
        if (!options.body.includes('OverrideBtn')) {
          return {
            ok: true,
            status: 200,
            text: async () => '<div>Notice: Advance limit reached.<input type="submit" name="ctl00$ctrl_MakeBookingTime$OverrideBtn" id="OverrideBtn" value="Override" /></div>'
          };
        } else {
          overrideTriggered = true;
          return {
            ok: true,
            status: 200,
            text: async () => 'Reservation Received'
          };
        }
      }
    };

    try {
      const res = await scvcc.modifyCourtBooking({
        reservationId: '194617',
        court: 'Court 5'
      });

      assert.equal(res.success, true);
      assert.equal(overrideTriggered, true);
      assert.equal(res.court, 'Court 5');
    } finally {
      scvcc.authFetch = originalAuthFetch;
    }
  });
});

describe('handleModifyPollInstance with advanceBookedCourts', () => {
  it('should modify SCVCC booking and keep preExistingBookings in new poll', async () => {
    const originalModify = scvcc.modifyCourtBooking;
    let modifyCalled = null;

    scvcc.modifyCourtBooking = async (params) => {
      modifyCalled = params;
      return {
        success: true,
        reservationId: params.reservationId,
        court: params.court,
        time: params.time || '6:30 PM',
        date: '11/4/2026',
        message: 'Updated'
      };
    };

    const pollState = {
      remoteJid: 'test_group@g.us',
      creator: { name: 'Admin', jid: 'admin@lid' },
      name: '🎾 Tuesday 6:30pm (12 slots / 12)\n\nCourt 2 - Booked\n',
      when: 'Tuesday 6:30pm',
      playAt: '2026-11-04T02:30:00.000Z',
      status: 'active',
      size: 12,
      scheduleId: 'rec_test1',
      advanceBookedCourts: [
        { court: 'Court 2', reservationId: '194617', date: '11/4/2026', time: '6:30 PM' }
      ],
      prebookedCourts: [
        { court: 'Court 2', player: 'Pramod', time: '6:30 PM', bookingType: 'auto' }
      ]
    };

    const activePolls = new Map([['p_inst1', pollState]]);
    const recurringPolls = new Map([
      ['rec_test1', { id: 'rec_test1', remoteJid: 'test_group@g.us', matchTime: '6:30 PM' }]
    ]);

    const context = {
      activePolls,
      recurringPolls,
      persistPolls: () => {}
    };

    try {
      const res = await pollCommands.handleModifyPollInstance(
        null,
        'test_group@g.us',
        'Admin',
        'admin@lid',
        'rec_test1',
        { court: 'Court 1' },
        context
      );

      assert.ok(modifyCalled);
      assert.equal(modifyCalled.reservationId, '194617');
      assert.equal(modifyCalled.court, 'Court 1');
      assert.ok(res.includes('Modified recurring poll instance'));
    } finally {
      scvcc.modifyCourtBooking = originalModify;
    }
  });

  describe("parseModifyCourtCommand group parameter", () => {
    it("should parse --group flag", () => {
      const parsed = scvcc.parseModifyCourtCommand("!modifycourt 194617 Court 1 --group=\"Bot-testing\"");
      assert.equal(parsed.reservationId, "194617");
      assert.equal(parsed.court, "Court 1");
      assert.equal(parsed.group, "Bot-testing");
    });

    it("should parse -g flag", () => {
      const parsed = scvcc.parseModifyCourtCommand("!modifycourt 194617 to Court 2 7pm -g Bot-testing");
      assert.equal(parsed.reservationId, "194617");
      assert.equal(parsed.court, "Court 2");
      assert.equal(parsed.time, "7pm");
      assert.equal(parsed.group, "Bot-testing");
    });

    it("should parse for group syntax", () => {
      const parsed = scvcc.parseModifyCourtCommand("!modifycourt Court 2 tomorrow to Court 1 for group \"Tennis Club\"");
      assert.equal(parsed.targetCourt, "Court 2");
      assert.equal(parsed.court, "Court 1");
      assert.equal(parsed.when, "tomorrow");
      assert.equal(parsed.group, "Tennis Club");
    });

    it("should parse group <name> syntax", () => {
      const parsed = scvcc.parseModifyCourtCommand("!modifycourt 194617 7:30pm group Bot-testing with Alice, Bob");
      assert.equal(parsed.reservationId, "194617");
      assert.equal(parsed.time, "7:30pm");
      assert.equal(parsed.group, "Bot-testing");
      assert.deepEqual(parsed.players, ["Alice", "Bob"]);
    });
  });

  describe("resolveTargetChatId and group admin permission checks", () => {
    const mockSock = {
      groupMetadata: async (jid) => ({
        id: jid,
        subject: "Bot-testing",
        participants: [
          { id: "admin_user@s.whatsapp.net", admin: "admin" },
          { id: "regular_user@s.whatsapp.net", admin: null }
        ]
      }),
      sendMessage: async () => {}
    };

    it("should resolve target group by name in groups.json", async () => {
      const res = await courtCommands.resolveTargetChatId(mockSock, "dm_chat", "admin_user@s.whatsapp.net", "Bot-testing");
      assert.equal(res.targetChatId, "120363403838804497@g.us");
      assert.equal(res.error, undefined);
    });

    it("should return error if group is not found", async () => {
      const res = await courtCommands.resolveTargetChatId(mockSock, "dm_chat", "admin_user@s.whatsapp.net", "NonExistentGroup123");
      assert.ok(res.error);
      assert.match(res.error, /Group "NonExistentGroup123" was not found/);
    });

    it("should reject if sender is not an admin of the target group", async () => {
      const res = await courtCommands.resolveTargetChatId(mockSock, "other_chat", "regular_user@s.whatsapp.net", "Bot-testing");
      assert.ok(res.error);
      assert.match(res.error, /Only group admins or the bot superadmin can modify court bookings/);
    });

    it("should allow if sender is superadmin", async () => {
      const res = await courtCommands.resolveTargetChatId(mockSock, "dm_chat", "90611059302558@lid", "Bot-testing");
      assert.equal(res.targetChatId, "120363403838804497@g.us");
      assert.equal(res.error, undefined);
    });

    it("should allow admin running !modifycourt with --group to update target group", async () => {
      const originalModify = scvcc.modifyCourtBooking;
      let modifyCalledWith = null;
      scvcc.modifyCourtBooking = async (params) => {
        modifyCalledWith = params;
        return {
          success: true,
          court: "Court 1",
          time: "7:00 PM",
          date: "11/4/2026",
          players: ["Pramod"],
          message: "Updated"
        };
      };

      const targetGroupJid = "120363403838804497@g.us";
      const otherGroupJid = "other_group@g.us";

      const targetPollState = {
        remoteJid: targetGroupJid,
        name: "🎾 Tuesday 7pm\n\nCourt 2 - Booked\n",
        queryTime: "7pm",
        advanceBookedCourts: [
          { court: "Court 2", reservationId: "194617", date: "11/4/2026", time: "7:00 PM" }
        ],
        prebookedCourts: [
          { court: "Court 2", player: "Pramod", time: "7:00 PM" }
        ]
      };

      const otherPollState = {
        remoteJid: otherGroupJid,
        name: "🎾 Tuesday 7pm\n\nCourt 2 - Booked\n",
        queryTime: "7pm",
        advanceBookedCourts: [
          { court: "Court 2", reservationId: "999999", date: "11/4/2026", time: "7:00 PM" }
        ]
      };

      const context = {
        activePolls: new Map([
          ["p_target", targetPollState],
          ["p_other", otherPollState]
        ]),
        recurringPolls: new Map(),
        persistPolls: () => {}
      };

      try {
        // Run from DM as admin specifying group Bot-testing
        const res = await courtCommands.handleCourtCommand(
          mockSock,
          "!modifycourt 194617 to Court 1 --group=\"Bot-testing\"",
          "dm_chat_user",
          "Admin",
          "admin_user@s.whatsapp.net",
          null,
          context
        );

        assert.equal(res, "Updated");
        assert.ok(modifyCalledWith);
        assert.equal(modifyCalledWith.chatId, targetGroupJid);
        assert.equal(modifyCalledWith.court, "Court 1");

        // Target poll state should be updated to Court 1
        assert.equal(targetPollState.advanceBookedCourts[0].court, "Court 1");
        assert.ok(targetPollState.name.includes("Court 1 - Booked"));

        // Other group poll state must NOT be touched
        assert.equal(otherPollState.advanceBookedCourts[0].court, "Court 2");
      } finally {
        scvcc.modifyCourtBooking = originalModify;
      }
    });

    it("should allow modify_court_reservation tool with group parameter", async () => {
      const originalModify = scvcc.modifyCourtBooking;
      let modifyCalledWith = null;
      scvcc.modifyCourtBooking = async (params) => {
        modifyCalledWith = params;
        return {
          success: true,
          court: "Court 3",
          time: "7:00 PM",
          date: "11/4/2026",
          message: "Tool Updated"
        };
      };

      const targetGroupJid = "120363403838804497@g.us";
      const targetPollState = {
        remoteJid: targetGroupJid,
        advanceBookedCourts: [
          { court: "Court 2", reservationId: "194617", date: "11/4/2026", time: "7:00 PM" }
        ]
      };

      const context = {
        activePolls: new Map([["p_target", targetPollState]]),
        recurringPolls: new Map(),
        persistPolls: () => {}
      };

      try {
        const res = await courtCommands.executeCourtTool(
          mockSock,
          "modify_court_reservation",
          { reservationId: "194617", court: "Court 3", group: "Bot-testing" },
          "Admin",
          "dm_chat",
          "admin_user@s.whatsapp.net",
          context
        );

        assert.equal(res, "Tool Updated");
        assert.equal(modifyCalledWith.chatId, targetGroupJid);
        assert.equal(modifyCalledWith.court, "Court 3");
        assert.equal(targetPollState.advanceBookedCourts[0].court, "Court 3");
      } finally {
        scvcc.modifyCourtBooking = originalModify;
      }
    });
  });
});
