/**
 * Tennis Group Bot (Baileys edition)
 * ----------------------------------
 * Listens for messages in a WhatsApp tennis group and helps with:
 *   - Coordinating who's free to play (!free, !notfree)
 *   - Tracking match results / a simple leaderboard (!score, !leaderboard)
 *   - Player ratings from TennisRecord.com, adjustable by users (@tenbot set my rating to 4.0, !setrating)
 *   - Weather checks for outdoor play (!weather)
 *   - Scheduling matches via WhatsApp polls:
 *       - Fixed spots: "@tenbot create a poll for 2" (singles) or "@tenbot create a poll for 8" (doubles).
 *         The creator is automatically Player 1 (unless specified otherwise or if they already have
 *         another match poll within less than 90 minutes), with votes starting from Player 2. Once all spots fill,
 *         the bot automatically posts singles/doubles matchups with rotations.
 *       - Opt-in (Yes/No): "@tenbot create a poll for tomorrow 9am" (no size specified). Creates a
 *         Yes/No poll. The bot waits for a user prompt ("@tenbot generate matchups" or "!matchups")
 *         to create matchups for players who voted Yes.
 *       - Direct Message Handling: Poll creation requests (e.g. "@tenbot create a poll for 4 tomorrow 9am",
 *         "@tenbot create a poll for 6am", "@tenbot create a poll for 10:30am for 4", "!createpoll 4 today 6pm")
 *         are parsed and handled directly by deterministic code without going through the LLM.
 *       - Manually Created Match Polls: The bot passively tracks user-created tennis match polls and their
 *         votes without making any changes or auto-generating matchups. It answers questions about them
 *         (who voted, who is playing, etc.) and generates matchups with the same court-balancing and rating rules
 *         IF AND ONLY IF users explicitly request it. When determining who is playing, the bot performs a label check first
 *         (if first slot > 1, adds leading extra players); if first slot is 1, it only applies the valid count check if all vote slots are filled.
 *         Non-match polls are not tracked.
 *       - Poll deletions & modifications: When cancelling/deleting a poll or modifying/replacing a poll,
 *         the bot also deletes the older poll message directly from WhatsApp. When a poll is deleted directly in WhatsApp
 *         by a user or admin, the bot detects it and removes it from active tracked polls.
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
const { parseLineup } = require('./lib/lineupParser');
const pairHistory = require('./lib/pairHistory');
const ratings = require('./lib/ratings');
const tennisRecord = require('./lib/tennisRecord');
const pollStore = require('./lib/pollStore');
const namesStore = require('./lib/names');
const messageHistory = require('./lib/messageHistory');
const { resolvePlayDateTime, getSanJoseNow, getSanJoseParts } = require('./lib/pollTime');

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
// automatically deleting it (kept for 2 weeks / 14 days so past draws, rematches,
// and matchup contexts remain accessible).
const POLL_EXPIRY_GRACE_DAYS = 14;

// How often to sweep for and delete completed/cancelled/expired polls.
const POLL_CLEANUP_INTERVAL_MINUTES = 15;

// Powers of 2 hours away from match playtime for sending reminders
// Reminder intervals away from match playtime: 10m (0.1667h), 1h, 2h, 4h, 8h, 16h, 32h, 64h
const POLL_REMINDER_HOURS = [0.1667, 1, 2, 4, 8, 16, 32, 64];
const POWERS_OF_2_REMINDER_HOURS = POLL_REMINDER_HOURS;
const POLL_REMINDER_CHECK_INTERVAL_MS = 60 * 1000;

// System prompt controlling the bot's personality/behavior
const SYSTEM_PROMPT =
  'You are a helpful assistant in a WhatsApp group chat for a group of tennis ' +
  'players in San Jose, California (Pacific Time) who organize casual matches together. Keep replies short and ' +
  'conversational (1-3 sentences) unless asked for more detail. You have ' +
  "access to tools to create match polls (fixed-spot polls for 2 singles or 4/8/12 doubles, " +
  "or Yes/No opt-in polls when no number of players is specified), generate matchups from poll votes, " +
  "set/update player ratings, check weather, cancel/delete polls, and access the group's availability list, win/loss leaderboard, " +
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
  'ALWAYS call the generate_matchups tool (or rematch tool). NEVER tell the user that a poll has ended, is closed, or is not active when they ask for matchups. ' +
  'If there are multiple polls or a specific poll is requested (e.g. "for 10am", "Tennis 8am"), pass pollId or pollName to generate_matchups. ' +
  'Results can be reported to you in plain words ("Mike & Sara ' +
  'beat John & Alex 6-4", or "we won" right after a draw) and are logged automatically before ' +
  "you see the message, so don't claim you can't record scores. " +
  'Initial ratings for new players are looked up from TennisRecord.com (defaulting to 3.49 if not found). ' +
  'Users can also change their own rating by addressing you (e.g. "@tenbot my rating is 4.0" or "@tenbot set my rating to 3.5") -- ' +
  'call the set_rating tool to update it. ' +
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

// Tools exposed to Claude for handling natural language requests
const CLAUDE_TOOLS = [
  {
    name: 'create_poll',
    description: 'Creates and sends a WhatsApp poll for organizing a tennis match in the group. Always call this tool directly when asked to create a poll without asking for user confirmation beforehand, even if the creator already has other polls (especially when the start time is 90 minutes or more away or rolled over to the next day). If size is specified (2 for singles, 4/8/12 for doubles), creates numbered slot spots where creator is Player 1 by default. If size is omitted or not specified, creates an opt-in poll with only two options (Yes and No) where players vote Yes to opt in. Note: users are in San Jose, CA (Pacific Time). If both day and time are given and in the past, poll creation is rejected. If only a start time is specified and the current time is greater than the start time, the poll is automatically created for the next day with that start time. If modifying/replacing an existing poll, set cancelExisting to true to delete the older poll from WhatsApp.',
    input_schema: {
      type: 'object',
      properties: {
        size: {
          type: 'integer',
          description: 'Total number of players for the match (2 for singles, 4/8/12/16 for doubles). If omitted or not specified, a Yes/No opt-in poll is created.'
        },
        when: {
          type: 'string',
          description: 'Human-readable day/time description (e.g. "9am", "6pm", "Tomorrow 9am", "Saturday 9am", "Tonight 6pm"). If user only specified a time, pass just that time (e.g. "9am").'
        },
        dayWord: {
          type: 'string',
          description: 'Day word explicitly mentioned by the user (e.g. "today", "tomorrow", "Saturday", "Sun"). If user only gave a time, omit this field or leave null.'
        },
        timeWord: {
          type: 'string',
          description: 'Time word mentioned in the request (e.g. "9am", "6:30pm", "7pm").'
        },
        includeCreator: {
          type: 'boolean',
          description: 'Whether the user requesting the fixed-spot poll is playing in it. Set to false ONLY if the user explicitly stated they are not playing (e.g. "I\'m not playing"). Do NOT set to false for time conflicts; the backend automatically checks conflicts on the resolved play date/time.'
        },
        cancelExisting: {
          type: 'boolean',
          description: 'Set to true if user requested changes to the current poll or is replacing an existing active poll. Deletes the older poll from WhatsApp.'
        },
        replacePollId: {
          type: 'string',
          description: 'Optional poll ID of an older/existing poll to cancel and delete from WhatsApp when creating this new poll.'
        }
      }
    }
  },
  {
    name: 'generate_matchups',
    description: 'Generates and posts singles/doubles matchups and rotations from current poll votes. Always call this tool when the user asks to generate matchups, draw, or make teams for a poll (whether active, filled, or resolved/rematch). For manual match polls, uses poll labels and adds creator / extra players (<creatorName>, <creatorName> 2, etc.) until a valid player count configuration is reached.',
    input_schema: {
      type: 'object',
      properties: {
        pollId: {
          type: 'string',
          description: 'Optional specific poll ID to generate matchups for if user specified or if multiple polls exist.'
        },
        pollName: {
          type: 'string',
          description: 'Optional poll name or time keyword (e.g. "8am", "10am", "Tennis 8am") to match the specific poll.'
        }
      }
    }
  },
  {
    name: 'add_alias',
    description: 'Adds an alias or nickname for a player so the bot recognizes them by either their full name or any of their aliases.',
    input_schema: {
      type: 'object',
      properties: {
        player: {
          type: 'string',
          description: 'The player full display name or existing alias.'
        },
        alias: {
          type: 'string',
          description: 'The new alias or nickname to associate with this player.'
        }
      },
      required: ['player', 'alias']
    }
  },
  {
    name: 'remove_alias',
    description: 'Removes an alias or nickname from a player.',
    input_schema: {
      type: 'object',
      properties: {
        player: {
          type: 'string',
          description: 'Optional player name if known.'
        },
        alias: {
          type: 'string',
          description: 'The alias or nickname to remove.'
        }
      },
      required: ['alias']
    }
  },
  {
    name: 'set_full_name',
    description: 'Sets or updates the full name for a player (or for the sender if player is omitted) and initializes/refreshes their rating from TennisRecord.com using the full name.',
    input_schema: {
      type: 'object',
      properties: {
        fullName: {
          type: 'string',
          description: 'The complete full name of the player (e.g. "Pramod Immaneni", "John Smith").'
        },
        player: {
          type: 'string',
          description: 'Optional display name or alias of the player to update. If omitted, updates the sender.'
        }
      },
      required: ['fullName']
    }
  },

  {
    name: 'set_rating',
    description: 'Sets or updates the rating for the user who sent the message (or for a named player if specified). Rating must be a number between 2.5 and 4.5.',
    input_schema: {
      type: 'object',
      properties: {
        rating: {
          type: 'number',
          description: 'The rating value to set (between 2.5 and 4.5, e.g. 3.0, 3.5, 4.0, 4.25).'
        },
        player: {
          type: 'string',
          description: 'Optional player name. If omitted, updates the sender\'s rating.'
        }
      },
      required: ['rating']
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
    description: 'Cancels the active match poll and deletes the poll message from WhatsApp.',
    input_schema: {
      type: 'object',
      properties: {
        pollId: {
          type: 'string',
          description: 'Optional specific poll ID to cancel and delete. If omitted, cancels the most recent active poll in this chat.'
        }
      }
    }
  },
  {
    name: 'rematch',
    description: 'Regenerates matchups and rotations from the current poll votes.',
    input_schema: {
      type: 'object',
      properties: {
        pollId: {
          type: 'string',
          description: 'Optional specific poll ID to regenerate matchups for.'
        },
        pollName: {
          type: 'string',
          description: 'Optional poll name or time keyword (e.g. "8am", "10am", "Tennis 8am") to match the specific poll.'
        }
      }
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
let targetGroupJid = null;

// Poll-related state and voter display name mappings are persisted to poll-state.json
// so voter identities survive a bot restart.
const {
  messageStore,   // `${remoteJid}:${id}` -> stored WAMessage content, needed for getMessage() and vote decoding
  activePolls,    // pollId -> { remoteJid, size, type, when, playAt, status, creator, lastConflictSignature, voteBuffer, lastPlayers, isManual }
  latestPollIdByChat // chatId -> pollId, so "!cancelpoll"/"!rematch"/"!pollstatus" know which poll to act on
} = pollStore.load();

const storeKey = (remoteJid, id) => `${remoteJid}:${id}`;

// Ensure all players in names.json have full names defaulted and ratings on startup
namesStore.defaultMissingFullNames();
ratings.syncRatingsWithNames();

function persistPolls() {
  pollStore.save({ messageStore, activePolls, latestPollIdByChat });
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Checks whether a poll title/options indicate a tennis match scheduling poll
 * rather than a general social/opinion poll (e.g. food, equipment, general banter).
 */
