/**
 * Tennis Group Bot (Baileys edition)
 * ----------------------------------
 * Listens for messages in a WhatsApp tennis group and helps with:
 *   - Coordinating who's free to play (!free, !notfree)
 *   - Tracking match results / a simple leaderboard (!score, !leaderboard)
 *   - Weather checks for outdoor play (!weather)
 *   - Scheduling matches via WhatsApp polls: "@tenbot create a poll for 2" (singles)
 *     or "@tenbot create a poll for 8" (doubles). Once every slot has exactly one voter,
 *     the bot automatically posts singles/doubles matchups with rotations.
 *   - General questions, answered by Claude with live group context (@tenbot ...)
 *
 * Setup:
 *   1. npm install
 *   2. Copy .env.example to .env and add your ANTHROPIC_API_KEY
 *   3. node index.js
 *   4. Scan the QR code with WhatsApp (Linked Devices > Link a Device)
 *   5. Send a message in your target group to see it respond
 *
 * Notes:
 *   - This uses Baileys, which connects to WhatsApp over a raw WebSocket --
 *     no browser/Puppeteer involved. It's still an UNOFFICIAL client (not the
 *     WhatsApp Business API), so use responsibly: avoid spammy/high-volume
 *     behavior, and know there's a (small but real) risk of your account
 *     being flagged if WhatsApp detects automation abuse.
 *   - Session data is cached locally after the first QR scan (in
 *     auth_info_baileys/), so you won't need to re-scan every restart.
 */

require('dotenv').config();
const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  getAggregateVotesInPollMessage,
  decryptPollVote,
  getKeyAuthor,
  jidNormalizedUser,
  DisconnectReason,
  Browsers
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

const storage = require('./lib/storage');
const weather = require('./lib/weather');
const { generateMatchups, formatMatchups } = require('./lib/matchups');
const pollStore = require('./lib/pollStore');
const { resolvePlayDateTime } = require('./lib/pollTime');

// ---- CONFIG ----
// Set this to the exact group name (subject) you want the bot to listen to.
// Leave as null to have the bot log every group name/ID it sees, so you can
// find the right one.
const TARGET_GROUP_NAME = 'SCVCC Early Morning Tennis Group (that usually plays in the evenings!)';
//const TARGET_GROUP_NAME = 'Bot-testing';

// Only call the LLM when the bot is directly addressed (recommended for
// groups, otherwise it'll try to reply to every single message). Structured
// commands (!free, !score, poll creation, etc.) always work regardless of
// this prefix as long as they start with it.
const TRIGGER_PREFIX = '@tenbot'; // e.g. "@tenbot who's free this weekend?"

// Default location for !weather when no location is given in the message.
const DEFAULT_LOCATION = 'San Jose, CA'; // change to wherever the group usually plays

// How long after a poll's scheduled play time to keep it around before
// automatically deleting it -- gives some slack for "!rematch"/"!pollstatus"
// to still work for a while after play starts, rather than vanishing the
// instant the clock crosses the play time.
const POLL_EXPIRY_GRACE_HOURS = 3;

// How often to sweep for and delete completed/cancelled/expired polls.
const POLL_CLEANUP_INTERVAL_MINUTES = 15;

// System prompt controlling the bot's personality/behavior
const SYSTEM_PROMPT =
  'You are a helpful assistant in a WhatsApp group chat for a group of tennis ' +
  'players who organize casual matches together. Keep replies short and ' +
  'conversational (1-3 sentences) unless asked for more detail. You have ' +
  "access to tools to create match polls (2 spots for singles, or 4/8/12 spots for doubles), " +
  "check weather, cancel polls, and access the group's availability list, win/loss leaderboard, " +
  'and active polls (given below). When a message contains a request to create a poll alongside ' +
  'other questions, call the create_poll tool and answer the other questions naturally in your reply.';

// Tools exposed to Claude for handling natural language requests
const CLAUDE_TOOLS = [
  {
    name: 'create_poll',
    description: 'Creates and sends a WhatsApp poll with numbered spots (1..N) for organizing a tennis match in the group. Supports singles (2 spots) and doubles (4, 8, 12, etc.). Use this whenever the user wants to create a poll, organize singles or doubles, set up spots for tennis, etc.',
    input_schema: {
      type: 'object',
      properties: {
        size: {
          type: 'integer',
          description: 'Number of spots in the poll. Must be 2 (for singles) or a positive multiple of 4 (e.g. 4, 8, 12, 16 for doubles).'
        },
        when: {
          type: 'string',
          description: 'Human-readable day/time description (e.g. "Saturday 9am", "Tomorrow 7pm", "Tonight 6pm").'
        },
        dayWord: {
          type: 'string',
          description: 'Day word mentioned in the request (e.g. "today", "tomorrow", "Saturday", "Sun").'
        },
        timeWord: {
          type: 'string',
          description: 'Time word mentioned in the request (e.g. "9am", "6:30pm", "7pm").'
        }
      },
      required: ['size']
    }
  },
  {
    name: 'get_weather',
    description: 'Get weather forecast for outdoor tennis play for a specific city or location.',
    input_schema: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'Location / city name. Defaults to the group\'s default location if omitted.'
        }
      }
    }
  },
  {
    name: 'cancel_poll',
    description: 'Cancels the active match poll so the bot stops tracking and auto-generating matchups.',
    input_schema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'rematch',
    description: 'Regenerates matchups and rotations from the current poll votes.',
    input_schema: {
      type: 'object',
      properties: {}
    }
  }
];

