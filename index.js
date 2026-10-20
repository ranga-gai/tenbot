/**
 * Tennis Group Bot (Baileys edition)
 * ----------------------------------
 * Listens for messages in a WhatsApp tennis group and coordinates:
 *   - Tennis match polls & voting (fixed spots, Yes/No opt-in)
 *   - Player availability, lineups, and matchup rotations
 *   - Real-time SCVCC court availability, schedule, and reservations
 *   - Player ratings from TennisRecord.com, aliases, and leaderboard
 *   - Multi-group management & superadmin controls
 *   - Natural language queries answered by Claude with live context
 */

require('dotenv').config();

// Global error handlers to keep the process alive and log detailed diagnostics
process.on('uncaughtException', (err, origin) => {
  const timestamp = new Date().toISOString();
  console.error(`\n🚨 [${timestamp}] Uncaught Exception (${origin}):`, err && err.stack ? err.stack : err);
});

process.on('unhandledRejection', (reason, promise) => {
  const timestamp = new Date().toISOString();
  console.error(`\n🚨 [${timestamp}] Unhandled Promise Rejection:`, reason && reason.stack ? reason.stack : reason);
});

process.on('warning', (warning) => {
  console.warn(`⚠️ [${new Date().toISOString()}] Node.js Warning:`, warning.name, warning.message);
});

process.on('beforeExit', (code) => {
  console.log(`⚠️ [${new Date().toISOString()}] Node.js beforeExit event emitted (exitCode: ${code}). Event loop has no active tasks.`);
});

process.on('exit', (code) => {
  console.log(`ℹ️ [${new Date().toISOString()}] Process exited with code: ${code}`);
});

process.on('SIGINT', () => {
  console.log(`\n🛑 [${new Date().toISOString()}] Received SIGINT (Ctrl+C). Terminating gracefully.`);
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log(`\n🛑 [${new Date().toISOString()}] Received SIGTERM. Terminating gracefully.`);
  process.exit(0);
});

const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  DisconnectReason,
  Browsers
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

const stats = require('./lib/stats');
const ratings = require('./lib/ratings');
const pollStore = require('./lib/pollStore');
const namesStore = require('./lib/names');
const messageHistory = require('./lib/messageHistory');
const recurringPollsModule = require('./lib/recurringPolls');
const groupsConfig = require('./lib/groupsConfig');
const courtsConfig = require('./lib/courtsConfig');
const anthropic = require('./lib/anthropic');
const pollTime = require('./lib/pollTime');
const { resolvePlayDateTime, getSanJoseNow, getSanJoseParts } = pollTime;

// Claude Tools & Schemas (extracted to lib/claudeTools.js)
const { CLAUDE_TOOLS, CACHED_CLAUDE_TOOLS } = require('./lib/claudeTools');

// Modular Command Handlers (extracted to lib/commands/)
const {
  routeCommand,
  executeTool,
  groupCommands,
  courtCommands,
  playerCommands,
  recurringCommands,
  pollCommands,
  lineupCommands
} = require('./lib/commands');

const { nameFor } = playerCommands;

// ---- CONFIG ----

const TRIGGER_PREFIX = '@tenbot';
const GENERIC_NAMES = new Set(['someone', 'player', 'player 1', 'player 2', 'player 3', 'player 4', 'me']);
const DEFAULT_LOCATION = 'San Jose, CA';
const POLL_CLEANUP_INTERVAL_MINUTES = 15;
const POLL_REMINDER_CHECK_INTERVAL_MS = 60 * 1000;
const RECURRING_POLL_CHECK_INTERVAL_MS = 30 * 1000;
const RATINGS_REFRESH_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const HISTORY_LIMIT = 10;

