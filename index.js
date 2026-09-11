/**
 * Tennis Group Bot (Baileys edition)
 * ----------------------------------
 * Listens for messages in a WhatsApp tennis group and helps with:
 *   - Coordinating who's free to play (!free, !notfree)
 *   - Tracking match results / a simple leaderboard (!score, !leaderboard)
 *   - Weather checks for outdoor play (!weather)
 *   - Scheduling matches via WhatsApp polls:
 *       - Fixed spots: "@tenbot create a poll for 2" (singles) or "@tenbot create a poll for 8" (doubles).
 *         The creator is automatically Player 1 (unless specified otherwise or if they already have
 *         another match poll within 1 hour), with votes starting from Player 2. Once all spots fill,
 *         the bot automatically posts singles/doubles matchups with rotations.
 *       - Opt-in (Yes/No): "@tenbot create a poll for tomorrow 9am" (no size specified). Creates a
 *         Yes/No poll. The bot waits for a user prompt ("@tenbot generate matchups" or "!matchups")
 *         to create matchups for players who voted Yes.
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
const {
  generateMatchups,
  formatMatchups,
  summarizeSchedule,
  findMatchupFor
} = require('./lib/matchups');
const { parseScoreReport } = require('./lib/scoreReport');
const pairHistory = require('./lib/pairHistory');
const ratings = require('./lib/ratings');
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
  "access to tools to create match polls (fixed-spot polls for 2 singles or 4/8/12 doubles, " +
  "or Yes/No opt-in polls when no number of players is specified), generate matchups from poll votes, " +
  "check weather, cancel polls, and access the group's availability list, win/loss leaderboard, " +
  'and active polls (given below). Multiple polls can be created for different times or by different users. ' +
  'Results can be reported to you in plain words ("Mike & Sara ' +
  'beat John & Alex 6-4", or "we won" right after a draw) and are logged automatically before ' +
  "you see the message, so don't claim you can't record scores. " +
  'If the user asks to create a poll without specifying the number of players (e.g. "create a poll for tomorrow 9am"), ' +
  'call create_poll without size to create a Yes/No opt-in poll. For Yes/No polls, matchups are created when ' +
  'the user prompts to create/generate matchups (using generate_matchups). ' +
  'For fixed-spot polls, by default the user asking to create the poll is Player 1 ' +
  'unless they explicitly state they are not playing or they already have another match poll scheduled within 1 hour. ' +
  'When a message contains a request to create a poll alongside other questions, call the create_poll tool and answer the other questions naturally.';

// Tools exposed to Claude for handling natural language requests
const CLAUDE_TOOLS = [
  {
    name: 'create_poll',
    description: 'Creates and sends a WhatsApp poll for organizing a tennis match in the group. If size is specified (2 for singles, 4/8/12 for doubles), creates numbered slot spots where creator is Player 1 by default. If size is omitted or not specified, creates an opt-in poll with only two options (Yes and No) where players vote Yes to opt in.',
    input_schema: {
      type: 'object',
      properties: {
        size: {
          type: 'integer',
          description: 'Total number of players for the match (2 for singles, 4/8/12/16 for doubles). If omitted or not specified, a Yes/No opt-in poll is created.'
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
        },
        includeCreator: {
          type: 'boolean',
          description: 'Whether the user requesting the fixed-spot poll is playing in it. Defaults to true unless the user explicitly mentions they are not playing.'
        }
      }
    }
  },
  {
    name: 'generate_matchups',
    description: 'Generates and posts singles/doubles matchups and rotations from the current poll votes. For Yes/No opt-in polls, considers only players who voted Yes. Also used when user asks to make the draw, create matchups, or rematch.',
    input_schema: {
      type: 'object',
      properties: {}
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

// Generic placeholder names that shouldn't match across different users by name alone
const GENERIC_NAMES = new Set(['someone', 'player', 'player 1', 'player 2', 'player 3', 'player 4', 'me']);

// Last free-form result recorded per chat: chatId -> { signature, at }.
// Unlike "!score", saying a result in words isn't a deliberate act of logging,
// so an identical one arriving again within the window below is treated as the
// same result being restated rather than a second set with the same score.
// In memory only -- a restart just reopens the window.
const recentFreeformScores = new Map();
const FREEFORM_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

// Active WhatsApp socket reference
let botSock = null;

// Poll-related state is persisted to poll-state.json so polls survive a bot
// restart. Loaded once here at startup; storeKey() below is used both for
// the in-memory maps and as the persisted key format.
const {
  messageStore,   // `${remoteJid}:${id}` -> stored WAMessage content, needed for getMessage() and vote decoding
  activePolls,    // pollId -> { remoteJid, size, type, when, playAt, status, creator, lastConflictSignature, voteBuffer, lastPlayers }
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
 * Removes a leading TRIGGER_PREFIX and nothing else, so "@tenbot Mike beat
 * John 6-4" can be read as a result while an occurrence further in stays put.
 *
 * That distinction matters here because a player is named "tenbot":
 * isAddressedToBot strips the trigger wherever it appears, which is right for
 * a question but would quietly delete a player from a result.
 */