// How many past messages (per chat) to keep for conversational context
const HISTORY_LIMIT = 10;

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn(
    '⚠️  No ANTHROPIC_API_KEY found in environment. Copy .env.example to .env ' +
    'and add your key, or LLM replies will fail.'
  );
}

// In-memory conversation history per chat: chatId -> [{role, content}, ...]
const chatHistories = new Map();

// Cache of group metadata (id -> metadata) so we don't refetch on every message
const groupMetadataCache = new Map();

// Bidirectional LID <-> Phone Number JID mappings
const lidToPn = new Map();
const pnToLid = new Map();

// Best-effort JID -> display name map, built up from messages we see.
// Poll votes only carry a JID, not a name, so this is how we label voters.
const knownNames = new Map();

// Active WhatsApp socket reference
let botSock = null;

// Poll-related state is persisted to poll-state.json so polls survive a bot
// restart. Loaded once here at startup; storeKey() below is used both for
// the in-memory maps and as the persisted key format.
const {
  messageStore,   // `${remoteJid}:${id}` -> stored WAMessage content, needed for getMessage() and vote decoding
  activePolls,    // pollId -> { remoteJid, size, when, playAt, status, lastConflictSignature, voteBuffer, lastPlayers }
  latestPollIdByChat // chatId -> pollId, so "!cancelpoll"/"!rematch"/"!pollstatus" know which poll to act on
} = pollStore.load();

const storeKey = (remoteJid, id) => `${remoteJid}:${id}`;

