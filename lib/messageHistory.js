/**
 * Persistent message history tracker: records group chat messages over a rolling
 * 2-week window (14 days) so Claude has full conversational context of all recent
 * group banter, discussions, availability remarks, and questions.
 *
 * Stored as Append-Only JSON Lines (.jsonl) per group/chat:
 * data/chat-history/<chatId>.jsonl
 *
 * Each message append is a true O(1) append to the file. Pruning (>14 days)
 * runs on a daily basis in a background sweep, rather than on every
 * single incoming message.
 */

const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('./paths');
const CHAT_HISTORY_DIR = path.join(DATA_DIR, 'chat-history');
const LEGACY_HISTORY_FILE = path.join(DATA_DIR, 'chat-history.json');
const HISTORY_FILE = LEGACY_HISTORY_FILE; // Backward compatibility alias
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// In-memory cache of loaded/recorded chat histories: chatId -> Array<Message>
const chatMemoryCache = new Map();
let lastDailyPruneTimestamp = Date.now();

function ensureHistoryDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(CHAT_HISTORY_DIR)) {
    fs.mkdirSync(CHAT_HISTORY_DIR, { recursive: true });
  }
}

function sanitizeChatId(chatId) {
  if (!chatId || typeof chatId !== 'string') return 'default';
  return chatId.replace(/[/\\:*?"<>|]/g, '_').trim();
}

function getChatFileName(chatId) {
  const safeId = sanitizeChatId(chatId);
  return `${safeId}.jsonl`;
}

function getChatFilePath(chatId) {
  return path.join(CHAT_HISTORY_DIR, getChatFileName(chatId));
}

function getLegacyJsonFilePath(chatId) {
  const safeId = sanitizeChatId(chatId);
  return path.join(CHAT_HISTORY_DIR, `${safeId}.json`);
}

function parseJsonLines(content) {
  if (!content || !content.trim()) return [];
  const lines = content.split('\n');
  const messages = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed);
      if (msg && typeof msg === 'object') {
        messages.push(msg);
      }
    } catch (_) {}
  }
  return messages;
}

function formatJsonLines(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  return messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
}

function atomicWriteJsonLines(filePath, messages) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
  const content = formatJsonLines(messages);
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function appendJsonLine(filePath, message) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const line = JSON.stringify(message) + '\n';
  fs.appendFileSync(filePath, line, 'utf8');
}

/**
 * Migrates any legacy .json files to .jsonl
 */
function migrateAllLegacyFiles() {
  ensureHistoryDir();

  // 1. Migrate monolithic chat-history.json if present
  if (fs.existsSync(LEGACY_HISTORY_FILE)) {
    try {
      const raw = fs.readFileSync(LEGACY_HISTORY_FILE, 'utf8');
      if (raw && raw.trim()) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const chatIds = Object.keys(parsed);
          console.log(`[messageHistory] Migrating legacy monolithic chat-history.json (${chatIds.length} chat(s)) to .jsonl`);
          for (const chatId of chatIds) {
            const list = Array.isArray(parsed[chatId]) ? parsed[chatId] : [];
            if (list.length > 0) {
              atomicWriteJsonLines(getChatFilePath(chatId), list);
            }
          }
        }
      }
      try {
        fs.unlinkSync(LEGACY_HISTORY_FILE);
      } catch (_) {}
    } catch (err) {
      console.error('⚠️ Failed to migrate legacy chat-history.json:', err.message);
    }
  }

  // 2. Migrate any .json files in chat-history/ to .jsonl
  try {
    const files = fs.readdirSync(CHAT_HISTORY_DIR).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      const legacyPath = path.join(CHAT_HISTORY_DIR, f);
      const chatId = f.slice(0, -5);
      const jsonlPath = getChatFilePath(chatId);
      try {
        const raw = fs.readFileSync(legacyPath, 'utf8');
        if (raw && raw.trim()) {
          const parsed = JSON.parse(raw);
          const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.messages) ? parsed.messages : []);
          if (list.length > 0 && !fs.existsSync(jsonlPath)) {
            atomicWriteJsonLines(jsonlPath, list);
          }
        }
        try {
          fs.unlinkSync(legacyPath);
        } catch (_) {}
      } catch (err) {
        console.error(`⚠️ Failed to migrate legacy JSON file ${f}:`, err.message);
      }
    }
  } catch (_) {}
}