function stripLeadingTrigger(text) {
  if (!TRIGGER_PREFIX) return text;
  const baseName = escapeRegex(TRIGGER_PREFIX.replace(/^@/, ''));
  return text.replace(new RegExp(`^@?${baseName}[:,]?\\s*`, 'i'), '').trim();
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
 * Checks if two identities (JID and/or display name) represent the same user.
 */
function isSameUser(jid1, jid2, name1, name2) {
  const k1 = ratings.keyFor(name1);
  const k2 = ratings.keyFor(name2);
  if (k1 && k2 && !GENERIC_NAMES.has(k1) && !GENERIC_NAMES.has(k2) && k1 === k2) {
    return true;
  }
  if (!jid1 || !jid2) return false;
  const norm1 = jidNormalizedUser(jid1);
  const norm2 = jidNormalizedUser(jid2);
  if (norm1 && norm2 && norm1 === norm2) return true;
  const pn1 = lidToPn.get(norm1) || (norm1?.endsWith('@s.whatsapp.net') ? norm1 : null);
  const pn2 = lidToPn.get(norm2) || (norm2?.endsWith('@s.whatsapp.net') ? norm2 : null);
  if (pn1 && pn2 && pn1 === pn2) return true;
  const lid1 = pnToLid.get(norm1) || (norm1?.endsWith('@lid') ? norm1 : null);
  const lid2 = pnToLid.get(norm2) || (norm2?.endsWith('@lid') ? norm2 : null);
  if (lid1 && lid2 && lid1 === lid2) return true;
  return false;
}

/**
 * Checks whether a user is currently a player/creator/voter in a given poll.
 */
function isUserInPoll(pollState, userJid, userName) {
  if (!pollState) return false;

  // 1. Check if user is the creator (Player 1)
  if (pollState.creator) {
    if (isSameUser(pollState.creator.jid, userJid, pollState.creator.name, userName)) {
      return true;
    }
  }

  // 2. Check voteBuffer (active votes in this poll)
  if (pollState.voteBuffer && pollState.voteBuffer instanceof Map) {
    for (const voterJid of pollState.voteBuffer.keys()) {
      const voterName = nameFor(voterJid);
      if (isSameUser(voterJid, userJid, voterName, userName)) {
        return true;
      }
    }
  }

  // 3. Check lastPlayers if poll was resolved
  if (Array.isArray(pollState.lastPlayers)) {
    const userKey = ratings.keyFor(userName);
    const resolvedName = userJid ? nameFor(userJid) : null;
    const resolvedKey = resolvedName ? ratings.keyFor(resolvedName) : null;

    for (const p of pollState.lastPlayers) {
      const pKey = ratings.keyFor(p);
      if (GENERIC_NAMES.has(pKey)) continue;
      if (userKey && !GENERIC_NAMES.has(userKey) && pKey === userKey) return true;
      if (resolvedKey && !GENERIC_NAMES.has(resolvedKey) && pKey === resolvedKey) return true;
    }
  }

  return false;
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
      for (const key of messageStore.keys()) {
        if (key.endsWith(`:${pollId}`)) {
          messageStore.delete(key);
        }
      }
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
async function executeTool(sock, chatId, sender, toolUse, msg) {
  const { name, input } = toolUse;
  if (name === 'create_poll') {
    const size = input.size || null;
    const when = input.when || null;
    const dayWord = input.dayWord || null;
    const timeWord = input.timeWord || null;
    const includeCreator = input.includeCreator !== false;
    const creatorName = sender !== 'Someone' ? sender : (msg?.key?.participant ? nameFor(msg.key.participant) : 'Player 1');
    const creatorJid = msg?.key?.participant || msg?.key?.remoteJid || null;

    const res = await createMatchPoll(sock, chatId, size, when, dayWord, timeWord, creatorName, creatorJid, includeCreator);
    if (res?.err) {
      return `Failed to create poll: ${res.err}`;
    }
    if (res?.isOptIn) {
      return `Opt-in poll created with "Yes" and "No" options${when ? ` for ${when}` : ''}. Players can vote "Yes" to opt in. When ready, ask me to generate the matchups!`;
    }
    if (res?.includedCreator) {
      const needed = size - 1;
      return `Poll for ${size} spots (${size === 2 ? 'Singles' : 'Doubles'}${when ? ` -- ${when}` : ''}) created with ${creatorName} as Player 1 (${needed} spot(s) to vote on: Player 2..Player ${size}).`;
    } else {
      const note = res?.reason ? ` (${res.reason}, so not automatically added as Player 1)` : '';
      return `Poll for ${size} spots (${size === 2 ? 'Singles' : 'Doubles'}${when ? ` -- ${when}` : ''}) created with all ${size} spot(s) open to vote on: Player 1..Player ${size}${note}.`;
    }
  }
  if (name === 'generate_matchups' || name === 'rematch') {
    const res = await generateMatchupsFromPoll(sock, chatId);
    return res || 'Matchups generated and posted.';
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
    let targetPollId = null;
    for (const [pollId, pollState] of [...activePolls.entries()].reverse()) {
      if (pollState.remoteJid === chatId && pollState.status === 'active') {
        targetPollId = pollId;
        break;
      }
    }
    if (!targetPollId) {
      targetPollId = latestPollIdByChat.get(chatId);
    }
    if (!targetPollId || !activePolls.has(targetPollId)) return 'No active poll to cancel.';
    activePolls.get(targetPollId).status = 'cancelled';
    persistPolls();
    return 'Poll cancelled successfully.';
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

  if (lower === '!ratings') {
    return formatRatings();
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
    let targetPollId = null;
    for (const [pollId, pollState] of [...activePolls.entries()].reverse()) {
      if (pollState.remoteJid === chatId && pollState.status === 'active') {
        targetPollId = pollId;
        break;
      }
    }
    if (!targetPollId) {
      targetPollId = latestPollIdByChat.get(chatId);
    }
    if (!targetPollId || !activePolls.has(targetPollId)) return 'No active poll to cancel.';
    activePolls.get(targetPollId).status = 'cancelled';
    persistPolls();
    return 'Poll cancelled -- I won\'t auto-generate matchups from it anymore.';
  }

  if (lower === '!rematch' || lower === '!matchups' || lower === '!draw') {
    return await generateMatchupsFromPoll(sock, chatId);
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

  // --- Free-form score reports ---
  // A result can be announced with "!score" (handled further up) or in plain
  // words to the bot ("@tenbot Mike & Sara beat John & Alex 6-4"), so this sits
  // behind the trigger check and ahead of the LLM: results are recorded rather
  // than chatted about, but only when the message is unmistakably a result --
  // see lib/scoreReport.js. Group chatter the bot isn't addressed in has
  // already returned above and is never read as a score.
  const freeformScore = handleFreeformScore(
    [text, stripLeadingTrigger(text), promptText],
    chatId,
    sender
  );
  if (freeformScore) return freeformScore;

  // --- LLM (handles free-form queries, poll creation, weather, Q&A, etc.) ---
  try {
    return await callClaude(sock, chatId, sender, promptText, msg);
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
    '!score <winner> def <loser> <score> – record a match and update ratings, e.g. "!score Mike & Sara def John & Alex 6-4 6-2"',
    `  (or tell me in words: "${TRIGGER_PREFIX} Mike & Sara beat John & Alex 6-4", or "${TRIGGER_PREFIX} we won" after a draw – no score means 6-3)`,
    '!leaderboard – show the win/loss leaderboard',
    '!ratings – show player ratings used to balance the courts',
    '!weather [location] – forecast for outdoor play (defaults to ' + DEFAULT_LOCATION + ')',
    `${TRIGGER_PREFIX} create a poll [for <N>] – post a match poll (N spots for singles/doubles, or Yes/No opt-in if N is omitted)`,
    '!matchups (or !draw, !rematch) – generate matchups from Yes votes in an opt-in poll, or re-draw a completed poll',
    '!cancelpoll – stop the current poll from auto-generating matchups',
    '!pollstatus – debug: show raw vote count and voters for active poll(s)',
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

/** Splits a side into its players: "Mike & Sara", "Mike and Sara", "Mike". */
function parseSide(side) {
  return side
    .split(/\s*(?:&|\+|\band\b)\s*/i)
    .map((name) => name.trim())
    .filter(Boolean);
}

const formatSide = (names) => names.join(' & ');
const formatSets = (sets) => sets.map(([a, b]) => `${a}-${b}`).join(' ');

/**
 * Records an understood result: the match against the leaderboard, each set
 * against the ratings, and a reply saying what moved. Shared by "!score" and
 * free-form reports so both behave identically once parsed.
 */
function applyScoreReport({ winners, losers, sets, assumedScore = false, inferredOpponents = false }) {
  const winnerText = formatSide(winners);
  const loserText = formatSide(losers);
  const scoreText = formatSets(sets);

  storage.recordMatch(winnerText, loserText, scoreText);
  const { sets: rated, changes } = ratings.applyResult(winners, losers, sets);

  const lines = [`Recorded: ${winnerText} def ${loserText} (${scoreText}).`];

  const notes = [];
  if (assumedScore) notes.push(`no score given, so I assumed ${scoreText}`);
  if (inferredOpponents) notes.push("opponents from today's draw");
  if (notes.length > 0) lines.push(`(${notes.join('; ')})`);

  const upsets = rated.filter((s) => s.upset).length;
  if (upsets > 0) {
    lines.push(`${upsets === rated.length ? 'Upset' : `${upsets} upset set(s)`} -- the lower-rated pairing came through.`);
  }

  lines.push(...changes.map((c) => {
    const move = c.to === c.from ? 'no change' : `${c.to > c.from ? '▲' : '▼'} ${ratings.formatRating(Math.abs(c.to - c.from))}`;
    return `  ${c.name}: ${ratings.formatRating(c.from)} → ${ratings.formatRating(c.to)} (${move})`;
  }));
  lines.push('Check "!leaderboard" for standings, "!ratings" for ratings.');

  return lines.join('\n');
}

/**
 * Parses "!score <winner> def <loser> <score>", e.g.
 * "!score Mike def John 6-4 6-2" or "!score Mike & Sara def John & Alex 6-4 4-6 7-5"
 *
 * Unlike free-form reports, the command takes names as given rather than
 * insisting it already knows them -- asking for a score explicitly is enough
 * to mean it, and it's how a new player gets their first result logged.
 */
function handleScoreCommand(text) {
  const match = text.match(/^!score\s+(.+?)\s+def\s+(.+?)\s+((?:\d+\s*-\s*\d+[\s,]*)+)$/i);
  if (!match) {
    return 'Couldn\'t parse that. Use: !score <winner> def <loser> <score>\ne.g. "!score Mike def John 6-4 6-2" or "!score Mike & Sara def John & Alex 6-4 6-2"';
  }

  const [, winner, loser, score] = match;
  const winners = parseSide(winner);
  const losers = parseSide(loser);
  const sets = score.trim().split(/[\s,]+/).map((s) => s.split('-').map(Number));

  if (winners.length !== losers.length) {
    return `Both sides need the same number of players -- got ${winners.length} vs ${losers.length}.`;
  }

  return applyScoreReport({ winners, losers, sets });
}

/**
 * Every player the bot already knows, mapped from lowercased name to the
 * canonical spelling. Free-form parsing checks names against this so ordinary
 * chatter can't be mistaken for a result -- see lib/scoreReport.js.
 */
function knownPlayers(chatId) {
  const byKey = new Map();
  const add = (name) => {
    const key = ratings.keyFor(name);
    if (key && !byKey.has(key)) byKey.set(key, String(name).trim());
  };

  for (const p of ratings.getAllRatings()) add(p.name);
  for (const p of storage.getLeaderboard()) add(p.name);
  for (const a of storage.getAvailability()) add(a.player);

  for (const [, pollState] of activePolls.entries()) {
    if (pollState.remoteJid === chatId) {
      if (pollState.creator?.name) add(pollState.creator.name);
      for (const name of pollState.lastPlayers || []) add(name);
      if (pollState.voteBuffer && pollState.voteBuffer instanceof Map) {
        for (const voterJid of pollState.voteBuffer.keys()) add(nameFor(voterJid));
      }
    }
  }

  return byKey;
}

/** The most recent poll state for a chat, if there is one. */
function lastPollStateFor(chatId) {
  for (const [, pollState] of [...activePolls.entries()].reverse()) {
    if (pollState.remoteJid === chatId && (pollState.lastSchedule || pollState.lastPlayers)) {
      return pollState;
    }
  }
  const pollId = latestPollIdByChat.get(chatId);
  return (pollId && activePolls.get(pollId)) || null;
}

// First-person stand-ins for whoever sent the message. These resolve to just
// that player; when the draw shows they were playing doubles, findMatchupFor
// fills in the partner, so "we won" still credits the pairing.
const SELF_WORDS = new Set(['i', 'me', 'myself', 'we', 'us', 'my team', 'our team']);

/**
 * Handles a result told to the bot in plain words rather than via "!score",
 * e.g. "@tenbot Mike & Sara beat John & Alex 6-4" or "@tenbot we won" after a
 * draw. Returns null when the message isn't a result report, so the caller can
 * pass it on to the LLM as an ordinary question.
 */
function handleFreeformScore(candidates, chatId, sender) {
  const roster = knownPlayers(chatId);
  const lastSchedule = lastPollStateFor(chatId)?.lastSchedule;

  const self = roster.get(ratings.keyFor(sender)) || null;

  const options = {
    resolveName: (raw) => {
      const key = ratings.keyFor(raw);
      if (SELF_WORDS.has(key)) return self;
      return roster.get(key) || null;
    },
    findMatchup: (names, versus) => findMatchupFor(lastSchedule, names, versus)
  };

  // The same message with the bot's name removed to varying degrees, least
  // edited first. The bot can be addressed with a prefix or an @-mention, and a
  // player here is called "tenbot" -- so the reading that survives the fewest
  // edits is the one to trust.
  let report = null;
  for (const candidate of new Set(candidates.filter(Boolean))) {
    report = parseScoreReport(candidate, options);
    if (report) break;
  }

  if (!report) return null;

  const signature = [
    formatSide(report.winners),
    formatSide(report.losers),
    formatSets(report.sets)
  ].join('|').toLowerCase();

  const previous = recentFreeformScores.get(chatId);
  if (previous?.signature === signature && Date.now() - previous.at < FREEFORM_DUPLICATE_WINDOW_MS) {
    console.log(`[score] Ignoring repeat free-form result: ${signature}`);
    return null;
  }
  recentFreeformScores.set(chatId, { signature, at: Date.now() });

  console.log(
    `[score] Free-form result understood: ${formatSide(report.winners)} def ` +
    `${formatSide(report.losers)} (${formatSets(report.sets)})` +
    `${report.assumedScore ? ' [assumed score]' : ''}${report.inferredOpponents ? ' [inferred opponents]' : ''}`
  );

  return applyScoreReport(report);
}

/** Lists current player ratings, strongest first. */
function formatRatings() {
  const board = ratings.getAllRatings();
  if (board.length === 0) {
    return `Nobody's rated yet -- everyone starts at ${ratings.formatRating(ratings.INITIAL_RATING)} once they play a poll or a score is recorded.`;
  }
  const lines = board.map((p, i) => `${i + 1}. ${p.name} — ${ratings.formatRating(p.rating)}`);
  return `📊 Player ratings (${ratings.formatRating(ratings.MIN_RATING)}–${ratings.formatRating(ratings.MAX_RATING)}):\n${lines.join('\n')}`;
}

// ---- Poll creation & vote handling ----

/**
 * Creates and sends a WhatsApp poll.
 * - If size is given (2 for singles, 4/8/12 for doubles), numbered slots are created
 *   ("Player 2" .. "Player <size>" with creator as Player 1 by default).
 * - If size is omitted (null/undefined), creates an opt-in poll with only two options:
 *   "Yes" and "No". The bot then waits for a user prompt to generate matchups from Yes voters.
 */
async function createMatchPoll(sock, remoteJid, size = null, when = null, dayWord = null, timeWord = null, creatorName = null, creatorJid = null, includeCreator = true) {
  const isOptIn = !size;

  if (size !== null && size !== undefined) {
    if (!Number.isInteger(size) || size <= 0) {
      return { err: `Give me a valid number of players, e.g. "${TRIGGER_PREFIX} create a poll for 2" (singles) or "${TRIGGER_PREFIX} create a poll for 8" (doubles), or leave size empty for a Yes/No poll.` };
    }
    if (size !== 2 && size % 4 !== 0) {
      return { err: `Poll size needs to be 2 for singles or a multiple of 4 for doubles (e.g. 4, 8, 12) -- got ${size}.` };
    }
    if (size > 40) {
      return { err: 'That\'s a lot of players for one poll -- try 40 or fewer.' };
    }
  }

  const playAt = resolvePlayDateTime(dayWord, timeWord);
  let shouldIncludeCreator = includeCreator;
  let excludedReason = null;

  // Check if a poll already exists for the same person within one hour of the new poll's start time
  if (shouldIncludeCreator && (creatorJid || creatorName)) {
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const newPlayTime = playAt.getTime();

    for (const [existingPollId, existingPoll] of activePolls.entries()) {
      if (existingPoll.remoteJid !== remoteJid) continue;
      if (existingPoll.status === 'cancelled') continue;
      if (!existingPoll.playAt) continue;

      const existingPlayTime = new Date(existingPoll.playAt).getTime();
      if (Number.isNaN(existingPlayTime)) continue;

      if (Math.abs(newPlayTime - existingPlayTime) <= ONE_HOUR_MS) {
        if (isUserInPoll(existingPoll, creatorJid, creatorName)) {
          shouldIncludeCreator = false;
          const existingWhen = existingPoll.when || new Date(existingPoll.playAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
          excludedReason = `a poll already exists for ${creatorName || 'you'} within one hour of this start time (${existingWhen})`;
          console.log(`[poll] Not auto-adding ${creatorName || 'creator'} as Player 1 in new poll: already in poll ${existingPollId} within 1 hour`);
          break;
        }
      }
    }
  }

  let values;
  let titlePrefix;
  let matchType;

  if (isOptIn) {
    values = ['Yes', 'No'];
    matchType = 'Opt-in';
    titlePrefix = shouldIncludeCreator && creatorName
      ? `🎾 ${creatorName}'s match: Vote Yes/No to play!`
      : '🎾 Vote Yes/No to play!';
  } else {
    const startIdx = shouldIncludeCreator ? 2 : 1;
    const count = shouldIncludeCreator ? size - 1 : size;
    values = Array.from({ length: count }, (_, i) => `Player ${i + startIdx}`);
    matchType = size === 2 ? 'Singles' : `${size} spots`;
    titlePrefix = shouldIncludeCreator && creatorName
      ? `🎾 ${creatorName}'s match: Vote for a spot!`
      : '🎾 Vote for a spot!';
  }

  const suffix = when ? ` -- ${when}` : ' for today\'s matches';

  const sent = await sock.sendMessage(remoteJid, {
    poll: {
      name: `${titlePrefix} (${matchType}${suffix})`,
      values,
      selectableCount: 1
    }
  });

  const pollId = sent.key.id;

  messageStore.set(storeKey(sent.key.remoteJid, pollId), sent.message);
  activePolls.set(pollId, {
    remoteJid,
    size: isOptIn ? null : size,
    type: isOptIn ? 'opt_in' : 'fixed',
    when: when || null,
    playAt: playAt.toISOString(),
    status: 'active', // 'active' | 'resolved' | 'cancelled'
    creator: shouldIncludeCreator ? { name: creatorName || 'Player 1', jid: creatorJid || null } : null,
    lastConflictSignature: null,
    voteBuffer: new Map(), // voterJid -> raw pollUpdate entry
    lastPlayers: null
  });
  latestPollIdByChat.set(remoteJid, pollId);
  persistPolls();
  console.log(`[poll] Created poll ${pollId} (${isOptIn ? 'Yes/No opt-in' : `${size} spots`}, creator: ${shouldIncludeCreator ? (creatorName || 'Player 1') : 'none (not included)'}) in ${remoteJid}${when ? ` (${when})` : ''}, play time ${playAt.toISOString()}`);

  return { err: null, isOptIn, size, includedCreator: shouldIncludeCreator, reason: excludedReason };
}

/**
 * Handles an incoming poll vote (from either event path): decrypts it if
 * needed, merges it into our running tally for that poll, and if every slot
 * now has exactly one voter (for fixed-slot polls), posts matchups.
 * For Yes/No opt-in polls, updates vote tallies and waits for user command.
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

  // If this is a Yes/No opt-in poll, tally the votes and wait for user prompt
  if (pollState.type === 'opt_in' || pollState.size === null) {
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
    const yesOption = aggregated.find((o) => /^yes$/i.test(o.name.trim()));
    const noOption = aggregated.find((o) => /^no$/i.test(o.name.trim()));
    const yesCount = yesOption ? yesOption.voters.length : 0;
    const noCount = noOption ? noOption.voters.length : 0;
    console.log(`[poll] Opt-in poll ${pollId}: ${yesCount} Yes vote(s), ${noCount} No vote(s) recorded.`);
    return;
  }

  // Fixed-size poll handling
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
  const neededVotes = pollState.creator ? pollState.size - 1 : pollState.size;

  console.log(
    `[poll] Poll ${pollId}: ${filled.length}/${neededVotes} slot(s) filled (${pollState.size} players total), ` +
    `${conflicts.length} conflicting slot(s), ${pollState.voteBuffer.size} raw vote(s) buffered.`
  );

  if (conflicts.length > 0) {
    const signature = conflicts.map((c) => `${c.name}:${c.voters.sort().join(',')}`).join('|');
    if (pollState.lastConflictSignature !== signature) {
      pollState.lastConflictSignature = signature;
      persistPolls();
      const lines = conflicts.map((c) => {
        const names = c.voters.map((v) => nameFor(v)).join(', ');
        return `${c.name}: ${names}`;
      });
      await sock.sendMessage(pollState.remoteJid, {
        text: `⚠️ A couple of slots have more than one vote -- one person should switch to an open slot:\n${lines.join('\n')}`
      });
    }
    return; // don't generate matchups while there's a conflict
  }

  if (pollState.status !== 'active') return;

  if (filled.length === neededVotes) {
    // Build the player list in slot order.
    const bySlot = new Map(aggregated.map((o) => [o.name, o.voters[0]]));
    const players = [];

    if (pollState.creator) {
      const creatorDisplayName = pollState.creator.name || (pollState.creator.jid ? nameFor(pollState.creator.jid) : 'Player 1');
      players.push(creatorDisplayName);
      for (let i = 2; i <= pollState.size; i++) {
        const voterJid = bySlot.get(`${i}`) || bySlot.get(`Player ${i}`);
        players.push(voterJid ? nameFor(voterJid) : `Player ${i}`);
      }
    } else {
      for (let i = 1; i <= pollState.size; i++) {
        const voterJid = bySlot.get(`${i}`) || bySlot.get(`Player ${i}`);
        players.push(voterJid ? nameFor(voterJid) : `Player ${i}`);
      }
    }

    pollState.status = 'resolved';
    pollState.lastPlayers = players;
    persistPolls();

    console.log(`[poll] Poll ${pollId} filled -- posting matchups for: ${players.join(', ')}`);

    ratings.ensureRated(players);
    const schedule = generateMatchups(players);
    const header = pollState.when ? `📅 ${pollState.when}\n\n` : '';
    await sock.sendMessage(pollState.remoteJid, { text: header + formatMatchups(schedule) });
    pairHistory.recordDraw(pollId, schedule);

    // Kept so "we won" reports can work out who the opponents were.
    pollState.lastSchedule = summarizeSchedule(schedule);
    persistPolls();
  }
}

/**
 * Generates and posts matchups for a poll:
 * - For Yes/No opt-in polls: considers all players who voted Yes and generates matchups.
 * - For fixed-size polls / rematches: regenerates matchups from the recorded player list.
 */
async function generateMatchupsFromPoll(sock, chatId) {
  let targetPollId = null;
  let targetPollState = null;

  // 1. Look for active opt-in poll first
  for (const [pollId, pollState] of [...activePolls.entries()].reverse()) {
    if (pollState.remoteJid === chatId && pollState.status === 'active' && (pollState.type === 'opt_in' || pollState.size === null)) {
      targetPollId = pollId;
      targetPollState = pollState;
      break;
    }
  }

  // 2. Look for any active poll with votes
  if (!targetPollState) {
    for (const [pollId, pollState] of [...activePolls.entries()].reverse()) {
      if (pollState.remoteJid === chatId && pollState.status === 'active' && pollState.voteBuffer.size > 0) {
        targetPollId = pollId;
        targetPollState = pollState;
        break;
      }
    }
  }

  // 3. Look for any poll with resolved players (for rematch)
  if (!targetPollState) {
    for (const [pollId, pollState] of [...activePolls.entries()].reverse()) {
      if (pollState.remoteJid === chatId && pollState.lastPlayers) {
        targetPollId = pollId;
        targetPollState = pollState;
        break;
      }
    }
  }

  if (!targetPollState) {
    const pollId = latestPollIdByChat.get(chatId);
    targetPollState = pollId && activePolls.get(pollId);
    targetPollId = pollId;
  }

  if (!targetPollState) {
    return `No poll found to generate matchups from -- create one with "${TRIGGER_PREFIX} create a poll" first.`;
  }

  const mePn = jidNormalizedUser(sock?.user?.id || sock?.authState?.creds?.me?.id || '');

  // If this is a Yes/No opt-in poll, gather all "Yes" voters
  if (targetPollState.type === 'opt_in' || targetPollState.size === null) {
    let pollCreationMessage = messageStore.get(storeKey(targetPollState.remoteJid, targetPollId));
    if (!pollCreationMessage) {
      return 'Could not retrieve the poll creation message to decode votes.';
    }

    const merged = [...targetPollState.voteBuffer.values()].map((u) => ({
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
      return `Failed to calculate poll votes: ${err.message}`;
    }

    const yesOption = aggregated.find((o) => /^yes$/i.test(o.name.trim()));
    const yesVoters = yesOption ? yesOption.voters : [];
    const players = yesVoters.map((v) => nameFor(v));

    if (players.length === 0) {
      return 'No one has voted "Yes" yet in the opt-in poll.';
    }

    if (players.length === 1) {
      return `Only 1 player has voted "Yes" so far (${players[0]}). Need at least 2 for singles or 4 for doubles.`;
    }

    if (players.length !== 2 && players.length % 4 !== 0) {
      return `Got ${players.length} players who voted Yes: ${players.join(', ')}.\nNeed 2 players for singles or a multiple of 4 (4, 8, 12, etc.) for doubles to generate standard matchups.`;
    }

    targetPollState.status = 'resolved';
    targetPollState.lastPlayers = players;
    persistPolls();

    console.log(`[poll] Generating matchups for opt-in poll ${targetPollId} with ${players.length} Yes voter(s): ${players.join(', ')}`);

    ratings.ensureRated(players);
    const schedule = generateMatchups(players);
    const header = targetPollState.when ? `📅 ${targetPollState.when}\n\n` : '';
    await sock.sendMessage(targetPollState.remoteJid, { text: header + formatMatchups(schedule) });
    pairHistory.recordDraw(targetPollId, schedule);
    targetPollState.lastSchedule = summarizeSchedule(schedule);
    persistPolls();
    return null;
  }

  // Fixed-size poll with lastPlayers
  if (targetPollState.lastPlayers) {
    ratings.ensureRated(targetPollState.lastPlayers);
    const schedule = generateMatchups(targetPollState.lastPlayers);
    const header = targetPollState.when ? `📅 ${targetPollState.when}\n\n` : '';
    await sock.sendMessage(targetPollState.remoteJid, { text: header + formatMatchups(schedule) });
    pairHistory.recordDraw(targetPollId, schedule);
    targetPollState.lastSchedule = summarizeSchedule(schedule);
    persistPolls();
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
 * active poll(s), straight from the raw vote buffer (not the aggregated tally),
 * so you can tell whether votes are being received at all.
 */
function pollStatusText(chatId) {
  const chatPolls = [...activePolls.entries()].filter(([, state]) => state.remoteJid === chatId);
  if (chatPolls.length === 0) {
    return 'No poll on record for this chat -- create one with "' + TRIGGER_PREFIX + ' create a poll".';
  }

  const mePn = jidNormalizedUser(botSock?.user?.id || botSock?.authState?.creds?.me?.id || '');

  const sections = chatPolls.map(([pollId, pollState]) => {
    const playAtLocal = pollState.playAt ? new Date(pollState.playAt).toLocaleString() : 'unknown';

    if (pollState.type === 'opt_in' || pollState.size === null) {
      let yesVoters = [];
      let noVoters = [];
      try {
        const pollCreationMessage = messageStore.get(storeKey(pollState.remoteJid, pollId));
        if (pollCreationMessage) {
          const merged = [...pollState.voteBuffer.values()].map((u) => ({
            ...u,
            vote: normalizeVotePayload(u.vote)
          }));
          const aggregated = getAggregateVotesInPollMessage({ message: pollCreationMessage, pollUpdates: merged }, mePn);
          const yesOpt = aggregated.find((o) => /^yes$/i.test(o.name.trim()));
          const noOpt = aggregated.find((o) => /^no$/i.test(o.name.trim()));
          yesVoters = yesOpt ? yesOpt.voters.map((v) => nameFor(v)) : [];
          noVoters = noOpt ? noOpt.voters.map((v) => nameFor(v)) : [];
        }
      } catch (e) {}

      const lines = [
        `Poll ${pollId}${pollState.when ? ` (${pollState.when})` : ''}: Opt-in (Yes/No).`,
        `Status: ${pollState.status}`,
        `Play time: ${playAtLocal} (auto-deleted ${POLL_EXPIRY_GRACE_HOURS}h after this if not already gone)`,
        `Yes votes (${yesVoters.length}): ${yesVoters.length ? yesVoters.join(', ') : '(none yet)'}`,
        `No votes (${noVoters.length}): ${noVoters.length ? noVoters.join(', ') : '(none yet)'}`,
        'Matchups: Waiting for user prompt (!matchups or "@tenbot generate matchups")'
      ];
      return lines.join('\n');
    }

    const voters = [...pollState.voteBuffer.keys()].map(nameFor);
    const neededVotes = pollState.creator ? pollState.size - 1 : pollState.size;
    const lines = [
      `Poll ${pollId}${pollState.when ? ` (${pollState.when})` : ''}: ${pollState.size} spots (${pollState.size === 2 ? 'Singles' : 'Doubles'}).`,
      pollState.creator ? `Creator (Player 1): ${pollState.creator.name || 'Player 1'}` : 'Creator: None (all spots open)',
      `Status: ${pollState.status}`,
      `Play time: ${playAtLocal} (auto-deleted ${POLL_EXPIRY_GRACE_HOURS}h after this if not already gone)`,
      `Raw votes recorded: ${pollState.voteBuffer.size}/${neededVotes} needed`,
      `Voters seen so far: ${voters.length ? voters.join(', ') : '(none yet)'}`
    ];
    return lines.join('\n');
  });

  return sections.join('\n\n---\n\n');
}

// ---- LLM Q&A ----

/**
 * Builds a short summary of current availability, leaderboard, and any
 * active polls to give the LLM real context instead of letting it guess.
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

  const mePn = jidNormalizedUser(botSock?.user?.id || botSock?.authState?.creds?.me?.id || '');
  const chatPolls = [...activePolls.entries()].filter(([, state]) => state.remoteJid === chatId);
  let pollText = 'no active poll';
  if (chatPolls.length > 0) {
    const pollDescriptions = chatPolls.map(([id, pollState]) => {
      const whenSuffix = pollState.when ? ` for ${pollState.when}` : '';
      if (pollState.type === 'opt_in' || pollState.size === null) {
        let yesCount = 0;
        let noCount = 0;
        let yesNames = [];
        try {
          const pollCreationMessage = messageStore.get(storeKey(pollState.remoteJid, id));
          if (pollCreationMessage) {
            const merged = [...pollState.voteBuffer.values()].map((u) => ({
              ...u,
              vote: normalizeVotePayload(u.vote)
            }));
            const aggregated = getAggregateVotesInPollMessage({ message: pollCreationMessage, pollUpdates: merged }, mePn);
            const yesOpt = aggregated.find((o) => /^yes$/i.test(o.name.trim()));
            const noOpt = aggregated.find((o) => /^no$/i.test(o.name.trim()));
            yesCount = yesOpt ? yesOpt.voters.length : 0;
            noCount = noOpt ? noOpt.voters.length : 0;
            yesNames = yesOpt ? yesOpt.voters.map((v) => nameFor(v)) : [];
          }
        } catch (e) {}

        if (pollState.status === 'resolved') {
          return `[Poll ${id}] a Yes/No opt-in poll${whenSuffix} was resolved with ${yesCount} players (${yesNames.join(', ')}) and matchups were posted`;
        } else if (pollState.status === 'cancelled') {
          return `[Poll ${id}] a Yes/No opt-in poll${whenSuffix} was cancelled`;
        } else {
          return `[Poll ${id}] a Yes/No opt-in poll${whenSuffix} is active with ${yesCount} "Yes" vote(s) (${yesNames.join(', ') || 'none yet'}) and ${noCount} "No" vote(s). Waiting for user prompt to generate matchups`;
        }
      }

      const filledCount = pollState.voteBuffer?.size || 0;
      const neededVotes = pollState.creator ? pollState.size - 1 : pollState.size;
      const creatorSuffix = pollState.creator ? ` (created by ${pollState.creator.name || 'Player 1'}, who is Player 1)` : ' (all spots open)';
      if (pollState.status === 'resolved') {
        return `[Poll ${id}] a ${pollState.size}-spot poll${whenSuffix} filled up and matchups were posted`;
      } else if (pollState.status === 'cancelled') {
        return `[Poll ${id}] a ${pollState.size}-spot poll${whenSuffix} was cancelled`;
      } else {
        return `[Poll ${id}] a ${pollState.size}-spot poll${whenSuffix}${creatorSuffix} is active with ${filledCount}/${neededVotes} votes needed`;
      }
    });
    pollText = pollDescriptions.join('; ');
  }

  const rated = ratings.getAllRatings();
  const ratingsText = rated.length
    ? rated.map((p) => `${p.name}: ${ratings.formatRating(p.rating)}`).join(', ')
    : 'nobody rated yet';

  return (
    `Current availability: ${availabilityText}\n` +
    `Leaderboard (top 5): ${leaderboardText}\n` +
    `Recent matches: ${recentText}\n` +
    `Player ratings (${ratings.formatRating(ratings.MIN_RATING)}-${ratings.formatRating(ratings.MAX_RATING)}, a pairing's rating is the sum of its two players'): ${ratingsText}\n` +
    `Active poll: ${pollText}`
  );
}

/**
 * Calls the Anthropic API with tools, recent chat history, and live context.
 * Enables Claude to handle free-form poll creation requests while answering
 * any other questions in the same message.
 */
async function callClaude(sock, chatId, sender, promptText, msg) {
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
      const result = await executeTool(sock, chatId, sender, toolUse, msg);
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