function persistPolls() {
  pollStore.save({ messageStore, activePolls, latestPollIdByChat });
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Checks whether an incoming message is addressed to the bot, matching any case
 * variation of TRIGGER_PREFIX (e.g. @tenbot, @Tenbot, @TENBOT, @TenBot, tenbot),
 * optional punctuation (colons, commas), or WhatsApp native @-mentions.
 */
function isAddressedToBot(text, msg, botJids, triggerPrefix = TRIGGER_PREFIX) {
  if (!triggerPrefix) return { addressed: true, promptText: text };

  const mentionedJids = msg?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  const isDirectlyMentioned = mentionedJids.some((jid) => botJids.includes(jidNormalizedUser(jid)));

  const baseName = escapeRegex(triggerPrefix.replace(/^@/, ''));
  const prefixRegex = new RegExp(`^@?${baseName}[:,]?\\s*`, 'i');
  const anywhereRegex = new RegExp(`@?${baseName}[:,]?\\b`, 'ig');

  if (prefixRegex.test(text)) {
    const promptText = text.replace(prefixRegex, '').trim();
    return { addressed: true, promptText };
  }

  if (isDirectlyMentioned || anywhereRegex.test(text)) {
    let promptText = text.replace(anywhereRegex, '').trim();
    for (const jid of botJids) {
      const num = jid.split('@')[0];
      if (num) {
        promptText = promptText.replace(new RegExp(`@${escapeRegex(num)}[:,]?\\s*`, 'g'), '').trim();
      }
    }
    promptText = promptText.replace(/^[,\s:]+/, '').replace(/\s{2,}/g, ' ').trim();
    return { addressed: true, promptText };
  }

  return { addressed: false, promptText: text };
}

/**
 * Associates a JID / LID with a display name across all formats.
 */
function recordName(jid, name) {
  if (!jid || !name) return;
  const raw = jid;
  const norm = jidNormalizedUser(jid);
  knownNames.set(raw, name);
  if (norm) {
    knownNames.set(norm, name);
    const pn = lidToPn.get(norm);
    if (pn) knownNames.set(pn, name);
    const lid = pnToLid.get(norm);
    if (lid) knownNames.set(lid, name);
  }
}

/**
 * Extracts messageSecret as a Buffer regardless of whether it's stored as
 * a Buffer, Uint8Array, base64 string, or serialized JSON object.
 */
function getMessageSecret(creationMessage) {
  const secret = creationMessage?.messageContextInfo?.messageSecret;
  if (!secret) return null;
  if (Buffer.isBuffer(secret)) return secret;
  if (secret instanceof Uint8Array) return Buffer.from(secret);
  if (typeof secret === 'string') return Buffer.from(secret, 'base64');
  if (secret.type === 'Buffer' && Array.isArray(secret.data)) return Buffer.from(secret.data);
  return Buffer.from(secret);
}

/**
 * Ensures selectedOptions in a decrypted vote payload are Buffer instances,
 * which is required by getAggregateVotesInPollMessage for SHA256 string matching.
 */
function normalizeVotePayload(vote) {
  if (!vote) return vote;
  if (Array.isArray(vote.selectedOptions)) {
    return {
      ...vote,
      selectedOptions: vote.selectedOptions.map((opt) => {
        if (Buffer.isBuffer(opt)) return opt;
        if (typeof opt === 'string') return Buffer.from(opt, 'base64');
        if (opt instanceof Uint8Array || Array.isArray(opt)) return Buffer.from(opt);
        if (opt && opt.type === 'Buffer' && Array.isArray(opt.data)) return Buffer.from(opt.data);
        return Buffer.from(opt);
      })
    };
  }
  return vote;
}

/**
 * Fetches and caches group metadata, populating LID <-> Phone Number maps.
 */
async function getGroupMetadata(sock, remoteJid) {
  if (!remoteJid || !remoteJid.endsWith('@g.us')) return null;
  let metadata = groupMetadataCache.get(remoteJid);
  if (!metadata) {
    try {
      metadata = await sock.groupMetadata(remoteJid);
      groupMetadataCache.set(remoteJid, metadata);
    } catch (err) {
      console.error(`Failed to fetch group metadata for ${remoteJid}:`, err.message);
      return null;
    }
  }
  if (metadata?.participants) {
    for (const p of metadata.participants) {
      const pn = jidNormalizedUser(p.id || p.jid);
      const lid = jidNormalizedUser(p.lid);
      if (pn && lid) {
        lidToPn.set(lid, pn);
        pnToLid.set(pn, lid);
      }
    }
  }
  return metadata;
}

/**
 * Safely attempts to decrypt a poll vote by iterating through candidate
 * creator and voter JIDs (e.g. LID vs Phone Number formats).
 */
function safeDecryptPollVote(votePayload, pollMsgId, pollEncKey, pollCreatorCandidates, voterCandidates) {
  const encPayload = Buffer.isBuffer(votePayload.encPayload)
    ? votePayload.encPayload
    : typeof votePayload.encPayload === 'string'
      ? Buffer.from(votePayload.encPayload, 'base64')
      : Buffer.from(votePayload.encPayload);
  const encIv = Buffer.isBuffer(votePayload.encIv)
    ? votePayload.encIv
    : typeof votePayload.encIv === 'string'
      ? Buffer.from(votePayload.encIv, 'base64')
      : Buffer.from(votePayload.encIv);

  let lastError = null;
  const uniqueCreators = [...new Set(pollCreatorCandidates.filter(Boolean))];
  const uniqueVoters = [...new Set(voterCandidates.filter(Boolean))];

  for (const creatorJid of uniqueCreators) {
    for (const voterJid of uniqueVoters) {
      try {
        const decrypted = decryptPollVote(
          { encPayload, encIv },
          {
            pollCreatorJid: creatorJid,
            pollMsgId,
            pollEncKey,
            voterJid
          }
        );
        if (decrypted) {
          return { decrypted, authenticatingVoterJid: voterJid, authenticatingCreatorJid: creatorJid };
        }
      } catch (err) {
        lastError = err;
      }
    }
  }

  throw lastError || new Error('Failed to decrypt poll vote: no matching JID combination authenticated');
}

/**
 * Deletes any poll whose scheduled play time (plus grace period) has
 * passed, regardless of whether it ended up resolved, cancelled, or just
 * never filled up. Runs once at startup (to clear anything stale from
 * before a restart) and on a recurring interval after that.
 */
function cleanupExpiredPolls() {
  const now = Date.now();
  const graceMs = POLL_EXPIRY_GRACE_HOURS * 60 * 60 * 1000;
  const removed = [];

  for (const [pollId, pollState] of activePolls.entries()) {
    if (!pollState.playAt) continue; // no play time recorded -- never auto-expire it
    const playAtMs = new Date(pollState.playAt).getTime();
    if (Number.isNaN(playAtMs)) continue;
    if (now > playAtMs + graceMs) {
      activePolls.delete(pollId);
      messageStore.delete(storeKey(pollState.remoteJid, pollId));
      for (const [chatId, latestId] of latestPollIdByChat.entries()) {
        if (latestId === pollId) latestPollIdByChat.delete(chatId);
      }
      removed.push(pollId);
    }
  }

  if (removed.length > 0) {
    persistPolls();
    console.log(`[poll] Cleaned up ${removed.length} expired/completed poll(s): ${removed.join(', ')}`);
  }
  return removed;
}

// Purge anything stale from before this startup, then keep sweeping.
cleanupExpiredPolls();
setInterval(cleanupExpiredPolls, POLL_CLEANUP_INTERVAL_MINUTES * 60 * 1000);


async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    version,
    browser: Browsers.ubuntu('Chrome'),
    logger: pino({ level: 'silent' }), // set to 'debug' if you need to see raw protocol traffic
    syncFullHistory: false,
    // Required by Baileys to decrypt incoming poll votes -- it needs to be
    // able to look back up the original poll creation message by its key.
    getMessage: async (key) => {
      return messageStore.get(storeKey(key.remoteJid, key.id));
    }
  });
  botSock = sock;

  // Record self user info
  const meName = sock.user?.name || state.creds?.me?.name;
  const meId = sock.user?.id || state.creds?.me?.id;
  const meLid = sock.user?.lid || state.creds?.me?.lid;
  if (meName) {
    if (meId) recordName(meId, meName);
    if (meLid) recordName(meLid, meName);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Scan this QR code with WhatsApp (Linked Devices):');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode
        : null;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(
        `⚠️  Connection closed (status ${statusCode || 'unknown'}).`,
        shouldReconnect ? 'Reconnecting...' : 'Logged out -- delete auth_info_baileys/ and re-scan to log in again.'
      );

      if (shouldReconnect) {
        startBot();
      }
    } else if (connection === 'open') {
      const currMeName = sock.user?.name || sock.authState?.creds?.me?.name;
      const currMeId = sock.user?.id || sock.authState?.creds?.me?.id;
      const currMeLid = sock.user?.lid || sock.authState?.creds?.me?.lid;
      if (currMeName) {
        if (currMeId) recordName(currMeId, currMeName);
        if (currMeLid) recordName(currMeLid, currMeName);
      }
      console.log(`✅ Tennis group bot is ready and listening for group ${TARGET_GROUP_NAME}.`);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      // Remember voter's display name if present
      if (msg.pushName && (msg.key.participant || msg.key.remoteJid)) {
        const rawJid = msg.key.participant || msg.key.remoteJid;
        recordName(rawJid, msg.pushName);
      }

      // Baileys delivers poll updates via messages.upsert with pollUpdateMessage payload.
      if (msg.message?.pollUpdateMessage) {
        const pollUpdateMessage = msg.message.pollUpdateMessage;
        const pollKey = pollUpdateMessage.pollCreationMessageKey;
        console.log(`[poll] Vote received via messages.upsert for poll ${pollKey?.id || '(unknown)'}`);
        if (pollKey) {
          try {
            await processPollVoteEvent(sock, pollKey, [{
              pollUpdateMessageKey: msg.key,
              vote: pollUpdateMessage.vote,
              senderTimestampMs: msg.messageTimestamp
            }]);
          } catch (err) {
            console.error('Error handling poll vote (upsert path):', err && err.message ? err.message : err);
            console.error(err && err.stack ? err.stack : '(no stack trace available)');
          }
        }
        continue;
      }

      if (type !== 'notify') continue;

      try {
        await handleMessage(sock, msg);
      } catch (err) {
        console.error('Error handling message:', err && err.message ? err.message : err);
        console.error(err && err.stack ? err.stack : '(no stack trace available)');
      }
    }
  });

  // Poll votes also arrive here on some Baileys setups.
  sock.ev.on('messages.update', async (updates) => {
    for (const { key, update } of updates) {
      if (!update.pollUpdates) continue;
      console.log(`[poll] Vote received via messages.update for poll ${key.id} (${update.pollUpdates.length} entry/entries)`);
      try {
        await processPollVoteEvent(sock, key, update.pollUpdates);
      } catch (err) {
        console.error('Error handling poll update:', err && err.message ? err.message : err);
        console.error(err && err.stack ? err.stack : '(no stack trace available)');
      }
    }
  });
}