function isMatchSchedulingPoll(title = '', options = []) {
  const text = `${title} ${options.join(' ')}`.toLowerCase();
  const matchKeywords = /\b(tennis|match|matches|court|courts|singles|doubles|play|playing|players|player|game|games|drill|drills|session|hit|hitting|schedule|scheduling|scvcc)\b/i;
  const timeKeywords = /\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|morning|evening|afternoon)\b|\b\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)\b|\b\d{1,2}[:.]\d{2}\b/i;
  const slotKeywords = /\b(player|spot|slot|court)\s*\d+|\b\d+\b/i;
  const hasOptInOrSlot = options.some((opt) => /^(yes|no|in|out|playing|can't play)$/i.test(opt.trim()) || slotKeywords.test(opt.trim()));

  if (matchKeywords.test(text)) return true;
  if (timeKeywords.test(title) && hasOptInOrSlot) return true;
  return false;
}

/**
 * Uses LLM (Claude) to interpret manually created polls so there are no mistakes
 * in identifying whether it's a match scheduling poll, the scheduled day/time,
 * poll type, and spot count.
 */
async function interpretManualPollWithLLM(pollName, options, creatorName) {
  const fallback = () => {
    const isMatchScheduling = isMatchSchedulingPoll(pollName, options);
    const dayMatch = pollName.match(/\b(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i);
    const timeMatch = pollName.match(/\b(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm))\b/i) || pollName.match(/\b(\d{1,2}[:.]\d{2})\b/i);
    const hasYesNo = options.some((opt) => /^yes$/i.test(opt.trim())) && options.some((opt) => /^no$/i.test(opt.trim()));
    return {
      isMatchScheduling,
      dayWord: dayMatch ? dayMatch[1] : null,
      timeWord: timeMatch ? timeMatch[1] : null,
      when: pollName,
      type: hasYesNo ? 'opt_in' : 'manual',
      size: hasYesNo ? null : (options.length > 0 ? options.length : null)
    };
  };

  if (!process.env.ANTHROPIC_API_KEY) {
    return fallback();
  }

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

  const prompt = `You are a specialized interpreter for a tennis group chat bot in San Jose, CA (Pacific Time).
Current local time in San Jose: ${sjTimeStr}.

A user has just created a WhatsApp poll in the tennis group.
Poll Details:
- Title: "${pollName}"
- Options: [${options.map((o) => `"${o}"`).join(', ')}]
- Creator: "${creatorName}"

Please analyze this poll:
1. Is this poll for scheduling/organizing a tennis match, practice session, hitting, drill, or court play? (isMatchScheduling: true/false).
   (Note: Social polls, food orders, equipment banter, or non-tennis topics should be isMatchScheduling: false).
2. What day is it scheduled for? (e.g. "today", "tomorrow", "saturday", "sunday", or null if not mentioned).
3. What time is it scheduled for? (e.g. "9am", "6:30pm", "10am", or null if not mentioned).
4. Provide a clean human-readable when string (e.g. "Tomorrow 9am", "Saturday 6pm", "Today 8:30am", or null).
5. Poll type: "opt_in" for Yes/No polls, or "manual" for fixed/numbered slots.
6. Poll size: number of player spots (or null if opt-in).

Respond ONLY with a JSON object in this exact format, with no other text or markdown formatting:
{
  "isMatchScheduling": boolean,
  "dayWord": string or null,
  "timeWord": string or null,
  "when": string or null,
  "type": "opt_in" | "manual",
  "size": number or null
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      console.warn(`[poll-llm] Anthropic API returned ${response.status}, falling back to regex parser.`);
      return fallback();
    }

    const data = await response.json();
    const rawContent = data.content?.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    const cleanedJson = rawContent.replace(/^\`\`\`json\s*/i, '').replace(/\s*\`\`\`$/i, '').trim();
    const parsed = JSON.parse(cleanedJson);

    return {
      isMatchScheduling: Boolean(parsed.isMatchScheduling),
      dayWord: parsed.dayWord || null,
      timeWord: parsed.timeWord || null,
      when: parsed.when || pollName,
      type: parsed.type === 'opt_in' ? 'opt_in' : 'manual',
      size: typeof parsed.size === 'number' ? parsed.size : (parsed.type === 'opt_in' ? null : (options.length > 0 ? options.length : null))
    };
  } catch (err) {
    console.error('[poll-llm] Failed to interpret poll with LLM, using fallback:', err.message);
    return fallback();
  }
}

/**
 * Checks whether a given count of players is valid for standard matchups
 * (2 for singles, or any positive multiple of 4: 4, 8, 12, 16... for doubles).
 */
function isValidPlayerCount(n) {
  return n === 2 || (n >= 4 && n % 4 === 0);
}

/**
 * For manually created match polls: if the voting player count does not meet a valid configuration
 * (2 for singles, multiples of 4 for doubles), include the creator of the poll as one of the players.
 */
/**
 * Returns the next higher valid player count configuration (2 for singles, or multiples of 4 for doubles).
 */
function getNextValidPlayerCount(n) {
  if (n <= 2) return 2;
  return Math.ceil(n / 4) * 4;
}

/**
 * Extracts the slot number from the first option/label if present (e.g. "3", "Player 3", "Spot 3" -> 3).
 */
function getFirstSlotNumber(options) {
  if (!options || options.length === 0) return null;
  const firstLabel = String(options[0]).trim();
  const match = firstLabel.match(/^(?:player|spot|slot|court|#|no\.?|num\.?)\s*(\d+)\b/i) ||
                firstLabel.match(/\b(\d+)\b/);
  if (match) {
    const num = parseInt(match[1], 10);
    if (Number.isFinite(num) && num >= 1) return num;
  }
  return null;
}

/**
 * Adds the next available player name for the creator:
 * 1st: "<cname>", 2nd: "<cname> 2", 3rd: "<cname> 3", etc.
 */
function addNextCreatorPlayer(players, creatorName) {
  const creatorKey = ratings.keyFor(creatorName);
  const isCreatorInList = players.some((p) => ratings.keyFor(p) === creatorKey);
  if (!isCreatorInList && !GENERIC_NAMES.has(creatorKey)) {
    players.push(creatorName);
    return creatorName;
  }

  let suffix = 2;
  while (true) {
    const candidate = `${creatorName} ${suffix}`;
    const candidateKey = ratings.keyFor(candidate);
    if (!players.some((p) => ratings.keyFor(p) === candidateKey)) {
      players.push(candidate);
      return candidate;
    }
    suffix++;
  }
}

/**
 * For manually created match polls:
 * 1. Perform label check first: if the first label doesn't start with first player (e.g. 3 or Player 3),
 *    include extra players to count of one less than the first label (e.g. 3 - 1 = 2: "cname", "cname 2").
 * 2. Add current voters/players.
 * 3. For Valid Total Player Count Check (First Label Index 1 Only): only apply the valid count check
 *    for extra players if all vote slots have been filled (or for opt-in Yes/No polls).
 * 4. Extra player names are generated using the creator name: "cname", "cname 2", "cname 3", etc.
 */
function resolveManualPollPlayers(targetPollState, currentPlayers) {
  const creatorName = targetPollState.creator?.name || (targetPollState.creator?.jid ? nameFor(targetPollState.creator.jid) : 'Creator');
  const options = targetPollState.options || [];
  const firstSlotNum = getFirstSlotNumber(options);

  const players = [];
  const addedFromLabel = [];
  const addedFromValidCount = [];

  // 1. Perform label check first: if first label starts at slot > 1 (e.g. 3 or Player 3 -> needs (3-1)=2 leading extra players)
  if (firstSlotNum && firstSlotNum > 1) {
    const leadingNeeded = firstSlotNum - 1;
    for (let i = 0; i < leadingNeeded; i++) {
      const name = addNextCreatorPlayer(players, creatorName);
      addedFromLabel.push(name);
    }
  }

  // 2. Add current voters/players
  for (const p of currentPlayers) {
    if (!players.some((existing) => ratings.keyFor(existing) === ratings.keyFor(p))) {
      players.push(p);
    }
  }

  // 3. ONLY if first vote label has index 1 AND all vote slots have been filled, apply valid total player count check
  const isOptIn = targetPollState.type === 'opt_in' || options.some((o) => /^yes$/i.test(o));
  const isFirstVoteLabelSlot1 = firstSlotNum === 1 || (firstSlotNum === null && isOptIn);
  const allSlotsFilled = isOptIn || (options.length > 0 && currentPlayers.length >= options.length);

  if (isFirstVoteLabelSlot1 && allSlotsFilled && !isValidPlayerCount(players.length)) {
    const targetCount = getNextValidPlayerCount(players.length);
    while (players.length < targetCount) {
      const name = addNextCreatorPlayer(players, creatorName);
      addedFromValidCount.push(name);
    }
  }

  const addedExtra = [...addedFromLabel, ...addedFromValidCount];
  const addedCreator = addedExtra.includes(creatorName);
  return { players, addedCreator, addedExtra, addedFromLabel, addedFromValidCount };
}

/**
 * Extracts options, votes, and interested players from a poll.
 */
function getPollVoters(pollId, pollState, mePn) {
  let pollCreationMessage = messageStore.get(storeKey(pollState.remoteJid, pollId));
  const merged = [...(pollState.voteBuffer ? pollState.voteBuffer.values() : [])].map((u) => ({
    ...u,
    vote: normalizeVotePayload(u.vote)
  }));

  let aggregated = [];
  if (pollCreationMessage) {
    try {
      aggregated = getAggregateVotesInPollMessage(
        {
          message: pollCreationMessage,
          pollUpdates: merged
        },
        mePn
      );
    } catch (err) {
      console.error(`[poll] getAggregateVotesInPollMessage failed for ${pollId}:`, err.message);
    }
  }

  const yesOption = aggregated.find((o) => /^yes$/i.test(o.name.trim()));
  const noOption = aggregated.find((o) => /^no$/i.test(o.name.trim()));

  let interestedPlayers = [];
  if (pollState.type === 'opt_in' || yesOption) {
    const yesVoters = yesOption ? yesOption.voters : [];
    interestedPlayers = yesVoters.map((v) => nameFor(v));
  } else if (aggregated.length > 0) {
    for (const opt of aggregated) {
      if (/^(no|out|can't play|cannot play)$/i.test(opt.name.trim())) continue;
      for (const v of opt.voters) {
        const name = nameFor(v);
        if (!interestedPlayers.includes(name)) interestedPlayers.push(name);
      }
    }
  }

  if (interestedPlayers.length === 0 && pollState.voteBuffer && pollState.voteBuffer.size > 0 && !yesOption) {
    for (const voterJid of pollState.voteBuffer.keys()) {
      const name = nameFor(voterJid);
      if (!interestedPlayers.includes(name)) interestedPlayers.push(name);
    }
  }

  return { aggregated, interestedPlayers, yesOption, noOption };
}

/**
 * Parses a user's message to see if it is a poll creation request.
 * Returns the parsed poll parameters or null if not a poll creation request.
 */
function parsePollCreationText(text) {
  if (!text) return null;

  const isPollCreationCommand = /^!(?:createpoll|poll|makepoll|newpoll)\b/i.test(text);
  const isPollCreationPhrase = /\b(?:create|make|post|start|set\s*up|setup|open)\s+(?:a\s+)?(?:match\s+)?(?:singles\s+|doubles\s+)?poll\b|\bnew\s+(?:match\s+)?poll\b|\bpoll\s+for\b/i.test(text);

  if (!isPollCreationCommand && !isPollCreationPhrase) {
    return null;
  }

  // Extract timeWord first (e.g. 10:30am, 9am, 6:00pm)
  let timeWord = null;
  const timeMatch = text.match(/\b(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm))\b/i) || text.match(/\b(\d{1,2}[:.]\d{2})\b/i);
  if (timeMatch) {
    timeWord = timeMatch[1].trim();
  }

  // Extract dayWord (e.g. today, tomorrow, Saturday)
  let dayWord = null;
  const dayMatch = text.match(/\b(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i);
  if (dayMatch) {
    dayWord = dayMatch[1];
  }

  // Build when string
  let when = null;
  if (dayWord && timeWord) {
    const capDay = dayWord.charAt(0).toUpperCase() + dayWord.slice(1).toLowerCase();
    when = `${capDay} ${timeWord}`;
  } else if (timeWord) {
    when = timeWord;
  } else if (dayWord) {
    when = dayWord.charAt(0).toUpperCase() + dayWord.slice(1).toLowerCase();
  }

  // Remove time patterns from text before parsing size so that times like "10:30am" or "10am" don't match as size 10
  let textWithoutTime = text;
  if (timeMatch) {
    textWithoutTime = textWithoutTime.replace(timeMatch[0], ' ');
  }
  textWithoutTime = textWithoutTime.replace(/\b\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)\b/ig, ' ').replace(/\b\d{1,2}[:.]\d{2}\b/g, ' ');

  // Determine size
  let size = null;
  const sizeMatch = textWithoutTime.match(/\b(?:for|size|spots?|players?)\s*[:=]?\s*(\d+)\b/i) ||
                    textWithoutTime.match(/\b(\d+)\s*(?:spots?|players?|people|courts?)\b/i) ||
                    textWithoutTime.match(/\bpoll\s+for\s+(\d+)\b/i) ||
                    textWithoutTime.match(/^!(?:createpoll|poll|makepoll|newpoll)\s+(\d+)\b/i) ||
                    textWithoutTime.match(/\bcreate\s+(?:a\s+)?(?:match\s+)?poll\s+(\d+)\b/i) ||
                    textWithoutTime.match(/\b([248]|12|16)\s*(?:players?|spots?)?\b/i);
  if (sizeMatch) {
    size = parseInt(sizeMatch[1], 10);
  } else if (/\bsingles\b/i.test(textWithoutTime)) {
    size = 2;
  } else if (/\bdoubles\b/i.test(textWithoutTime)) {
    size = 4;
  }

  // Determine includeCreator
  let includeCreator = true;
  if (/\b(?:not\s+playing|won't\s+play|wont\s+play|without\s+me|exclude\s+me|not\s+for\s+me|i'm\s+not\s+playing|im\s+not\s+playing)\b/i.test(text)) {
    includeCreator = false;
  }

  // Determine cancelExisting / replacement
  let cancelExisting = false;
  if (/\b(?:replace|cancel\s+existing|cancel\s+previous|update\s+poll|change\s+poll|reschedule)\b/i.test(text)) {
    cancelExisting = true;
  }

  return {
    size,
    when,
    dayWord,
    timeWord,
    includeCreator,
    cancelExisting
  };
}

/**
 * Handles direct poll creation from parsed message parameters without calling the LLM.
 */
async function handleDirectPollCreation(sock, chatId, sender, msg, parsed) {
  const { size, when, dayWord, timeWord, includeCreator, cancelExisting } = parsed;
  const creatorName = sender !== 'Someone' ? sender : (msg?.key?.participant ? nameFor(msg.key.participant) : 'Player 1');
  const creatorJid = msg?.key?.participant || msg?.key?.remoteJid || null;
  const targetChatId = chatId.endsWith('@g.us') ? chatId : (await getTargetGroupJid(sock) || chatId);

  const res = await createMatchPoll(
    sock,
    targetChatId,
    size,
    when,
    dayWord,
    timeWord,
    creatorName,
    creatorJid,
    includeCreator,
    null,
    cancelExisting
  );

  if (res?.err) {
    return `Could not create poll: ${res.err}`;
  }

  const resolvedWhen = res?.when ? ` for ${res.when}` : (when ? ` for ${when}` : '');
  const replacedNote = res?.replacedOldPoll ? ' (older poll deleted from WhatsApp)' : '';

  if (res?.isOptIn) {
    return `Opt-in poll created with "Yes" and "No" options${resolvedWhen}${replacedNote}. Players can vote "Yes" to opt in. When ready, ask me to generate the matchups!`;
  }

  if (res?.includedCreator) {
    const needed = size - 1;
    return `Poll for ${size} spots (${size === 2 ? 'Singles' : 'Doubles'}${resolvedWhen}${replacedNote}) created with ${creatorName} as Player 1 (${needed} spot(s) to vote on: Player 2..Player ${size}).`;
  } else {
    const note = res?.reason ? ` (${res.reason}, so not automatically added as Player 1)` : '';
    return `Poll for ${size} spots (${size === 2 ? 'Singles' : 'Doubles'}${resolvedWhen}${replacedNote}) created with all ${size} spot(s) open to vote on: Player 1..Player ${size}${note}.`;
  }
}

/**
 * Checks whether an incoming message is addressed to the bot, matching any case
 * variation of TRIGGER_PREFIX (e.g. @tenbot, @Tenbot, @TENBOT, @TenBot - must start with @),
 * optional punctuation (colons, commas), or WhatsApp native @-mentions.
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

/**
 * Removes a leading TRIGGER_PREFIX and nothing else, so "@tenbot Mike beat
 * John 6-4" can be read as a result while an occurrence further in stays put.
 */
function stripLeadingTrigger(text) {
  if (!TRIGGER_PREFIX) return text;
  const baseName = escapeRegex(TRIGGER_PREFIX.replace(/^@/, ''));
  return text.replace(new RegExp(`^@${baseName}[:,]?\\s*`, 'i'), '').trim();
}

/**
 * Associates a JID / LID with a display name across all formats.
 */
function recordName(jid, name) {
  if (!jid || !name) return false;
  const trimmed = String(name).trim();
  if (!trimmed) return false;
  const raw = jid;
  const norm = jidNormalizedUser(jid);

  const canonicalId = namesStore.resolveCanonicalId(norm || raw);
  const pn = norm?.endsWith('@s.whatsapp.net') ? norm : (raw?.endsWith('@s.whatsapp.net') ? raw : null);
  namesStore.setName(canonicalId, trimmed, [], pn);
  return true;
}

/**
 * Checks if two identities (JID and/or display name) represent the same user.
 */
/**
 * Checks if a user is an admin or superadmin in a group.
 */
/**
 * Retrieves the target group JID (caching if necessary).
 */
async function getTargetGroupJid(sock) {
  if (targetGroupJid) return targetGroupJid;
  try {
    const groups = await sock.groupFetchAllParticipating();
    for (const [gId, gMeta] of Object.entries(groups)) {
      groupMetadataCache.set(gId, gMeta);
      if (gMeta.subject === TARGET_GROUP_NAME) {
        targetGroupJid = gId;
        return gId;
      }
    }
  } catch (err) {
    console.error('Failed to fetch participating groups:', err.message);
  }
  return null;
}

async function isUserAdmin(sock, remoteJid, senderJid) {
  if (!sock || !senderJid) return false;
  const targetJid = (remoteJid && remoteJid.endsWith('@g.us')) ? remoteJid : (await getTargetGroupJid(sock));
  if (!targetJid) return false;
  try {
    const metadata = await getGroupMetadata(sock, targetJid);
    if (!metadata?.participants) return false;

    const normUser = jidNormalizedUser(senderJid);
    const pnUser = namesStore.getPnByLid(normUser) || (normUser?.endsWith('@s.whatsapp.net') ? normUser : null);
    const lidUser = namesStore.resolveCanonicalId(normUser) || (normUser?.endsWith('@lid') ? normUser : null);

    const participant = metadata.participants.find((p) => {
      const pPn = jidNormalizedUser(p.id || p.jid);
      const pLid = jidNormalizedUser(p.lid);
      return (
        pPn === normUser ||
        pLid === normUser ||
        (pnUser && (pPn === pnUser || pLid === pnUser)) ||
        (lidUser && (pPn === lidUser || pLid === lidUser))
      );
    });

    return participant?.admin === 'admin' || participant?.admin === 'superadmin';
  } catch (err) {
    console.error('Failed to check admin status:', err.message);
    return false;
  }
}

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
  const lid1 = namesStore.resolveCanonicalId(norm1);
  const lid2 = namesStore.resolveCanonicalId(norm2);
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
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        metadata = await sock.groupMetadata(remoteJid);
        if (metadata) {
          groupMetadataCache.set(remoteJid, metadata);
          if (metadata.subject === TARGET_GROUP_NAME) {
            targetGroupJid = remoteJid;
          }
          break;
        }
      } catch (err) {
        if (attempt === 1) {
          await new Promise((r) => setTimeout(r, 300));
        } else {
          console.error(`Failed to fetch group metadata for ${remoteJid}:`, err.message);
        }
      }
    }
  }

  // Only record participant name and LID mappings for the target group
  const isTarget = (targetGroupJid && remoteJid === targetGroupJid) || (metadata?.subject === TARGET_GROUP_NAME);
  if (isTarget && metadata?.participants) {
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
 * Deletes a poll message directly from WhatsApp for everyone in the chat.
 */
async function deletePollFromWhatsApp(sock, remoteJid, pollId) {
  if (!sock || !remoteJid || !pollId) return;
  try {
    const key = {
      remoteJid,
      fromMe: true,
      id: pollId
    };
    await sock.sendMessage(remoteJid, { delete: key });
    console.log(`[poll] Deleted poll message ${pollId} from WhatsApp chat ${remoteJid}`);
  } catch (err) {
    console.error(`[poll] Failed to delete poll message ${pollId} from WhatsApp:`, err.message);
  }
}

/**
 * Handles deletion / revocation of a poll message in WhatsApp (whether deleted
 * manually by a user in the WhatsApp app, by an admin, or deleted by the bot).
 */
function handlePollDeleted(remoteJid, pollId) {
  if (!pollId) return;
  let changed = false;

  let chatId = remoteJid;
  if (activePolls.has(pollId)) {
    const pollState = activePolls.get(pollId);
    if (!chatId) chatId = pollState.remoteJid;
    const pollName = pollState.name || 'Match Poll';
    console.log(`[poll] Tracked poll ${pollId} ("${pollName}") was deleted in WhatsApp chat ${chatId}. Removing from active polls.`);
    activePolls.delete(pollId);
    changed = true;
  }

  // Remove from messageStore
  for (const key of messageStore.keys()) {
    if (key.endsWith(`:${pollId}`)) {
      messageStore.delete(key);
      changed = true;
    }
  }

  // Update latestPollIdByChat
  if (chatId && latestPollIdByChat.get(chatId) === pollId) {
    latestPollIdByChat.delete(chatId);
    for (const [id, state] of [...activePolls.entries()].reverse()) {
      if (state.remoteJid === chatId && (state.status === 'active' || state.status === 'filled')) {
        latestPollIdByChat.set(chatId, id);
        break;
      }
    }
    changed = true;
  } else {
    for (const [cId, id] of latestPollIdByChat.entries()) {
      if (id === pollId) {
        latestPollIdByChat.delete(cId);
        for (const [otherId, state] of [...activePolls.entries()].reverse()) {
          if (state.remoteJid === cId && (state.status === 'active' || state.status === 'filled')) {
            latestPollIdByChat.set(cId, otherId);
            break;
          }
        }
        changed = true;
      }
    }
  }

  if (changed) {
    persistPolls();
  }
}

/**
 * Cancels a poll internally and deletes the poll message from WhatsApp.
 */
async function cancelOrDeletePoll(sock, remoteJid, pollId) {
  if (!pollId) return;
  handlePollDeleted(remoteJid, pollId);
  await deletePollFromWhatsApp(sock, remoteJid, pollId);
}

/**
 * Deletes any poll whose scheduled play time (plus grace period) has
 * passed, regardless of whether it ended up resolved, cancelled, or just
 * never filled up. Runs once at startup (to clear anything stale from
 * before a restart) and on a recurring interval after that.
 */
function cleanupExpiredPolls() {
  const now = Date.now();
  const graceMs = POLL_EXPIRY_GRACE_DAYS * 24 * 60 * 60 * 1000; // Keep polls for 2 weeks (14 days)
  const removed = [];

  for (const [pollId, pollState] of activePolls.entries()) {
    if (!pollState.playAt) continue; // no play time recorded -- never auto-expire it
    const playAtMs = new Date(pollState.playAt).getTime();
    if (Number.isNaN(playAtMs)) continue;

    if (now > playAtMs + graceMs) {
      console.log(`[poll] Expiring poll ${pollId} ("${pollState.name || pollState.when}"): playAt=${pollState.playAt}, now=${new Date(now).toISOString()} (exceeded 2-week retention)`);
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
    console.log(`[poll] Cleaned up ${removed.length} expired/completed poll(s) older than 2 weeks: ${removed.join(', ')}`);
  }
  return removed;
}

// Purge anything stale from before this startup, then keep sweeping.
cleanupExpiredPolls();
setInterval(cleanupExpiredPolls, POLL_CLEANUP_INTERVAL_MINUTES * 60 * 1000);

/**
 * Builds engaging, creative, and escalating reminder text as match time gets closer.
 * Supports both fixed-spot and Yes/No opt-in match polls.
 */
function buildPollReminderText(H, pollState, openSpots, totalSpots, playerList, isOptIn = false, yesCount = 0) {
  const whenStr = pollState.when ? pollState.when : (pollState.name || 'today');
  const spotWord = openSpots === 1 ? 'spot' : 'spots';
  const playerWord = openSpots === 1 ? 'player' : 'players';

  if (isOptIn) {
    if (H >= 16) {
      return `⏰ *${H} Hours to Playtime!* We have *${yesCount} player(s) in* so far for *${whenStr}*.\n` +
        `Players in: ${playerList}\n` +
        `Don't miss out — cast your vote above to join the match!`;
    }
    if (H >= 8) {
      return `🎾 *8 Hours to Match Time!* We currently have *${yesCount} player(s) in* for *${whenStr}*.\n` +
        `Current lineup: ${playerList}\n` +
        `Who else is ready to play? Vote Yes in the poll above! 🎾⚡`;
    }
    if (H >= 4) {
      return `🔥 *4 Hours Until Court Time!* *${yesCount} player(s)* lined up for *${whenStr}*!\n` +
        `Roster: ${playerList}\n` +
        `Cast your vote above if you want in on today's session!`;
    }
    if (H >= 2) {
      return `⚡ *2 HOURS TO GO!* *${yesCount} player(s)* confirmed for *${whenStr}*!\n` +
        `Ready on court: ${playerList}\n` +
        `Vote Yes now before teams and matchups are drawn! 🎾🏃‍♂️💨`;
    }
    if (H >= 1) {
      return `🚨 *FINAL CALL: 1 HOUR LEFT!* *${yesCount} player(s) in* for *${whenStr}*!\n` +
        `Current roster: ${playerList}\n` +
        `Last chance to vote Yes before match time! 🏆🎾🔥`;
    }
    return `⚡ *10 MINUTES REMAINING!* *${yesCount} player(s) in* for *${whenStr}*!\n` +
      `Current roster: ${playerList}\n` +
      `Final countdown to vote Yes before matchups are locked in! 🏆🎾⚡`;
  }

  if (H >= 32) {
    return `🎾 *Match Alert:* The match poll for *${whenStr}* still has *${openSpots} open ${spotWord}* (${openSpots}/${totalSpots} needed).\n` +
      `Current players: ${playerList}\n` +
      `Vote in the poll above to lock in your spot!`;
  }
  if (H >= 16) {
    return `⏰ *${H} Hours to Playtime!* We have *${openSpots} ${spotWord} remaining* for *${whenStr}* (${openSpots}/${totalSpots} needed).\n` +
      `Roster so far: ${playerList}\n` +
      `Don't miss out — cast your vote above to join the court!`;
  }
  if (H >= 8) {
    return `🎾 *8 Hours to Match Time!* We still need *${openSpots} more ${playerWord}* to complete the court for *${whenStr}* (${totalSpots} total spots).\n` +
      `Current lineup: ${playerList}\n` +
      `Who's ready to hit some winners today? Claim your spot!`;
  }
  if (H >= 4) {
    return `🔥 *4 Hours Until Court Time!* Only *${openSpots} ${spotWord} left* for *${whenStr}*!\n` +
      `Lined up to play: ${playerList}\n` +
      `Racquets ready? Grab the open ${spotWord} before it fills up! 🎾⚡`;
  }
  if (H >= 2) {
    return `⚡ *2 HOURS TO GO!* We only need *${openSpots} more ${playerWord}* to make the match happen at *${whenStr}*!\n` +
      `Ready on court: ${playerList}\n` +
      `Don't leave the squad hanging — step up and claim the final ${spotWord}! 🎾🏃‍♂️💨`;
  }
  if (H >= 1) {
    return `🚨 *FINAL CALL: 1 HOUR LEFT!* Just *${openSpots} ${spotWord} open* for *${whenStr}*!\n` +
      `Current roster: ${playerList}\n` +
      `Who's coming through in the clutch? Vote now and let's play! 🏆🎾🔥`;
  }
  return `⚡ *10 MINUTES TO GO!* Still need *${openSpots} more ${playerWord}* for *${whenStr}*!\n` +
    `Current lineup: ${playerList}\n` +
    `Last chance to grab the remaining ${spotWord} before match time! 🏆🎾⚡`;
}