function loadChatFile(chatId) {
  if (!chatId) return [];
  if (chatMemoryCache.has(chatId)) {
    return chatMemoryCache.get(chatId);
  }

  ensureHistoryDir();
  const jsonlPath = getChatFilePath(chatId);
  const legacyJsonPath = getLegacyJsonFilePath(chatId);

  // If legacy .json exists and .jsonl does not, migrate it
  if (fs.existsSync(legacyJsonPath) && !fs.existsSync(jsonlPath)) {
    try {
      const raw = fs.readFileSync(legacyJsonPath, 'utf8');
      if (raw && raw.trim()) {
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.messages) ? parsed.messages : []);
        atomicWriteJsonLines(jsonlPath, list);
      }
      try {
        fs.unlinkSync(legacyJsonPath);
      } catch (_) {}
    } catch (_) {}
  }

  if (!fs.existsSync(jsonlPath) && fs.existsSync(LEGACY_HISTORY_FILE)) {
    migrateAllLegacyFiles();
  }

  if (!fs.existsSync(jsonlPath)) {
    chatMemoryCache.set(chatId, []);
    return [];
  }

  try {
    const raw = fs.readFileSync(jsonlPath, 'utf8');
    const messages = parseJsonLines(raw);
    chatMemoryCache.set(chatId, messages);
    return messages;
  } catch (err) {
    console.error(`⚠️ Failed to load chat history for ${chatId}:`, err.message);
    chatMemoryCache.set(chatId, []);
    return [];
  }
}

/**
 * Prunes expired messages (>14 days) for a single chat file.
 */
function pruneExpiredMessagesForChat(chatId, maxAgeMs = TWO_WEEKS_MS) {
  if (!chatId) return 0;
  const list = loadChatFile(chatId);
  const cutoff = Date.now() - maxAgeMs;
  const pruned = list.filter((m) => m.timestamp >= cutoff);
  const removedCount = list.length - pruned.length;
  if (removedCount > 0) {
    chatMemoryCache.set(chatId, pruned);
    atomicWriteJsonLines(getChatFilePath(chatId), pruned);
  }
  return removedCount;
}

/**
 * Prunes all expired messages across all chat files.
 * Runs once per day in a background sweep.
 */
function pruneAllExpiredMessages(maxAgeMs = TWO_WEEKS_MS) {
  ensureHistoryDir();
  let totalPruned = 0;
  try {
    const files = fs.readdirSync(CHAT_HISTORY_DIR).filter((f) => f.endsWith('.jsonl'));
    for (const file of files) {
      const chatId = file.slice(0, -6);
      const count = pruneExpiredMessagesForChat(chatId, maxAgeMs);
      totalPruned += count;
    }
  } catch (err) {
    console.error('⚠️ Failed to prune expired messages:', err.message);
  }
  if (totalPruned > 0) {
    console.log(`[messageHistory] Pruned ${totalPruned} expired message(s) older than 14 days`);
  }
  return totalPruned;
}

/**
 * Internal helper to trigger daily pruning if 24 hours have elapsed.
 */
function checkAndRunDailyPrune() {
  const now = Date.now();
  if (now - lastDailyPruneTimestamp >= ONE_DAY_MS) {
    lastDailyPruneTimestamp = now;
    pruneAllExpiredMessages();
  }
}

// Initial migration on module load
migrateAllLegacyFiles();

/**
 * Appends a message to the chat's history using fast O(1) append.
 * Does NOT rewrite or prune the file on incoming messages.
 */
function recordMessage(chatId, sender, text, timestamp = Date.now(), fromMe = false, id = null) {
  if (!chatId || !text || typeof text !== 'string') return;
  const cleanText = text.trim();
  if (!cleanText) return;

  // Run daily pruning sweep if due (once per day)
  checkAndRunDailyPrune();

  const list = loadChatFile(chatId);
  const now = Date.now();

  const msgEntry = {
    id: id || null,
    sender: sender || (fromMe ? 'Bot' : 'Someone'),
    text: cleanText,
    timestamp: typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime() || now,
    fromMe: Boolean(fromMe)
  };

  list.push(msgEntry);
  chatMemoryCache.set(chatId, list);

  // Pure O(1) append without rewriting or pruning on incoming messages!
  appendJsonLine(getChatFilePath(chatId), msgEntry);
}

/**
 * Updates an existing message in the chat history when it has been edited,
 * or appends it if the original was not found.
 */