async function handleMessage(sock, msg) {
  if (!msg.message || msg.key.fromMe) return;

  const remoteJid = msg.key.remoteJid;
  const isGroup = remoteJid && remoteJid.endsWith('@g.us');
  if (!isGroup) return;

  const metadata = await getGroupMetadata(sock, remoteJid);
  const groupName = metadata?.subject || remoteJid;

  console.log(`Received message from group ${groupName}`);

  if (!TARGET_GROUP_NAME) {
    console.log(`[Group seen] "${groupName}" (id: ${remoteJid})`);
    return;
  }

  if (groupName !== TARGET_GROUP_NAME) return;

  const text = extractText(msg.message);
  if (!text) return;

  const sender = msg.pushName || 'Someone';

  // Remember this voter's display name for when we see their poll votes later.
  if (msg.key.participant) {
    recordName(msg.key.participant, sender);
  }

  console.log(`[${groupName}] ${sender}: ${text}`);

  const reply = await getResponse(sock, text.trim(), remoteJid, sender, msg);
  if (reply) {
    await sock.sendMessage(remoteJid, { text: reply });
  }
}

function extractText(message) {
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    null
  );
}

/**
 * Executes a tool called by Claude and returns the result string.
 */
async function executeTool(sock, chatId, sender, toolUse) {
  const { name, input } = toolUse;
  if (name === 'create_poll') {
    const size = input.size;
    const when = input.when || null;
    const dayWord = input.dayWord || null;
    const timeWord = input.timeWord || null;
    const err = await createMatchPoll(sock, chatId, size, when, dayWord, timeWord);
    if (err) {
      return `Failed to create poll: ${err}`;
    }
    return `Poll for ${size} spots (${size === 2 ? 'Singles' : 'Doubles'}${when ? ` -- ${when}` : ''}) created and posted to the group.`;
  }
  if (name === 'get_weather') {
    const location = input.location || DEFAULT_LOCATION;
    try {
      const forecast = await weather.getForecast(location);
      return weather.formatForecast(forecast);
    } catch (err) {
      return `Failed to get weather for ${location}: ${err.message}`;
    }
  }
  if (name === 'cancel_poll') {
    const pollId = latestPollIdByChat.get(chatId);
    if (!pollId || !activePolls.has(pollId)) return 'No active poll to cancel.';
    activePolls.get(pollId).status = 'cancelled';
    persistPolls();
    return 'Poll cancelled successfully.';
  }
  if (name === 'rematch') {
    const res = await regenerateMatchups(sock, chatId);
    return res || 'Matchups regenerated and posted.';
  }
  return `Unknown tool ${name}`;
}

/**
 * Routes an incoming message to the right handler: structured tennis
 * commands first, then the LLM with tool support for free-form queries,
 * questions, and poll creation.
 */
