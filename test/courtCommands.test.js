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
});
