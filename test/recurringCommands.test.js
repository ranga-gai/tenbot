const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  handleListRecurringPolls,
  handleRecurringCommand,
  executeRecurringTool
} = require('../lib/commands/recurringCommands');

describe('recurringCommands', () => {
  describe('handleListRecurringPolls', () => {
    it('should return no schedules message when recurringPolls map is empty', () => {
      const context = { recurringPolls: new Map() };
      const res = handleListRecurringPolls('test_chat@g.us', context);
      assert.match(res, /No recurring match polls scheduled/i);
    });

    it('should format recurring poll schedule list when schedules exist', () => {
      const recurringPolls = new Map([
        ['rec_test1', {
          id: 'rec_test1',
          remoteJid: 'test_chat@g.us',
          daysDisplay: 'Mon, Wed, Fri',
          matchDisplay: '7:00 PM',
          postDisplay: '8:00 AM',
          size: 4,
          enabled: true
        }]
      ]);
      const res = handleListRecurringPolls('test_chat@g.us', { recurringPolls });
      assert.match(res, /rec_test1/);
      assert.match(res, /Mon, Wed, Fri/);
      assert.match(res, /7:00 PM/);
    });
  });

  describe('handleRecurringCommand', () => {
    it('should handle !recurringpolls list command', async () => {
      const context = { recurringPolls: new Map() };
      const res = await handleRecurringCommand(null, '!recurringpolls', 'test_chat@g.us', 'Alice', '123@s.whatsapp.net', context);
      assert.match(res, /No recurring match polls scheduled/i);
    });

    it('should return null for non-recurring commands', async () => {
      const res = await handleRecurringCommand(null, '!help', 'test_chat@g.us', 'Alice', '123@s.whatsapp.net', {});
      assert.equal(res, null);
    });
  });

  describe('executeRecurringTool', () => {
    it('should execute list_recurring_polls tool', async () => {
      const context = { recurringPolls: new Map() };
      const res = await executeRecurringTool(null, 'list_recurring_polls', {}, '123@s.whatsapp.net', 'test_chat@g.us', 'Alice', context);
      assert.match(res, /No recurring match polls scheduled/i);
    });

    it('should return unknown message for unrecognized tool', async () => {
      const res = await executeRecurringTool(null, 'nonexistent_recurring_tool', {}, '123@s.whatsapp.net', 'test_chat@g.us', 'Alice', {});
      assert.equal(res, 'Unknown recurring tool nonexistent_recurring_tool');
    });
  });
});
