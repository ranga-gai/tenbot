const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const pollStore = require('../lib/pollStore');
const { DATA_DIR } = require('../lib/paths');

describe('pollStore subfolder & multi-file architecture', () => {
  const testChatId = 'test_group_999@g.us';
  const testGroupDir = pollStore.getGroupDir(testChatId);

  afterEach(() => {
    // Cleanup test folder if created
    if (fs.existsSync(testGroupDir)) {
      fs.rmSync(testGroupDir, { recursive: true, force: true });
    }
    const legacyFile = pollStore.getGroupFilePath(testChatId);
    if (fs.existsSync(legacyFile)) {
      fs.unlinkSync(legacyFile);
    }
  });

  it('should save state in subfolder with recurring.json, meta.json, and individual polls/*.json files', () => {
    const pollId1 = 'poll_test_001';
    const pollId2 = 'poll_test_002';

    const pollState1 = {
      remoteJid: testChatId,
      name: 'Tennis Monday 7pm',
      options: ['Player 1', 'Player 2'],
      size: 4,
      status: 'active',
      voteBuffer: new Map([
        ['user1', { vote: { selectedOptions: [Buffer.from([1, 2, 3])] } }]
      ])
    };

    const pollState2 = {
      remoteJid: testChatId,
      name: 'Tennis Tuesday 6pm',
      options: ['Yes', 'No'],
      type: 'opt_in',
      status: 'active',
      voteBuffer: new Map()
    };

    const creationMsg1 = {
      pollCreationMessage: { name: 'Tennis Monday 7pm', options: [] }
    };

    const messageStore = new Map([
      [`${testChatId}:${pollId1}`, creationMsg1],
      [`${testChatId}:general_alert`, { text: 'Tennis alert' }]
    ]);

    const activePolls = new Map([
      [pollId1, pollState1],
      [pollId2, pollState2]
    ]);

    const latestPollIdByChat = new Map([[testChatId, pollId2]]);

    const recurringPolls = new Map([
      ['rec_test_1', { id: 'rec_test_1', remoteJid: testChatId, matchTime: '7pm', days: 'mon,wed' }]
    ]);

    pollStore.save({ messageStore, activePolls, latestPollIdByChat, recurringPolls }, testChatId);

    // Verify directory structure
    assert.ok(fs.existsSync(testGroupDir));
    assert.ok(fs.existsSync(path.join(testGroupDir, 'meta.json')));
    assert.ok(fs.existsSync(path.join(testGroupDir, 'recurring.json')));
    assert.ok(fs.existsSync(path.join(testGroupDir, 'polls')));
    assert.ok(fs.existsSync(path.join(testGroupDir, 'messages.json'))); // has general_alert

    // Verify individual poll instance files
    const pollFile1 = path.join(testGroupDir, 'polls', `${pollId1}.json`);
    const pollFile2 = path.join(testGroupDir, 'polls', `${pollId2}.json`);
    assert.ok(fs.existsSync(pollFile1));
    assert.ok(fs.existsSync(pollFile2));

    const pollData1 = pollStore.readJsonSafe(pollFile1);
    assert.equal(pollData1.pollId, pollId1);
    assert.equal(pollData1.pollState.name, 'Tennis Monday 7pm');
    assert.ok(pollData1.creationMessage);
    assert.equal(pollData1.creationMessage.pollCreationMessage.name, 'Tennis Monday 7pm');

    // Verify recurring.json
    const recData = pollStore.readJsonSafe(path.join(testGroupDir, 'recurring.json'));
    assert.ok(recData.recurringPolls instanceof Map);
    assert.equal(recData.recurringPolls.size, 1);
    assert.equal(recData.recurringPolls.get('rec_test_1').matchTime, '7pm');

    // Verify meta.json
    const metaData = pollStore.readJsonSafe(path.join(testGroupDir, 'meta.json'));
    assert.equal(metaData.chatId, testChatId);
    assert.equal(metaData.latestPollId, pollId2);
  });

  it('should accurately reload group state from subfolder', () => {
    const pollId = 'poll_reload_1';
    const pollState = {
      remoteJid: testChatId,
      name: 'Sunday Hit',
      options: ['P1', 'P2'],
      size: 4,
      status: 'active',
      voteBuffer: new Map([
        ['user_abc', { vote: { selectedOptions: [Buffer.from([99, 100])] } }]
      ])
    };

    const messageStore = new Map([
      [`${testChatId}:${pollId}`, { pollCreationMessage: { name: 'Sunday Hit' } }]
    ]);
    const activePolls = new Map([[pollId, pollState]]);
    const latestPollIdByChat = new Map([[testChatId, pollId]]);
    const recurringPolls = new Map([
      ['rec_sun', { id: 'rec_sun', remoteJid: testChatId, matchTime: '9am' }]
    ]);

    pollStore.save({ messageStore, activePolls, latestPollIdByChat, recurringPolls }, testChatId);

    const reloaded = pollStore.loadGroup(testChatId);
    assert.equal(reloaded.chatId, testChatId);
    assert.equal(reloaded.activePolls.size, 1);
    assert.equal(reloaded.activePolls.get(pollId).name, 'Sunday Hit');

    // Verify Buffer deserialization in voteBuffer
    const voterEntry = reloaded.activePolls.get(pollId).voteBuffer.get('user_abc');
    assert.ok(voterEntry);
    assert.ok(Buffer.isBuffer(voterEntry.vote.selectedOptions[0]));
    assert.deepEqual([...voterEntry.vote.selectedOptions[0]], [99, 100]);

    // Verify creation message co-located in messageStore
    assert.equal(reloaded.messageStore.size, 1);
    assert.ok(reloaded.messageStore.has(`${testChatId}:${pollId}`));

    // Verify recurring schedule
    assert.equal(reloaded.recurringPolls.size, 1);
    assert.equal(reloaded.recurringPolls.get('rec_sun').matchTime, '9am');

    // Verify latest poll ID
    assert.equal(reloaded.latestPollIdByChat.get(testChatId), pollId);
  });

  it('should automatically delete individual poll file when poll is removed from activePolls', () => {
    const pollId1 = 'poll_keep';
    const pollId2 = 'poll_remove';

    const pState1 = { remoteJid: testChatId, name: 'Poll 1', status: 'active', voteBuffer: new Map() };
    const pState2 = { remoteJid: testChatId, name: 'Poll 2', status: 'active', voteBuffer: new Map() };

    const activePolls = new Map([[pollId1, pState1], [pollId2, pState2]]);
    pollStore.save({ messageStore: new Map(), activePolls, latestPollIdByChat: new Map(), recurringPolls: new Map() }, testChatId);

    const pollFile1 = path.join(testGroupDir, 'polls', `${pollId1}.json`);
    const pollFile2 = path.join(testGroupDir, 'polls', `${pollId2}.json`);
    assert.ok(fs.existsSync(pollFile1));
    assert.ok(fs.existsSync(pollFile2));

    // Remove pollId2 and save again
    activePolls.delete(pollId2);
    pollStore.save({ messageStore: new Map(), activePolls, latestPollIdByChat: new Map(), recurringPolls: new Map() }, testChatId);

    assert.ok(fs.existsSync(pollFile1));
    assert.equal(fs.existsSync(pollFile2), false); // file should be removed!
  });

  it('should auto-migrate legacy monolithic poll-state-<chatId>.json file', () => {
    const legacyFile = pollStore.getGroupFilePath(testChatId);
    const legacyPayload = {
      chatId: testChatId,
      updatedAt: new Date().toISOString(),
      messageStore: {
        __type: 'Map',
        entries: [
          [`${testChatId}:legacy_poll_1`, { pollCreationMessage: { name: 'Legacy Poll' } }]
        ]
      },
      activePolls: {
        __type: 'Map',
        entries: [
          ['legacy_poll_1', { remoteJid: testChatId, name: 'Legacy Poll', status: 'active', voteBuffer: { __type: 'Map', entries: [] } }]
        ]
      },
      latestPollIdByChat: {
        __type: 'Map',
        entries: [[testChatId, 'legacy_poll_1']]
      },
      recurringPolls: {
        __type: 'Map',
        entries: [
          ['rec_legacy', { id: 'rec_legacy', remoteJid: testChatId, matchTime: '8am' }]
        ]
      }
    };

    fs.writeFileSync(legacyFile, JSON.stringify(legacyPayload, null, 2), 'utf-8');
    assert.ok(fs.existsSync(legacyFile));

    // Calling loadGroup should detect legacy file, migrate it, and delete the legacy file
    const loaded = pollStore.loadGroup(testChatId);
    assert.equal(loaded.activePolls.size, 1);
    assert.equal(loaded.activePolls.get('legacy_poll_1').name, 'Legacy Poll');
    assert.equal(loaded.recurringPolls.size, 1);
    assert.equal(loaded.recurringPolls.get('rec_legacy').matchTime, '8am');

    // Legacy file should have been migrated and removed
    assert.equal(fs.existsSync(legacyFile), false);

    // New directory structure should exist
    assert.ok(fs.existsSync(testGroupDir));
    assert.ok(fs.existsSync(path.join(testGroupDir, 'polls', 'legacy_poll_1.json')));
    assert.ok(fs.existsSync(path.join(testGroupDir, 'recurring.json')));
    assert.ok(fs.existsSync(path.join(testGroupDir, 'meta.json')));
  });
});
