/**
 * Persists poll state (message store, active polls, latest-poll-per-chat)
 * to a local JSON file so polls survive a bot restart.
 *
 * This is trickier than the availability/leaderboard storage because poll
 * state includes:
 *   - JS Maps (voteBuffer per poll, and the top-level stores themselves),
 *     which don't serialize with plain JSON.
 *   - Raw WhatsApp proto message objects (the poll creation message, and
 *     buffered vote entries), which contain binary fields as Buffer or
 *     Uint8Array instances that JSON.stringify mangles by default.
 *
 * The replacer/reviver pair below handles both generically: any Map is
 * tagged and rebuilt as a Map, and any Uint8Array (including Buffer, which
 * is a Uint8Array subclass) is base64-encoded and rebuilt as a Buffer.
 *
 * Caveat: after reloading, proto message objects come back as plain JS
 * objects with the same fields, not real protobufjs class instances. This
 * works for what this bot needs (getAggregateVotesInPollMessage and the
 * getMessage lookup mainly just read plain fields), but if a Baileys
 * version relies on class-instance methods for some poll-related internal
 * operation, restored-after-restart polls could behave subtly differently
 * from ones created in the current process. Worth knowing if something
 * looks off specifically after a restart.
 */

const fs = require('fs');
const path = require('path');

const POLL_STATE_FILE = path.join(__dirname, '..', 'poll-state.json');

function replacer(key, value) {
  if (value instanceof Map) {
    return { __type: 'Map', entries: [...value.entries()] };
  }
  if (value instanceof Uint8Array) {
    // Plain Uint8Array (e.g. protobuf byte fields). Real Buffer instances
    // are converted to {type:'Buffer', data:[...]} by their own toJSON
    // before this replacer ever sees them -- handled in the reviver below.
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

function save({ messageStore, activePolls, latestPollIdByChat, knownNames, lidToPn, pnToLid }) {
  try {
    const payload = { messageStore, activePolls, latestPollIdByChat, knownNames, lidToPn, pnToLid };
    fs.writeFileSync(POLL_STATE_FILE, JSON.stringify(payload, replacer));
  } catch (err) {
    console.error('⚠️  Failed to save poll state:', err.message);
  }
}

function load() {
  const empty = () => ({
    messageStore: new Map(),
    activePolls: new Map(),
    latestPollIdByChat: new Map(),
    knownNames: new Map(),
    lidToPn: new Map(),
    pnToLid: new Map()
  });

  if (!fs.existsSync(POLL_STATE_FILE)) return empty();

  try {
    const raw = fs.readFileSync(POLL_STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw, reviver);
    const messageStore = parsed.messageStore instanceof Map ? parsed.messageStore : new Map();
    const activePolls = parsed.activePolls instanceof Map ? parsed.activePolls : new Map();
    const latestPollIdByChat = parsed.latestPollIdByChat instanceof Map ? parsed.latestPollIdByChat : new Map();
    const knownNames = parsed.knownNames instanceof Map ? parsed.knownNames : (parsed.knownNames ? new Map(Object.entries(parsed.knownNames)) : new Map());
    const lidToPn = parsed.lidToPn instanceof Map ? parsed.lidToPn : (parsed.lidToPn ? new Map(Object.entries(parsed.lidToPn)) : new Map());
    const pnToLid = parsed.pnToLid instanceof Map ? parsed.pnToLid : (parsed.pnToLid ? new Map(Object.entries(parsed.pnToLid)) : new Map());

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
      latestPollIdByChat,
      knownNames,
      lidToPn,
      pnToLid
    };
  } catch (err) {
    console.error('⚠️  Failed to load poll state, starting fresh:', err.message);
    return empty();
  }
}

module.exports = { save, load, POLL_STATE_FILE };
