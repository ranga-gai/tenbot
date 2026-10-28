const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { helpText, COMMAND_HELP } = require('../lib/help');

describe('help', () => {
  it('should return general help text when no command is specified', () => {
    const text = helpText(null, false);
    assert.match(text, /Tennis Group Bot Commands:/);
    assert.match(text, /!poll/);
    assert.match(text, /!matchups/);
    assert.match(text, /!score/);
    assert.match(text, /!ratings/);
    // When isSuper is false, superadmin group commands should not appear
    assert.equal(text.includes('!groups – (Superadmin only via DM)'), false);
  });

  it('should include superadmin commands in general help when isSuper is true', () => {
    const text = helpText(null, true);
    assert.match(text, /!groups/);
    assert.match(text, /Superadmin only/);
  });

  it('should return detailed help for "!help poll" including option descriptions', () => {
    const text = helpText('poll', false);
    assert.match(text, /Create Match Poll \(!poll\)/);
    assert.match(text, /Usage:/);
    assert.match(text, /Options:/);
    assert.match(text, /`--courts` — Check SCVCC court availability/);
    assert.equal(text.includes('`--no-matchups`'), false);
    assert.match(text, /`--lineups=filled\|fallback\|none` — Lineup generation mode/);
    assert.match(text, /`--lineup-lead-time=<duration>` — Lead time before play time/);
    assert.match(text, /`--slot-check` \/ `--no-slot-check` — Enable or disable slot conflict checking/);
    assert.match(text, /`--pre-allocate-slots` — Include pre-allocated court slots/);
    assert.match(text, /`--reminders` \/ `--no-reminders`/);
    assert.match(text, /`--reminders` \/ `--no-reminders`/);
    assert.match(text, /`--reminders` \/ `--no-reminders`/);
    assert.match(text, /`--court-booking-type=pre-book\|none` — Automatically pre-book courts/);
    assert.match(text, /`--look-around="<window>"` — Time window to search/);
    assert.match(text, /Examples:/);
  });

  it('should return detailed help for "!help courts" including option descriptions', () => {
    const text = helpText('courts', false);
    assert.match(text, /Court Availability \(!courts\)/);
    assert.match(text, /Options:/);
    assert.match(text, /`\[when\]` — Date or day of the week to check availability/);
    assert.match(text, /`\[time\]` — Filter availability by start time/);
    assert.match(text, /`\[court\]` — Filter availability to a specific court/);
    assert.match(text, /`\[pb\]` — Check pickleball court availability/);
    assert.match(text, /SCVCC/);
  });

  it('should return detailed help for "!help recurringpoll" including option descriptions', () => {
    const text = helpText('recurringpoll', false);
    assert.match(text, /Recurring Daily Polls \(!recurringpoll\)/);
    assert.match(text, /Options:/);
    assert.match(text, /`<matchTime>` — Scheduled match play time/);
    assert.match(text, /`\[at <postTime>\]` — When to post the poll/);
    assert.match(text, /`\[days\]` — Days of the week to post/);
    assert.match(text, /`--booking-strategy=advanced\|standard` — Booking strategy/);
    assert.match(text, /`--booking-schedule="<offset>"` — Advance booking trigger schedule/);
    assert.match(text, /`--look-around="<window>"`/);
    assert.match(text, /`--pre-allocate-slots` — Include pre-allocated court slots/);
    assert.match(text, /advance court pre-booking/i);
  });

  it('should return detailed help for "!help bookcourt" including option descriptions', () => {
    const text = helpText('bookcourt', false);
    assert.match(text, /Book Court/);
    assert.match(text, /Options:/);
    assert.match(text, /`<time>` — Booking start time/);
    assert.match(text, /`\[singles\/doubles\]` — Match format/);
    assert.match(text, /`\[duration\]` — Length of booking/);
  });

  it('should return detailed help for "!help modifyinstance" including option descriptions', () => {
    const text = helpText('modifyinstance', false);
    assert.match(text, /Modify Poll Instance/);
    assert.match(text, /Options:/);
    assert.match(text, /`<scheduleId\/pollId>` — Target poll ID/);
    assert.match(text, /`--lineups=filled\|fallback\|none`/);
    assert.match(text, /`--pre-allocate-slots` — Include pre-allocated court slots/);
  });

  it('should return detailed help for "!help score" including option descriptions', () => {
    const text = helpText('score', false);
    assert.match(text, /Match Score Reporting \(!score\)/);
    assert.match(text, /Options:/);
    assert.match(text, /`<winner>` — Name\(s\) of the winning player/);
    assert.match(text, /`<loser>` — Name\(s\) of the losing player/);
    assert.match(text, /`<score>` — Match scores by set/);
  });

  it('should provide options descriptions for all registered commands in COMMAND_HELP', () => {
    for (const [topicKey, item] of Object.entries(COMMAND_HELP)) {
      assert.ok(Array.isArray(item.options), `Command "${topicKey}" must have an options array`);
      assert.ok(item.options.length > 0, `Command "${topicKey}" options array must not be empty`);
      const formatted = helpText(topicKey, true);
      assert.match(formatted, /Options:/, `Command "${topicKey}" help must include Options section`);
    }
  });

  it('should return general help with notice for unknown command topic', () => {
    const text = helpText('unknown_xyz_topic', false);
    assert.match(text, /Unknown command/);
  });
});
