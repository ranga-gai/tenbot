/**
 * Persists poll state (message store, active polls, latest-poll-per-chat, recurring polls)
 * into separate subfolders per group, separating recurring polls into recurring.json,
 * and individual poll instances into polls/<pollId>.json.
 *
 * Directory structure:
 * data/poll-states/<chatId>/
 *   ├── meta.json         # latestPollIdByChat and metadata
 *   ├── recurring.json    # standing recurring poll schedules
 *   ├── messages.jsonl    # optional extra/orphaned messages (retained up to 14 days)
 *   └── polls/
 *       ├── <pollId>.json # poll instance state + creation message payload
 *       └── ...
 */

const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('./paths');
const { formatLookAround } = require('./pollTime');
const POLL_STATES_DIR = path.join(DATA_DIR, 'poll-states');

// Extra/orphaned messages retention window (14 days)
const MESSAGE_RETENTION_DAYS = 14;
const MESSAGE_RETENTION_MS = MESSAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

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
    if (value.__type === 'Uint8Array') return Buffer.from(value.base64, 'base64');
    if (value.type === 'Buffer' && Array.isArray(value.data)) return Buffer.from(value.data);
  }
  return value;
}

function ensurePollStatesDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(POLL_STATES_DIR)) {
    fs.mkdirSync(POLL_STATES_DIR, { recursive: true });
  }
}

function sanitizeChatId(chatId) {
  if (!chatId || typeof chatId !== 'string') return 'default';
  return chatId.replace(/[/\\:*?"<>|]/g, '_').trim();
}

function getGroupDir(chatId) {
  const safeId = sanitizeChatId(chatId);
  return path.join(POLL_STATES_DIR, safeId);
}

function getGroupPollsDir(chatId) {
  return path.join(getGroupDir(chatId), 'polls');
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

function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
  const json = JSON.stringify(data, replacer, 2);
  fs.writeFileSync(tempPath, json, 'utf-8');
  fs.renameSync(tempPath, filePath);
}

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw || !raw.trim()) return null;
    return JSON.parse(raw, reviver);
  } catch (err) {
    console.error(`⚠️ Failed to parse JSON file ${filePath}:`, err.message);
    return null;
  }
}

/**
 * Extracts a numeric timestamp in milliseconds from a message object.
 */
function getMessageTimestampMs(msg, fallbackMs = Date.now()) {
  if (!msg) return fallbackMs;
  let ts = msg.messageTimestamp ?? msg.timestamp;
  if (typeof ts === 'object' && ts !== null && typeof ts.low === 'number') {
    ts = ts.low;
  }
  const n = Number(ts);
  if (Number.isFinite(n) && n > 0) {
    return n < 1e11 ? n * 1000 : n;
  }
  return fallbackMs;
}

/**
 * Atomically writes an array of records to a JSON Lines (.jsonl) file.
 */
function atomicWriteJsonLines(filePath, items) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
  const content = items.map((item) => JSON.stringify(item, replacer)).join('\n') + '\n';
  fs.writeFileSync(tempPath, content, 'utf-8');
  fs.renameSync(tempPath, filePath);
}

/**
 * Safely reads a JSON Lines (.jsonl) file into an array of objects.
 */
function readJsonLinesSafe(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw || !raw.trim()) return [];
    const lines = raw.split('\n');
    const items = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        items.push(JSON.parse(trimmed, reviver));
      } catch (_) {}
    }
    return items;
  } catch (err) {
    console.error(`⚠️ Failed to parse JSONL file ${filePath}:`, err.message);
    return [];
  }
}

/**
 * Loads extra/orphaned messages from messages.jsonl (or legacy messages.json),
 * pruning any messages older than MESSAGE_RETENTION_DAYS (14 days).
 */