async function getResponse(sock, text, chatId, sender, msg) {
  const lower = text.toLowerCase();

  // --- Basic commands ---
  if (lower === '!ping') return 'pong 🏓';

  if (lower.startsWith('!help')) return helpText();

  if (lower === '!reset') {
    chatHistories.delete(chatId);
    return 'Conversation history cleared.';
  }

  // --- Availability ---
  if (lower.startsWith('!free')) {
    const when = text.slice('!free'.length).trim();
    if (!when) return formatAvailability();
    storage.setAvailable(sender, when);
    return `Got it, ${sender} is free ${when}. Send "!free" to see the full list.`;
  }

  if (lower === '!notfree') {
    storage.removeAvailable(sender);
    return `Removed ${sender} from the availability list.`;
  }

  if (lower === '!clearfree') {
    storage.clearAvailability();
    return 'Availability list cleared for everyone.';
  }

  // --- Scores / leaderboard ---
  if (lower.startsWith('!score')) {
    return handleScoreCommand(text);
  }

  if (lower === '!leaderboard') {
    return formatLeaderboard();
  }

  // --- Weather ---
  if (lower.startsWith('!weather')) {
    const location = text.slice('!weather'.length).trim() || DEFAULT_LOCATION;
    try {
      const forecast = await weather.getForecast(location);
      return weather.formatForecast(forecast);
    } catch (err) {
      console.error('Weather lookup failed:', err.message);
      return `Couldn't get the weather for "${location}": ${err.message}`;
    }
  }

  // --- Poll management ---
  if (lower === '!cancelpoll') {
    const pollId = latestPollIdByChat.get(chatId);
    if (!pollId || !activePolls.has(pollId)) return 'No active poll to cancel.';
    activePolls.get(pollId).status = 'cancelled';
    persistPolls();
    return 'Poll cancelled -- I won\'t auto-generate matchups from it anymore.';
  }

  if (lower === '!rematch') {
    return await regenerateMatchups(sock, chatId);
  }

  if (lower === '!cleanuppolls') {
    const removed = cleanupExpiredPolls();
    return removed.length
      ? `Cleaned up ${removed.length} old poll(s).`
      : 'Nothing to clean up yet -- no polls have passed their play time + grace period.';
  }

  if (lower === '!pollstatus') {
    return pollStatusText(chatId);
  }

  // --- Trigger check for bot-addressed messages (case-insensitive, with/without @, native mentions) ---
  const mePn = jidNormalizedUser(sock?.user?.id || sock?.authState?.creds?.me?.id || '');
  const meLid = jidNormalizedUser(sock?.user?.lid || sock?.authState?.creds?.me?.lid || '');
  const botJids = [mePn, meLid].filter(Boolean);

  const { addressed, promptText } = isAddressedToBot(text, msg, botJids);
  if (TRIGGER_PREFIX && !addressed) {
    return null; // not addressed to the bot, stay quiet
  }
  if (!promptText) return null;

  // --- LLM (handles free-form queries, poll creation, weather, Q&A, etc.) ---
  try {
    return await callClaude(sock, chatId, sender, promptText);
  } catch (err) {
    console.error('LLM call failed:', err);
    return "Sorry, I couldn't come up with a reply just now.";
  }
}

function helpText() {
  return [
    'Commands:',
    '!free <when> – mark yourself free to play, e.g. "!free Sat 9am"',
    '!free – show who\'s free and when',
    '!notfree – remove yourself from the availability list',
    '!clearfree – clear the whole availability list',
    '!score <winner> def <loser> <score> – record a match, e.g. "!score Mike def John 6-4 6-2"',
    '!leaderboard – show the win/loss leaderboard',
    '!weather [location] – forecast for outdoor play (defaults to ' + DEFAULT_LOCATION + ')',
    `${TRIGGER_PREFIX} create a poll for <N> – post a poll with N spots (2 for singles, 4/8/12 for doubles); once everyone's voted in, matchups post automatically`,
    '!cancelpoll – stop the current poll from auto-generating matchups',
    '!pollstatus – debug: show raw vote count and voters for the current poll',
    '!rematch – regenerate matchups from the current poll\'s votes',
    '!cleanuppolls – debug: force a sweep that deletes expired/completed polls now',
    '!reset – clear the bot\'s conversation memory',
    TRIGGER_PREFIX ? `${TRIGGER_PREFIX} <question> – ask the bot anything (including free-form poll creation and questions)` : '(bot also responds to any message)'
  ].join('\n');
}

function formatAvailability() {
  const list = storage.getAvailability();
  if (list.length === 0) {
    return 'No one has marked themselves free yet. Use "!free <when>" to add yourself.';
  }
  const lines = list.map((a) => `• ${a.player} – ${a.when}`);
  return `Who's free:\n${lines.join('\n')}`;
}

function formatLeaderboard() {
  const board = storage.getLeaderboard();
  if (board.length === 0) {
    return 'No matches recorded yet. Use "!score <winner> def <loser> <score>" to log one.';
  }
  const lines = board.map(
    (p, i) => `${i + 1}. ${p.name} — ${p.wins}W ${p.losses}L`
  );
  return `🏆 Leaderboard:\n${lines.join('\n')}`;
}

/**
 * Parses "!score <winner> def <loser> <score>", e.g.
 * "!score Mike def John 6-4 6-2"
 */
function handleScoreCommand(text) {
  const match = text.match(/^!score\s+(.+?)\s+def\s+(.+?)\s+((?:\d+-\\d+\s*)+)$/i);
  if (!match) {
    return 'Couldn\'t parse that. Use: !score <winner> def <loser> <score>\ne.g. "!score Mike def John 6-4 6-2"';
  }
  const [, winner, loser, score] = match;
  storage.recordMatch(winner.trim(), loser.trim(), score.trim());
  return `Recorded: ${winner.trim()} def ${loser.trim()} (${score.trim()}). Check "!leaderboard" for standings.`;
}

// ---- Poll creation & vote handling ----

/**
 * Creates and sends a WhatsApp poll with numbered slots 1..size, and starts
 * tracking it so we can auto-generate matchups once it fills up. `when` is
 * an optional day/time phrase (e.g. "Saturday 9am") echoed in the poll title;
 * `dayWord`/`timeWord` are the raw matches used to compute an absolute play
 * time for expiry purposes. Supports size=2 (singles) or multiples of 4 (doubles).
 */