/**
 * Sweeps active polls and sends escalating reminders at every power of 2
 * hours (64h, 32h, 16h, 8h, 4h, 2h, 1h) away from playtime.
 * Always silenced between 10pm and 8am in San Jose, CA (Pacific Time).
 */
async function checkAndSendPollReminders(sock) {
  if (!sock) return;
  try {
    const sjParts = getSanJoseParts();
    const currentHour = sjParts.hour;

    // Always silence reminders between 10pm and 8am (Pacific Time)
    if (currentHour >= 22 || currentHour < 8) return;

    const now = Date.now();
    const mePn = jidNormalizedUser(sock.user?.id || sock.authState?.creds?.me?.id || '');

    for (const [pollId, pollState] of activePolls.entries()) {
      if (pollState.status !== 'active') continue;
      if (!pollState.playAt) continue;

      const playAtMs = new Date(pollState.playAt).getTime();
      if (Number.isNaN(playAtMs)) continue;
      const diffMs = playAtMs - now;
      if (diffMs <= 0) continue; // match time has passed

      const hoursRemaining = diffMs / (60 * 60 * 1000);
      const isOptIn = pollState.type === 'opt_in' || pollState.options?.some((o) => /^yes$/i.test(o));

      // Find the most immediate matching power-of-2 reminder bucket (smallest H where hoursRemaining <= H)
      const targetH = POWERS_OF_2_REMINDER_HOURS.find((h) => hoursRemaining <= h);
      if (!targetH) continue; // more than 64 hours away

      if (!Array.isArray(pollState.sentReminders)) {
        pollState.sentReminders = [];
      }

      if (pollState.sentReminders.includes(targetH)) continue;

      // Determine spots and voters
      let totalSpots = 0;
      let neededVotes = 0;
      let openSpots = 0;
      let yesCount = 0;

      const { interestedPlayers, aggregated } = getPollVoters(pollId, pollState, mePn);
      let players = [];

      if (pollState.isManual) {
        const options = pollState.options || [];
        const firstSlotNum = getFirstSlotNumber(options);
        const leadingCreatorSpots = (firstSlotNum && firstSlotNum > 1) ? (firstSlotNum - 1) : 0;
        neededVotes = options.length > 0 ? options.length : (pollState.size || 4);
        totalSpots = leadingCreatorSpots + neededVotes;

        const filledVotes = aggregated && aggregated.length > 0
          ? aggregated.filter((o) => o.voters.length > 0).length
          : (interestedPlayers ? interestedPlayers.length : (pollState.voteBuffer ? pollState.voteBuffer.size : 0));
        openSpots = Math.max(0, neededVotes - filledVotes);

        if (isOptIn) {
          yesCount = interestedPlayers.length;
        } else {
          if (openSpots <= 0) continue; // all manual slots filled
        }

        const { players: resolvedPlayers } = resolveManualPollPlayers(pollState, interestedPlayers);
        players = resolvedPlayers;
      } else if (isOptIn) {
        yesCount = interestedPlayers.length;
        players = [...interestedPlayers];
        if (pollState.creator?.name && !players.includes(pollState.creator.name)) {
          players.unshift(pollState.creator.name);
        }
      } else {
        totalSpots = pollState.size || (pollState.options ? pollState.options.length : 4);
        neededVotes = pollState.creator ? totalSpots - 1 : totalSpots;
        const filledVotes = aggregated && aggregated.length > 0
          ? aggregated.filter((o) => o.voters.length > 0).length
          : (interestedPlayers ? interestedPlayers.length : (pollState.voteBuffer ? pollState.voteBuffer.size : 0));
        openSpots = Math.max(0, neededVotes - filledVotes);

        if (openSpots <= 0) continue; // fixed spot poll is already full

        players = [...interestedPlayers];
        if (pollState.creator?.name && !players.includes(pollState.creator.name)) {
          players.unshift(pollState.creator.name);
        }
      }

      const playerList = players.length > 0 ? players.join(', ') : 'None yet';

      const reminderText = buildPollReminderText(targetH, pollState, openSpots, totalSpots, playerList, isOptIn, yesCount);
      console.log(`[poll] Sending ${targetH < 1 ? "10m" : targetH + "h"} reminder for poll ${pollId} ("${pollState.name || pollState.when}") in ${pollState.remoteJid}`);

      try {
        await sock.sendMessage(pollState.remoteJid, { text: reminderText });
        // Mark this bucket and all LARGER buckets as sent ONLY AFTER successfully sending message
        for (const h of POWERS_OF_2_REMINDER_HOURS) {
          if (h >= targetH && !pollState.sentReminders.includes(h)) {
            pollState.sentReminders.push(h);
          }
        }
        persistPolls();
      } catch (sendErr) {
        console.error(`[poll] Failed to send reminder for poll ${pollId}:`, sendErr.message);
      }
    }
  } catch (err) {
    console.error(`⚠️ [${new Date().toISOString()}] Error in checkAndSendPollReminders:`, err);
  }
}