function loadExtraMessages(groupDir, now = Date.now()) {
  const cutoff = now - MESSAGE_RETENTION_MS;
  const jsonlPath = path.join(groupDir, 'messages.jsonl');
  const legacyJsonPath = path.join(groupDir, 'messages.json');
  const messages = new Map();

  if (fs.existsSync(jsonlPath)) {
    const items = readJsonLinesSafe(jsonlPath);
    for (const item of items) {
      if (!item || !item.key) continue;
      const ts = item.timestamp || getMessageTimestampMs(item.message || item.msg, now);
      if (ts >= cutoff) {
        messages.set(item.key, item.message || item.msg || item);
      }
    }
    // Clean up legacy messages.json if present
    if (fs.existsSync(legacyJsonPath)) {
      try { fs.unlinkSync(legacyJsonPath); } catch (_) {}
    }
  } else if (fs.existsSync(legacyJsonPath)) {
    const msgData = readJsonSafe(legacyJsonPath);
    let msgMap = null;
    if (msgData?.messageStore instanceof Map) {
      msgMap = msgData.messageStore;
    } else if (msgData?.messageStore && typeof msgData.messageStore === 'object') {
      msgMap = new Map(Object.entries(msgData.messageStore));
    } else if (msgData instanceof Map) {
      msgMap = msgData;
    }
    if (msgMap) {
      for (const [k, v] of msgMap.entries()) {
        const ts = getMessageTimestampMs(v, now);
        if (ts >= cutoff) {
          messages.set(k, v);
        }
      }
    }
  }

  return messages;
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

/**
 * Migrates polls and recurring schedules using legacy matchup flags (noMatchups / autoMatchups)
 * to the newer lineup generation configuration options (lineupGeneration, lineupLeadTime, manualLineupPosted).
 * Returns the number of items migrated.
 */
function migratePollMatchupOptions({ activePolls, recurringPolls } = {}) {
  let migratedCount = 0;

  if (activePolls instanceof Map) {
    for (const [, pollState] of activePolls.entries()) {
      if (!pollState || typeof pollState !== 'object') continue;
      let changed = false;

      if (!pollState.lineupGeneration) {
        if (pollState.isManual || pollState.noMatchups === true || pollState.autoMatchups === false) {
          pollState.lineupGeneration = 'none';
        } else {
          pollState.lineupGeneration = 'filled';
        }
        changed = true;
      }

      if (pollState.lineupLeadTime === undefined || pollState.lineupLeadTime === null) {
        pollState.lineupLeadTime = 30;
        changed = true;
      }

      if (!pollState.lineupLeadTimeDisplay) {
        pollState.lineupLeadTimeDisplay = formatLookAround(pollState.lineupLeadTime) || `${pollState.lineupLeadTime} mins`;
        changed = true;
      }

      if (pollState.manualLineupPosted === undefined) {
        pollState.manualLineupPosted = false;
        changed = true;
      }

      if (pollState.lineupReminderSent === undefined) {
        pollState.lineupReminderSent = false;
        changed = true;
      }

      // Remove legacy matchups flags
      if (pollState.noMatchups !== undefined || pollState.autoMatchups !== undefined) {
        delete pollState.noMatchups;
        delete pollState.autoMatchups;
        changed = true;
      }

      if (changed) migratedCount++;
    }
  }

  if (recurringPolls instanceof Map) {
    for (const [, sched] of recurringPolls.entries()) {
      if (!sched || typeof sched !== 'object') continue;
      let changed = false;

      if (!sched.lineupGeneration) {
        if (sched.noMatchups === true || sched.autoMatchups === false) {
          sched.lineupGeneration = 'none';
        } else {
          sched.lineupGeneration = 'filled';
        }
        changed = true;
      }

      if (sched.lineupLeadTime === undefined || sched.lineupLeadTime === null) {
        sched.lineupLeadTime = 30;
        changed = true;
      }

      // Remove legacy matchups flags
      if (sched.noMatchups !== undefined || sched.autoMatchups !== undefined) {
        delete sched.noMatchups;
        delete sched.autoMatchups;
        changed = true;
      }

      if (changed) migratedCount++;
    }
  }

  return migratedCount;
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
    if (pollState.reminders === undefined) {
      if (pollState.remindersPaused !== undefined) {
        pollState.reminders = !pollState.remindersPaused;
        delete pollState.remindersPaused;
      } else {
        pollState.reminders = true;
      }
    } else if (pollState.remindersPaused !== undefined) {
      delete pollState.remindersPaused;
    }

    // Ensure court booking arrays backward compatibility
    if (!Array.isArray(pollState.autoBookedCourts) && Array.isArray(pollState.advanceBookedCourts)) {
      pollState.autoBookedCourts = pollState.advanceBookedCourts;
    }
    if (!Array.isArray(pollState.advanceBookedCourts) && Array.isArray(pollState.autoBookedCourts)) {
      pollState.advanceBookedCourts = pollState.autoBookedCourts;
    }
    if (!Array.isArray(pollState.manuallyBookedCourts) && Array.isArray(pollState.prebookedCourts)) {
      const autoNames = new Set((pollState.autoBookedCourts || []).map(b => (b.court || '').toLowerCase().trim()));
      pollState.manuallyBookedCourts = pollState.prebookedCourts
        .filter(pb => !autoNames.has((pb.court || '').toLowerCase().trim()))
        .map(pb => ({
          court: pb.court,
          time: pb.time || null,
          players: pb.players || (pb.fullName ? pb.fullName.split(/[,;&+]|\band\b/i).map(s => s.trim()).filter(Boolean) : (pb.player ? [pb.player] : []))
        }));
    }
  }
}