async function createMatchPoll(sock, remoteJid, size, when, dayWord, timeWord) {
  if (!Number.isInteger(size) || size <= 0) {
    return `Give me a valid number of players, e.g. "${TRIGGER_PREFIX} create a poll for 2" (singles) or "${TRIGGER_PREFIX} create a poll for 8" (doubles).`;
  }
  if (size !== 2 && size % 4 !== 0) {
    return `Poll size needs to be 2 for singles or a multiple of 4 for doubles (e.g. 4, 8, 12) -- got ${size}.`;
  }
  if (size > 40) {
    return 'That\'s a lot of players for one poll -- try 40 or fewer.';
  }

  const values = Array.from({ length: size }, (_, i) => `${i + 1}`);
  const matchType = size === 2 ? 'Singles' : `${size} spots`;
  const suffix = when ? ` -- ${when}` : ' for today\'s matches';

  const sent = await sock.sendMessage(remoteJid, {
    poll: {
      name: `🎾 Vote for a spot! (${matchType}${suffix})`,
      values,
      selectableCount: 1
    }
  });

  const pollId = sent.key.id;
  const playAt = resolvePlayDateTime(dayWord, timeWord);

  messageStore.set(storeKey(sent.key.remoteJid, pollId), sent.message);
  activePolls.set(pollId, {
    remoteJid,
    size,
    when: when || null,
    playAt: playAt.toISOString(),
    status: 'active', // 'active' | 'resolved' | 'cancelled'
    lastConflictSignature: null,
    voteBuffer: new Map(), // voterJid -> raw pollUpdate entry
    lastPlayers: null
  });
  latestPollIdByChat.set(remoteJid, pollId);
  persistPolls();
  console.log(`[poll] Created poll ${pollId} for ${size} spots (${size === 2 ? 'singles' : 'doubles'}) in ${remoteJid}${when ? ` (${when})` : ''}, play time ${playAt.toISOString()}`);

  return null; // the poll message itself is the response; no extra text needed
}

/**
 * Handles an incoming poll vote (from either event path): decrypts it if
 * needed, merges it into our running tally for that poll, and if every slot
 * now has exactly one voter, posts matchups.
 */
