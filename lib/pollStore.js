/**
 * Persists poll state (message store, active polls, latest-poll-per-chat, recurring polls)
 * to separate local JSON files per group so polls survive a bot restart with complete group isolation.
 */

const fs = require('fs');
const path = require('path');

const POLL_STATES_DIR = path.join(__dirname, '..', 'poll-states');

// In-memory set of known chat IDs that have been loaded or saved
const knownGroupChatIds = new Set();

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

function ensurePollStatesDir() {
  if (!fs.existsSync(POLL_STATES_DIR)) {
    fs.mkdirSync(POLL_STATES_DIR, { recursive: true });
  }
}

function sanitizeChatId(chatId) {
  if (!chatId || typeof chatId !== 'string') return 'default';
  return chatId.replace(/[/\\:*?"<>|]/g, '_').trim();
}

function getGroupFileName(chatId) {
  const safeId = sanitizeChatId(chatId);
  return `poll-state-${safeId}.json`;
}

function getGroupFilePath(chatId) {
  return path.join(POLL_STATES_DIR, getGroupFileName(chatId));
}

function inferChatIdFromFileName(fileName) {
  if (!fileName || !fileName.endsWith('.json')) return null;
  const base = fileName.slice(0, -5);
  if (base.startsWith('poll-state-')) {
    return base.slice('poll-state-'.length);
  }
  return base;
}

/**
 * Partitions in-memory state into per-group buckets.
 */
function partitionByGroup({ messageStore, activePolls, latestPollIdByChat, recurringPolls }) {
  const groups = new Map();

  function getGroupBucket(chatId) {
    const id = chatId || 'default';
    if (!groups.has(id)) {
      groups.set(id, {
        messageStore: new Map(),
        activePolls: new Map(),
        latestPollIdByChat: new Map(),
        recurringPolls: new Map()
      });
    }
    return groups.get(id);
  }

  // 1. activePolls: key is pollId, val.remoteJid is chatId
  if (activePolls instanceof Map) {
    for (const [pollId, pollState] of activePolls.entries()) {
      const bucket = getGroupBucket(pollState?.remoteJid);
      bucket.activePolls.set(pollId, pollState);
    }
  }

  // 2. latestPollIdByChat: key is chatId, val is pollId
  if (latestPollIdByChat instanceof Map) {
    for (const [chatId, pollId] of latestPollIdByChat.entries()) {
      const bucket = getGroupBucket(chatId);
      bucket.latestPollIdByChat.set(chatId, pollId);
    }
  }

  // 3. recurringPolls: key is schedId, val.remoteJid is chatId
  if (recurringPolls instanceof Map) {
    for (const [schedId, sched] of recurringPolls.entries()) {
      const bucket = getGroupBucket(sched?.remoteJid);
      bucket.recurringPolls.set(schedId, sched);
    }
  }

  // 4. messageStore: key is `${remoteJid}:${id}`
  if (messageStore instanceof Map) {
    for (const [key, msg] of messageStore.entries()) {
      const remoteJid = key.includes(':') ? key.slice(0, key.indexOf(':')) : 'default';
      const bucket = getGroupBucket(remoteJid);
      bucket.messageStore.set(key, msg);
    }
  }

  return groups;
}

function sanitizeActivePolls(activePolls) {
  if (!(activePolls instanceof Map)) return;
  for (const [, pollState] of activePolls.entries()) {
    if (!pollState || typeof pollState !== 'object') continue;
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
}

function parsePollStateContent(raw) {
  if (!raw || !raw.trim()) {
    return {
      chatId: null,
      messageStore: new Map(),
      activePolls: new Map(),
      latestPollIdByChat: new Map(),
      recurringPolls: new Map()
    };
  }
  const parsed = JSON.parse(raw, reviver);
  const messageStore = parsed.messageStore instanceof Map ? parsed.messageStore : new Map();
  const activePolls = parsed.activePolls instanceof Map ? parsed.activePolls : new Map();
  const latestPollIdByChat = parsed.latestPollIdByChat instanceof Map ? parsed.latestPollIdByChat : new Map();
  const recurringPolls = parsed.recurringPolls instanceof Map
    ? parsed.recurringPolls
    : (parsed.recurringPolls && typeof parsed.recurringPolls === 'object'
      ? new Map(Object.entries(parsed.recurringPolls))
      : new Map());

  sanitizeActivePolls(activePolls);

  return {
    chatId: parsed.chatId || null,
    messageStore,
    activePolls,
    latestPollIdByChat,
    recurringPolls
  };
}

function mergeInto(target, source) {
  if (source.messageStore instanceof Map) {
    for (const [k, v] of source.messageStore.entries()) {
      target.messageStore.set(k, v);
    }
  }
  if (source.activePolls instanceof Map) {
    for (const [k, v] of source.activePolls.entries()) {
      target.activePolls.set(k, v);
    }
  }
  if (source.latestPollIdByChat instanceof Map) {
    for (const [k, v] of source.latestPollIdByChat.entries()) {
      target.latestPollIdByChat.set(k, v);
    }
  }
  if (source.recurringPolls instanceof Map) {
    for (const [k, v] of source.recurringPolls.entries()) {
      target.recurringPolls.set(k, v);
    }
  }
}

function saveGroupFile(chatId, bucket) {
  try {
    ensurePollStatesDir();
    const filePath = getGroupFilePath(chatId);
    const payload = {
      chatId,
      updatedAt: new Date().toISOString(),
      messageStore: bucket.messageStore,
      activePolls: bucket.activePolls,
      latestPollIdByChat: bucket.latestPollIdByChat,
      recurringPolls: bucket.recurringPolls
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, replacer, 2));
  } catch (err) {
    console.error(`⚠️ Failed to save group poll state for ${chatId}:`, err.message);
  }
}

/**
 * Saves poll state.
 * If targetChatId is provided, saves only that group's file.
 * Otherwise partitions across all groups and updates each group's file.
 */
function save({ messageStore, activePolls, latestPollIdByChat, recurringPolls }, targetChatId = null) {
  ensurePollStatesDir();
  try {
    const partitioned = partitionByGroup({ messageStore, activePolls, latestPollIdByChat, recurringPolls });

    if (targetChatId) {
      knownGroupChatIds.add(targetChatId);
      const bucket = partitioned.get(targetChatId) || {
        messageStore: new Map(),
        activePolls: new Map(),
        latestPollIdByChat: new Map(),
        recurringPolls: new Map()
      };
      saveGroupFile(targetChatId, bucket);
      return;
    }

    const allChatIds = new Set([...knownGroupChatIds, ...partitioned.keys()]);
    try {
      const files = fs.readdirSync(POLL_STATES_DIR).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const id = inferChatIdFromFileName(file);
        if (id) allChatIds.add(id);
      }
    } catch (e) {}

    for (const chatId of allChatIds) {
      knownGroupChatIds.add(chatId);
      const bucket = partitioned.get(chatId) || {
        messageStore: new Map(),
        activePolls: new Map(),
        latestPollIdByChat: new Map(),
        recurringPolls: new Map()
      };
      saveGroupFile(chatId, bucket);
    }
  } catch (err) {
    console.error('⚠️ Failed to save poll state:', err.message);
  }
}

/**
 * Loads all group poll state files from poll-states/ and merges them.
 */
function load() {
  const merged = {
    messageStore: new Map(),
    activePolls: new Map(),
    latestPollIdByChat: new Map(),
    recurringPolls: new Map()
  };

  ensurePollStatesDir();


  try {
    const files = fs.readdirSync(POLL_STATES_DIR).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(POLL_STATES_DIR, file);
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = parsePollStateContent(raw);
        mergeInto(merged, data);
        const resolvedChatId = data.chatId || inferChatIdFromFileName(file);
        if (resolvedChatId) {
          knownGroupChatIds.add(resolvedChatId);
        }
      } catch (err) {
        console.error(`⚠️ Failed to load poll state file ${file}:`, err.message);
      }
    }
  } catch (err) {
    console.error('⚠️ Failed to read poll-states directory:', err.message);
  }

  sanitizeActivePolls(merged.activePolls);


  return merged;
}

function loadGroup(chatId) {
  const filePath = getGroupFilePath(chatId);
  if (!fs.existsSync(filePath)) {
    return {
      chatId,
      messageStore: new Map(),
      activePolls: new Map(),
      latestPollIdByChat: new Map(),
      recurringPolls: new Map()
    };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return parsePollStateContent(raw);
  } catch (err) {
    console.error(`⚠️ Failed to load poll state for group ${chatId}:`, err.message);
    return {
      chatId,
      messageStore: new Map(),
      activePolls: new Map(),
      latestPollIdByChat: new Map(),
      recurringPolls: new Map()
    };
  }
}

module.exports = {
  save,
  load,
  loadGroup,
  saveGroupFile,
  getGroupFilePath,
  getGroupFileName,
  sanitizeChatId,
  POLL_STATES_DIR
};