function sanitizeRecurringPolls(recurringPolls) {
  if (!(recurringPolls instanceof Map)) return;
  for (const [, sched] of recurringPolls.entries()) {
    if (!sched || typeof sched !== 'object') continue;
    if (sched.reminders === undefined) {
      sched.reminders = true;
    }
    if (sched.advanceBookings && typeof sched.advanceBookings === 'object') {
      for (const [, entry] of Object.entries(sched.advanceBookings)) {
        if (!entry || typeof entry !== 'object') continue;
        if (!Array.isArray(entry.autoBookedCourts) && Array.isArray(entry.advanceBookedCourts)) {
          entry.autoBookedCourts = entry.advanceBookedCourts;
        }
        if (!Array.isArray(entry.advanceBookedCourts) && Array.isArray(entry.autoBookedCourts)) {
          entry.advanceBookedCourts = entry.autoBookedCourts;
        }
      }
    }
  }
}

function parseLegacyPollStateContent(raw) {
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
  sanitizeRecurringPolls(recurringPolls);

  return {
    chatId: parsed.chatId || null,
    messageStore,
    activePolls,
    latestPollIdByChat,
    recurringPolls
  };
}

/**
 * Saves state for a specific group into its subfolder:
 * data/poll-states/<chatId>/
 *   ├── meta.json
 *   ├── recurring.json
 *   ├── messages.jsonl (if extra messages exist, retained up to 14 days)
 *   └── polls/<pollId>.json
 */
function saveGroup(chatId, bucket) {
  try {
    ensurePollStatesDir();
    const groupDir = getGroupDir(chatId);
    const pollsDir = getGroupPollsDir(chatId);

    if (!fs.existsSync(pollsDir)) {
      fs.mkdirSync(pollsDir, { recursive: true });
    }

    // 1. meta.json
    const latestPollId = bucket.latestPollIdByChat ? bucket.latestPollIdByChat.get(chatId) : null;
    const metaPayload = {
      chatId,
      updatedAt: new Date().toISOString(),
      latestPollId: latestPollId || null
    };
    atomicWriteJson(path.join(groupDir, 'meta.json'), metaPayload);

    // 2. recurring.json
    const recurringPayload = {
      chatId,
      updatedAt: new Date().toISOString(),
      recurringPolls: bucket.recurringPolls || new Map()
    };
    atomicWriteJson(path.join(groupDir, 'recurring.json'), recurringPayload);

    // 3. polls/<pollId>.json
    const activePollIds = new Set();
    const handledMessageKeys = new Set();

    if (bucket.activePolls instanceof Map) {
      for (const [pollId, pollState] of bucket.activePolls.entries()) {
        activePollIds.add(String(pollId));
        const safePollId = sanitizeChatId(pollId);
        const pollFilePath = path.join(pollsDir, `${safePollId}.json`);

        // Find associated creationMessage in messageStore
        let creationMessage = null;
        const directKey = `${pollState?.remoteJid || chatId}:${pollId}`;
        if (bucket.messageStore && bucket.messageStore.has(directKey)) {
          creationMessage = bucket.messageStore.get(directKey);
          handledMessageKeys.add(directKey);
        } else if (bucket.messageStore) {
          for (const [k, v] of bucket.messageStore.entries()) {
            if (k.endsWith(`:${pollId}`)) {
              creationMessage = v;
              handledMessageKeys.add(k);
              break;
            }
          }
        }

        const pollPayload = {
          pollId,
          chatId,
          updatedAt: new Date().toISOString(),
          pollState,
          creationMessage
        };
        atomicWriteJson(pollFilePath, pollPayload);
      }
    }

    // Remove any stale poll files in polls/ that are no longer in activePolls
    try {
      const existingPollFiles = fs.readdirSync(pollsDir).filter((f) => f.endsWith('.json'));
      for (const file of existingPollFiles) {
        const filePath = path.join(pollsDir, file);
        try {
          const pollData = readJsonSafe(filePath);
          const pId = pollData?.pollId || file.slice(0, -5);
          if (!activePollIds.has(String(pId))) {
            fs.unlinkSync(filePath);
          }
        } catch (_) {}
      }
    } catch (_) {}

    // 4. messages.jsonl (for any messages not attached to active polls, retained up to 14 days)
    const extraMessages = [];
    const now = Date.now();
    const cutoff = now - MESSAGE_RETENTION_MS;

    if (bucket.messageStore instanceof Map) {
      for (const [k, v] of bucket.messageStore.entries()) {
        if (!handledMessageKeys.has(k)) {
          const ts = getMessageTimestampMs(v, now);
          if (ts >= cutoff) {
            extraMessages.push({
              key: k,
              date: new Date(ts).toISOString(),
              timestamp: ts,
              message: v
            });
          } else {
            // Prune expired non-poll messages from memory
            bucket.messageStore.delete(k);
          }
        }
      }
    }

    const messagesJsonlPath = path.join(groupDir, 'messages.jsonl');
    const legacyMessagesJsonPath = path.join(groupDir, 'messages.json');

    if (extraMessages.length > 0) {
      atomicWriteJsonLines(messagesJsonlPath, extraMessages);
      if (fs.existsSync(legacyMessagesJsonPath)) {
        try { fs.unlinkSync(legacyMessagesJsonPath); } catch (_) {}
      }
    } else {
      if (fs.existsSync(messagesJsonlPath)) {
        try { fs.unlinkSync(messagesJsonlPath); } catch (_) {}
      }
      if (fs.existsSync(legacyMessagesJsonPath)) {
        try { fs.unlinkSync(legacyMessagesJsonPath); } catch (_) {}
      }
    }
  } catch (err) {
    console.error(`⚠️ Failed to save group poll state for ${chatId}:`, err.message);
  }
}