const SYSTEM_PROMPT =
  'You are a helpful assistant in a WhatsApp group chat for a group of tennis ' +
  'players in San Jose, California (Pacific Time) who organize casual matches together. Keep replies short and ' +
  'conversational (1-3 sentences) unless asked for more detail. You have ' +
  "access to tools to create match polls (fixed-spot polls for 2 singles or 4/8/12 doubles, " +
  "or Yes/No opt-in polls when no number of players is specified), generate matchups from poll votes, " +
  "set/update player ratings, check weather, cancel/delete polls, schedule recurring match polls on specific days of the week or every day with customizable poll creation times, optional start date and end date (schedule_recurring_poll), modify recurring schedules including start/end dates (modify_recurring_poll), list recurring schedules (list_recurring_polls), pause recurring schedules indefinitely or until a specific date after which they resume automatically (pause_recurring_poll), resume recurring schedules (resume_recurring_poll), skip one or more upcoming instances of a recurring poll (skip_recurring_poll_instance), restore skipped instances (unskip_recurring_poll_instance), and access the group's availability list, win/loss leaderboard, " +
  'and active polls (given below). Multiple polls can be created for different times or by different users. ' +
  'The live local time in San Jose, CA is provided at the top of the context blurb below. ' +
  'Polls created manually by users for organizing tennis matches are passively tracked by the bot (marked as user-created / isManual). ' +
  'Non-match polls (such as food, social, or general polls) are not tracked. ' +
  'For tracked manual match polls, do not make any changes or auto-generate matchups when they fill up. ' +
  'Answer questions about manual match polls when asked (who voted, who is playing, current count, etc.). ' +
  'For manual match polls, the context blurb below provides the exact "Players currently in/playing" list based on the rules. ' +
  'When asked who is playing, who has voted, or how many spots are left, rely strictly on the provided "Players currently in/playing" list. ' +
  'Do NOT include the creator unless they actually voted or are explicitly listed in "Players currently in/playing". ' +
  'For polls starting at slot 1, extra players / creator are NEVER included while voting is still in progress (only when all vote slots are filled and count is invalid). ' +
  'When a user asks to generate matchups, create the draw, make teams, or rematch for ANY match poll (including manually created match polls, opt-in polls, or previously resolved polls), ' +
  'ALWAYS call the generate_matchups tool (or rematch tool). If the user asks to keep specific players on the same team or partner together (e.g. "keeping PlayerA and PlayerB in same team", "partner P1 with P2", "with X and Y together"), ALWAYS pass those players in fixedPairs as a 2D array of string pairs (e.g. fixedPairs: [["PlayerA", "PlayerB"]]) to generate_matchups or rematch. NEVER tell the user that a poll has ended, is closed, or is not active when they ask for matchups. ' +
  'If there are multiple polls or a specific poll is requested (e.g. "for 10am", "Tennis 8am"), pass pollId or pollName to generate_matchups. ' +
  'Results can be reported to you in plain words ("Mike & Sara ' +
  'beat John & Alex 6-4", or "we won" right after a draw) and are logged automatically before ' +
  "you see the message, so don't claim you can't record scores. " +
  'Initial ratings for new players are looked up from TennisRecord.com (defaulting to 3.49 if not found). ' +
  'Users can also change their own rating by addressing you (e.g. "@tenbot my rating is 4.0" or "@tenbot set my rating to 3.5") -- ' +
  'call the set_rating or reset_rating tool to update it. Group admins can also update or reset ratings for other players. ' +
  'When creating a poll: ' +
  '- ALWAYS call the create_poll tool directly when a user asks to create a poll. Never ask the user for confirmation before creating the poll, even if the creator already has other active polls in the group (the backend handles slot allocation and conflict separation automatically). ' +
  '- If only a start time was specified without a day (e.g. "create a poll for 6am" or "create a poll for 9am"): ' +
  '  leave dayWord empty/null and pass when with just the requested time (e.g. when="6am", timeWord="6am"). ' +
  '  The create_poll backend compares the start time against the current San Jose time: if the current time is greater than the start time, it automatically creates the poll for the next day with that start time (e.g. "Tomorrow 6am"); if the start time is upcoming today, it creates the poll for today at that start time. Do not add "Tomorrow" to when or dayWord unless the user explicitly said "tomorrow". ' +
  '- When checking the 90-minute conflict window against other polls from the same creator: evaluate the conflict window against the modified/actual scheduled start time (for instance, if a start time was rolled over to next day, evaluate against the next-day start time, NOT the original passed time today). ' +
  '- If the new poll start time is 90 minutes or more (including exactly 90 minutes away, e.g. 9:00am and 10:30am, or when rolled over to the next day) from the creator\'s other polls start times, create the poll immediately without requiring extra confirmation. ' +
  '- If both a day and time are specified (e.g. "today 9am", "Saturday 9am" when it is already Saturday evening) and that time has already passed in San Jose, ' +
  'do NOT create the poll -- ask the user to fix the day/time to an upcoming time. ' +
  'If the user asks to create a poll without specifying the number of players (e.g. "create a poll for tomorrow 9am"), ' +
  'call create_poll without size to create a Yes/No opt-in poll. For Yes/No polls, matchups are created when ' +
  'the user prompts to create/generate matchups (using generate_matchups). ' +
  'When cancelling or deleting a poll upon user request (e.g. "@tenbot cancel poll" or "@tenbot delete poll"), ' +
  'call cancel_poll, which will also delete the poll message from WhatsApp. ' +
  'If a poll is deleted directly in WhatsApp by a user or admin, it is automatically removed from tracking. ' +
  'If the user requests changes to an existing poll (e.g. changing the time, number of players, or day) and a new poll is created, ' +
  'set cancelExisting: true (or pass replacePollId) in create_poll so the older poll is automatically deleted from WhatsApp and replaced. ' +
  'For fixed-spot polls, by default the user asking to create the poll is Player 1 ' +
  'unless they explicitly state they are not playing or they already have another match poll scheduled within less than 90 minutes of the resolved play time. ' +
  'When a message contains a request alongside other questions, execute the appropriate tools and answer naturally.';

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn(
    '⚠️  No ANTHROPIC_API_KEY found in environment. Copy .env.example to .env ' +
    'and add your key, or LLM replies will fail.'
  );
}

if (groupsConfig.hasWhitelist()) {
  const whitelisted = groupsConfig.getWhitelistedGroups();
  console.log(`✅ Configured groups active from groups.json: [${whitelisted.join(', ')}]`);
} else {
  console.log('🌐 Multi-group mode (open): No groups configured in groups.json; bot will respond in all groups.');
}

courtsConfig.logCourtConfigs();

// In-memory conversation history per chat
const chatHistories = new Map();

// Active WhatsApp socket reference
let botSock = null;

// Poll-related state and voter mappings persisted per group
const {
  messageStore,
  activePolls,
  latestPollIdByChat,
  recurringPolls
} = pollStore.load();

const storeKey = (remoteJid, id) => `${remoteJid}:${id}`;

// Ensure all players in names.json have full names defaulted and ratings on startup
namesStore.defaultMissingFullNames();
ratings.syncRatingsWithNames();

function persistPolls(chatId = null) {
  pollStore.save({ messageStore, activePolls, latestPollIdByChat, recurringPolls }, chatId);
}

