/**
 * Persistent message history tracker: records group chat messages over a rolling
 * 2-week window (14 days) so Claude has full conversational context of all recent
 * group banter, discussions, availability remarks, and questions.
 */

const fs = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(__dirname, '..', 'chat-history.json');
const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

function loadStore() {
  if (!fs.existsSync(HISTORY_FILE)) return {};
  try {
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.error('⚠️ Failed to load chat-history.json:', err.message);
    return {};
  }
}

function saveStore(store) {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    console.error('⚠️ Failed to save chat-history.json:', err.message);
  }
}

/**
 * Appends a message to the chat's 2-week history and prunes older entries.
 */
function recordMessage(chatId, sender, text, timestamp = Date.now(), fromMe = false) {
  if (!chatId || !text || typeof text !== 'string') return;
  const cleanText = text.trim();
  if (!cleanText) return;

  const store = loadStore();
  if (!Array.isArray(store[chatId])) {
    store[chatId] = [];
  }

  const now = Date.now();
  const cutoff = now - TWO_WEEKS_MS;

  // Add new message
  store[chatId].push({
    sender: sender || (fromMe ? 'Bot' : 'Someone'),
    text: cleanText,
    timestamp: typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime() || now,
    fromMe: Boolean(fromMe)
  });

  // Prune messages older than 2 weeks
  store[chatId] = store[chatId].filter((m) => m.timestamp >= cutoff);

  saveStore(store);
}

/**
 * Retrieves all messages for a chat within the 2-week window.
 */
function getRecentMessages(chatId, maxAgeMs = TWO_WEEKS_MS) {
  const store = loadStore();
  const list = store[chatId] || [];
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
function clear(chatId) {
  const store = loadStore();
  if (chatId) {
    delete store[chatId];
  } else {
    for (const k of Object.keys(store)) delete store[k];
  }
  saveStore(store);
}

module.exports = {
  TWO_WEEKS_MS,
  recordMessage,
  getRecentMessages,
  formatRecentMessagesForContext,
  clear
};