function saveGroupFile(chatId, bucket) {
  return saveGroup(chatId, bucket);
}

/**
 * Saves poll state.
 * If targetChatId is provided, saves only that group subfolder.
 * Otherwise partitions across all groups and updates each group subfolder.
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
      saveGroup(targetChatId, bucket);
      return;
    }

    const allChatIds = new Set([...knownGroupChatIds, ...partitioned.keys()]);
    try {
      const items = fs.readdirSync(POLL_STATES_DIR);
      for (const item of items) {
        const itemPath = path.join(POLL_STATES_DIR, item);
        try {
          if (fs.statSync(itemPath).isDirectory()) {
            allChatIds.add(item);
          } else if (item.endsWith('.json')) {
            const id = inferChatIdFromFileName(item);
            if (id) allChatIds.add(id);
          }
        } catch (_) {}
      }
    } catch (_) {}

    for (const chatId of allChatIds) {
      knownGroupChatIds.add(chatId);
      const bucket = partitioned.get(chatId) || {
        messageStore: new Map(),
        activePolls: new Map(),
        latestPollIdByChat: new Map(),
        recurringPolls: new Map()
      };
      saveGroup(chatId, bucket);
    }
  } catch (err) {
    console.error('⚠️ Failed to save poll state:', err.message);
  }
}

/**
 * Loads a single group state from its subfolder:
 * data/poll-states/<chatId>/
 */
