const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const messageHistory = require('../lib/messageHistory');

describe('messageHistory per-group storage architecture', () => {
  const chat1 = 'test_history_group_1@g.us';
  const chat2 = 'test_history_group_2@g.us';

  afterEach(() => {
    messageHistory.clear(chat1);
    messageHistory.clear(chat2);
  });

  it('should store message history in separate files per chat', () => {
    const now = Date.now();
    messageHistory.recordMessage(chat1, 'Alice', 'Hello from Chat 1', now - 1000);
    messageHistory.recordMessage(chat2, 'Bob', 'Hello from Chat 2', now);

    const file1 = messageHistory.getChatFilePath(chat1);
    const file2 = messageHistory.getChatFilePath(chat2);

    assert.ok(fs.existsSync(file1));
    assert.ok(fs.existsSync(file2));

    const content1 = JSON.parse(fs.readFileSync(file1, 'utf8'));
    assert.equal(content1.chatId, chat1);
    assert.equal(content1.messages.length, 1);
    assert.equal(content1.messages[0].text, 'Hello from Chat 1');

    const content2 = JSON.parse(fs.readFileSync(file2, 'utf8'));
    assert.equal(content2.chatId, chat2);
    assert.equal(content2.messages.length, 1);
    assert.equal(content2.messages[0].text, 'Hello from Chat 2');
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

  it('should prune messages older than 2 weeks', () => {
    const now = Date.now();
    const oldTimestamp = now - (15 * 24 * 60 * 60 * 1000); // 15 days ago
    const recentTimestamp = now - (1 * 24 * 60 * 60 * 1000); // 1 day ago

    messageHistory.recordMessage(chat1, 'Alice', 'Old message', oldTimestamp);
    messageHistory.recordMessage(chat1, 'Alice', 'Recent message', recentTimestamp);

    const history = messageHistory.getRecentMessages(chat1);
    assert.equal(history.length, 1);
    assert.equal(history[0].text, 'Recent message');
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