function getPollContext() {
  return {
    messageStore,
    activePolls,
    latestPollIdByChat,
    recurringPolls,
    persistPolls,
    targetGroupJid: groupCommands.getCachedTargetGroupJid(),
    groupMetadataCache: groupCommands.getGroupMetadataCache(),
    chatHistories,
    botSock
  };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Associates a JID / LID with a display name across all formats.
 */
function recordName(jid, name, explicitPn = null) {
  if (!jid || !name) return false;
  const trimmed = String(name).trim();
  if (!trimmed) return false;
  const raw = jid;
  const norm = jidNormalizedUser(jid);
  const canonicalId = namesStore.resolveCanonicalId(norm || raw);
  const existingName = namesStore.getName(canonicalId || norm || raw);
  const existingPn = namesStore.getPnByLid(canonicalId || norm || raw);

  const pn = explicitPn || (norm?.endsWith('@s.whatsapp.net') ? norm : (raw?.endsWith('@s.whatsapp.net') ? raw : null)) || existingPn;

  if (existingName && existingName === trimmed && existingPn && existingPn === pn) {
    return false;
  }
  namesStore.setName(canonicalId, trimmed, [], pn);
  return true;
}

/**
 * Checks whether an incoming message is addressed to the bot.
 */
function isAddressedToBot(text, msg, botJids, triggerPrefix = TRIGGER_PREFIX) {
  if (!triggerPrefix) return { addressed: true, promptText: text };

  const mentionedJids = msg?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
  const isDirectlyMentioned = mentionedJids.some((jid) => botJids.includes(jidNormalizedUser(jid)));

  const baseName = escapeRegex(triggerPrefix.replace(/^@/, ''));
  const prefixRegex = new RegExp(`^@${baseName}[:,]?\\s*`, 'i');
  const anywhereRegex = new RegExp(`@${baseName}[:,]?\\b`, 'ig');

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

function stripLeadingTrigger(text) {
  if (!TRIGGER_PREFIX) return text;
  const baseName = escapeRegex(TRIGGER_PREFIX.replace(/^@/, ''));
  return text.replace(new RegExp(`^@${baseName}[:,]?\\s*`, 'i'), '').trim();
}

function extractText(message) {
  if (!message) return null;
  const msg = message.ephemeralMessage?.message ||
    message.viewOnceMessage?.message ||
    message.viewOnceMessageV2?.message ||
    message.documentWithCaptionMessage?.message ||
    message;
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    msg.documentMessage?.caption ||
    msg.buttonsResponseMessage?.selectedButtonId ||
    msg.listResponseMessage?.singleSelectReply?.selectedRowId ||
    msg.templateButtonReplyMessage?.selectedId ||
    null
  );
}

/**
 * Builds context summary for Claude Q&A.
 */
function buildContextBlurb(chatId) {
  const sjTimeStr = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'long',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(new Date());

  const availability = stats.getAvailability();
  const board = stats.getLeaderboard();
  const recent = stats.getRecentMatches(5);

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
      const isOptIn = pollState.type === 'opt_in' || pollState.size === null || pollState.options?.some((o) => /^yes$/i.test(o.trim()));

      if (isOptIn) {
        const { interestedPlayers } = pollCommands.getPollVoters(id, pollState, mePn, messageStore);
        const yesNames = interestedPlayers || [];
        const yesCount = yesNames.length;
        if (pollState.status === 'cancelled') {
          return `[Poll ${id}] a Yes/No opt-in poll${whenSuffix} was cancelled`;
        }
        const creatorDesc = pollState.creator?.name ? ` (created by ${pollState.creator.name})` : '';
        const statusNote = pollState.status === 'resolved' ? 'status: resolved/drawn (can rematch)' : (pollState.status === 'stopped' ? 'status: stopped (voting stopped)' : (pollState.status === 'expired' ? 'status: expired (play time passed, can still generate matchups if requested)' : 'status: active'));
        return `[Poll ${id}] a Yes/No opt-in poll${whenSuffix}${creatorDesc} is tracked with ${yesCount} "Yes" vote(s) (${yesNames.join(', ') || 'none yet'}). (${statusNote})`;
      }

      if (pollState.isManual) {
        const { aggregated, interestedPlayers } = pollCommands.getPollVoters(id, pollState, mePn, messageStore);
        const optionDetails = [];
        for (const opt of aggregated) {
          const names = opt.voters.map(nameFor);
          if (names.length > 0) optionDetails.push(`${opt.name}: ${names.join(', ')}`);
        }
        const { players: playingPlayers, addedFromLabel, addedFromValidCount } = pollCommands.resolveManualPollPlayers(pollState, interestedPlayers);
        const creatorName = pollState.creator?.name || 'Someone';

        let additionNotes = [];
        if (addedFromLabel.length > 0) additionNotes.push(`[${addedFromLabel.join(', ')}] from poll slot labels`);
        if (addedFromValidCount.length > 0) additionNotes.push(`[${addedFromValidCount.join(', ')}] to reach valid player count`);
        const additionSuffix = additionNotes.length > 0 ? ` (includes ${additionNotes.join(' and ')})` : '';

        if (pollState.status === 'cancelled') {
          return `[Poll ${id}] a user-created manual match poll "${pollState.name || 'Match Poll'}" was cancelled`;
        }
        const statusNote = pollState.status === 'resolved' ? 'status: resolved/drawn (can generate matchups again / rematch)' : (pollState.status === 'filled' ? 'status: filled (all voting slots filled, waiting for matchup request)' : (pollState.status === 'stopped' ? 'status: stopped (voting stopped, call generate_matchups when ready)' : (pollState.status === 'expired' ? 'status: expired (play time passed, can still generate matchups if requested)' : 'status: active')));
        return `[Poll ${id}] a user-created manual match poll "${pollState.name || 'Match Poll'}" (created by ${creatorName}) is tracked with ${interestedPlayers.length} vote(s): [${optionDetails.join('; ') || 'no votes yet'}]. Players currently in/playing (${playingPlayers.length}): ${playingPlayers.join(', ')}${additionSuffix}. (${statusNote} -- when asked to generate matchups or draw, call generate_matchups)`;
      }

      const { aggregated } = pollCommands.getPollVoters(id, pollState, mePn, messageStore);
      const { players: currentPlayers, filledCount, totalSlotsCount } = pollCommands.resolveFixedPollRoster(pollState, aggregated);
      const hasPrebooked = Array.isArray(pollState.prebookedPlayers) && pollState.prebookedPlayers.length > 0;
      const creatorSuffix = pollState.creator && !hasPrebooked ? ` (created by ${pollState.creator.name || 'Player 1'}, who is Player 1)` : ' (all spots open)';
      const prebookedSuffix = hasPrebooked
        ? ` (includes prebooked spots: ${pollState.prebookedPlayers.map((p) => typeof p === 'string' ? `${p}'s Spot` : p.slotName).join(', ')})`
        : '';
      if (pollState.status === 'cancelled') {
        return `[Poll ${id}] a ${pollState.size}-spot poll${whenSuffix} was cancelled`;
      }
      const statusNote = pollState.status === 'resolved' ? 'status: resolved/drawn (can rematch)' : (pollState.status === 'filled' ? 'status: filled (all slots filled, waiting for matchup request)' : (pollState.status === 'stopped' ? 'status: stopped (voting stopped)' : (pollState.status === 'expired' ? 'status: expired (play time passed, can still generate matchups if requested)' : 'status: active')));
      return `[Poll ${id}] a ${pollState.size}-spot poll${whenSuffix}${creatorSuffix}${prebookedSuffix} is tracked with ${filledCount}/${totalSlotsCount} slots filled. Players currently in/playing (${currentPlayers.length}): ${currentPlayers.join(', ')}. (${statusNote})`;
    });
    pollText = pollDescriptions.join('; ');
  }

  const rated = ratings.getAllRatings();
  const ratingsText = rated.length
    ? rated.map((p) => `${p.name}: ${ratings.formatRating(p.rating)}`).join(', ')
    : 'nobody rated yet';

  const chatRecurring = [...recurringPolls.values()].filter((s) => !chatId.endsWith('@g.us') || s.remoteJid === chatId);
  let recurringText = 'none';
  if (chatRecurring.length > 0) {
    recurringText = chatRecurring.map((s) => `[ID: ${s.id}] ${s.size ? `${s.size} spots` : 'Opt-in'} for ${s.matchDisplay} (${s.daysDisplay || s.days || 'everyday'}) (posts at ${s.postDisplay}, status: ${s.enabled ? 'active' : 'paused'})`).join('; ');
  }

  const groupChatLog = messageHistory.formatRecentMessagesForContext(chatId);

  return (
    `Current time in San Jose, CA (Pacific Time): ${sjTimeStr}\n` +
    `Current availability: ${availabilityText}\n` +
    `Leaderboard (top 5): ${leaderboardText}\n` +
    `Recent matches: ${recentText}\n` +
    `Player ratings (${ratings.formatRating(ratings.MIN_RATING)}-${ratings.MAX_RATING}, a pairing's rating is the sum of its two players'): ${ratingsText}\n` +
    `Active poll: ${pollText}\n` +
    `Recurring daily polls: ${recurringText}\n\n` +
    `--- Group Chat History (Past 2 Weeks) ---\n${groupChatLog}\n--- End of Group Chat History ---`
  );
}