function loadGroup(chatId) {
  const safeChatId = sanitizeChatId(chatId);
  const groupDir = getGroupDir(chatId);
  const legacyFile = getGroupFilePath(chatId);

  // Auto-migrate legacy file if it exists and directory does not exist
  if (fs.existsSync(legacyFile) && !fs.existsSync(groupDir)) {
    try {
      const raw = fs.readFileSync(legacyFile, 'utf-8');
      const parsed = parseLegacyPollStateContent(raw);
      saveGroup(chatId, parsed);
      try {
        fs.unlinkSync(legacyFile);
      } catch (_) {}
    } catch (e) {
      console.error(`Failed to migrate legacy poll state for ${chatId}:`, e.message);
    }
  }

  const result = {
    chatId,
    messageStore: new Map(),
    activePolls: new Map(),
    latestPollIdByChat: new Map(),
    recurringPolls: new Map()
  };

  if (!fs.existsSync(groupDir)) {
    return result;
  }

  try {
    // 1. meta.json
    const meta = readJsonSafe(path.join(groupDir, 'meta.json'));
    if (meta && meta.latestPollId) {
      result.latestPollIdByChat.set(chatId, meta.latestPollId);
    }

    // 2. recurring.json
    const recData = readJsonSafe(path.join(groupDir, 'recurring.json'));
    let recMap = null;
    if (recData?.recurringPolls instanceof Map) {
      recMap = recData.recurringPolls;
    } else if (recData?.recurringPolls && typeof recData.recurringPolls === 'object') {
      recMap = new Map(Object.entries(recData.recurringPolls));
    } else if (recData instanceof Map) {
      recMap = recData;
    }
    if (recMap) {
      for (const [k, v] of recMap.entries()) {
        result.recurringPolls.set(k, v);
      }
    }

    // 3. messages.jsonl (or fallback legacy messages.json) with 14-day cutoff
    const extraMessages = loadExtraMessages(groupDir);
    for (const [k, v] of extraMessages.entries()) {
      result.messageStore.set(k, v);
    }

    // 4. polls/
    const pollsDir = getGroupPollsDir(chatId);
    if (fs.existsSync(pollsDir)) {
      const pollFiles = fs.readdirSync(pollsDir).filter((f) => f.endsWith('.json'));
      for (const file of pollFiles) {
        try {
          const pollData = readJsonSafe(path.join(pollsDir, file));
          if (pollData) {
            const pollState = pollData.pollState || pollData;
            const pId = pollData.pollId || pollState.id || file.slice(0, -5);
            result.activePolls.set(pId, pollState);
            if (pollData.creationMessage) {
              const rJid = pollState.remoteJid || chatId;
              result.messageStore.set(`${rJid}:${pId}`, pollData.creationMessage);
            }
          }
        } catch (pollErr) {
          console.error(`Failed to load poll file ${file} in ${chatId}:`, pollErr.message);
        }
      }
    }

    // If latestPollId was not in meta.json, deduce it from activePolls
    if (!result.latestPollIdByChat.has(chatId) && result.activePolls.size > 0) {
      let latestId = null;
      let latestTime = 0;
      for (const [id, state] of result.activePolls.entries()) {
        const t = state.createdAt ? new Date(state.createdAt).getTime() : 0;
        if (t >= latestTime) {
          latestTime = t;
          latestId = id;
        }
      }
      if (latestId) {
        result.latestPollIdByChat.set(chatId, latestId);
      }
    }

    sanitizeActivePolls(result.activePolls);
    sanitizeRecurringPolls(result.recurringPolls);

    const count = migratePollMatchupOptions(result);
    if (count > 0) {
      saveGroup(chatId, result);
    }
  } catch (err) {
    console.error(`⚠️ Failed to load poll state for group ${chatId}:`, err.message);
  }

  return result;
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

/**
 * Loads all poll states across all known group subfolders.
 */
function load() {
  ensurePollStatesDir();
  const merged = {
    chatId: null,
    messageStore: new Map(),
    activePolls: new Map(),
    latestPollIdByChat: new Map(),
    recurringPolls: new Map()
  };

  try {
    const items = fs.readdirSync(POLL_STATES_DIR);
    for (const item of items) {
      const itemPath = path.join(POLL_STATES_DIR, item);
      try {
        if (fs.statSync(itemPath).isDirectory()) {
          knownGroupChatIds.add(item);
          const groupState = loadGroup(item);
          mergeInto(merged, groupState);
        } else if (item.endsWith('.json')) {
          const chatId = inferChatIdFromFileName(item);
          if (chatId) {
            knownGroupChatIds.add(chatId);
            const groupState = loadGroup(chatId);
            mergeInto(merged, groupState);
          }
        }
      } catch (loadErr) {
        console.error(`⚠️ Failed to load group state folder ${item}:`, loadErr.message);
      }
    }
  } catch (err) {
    console.error('⚠️ Failed to read poll-states directory:', err.message);
  }

  sanitizeActivePolls(merged.activePolls);
  sanitizeRecurringPolls(merged.recurringPolls);
  const migratedCount = migratePollMatchupOptions(merged);
  if (migratedCount > 0) {
    console.log(`[pollStore] Migrated ${migratedCount} poll(s)/schedule(s) to new lineup generation options`);
    save(merged);
  }

  return merged;
}

module.exports = {
  save,
  load,
  loadGroup,
  migratePollMatchupOptions,
  sanitizeActivePolls,
  sanitizeRecurringPolls,
  saveGroupFile,
  saveGroup,
  getGroupDir,
  getGroupPollsDir,
  getGroupFilePath,
  getGroupFileName,
  atomicWriteJson,
  readJsonSafe,
  atomicWriteJsonLines,
  readJsonLinesSafe,
  getMessageTimestampMs,
  loadExtraMessages,
  MESSAGE_RETENTION_DAYS,
  sanitizeChatId,
  DATA_DIR,
  POLL_STATES_DIR
};