async function processPollVoteEvent(sock, pollMessageKey, rawPollUpdates) {
  const pollId = pollMessageKey.id;
  const pollState = activePolls.get(pollId);
  if (!pollState) {
    const known = [...activePolls.keys()];
    console.log(
      `[poll] Got a vote for message ${pollId}, but no active poll is tracked for it. ` +
      `Tracked poll ids: ${known.length ? known.join(', ') : '(none)'}. ` +
      'If the bot restarted after creating the poll, its tracking was lost -- see README.'
    );
    return;
  }

  let pollCreationMessage = messageStore.get(storeKey(pollMessageKey.remoteJid, pollId));
  if (!pollCreationMessage && pollState.remoteJid) {
    pollCreationMessage = messageStore.get(storeKey(pollState.remoteJid, pollId));
  }
  if (!pollCreationMessage) {
    console.log(`[poll] No stored creation message found for poll ${pollId} -- can't decode its votes.`);
    return;
  }

  const pollEncKey = getMessageSecret(pollCreationMessage);
  console.log(
    `[poll] Debug -- creation message keys: [${Object.keys(pollCreationMessage).join(', ')}], ` +
    `messageSecret present: ${!!pollEncKey}, is binary: ${Buffer.isBuffer(pollEncKey)}, length: ${pollEncKey?.length ?? 'n/a'}`
  );

  if (pollState.status === 'cancelled') return; // don't process votes on a cancelled poll

  if (pollState.remoteJid && pollState.remoteJid.endsWith('@g.us')) {
    await getGroupMetadata(sock, pollState.remoteJid);
  }

  const meLid = jidNormalizedUser(sock.user?.lid || sock.authState?.creds?.me?.lid || '');
  const mePn = jidNormalizedUser(sock.user?.id || sock.authState?.creds?.me?.id || '');

  const pollCreatorCandidates = [
    meLid,
    mePn,
    pollMessageKey.participant ? jidNormalizedUser(pollMessageKey.participant) : null,
    pollMessageKey.participant && pnToLid.get(jidNormalizedUser(pollMessageKey.participant)),
    pollMessageKey.participant && lidToPn.get(jidNormalizedUser(pollMessageKey.participant)),
    pollMessageKey.remoteJid ? jidNormalizedUser(pollMessageKey.remoteJid) : null
  ];

  // Merge new updates into our per-voter buffer.
  for (const u of rawPollUpdates) {
    const rawVoterJid = u.pollUpdateMessageKey?.participant || (u.pollUpdateMessageKey?.fromMe ? mePn : u.pollUpdateMessageKey?.remoteJid);
    const voterNormalized = jidNormalizedUser(rawVoterJid);
    if (!voterNormalized && !u.pollUpdateMessageKey?.fromMe) {
      console.log('[poll] Skipping a vote with no identifiable voter JID:', JSON.stringify(u));
      continue;
    }

    const voterLid = pnToLid.get(voterNormalized) || (voterNormalized?.endsWith('@lid') ? voterNormalized : null);
    const voterPn = lidToPn.get(voterNormalized) || (voterNormalized?.endsWith('@s.whatsapp.net') ? voterNormalized : null);

    const voterCandidates = [
      voterNormalized,
      voterLid,
      voterPn,
      u.pollUpdateMessageKey?.participantPn ? jidNormalizedUser(u.pollUpdateMessageKey.participantPn) : null,
      u.pollUpdateMessageKey?.participant ? jidNormalizedUser(u.pollUpdateMessageKey.participant) : null,
      u.pollUpdateMessageKey?.remoteJid ? jidNormalizedUser(u.pollUpdateMessageKey.remoteJid) : null,
      u.pollUpdateMessageKey?.fromMe ? meLid : null,
      u.pollUpdateMessageKey?.fromMe ? mePn : null
    ];

    let votePayload = u.vote;
    let authenticatingVoter = voterNormalized || mePn;
    const isEncrypted = votePayload && (votePayload.encPayload || votePayload.encIv) && !Array.isArray(votePayload.selectedOptions);
    if (isEncrypted) {
      if (!pollEncKey) {
        console.log(`[poll] Cannot decrypt vote from ${voterNormalized}: missing messageSecret on creation message`);
        continue;
      }
      try {
        const res = safeDecryptPollVote(
          votePayload,
          pollId,
          pollEncKey,
          pollCreatorCandidates,
          voterCandidates
        );
        votePayload = res.decrypted;
        authenticatingVoter = res.authenticatingVoterJid;
        console.log(`[poll] Successfully decrypted vote from ${authenticatingVoter} (creator: ${res.authenticatingCreatorJid}) for poll ${pollId}`);
      } catch (err) {
        console.error(`[poll] Failed to decrypt poll vote from ${voterNormalized || 'fromMe'}:`, err && err.message ? err.message : err);
        continue;
      }
    }

    votePayload = normalizeVotePayload(votePayload);
    const canonicalVoter = lidToPn.get(authenticatingVoter) || authenticatingVoter;

    pollState.voteBuffer.set(canonicalVoter, {
      ...u,
      pollUpdateMessageKey: {
        ...u.pollUpdateMessageKey,
        fromMe: false,
        participant: canonicalVoter
      },
      vote: votePayload
    });
  }
  persistPolls(); // save vote progress immediately in case of a restart mid-poll

  const merged = [...pollState.voteBuffer.values()].map((u) => ({
    ...u,
    vote: normalizeVotePayload(u.vote)
  }));

  let aggregated;
  try {
    aggregated = getAggregateVotesInPollMessage(
      {
        message: pollCreationMessage,
        pollUpdates: merged
      },
      mePn
    );
  } catch (err) {
    console.error(`[poll] getAggregateVotesInPollMessage failed for poll ${pollId}:`, err.message);
    return;
  }

  const filled = aggregated.filter((o) => o.voters.length > 0);
  const conflicts = aggregated.filter((o) => o.voters.length > 1);

  console.log(
    `[poll] Poll ${pollId}: ${filled.length}/${pollState.size} slot(s) filled, ` +
    `${conflicts.length} conflicting slot(s), ${pollState.voteBuffer.size} raw vote(s) buffered.`
  );

  if (conflicts.length > 0) {
    const signature = conflicts.map((c) => `${c.name}:${c.voters.sort().join(',')}`).join('|');
    if (pollState.lastConflictSignature !== signature) {
      pollState.lastConflictSignature = signature;
      persistPolls();
      const lines = conflicts.map((c) => {
        const names = c.voters.map((v) => nameFor(v)).join(', ');
        return `Slot ${c.name}: ${names}`;
      });
      await sock.sendMessage(pollState.remoteJid, {
        text: `⚠️ A couple of slots have more than one vote -- one person should switch to an open slot:\n${lines.join('\n')}`
      });
    }
    return; // don't generate matchups while there's a conflict
  }

  if (pollState.status !== 'active') return;

  if (filled.length === pollState.size) {
    // Every slot has exactly one voter -- build the player list in slot order.
    const bySlot = new Map(aggregated.map((o) => [o.name, o.voters[0]]));
    const players = [];
    for (let i = 1; i <= pollState.size; i++) {
      const voterJid = bySlot.get(`${i}`);
      players.push(voterJid ? nameFor(voterJid) : `Slot ${i}`);
    }

    pollState.status = 'resolved';
    pollState.lastPlayers = players;
    persistPolls();

    console.log(`[poll] Poll ${pollId} filled -- posting matchups for: ${players.join(', ')}`);

    const courts = generateMatchups(players);
    const header = pollState.when ? `📅 ${pollState.when}\n\n` : '';
    await sock.sendMessage(pollState.remoteJid, { text: header + formatMatchups(courts) });
  }
}

/** Regenerates and re-announces matchups from the latest poll's current votes. */
async function regenerateMatchups(sock, chatId) {
  const pollId = latestPollIdByChat.get(chatId);
  const pollState = pollId && activePolls.get(pollId);
  if (!pollState) {
    return `No poll to work from yet -- create one with "${TRIGGER_PREFIX} create a poll for <N>" first.`;
  }
  if (pollState.lastPlayers) {
    const courts = generateMatchups(pollState.lastPlayers);
    const header = pollState.when ? `📅 ${pollState.when}\n\n` : '';
    await sock.sendMessage(pollState.remoteJid, { text: header + formatMatchups(courts) });
    return null;
  }
  return 'That poll hasn\'t filled up yet, so there\'s nothing to generate matchups from.';
}

