const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const messageHistory = require('../lib/messageHistory');

describe('messageHistory per-group JSONL storage architecture', () => {
  const chat1 = 'test_history_group_1@g.us';
  const chat2 = 'test_history_group_2@g.us';

  afterEach(() => {
    messageHistory.clear(chat1);
    messageHistory.clear(chat2);
  });

  it('should store message history as JSON lines (.jsonl) in separate files per chat', () => {
    const now = Date.now();
    messageHistory.recordMessage(chat1, 'Alice', 'Hello from Chat 1', now - 1000);
    messageHistory.recordMessage(chat2, 'Bob', 'Hello from Chat 2', now);

    const file1 = messageHistory.getChatFilePath(chat1);
    const file2 = messageHistory.getChatFilePath(chat2);

    assert.ok(file1.endsWith('.jsonl'));
    assert.ok(file2.endsWith('.jsonl'));
    assert.ok(fs.existsSync(file1));
    assert.ok(fs.existsSync(file2));

    const messages1 = messageHistory.parseJsonLines(fs.readFileSync(file1, 'utf8'));
    assert.equal(messages1.length, 1);
    assert.equal(messages1[0].text, 'Hello from Chat 1');
    assert.equal(messages1[0].sender, 'Alice');

    const messages2 = messageHistory.parseJsonLines(fs.readFileSync(file2, 'utf8'));
    assert.equal(messages2.length, 1);
    assert.equal(messages2[0].text, 'Hello from Chat 2');
    assert.equal(messages2[0].sender, 'Bob');
  });

  it('should perform O(1) appends to .jsonl file without pruning on each incoming message', () => {
    const now = Date.now();
    const oldTimestamp = now - (16 * 24 * 60 * 60 * 1000); // 16 days ago

    // Record an older message
    messageHistory.recordMessage(chat1, 'Alice', 'Old line', oldTimestamp);
    const file1 = messageHistory.getChatFilePath(chat1);

    // Record a new message - verify it appends rather than compacting/rewriting immediately
    messageHistory.recordMessage(chat1, 'Bob', 'New line', now);

    const raw = fs.readFileSync(file1, 'utf8');
    const lines = raw.trim().split('\n');
    assert.equal(lines.length, 2); // Both lines still in file (no rewriting during recordMessage)

    // But getRecentMessages filters out the 16-day-old message
    const recent = messageHistory.getRecentMessages(chat1);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].text, 'New line');
  });

  it('should prune messages older than 2 weeks when pruneAllExpiredMessages runs', () => {
    const now = Date.now();
    const oldTimestamp = now - (15 * 24 * 60 * 60 * 1000); // 15 days ago
    const recentTimestamp = now - (1 * 24 * 60 * 60 * 1000); // 1 day ago

    messageHistory.recordMessage(chat1, 'Alice', 'Old message', oldTimestamp);
    messageHistory.recordMessage(chat1, 'Alice', 'Recent message', recentTimestamp);

    const file1 = messageHistory.getChatFilePath(chat1);
    assert.equal(messageHistory.parseJsonLines(fs.readFileSync(file1, 'utf8')).length, 2);

    // Run explicit daily prune sweep
    const count = messageHistory.pruneAllExpiredMessages();
    assert.ok(count >= 1);

    // File on disk now only has the unexpired message
    const onDiskAfterPrune = messageHistory.parseJsonLines(fs.readFileSync(file1, 'utf8'));
    assert.equal(onDiskAfterPrune.length, 1);
    assert.equal(onDiskAfterPrune[0].text, 'Recent message');
  });

  it('should only modify the target chat file when adding messages', () => {
    const now = Date.now();
    messageHistory.recordMessage(chat1, 'Alice', 'Message 1', now - 5000);
    messageHistory.recordMessage(chat2, 'Bob', 'Message 1', now - 5000);

    const file2 = messageHistory.getChatFilePath(chat2);
    const mtime2Before = fs.statSync(file2).mtimeMs;

    // Wait slightly then write to chat1 only
    messageHistory.recordMessage(chat1, 'Alice', 'Message 2', now);

    const mtime2After = fs.statSync(file2).mtimeMs;
    assert.equal(mtime2Before, mtime2After, 'Chat 2 file should NOT have been touched');

    const history1 = messageHistory.getRecentMessages(chat1);
    assert.equal(history1.length, 2);

    const history2 = messageHistory.getRecentMessages(chat2);
    assert.equal(history2.length, 1);
  });

  it('should clear only the target chat when clear(chatId) is called', () => {
    messageHistory.recordMessage(chat1, 'Alice', 'Keep me not');
    messageHistory.recordMessage(chat2, 'Bob', 'Keep me');

    assert.ok(fs.existsSync(messageHistory.getChatFilePath(chat1)));
    assert.ok(fs.existsSync(messageHistory.getChatFilePath(chat2)));

    messageHistory.clear(chat1);

    assert.equal(fs.existsSync(messageHistory.getChatFilePath(chat1)), false);
    assert.ok(fs.existsSync(messageHistory.getChatFilePath(chat2)));
    assert.equal(messageHistory.getRecentMessages(chat1).length, 0);
    assert.equal(messageHistory.getRecentMessages(chat2).length, 1);
  });

  it('should format recent messages for LLM context', () => {
    messageHistory.recordMessage(chat1, 'Alice', 'Anyone up for tennis tomorrow?');
    messageHistory.recordMessage(chat1, 'Bob', 'I am in!');

    const formatted = messageHistory.formatRecentMessagesForContext(chat1);
    assert.match(formatted, /Alice: Anyone up for tennis tomorrow\?/);
    assert.match(formatted, /Bob: I am in!/);
  });
});