function recordEditedMessage(chatId, messageId, sender, text, timestamp = Date.now(), fromMe = false) {
  if (!chatId || !text || typeof text !== 'string') return;
  const cleanText = text.trim();
  if (!cleanText) return;

  const list = loadChatFile(chatId);
  const now = Date.now();

  let updated = false;
  if (messageId) {
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i];
      if (entry.id === messageId) {
        entry.text = cleanText;
        entry.edited = true;
        entry.editedAt = typeof timestamp === 'number' ? timestamp : now;
        if (sender && (!entry.sender || entry.sender === 'Someone')) {
          entry.sender = sender;
        }
        updated = true;
        break;
      }
    }
  }

  if (!updated) {
    // If not found by ID, check if there is a recent message by the same sender within 15 minutes
    const fifteenMinsAgo = now - 15 * 60 * 1000;
    for (let i = list.length - 1; i >= 0; i--) {
      const entry = list[i];
      if (entry.sender === sender && entry.timestamp >= fifteenMinsAgo) {
        entry.text = cleanText;
        entry.edited = true;
        entry.editedAt = typeof timestamp === 'number' ? timestamp : now;
        if (messageId) entry.id = messageId;
        updated = true;
        break;
      }
    }
  }

  if (!updated) {
    list.push({
      id: messageId || null,
      sender: sender || (fromMe ? 'Bot' : 'Someone'),
      text: cleanText,
      timestamp: typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime() || now,
      fromMe: Boolean(fromMe),
      edited: true,
      editedAt: now
    });
  }

  chatMemoryCache.set(chatId, list);
  atomicWriteJsonLines(getChatFilePath(chatId), list);
}

/**
 * Retrieves all messages for a chat within the 2-week window.
 * Always filters by cutoff so consumers never see expired messages.
 */
function getRecentMessages(chatId, maxAgeMs = TWO_WEEKS_MS) {
  if (!chatId) return [];
  const list = loadChatFile(chatId);
  const cutoff = Date.now() - maxAgeMs;
  return list.filter((m) => m.timestamp >= cutoff);
}

/**
 * Formats the 2-week group message history into human-readable text for LLM context.
 */
function formatRecentMessagesForContext(chatId, maxAgeMs = TWO_WEEKS_MS, maxChars = 30000) {
  const messages = getRecentMessages(chatId, maxAgeMs);
  if (messages.length === 0) return 'No recent group messages recorded.';

  const lines = messages.map((m) => {
    const timeStr = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      weekday: 'short',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    }).format(new Date(m.timestamp));

    return `[${timeStr}] ${m.sender}: ${m.text}`;
  });

  let joined = lines.join('\n');
  if (joined.length > maxChars) {
    joined = '... (earlier messages truncated)\n' + joined.slice(-maxChars);
  }
  return joined;
}

/**
 * Clears message history for a chat.
 */
function clear(chatId = null) {
  ensureHistoryDir();
  if (chatId) {
    chatMemoryCache.delete(chatId);
    const jsonlPath = getChatFilePath(chatId);
    const legacyJsonPath = getLegacyJsonFilePath(chatId);
    if (fs.existsSync(jsonlPath)) {
      try { fs.unlinkSync(jsonlPath); } catch (_) {}
    }
    if (fs.existsSync(legacyJsonPath)) {
      try { fs.unlinkSync(legacyJsonPath); } catch (_) {}
    }
  } else {
    chatMemoryCache.clear();
    try {
      const files = fs.readdirSync(CHAT_HISTORY_DIR);
      for (const f of files) {
        if (f.endsWith('.jsonl') || f.endsWith('.json')) {
          try { fs.unlinkSync(path.join(CHAT_HISTORY_DIR, f)); } catch (_) {}
        }
      }
    } catch (_) {}
    if (fs.existsSync(LEGACY_HISTORY_FILE)) {
      try { fs.unlinkSync(LEGACY_HISTORY_FILE); } catch (_) {}
    }
  }
}

function loadStore() {
  migrateAllLegacyFiles();
  ensureHistoryDir();
  const store = {};
  try {
    const files = fs.readdirSync(CHAT_HISTORY_DIR).filter((f) => f.endsWith('.jsonl'));
    for (const file of files) {
      const chatId = file.slice(0, -6);
      store[chatId] = loadChatFile(chatId);
    }
  } catch (_) {}
  return store;
}

function saveStore(store) {
  if (!store || typeof store !== 'object') return;
  for (const [chatId, messages] of Object.entries(store)) {
    if (Array.isArray(messages)) {
      chatMemoryCache.set(chatId, messages);
      atomicWriteJsonLines(getChatFilePath(chatId), messages);
    }
  }
}

module.exports = {
  TWO_WEEKS_MS,
  ONE_DAY_MS,
  recordMessage,
  recordEditedMessage,
  getRecentMessages,
  formatRecentMessagesForContext,
  clear,
  loadStore,
  saveStore,
  pruneExpiredMessagesForChat,
  pruneAllExpiredMessages,
  getChatFilePath,
  getChatFileName,
  getLegacyJsonFilePath,
  sanitizeChatId,
  parseJsonLines,
  formatJsonLines,
  CHAT_HISTORY_DIR,
  DATA_DIR,
  HISTORY_FILE,
  LEGACY_HISTORY_FILE
};