// Check and send reminders for unfilled fixed spot polls every minute
setInterval(() => {
  if (botSock) checkAndSendPollReminders(botSock);
}, POLL_REMINDER_CHECK_INTERVAL_MS);

// Bi-weekly player rating refresh from TennisRecord.com (every 2 weeks)
const RATINGS_REFRESH_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // Check every 6 hours for players due (>= 14 days)

async function checkPeriodicRatingsSweep() {
  try {
    await ratings.refreshPeriodicRatings();
  } catch (err) {
    console.error(`⚠️ [${new Date().toISOString()}] Error in checkPeriodicRatingsSweep:`, err);
  }
}

setTimeout(() => {
  checkPeriodicRatingsSweep();
  setInterval(checkPeriodicRatingsSweep, RATINGS_REFRESH_CHECK_INTERVAL_MS);
}, 20 * 1000);


async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: state,
    version,
    browser: Browsers.ubuntu('Chrome'),
    logger: pino({ level: 'silent' }), // set to 'debug' if you need to see raw protocol traffic
    syncFullHistory: false,
    keepAliveIntervalMs: 25000,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
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

  function isTargetGroupContact(contactId) {
    if (!contactId || !targetGroupJid) return false;
    const norm = jidNormalizedUser(contactId);
    const targetMeta = groupMetadataCache.get(targetGroupJid);
    if (!targetMeta?.participants) return false;
    return targetMeta.participants.some((p) => {
      const pPn = jidNormalizedUser(p.id || p.jid);
      const pLid = jidNormalizedUser(p.lid);
      return pPn === norm || pLid === norm || contactId === p.id || contactId === p.lid;
    });
  }

  sock.ev.on('contacts.upsert', (contacts) => {
    try {
      let changed = false;
      for (const c of contacts) {
        const name = c.name || c.notify || c.verifiedName;
        if (name && c.id && isTargetGroupContact(c.id)) {
          recordName(c.id, name);
        }
      }
    } catch (err) {
      console.error(`⚠️ [${new Date().toISOString()}] Error in contacts.upsert:`, err);
    }
  });

  sock.ev.on('contacts.update', (updates) => {
    try {
      let changed = false;
      for (const c of updates) {
        const name = c.name || c.notify || c.verifiedName;
        if (name && c.id && isTargetGroupContact(c.id)) {
          recordName(c.id, name);
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
      if (currMeName) {
        if (currMeId) recordName(currMeId, currMeName);
        if (currMeLid) recordName(currMeLid, currMeName);
      }

      // Pre-warm group metadata cache so the very first message is recognized instantly
      try {
        const groups = await sock.groupFetchAllParticipating();
        for (const [gId, gMeta] of Object.entries(groups)) {
          groupMetadataCache.set(gId, gMeta);
          if (gMeta.subject === TARGET_GROUP_NAME) {
            targetGroupJid = gId;
            console.log(`[target-group] Pre-cached target group "${gMeta.subject}" (id: ${gId})`);

            // Only map participants for the TARGET_GROUP_NAME
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
      } catch (err) {
        console.error('[groups] Failed to pre-fetch groups on connection open:', err.message);
      }

      console.log(`✅ Tennis group bot is ready and listening for group ${TARGET_GROUP_NAME}.`);

      checkAndSendPollReminders(sock);
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
      let isTargetGroup = false;

      if (isGroup) {
        const metadata = await getGroupMetadata(sock, remoteJid);
        groupName = metadata?.subject || remoteJid;
        isTargetGroup = (targetGroupJid && remoteJid === targetGroupJid) || (groupName === TARGET_GROUP_NAME);

        if (!TARGET_GROUP_NAME) {
          console.log(`[Group seen] "${groupName}" (id: ${remoteJid})`);
          continue;
        }

        if (!isTargetGroup) {
          continue; // Ignore messages not meant for TARGET_GROUP_NAME
        }
      } else if (isDirect) {
        // Direct message: only allowed if sender is an admin of TARGET_GROUP_NAME
        const targetJid = await getTargetGroupJid(sock);
        const isAdmin = await isUserAdmin(sock, targetJid, remoteJid);
        if (!isAdmin) {
          console.log(`[DM] Ignored direct message from non-admin user ${remoteJid}`);
          continue;
        }
        console.log(`[DM] Authorized admin direct message received from ${remoteJid} (${msg.pushName || 'Admin'})`);
      }

      // Check for message revocation (deleted for everyone in WhatsApp)
      const protocolMsg = msg.message?.protocolMessage;
      if (protocolMsg && (protocolMsg.type === 0 || protocolMsg.key?.id)) {
        const deletedId = protocolMsg.key?.id;
        if (deletedId && activePolls.has(deletedId)) {
          handlePollDeleted(remoteJid || protocolMsg.key?.remoteJid, deletedId);
        }
      }

      // Remember voter's display name if present
      if (msg.pushName && (msg.key.participant || remoteJid)) {
        const rawJid = msg.key.participant || remoteJid;
        recordName(rawJid, msg.pushName);
      }

      // Check for incoming poll creation message (bot-created or user-created in group)
      const pollCreation = msg.message?.pollCreationMessage || msg.message?.pollCreationMessageV2 || msg.message?.pollCreationMessageV3;
      if (pollCreation) {
        const pollId = msg.key.id;

        // If not already tracked by bot, check if this manually created poll is for tennis match scheduling
        if (!activePolls.has(pollId)) {
          const pollName = pollCreation.name || 'Match Poll';
          const options = (pollCreation.options || []).map((o) => o.optionName);
          const creatorName = msg.pushName || (msg.key.participant ? nameFor(msg.key.participant) : 'Someone');
          const creatorJid = msg.key.participant || remoteJid || null;

          // Interpret manually created poll using LLM to avoid mistakes
          const interpretation = await interpretManualPollWithLLM(pollName, options, creatorName);
          if (!interpretation.isMatchScheduling) {
            console.log(`[poll] LLM interpreted poll ${pollId} ("${pollName}") as non-match scheduling in ${remoteJid}. Ignoring.`);
            continue; // Do not track non-match polls
          }

          messageStore.set(storeKey(remoteJid, pollId), msg.message);

          const playAt = resolvePlayDateTime(interpretation.dayWord, interpretation.timeWord);
          const pollType = interpretation.type || (options.some((opt) => /^yes$/i.test(opt.trim())) ? 'opt_in' : 'manual');
          const pollSize = interpretation.size !== undefined && interpretation.size !== null ? interpretation.size : (pollType === 'opt_in' ? null : (options.length > 0 ? options.length : null));
          const resolvedWhen = interpretation.when || pollName;

          const initialManualHours = (playAt.getTime() - Date.now()) / (60 * 60 * 1000);
          const manualSentReminders = POWERS_OF_2_REMINDER_HOURS.filter((h) => h > initialManualHours && h > 1);

          activePolls.set(pollId, {
            remoteJid,
            name: pollName,
            options,
            size: pollSize,
            type: pollType,
            when: resolvedWhen,
            playAt: playAt.toISOString(),
            status: 'active',
            isManual: true, // user-created manual match poll, passively tracked
            creator: { name: creatorName, jid: creatorJid },
            lastConflictSignature: null,
            voteBuffer: new Map(),
            lastPlayers: null,
            sentReminders: manualSentReminders
          });
          latestPollIdByChat.set(remoteJid, pollId);
          persistPolls();
          console.log(`[poll] LLM verified & passively tracking manually-created match poll ${pollId} ("${pollName}", when: "${resolvedWhen}", type: ${pollType}, size: ${pollSize}) by ${creatorName} in ${remoteJid}`);
        } else {
          messageStore.set(storeKey(remoteJid, pollId), msg.message);
        }
      }

      // Baileys delivers poll updates via messages.upsert with pollUpdateMessage payload.
      if (msg.message?.pollUpdateMessage) {
        const pollUpdateMessage = msg.message.pollUpdateMessage;
        const pollKey = pollUpdateMessage.pollCreationMessageKey;
        if (pollKey && activePolls.has(pollKey.id)) {
          console.log(`[poll] Vote received via messages.upsert for poll ${pollKey?.id || '(unknown)'}`);
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

      // Process all incoming message types (notify and append)

      try {
        await handleMessage(sock, msg, groupName);
      } catch (err) {
        console.error('Error handling message:', err && err.message ? err.message : err);
        console.error(err && err.stack ? err.stack : '(no stack trace available)');
      }
    }
  });

  // Poll votes and message revocations also arrive here on some Baileys setups.
  sock.ev.on('messages.update', async (updates) => {
    try {
      for (const { key, update } of updates) {
      const remoteJid = key?.remoteJid || update.key?.remoteJid;
      if (!remoteJid || !remoteJid.endsWith('@g.us')) continue;
      if (TARGET_GROUP_NAME) {
        const metadata = await getGroupMetadata(sock, remoteJid);
        const groupName = metadata?.subject || remoteJid;
        if (groupName !== TARGET_GROUP_NAME) continue;
      }

      // Check if a tracked poll message was revoked/deleted (message set to null)
      if (update && update.message === null) {
        const deletedId = key?.id || update.key?.id;
        if (deletedId && activePolls.has(deletedId)) {
          handlePollDeleted(remoteJid, deletedId);
        }
      }

      if (!update.pollUpdates) continue;
      if (!activePolls.has(key.id)) continue;
      console.log(`[poll] Vote received via messages.update for poll ${key.id} (${update.pollUpdates.length} entry/entries)`);
      try {
        await processPollVoteEvent(sock, key, update.pollUpdates);
      } catch (err) {
        console.error('Error handling poll update:', err && err.message ? err.message : err);
        console.error(err && err.stack ? err.stack : '(no stack trace available)');
      }
    }
    } catch (err) {
      console.error(`⚠️ [${new Date().toISOString()}] Error in messages.update outer loop:`, err);
    }
  });

  // Handle message deletion events emitted by Baileys
  sock.ev.on('messages.delete', async (item) => {
    try {
      const jid = item.jid || (Array.isArray(item.keys) && item.keys[0]?.remoteJid);
    if (jid && jid.endsWith('@g.us') && TARGET_GROUP_NAME) {
      const metadata = await getGroupMetadata(sock, jid);
      const groupName = metadata?.subject || jid;
      if (groupName !== TARGET_GROUP_NAME) return;
    }

    if (item.all && item.jid) {
      for (const [pollId, pollState] of [...activePolls.entries()]) {
        if (pollState.remoteJid === item.jid) {
          handlePollDeleted(item.jid, pollId);
        }
      }
    } else if (Array.isArray(item.keys)) {
      for (const key of item.keys) {
        if (key?.id && activePolls.has(key.id)) {
          handlePollDeleted(key.remoteJid, key.id);
        }
      }
    }
    } catch (err) {
      console.error(`⚠️ [${new Date().toISOString()}] Error in messages.delete:`, err);
    }
  });
}

async function handleMessage(sock, msg, groupName) {
  if (!msg.message || msg.key.fromMe) return;

  const remoteJid = msg.key.remoteJid;
  const text = extractText(msg.message);
  if (!text) return;

  const sender = msg.pushName || 'Someone';

  // Remember this voter's display name for when we see their poll votes later.
  if (msg.key.participant) {
    recordName(msg.key.participant, sender);
  }

  // Record all target group messages in persistent 2-week history
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
    const cancelExisting = input.cancelExisting === true;
    const replacePollId = input.replacePollId || null;
    const creatorName = sender !== 'Someone' ? sender : (msg?.key?.participant ? nameFor(msg.key.participant) : 'Player 1');
    const creatorJid = msg?.key?.participant || msg?.key?.remoteJid || null;
    const targetChatId = chatId.endsWith('@g.us') ? chatId : (await getTargetGroupJid(sock) || chatId);

    const res = await createMatchPoll(sock, targetChatId, size, when, dayWord, timeWord, creatorName, creatorJid, includeCreator, replacePollId, cancelExisting);
    if (res?.err) {
      return `Could not create poll: ${res.err}`;
    }
    const resolvedWhen = res?.when ? ` for ${res.when}` : (when ? ` for ${when}` : '');
    const replacedNote = res?.replacedOldPoll ? ' (older poll deleted from WhatsApp)' : '';
    if (res?.isOptIn) {
      return `Opt-in poll created with "Yes" and "No" options${resolvedWhen}${replacedNote}. Players can vote "Yes" to opt in. When ready, ask me to generate the matchups!`;
    }
    if (res?.includedCreator) {
      const needed = size - 1;
      return `Poll for ${size} spots (${size === 2 ? 'Singles' : 'Doubles'}${resolvedWhen}${replacedNote}) created with ${creatorName} as Player 1 (${needed} spot(s) to vote on: Player 2..Player ${size}).`;
    } else {
      const note = res?.reason ? ` (${res.reason}, so not automatically added as Player 1)` : '';
      return `Poll for ${size} spots (${size === 2 ? 'Singles' : 'Doubles'}${resolvedWhen}${replacedNote}) created with all ${size} spot(s) open to vote on: Player 1..Player ${size}${note}.`;
    }
  }
  if (name === 'generate_matchups' || name === 'rematch') {
    const res = await generateMatchupsFromPoll(sock, chatId, input.pollId, input.pollName || input.when);
    return res || 'Matchups generated and posted.';
  }
  if (name === 'add_alias') {
    const { player, alias } = input;
    if (!player || !alias) return 'Please provide both player name and alias.';
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    const canManage = await canUserManagePlayerAlias(sock, chatId, senderJid, sender, player);
    if (!canManage) {
      return '⚠️ Only group admins can add aliases for other players. You can add aliases for yourself.';
    }
    const res = namesStore.addAliasForPlayer(player, alias);
    if (res) {
      return `Added alias "${alias}" for player "${res.name}". Current aliases: [${res.aliases.join(', ')}].`;
    }
    return `Could not add alias for "${player}".`;
  }
  if (name === 'remove_alias') {
    const { player, alias } = input;
    const targetAlias = alias || player;
    const targetPlayer = alias ? player : null;
    if (!targetAlias) return 'Please provide the alias to remove.';

    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    let resolvedPlayer = targetPlayer;
    if (!resolvedPlayer) {
      const match = namesStore.findIdByNameOrAlias(targetAlias);
      if (match) resolvedPlayer = match.entry?.name;
    }

    const canManage = await canUserManagePlayerAlias(sock, chatId, senderJid, sender, resolvedPlayer || targetAlias);
    if (!canManage) {
      return '⚠️ Only group admins can delete aliases for other players. You can delete aliases for yourself.';
    }

    const res = namesStore.removeAliasForPlayer(targetPlayer, targetAlias);
    if (res) {
      return `Removed alias "${res.removed}" from player "${res.name}". Current aliases: [${res.aliases.join(', ')}].`;
    }
    return `Alias "${targetAlias}" was not found.`;
  }
  if (name === 'set_full_name') {
    const { fullName, player } = input;
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handleSetFullName(sock, chatId, senderJid, sender, player, fullName);
  }

  if (name === 'set_rating') {
    const newRating = input.rating;
    const targetPlayer = input.player || (sender !== 'Someone' ? sender : (msg?.key?.participant ? nameFor(msg.key.participant) : null));
    const targetJid = !input.player ? (msg?.key?.participant || msg?.key?.remoteJid || null) : null;
    if (!targetPlayer) return 'Could not identify player to update rating for.';
    if (typeof newRating !== 'number' || newRating < ratings.MIN_RATING || newRating > ratings.MAX_RATING) {
      return `Rating must be a number between ${ratings.MIN_RATING} and ${ratings.MAX_RATING}.`;
    }
    const updated = ratings.setRating(targetPlayer, newRating, { jid: targetJid });
    return `Updated rating for ${targetPlayer} to ${ratings.formatRating(updated)}.`;
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
    let targetPollId = input.pollId || null;
    if (!targetPollId) {
      for (const [pollId, pollState] of [...activePolls.entries()].reverse()) {
        if (pollState.remoteJid === chatId && pollState.status === 'active' && !pollState.isManual) {
          targetPollId = pollId;
          break;
        }
      }
    }
    if (!targetPollId) {
      targetPollId = latestPollIdByChat.get(chatId);
    }
    if (!targetPollId || !activePolls.has(targetPollId)) return 'No active poll to cancel.';

    const targetPollState = activePolls.get(targetPollId);
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    const isCreator = targetPollState.creator ? isSameUser(targetPollState.creator.jid, senderJid, targetPollState.creator.name, sender) : false;
    const isAdmin = await isUserAdmin(sock, chatId, senderJid);

    if (!isCreator && !isAdmin) {
      return '⚠️ Only the poll creator or group admins can cancel this poll.';
    }

    await cancelOrDeletePoll(sock, chatId, targetPollId);
    return 'Poll cancelled and deleted from WhatsApp successfully.';
  }
  return `Unknown tool ${name}`;
}

/**
 * Routes an incoming message to the right handler: structured tennis
 * commands first, direct poll creation parsing, then the LLM with tool support for free-form queries,
 * questions, etc.
 */

/**
 * Records a manually published lineup in the chat into the active poll state
 * and pair history so score reports and partner memory work seamlessly.
 */
async function handleManualLineup(sock, chatId, sender, lineup) {
  let targetPollId = null;
  let targetPollState = null;

  for (const [pollId, pollState] of [...activePolls.entries()].reverse()) {
    if (pollState.remoteJid === chatId && pollState.status === 'active') {
      targetPollId = pollId;
      targetPollState = pollState;
      break;
    }
  }

  if (!targetPollState) {
    targetPollId = latestPollIdByChat.get(chatId);
    targetPollState = targetPollId && activePolls.get(targetPollId);
  }

  if (targetPollState) {
    targetPollState.status = 'resolved';
    targetPollState.lastPlayers = lineup.players;
    targetPollState.lastSchedule = lineup;
    pairHistory.recordDraw(targetPollId, lineup);
    await ratings.ensureRated(lineup.players);
    persistPolls();
    console.log(`[lineup] Recorded manual lineup for poll ${targetPollId} in ${chatId} (${lineup.players.length} players: ${lineup.players.join(', ')})`);
    return `📋 Got it! Recorded lineup for ${lineup.players.length} players (${lineup.players.join(', ')}). Results can be reported anytime!`;
  } else {
    pairHistory.recordDraw(`manual_${Date.now()}`, lineup);
    await ratings.ensureRated(lineup.players);
    console.log(`[lineup] Recorded standalone manual lineup in ${chatId} (${lineup.players.length} players: ${lineup.players.join(', ')})`);
    return `📋 Got it! Recorded lineup for ${lineup.players.length} players (${lineup.players.join(', ')}). Results can be reported anytime!`;
  }
}

async function getResponse(sock, text, chatId, sender, msg) {
  const lower = text.toLowerCase();

  // --- Basic commands ---
  if (lower === '!ping') return 'pong 🏓';

  if (lower.startsWith('!help')) return helpText();

  if (lower === '!reset') {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    const isAdmin = await isUserAdmin(sock, chatId, senderJid);
    if (!isAdmin) {
      return '⚠️ Only group admins can use !reset.';
    }
    chatHistories.delete(chatId);
    messageHistory.clear(chatId);
    return 'Conversation history and recent 2-week group message logs cleared.';
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
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    const isAdmin = await isUserAdmin(sock, chatId, senderJid);
    if (!isAdmin) {
      return '⚠️ Only group admins can use !clearfree.';
    }
    storage.clearAvailability();
    return 'Availability list cleared for everyone.';
  }

  // --- Aliases ---
  if (lower === '!aliases' || lower === '!alias list') {
    return formatAliases();
  }

  if (lower.startsWith('!alias') || lower.startsWith('!addalias')) {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    const senderDisplayName = sender !== 'Someone' ? sender : (senderJid ? nameFor(senderJid) : 'me');
    const parsed = parseAliasCommand(text, senderDisplayName);
    if (!parsed || !parsed.name || !parsed.alias) {
      return 'Couldn\'t parse that. Use: "!alias <alias>" (for yourself) or "!alias <player name> = <alias>"\ne.g. "!alias PK" or "!alias Jonathan Doe = JD"';
    }
    const canManage = await canUserManagePlayerAlias(sock, chatId, senderJid, sender, parsed.name);
    if (!canManage) {
      return '⚠️ Only group admins can add aliases for other players. You can add aliases for yourself (e.g. "!alias <your alias>").';
    }
    const res = namesStore.addAliasForPlayer(parsed.name, parsed.alias, senderJid);
    if (res) {
      return `✅ Added alias "${parsed.alias}" for player "${res.name}". Current aliases: [${res.aliases.join(', ')}].`;
    } else {
      return `Could not add alias for "${parsed.name}".`;
    }
  }

  if (/^!(?:deletealias|delalias|removealias|rmalias)\b/i.test(lower)) {
    const parsed = parseAliasCommand(text) || { name: null, alias: text.replace(/^!(?:deletealias|delalias|removealias|rmalias)\s*/i, '').trim() };
    if (!parsed || (!parsed.name && !parsed.alias)) {
      return 'Use: !deletealias <player name> = <alias> or !deletealias <alias>\ne.g. "!deletealias Jonathan Doe = JD" or "!deletealias JD"';
    }
    const targetAlias = parsed.alias || parsed.name;
    const targetPlayer = parsed.alias ? parsed.name : null;

    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    let resolvedPlayer = targetPlayer;
    if (!resolvedPlayer) {
      const match = namesStore.findIdByNameOrAlias(targetAlias);
      if (match) resolvedPlayer = match.entry?.name;
    }

    const canManage = await canUserManagePlayerAlias(sock, chatId, senderJid, sender, resolvedPlayer || targetAlias);
    if (!canManage) {
      return '⚠️ Only group admins can delete aliases for other players. You can delete aliases for yourself (e.g. "!deletealias <your alias>").';
    }

    const res = namesStore.removeAliasForPlayer(targetPlayer, targetAlias);
    if (res) {
      return `✅ Removed alias "${res.removed}" from player "${res.name}". Current aliases: [${res.aliases.join(', ')}].`;
    } else {
      return `Alias "${targetAlias}" was not found.`;
    }
  }

  // --- Full Name ---
  if (lower.startsWith('!setfullname') || lower.startsWith('!fullname')) {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    const senderDisplayName = sender !== 'Someone' ? sender : (senderJid ? nameFor(senderJid) : 'me');
    const parsed = parseFullNameCommand(text, senderDisplayName);
    if (!parsed || !parsed.fullName) {
      return 'Please provide a full name. Use: "!fullname <full name>" or "!setfullname <player name> = <full name>"\ne.g. "!fullname Roger Federer" or "!setfullname John = Johnathan Smith"';
    }
    return await handleSetFullName(sock, chatId, senderJid, sender, parsed.name, parsed.fullName);
  }

  // --- Scores / leaderboard ---
  if (lower.startsWith('!score')) {
    return handleScoreCommand(text);
  }

  if (lower === '!leaderboard') {
    return formatLeaderboard();
  }

  // --- Ratings & manual rating updates ---
  if (lower.startsWith('!myrating') || lower.startsWith('!setrating')) {
    const valStr = text.replace(/^!(?:myrating|setrating)\s*/i, '').trim();
    const val = parseFloat(valStr);
    if (Number.isNaN(val) || val < ratings.MIN_RATING || val > ratings.MAX_RATING) {
      return `Please provide a valid rating between ${ratings.MIN_RATING} and ${ratings.MAX_RATING}, e.g. "!setrating 3.5" or "${TRIGGER_PREFIX} set my rating to 4.0".`;
    }
    const targetPlayer = sender !== 'Someone' ? sender : (msg?.key?.participant ? nameFor(msg.key.participant) : 'Player');
    const targetJid = msg?.key?.participant || msg?.key?.remoteJid || null;
    const updated = ratings.setRating(targetPlayer, val, { jid: targetJid });
    return `Updated rating for ${targetPlayer} to ${ratings.formatRating(updated)}.`;
  }

  if (lower === '!ratings') {
    return formatRatings();
  }

  // --- TennisRecord Certificate Check Management ---
  if (lower === '!suspendcert' || lower === '!suspendcertcheck' || lower === '!certcheck suspend' || lower === '!certcheck off') {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    const isAdmin = await isUserAdmin(sock, chatId, senderJid);
    if (!isAdmin) {
      return '⚠️ Only group admins can change SSL certificate verification settings.';
    }
    tennisRecord.suspendCertCheck();
    return '🔓 TennisRecord SSL certificate validation suspended. Lookups will proceed even if certificates are expired or invalid.';
  }

  if (lower === '!resumecert' || lower === '!resumecertcheck' || lower === '!certcheck resume' || lower === '!certcheck on') {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    const isAdmin = await isUserAdmin(sock, chatId, senderJid);
    if (!isAdmin) {
      return '⚠️ Only group admins can change SSL certificate verification settings.';
    }
    tennisRecord.resumeCertCheck();
    return '🔒 TennisRecord SSL certificate validation resumed (strict verification enabled).';
  }

  if (lower === '!certstatus' || lower === '!certcheck' || lower === '!sslstatus') {
    const isSuspended = tennisRecord.getCertCheckSuspended();
    return `🔒 TennisRecord SSL certificate check status: ${isSuspended ? 'SUSPENDED (insecure / expired certs allowed)' : 'ACTIVE (strict verification enabled)'}.`;
  }

  if (lower === '!refreshratings') {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    const isAdmin = await isUserAdmin(sock, chatId, senderJid);
    if (!isAdmin) {
      return '⚠️ Only group admins can use !refreshratings.';
    }
    const { checkedCount, updatedCount } = await ratings.refreshPeriodicRatings({ force: true });
    return `Checked ${checkedCount} player(s) on TennisRecord.com: updated ${updatedCount} rating(s).`;
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

  // --- Check for manually published lineup ---
  const manualLineup = parseLineup(text, knownPlayers(chatId));
  if (manualLineup) {
    return await handleManualLineup(sock, chatId, sender, manualLineup);
  }

  // --- Direct Command Poll creation (!createpoll / !poll / !makepoll / !newpoll) ---
  if (/^!(?:createpoll|poll|makepoll|newpoll)\b/i.test(text)) {
    const parsed = parsePollCreationText(text);
    if (parsed) {
      return await handleDirectPollCreation(sock, chatId, sender, msg, parsed);
    }
  }

  // --- Poll management ---
  if (lower === '!cancelpoll' || lower === '!deletepoll') {
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

    const targetPollState = activePolls.get(targetPollId);
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    const isCreator = targetPollState.creator ? isSameUser(targetPollState.creator.jid, senderJid, targetPollState.creator.name, sender) : false;
    const isAdmin = await isUserAdmin(sock, chatId, senderJid);

    if (!isCreator && !isAdmin) {
      return '⚠️ Only the poll creator or group admins can cancel this poll.';
    }

    await cancelOrDeletePoll(sock, chatId, targetPollId);
    return 'Poll cancelled and deleted from WhatsApp -- I won\'t auto-generate matchups from it anymore.';
  }

  if (lower === '!rematch' || lower === '!matchups' || lower === '!draw') {
    return await generateMatchupsFromPoll(sock, chatId);
  }

  if (lower === '!cleanuppolls') {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    const isAdmin = await isUserAdmin(sock, chatId, senderJid);
    if (!isAdmin) {
      return '⚠️ Only group admins can use !cleanuppolls.';
    }
    const removed = cleanupExpiredPolls();
    return removed.length
      ? `Cleaned up ${removed.length} old poll(s).`
      : 'Nothing to clean up yet -- no polls have passed their play time + grace period.';
  }

  if (lower === '!pollstatus') {
    return pollStatusText(chatId);
  }

  // --- Trigger check for bot-addressed messages (case-insensitive, requiring @, or native WhatsApp mentions) ---
  const mePn = jidNormalizedUser(sock?.user?.id || sock?.authState?.creds?.me?.id || '');
  const meLid = jidNormalizedUser(sock?.user?.lid || sock?.authState?.creds?.me?.lid || '');
  const botJids = [mePn, meLid].filter(Boolean);

  const isDM = !chatId.endsWith('@g.us');
  const { addressed, promptText } = isDM
    ? { addressed: true, promptText: stripLeadingTrigger(text) }
    : isAddressedToBot(text, msg, botJids);

  if (TRIGGER_PREFIX && !addressed) {
    return null; // not addressed to the bot with @, stay quiet
  }
  if (!promptText) return null;

  // --- Direct Poll Creation Request (handled directly without LLM) ---
  const directPollParsed = parsePollCreationText(promptText);
  if (directPollParsed) {
    return await handleDirectPollCreation(sock, chatId, sender, msg, directPollParsed);
  }

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

  // --- LLM (handles free-form queries, weather, Q&A, etc.) ---
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
    '!clearfree – (Admin only) clear the whole availability list',
    '!score <winner> def <loser> <score> – record a match and update ratings, e.g. "!score Mike & Sara def John & Alex 6-4 6-2"',
    `  (or tell me in words: "${TRIGGER_PREFIX} Mike & Sara beat John & Alex 6-4", or "${TRIGGER_PREFIX} we won" after a draw – no score means 6-3)`,
    '!leaderboard – show the win/loss leaderboard',
    '!ratings – show player ratings used to balance the courts',
    '!alias <alias> (or !alias <name> = <alias>) – add an alias for yourself or another player, e.g. "!alias PK" or "!alias John = JD"',
    '!deletealias <name> = <alias> (or !deletealias <alias>) – remove an alias for a player',
    '!aliases – list all registered players and their aliases',
    '!fullname <full name> (or !setfullname <name> = <full name>) – set your full name and lookup initial TennisRecord rating',
    '!refreshratings – (Admin only) refresh player ratings from TennisRecord.com now',
    `!setrating <rating> (or ${TRIGGER_PREFIX} my rating is <rating>) – set or update your rating (${ratings.MIN_RATING}–${ratings.MAX_RATING})`,
    '!weather [location] – forecast for outdoor play (defaults to ' + DEFAULT_LOCATION + ')',
    `${TRIGGER_PREFIX} create a poll [for <N>] [when] – post a match poll (N spots for singles/doubles, or Yes/No opt-in if N is omitted)`,
    '!poll [for <N>] [when] (or !createpoll) – direct command to create a match poll',
    '!matchups (or !draw, !rematch) – generate matchups from active tennis match poll',
    '!cancelpoll (or !deletepoll) – stop and delete the active poll (creator or admin only)',
    '!pollstatus – debug: show raw vote count and voters for active match poll(s)',
    '!cleanuppolls – (Admin only) debug: force a sweep that deletes expired/completed polls now',
    '!reset – (Admin only) clear the bot\'s conversation memory',
    TRIGGER_PREFIX ? `${TRIGGER_PREFIX} <question> – ask the bot anything (including setting rating, questions)` : '(bot also responds to any message)'
  ].join('\n');
}

/**
 * Checks if a user has permission to set/add an alias for a given target player.
 * A user can always add an alias for themselves.
 * Adding an alias for other players requires group admin permissions.
 */
async function canUserManagePlayerAlias(sock, chatId, senderJid, senderName, targetPlayer) {
  if (!targetPlayer) return false;
  const tKey = ratings.keyFor(targetPlayer);
  if (['me', 'myself', 'my', 'i'].includes(tKey)) return true;

  if (senderName && ratings.keyFor(senderName) === tKey) return true;

  if (senderJid) {
    const senderCanonical = nameFor(senderJid);
    if (senderCanonical && ratings.keyFor(senderCanonical) === tKey) return true;

    const match = namesStore.findIdByNameOrAlias(targetPlayer);
    if (match) {
      const normSender = jidNormalizedUser(senderJid);
      const pn = namesStore.getPnByLid(normSender) || (normSender?.endsWith('@s.whatsapp.net') ? normSender : null);
      const lid = namesStore.resolveCanonicalId(normSender) || (normSender?.endsWith('@lid') ? normSender : null);

      if (match.id === normSender || match.id === pn || match.id === lid) return true;
      if (match.entry?.name && ratings.keyFor(match.entry.name) === ratings.keyFor(senderName)) return true;
    }
  }

  return await isUserAdmin(sock, chatId, senderJid);
}


async function handleSetFullName(sock, chatId, senderJid, senderName, playerName, fullName) {
  const cleanFull = typeof fullName === 'string' ? fullName.trim() : '';
  if (!cleanFull) return 'Please provide a valid full name.';

  const targetPlayer = playerName || senderName || (senderJid ? nameFor(senderJid) : 'me');
  const canManage = await canUserManagePlayerAlias(sock, chatId, senderJid, senderName, targetPlayer);
  if (!canManage) {
    return '⚠️ Only group admins can update the full name for other players. You can set your own full name.';
  }

  let targetId = null;
  const match = namesStore.findIdByNameOrAlias(targetPlayer);
  if (match) {
    targetId = match.id;
  } else if (senderJid) {
    targetId = namesStore.resolveCanonicalId(jidNormalizedUser(senderJid));
  } else {
    targetId = targetPlayer;
  }

  const updatedEntry = namesStore.setFullName(targetId, cleanFull);
  const resolvedDisplayName = updatedEntry?.name || targetPlayer;

  const trResult = await ratings.updateRatingFromFullName(targetId, cleanFull, { jid: senderJid });
  let ratingNote = '';
  if (trResult) {
    const locStr = trResult.tennisRecordLocation ? ` (${trResult.tennisRecordLocation})` : '';
    const urlStr = trResult.tennisRecordUrl ? ` -> ${trResult.tennisRecordUrl}` : '';
    ratingNote = ` Initial rating from TennisRecord set to ${ratings.formatRating(trResult.rating)}${locStr}${urlStr}.`;
  }

  return `✅ Updated full name for "${resolvedDisplayName}" to "${cleanFull}".${ratingNote}`;
}

function parseFullNameCommand(text, defaultSenderName = null) {
  const raw = text.replace(/^!(?:setfullname|fullname)\s*/i, '').trim();
  if (!raw) return null;

  if (/\bfor\b/i.test(raw)) {
    const forMatch = raw.match(/^(.+?)\s+\bfor\b\s+(.+)$/i);
    if (forMatch) {
      return { name: forMatch[2].trim(), fullName: forMatch[1].trim() };
    }
  }

  const delimMatch = raw.match(/^(.+?)\s*(?:=|:|->|\bas\b|\bto\b)\s*(.+)$/i);
  if (delimMatch) {
    return { name: delimMatch[1].trim(), fullName: delimMatch[2].trim() };
  }

  return { name: defaultSenderName || 'me', fullName: raw };
}

function parseAliasCommand(text, defaultSenderName = null) {
  const raw = text.replace(/^!(?:alias|addalias)\s*/i, '').trim();
  if (!raw) return null;

  if (/\bfor\b/i.test(raw)) {
    const forMatch = raw.match(/^(.+?)\s+\bfor\b\s+(.+)$/i);
    if (forMatch) {
      return { name: forMatch[2].trim(), alias: forMatch[1].trim() };
    }
  }

  const delimMatch = raw.match(/^(.+?)\s*(?:=|:|->|\bas\b|\bto\b)\s*(.+)$/i);
  if (delimMatch) {
    return { name: delimMatch[1].trim(), alias: delimMatch[2].trim() };
  }

  const singleQuoteMatch = raw.match(/^"([^"]+)"$/);
  if (singleQuoteMatch) {
    return { name: defaultSenderName || 'me', alias: singleQuoteMatch[1].trim() };
  }

  const quoteMatch = raw.match(/^"([^"]+)"\s+(.+)$/) || raw.match(/^(.+?)\s+"([^"]+)"$/);
  if (quoteMatch) {
    return { name: quoteMatch[1].trim(), alias: quoteMatch[2].trim() };
  }

  const spaceParts = raw.split(/\s+/);
  if (spaceParts.length >= 2) {
    const alias = spaceParts.pop();
    const name = spaceParts.join(' ');
    return { name, alias };
  }

  if (spaceParts.length === 1 && spaceParts[0]) {
    return { name: defaultSenderName || 'me', alias: spaceParts[0] };
  }

  return null;
}

function formatAliases() {
  const entries = namesStore.getAllEntries();
  if (entries.length === 0) {
    return 'No player aliases recorded yet. Use "!alias <name> = <alias>" to add one.';
  }
  const lines = entries.map((e) => {
    const aliasStr = e.aliases && e.aliases.length > 0 ? ` (aliases: ${e.aliases.join(', ')})` : ' (no aliases)';
    return `• ${e.name}${aliasStr}`;
  });
  return `📋 Player Names & Aliases:\n${lines.join('\n')}`;
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
 * "!score Mike def John 6-4 6-2" or "!score Mike & Sara def John & Alex 6-4 6-2"
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
  let winners = parseSide(winner);
  let losers = parseSide(loser);
  const sets = score.trim().split(/[\s,]+/).map((s) => s.split('-').map(Number));

  if (winners.length !== losers.length) {
    return `Both sides need the same number of players -- got ${winners.length} vs ${losers.length}.`;
  }

  const resolveCanonical = (n) => {
    const match = namesStore.findIdByNameOrAlias(n);
    return (match && match.entry?.name) ? match.entry.name : n;
  };
  winners = winners.map(resolveCanonical);
  losers = losers.map(resolveCanonical);

  return applyScoreReport({ winners, losers, sets });
}

/**
 * Every player the bot already knows, mapped from lowercased name to the
 * canonical spelling. Free-form parsing checks names against this so ordinary
 * chatter can't be mistaken for a result -- see lib/scoreReport.js.
 */
function knownPlayers(chatId) {
  const byKey = new Map();
  const add = (name, canonicalName = null) => {
    const key = ratings.keyFor(name);
    const resolved = canonicalName ? String(canonicalName).trim() : String(name).trim();
    if (key && !byKey.has(key)) byKey.set(key, resolved);
  };

  for (const entry of namesStore.getAllEntries()) {
    if (entry.name) add(entry.name, entry.name);
    for (const alias of entry.aliases || []) {
      add(alias, entry.name);
    }
  }
  for (const p of ratings.getAllRatings()) add(p.name, p.name);
  for (const p of storage.getLeaderboard()) add(p.name, p.name);
  for (const a of storage.getAvailability()) add(a.player, a.player);

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
    return `Nobody's rated yet -- everyone starts from their TennisRecord rating (or ${ratings.formatRating(ratings.INITIAL_RATING)}) once they play a poll or set their rating.`;
  }
  const lines = board.map((p, i) => `${i + 1}. ${p.name} — ${ratings.formatRating(p.rating)}`);
  return `📊 Player ratings (${ratings.formatRating(ratings.MIN_RATING)}–${ratings.MAX_RATING}):\n${lines.join('\n')}`;
}

// ---- Poll creation & vote handling ----

/**
 * Creates and sends a WhatsApp poll.
 * - If size is given (2 for singles, 4/8/12 for doubles), numbered slots are created
 *   ("Player 2" .. "Player <size>" with creator as Player 1 by default).
 * - If size is omitted (null/undefined), creates an opt-in poll with only two options:
 *   "Yes" and "No". The bot then waits for a user prompt to generate matchups from Yes voters.
 * - If replacePollId or cancelExisting is specified, deletes the older poll from WhatsApp.
 */
async function createMatchPoll(sock, remoteJid, size = null, when = null, dayWord = null, timeWord = null, creatorName = null, creatorJid = null, includeCreator = true, replacePollId = null, cancelExisting = false) {
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

  // Extract dayWord and timeWord from when if not explicitly provided
  let effectiveDayWord = dayWord;
  let effectiveTimeWord = timeWord;
  if (!effectiveDayWord && when) {
    const dayMatch = when.match(/\b(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i);
    if (dayMatch) effectiveDayWord = dayMatch[1];
  }
  if (!effectiveTimeWord && when) {
    const timeMatch = when.match(/\b(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm))\b/i) || when.match(/\b(\d{1,2}[:.]\d{2})\b/i);
    if (timeMatch) effectiveTimeWord = timeMatch[1];
  }

  const playAt = resolvePlayDateTime(effectiveDayWord, effectiveTimeWord);
  const sjNow = getSanJoseNow();

  // If BOTH day and time were specified and have already passed, reject and ask user to fix it
  if (effectiveDayWord && effectiveTimeWord && playAt.getTime() <= sjNow.getTime()) {
    const specifiedStr = when || `${effectiveDayWord} ${effectiveTimeWord}`;
    return {
      err: `The specified time (${specifiedStr}) has already passed. Please specify an upcoming day or time to create the poll.`
    };
  }

  // If replacing an existing poll or user requested modifications, delete older poll from WhatsApp
  let replacedOldPoll = false;
  if (replacePollId && activePolls.has(replacePollId)) {
    await cancelOrDeletePoll(sock, remoteJid, replacePollId);
    replacedOldPoll = true;
  } else if (cancelExisting) {
    for (const [pollId, pollState] of [...activePolls.entries()].reverse()) {
      if (pollState.remoteJid === remoteJid && pollState.status === 'active' && !pollState.isManual) {
        await cancelOrDeletePoll(sock, remoteJid, pollId);
        replacedOldPoll = true;
        break;
      }
    }
  }

  // If time rolled over to tomorrow and when doesn't mention tomorrow or day name, adjust when
  const playParts = getSanJoseParts(playAt);
  const nowParts = getSanJoseParts(sjNow);
  const isTomorrow = playParts.day !== nowParts.day || playParts.month !== nowParts.month;
  let resolvedWhen = when;
  if (isTomorrow && !effectiveDayWord) {
    if (resolvedWhen) {
      if (!/\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i.test(resolvedWhen)) {
        resolvedWhen = `Tomorrow ${resolvedWhen}`;
      }
    } else if (effectiveTimeWord) {
      resolvedWhen = `Tomorrow ${effectiveTimeWord}`;
    } else {
      resolvedWhen = 'Tomorrow';
    }
  }

  let shouldIncludeCreator = includeCreator;
  let excludedReason = null;

  // Check if a poll already exists for the same person within 90 minutes of the new poll's start time
  if (shouldIncludeCreator && (creatorJid || creatorName)) {
    const CONFLICT_WINDOW_MS = 90 * 60 * 1000; // 90 minutes
    const newPlayTime = playAt.getTime();

    for (const [existingPollId, existingPoll] of activePolls.entries()) {
      if (existingPoll.remoteJid !== remoteJid) continue;
      if (existingPoll.status === 'cancelled') continue;
      if (!existingPoll.playAt) continue;

      const existingPlayTime = new Date(existingPoll.playAt).getTime();
      if (Number.isNaN(existingPlayTime)) continue;

      if (Math.abs(newPlayTime - existingPlayTime) < CONFLICT_WINDOW_MS) {
        if (isUserInPoll(existingPoll, creatorJid, creatorName)) {
          shouldIncludeCreator = false;
          const existingWhen = existingPoll.when || new Date(existingPoll.playAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
          excludedReason = `a poll already exists for ${creatorName || 'you'} within 90 minutes of this start time (${existingWhen})`;
          console.log(`[poll] Not auto-adding ${creatorName || 'creator'} as Player 1 in new poll: already in poll ${existingPollId} within 90 minutes`);
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

  const suffix = resolvedWhen ? ` -- ${resolvedWhen}` : ' for today\'s matches';

  const sent = await sock.sendMessage(remoteJid, {
    poll: {
      name: `${titlePrefix} (${matchType}${suffix})`,
      values,
      selectableCount: 1
    }
  });

  const pollId = sent.key.id;

  messageStore.set(storeKey(sent.key.remoteJid, pollId), sent.message);
  const initialHours = (playAt.getTime() - Date.now()) / (60 * 60 * 1000);
  const sentReminders = POWERS_OF_2_REMINDER_HOURS.filter((h) => h > initialHours && h > 1);

  activePolls.set(pollId, {
    remoteJid,
    name: `${titlePrefix} (${matchType}${suffix})`,
    options: values,
    size: isOptIn ? null : size,
    type: isOptIn ? 'opt_in' : 'fixed',
    when: resolvedWhen || null,
    playAt: playAt.toISOString(),
    status: 'active', // 'active' | 'resolved' | 'cancelled'
    isManual: false,
    creator: shouldIncludeCreator ? { name: creatorName || 'Player 1', jid: creatorJid || null } : null,
    lastConflictSignature: null,
    voteBuffer: new Map(), // voterJid -> raw pollUpdate entry
    lastPlayers: null,
    sentReminders
  });
  latestPollIdByChat.set(remoteJid, pollId);
  persistPolls();
  console.log(`[poll] Created poll ${pollId} (${isOptIn ? 'Yes/No opt-in' : `${size} spots`}, creator: ${shouldIncludeCreator ? (creatorName || 'Player 1') : 'none (not included)'}) in ${remoteJid}${resolvedWhen ? ` (${resolvedWhen})` : ''}, play time ${playAt.toISOString()}`);

  return { err: null, isOptIn, size, when: resolvedWhen, includedCreator: shouldIncludeCreator, reason: excludedReason, replacedOldPoll };
}

/**
 * Handles an incoming poll vote (from either event path): decrypts it if
 * needed, merges it into our running tally for that poll, and if every slot
 * now has exactly one voter (for fixed-slot polls), posts matchups.
 * For Yes/No opt-in polls and manual user polls, updates vote tallies and waits for user command.
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
    pollMessageKey.participant && namesStore.resolveCanonicalId(jidNormalizedUser(pollMessageKey.participant)),
    pollMessageKey.participant && namesStore.getPnByLid(jidNormalizedUser(pollMessageKey.participant)),
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

    const rawParticipantPn = u.pollUpdateMessageKey?.participantPn ? jidNormalizedUser(u.pollUpdateMessageKey.participantPn) : null;
    if (voterNormalized && rawParticipantPn) {
      if (voterNormalized.endsWith('@lid') && rawParticipantPn.endsWith('@s.whatsapp.net')) {
        namesStore.setMapping(voterNormalized, rawParticipantPn);
      }
    }
    const voterLid = namesStore.resolveCanonicalId(voterNormalized) || (voterNormalized?.endsWith('@lid') ? voterNormalized : null);
    const voterPn = rawParticipantPn || namesStore.getPnByLid(voterNormalized) || (voterNormalized?.endsWith('@s.whatsapp.net') ? voterNormalized : null);

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
    const canonicalVoter = voterLid || authenticatingVoter;

    pollState.voteBuffer.set(canonicalVoter, {
      ...u,
      pollUpdateMessageKey: {
        ...u.pollUpdateMessageKey,
        fromMe: false,
        participant: canonicalVoter
      },
      vote: votePayload
    });

    // When recording a vote, if player rating is unavailable, fetch it from TennisRecord
    const voterName = nameFor(canonicalVoter);
    if (voterName && !ratings.isPlaceholder(voterName) && !GENERIC_NAMES.has(ratings.keyFor(voterName))) {
      await ratings.ensureRated([{
        name: voterName,
        jid: canonicalVoter,
        lid: authenticatingVoter && authenticatingVoter.endsWith('@lid') ? authenticatingVoter : null
      }]);
    }
  }
  persistPolls(); // save vote progress immediately in case of a restart mid-poll

  const merged = [...pollState.voteBuffer.values()].map((u) => ({
    ...u,
    vote: normalizeVotePayload(u.vote)
  }));

  // If this poll was created manually by a user, passively track votes without automatic changes or auto-matchups
  if (pollState.isManual) {
    let yesCount = 0;
    let noCount = 0;
    let filledCount = 0;
    let totalOptionsCount = pollState.options ? pollState.options.length : 0;
    try {
      const aggregated = getAggregateVotesInPollMessage(
        { message: pollCreationMessage, pollUpdates: merged },
        mePn
      );
      const yesOpt = aggregated.find((o) => /^yes$/i.test(o.name.trim()));
      const noOpt = aggregated.find((o) => /^no$/i.test(o.name.trim()));
      yesCount = yesOpt ? yesOpt.voters.length : 0;
      noCount = noOpt ? noOpt.voters.length : 0;

      const votingOptions = aggregated.filter((o) => !/^(no|out|can't play|cannot play)$/i.test(o.name.trim()));
      filledCount = votingOptions.filter((o) => o.voters.length > 0).length;
      if (totalOptionsCount === 0) totalOptionsCount = votingOptions.length;
    } catch (e) {}

    // When all voting slots are filled and not already resolved, transition status to 'filled'
    if (pollState.status !== 'resolved' && pollState.status !== 'cancelled') {
      const isFilled = (pollState.type !== 'opt_in' && totalOptionsCount > 0 && filledCount >= totalOptionsCount);
      const newStatus = isFilled ? 'filled' : 'active';
      if (pollState.status !== newStatus) {
        pollState.status = newStatus;
        persistPolls();
      }
    }

    console.log(`[poll] Manually-created poll ${pollId} vote updated (${pollState.voteBuffer.size} vote(s) buffered, status: ${pollState.status}, filled: ${filledCount}/${totalOptionsCount}, Yes: ${yesCount}, No: ${noCount}). Passively tracking -- waiting for explicit matchup request.`);
    return;
  }

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
    const noCount = noOption ? noOpt.voters.length : 0;
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

    await ratings.ensureRated(players);
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
 * - For user-created manual tennis match polls: extracts voters in slot/option order or Yes voters.
 *   If the player count does not meet valid configurations (2 for singles, multiples of 4 for doubles),
 *   includes the creator of the poll as one of the players.
 * - For fixed-size polls / rematches: regenerates matchups from the recorded player list.
 */
async function generateMatchupsFromPoll(sock, chatId, specificPollId = null, specificPollName = null) {
  let targetPollId = null;
  let targetPollState = null;

  // 1. If a specific poll ID was requested, check if it exists in this chat
  if (specificPollId && activePolls.has(specificPollId)) {
    const poll = activePolls.get(specificPollId);
    if (poll.remoteJid === chatId && poll.status !== 'cancelled') {
      targetPollId = specificPollId;
      targetPollState = poll;
    }
  }

  // 2. If a specific poll name / time keyword was requested, search for it
  if (!targetPollState && specificPollName) {
    const q = String(specificPollName).toLowerCase().trim();
    for (const [pollId, pollState] of [...activePolls.entries()].reverse()) {
      if (pollState.remoteJid === chatId && pollState.status !== 'cancelled') {
        const pName = (pollState.name || '').toLowerCase();
        const pWhen = (pollState.when || '').toLowerCase();
        if (pName.includes(q) || pWhen.includes(q) || q.includes(pName)) {
          targetPollId = pollId;
          targetPollState = pollState;
          break;
        }
      }
    }
  }

  // 3. Look for active opt-in or manual match poll first
  if (!targetPollState) {
    for (const [pollId, pollState] of [...activePolls.entries()].reverse()) {
      if (pollState.remoteJid === chatId && (pollState.status === 'active' || pollState.status === 'filled') && (pollState.type === 'opt_in' || pollState.size === null || pollState.isManual)) {
        targetPollId = pollId;
        targetPollState = pollState;
        break;
      }
    }
  }

  // 4. Look for any active match poll with votes
  if (!targetPollState) {
    for (const [pollId, pollState] of [...activePolls.entries()].reverse()) {
      if (pollState.remoteJid === chatId && (pollState.status === 'active' || pollState.status === 'filled') && pollState.voteBuffer.size > 0) {
        targetPollId = pollId;
        targetPollState = pollState;
        break;
      }
    }
  }

  // 5. Look for any match poll with players/votes (including resolved, for rematch or re-draw)
  if (!targetPollState) {
    for (const [pollId, pollState] of [...activePolls.entries()].reverse()) {
      if (pollState.remoteJid === chatId && pollState.status !== 'cancelled' && (pollState.lastPlayers || pollState.voteBuffer.size > 0)) {
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
    return `No tennis match poll found to generate matchups from -- create one with "${TRIGGER_PREFIX} create a poll" first.`;
  }

  const mePn = jidNormalizedUser(sock?.user?.id || sock?.authState?.creds?.me?.id || '');

  // Extract players from votes or previous draw
  let players = [];
  const { interestedPlayers, yesOption } = getPollVoters(targetPollId, targetPollState, mePn);
  if (interestedPlayers && interestedPlayers.length > 0) {
    players = interestedPlayers;
    if (targetPollState.isManual) {
      const { players: adjustedPlayers, addedExtra } = resolveManualPollPlayers(targetPollState, players);
      if (addedExtra && addedExtra.length > 0) {
        console.log(`[poll] Adjusted manual poll players: added extra [${addedExtra.join(', ')}] -> total ${adjustedPlayers.length} player(s)`);
      }
      players = adjustedPlayers;
    }
  } else if (targetPollState.lastPlayers && targetPollState.lastPlayers.length > 0) {
    players = targetPollState.lastPlayers;
  }

  if (players.length === 0) {
    return targetPollState.type === 'opt_in' || targetPollState.options?.some((o) => /^yes$/i.test(o))
      ? 'No one has voted "Yes" yet in the opt-in poll.'
      : 'No votes have been recorded yet for this poll.';
  }

  if (players.length === 1) {
    return `Only 1 player has voted so far (${players[0]}). Need at least 2 for singles or 4 for doubles.`;
  }

  if (players.length !== 2 && players.length % 4 !== 0) {
    return `Got ${players.length} players (${players.join(', ')}).\nNeed 2 players for singles or a multiple of 4 (4, 8, 12, etc.) for doubles to generate standard matchups.`;
  }

  targetPollState.status = 'resolved';
  targetPollState.lastPlayers = players;
  persistPolls();

  console.log(`[poll] Generating matchups for poll ${targetPollId} ("${targetPollState.name || targetPollState.type}") with ${players.length} player(s): ${players.join(', ')}`);

  await ratings.ensureRated(players);
  const schedule = generateMatchups(players);
  const header = targetPollState.when ? `📅 ${targetPollState.when}\n\n` : '';
  await sock.sendMessage(targetPollState.remoteJid, { text: header + formatMatchups(schedule) });
  pairHistory.recordDraw(targetPollId, schedule);
  targetPollState.lastSchedule = summarizeSchedule(schedule);
  persistPolls();
  return null;
}

/** Best-effort JID -> display name lookup, falling back to a short id. */
function nameFor(jid) {
  if (!jid || jid === 'me') {
    const meName = botSock?.user?.name || botSock?.authState?.creds?.me?.id;
    if (meName) return meName;
    const meId = jidNormalizedUser(botSock?.user?.id || botSock?.authState?.creds?.me?.id || '');
    if (meId && meId !== jid) return nameFor(meId);
    return 'Me';
  }
  const norm = jidNormalizedUser(jid) || jid;
  const registeredName = namesStore.getName(norm) || namesStore.getName(jid);
  if (registeredName) return registeredName;

  // Check if this JID matches any creator in activePolls
  for (const [, pollState] of activePolls.entries()) {
    if (pollState.creator?.jid && (pollState.creator.jid === norm || pollState.creator.jid === jid)) {
      if (pollState.creator.name) {
        recordName(norm, pollState.creator.name);
        return pollState.creator.name;
      }
    }
  }

  const pn = namesStore.getPnByLid(norm);
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

    if (pollState.isManual) {
      const { aggregated, interestedPlayers } = getPollVoters(pollId, pollState, mePn);
      const optionSummaries = aggregated.map((opt) => `${opt.name} (${opt.voters.length}): ${opt.voters.map(nameFor).join(', ') || '(none)'}`);
      const { players: playingPlayers, addedFromLabel, addedFromValidCount } = resolveManualPollPlayers(pollState, interestedPlayers);
      const creatorName = pollState.creator?.name || 'Someone';

      let additionNotes = [];
      if (addedFromLabel.length > 0) additionNotes.push(`${addedFromLabel.join(', ')} from poll slot labels`);
      if (addedFromValidCount.length > 0) additionNotes.push(`${addedFromValidCount.join(', ')} to reach valid player count`);
      const additionStr = additionNotes.length > 0 ? ` (includes ${additionNotes.join(' and ')})` : '';

      const lines = [
        `Poll ${pollId}: User-Created Manual Match Poll "${pollState.name || 'Match Poll'}".`,
        `Creator: ${creatorName}`,
        `Status: ${pollState.status} (Passively tracked)`,
        `Play time: ${playAtLocal} (kept for 2 weeks after scheduled play time)`,
        `Total votes buffered: ${pollState.voteBuffer.size}`,
        `Options & Votes:\n  ${optionSummaries.length ? optionSummaries.join('\n  ') : '(none)'}`,
        `Voted so far (${interestedPlayers.length}): ${interestedPlayers.length ? interestedPlayers.join(', ') : '(none yet)'}`,
        `Currently playing (${playingPlayers.length}): ${playingPlayers.join(', ')}${additionStr}`,
        'Matchups: Passively tracked -- will generate matchups only upon explicit user request (!matchups or "@tenbot generate matchups")'
      ];
      return lines.join('\n');
    }

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
        `Play time: ${playAtLocal} (kept for 2 weeks after scheduled play time)`,
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
      `Play time: ${playAtLocal} (kept for 2 weeks after scheduled play time)`,
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

      if (pollState.isManual) {
        const { aggregated, interestedPlayers } = getPollVoters(id, pollState, mePn);
        const optionDetails = [];
        for (const opt of aggregated) {
          const names = opt.voters.map(nameFor);
          if (names.length > 0) {
            optionDetails.push(`${opt.name}: ${names.join(', ')}`);
          }
        }

        const { players: playingPlayers, addedFromLabel, addedFromValidCount } = resolveManualPollPlayers(pollState, interestedPlayers);
        const creatorName = pollState.creator?.name || 'Someone';

        let additionNotes = [];
        if (addedFromLabel.length > 0) additionNotes.push(`[${addedFromLabel.join(', ')}] from poll slot labels`);
        if (addedFromValidCount.length > 0) additionNotes.push(`[${addedFromValidCount.join(', ')}] to reach valid player count`);
        const additionSuffix = additionNotes.length > 0 ? ` (includes ${additionNotes.join(' and ')})` : '';

        if (pollState.status === 'cancelled') {
          return `[Poll ${id}] a user-created manual match poll "${pollState.name || 'Match Poll'}" was cancelled`;
        } else {
          const statusNote = pollState.status === 'resolved' ? 'status: resolved/drawn (can generate matchups again / rematch)' : (pollState.status === 'filled' ? 'status: filled (all voting slots filled, waiting for matchup request)' : 'status: active');
          return `[Poll ${id}] a user-created manual match poll "${pollState.name || 'Match Poll'}" (created by ${creatorName}) is tracked with ${interestedPlayers.length} vote(s): [${optionDetails.join('; ') || 'no votes yet'}]. Players currently in/playing (${playingPlayers.length}): ${playingPlayers.join(', ')}${additionSuffix}. (${statusNote} -- when asked to generate matchups or draw, call generate_matchups)`;
        }
      }

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

        if (pollState.status === 'cancelled') {
          return `[Poll ${id}] a Yes/No opt-in poll${whenSuffix} was cancelled`;
        } else {
          const statusNote = pollState.status === 'resolved' ? 'status: resolved/drawn (can rematch)' : 'status: active';
          return `[Poll ${id}] a Yes/No opt-in poll${whenSuffix} is tracked with ${yesCount} "Yes" vote(s) (${yesNames.join(', ') || 'none yet'}) and ${noCount} "No" vote(s). (${statusNote})`;
        }
      }

      const filledCount = pollState.voteBuffer?.size || 0;
      const neededVotes = pollState.creator ? pollState.size - 1 : pollState.size;
      const creatorSuffix = pollState.creator ? ` (created by ${pollState.creator.name || 'Player 1'}, who is Player 1)` : ' (all spots open)';
      if (pollState.status === 'cancelled') {
        return `[Poll ${id}] a ${pollState.size}-spot poll${whenSuffix} was cancelled`;
      } else {
        const statusNote = pollState.status === 'resolved' ? 'status: resolved/drawn (can rematch)' : 'status: active';
        return `[Poll ${id}] a ${pollState.size}-spot poll${whenSuffix}${creatorSuffix} is tracked with ${filledCount}/${neededVotes} votes. (${statusNote})`;
      }
    });
    pollText = pollDescriptions.join('; ');
  }

  const rated = ratings.getAllRatings();
  const ratingsText = rated.length
    ? rated.map((p) => `${p.name}: ${ratings.formatRating(p.rating)}`).join(', ')
    : 'nobody rated yet';

  const groupChatLog = messageHistory.formatRecentMessagesForContext(chatId);

  return (
    `Current time in San Jose, CA (Pacific Time): ${sjTimeStr}\n` +
    `Current availability: ${availabilityText}\n` +
    `Leaderboard (top 5): ${leaderboardText}\n` +
    `Recent matches: ${recentText}\n` +
    `Player ratings (${ratings.formatRating(ratings.MIN_RATING)}-${ratings.MAX_RATING}, a pairing's rating is the sum of its two players'): ${ratingsText}\n` +
    `Active poll: ${pollText}\n\n` +
    `--- Group Chat History (Past 2 Weeks) ---\n${groupChatLog}\n--- End of Group Chat History ---`
  );
}

/**
 * Calls the Anthropic API with tools, recent chat history, and live context.
 * Enables Claude to handle general questions and conversational queries with live group context.
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
      } catch (e) {}
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

// Watchdog heartbeat every 30 seconds to keep process alive and verify connection
setInterval(() => {
  // Keeps the event loop actively referenced
}, 30000);

launchBot();