/** Best-effort JID -> display name lookup, falling back to a short id. */
function nameFor(jid) {
  if (!jid || jid === 'me') {
    const meName = botSock?.user?.name || botSock?.authState?.creds?.me?.name;
    if (meName) return meName;
    const meId = jidNormalizedUser(botSock?.user?.id || botSock?.authState?.creds?.me?.id || '');
    if (meId && meId !== jid) return nameFor(meId);
    return 'Me';
  }
  const norm = jidNormalizedUser(jid) || jid;
  const pn = lidToPn.get(norm) || norm;
  if (knownNames.has(norm)) return knownNames.get(norm);
  if (knownNames.has(pn)) return knownNames.get(pn);
  if (knownNames.has(jid)) return knownNames.get(jid);
  const digits = (pn || norm || jid).split('@')[0].replace(/\D/g, '');
  if (digits.length >= 4) {
    return `Player (${digits.slice(-4)})`;
  }
  return digits ? `Player (${digits})` : 'Player';
}

/**
 * Debug helper: reports what the bot has actually recorded for the current
 * poll, straight from the raw vote buffer (not the aggregated tally), so you
 * can tell whether votes are being received at all versus a matching/logic
 * issue further downstream.
 */
function pollStatusText(chatId) {
  const pollId = latestPollIdByChat.get(chatId);
  const pollState = pollId && activePolls.get(pollId);
  if (!pollState) {
    return 'No poll on record for this chat -- create one with "' + TRIGGER_PREFIX + ' create a poll for <N>".';
  }
  const voters = [...pollState.voteBuffer.keys()].map(nameFor);
  const playAtLocal = pollState.playAt ? new Date(pollState.playAt).toLocaleString() : 'unknown';
  return [
    `Poll ${pollId}${pollState.when ? ` (${pollState.when})` : ''}: ${pollState.size} spots.`,
    `Status: ${pollState.status}`,
    `Play time: ${playAtLocal} (auto-deleted ${POLL_EXPIRY_GRACE_HOURS}h after this if not already gone)`,
    `Raw votes recorded: ${pollState.voteBuffer.size}`,
    `Voters seen so far: ${voters.length ? voters.join(', ') : '(none yet)'}`
  ].join('\n');
}

// ---- LLM Q&A ----

/**
 * Builds a short summary of current availability, leaderboard, and any
 * active poll to give the LLM real context instead of letting it guess.
 */
function buildContextBlurb(chatId) {
  const availability = storage.getAvailability();
  const board = storage.getLeaderboard();
  const recent = storage.getRecentMatches(5);

  const availabilityText = availability.length
    ? availability.map((a) => `${a.player} (${a.when})`).join(', ')
    : 'no one has marked themselves free right now';

  const leaderboardText = board.length
    ? board.slice(0, 5).map((p) => `${p.name}: ${p.wins}W-${p.losses}L`).join(', ')
    : 'no matches recorded yet';

  const recentText = recent.length
    ? recent.map((m) => `${m.winner} def ${m.loser} (${m.score})`).join('; ')
    : 'none';

  const pollId = latestPollIdByChat.get(chatId);
  const pollState = pollId && activePolls.get(pollId);
  let pollText = 'no active poll';
  if (pollState) {
    const filledCount = pollState.voteBuffer.size;
    const whenSuffix = pollState.when ? ` for ${pollState.when}` : '';
    if (pollState.status === 'resolved') {
      pollText = `a ${pollState.size}-spot poll${whenSuffix} just filled up and matchups were posted`;
    } else if (pollState.status === 'cancelled') {
      pollText = `a ${pollState.size}-spot poll${whenSuffix} was cancelled`;
    } else {
      pollText = `a ${pollState.size}-spot poll${whenSuffix} is active with ${filledCount}/${pollState.size} votes so far`;
    }
  }

  return (
    `Current availability: ${availabilityText}\n` +
    `Leaderboard (top 5): ${leaderboardText}\n` +
    `Recent matches: ${recentText}\n` +
    `Active poll: ${pollText}`
  );
}

/**
 * Calls the Anthropic API with tools, recent chat history, and live context.
 * Enables Claude to handle free-form poll creation requests while answering
 * any other questions in the same message.
 */
async function callClaude(sock, chatId, sender, promptText) {
  const history = chatHistories.get(chatId) || [];

  const userMessage = { role: 'user', content: `${sender}: ${promptText}` };
  const messages = [...history, userMessage];

  const systemWithContext = `${SYSTEM_PROMPT}\n\n${buildContextBlurb(chatId)}`;

  const makeApiCall = async (msgs) => {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        system: systemWithContext,
        tools: CLAUDE_TOOLS,
        messages: msgs
      })
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Anthropic API error ${response.status}: ${errBody}`);
    }

    return await response.json();
  };

  let data = await makeApiCall(messages);
  const toolUseBlocks = data.content?.filter((b) => b.type === 'tool_use') || [];

  if (toolUseBlocks.length > 0) {
    const toolResults = [];
    for (const toolUse of toolUseBlocks) {
      const result = await executeTool(sock, chatId, sender, toolUse);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: typeof result === 'string' ? result : JSON.stringify(result)
      });
    }

    const followUpMessages = [
      ...messages,
      { role: 'assistant', content: data.content },
      { role: 'user', content: toolResults }
    ];

    data = await makeApiCall(followUpMessages);
  }

  const replyText = data.content
    ?.filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  const updatedHistory = [
    ...messages,
    { role: 'assistant', content: replyText || '' }
  ].slice(-HISTORY_LIMIT * 2);
  chatHistories.set(chatId, updatedHistory);

  return replyText;
}

startBot();
