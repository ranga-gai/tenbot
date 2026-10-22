const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { helpText } = require('../lib/help');

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

  it('should return detailed help for "!help poll"', () => {
    const text = helpText('poll', false);
    assert.match(text, /Create Match Poll \(!poll\)/);
    assert.match(text, /Usage:/);
    assert.match(text, /Examples:/);
    assert.match(text, /look-around/i);
  });

  it('should return detailed help for "!help courts"', () => {
    const text = helpText('courts', false);
    assert.match(text, /Court Availability \(!courts\)/);
    assert.match(text, /SCVCC/);
  });

  it('should return detailed help for "!help recurringpoll"', () => {
    const text = helpText('recurringpoll', false);
    assert.match(text, /Recurring Daily Polls \(!recurringpoll\)/);
    assert.match(text, /advance court pre-booking/i);
    assert.match(text, /look-around/i);
  });

  it('should return detailed help for "!help score"', () => {
    const text = helpText('score', false);
    assert.match(text, /Match Score Reporting \(!score\)/);
  });

  it('should return general help with notice for unknown command topic', () => {
    const text = helpText('unknown_xyz_topic', false);
    assert.match(text, /Unknown command/);
  });
});
