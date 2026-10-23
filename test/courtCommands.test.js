const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const scvcc = require('../lib/scvcc');
const {
  handleCourtCommand,
  executeCourtTool
} = require('../lib/commands/courtCommands');

describe('courtCommands', () => {
  describe('handleCourtCommand', () => {
    it('should return null for non-court commands', async () => {
      const res = await handleCourtCommand(null, '!help', 'chat@g.us', 'Alice');
      assert.equal(res, null);
    });

    it('should parse !cancelcourt without reservation ID and prompt usage', async () => {
      const res = await handleCourtCommand(null, '!cancelcourt', 'chat@g.us', 'Alice');
      assert.equal(res, null);
    });

    it('should preserve parsed.requester when "for <Player>" is passed in !bookcourt', async () => {
      let passedArgs = null;
      const originalBookCourt = scvcc.bookCourt;
      scvcc.bookCourt = async (args) => {
        passedArgs = args;
        return { success: true, message: 'Booked mock court' };
      };

      try {
        const cmd = '!bookcourt Court 3 10:30am tomorrow for Vijay Parthasarathy with Kejal Patel, Vishal Singh, Gaurav Puri';
        await handleCourtCommand(null, cmd, 'chat@g.us', 'PI');

        assert.ok(passedArgs);
        assert.equal(passedArgs.requester, 'Vijay Parthasarathy');
        assert.equal(passedArgs.requestedBy, 'PI');
        assert.deepEqual(passedArgs.players, ['Kejal Patel', 'Vishal Singh', 'Gaurav Puri']);
      } finally {
        scvcc.bookCourt = originalBookCourt;
      }
    });

    it('should not force sender as requester when 4 players are already listed without "for"', async () => {
      let passedArgs = null;
      const originalBookCourt = scvcc.bookCourt;
      scvcc.bookCourt = async (args) => {
        passedArgs = args;
        return { success: true, message: 'Booked mock court' };
      };

      try {
        const cmd = '!bookcourt Court 3 10:30am tomorrow with Vijay Parthasarathy, Kejal Patel, Vishal Singh, Gaurav Puri';
        await handleCourtCommand(null, cmd, 'chat@g.us', 'PI');

        assert.ok(passedArgs);
        assert.equal(passedArgs.requester, null);
        assert.equal(passedArgs.requestedBy, 'PI');
        assert.deepEqual(passedArgs.players, ['Vijay Parthasarathy', 'Kejal Patel', 'Vishal Singh', 'Gaurav Puri']);
      } finally {
        scvcc.bookCourt = originalBookCourt;
      }
    });

    it('should default requester to sender when fewer than 4 players are listed without "for"', async () => {
      let passedArgs = null;
      const originalBookCourt = scvcc.bookCourt;
      scvcc.bookCourt = async (args) => {
        passedArgs = args;
        return { success: true, message: 'Booked mock court' };
      };

      try {
        const cmd = '!bookcourt Court 3 10:30am tomorrow with Kejal Patel, Vishal Singh, Gaurav Puri';
        await handleCourtCommand(null, cmd, 'chat@g.us', 'PI');

        assert.ok(passedArgs);
        assert.equal(passedArgs.requester, 'PI');
        assert.equal(passedArgs.requestedBy, 'PI');
        assert.deepEqual(passedArgs.players, ['Kejal Patel', 'Vishal Singh', 'Gaurav Puri']);
      } finally {
        scvcc.bookCourt = originalBookCourt;
      }
    });
  });

  describe('executeCourtTool', () => {
    it('should return unknown message for unrecognized court tool', async () => {
      const res = await executeCourtTool(null, 'nonexistent_court_tool', {}, 'Alice', 'chat@g.us');
      assert.equal(res, 'Unknown court tool nonexistent_court_tool');
    });
  });

  describe('bookCourt availability filtering', () => {
    it('should return failure when only courts with < 90m availability exist and minAvailableMinutes: 90 is specified', async () => {
      const origCheck = scvcc.checkCourtAvailability;
      scvcc.checkCourtAvailability = async () => ({
        success: true,
        slots: [{
          time: '10:00 AM',
          courts: [
            { court: 'Court 1', status: 'available', availableMinutes: 30, resourceId: '1' },
            { court: 'Court 2', status: 'available', availableMinutes: 60, resourceId: '2' }
          ]
        }]
      });

      try {
        const res = await scvcc.bookCourt({ when: 'tomorrow', time: '10am', minAvailableMinutes: 90 });
        assert.equal(res.success, false);
        assert.match(res.message, /No courts are available at SCVCC/);
      } finally {
        scvcc.checkCourtAvailability = origCheck;
      }
    });

    it('should select court with >= 90m availability when minAvailableMinutes: 90 is specified', async () => {
      const origCheck = scvcc.checkCourtAvailability;
      const origAuthFetch = scvcc.authFetch;
      scvcc.checkCourtAvailability = async () => ({
        success: true,
        slots: [{
          time: '10:00 AM',
          courts: [
            { court: 'Court 1', status: 'available', availableMinutes: 30, resourceId: '1' },
            { court: 'Court 2', status: 'available', availableMinutes: 60, resourceId: '2' },
            { court: 'Court 3', status: 'available', availableMinutes: 90, resourceId: '3' }
          ]
        }]
      });

      let capturedDialogUrl = null;
      scvcc.authFetch = async (url) => {
        capturedDialogUrl = url;
        throw new Error('STOP_AFTER_SELECTION');
      };

      try {
        await scvcc.bookCourt({ when: 'tomorrow', time: '10am', minAvailableMinutes: 90 });
      } catch (err) {
        if (err.message !== 'STOP_AFTER_SELECTION') throw err;
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.authFetch = origAuthFetch;
      }

      assert.ok(capturedDialogUrl);
      assert.ok(capturedDialogUrl.includes('resourceID=3'), 'Should have selected Court 3 with 90m availability');
    });

    it('should skip specifically requested court if it has < 90m and pick another court with >= 90m', async () => {
      const origCheck = scvcc.checkCourtAvailability;
      const origAuthFetch = scvcc.authFetch;
      scvcc.checkCourtAvailability = async () => ({
        success: true,
        slots: [{
          time: '10:00 AM',
          courts: [
            { court: 'Court 1', status: 'available', availableMinutes: 60, resourceId: '1' },
            { court: 'Court 2', status: 'available', availableMinutes: 90, resourceId: '2' }
          ]
        }]
      });

      let capturedDialogUrl = null;
      scvcc.authFetch = async (url) => {
        capturedDialogUrl = url;
        throw new Error('STOP_AFTER_SELECTION');
      };

      try {
        await scvcc.bookCourt({ when: 'tomorrow', time: '10am', court: 'Court 1', minAvailableMinutes: 90 });
      } catch (err) {
        if (err.message !== 'STOP_AFTER_SELECTION') throw err;
      } finally {
        scvcc.checkCourtAvailability = origCheck;
        scvcc.authFetch = origAuthFetch;
      }

      assert.ok(capturedDialogUrl);
      assert.ok(capturedDialogUrl.includes('resourceID=2'), 'Should have selected Court 2 with 90m availability instead of Court 1');
    });

    it('should fail when specifically requested court has < 90m and no other court has >= 90m', async () => {
      const origCheck = scvcc.checkCourtAvailability;
      scvcc.checkCourtAvailability = async () => ({
        success: true,
        slots: [{
          time: '10:00 AM',
          courts: [
            { court: 'Court 1', status: 'available', availableMinutes: 60, resourceId: '1' },
            { court: 'Court 2', status: 'available', availableMinutes: 30, resourceId: '2' }
          ]
        }]
      });

      try {
        const res = await scvcc.bookCourt({ when: 'tomorrow', time: '10am', court: 'Court 1', minAvailableMinutes: 90 });
        assert.equal(res.success, false);
      } finally {
        scvcc.checkCourtAvailability = origCheck;
      }
    });
  });

  describe('getCourtBookings spanning multi-slot reservations', () => {
    it('should show courts spanning across the entire duration in all 30m slots', async () => {
      const origAuthFetch = scvcc.authFetch;
      const testChatId = '120363403838804497@g.us';

      const mockHtml = `
        <tr>
          <td><div class="tscell">6:30 PM</div></td>
          <td rowspan="3">
            <div class="ncCourtNum">Court 2</div>
            <img title="Doubles" />
            <div class="playerName" title="Immaneni, Pramod">Pramod Immaneni</div>
          </td>
        </tr>
        <tr>
          <td><div class="tscell">7:00 PM</div></td>
          <td><div class="ncCourtNum">Court 1</div><div class="blockTitle">Blocked</div></td>
        </tr>
        <tr>
          <td><div class="tscell">7:30 PM</div></td>
          <td><div class="ncCourtNum">Court 1</div><div class="blockTitle">Blocked</div></td>
        </tr>
        <tr>
          <td><div class="tscell">8:00 PM</div></td>
          <td><div class="ncCourtNum">Court 1</div><div class="blockTitle">Blocked</div></td>
        </tr>
      `;

      scvcc.authFetch = async () => ({
        ok: true,
        text: async () => mockHtml
      });

      try {
        const res = await scvcc.getCourtBookings({ when: 'today', chatId: testChatId });
        assert.ok(res.success);

        const ct2At630 = res.bookings.find(b => b.court === 'Court 2' && b.time === '6:30 PM');
        const ct2At700 = res.bookings.find(b => b.court === 'Court 2' && b.time === '7:00 PM');
        const ct2At730 = res.bookings.find(b => b.court === 'Court 2' && b.time === '7:30 PM');
        const ct2At800 = res.bookings.find(b => b.court === 'Court 2' && b.time === '8:00 PM');

        assert.ok(ct2At630, 'Court 2 should be present at 6:30 PM');
        assert.ok(ct2At700, 'Court 2 should be present at 7:00 PM');
        assert.ok(ct2At730, 'Court 2 should be present at 7:30 PM');
        assert.ok(!ct2At800, 'Court 2 should NOT be present at 8:00 PM');

        assert.ok(res.message.includes('Court 2'));
        assert.ok(res.message.includes('Booked: PI'));
      } finally {
        scvcc.authFetch = origAuthFetch;
      }
    });
  });

  describe('pause and resume court bookings', () => {
    const groupsConfig = require('../lib/groupsConfig');
    const origConfig = JSON.parse(JSON.stringify(groupsConfig.loadRawConfig() || {}));
    const origIsSuper = groupsConfig.isSuperAdmin;
    const testChatId = '120363403838804497@g.us';
    const adminUser = '11111@s.whatsapp.net';
    const regularUser = '22222@s.whatsapp.net';
    const superUser = '99999@s.whatsapp.net';

    const mockSock = {
      groupMetadata: async (jid) => ({
        id: jid,
        subject: 'Bot-testing',
        participants: [
          { id: adminUser, admin: 'admin' },
          { id: regularUser, admin: null }
        ]
      })
    };

    function setupMocks() {
      groupsConfig.isSuperAdmin = (jid) => jid === superUser;
    }

    function teardownMocks() {
      groupsConfig.isSuperAdmin = origIsSuper;
      groupsConfig.saveRawConfig(origConfig);
    }

    it('should reject non-admin from pausing court bookings for a group', async () => {
      setupMocks();
      try {
        const res = await handleCourtCommand(mockSock, '!pausecourtbookings', testChatId, 'Regular', regularUser);
        assert.match(res, /Only group admins or the bot superadmin can pause court bookings/);
      } finally {
        teardownMocks();
      }
    });

    it('should reject non-admin from resuming court bookings for a group', async () => {
      setupMocks();
      try {
        const res = await handleCourtCommand(mockSock, '!resumecourtbookings', testChatId, 'Regular', regularUser);
        assert.match(res, /Only group admins or the bot superadmin can resume court bookings/);
      } finally {
        teardownMocks();
      }
    });

    it('should reject non-superadmin from pausing all groups', async () => {
      setupMocks();
      try {
        const res = await handleCourtCommand(mockSock, '!pausecourtbookings all', testChatId, 'Admin', adminUser);
        assert.match(res, /Only the bot superadmin can pause court bookings for all groups/);

        const res2 = await handleCourtCommand(mockSock, '!pauseallcourtbookings', testChatId, 'Admin', adminUser);
        assert.match(res2, /Only the bot superadmin can pause court bookings for all groups/);
      } finally {
        teardownMocks();
      }
    });

    it('should reject non-superadmin from resuming all groups', async () => {
      setupMocks();
      try {
        const res = await handleCourtCommand(mockSock, '!resumecourtbookings all', testChatId, 'Admin', adminUser);
        assert.match(res, /Only the bot superadmin can resume court bookings for all groups/);

        const res2 = await handleCourtCommand(mockSock, '!resumeallcourtbookings', testChatId, 'Admin', adminUser);
        assert.match(res2, /Only the bot superadmin can resume court bookings for all groups/);
      } finally {
        teardownMocks();
      }
    });

    it('should allow group admin to pause court bookings for current group', async () => {
      setupMocks();
      try {
        const res = await handleCourtCommand(mockSock, '!pausecourtbookings', testChatId, 'Admin', adminUser);
        assert.match(res, /Court bookings paused for/);
        const cfg = groupsConfig.loadRawConfig();
        assert.equal(cfg.groups[testChatId].courtBookingEnabled, false);
      } finally {
        teardownMocks();
      }
    });

    it('should allow group admin to resume court bookings for current group', async () => {
      setupMocks();
      try {
        const res = await handleCourtCommand(mockSock, '!resumecourtbookings', testChatId, 'Admin', adminUser);
        assert.match(res, /Court bookings resumed for/);
        const cfg = groupsConfig.loadRawConfig();
        assert.equal(cfg.groups[testChatId].courtBookingEnabled, true);
      } finally {
        teardownMocks();
      }
    });

    it('should allow superadmin to pause court bookings across all groups with a single command', async () => {
      setupMocks();
      try {
        const res = await handleCourtCommand(mockSock, '!pauseallcourtbookings', testChatId, 'Super', superUser);
        assert.match(res, /Court bookings paused for all groups/);
        const cfg = groupsConfig.loadRawConfig();
        assert.equal(cfg.defaults.courtBookingEnabled, false);
        for (const g of Object.values(cfg.groups)) {
          assert.equal(g.courtBookingEnabled, false);
        }
      } finally {
        teardownMocks();
      }
    });

    it('should allow superadmin to resume court bookings across all groups with a single command', async () => {
      setupMocks();
      try {
        const res = await handleCourtCommand(mockSock, '!resumeallcourtbookings', testChatId, 'Super', superUser);
        assert.match(res, /Court bookings resumed for all groups/);
        const cfg = groupsConfig.loadRawConfig();
        assert.equal(cfg.defaults.courtBookingEnabled, true);
        for (const g of Object.values(cfg.groups)) {
          assert.equal(g.courtBookingEnabled, true);
        }
      } finally {
        teardownMocks();
      }
    });

    it('should handle pause_court_bookings and resume_court_bookings tools', async () => {
      setupMocks();
      try {
        // Group admin tool execution
        const resAdminPause = await executeCourtTool(mockSock, 'pause_court_bookings', { group: testChatId }, 'Admin', testChatId, adminUser);
        assert.match(resAdminPause, /Court bookings paused for/);

        const resAdminResume = await executeCourtTool(mockSock, 'resume_court_bookings', { group: testChatId }, 'Admin', testChatId, adminUser);
        assert.match(resAdminResume, /Court bookings resumed for/);

        // Non-admin tool execution rejected
        const resNonAdmin = await executeCourtTool(mockSock, 'pause_court_bookings', { group: testChatId }, 'Regular', testChatId, regularUser);
        assert.match(resNonAdmin, /Only group admins or the bot superadmin can pause court bookings/);

        // Superadmin all groups tool execution
        const resSuperPause = await executeCourtTool(mockSock, 'pause_court_bookings', { all: true }, 'Super', testChatId, superUser);
        assert.match(resSuperPause, /Court bookings paused for all groups/);

        const resSuperResume = await executeCourtTool(mockSock, 'resume_court_bookings', { all: true }, 'Super', testChatId, superUser);
        assert.match(resSuperResume, /Court bookings resumed for all groups/);
      } finally {
        teardownMocks();
      }
    });
  });

  describe("court webcam (!webcam)", () => {
    const origGetWebcam = scvcc.getCourtWebcamSnapshot;
    const origGetClip = scvcc.getCourtWebcamClip;
    const testChatId = "120363403838804497@g.us";

    function restore() {
      scvcc.getCourtWebcamSnapshot = origGetWebcam;
      scvcc.getCourtWebcamClip = origGetClip;
    }

    it("should return a photo snapshot object for !webcam by default without player links", async () => {
      const mockImageBuf = Buffer.from("fake-jpeg-image-bytes");
      scvcc.getCourtWebcamSnapshot = async () => ({
        success: true,
        imageBuffer: mockImageBuf,
        playerUrl: "https://g1.ipcamlive.com/player/player.php?alias=5ca7b2391ca5e&autoplay=1"
      });

      try {
        const res = await handleCourtCommand(null, "!webcam", testChatId, "Alice");
        assert.ok(typeof res === "object" && res !== null, "Should return media object so routeCommand does not fall through");
        assert.equal(res.image, mockImageBuf);
        assert.match(res.caption, /SCVCC Tennis Court Webcam/);
        assert.equal(res.caption.includes("player.php"), false, "Should NOT include player link");
        assert.equal(res.caption.includes("Live Player"), false, "Should NOT include player link");

        const resCam = await handleCourtCommand(null, "!camera", testChatId, "Alice");
        assert.ok(typeof resCam === "object" && resCam !== null);
        assert.equal(resCam.image, mockImageBuf);
      } finally {
        restore();
      }
    });

    it("should return a 10s video clip object when video option is requested (!webcam video)", async () => {
      const mockVideoBuf = Buffer.from("fake-mp4-video-bytes");
      scvcc.getCourtWebcamClip = async (duration) => ({
        success: true,
        videoBuffer: mockVideoBuf,
        duration: 10,
        playerUrl: "https://g1.ipcamlive.com/player/player.php?alias=5ca7b2391ca5e&autoplay=1"
      });

      try {
        const res = await handleCourtCommand(null, "!webcam video", testChatId, "Alice");
        assert.ok(typeof res === "object" && res !== null, "Should return media object so routeCommand does not fall through");
        assert.equal(res.video, mockVideoBuf);
        assert.equal(res.mimetype, "video/mp4");
        assert.match(res.caption, /SCVCC Tennis Court Webcam \(10s clip\)/);
        assert.equal(res.caption.includes("player.php"), false, "Should NOT include player link");
        assert.equal(res.caption.includes("Live Player"), false, "Should NOT include player link");

        const resClip = await handleCourtCommand(null, "!camera clip", testChatId, "Alice");
        assert.ok(typeof resClip === "object" && resClip !== null);
        assert.equal(resClip.video, mockVideoBuf);
      } finally {
        restore();
      }
    });

    it("should reject webcam command when court booking is disabled for group", async () => {
      const groupsConfig = require("../lib/groupsConfig");
      const origIsCourtBookingEnabled = groupsConfig.isCourtBookingEnabled;
      groupsConfig.isCourtBookingEnabled = () => false;
      try {
        const res = await handleCourtCommand(null, "!webcam", testChatId, "Alice");
        assert.match(res, /Court webcam and booking functionality is not enabled/);
      } finally {
        groupsConfig.isCourtBookingEnabled = origIsCourtBookingEnabled;
      }
    });

    it("should handle get_court_webcam tool execution defaulting to photo and sending video when requested", async () => {
      const mockImageBuf = Buffer.from("tool-image-bytes");
      const mockVideoBuf = Buffer.from("tool-video-bytes");
      scvcc.getCourtWebcamSnapshot = async () => ({
        success: true,
        imageBuffer: mockImageBuf,
        playerUrl: "https://g1.ipcamlive.com/player/player.php?alias=5ca7b2391ca5e&autoplay=1"
      });
      scvcc.getCourtWebcamClip = async (duration) => ({
        success: true,
        videoBuffer: mockVideoBuf,
        duration: 10,
        playerUrl: "https://g1.ipcamlive.com/player/player.php?alias=5ca7b2391ca5e&autoplay=1"
      });

      try {
        const sentMessages = [];
        const mockSock = {
          sendMessage: async (jid, content) => {
            sentMessages.push({ jid, content });
            return { key: { id: "msg-tool-" + sentMessages.length } };
          }
        };

        // Default tool call -> photo snapshot
        const toolResDefault = await executeCourtTool(mockSock, "get_court_webcam", {}, "Alice", testChatId);
        assert.match(toolResDefault, /Live court webcam photo snapshot has been sent to the chat/);
        assert.equal(toolResDefault.includes("player.php"), false, "Should NOT include player link in tool output");
        assert.equal(sentMessages.length, 1);
        assert.equal(sentMessages[0].content.image, mockImageBuf);
        assert.equal(sentMessages[0].content.caption.includes("player.php"), false);

        // format: video tool call -> 10s video clip
        const toolResVideo = await executeCourtTool(mockSock, "get_court_webcam", { format: "video" }, "Alice", testChatId);
        assert.match(toolResVideo, /Live 10-second court webcam video clip has been sent to the chat/);
        assert.equal(toolResVideo.includes("player.php"), false, "Should NOT include player link in tool output");
        assert.equal(sentMessages.length, 2);
        assert.equal(sentMessages[1].content.video, mockVideoBuf);
        assert.equal(sentMessages[1].content.caption.includes("player.php"), false);
      } finally {
        restore();
      }
    });
  });
});
