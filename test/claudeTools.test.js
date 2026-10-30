const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { CLAUDE_TOOLS, CACHED_CLAUDE_TOOLS } = require('../lib/claudeTools');

describe('claudeTools', () => {
  it('should export CLAUDE_TOOLS and CACHED_CLAUDE_TOOLS as arrays', () => {
    assert(Array.isArray(CLAUDE_TOOLS));
    assert(Array.isArray(CACHED_CLAUDE_TOOLS));
    assert.equal(CLAUDE_TOOLS.length, CACHED_CLAUDE_TOOLS.length);
    assert.equal(CLAUDE_TOOLS.length, 40);
  });

  it('should ensure each tool has name, description, and valid input_schema', () => {
    for (const tool of CLAUDE_TOOLS) {
      assert.equal(typeof tool.name, 'string');
      assert.ok(tool.name.length > 0);
      assert.equal(typeof tool.description, 'string');
      assert.ok(tool.description.length > 0);
      assert.equal(typeof tool.input_schema, 'object');
      assert.equal(tool.input_schema.type, 'object');
      assert.equal(typeof tool.input_schema.properties, 'object');
    }
  });

  it('should ensure CACHED_CLAUDE_TOOLS has cache_control ephemeral on the last tool only', () => {
    for (let i = 0; i < CACHED_CLAUDE_TOOLS.length; i++) {
      const tool = CACHED_CLAUDE_TOOLS[i];
      if (i === CACHED_CLAUDE_TOOLS.length - 1) {
        assert.deepEqual(tool.cache_control, { type: 'ephemeral' });
      } else {
        assert.equal(tool.cache_control, undefined);
      }
    }
  });

  it('should contain all expected key tool names', () => {
    const toolNames = new Set(CLAUDE_TOOLS.map((t) => t.name));
    const expected = [
      'simulate_poll',
      'create_poll',
      'reset_rating',
      'generate_matchups',
      'add_alias',
      'remove_alias',
      'set_full_name',
      'set_rating',
      'get_weather',
      'clear_all_polls',
      'cancel_poll',
      'rematch',
      'parse_lineup',
      'stop_poll',
      'resume_poll',
      'pause_reminders',
      'resume_reminders',
      'trigger_reminder',
      'schedule_recurring_poll',
      'modify_recurring_poll',
      'list_recurring_polls',
      'limit_poll_slots',
      'modify_poll_instance',
      'pause_recurring_poll',
      'resume_recurring_poll',
      'skip_recurring_poll_instance',
      'unskip_recurring_poll_instance',
      'cancel_recurring_poll',
      'clear_all_recurring_polls',
      'get_court_bookings',
      'check_court_availability',
      'cancel_court_reservation',
      'pause_court_bookings',
      'resume_court_bookings',
      'get_court_webcam',
      'list_groups',
      'add_group',
      'remove_group',
      'update_group_config',
      'get_group_config'
    ];

    for (const exp of expected) {
      assert.ok(toolNames.has(exp), `Expected tool "${exp}" to be present in CLAUDE_TOOLS`);
    }
  });
});
