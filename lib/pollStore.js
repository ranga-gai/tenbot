/**
 * Persists poll state (message store, active polls, latest-poll-per-chat)
 * to a local JSON file so polls survive a bot restart.
 */

const fs = require('fs');
const path = require('path');

const POLL_STATE_FILE = path.join(__dirname, '..', 'poll-state.json');

function replacer(key, value) {
  if (value instanceof Map) {
    return { __type: 'Map', entries: [...value.entries()] };
  }
  if (value instanceof Uint8Array) {
    return { __type: 'Uint8Array', base64: Buffer.from(value).toString('base64') };
  }
  return value;
}

function reviver(key, value) {
  if (value && typeof value === 'object') {
    if (value.__type === 'Map') return new Map(value.entries);
    if (value.__type === 'Uint8Array') return new Uint8Array(Buffer.from(value.base64, 'base64'));
    if (value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data);
  }
  return value;
}

function save({ messageStore, activePolls, latestPollIdByChat }) {
  try {
    const payload = { messageStore, activePolls, latestPollIdByChat };
    fs.writeFileSync(POLL_STATE_FILE, JSON.stringify(payload, replacer));
  } catch (err) {
    console.error('⚠️ Failed to save poll state:', err.message);
  }
}

function load() {
  const empty = () => ({
    messageStore: new Map(),
    activePolls: new Map(),
    latestPollIdByChat: new Map()
  });

  if (!fs.existsSync(POLL_STATE_FILE)) return empty();

  try {
    const raw = fs.readFileSync(POLL_STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw, reviver);
    const messageStore = parsed.messageStore instanceof Map ? parsed.messageStore : new Map();
    const activePolls = parsed.activePolls instanceof Map ? parsed.activePolls : new Map();
    const latestPollIdByChat = parsed.latestPollIdByChat instanceof Map ? parsed.latestPollIdByChat : new Map();

    for (const [, pollState] of activePolls.entries()) {
      if (!(pollState.voteBuffer instanceof Map)) {
        if (pollState.voteBuffer && typeof pollState.voteBuffer === 'object') {
          if (pollState.voteBuffer.__type === 'Map' && Array.isArray(pollState.voteBuffer.entries)) {
            pollState.voteBuffer = new Map(pollState.voteBuffer.entries);
          } else {
            pollState.voteBuffer = new Map(Object.entries(pollState.voteBuffer));
          }
        } else {
          pollState.voteBuffer = new Map();
        }
      }
      if (!Array.isArray(pollState.sentReminders)) {
        pollState.sentReminders = [];
      }
    }

    return {
      messageStore,
      activePolls,
      latestPollIdByChat
    };
  } catch (err) {
    console.error('⚠️ Failed to load poll state, starting fresh:', err.message);
    return empty();
  }
}

module.exports = {
  save,
  load,
  POLL_STATE_FILE
};