/**
 * Calls Claude with tools, chat history, and live context using prompt caching.
 */
async function callClaude(sock, chatId, sender, promptText, msg) {
  const history = chatHistories.get(chatId) || [];
  const userMessage = { role: 'user', content: `${sender}: ${promptText}` };
  const messages = [...history, userMessage];

  const systemBlocks = [
    {
      type: 'text',
      text: SYSTEM_PROMPT,
      cache_control: { type: 'ephemeral' }
    },
    {
      type: 'text',
      text: buildContextBlurb(chatId)
    }
  ];

  const context = getPollContext();
  const makeApiCall = async (msgs) => {
    return await anthropic.callAnthropicMessages({
      messages: msgs,
      system: systemBlocks,
      tools: CACHED_CLAUDE_TOOLS,
      maxTokens: 400
    });
  };

  let data = await makeApiCall(messages);
  const toolUseBlocks = data.content?.filter((b) => b.type === 'tool_use') || [];

  if (toolUseBlocks.length > 0) {
    const toolResults = [];
    for (const toolUse of toolUseBlocks) {
      const result = await executeTool(sock, chatId, sender, toolUse, msg, context);
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

  const replyText = anthropic.extractTextFromResponse(data);
  const updatedHistory = [
    ...messages,
    { role: 'assistant', content: replyText || '' }
  ].slice(-HISTORY_LIMIT * 2);
  chatHistories.set(chatId, updatedHistory);

  return replyText;
}

/**
 * Central response router for incoming messages.
 */
async function getResponse(sock, rawText, chatId, sender, msg) {
  const context = getPollContext();

  // 1. Check structured commands via modular router
  const handled = await routeCommand(sock, rawText, chatId, sender, msg, context);
  if (handled !== null) {
    return handled;
  }

  // 2. Check bot trigger (@tenbot or DM)
  const mePn = jidNormalizedUser(sock?.user?.id || sock?.authState?.creds?.me?.id || '');
  const meLid = jidNormalizedUser(sock?.user?.lid || sock?.authState?.creds?.me?.lid || '');
  const botJids = [mePn, meLid].filter(Boolean);

  const isDM = !chatId.endsWith('@g.us');
  const text = (rawText || '').trim();
  const { addressed, promptText } = isDM
    ? { addressed: true, promptText: stripLeadingTrigger(text) }
    : isAddressedToBot(text, msg, botJids);

  if (TRIGGER_PREFIX && !addressed) {
    return null;
  }
  if (!promptText) return null;

  // Direct recurring poll phrase
  const directRecurringParsed = recurringPollsModule.parseRecurringPollText(promptText);
  if (directRecurringParsed) {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await recurringCommands.handleRecurringCommand(sock, promptText, chatId, sender, senderJid, {
      ...context,
      cancelOrDeletePoll: (s, rJid, pId) => pollCommands.cancelOrDeletePoll(s, rJid, pId, context)
    });
  }

  // Direct poll creation phrase
  const directPollParsed = pollCommands.parsePollCreationText(promptText);
  if (directPollParsed) {
    return await pollCommands.handleDirectPollCreation(sock, chatId, sender, msg, directPollParsed, { isCommand: false }, context);
  }

  // Free-form score report
  const freeformScore = playerCommands.handleFreeformScore(
    [text, stripLeadingTrigger(text), promptText],
    chatId,
    sender,
    activePolls
  );
  if (freeformScore) return freeformScore;

  // LLM fallback
  try {
    return await callClaude(sock, chatId, sender, promptText, msg);
  } catch (err) {
    console.error('LLM call failed:', err);
    return "Sorry, I couldn't come up with a reply just now.";
  }
}

async function handleMessage(sock, msg, groupName) {
  if (!msg.message || msg.key.fromMe) return;

  const remoteJid = msg.key.remoteJid;
  const text = extractText(msg.message);
  if (!text) return;

  const sender = msg.pushName || 'Someone';
  const senderPn = msg.key?.participantPn ? jidNormalizedUser(msg.key.participantPn) : (msg.participantPn ? jidNormalizedUser(msg.participantPn) : null);
  if (msg.key.participant) {
    recordName(msg.key.participant, sender, senderPn);
  }

  messageHistory.recordMessage(
    remoteJid,
    sender,
    text,
    msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now(),
    false
  );

  console.log(`[${groupName}] ${sender}: ${text}`);

  const reply = await getResponse(sock, text.trim(), remoteJid, sender, msg);
  if (reply) {
    messageHistory.recordMessage(remoteJid, 'tenbot', reply, Date.now(), true);
    await sock.sendMessage(remoteJid, { text: reply });
  }
}

// Background sweeps
pollCommands.cleanupExpiredPolls(getPollContext());
setInterval(() => {
  pollCommands.cleanupExpiredPolls(getPollContext());
}, POLL_CLEANUP_INTERVAL_MINUTES * 60 * 1000);

setInterval(() => {
  if (botSock) pollCommands.checkAndSendPollReminders(botSock, getPollContext());
}, POLL_REMINDER_CHECK_INTERVAL_MS);

setInterval(() => {
  if (botSock) {
    recurringPollsModule.checkAndExecuteAdvanceBookings({
      sock: botSock,
      recurringPolls,
      persistPolls,
      preBookCourtsForMatch: (args) => pollCommands.preBookCourtsForMatch(args),
      activePolls,
      sendBookingNotifications: courtCommands.sendBookingNotifications
    }).catch((err) => console.error('[advance-booking] Error in sweep:', err.message));

    recurringPollsModule.checkAndPostRecurringPolls({
      sock: botSock,
      recurringPolls,
      persistPolls,
      createMatchPoll: (...args) => pollCommands.createMatchPoll(...args, getPollContext()),
      getTargetGroupJid: groupCommands.getTargetGroupJid,
      preBookCourtsForMatch: (args) => pollCommands.preBookCourtsForMatch(args),
      activePolls,
      sendBookingNotifications: courtCommands.sendBookingNotifications
    }).catch((err) => console.error('[recurring-poll] Error in sweep:', err.message));
  }
}, RECURRING_POLL_CHECK_INTERVAL_MS);

setTimeout(() => {
  ratings.refreshPeriodicRatings().catch((err) => console.error('Error in periodic ratings sweep:', err));
  setInterval(() => {
    ratings.refreshPeriodicRatings().catch((err) => console.error('Error in periodic ratings sweep:', err));
  }, RATINGS_REFRESH_CHECK_INTERVAL_MS);
}, 20 * 1000);

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    version,
    browser: Browsers.ubuntu('Chrome'),
    logger: pino({ level: 'silent' }),
    syncFullHistory: false,
    keepAliveIntervalMs: 25000,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    getMessage: async (key) => {
      return messageStore.get(storeKey(key.remoteJid, key.id));
    }
  });
  botSock = sock;

  const meName = sock.user?.name || state.creds?.me?.name;
  const meId = sock.user?.id || state.creds?.me?.id;
  const meLid = sock.user?.lid || state.creds?.me?.lid;
  const mePnNorm = meId ? jidNormalizedUser(meId) : null;
  const meLidNorm = meLid ? jidNormalizedUser(meLid) : null;
  if (meLidNorm && mePnNorm && meLidNorm !== mePnNorm) {
    namesStore.setMapping(meLidNorm, mePnNorm, meName);
  } else if (meLidNorm && meName) {
    recordName(meLidNorm, meName);
  }

  sock.ev.on('creds.update', saveCreds);

  function isTargetGroupContact(contactId) {
    const targetGroupJid = groupCommands.getCachedTargetGroupJid();
    if (!contactId || !targetGroupJid) return false;
    const norm = jidNormalizedUser(contactId);
    const targetMeta = groupCommands.getGroupMetadataCache().get(targetGroupJid);
    if (!targetMeta?.participants) return false;
    return targetMeta.participants.some((p) => {
      const pPn = jidNormalizedUser(p.id || p.jid);
      const pLid = jidNormalizedUser(p.lid);
      return pPn === norm || pLid === norm || contactId === p.id || contactId === p.lid;
    });
  }

  sock.ev.on('contacts.upsert', (contacts) => {
    try {
      for (const c of contacts) {
        const name = c.name || c.notify || c.verifiedName;
        if (name && c.id && isTargetGroupContact(c.id)) {
          const cPn = c.id.endsWith('@s.whatsapp.net') ? jidNormalizedUser(c.id) : (c.pn ? jidNormalizedUser(c.pn) : null);
          recordName(c.id, name, cPn);
        }
      }
    } catch (err) {
      console.error(`⚠️ [${new Date().toISOString()}] Error in contacts.upsert:`, err);
    }
  });

  sock.ev.on('contacts.update', (updates) => {
    try {
      for (const c of updates) {
        const name = c.name || c.notify || c.verifiedName;
        if (name && c.id && isTargetGroupContact(c.id)) {
          const cPn = c.id.endsWith('@s.whatsapp.net') ? jidNormalizedUser(c.id) : (c.pn ? jidNormalizedUser(c.pn) : null);
          recordName(c.id, name, cPn);
        }
      }
    } catch (err) {
      console.error(`⚠️ [${new Date().toISOString()}] Error in contacts.update:`, err);
    }
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Scan this QR code with WhatsApp (Linked Devices):');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output?.statusCode
        : null;
      const errorMsg = lastDisconnect?.error?.message || 'unknown error';
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      const reasonDesc = statusCode === 428
        ? 'Connection Terminated / closed by WhatsApp (routine transient disconnect)'
        : (statusCode === DisconnectReason.restartRequired ? 'Restart required by server' : errorMsg);

      console.log(
        `⚠️ [${new Date().toISOString()}] Connection closed (status: ${statusCode || 'unknown'}, reason: ${reasonDesc}).`,
        shouldReconnect ? 'Reconnecting in 3 seconds...' : 'Logged out -- delete auth_info_baileys/ and re-scan to log in again.'
      );

      if (shouldReconnect) {
        scheduleReconnect(3000);
      } else {
        console.warn(`🚨 [${new Date().toISOString()}] WhatsApp session reported logged out (status ${statusCode || 401}). If unintended, delete auth_info_baileys/ and restart to link again.`);
      }
    } else if (connection === 'open') {
      const currMeName = sock.user?.name || sock.authState?.creds?.me?.name;
      const currMeId = sock.user?.id || sock.authState?.creds?.me?.id;
      const currMeLid = sock.user?.lid || sock.authState?.creds?.me?.lid;
      const currMePn = currMeId ? jidNormalizedUser(currMeId) : null;
      const currMeLidNorm = currMeLid ? jidNormalizedUser(currMeLid) : null;
      if (currMeLidNorm && currMePn && currMeLidNorm !== currMePn) {
        namesStore.setMapping(currMeLidNorm, currMePn, currMeName);
      } else if (currMeLidNorm && currMeName) {
        recordName(currMeLidNorm, currMeName);
      }

      try {
        const groups = await sock.groupFetchAllParticipating();
        let allowedCount = 0;
        for (const [gId, gMeta] of Object.entries(groups)) {
          groupCommands.getGroupMetadataCache().set(gId, gMeta);
          if (groupsConfig.isGroupAllowed(gId, gMeta.subject)) {
            allowedCount++;
            if (!groupCommands.getCachedTargetGroupJid()) groupCommands.setTargetGroupJid(gId);
            namesStore.setGroupMembers(gId, gMeta.participants);
            console.log(`[groups] Pre-cached allowed group "${gMeta.subject}" (id: ${gId})`);

            if (gMeta.participants) {
              for (const p of gMeta.participants) {
                const rawPn = p.id || p.jid;
                const rawLid = p.lid;
                const pn = rawPn && rawPn.endsWith('@s.whatsapp.net') ? jidNormalizedUser(rawPn) : null;
                const lid = rawLid && rawLid.endsWith('@lid') ? jidNormalizedUser(rawLid) : (rawPn && rawPn.endsWith('@lid') ? jidNormalizedUser(rawPn) : null);
                const name = p.name || p.notify || p.verifiedName;
                if (pn && lid && pn !== lid) {
                  namesStore.setMapping(lid, pn, name);
                } else if (name) {
                  if (pn) recordName(pn, name);
                  if (lid) recordName(lid, name);
                }
              }
            }
          }
        }
        console.log(`✅ Tennis group bot is ready and listening for ${allowedCount} group(s).`);
      } catch (err) {
        console.error('[groups] Failed to pre-fetch groups on connection open:', err.message);
      }

      const context = getPollContext();
      pollCommands.checkAndSendPollReminders(sock, context);
      recurringPollsModule.checkAndExecuteAdvanceBookings({
        sock,
        recurringPolls,
        persistPolls,
        preBookCourtsForMatch: (args) => pollCommands.preBookCourtsForMatch(args),
        activePolls,
        sendBookingNotifications: courtCommands.sendBookingNotifications
      }).catch((err) => console.error('[advance-booking] Error in sweep:', err.message));

      recurringPollsModule.checkAndPostRecurringPolls({
        sock,
        recurringPolls,
        persistPolls,
        createMatchPoll: (...args) => pollCommands.createMatchPoll(...args, context),
        getTargetGroupJid: groupCommands.getTargetGroupJid,
        preBookCourtsForMatch: (args) => pollCommands.preBookCourtsForMatch(args),
        activePolls,
        sendBookingNotifications: courtCommands.sendBookingNotifications
      }).catch((err) => console.error('[recurring-poll] Error in sweep:', err.message));
    }
  });

  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    if (!id || !participants) return;
    try {
      const metadata = await groupCommands.getGroupMetadata(sock, id, recordName);
      if (metadata && metadata.participants) {
        namesStore.setGroupMembers(id, metadata.participants);
        for (const p of metadata.participants) {
          const rawPn = p.id || p.jid;
          const rawLid = p.lid;
          const pn = rawPn && rawPn.endsWith('@s.whatsapp.net') ? jidNormalizedUser(rawPn) : null;
          const lid = rawLid && rawLid.endsWith('@lid') ? jidNormalizedUser(rawLid) : (rawPn && rawPn.endsWith('@lid') ? jidNormalizedUser(rawPn) : null);
          const name = p.name || p.notify || p.verifiedName;
          if (pn && lid && pn !== lid) {
            namesStore.setMapping(lid, pn, name);
          } else if (name) {
            if (pn) recordName(pn, name);
            if (lid) recordName(lid, name);
          }
        }
      }
    } catch (e) {
      console.error('[group-participants] Error updating group participants:', e.message);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      const remoteJid = msg.key?.remoteJid;
      if (!remoteJid) continue;

      const isGroup = remoteJid.endsWith('@g.us');
      const isDirect = !isGroup && (remoteJid.endsWith('@s.whatsapp.net') || remoteJid.endsWith('@lid'));

      if (!isGroup && !isDirect) continue;

      let groupName = 'Direct Message';
      let isAllowedGroup = false;

      if (isGroup) {
        const metadata = await groupCommands.getGroupMetadata(sock, remoteJid, recordName);
        groupName = metadata?.subject || remoteJid;
        isAllowedGroup = groupsConfig.isGroupAllowed(remoteJid, groupName);

        if (!isAllowedGroup) continue;

        if (metadata?.participants && !namesStore.getGroupMembers(remoteJid)) {
          namesStore.setGroupMembers(remoteJid, metadata.participants);
        }
      } else if (isDirect) {
        const isSuper = groupsConfig.isSuperAdmin(remoteJid);
        const adminGroups = await groupCommands.getAdminGroupsForUser(sock, remoteJid);
        if (!isSuper && adminGroups.length === 0) {
          console.log(`[DM] Ignored direct message from non-admin user ${remoteJid}`);
          continue;
        }
      }

      // Revocation / deletion in WhatsApp
      const protocolMsg = msg.message?.protocolMessage;
      if (protocolMsg && (protocolMsg.type === 0 || protocolMsg.key?.id)) {
        const deletedId = protocolMsg.key?.id;
        if (deletedId && activePolls.has(deletedId)) {
          pollCommands.handlePollDeleted(remoteJid || protocolMsg.key?.remoteJid, deletedId, getPollContext());
        }
      }

      const senderPn = msg.key?.participantPn ? jidNormalizedUser(msg.key.participantPn) : (msg.participantPn ? jidNormalizedUser(msg.participantPn) : null);
      if (msg.pushName && msg.key?.participant) {
        recordName(msg.key.participant, msg.pushName, senderPn);
      } else if (msg.pushName && !msg.key?.fromMe && remoteJid && !remoteJid.endsWith('@g.us')) {
        recordName(remoteJid, msg.pushName, remoteJid.endsWith('@s.whatsapp.net') ? remoteJid : null);
      }

      // Poll creation message detection
      const pollCreation = msg.message?.pollCreationMessage || msg.message?.pollCreationMessageV2 || msg.message?.pollCreationMessageV3;
      if (pollCreation) {
        const pollId = msg.key.id;

        if (!activePolls.has(pollId)) {
          const pollName = pollCreation.name || 'Match Poll';
          const options = (pollCreation.options || []).map((o) => o.optionName);
          const creatorName = msg.pushName || (msg.key.participant ? nameFor(msg.key.participant) : 'Someone');
          const creatorJid = msg.key.participant || remoteJid || null;

          const interpretation = await pollCommands.interpretManualPollWithLLM(pollName, options, creatorName);
          if (!interpretation.isMatchScheduling) {
            console.log(`[poll] LLM interpreted poll ${pollId} ("${pollName}") as non-match scheduling in ${remoteJid}. Ignoring.`);
            continue;
          }

          messageStore.set(storeKey(remoteJid, pollId), msg.message);

          const hasExplicitDayInPollTitle = /\b(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i.test(pollName);
          const effectiveDayWord = interpretation.dayWord || null;
          const playAt = resolvePlayDateTime(effectiveDayWord, interpretation.timeWord);
          const sjNow = getSanJoseNow();
          const playParts = getSanJoseParts(playAt);
          const nowParts = getSanJoseParts(sjNow);
          const isTomorrow = playParts.day !== nowParts.day || playParts.month !== nowParts.month;

          let resolvedWhen = interpretation.when || pollName;
          if (isTomorrow && !hasExplicitDayInPollTitle) {
            if (resolvedWhen && !/\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i.test(resolvedWhen)) {
              resolvedWhen = `Tomorrow ${resolvedWhen}`;
            } else if (interpretation.timeWord && !/\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i.test(resolvedWhen)) {
              resolvedWhen = `Tomorrow ${interpretation.timeWord}`;
            } else if (!resolvedWhen) {
              resolvedWhen = 'Tomorrow';
            }
          }

          const pollType = interpretation.type || (options.some((opt) => /^yes$/i.test(opt.trim())) ? 'opt_in' : 'manual');
          const pollSize = interpretation.size !== undefined && interpretation.size !== null ? interpretation.size : (pollType === 'opt_in' ? null : (options.length > 0 ? options.length : null));
          const initialManualHours = (playAt.getTime() - Date.now()) / (60 * 60 * 1000);
          const manualSentReminders = [1, 2, 4, 8, 16, 24, 32, 64].filter((h) => h > initialManualHours && h > 1);

          activePolls.set(pollId, {
            remoteJid,
            name: pollName,
            options,
            size: pollSize,
            type: pollType,
            when: resolvedWhen,
            playAt: playAt.toISOString(),
            createdAt: new Date().toISOString(),
            status: 'active',
            isManual: true,
            creator: { name: creatorName, jid: creatorJid },
            lastConflictSignature: null,
            voteBuffer: new Map(),
            lastPlayers: null,
            sentReminders: manualSentReminders
          });
          latestPollIdByChat.set(remoteJid, pollId);
          persistPolls();

          if (creatorName && !ratings.isPlaceholder(creatorName) && !GENERIC_NAMES.has(ratings.keyFor(creatorName))) {
            const creatorLid = creatorJid ? namesStore.resolveCanonicalId(creatorJid) : null;
            ratings.ensureRated([{
              name: creatorName,
              jid: creatorJid,
              lid: creatorLid && creatorLid.endsWith('@lid') ? creatorLid : null
            }]).catch(() => {});
          }
          console.log(`[poll] LLM verified & passively tracking manually-created match poll ${pollId} ("${pollName}", when: "${resolvedWhen}", type: ${pollType}, size: ${pollSize}) by ${creatorName} in ${remoteJid}`);

          if (msg?.key && sock) {
            try {
              await sock.sendMessage(remoteJid, {
                react: {
                  text: '🤖',
                  key: msg.key
                }
              });
              console.log(`[poll] Added 🤖 reaction to tracked manual poll ${pollId} in ${remoteJid}`);
            } catch (err) {
              console.error('[poll] Failed to add 🤖 reaction to manual poll:', err.message);
            }
          }
        } else {
          messageStore.set(storeKey(remoteJid, pollId), msg.message);
        }
      }

      // Poll vote event
      if (msg.message?.pollUpdateMessage) {
        const pollUpdateMessage = msg.message.pollUpdateMessage;
        const pollKey = pollUpdateMessage.pollCreationMessageKey;
        if (pollKey && activePolls.has(pollKey.id)) {
          console.log(`[poll] Vote received via messages.upsert for poll ${pollKey?.id || '(unknown)'}`);
          try {
            await pollCommands.processPollVoteEvent(sock, pollKey, [{
              pollUpdateMessageKey: msg.key,
              vote: pollUpdateMessage.vote,
              senderTimestampMs: msg.messageTimestamp
            }], getPollContext());
          } catch (err) {
            console.error('Error handling poll vote (upsert path):', err && err.message ? err.message : err);
          }
        }
        continue;
      }

      try {
        await handleMessage(sock, msg, groupName);
      } catch (err) {
        console.error('Error handling message:', err && err.message ? err.message : err);
      }
    }
  });

  sock.ev.on('messages.update', async (updates) => {
    try {
      for (const { key, update } of updates) {
        const remoteJid = key?.remoteJid || update.key?.remoteJid;
        if (!remoteJid || !remoteJid.endsWith('@g.us')) continue;
        const metadata = await groupCommands.getGroupMetadata(sock, remoteJid, recordName);
        const groupName = metadata?.subject || remoteJid;
        if (!groupsConfig.isGroupAllowed(remoteJid, groupName)) continue;

        if (update && update.message === null) {
          const deletedId = key?.id || update.key?.id;
          if (deletedId && activePolls.has(deletedId)) {
            pollCommands.handlePollDeleted(remoteJid, deletedId, getPollContext());
          }
        }

        if (!update.pollUpdates) continue;
        if (!activePolls.has(key.id)) continue;
        console.log(`[poll] Vote received via messages.update for poll ${key.id} (${update.pollUpdates.length} entry/entries)`);
        try {
          await pollCommands.processPollVoteEvent(sock, key, update.pollUpdates, getPollContext());
        } catch (err) {
          console.error('Error handling poll update:', err && err.message ? err.message : err);
        }
      }
    } catch (err) {
      console.error(`⚠️ [${new Date().toISOString()}] Error in messages.update outer loop:`, err);
    }
  });

  sock.ev.on('messages.delete', async (item) => {
    try {
      const jid = item.jid || (Array.isArray(item.keys) && item.keys[0]?.remoteJid);
      if (jid && jid.endsWith('@g.us')) {
        const metadata = await groupCommands.getGroupMetadata(sock, jid, recordName);
        const groupName = metadata?.subject || jid;
        if (!groupsConfig.isGroupAllowed(jid, groupName)) return;
      }

      if (item.all && item.jid) {
        for (const [pollId, pollState] of [...activePolls.entries()]) {
          if (pollState.remoteJid === item.jid) {
            pollCommands.handlePollDeleted(item.jid, pollId, getPollContext());
          }
        }
      } else if (Array.isArray(item.keys)) {
        for (const key of item.keys) {
          if (key?.id && activePolls.has(key.id)) {
            pollCommands.handlePollDeleted(key.remoteJid, key.id, getPollContext());
          }
        }
      }
    } catch (err) {
      console.error(`⚠️ [${new Date().toISOString()}] Error in messages.delete:`, err);
    }
  });
}

