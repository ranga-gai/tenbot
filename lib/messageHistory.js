/**
 * Persistent message history tracker: records group chat messages over a rolling
 * 2-week window (14 days) so Claude has full conversational context of all recent
 * group banter, discussions, availability remarks, and questions.
 *
 * Persists messages in individual files per group/chat:
 * data/chat-history/<chatId>.json
 */

const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('./paths');
const CHAT_HISTORY_DIR = path.join(DATA_DIR, 'chat-history');
const LEGACY_HISTORY_FILE = path.join(DATA_DIR, 'chat-history.json');
const HISTORY_FILE = LEGACY_HISTORY_FILE; // Backward compatibility alias
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

// In-memory cache of loaded/recorded chat histories: chatId -> Array<Message>
const chatMemoryCache = new Map();

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
  return `${safeId}.json`;
}

function getChatFilePath(chatId) {
  return path.join(CHAT_HISTORY_DIR, getChatFileName(chatId));
}

function inferChatIdFromFileName(fileName) {
  if (!fileName || !fileName.endsWith('.json')) return null;
  return fileName.slice(0, -5);
}

function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

/**
 * Automatically migrates existing monolithic chat-history.json into per-group files.
 */
function migrateLegacyHistoryFile() {
  if (!fs.existsSync(LEGACY_HISTORY_FILE)) return;
  try {
    ensureHistoryDir();
    const raw = fs.readFileSync(LEGACY_HISTORY_FILE, 'utf8');
    if (raw && raw.trim()) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const chatIds = Object.keys(parsed);
        console.log(`[messageHistory] Migrating legacy chat-history.json with ${chatIds.length} chat(s) to ${CHAT_HISTORY_DIR}/`);
        for (const chatId of chatIds) {
          const list = Array.isArray(parsed[chatId]) ? parsed[chatId] : [];
          if (list.length > 0) {
            saveChatFile(chatId, list);
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

function loadChatFile(chatId) {
  if (!chatId) return [];
  if (chatMemoryCache.has(chatId)) {
    return chatMemoryCache.get(chatId);
  }

  ensureHistoryDir();
  const filePath = getChatFilePath(chatId);

  // If chat file does not exist yet, check if legacy file exists and needs migration
  if (!fs.existsSync(filePath) && fs.existsSync(LEGACY_HISTORY_FILE)) {
    migrateLegacyHistoryFile();
  }

  if (!fs.existsSync(filePath)) {
    chatMemoryCache.set(chatId, []);
    return [];
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) {
      chatMemoryCache.set(chatId, []);
      return [];
    }
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.messages) ? parsed.messages : []);
    chatMemoryCache.set(chatId, list);
    return list;
  } catch (err) {
    console.error(`⚠️ Failed to load chat history for ${chatId}:`, err.message);
    chatMemoryCache.set(chatId, []);
    return [];
  }
}

function saveChatFile(chatId, messages) {
  if (!chatId) return;
  chatMemoryCache.set(chatId, messages);
  ensureHistoryDir();
  const filePath = getChatFilePath(chatId);
  const payload = {
    chatId,
    updatedAt: new Date().toISOString(),
    messages
  };
  atomicWriteJson(filePath, payload);
}

function loadStore() {
  migrateLegacyHistoryFile();
  ensureHistoryDir();
  const store = {};
  try {
    const files = fs.readdirSync(CHAT_HISTORY_DIR).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      const filePath = path.join(CHAT_HISTORY_DIR, file);
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        if (!raw || !raw.trim()) continue;
        const parsed = JSON.parse(raw);
        const chatId = parsed?.chatId || inferChatIdFromFileName(file);
        const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.messages) ? parsed.messages : []);
        if (chatId) {
          store[chatId] = list;
          chatMemoryCache.set(chatId, list);
        }
      } catch (_) {}
    }
  } catch (_) {}
  return store;
}

function saveStore(store) {
  if (!store || typeof store !== 'object') return;
  for (const [chatId, messages] of Object.entries(store)) {
    if (Array.isArray(messages)) {
      saveChatFile(chatId, messages);
    }
  }
}

// Initial migration check upon module load
migrateLegacyHistoryFile();

/**
 * Appends a message to the chat's 2-week history and prunes older entries.
 */
function recordMessage(chatId, sender, text, timestamp = Date.now(), fromMe = false, id = null) {
  if (!chatId || !text || typeof text !== 'string') return;
  const cleanText = text.trim();
  if (!cleanText) return;

  const list = [...loadChatFile(chatId)];
  const now = Date.now();
  const cutoff = now - TWO_WEEKS_MS;

  // Add new message
  list.push({
    id: id || null,
    sender: sender || (fromMe ? 'Bot' : 'Someone'),
    text: cleanText,
    timestamp: typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime() || now,
    fromMe: Boolean(fromMe)
  });

  // Prune messages older than 2 weeks
  const pruned = list.filter((m) => m.timestamp >= cutoff);
  saveChatFile(chatId, pruned);
}

/**
 * Updates an existing message in the chat history when it has been edited,
 * or appends it if the original was not found.
 */
function recordEditedMessage(chatId, messageId, sender, text, timestamp = Date.now(), fromMe = false) {
  if (!chatId || !text || typeof text !== 'string') return;
  const cleanText = text.trim();
  if (!cleanText) return;

  const list = [...loadChatFile(chatId)];
  const now = Date.now();
  const cutoff = now - TWO_WEEKS_MS;

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

  const pruned = list.filter((m) => m.timestamp >= cutoff);
  saveChatFile(chatId, pruned);
}

/**
 * Retrieves all messages for a chat within the 2-week window.
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
    const filePath = getChatFilePath(chatId);
    if (fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (_) {}
    }
  } else {
    chatMemoryCache.clear();
    try {
      const files = fs.readdirSync(CHAT_HISTORY_DIR).filter((f) => f.endsWith('.json'));
      for (const f of files) {
        try {
          fs.unlinkSync(path.join(CHAT_HISTORY_DIR, f));
        } catch (_) {}
      }
    } catch (_) {}
    if (fs.existsSync(LEGACY_HISTORY_FILE)) {
      try {
        fs.unlinkSync(LEGACY_HISTORY_FILE);
      } catch (_) {}
    }
  }
}

module.exports = {
  TWO_WEEKS_MS,
  recordMessage,
  recordEditedMessage,
  getRecentMessages,
  formatRecentMessagesForContext,
  clear,
  loadStore,
  saveStore,
  getChatFilePath,
  getChatFileName,
  sanitizeChatId,
  CHAT_HISTORY_DIR,
  DATA_DIR,
  HISTORY_FILE,
  LEGACY_HISTORY_FILE
};
