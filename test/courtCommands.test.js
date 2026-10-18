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
});