let isStarting = false;
let reconnectTimeout = null;

function scheduleReconnect(delayMs = 3000) {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }
  reconnectTimeout = setTimeout(() => {
    reconnectTimeout = null;
    launchBot();
  }, delayMs);
}

async function launchBot() {
  if (isStarting) return;
  isStarting = true;
  try {
    if (botSock) {
      try {
        botSock.ev.removeAllListeners();
        botSock.end(undefined);
      } catch (e) { }
      botSock = null;
    }
    await startBot();
  } catch (err) {
    console.error(`💥 [${new Date().toISOString()}] Error during startBot():`, err && err.stack ? err.stack : err);
    console.log('🔄 Retrying in 5 seconds...');
    scheduleReconnect(5000);
  } finally {
    isStarting = false;
  }
}

if (require.main === module) {
  setInterval(() => {
    // Keeps event loop actively referenced
  }, 30000);

  launchBot();
}

module.exports = {
  createMatchPoll: (...args) => pollCommands.createMatchPoll(...args, getPollContext()),
  parsePollCreationText: pollCommands.parsePollCreationText,
  handleDirectPollCreation: (sock, chatId, sender, msg, parsed, opts) =>
    pollCommands.handleDirectPollCreation(sock, chatId, sender, msg, parsed, opts, getPollContext()),
  handleMessage,
  resolveManualPollPlayers: pollCommands.resolveManualPollPlayers
};
