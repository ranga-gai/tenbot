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
const recurringPollsModule = require('./lib/recurringPolls');
const scvcc = require('./lib/scvcc');
const groupsConfig = require('./lib/groupsConfig');
const anthropic = require('./lib/anthropic');
const { helpText } = require('./lib/help');
const { resolvePlayDateTime, getSanJoseNow, getSanJoseParts, parseTimeString, WORD_TO_NUMBER, NUMBER_WORDS_PATTERN } = require('./lib/pollTime');

// ---- CONFIG ----

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
// Reminder intervals away from match playtime: 1h, 2h, 4h, 8h, 16h, 24h, 32h, 64h
const POLL_REMINDER_HOURS = [1, 2, 4, 8, 16, 24, 32, 64];
const POWERS_OF_2_REMINDER_HOURS = POLL_REMINDER_HOURS;
const POLL_REMINDER_CHECK_INTERVAL_MS = 60 * 1000;
const MAX_POLL_REMINDERS = 2;

// System prompt controlling the bot's personality/behavior
const SYSTEM_PROMPT =
  'You are a helpful assistant in a WhatsApp group chat for a group of tennis ' +
  'players in San Jose, California (Pacific Time) who organize casual matches together. Keep replies short and ' +
  'conversational (1-3 sentences) unless asked for more detail. You have ' +
  "access to tools to create match polls (fixed-spot polls for 2 singles or 4/8/12 doubles, " +
  "or Yes/No opt-in polls when no number of players is specified), generate matchups from poll votes, " +
  "set/update player ratings, check weather, cancel/delete polls, schedule recurring match polls on specific days of the week or every day with customizable poll creation times per day of the week (schedule_recurring_poll), modify recurring schedules (modify_recurring_poll), list recurring schedules (list_recurring_polls), pause recurring schedules (pause_recurring_poll), resume recurring schedules (resume_recurring_poll), skip a recurring poll instance (skip_recurring_poll_instance), restore a skipped instance (unskip_recurring_poll_instance), and access the group's availability list, win/loss leaderboard, " +
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

// Tools exposed to Claude for handling natural language requests
const CLAUDE_TOOLS = [
  {
    name: 'create_poll',
    description: 'Creates and sends a WhatsApp poll for organizing a tennis match in the group. Always call this tool directly when asked to create a poll without asking for user confirmation beforehand, even if the creator already has other polls (especially when the start time is 90 minutes or more away or rolled over to the next day). If size is specified, creates numbered slot spots; if the given player count does not match a valid count (2 for singles, 4/8/12 for doubles), it assumes creator and virtual players and starts labels from Player <valid count - given count + 1>. If size is omitted or not specified, creates an opt-in poll with only two options (Yes and No) where players vote Yes to opt in. Note: users are in San Jose, CA (Pacific Time). If both day and time are given and in the past, poll creation is rejected. If only a start time is specified and the current time is greater than the start time, the poll is automatically created for the next day with that start time. If modifying/replacing an existing poll, set cancelExisting to true to delete the older poll from WhatsApp. Note: by default, court availability is NOT checked when creating a poll unless checkCourts/includeCourts is explicitly set to true (e.g. user specifies "with courts", "check courts", "consider court availability", "--courts"). When checkCourts is true, if no live or prebooked courts are available at SCVCC for that time, the poll is not created and a notification is sent instead.',
    input_schema: {
      type: 'object',
      properties: {
        size: {
          description: 'Total number of players for the match (2 for singles, 4/8/12/16 for doubles) or "auto" to automatically calculate spots (4, 8, or 12) based on SCVCC pre-booked and free courts. Words for numbers (e.g. "four", "two", "eight") map to their numeric values (4, 2, 8). Do not confuse court numbers (e.g. "court 2") with size. If omitted or not specified, a Yes/No opt-in poll is created.'
        },
        court: {
          type: 'string',
          description: 'Optional specific court for the match (e.g. "Court 2", "Court 3", "Pickleball 1").'
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
        },
        autoMatchups: {
          type: 'boolean',
          description: 'Whether to automatically generate matchups when voting completes (default: true). Set to false if matchups should NOT be created automatically.'
        },
        noMatchups: {
          type: 'boolean',
          description: 'If true, do not automatically create matchups when voting completes.'
        },
        checkCourts: {
          type: 'boolean',
          description: 'Whether to check and consider SCVCC court availability for the match time (default: false). Set to true only if the user explicitly asks to consider or check court availability (e.g. "with courts", "check courts", "consider court availability", "--courts").'
        },
        includeCourts: {
          type: 'boolean',
          description: 'Alias for checkCourts. Whether to check and consider SCVCC court availability in the poll (default: false).'
        },
        'prebooked-spots': {
          type: 'boolean',
          description: "Whether to include named voting slots for booking players on prebooked courts (e.g. \"Conrad's Spot\"). Defaults to false (standard numbered slots like Player 1, Player 2 are used)."
        },
        includePrebookedSpots: {
          type: 'boolean',
          description: "Whether to include named voting slots for booking players on prebooked courts (e.g. \"Conrad's Spot\"). Defaults to false (standard numbered slots like Player 1, Player 2 are used)."
        }
      }
    }
  },
  {
    name: 'reset_rating',
    description: 'Resets a player\'s rating (or the sender\'s rating if player is omitted) back to their baseline TennisRecord rating (or default 3.49). Non-admins can only reset their own rating; only group admins can reset ratings for other players.',
    input_schema: {
      type: 'object',
      properties: {
        player: {
          type: 'string',
          description: 'Optional player name or alias to reset rating for. If omitted, resets the sender\'s rating.'
        }
      }
    }
  },
  {
    name: 'generate_matchups',
    description: 'Generates and posts singles/doubles matchups and rotations from current poll votes. Always call this tool when the user asks to generate matchups, draw, or make teams for a poll (whether active, filled, or resolved/rematch). If the user asks to keep specific players on the same team or partner together (e.g. "keeping PlayerA and PlayerB in same team", "partner P1 with P2", "with X and Y together"), pass them in fixedPairs as a 2D array of player name pairs (e.g. [["PlayerA", "PlayerB"]]). For manual match polls, uses poll labels and adds creator / extra players (<creatorName>, <creatorName> 2, etc.) until a valid player count configuration is reached.',
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
        },
        fixedPairs: {
          type: 'array',
          items: {
            type: 'array',
            items: { type: 'string' }
          },
          description: '2D array of player name pairs who MUST be partners on the same team across sets (e.g. [["PlayerA", "PlayerB"]]). Pass this whenever the user asks to keep players on the same team, partner them together, or pair them.'
        },
        prebookedCourts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of prebooked courts (e.g. ["Court 2", "Court 3"]) to assign matches to first before unbooked matches (M1, M2).'
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
    description: 'Sets or updates the rating for the user who sent the message (or for a named player if specified). Rating must be a number between 2.5 and 4.5. Non-admins can only change their own rating; only group admins can change ratings for other players.',
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
    name: 'clear_all_polls',
    description: 'Removes all polls from bot memory and state without deleting them from WhatsApp. Admin only.',
    input_schema: {
      type: 'object',
      properties: {}
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
    description: 'Regenerates matchups and rotations from the current poll votes with optional pairing constraints.',
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
        },
        fixedPairs: {
          type: 'array',
          items: {
            type: 'array',
            items: { type: 'string' }
          },
          description: '2D array of player name pairs who MUST be partners on the same team across sets (e.g. [["PlayerA", "PlayerB"]]).'
        },
        prebookedCourts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of prebooked courts (e.g. ["Court 2", "Court 3"]) to assign matches to first before unbooked matches (M1, M2).'
        }
      }
    }
  },
  {
    name: 'stop_poll',
    description: 'Stops voting on an active or filled match poll, silences reminders, and sets status to stopped without deleting the poll message from WhatsApp. Matchups can still be generated later.',
    input_schema: {
      type: 'object',
      properties: {
        pollId: {
          type: 'string',
          description: 'Optional specific poll ID to stop. If omitted, stops the most recent active or filled match poll in this chat.'
        }
      }
    }
  },
  {
    name: 'resume_poll',
    description: 'Resumes voting and reminders for a stopped match poll.',
    input_schema: {
      type: 'object',
      properties: {
        pollId: {
          type: 'string',
          description: 'Optional specific poll ID to resume. If omitted, resumes the most recent stopped match poll in this chat.'
        }
      }
    }
  },
  {
    name: 'pause_reminders',
    description: 'Pauses upcoming reminder notifications for a specific match poll or all active match polls in this chat. Any group member can issue this.',
    input_schema: {
      type: 'object',
      properties: {
        pollId: {
          type: 'string',
          description: 'Optional specific poll ID to pause reminders for. If omitted, pauses reminders for all active match polls in this chat.'
        }
      }
    }
  },
  {
    name: 'resume_reminders',
    description: 'Resumes upcoming reminder notifications for a specific match poll or all active match polls in this chat. Any group member can issue this.',
    input_schema: {
      type: 'object',
      properties: {
        pollId: {
          type: 'string',
          description: 'Optional specific poll ID to resume reminders for. If omitted, resumes reminders for all active match polls in this chat.'
        }
      }
    }
  },
  {
    name: 'trigger_reminder',
    description: 'Manually sends a match reminder notification for a specific active poll or all active match polls in this chat. Any group member can issue this.',
    input_schema: {
      type: 'object',
      properties: {
        pollId: {
          type: 'string',
          description: 'Optional specific poll ID to send reminder for. If omitted, sends reminders for all active match polls in this chat.'
        }
      }
    }
  },
  {
    name: 'schedule_recurring_poll',
    description: 'Schedules a recurring tennis match poll to be created and posted automatically on specified days of the week or every day. The poll creation time can be configured uniformly, on a day-of-week basis, or more than 24 hours in advance of match playtime (e.g. play at 7pm on Monday with poll created at Sunday 6pm, 1 day before at 6pm, or 2 days before at 8am).',
    input_schema: {
      type: 'object',
      properties: {
        size: {
          type: 'integer',
          description: 'Total number of players for the match (2 for singles, 4/8/12 for doubles). If omitted, creates a Yes/No opt-in poll.'
        },
        matchTime: {
          type: 'string',
          description: 'Time of day when the match takes place (e.g. "7pm", "9am", "6:30pm", "19:00").'
        },
        days: {
          type: 'string',
          description: 'Days of the week when the match takes place (e.g. "everyday", "weekdays", "weekends", "mon-thu", "mon,wed,fri", "tuesdays and thursdays", "saturday"). Defaults to "everyday".'
        },
        postTime: {
          description: 'Optional time/day when the poll should be posted to the group. Can be a same-day time ("8am", "7:30am"), day-of-week specific ("7am on weekdays, 8am on weekends"), or >24h in advance of match play time (e.g. "sunday 6pm" for Monday matches, "1 day before at 6pm", "2 days before at 8am"). If omitted, defaults to 8:00 AM (or 7:00 PM the evening before for early morning matches).'
        },
        postTimesByDay: {
          type: 'object',
          description: 'Optional map of day names or day indices to specific post times (e.g. {"mon": "7am", "tue": "7am", "sat": "8am", "sun": "8am"} or {"weekdays": "7am", "weekends": "8am"}).'
        },
        includeCreator: {
          type: 'boolean',
          description: 'Whether the creator should be automatically added as Player 1 in the recurring poll (default false for automated daily polls).'
        },
        autoMatchups: {
          type: 'boolean',
          description: 'Whether to automatically generate matchups when the poll fills up. Set to false if matchups should NOT be created automatically when poll ends/fills (default: true).'
        },
        noMatchups: {
          type: 'boolean',
          description: 'If true, do not automatically create matchups when the poll ends/fills.'
        },
        checkCourts: {
          type: 'boolean',
          description: 'Optional: whether to check and consider SCVCC court availability when posting recurring polls (default: false).'
        },
        includeCourts: {
          type: 'boolean',
          description: 'Optional: whether to check and consider SCVCC court availability (default: false).'
        },
        'prebooked-spots': {
          type: 'boolean',
          description: 'Whether to include named voting slots for booking players on prebooked courts in recurring polls. Defaults to false.'
        },
        includePrebookedSpots: {
          type: 'boolean',
          description: 'Whether to include named voting slots for booking players on prebooked courts in recurring polls. Defaults to false.'
        }
      },
      required: ['matchTime']
    }
  },
  {
    name: 'modify_recurring_poll',
    description: 'Modifies an existing scheduled recurring match poll (e.g. change time, post time, player spots, days of the week, or auto-matchups). Only the poll creator or group admins can modify it.',
    input_schema: {
      type: 'object',
      properties: {
        scheduleId: {
          type: 'string',
          description: 'The schedule ID of the recurring poll to modify (e.g. "rec_1", "rec_...").'
        },
        modifyInstance: {
          type: 'boolean',
          description: 'Set to true if modifying the active/current poll instance created by this schedule instead of modifying the recurring schedule template.'
        },
        size: {
          type: 'integer',
          description: 'Optional new player count (2 for singles, 4/8/12 for doubles). If type is opt_in, set to null.'
        },
        type: {
          type: 'string',
          enum: ['spots', 'opt_in'],
          description: 'Poll format: "spots" for fixed player count or "opt_in" for Yes/No poll.'
        },
        matchTime: {
          type: 'string',
          description: 'Optional new match time (e.g. "7pm", "9am", "6:30pm").'
        },
        postTime: {
          description: 'Optional new post time (e.g. "8am", "7:30am", "7pm", or day-of-week specific like "7am on weekdays, 8am on weekends" or {"weekdays": "7am", "weekends": "8am"}).'
        },
        postTimesByDay: {
          type: 'object',
          description: 'Optional map of day names or day indices to specific post times (e.g. {"mon": "7am", "tue": "7am", "sat": "8am", "sun": "8am"} or {"weekdays": "7am", "weekends": "8am"}).'
        },
        days: {
          type: 'string',
          description: 'Optional new days of week (e.g. "weekdays", "mon-thu", "weekends", "mon,wed,fri", "everyday").'
        },
        autoMatchups: {
          type: 'boolean',
          description: 'Optional: whether to automatically generate matchups when poll fills.'
        },
        noMatchups: {
          type: 'boolean',
          description: 'Optional: if true, disable automatic matchups generation when poll fills.'
        },
        includeCreator: {
          type: 'boolean',
          description: 'Optional: whether to automatically include creator as Player 1.'
        },
        checkCourts: {
          type: 'boolean',
          description: 'Optional: whether to check and consider SCVCC court availability.'
        },
        includeCourts: {
          type: 'boolean',
          description: 'Optional: whether to check and consider SCVCC court availability.'
        },
        'prebooked-spots': {
          type: 'boolean',
          description: 'Optional: whether to include named voting slots for booking players on prebooked courts.'
        },
        includePrebookedSpots: {
          type: 'boolean',
          description: 'Optional: whether to include named voting slots for booking players on prebooked courts.'
        }
      },
      required: ['scheduleId']
    }
  },
  {
    name: 'list_recurring_polls',
    description: 'Lists all scheduled recurring match polls in this chat.',
    input_schema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'limit_poll_slots',
    description: 'Internally sets or limits the number of player slots for an active match poll or recurring poll instance without deleting or modifying the WhatsApp poll message. If votes reach or cross this limit, the poll is marked filled, and any votes exceeding this limit will not be considered (with a warning sent).',
    input_schema: {
      type: 'object',
      properties: {
        targetId: {
          type: 'string',
          description: 'The poll ID, schedule ID (e.g. "rec_mujmt71n"), or poll time/name of the instance to limit.'
        },
        slots: {
          type: 'integer',
          description: 'The new maximum number of slots/players for this poll instance (e.g. 4, 8, 12).'
        }
      },
      required: ['slots']
    }
  },
  {
    name: 'modify_poll_instance',
    description: 'Modifies a specific active match poll or recurring poll instance (e.g. change time, spots count, courts, or auto-matchups) without altering the recurring schedule for future weeks. The instance can be identified by its poll ID, schedule ID (e.g. "rec_mujmt71n"), or poll time/name. Deletes the older poll from WhatsApp and posts the updated poll.',
    input_schema: {
      type: 'object',
      properties: {
        targetId: {
          type: 'string',
          description: 'The poll ID, schedule ID (e.g. "rec_mujmt71n"), or poll time/name of the instance to modify.'
        },
        size: {
          description: 'Optional new number of players (2 for singles, 4/8/12/16 for doubles), "auto", or null for Yes/No opt-in.'
        },
        when: {
          type: 'string',
          description: 'Optional new day/time description (e.g. "7:30pm", "Wednesday 8pm", "Tomorrow 6pm").'
        },
        timeWord: {
          type: 'string',
          description: 'Optional new time (e.g. "7:30pm", "8pm").'
        },
        dayWord: {
          type: 'string',
          description: 'Optional new day (e.g. "Wednesday", "tomorrow").'
        },
        autoMatchups: {
          type: 'boolean',
          description: 'Optional: whether to auto-generate matchups when filled.'
        },
        noMatchups: {
          type: 'boolean',
          description: 'Optional: if true, disable automatic matchups.'
        },
        checkCourts: {
          type: 'boolean',
          description: 'Optional: whether to check and consider SCVCC court availability.'
        },
        includeCourts: {
          type: 'boolean',
          description: 'Optional: whether to check and consider SCVCC court availability.'
        },
        'prebooked-spots': {
          type: 'boolean',
          description: 'Optional: whether to include named slots for prebooked courts.'
        }
      },
      required: ['targetId']
    }
  },
  {
    name: 'pause_recurring_poll',
    description: 'Pauses a scheduled recurring match poll schedule so it will not automatically post polls until resumed. Can be paused by the schedule creator or group admins. Set scheduleId to "all" to pause all recurring polls.',
    input_schema: {
      type: 'object',
      properties: {
        scheduleId: {
          type: 'string',
          description: 'The schedule ID of the recurring poll to pause (e.g. "rec_1", "rec_mujmt71n") or "all" to pause all recurring schedules.'
        }
      }
    }
  },
  {
    name: 'resume_recurring_poll',
    description: 'Resumes a paused recurring match poll schedule so it resumes automatic poll posting. Can be resumed by the schedule creator or group admins. Set scheduleId to "all" to resume all recurring polls.',
    input_schema: {
      type: 'object',
      properties: {
        scheduleId: {
          type: 'string',
          description: 'The schedule ID of the recurring poll to resume (e.g. "rec_1", "rec_mujmt71n") or "all" to resume all recurring schedules.'
        }
      }
    }
  },
  {
    name: 'skip_recurring_poll_instance',
    description: 'Skips a specific instance (or the next upcoming instance) of a scheduled recurring match poll without pausing or disabling future recurring schedules. If the poll instance was already created as an active poll on WhatsApp, it is cancelled and deleted. If it has not been posted yet, it will not be created. Subsequent instances remain active.',
    input_schema: {
      type: 'object',
      properties: {
        scheduleId: {
          type: 'string',
          description: 'The schedule ID of the recurring poll (e.g. "rec_1", "rec_mujmt71n"). If omitted and only one schedule exists, it will be automatically selected.'
        },
        targetDayOrDate: {
          type: 'string',
          description: 'Optional specific day of week (e.g. "wednesday", "tomorrow") or date (e.g. "2026-10-07", "10/7") of the instance to skip. If omitted, skips the next upcoming instance.'
        }
      }
    }
  },
  {
    name: 'unskip_recurring_poll_instance',
    description: 'Restores a previously skipped instance for a scheduled recurring match poll so it will post automatically as scheduled.',
    input_schema: {
      type: 'object',
      properties: {
        scheduleId: {
          type: 'string',
          description: 'The schedule ID of the recurring poll (e.g. "rec_1", "rec_mujmt71n"). If omitted and only one schedule exists, it will be automatically selected.'
        },
        targetDayOrDate: {
          type: 'string',
          description: 'Optional specific day or date to unskip.'
        }
      }
    }
  },
  {
    name: 'cancel_recurring_poll',
    description: 'Cancels and deletes a scheduled recurring daily match poll by its schedule ID. Only the poll creator or group admins can cancel it.',
    input_schema: {
      type: 'object',
      properties: {
        scheduleId: {
          type: 'string',
          description: 'The schedule ID of the recurring poll to cancel (e.g. "rec_1", "sched_abc").'
        }
      },
      required: ['scheduleId']
    }
  },
  {
    name: 'clear_all_recurring_polls',
    description: 'Clears and deletes all scheduled recurring daily match polls in this chat. Admin only.',
    input_schema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_court_bookings',
    description: 'Retrieves the court schedule and member bookings/reservations (player names, court number, match type, and duration) at Silver Creek Valley Country Club (SCVCC) for tennis or pickleball courts.',
    input_schema: {
      type: 'object',
      properties: {
        when: {
          type: 'string',
          description: 'Date or day description (e.g. "today", "tomorrow", "Saturday", "9/26/2026"). Defaults to today.'
        },
        time: {
          type: 'string',
          description: 'Optional time or period filter (e.g. "6pm", "7:00 PM", "9am", "morning", "afternoon", "evening").'
        },
        court: {
          type: 'string',
          description: 'Optional specific court filter (e.g. "Court 2", "Court 4", "Pickleball 1").'
        },
        sport: {
          type: 'string',
          description: 'Sport type: "tennis" (default), "pickleball", or "all".'
        },
        player: {
          type: 'string',
          description: 'Optional player name filter to check when a specific player is booked.'
        }
      }
    }
  },
  {
    name: 'check_court_availability',
    description: 'Checks real-time court status and available open slots at Silver Creek Valley Country Club (SCVCC) for tennis courts (Courts 1-6) and pickleball courts.',
    input_schema: {
      type: 'object',
      properties: {
        when: {
          type: 'string',
          description: 'Date or day description to check (e.g. "today", "tomorrow", "Saturday", "9/26/2026"). Defaults to today.'
        },
        time: {
          type: 'string',
          description: 'Optional time or period filter (e.g. "6pm", "7:00 PM", "9am", "morning", "afternoon", "evening").'
        },
        court: {
          type: 'string',
          description: 'Optional specific court filter (e.g. "Court 2", "Court 4", "Pickleball 1").'
        },
        sport: {
          type: 'string',
          description: 'Sport type: "tennis" (Courts 1-6, default) or "pickleball" (Pickleball Courts) or "all".'
        }
      }
    }
  },

  {
    name: "list_groups",
    description: "Lists all WhatsApp groups the bot is currently a participating member of, showing group names, WhatsApp JIDs, participant counts, and configuration status.",
    input_schema: {
      type: "object",
      properties: {}
    }
  },
];

// How many past messages (per chat) to keep for conversational context
const HISTORY_LIMIT = 10;

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn(
    '⚠️  No ANTHROPIC_API_KEY found in environment. Copy .env.example to .env ' +
    'and add your key, or LLM replies will fail.'
  );
}

if (groupsConfig.hasWhitelist()) {
  const whitelisted = groupsConfig.getWhitelistedGroups();
  console.log(`✅ Group whitelist active: [${whitelisted.join(", ")}]`);
} else {
  console.log("🌐 Multi-group mode (open): Bot is listening to all groups it is added to.");
}

const TARGET_GROUP_NAME = process.env.TARGET_GROUP_NAME || null;


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

// Poll-related state and voter display name mappings are persisted per group in poll-states/
// so voter identities survive a bot restart.
const {
  messageStore,   // `${remoteJid}:${id}` -> stored WAMessage content, needed for getMessage() and vote decoding
  activePolls,    // pollId -> { remoteJid, size, type, when, playAt, status, creator, lastConflictSignature, voteBuffer, lastPlayers, isManual }
  latestPollIdByChat, // chatId -> pollId, so "!cancelpoll"/"!rematch"/"!pollstatus" know which poll to act on
  recurringPolls  // scheduleId -> recurring schedule object
} = pollStore.load();

const storeKey = (remoteJid, id) => `${remoteJid}:${id}`;

// Ensure all players in names.json have full names defaulted and ratings on startup
namesStore.defaultMissingFullNames();
ratings.syncRatingsWithNames();

function persistPolls(chatId = null) {
  pollStore.save({ messageStore, activePolls, latestPollIdByChat, recurringPolls }, chatId);
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
    const timeWord = timeMatch ? timeMatch[1] : null;
    const dayWord = dayMatch ? dayMatch[1] : null;
    let whenStr = pollName;
    if (timeWord && !dayWord) {
      const playAt = resolvePlayDateTime(null, timeWord);
      const playParts = getSanJoseParts(playAt);
      const nowParts = getSanJoseParts(getSanJoseNow());
      if (playParts.day !== nowParts.day || playParts.month !== nowParts.month) {
        whenStr = `Tomorrow ${timeWord}`;
      }
    }
    return {
      isMatchScheduling,
      dayWord,
      timeWord,
      when: whenStr,
      type: hasYesNo ? 'opt_in' : 'manual',
      size: hasYesNo ? null : (options.length > 0 ? options.length : null)
    };
  };

  if (!anthropic.isAnthropicConfigured()) {
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
2. What day is it scheduled for? (e.g. "today", "tomorrow", "saturday", "sunday", or null if not mentioned). If only a start time was mentioned (e.g. "Tennis 7pm", "6am") without an explicit day word and the start time is already in the past today in San Jose, leave dayWord as null.
3. What time is it scheduled for? (e.g. "9am", "6:30pm", "10am", or null if not mentioned).
4. Provide a clean human-readable when string (e.g. "Sunday 7:30am", "Saturday 6pm", "Tomorrow 7pm", "Today 8:30am"). If only a start time was mentioned without an explicit day and the start time is already in the past today in San Jose (e.g. it is 8pm now and poll title is "Tennis 7pm"), use "Tomorrow <time>" (e.g. "Tomorrow 7pm"). If a day of the week (e.g. Sunday) was mentioned or implied, ALWAYS use the named day (e.g. "Sunday 7:30am"). Only use "Tomorrow" if the user explicitly wrote "tomorrow" or if only a time was given that has already passed today.
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
    const parsed = await anthropic.callAnthropicJson({
      prompt,
      maxTokens: 300
    });

    let resolvedWhenStr = parsed.when || pollName;
    // If an explicit day name was parsed (e.g. Sunday, Saturday), ensure when retains the day name instead of relative "Tomorrow"
    if (parsed.dayWord && !/^(?:today|tomorrow|tonight)$/i.test(parsed.dayWord) && /^(?:tomorrow|today)/i.test(resolvedWhenStr)) {
      const capDay = parsed.dayWord.charAt(0).toUpperCase() + parsed.dayWord.slice(1).toLowerCase();
      resolvedWhenStr = parsed.timeWord ? `${capDay} ${parsed.timeWord}` : capDay;
    }

    return {
      isMatchScheduling: Boolean(parsed.isMatchScheduling),
      dayWord: parsed.dayWord || null,
      timeWord: parsed.timeWord || null,
      when: resolvedWhenStr,
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

  // For Yes/No opt-in polls, only players who voted Yes are playing.
  // Never add creator extra/virtual duplicates (creator 2, etc.) or pad to valid counts.
  const isOptIn = targetPollState.type === 'opt_in' || targetPollState.size === null || options.some((o) => /^yes$/i.test(o.trim()));
  if (isOptIn) {
    const players = [];
    for (const p of currentPlayers) {
      if (!players.some((existing) => ratings.keyFor(existing) === ratings.keyFor(p))) {
        players.push(p);
      }
    }
    return { players, addedCreator: false, addedExtra: [], addedFromLabel: [], addedFromValidCount: [] };
  }

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
  const isFirstVoteLabelSlot1 = firstSlotNum === 1;
  const allSlotsFilled = options.length > 0 && currentPlayers.length >= options.length;

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
 * For fixed-spot polls (including auto-scheduled prebooked court polls):
 * Resolves the list of playing players, filled slot count, total slot count, and whether all slots are filled.
 * Handles:
 * - Prebooked court slots: "<canonical name>'s Spot", which default to the prebooked group player
 *   unless a voter votes on and overrides that slot.
 * - Leading creator/virtual spots (if first option > 1).
 * - Regular voting slots ("Player X").
 */
function resolveFixedPollRoster(pollState, aggregated = [], bySlot = null) {
  const options = pollState.options || [];
  const slotMap = bySlot || new Map((aggregated || []).map((o) => [o.name, o.voters && o.voters.length > 0 ? o.voters[0] : null]));

  const prebookedSlotMap = new Map();
  if (Array.isArray(pollState.prebookedPlayers)) {
    for (const p of pollState.prebookedPlayers) {
      if (typeof p === 'string') {
        prebookedSlotMap.set(`${p}'s Spot`, p);
      } else if (p && typeof p === 'object') {
        const sName = p.slotName || p.slot || `${p.defaultPlayer || p.name}'s Spot`;
        const pName = p.defaultPlayer || p.name || p.canonicalName;
        if (sName && pName) prebookedSlotMap.set(sName, pName);
      }
    }
  }

  const hasPrebooked = prebookedSlotMap.size > 0;
  const firstSlotNum = hasPrebooked ? null : getFirstSlotNumber(options);
  const leadingSpots = (!hasPrebooked && firstSlotNum && firstSlotNum > 1)
    ? (firstSlotNum - 1)
    : (!hasPrebooked && pollState.creator ? 1 : 0);
  const creatorName = pollState.creator?.name || (pollState.creator?.jid ? nameFor(pollState.creator.jid) : 'Creator');

  const allPlayers = [];
  // For polls with leading virtual/creator spots
  for (let i = 0; i < leadingSpots; i++) {
    addNextCreatorPlayer(allPlayers, creatorName);
  }

  let filledCount = leadingSpots;
  const totalSlotsCount = leadingSpots + options.length;

  for (const opt of options) {
    const voterJid = slotMap.get(opt);
    if (voterJid) {
      // Voted slot (or overridden prebooked slot)
      const playerName = nameFor(voterJid);
      allPlayers.push(playerName);
      filledCount++;
    } else if (prebookedSlotMap.has(opt)) {
      // Unvoted prebooked slot -> defaults to prebooked player
      const defaultPlayer = prebookedSlotMap.get(opt);
      allPlayers.push(defaultPlayer);
      filledCount++;
    } else {
      // Unvoted normal slot -> empty
    }
  }

  const effectiveLimit = (typeof pollState.slotLimit === 'number' && pollState.slotLimit > 0)
    ? pollState.slotLimit
    : totalSlotsCount;

  const players = allPlayers.slice(0, effectiveLimit);
  const excessPlayers = allPlayers.slice(effectiveLimit);
  const effFilledCount = Math.min(filledCount, effectiveLimit);
  const effTotalSlotsCount = effectiveLimit;
  const isAllFilled = (filledCount >= effectiveLimit);

  return {
    players,
    allPlayers,
    excessPlayers,
    filledCount: effFilledCount,
    totalSlotsCount: effTotalSlotsCount,
    naturalTotalSlots: totalSlotsCount,
    isAllFilled,
    prebookedSlotMap
  };
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

  const isPollCreationCommand = /^!(?:createpoll|poll|makepoll|newpoll|optinpoll|yesnopoll|createoptinpoll|createyesnopoll)\b/i.test(text);
  const isPollCreationPhrase = /\b(?:create|make|post|start|set\s*up|setup|open|put|put\s*up|add|send|run|do)\s+(?:a\s+)?(?:match\s+)?(?:singles\s+|doubles\s+|yes\/no\s+|yesno\s+|opt-?in\s+)?poll\b|\bnew\s+(?:match\s+)?(?:singles\s+|doubles\s+|yes\/no\s+|yesno\s+|opt-?in\s+)?poll\b|\b(?:opt-?in|yes\s*\/\s*no|yesno)\s+poll\b|\bpoll\s+for\b/i.test(text);

  if (!isPollCreationCommand && !isPollCreationPhrase) {
    return null;
  }

  // If this is a recurring/daily poll request, leave it for parseRecurringPollText
  if (/\b(?:daily|recurring|repeating|every\s*day)\b/i.test(text)) {
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

  // Extract court mention if any (e.g. "court 2", "Court 2", "ct 2", "pickleball 1")
  let court = null;
  const courtMatch = text.match(/\b(?:on\s+|at\s+|for\s+)?(?:the\s+)?(court\s*#?\s*\d+|pickleball\s*#?\s*\d+|pb\s*#?\s*\d+)\b/i);
  if (courtMatch) {
    const rawCourt = courtMatch[1].replace(/#/g, '').replace(/\s+/g, ' ').trim();
    if (/^court\s*\d+$/i.test(rawCourt)) {
      const num = rawCourt.match(/\d+/)[0];
      court = `Court ${num}`;
    } else if (/^pickleball\s*\d+$/i.test(rawCourt)) {
      const num = rawCourt.match(/\d+/)[0];
      court = `Pickleball ${num}`;
    } else if (/^pb\s*\d+$/i.test(rawCourt)) {
      const num = rawCourt.match(/\d+/)[0];
      court = `PB ${num}`;
    } else {
      court = rawCourt;
    }
  }

  // Remove time patterns from text before parsing size so that times like "10:30am" or "10am" don't match as size 10
  let textWithoutTime = text;
  if (timeMatch) {
    textWithoutTime = textWithoutTime.replace(timeMatch[0], ' ');
  }
  textWithoutTime = textWithoutTime.replace(/\b\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)\b/ig, ' ').replace(/\b\d{1,2}[:.]\d{2}\b/g, ' ');

  // Remove specific court mentions before parsing size so that "court 2" doesn't match as size 2
  let textCleanedForSize = textWithoutTime.replace(/\b(?:on\s+|at\s+|for\s+)?(?:the\s+)?(?:courts?|pickleball|pb)\s*#?\s*\d+\b/gi, ' ');

  // Determine size
  const isExplicitOptIn = /\b(?:opt-?in|yes\s*\/\s*no|yesno|open)\b/i.test(text) ||
    /^!(?:optinpoll|yesnopoll|createoptinpoll|createyesnopoll)\b/i.test(text);
  let size = null;
  if (!isExplicitOptIn) {
    if (/\bauto\b/i.test(textCleanedForSize) || /\bauto[-_\s]*(?:spots?|players?|courts?|size)\b/i.test(textCleanedForSize)) {
      size = 'auto';
    } else {
      // 1 court -> 4 players, 2 courts -> 8 players, 3 courts -> 12 players
      const courtCountMatch = textCleanedForSize.match(new RegExp(`\\b(\\d+|${NUMBER_WORDS_PATTERN})\\s+courts?\\b`, 'i'));
      if (courtCountMatch) {
        const raw = courtCountMatch[1].toLowerCase();
        const count = WORD_TO_NUMBER[raw] || parseInt(raw, 10);
        if (count > 0 && count <= 4) size = count * 4;
      }

      if (!size) {
        const explicitMatch = textCleanedForSize.match(new RegExp(`\\b(?:for|size|spots?|players?)\\s*[:=]?\\s*(\\d+|${NUMBER_WORDS_PATTERN})\\b`, 'i')) ||
          textCleanedForSize.match(new RegExp(`\\b(\\d+|${NUMBER_WORDS_PATTERN})\\s*(?:spots?|players?|people)\\b`, 'i')) ||
          textCleanedForSize.match(new RegExp(`\\bpoll\\s+for\\s+(\\d+|${NUMBER_WORDS_PATTERN})\\b`, 'i')) ||
          textCleanedForSize.match(new RegExp(`^!(?:createpoll|poll|makepoll|newpoll)\\s+(\\d+|${NUMBER_WORDS_PATTERN})\\b`, 'i')) ||
          textCleanedForSize.match(new RegExp(`\\b(?:create|make|post|start|open|put)\\s+(?:a\\s+)?(?:match\\s+)?poll\\s+(\\d+|${NUMBER_WORDS_PATTERN})\\b`, 'i'));

        if (explicitMatch) {
          const raw = explicitMatch[1].toLowerCase();
          size = WORD_TO_NUMBER[raw] || parseInt(raw, 10);
        } else if (/\bsingles\b/i.test(textCleanedForSize)) {
          size = 2;
        } else if (/\bdoubles\b/i.test(textCleanedForSize)) {
          size = 4;
        } else {
          const fallbackMatch = textCleanedForSize.match(new RegExp(`\\b([248]|12|16|two|four|eight|twelve|sixteen)\\s*(?:players?|spots?)?\\b`, 'i'));
          if (fallbackMatch) {
            const raw = fallbackMatch[1].toLowerCase();
            size = WORD_TO_NUMBER[raw] || parseInt(raw, 10);
          }
        }
      }
    }
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

  // Determine noMatchups
  const noMatchups = /(?:^|\s)(?:--no-?matchups?|--no-?draw)\b|\b(?:no[-_\s]*matchups?|no[-_\s]*draw|without\s+(?:auto[-_\s]*|automatic\s+)?matchups?|without\s+(?:auto[-_\s]*|automatic\s+)?draw|(?:do\s*not|don'?t)\s+(?:create|make|generate|post|auto-?generate)\s+(?:matchups?|draw|the\s+draw|the\s+matchups?)|no[-_\s]*(?:auto\s+|automatic\s+)?matchups?)\b/i.test(text);

  // Determine court availability checking (default: false / do not check court availability)
  const checkCourts = /(?:^|\s)(?:--courts?|--check-?courts?|--court-?avail(?:ability)?|--include-?courts?|--with-?courts?|--consider-?courts?|--consider-?court-?avail(?:ability)?)\b/i.test(text) ||
    /\b(?:(?:consider|considering|check|checking|include|including)\s+(?:the\s+)?(?:courts?|court\s+availability|availability)|with\s+(?:the\s+)?(?:courts|court\s+availability)|(?:consider|check)\s+availability)\b/i.test(text);

  // Determine includePrebookedSpots
  let includePrebookedSpots = false;
  if (/(?:^|\s)(?:--?no-?prebooked[-_]?spots?|no-?prebooked[-_]?spots?|--?no-?named-?spots?|--?prebooked[-_]?spots?=(?:false|no|0)|prebooked[-_]?spots?=(?:false|no|0))\b|\b(?:without|no)\s+(?:named\s+|the\s+)?prebooked[-_]?spots?\b/i.test(text)) {
    includePrebookedSpots = false;
  } else if (/(?:^|\s)(?:--?prebooked[-_]?spots?|prebooked[-_]?spots?)(?:=(?:true|yes|1))?\b|(?:^|\s)(?:--with-?prebooked-?spots?|--named-?prebooked-?slots?|--prebooked-?slots?)\b|\b(?:with|include)\s+(?:named\s+|the\s+)?prebooked[-_]?(?:spots?|slots?)\b/i.test(text)) {
    includePrebookedSpots = true;
  }

  return {
    size,
    when,
    dayWord,
    timeWord,
    court,
    includeCreator,
    cancelExisting,
    noMatchups,
    checkCourts,
    includeCourts: checkCourts,
    includePrebookedSpots,
    'prebooked-spots': includePrebookedSpots,
    prebookedSpots: includePrebookedSpots
  };
}

/**
 * Handles direct poll creation from parsed message parameters without calling the LLM.
 */
async function handleDirectPollCreation(sock, chatId, sender, msg, parsed, opts = {}) {
  const { size, when, dayWord, timeWord, court, includeCreator, cancelExisting, noMatchups, checkCourts } = parsed;
  const includePrebookedSpots = parsed?.['prebooked-spots'] !== undefined
    ? parsed['prebooked-spots']
    : (parsed?.prebookedSpots !== undefined ? parsed.prebookedSpots : parsed?.includePrebookedSpots);
  const isCommand = opts.isCommand === true;
  const creatorName = sender !== 'Someone' ? sender : (msg?.key?.participant ? nameFor(msg.key.participant) : 'Player 1');
  const creatorJid = msg?.key?.participant || msg?.key?.remoteJid || null;
  const targetChatId = chatId.endsWith('@g.us') ? chatId : (await getTargetGroupJid(sock) || chatId);

  const effectiveCheckCourts = checkCourts !== undefined
    ? Boolean(checkCourts)
    : Boolean(parsed.includeCourts);

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
    cancelExisting,
    isCommand,
    noMatchups || false,
    effectiveCheckCourts,
    includePrebookedSpots || false,
    false,
    null,
    court
  );

  if (res?.err) {
    if (res.noCourtsAvailable) {
      return null;
    }
    return `Could not create poll: ${res.err}`;
  }

  const resolvedWhen = res?.when ? ` for ${res.when}` : (when ? ` for ${when}` : '');
  const replacedNote = res?.replacedOldPoll ? ' (older poll deleted from WhatsApp)' : '';

  // The poll title itself has the time and number of slots to vote for (or Yes/No opt-in),
  // so do not generate a separate confirmation text message after posting the poll.
  return null;
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
 * Checks if two identities (JID and/or display name) represent the same user.
 */
/**
 * Checks if a user is an admin or superadmin in a group.
 */
/**
 * Retrieves the target group JID (caching if necessary).
 */
async function getAdminGroupsForUser(sock, senderJid) {
  if (!sock || !senderJid) return [];
  const adminGroups = [];
  try {
    let groups = groupMetadataCache;
    if (groups.size === 0) {
      const fetched = await sock.groupFetchAllParticipating();
      for (const [gId, gMeta] of Object.entries(fetched)) {
        groupMetadataCache.set(gId, gMeta);
      }
      groups = groupMetadataCache;
    }

    const normUser = jidNormalizedUser(senderJid);
    const pnUser = namesStore.getPnByLid(normUser) || (normUser?.endsWith("@s.whatsapp.net") ? normUser : null);
    const lidUser = namesStore.resolveCanonicalId(normUser) || (normUser?.endsWith("@lid") ? normUser : null);

    for (const [gId, gMeta] of groups.entries()) {
      if (!groupsConfig.isGroupAllowed(gId, gMeta.subject)) continue;
      if (!gMeta.participants) continue;

      const participant = gMeta.participants.find((p) => {
        const pPn = jidNormalizedUser(p.id || p.jid);
        const pLid = jidNormalizedUser(p.lid);
        return (
          pPn === normUser ||
          pLid === normUser ||
          (pnUser && (pPn === pnUser || pLid === pnUser)) ||
          (lidUser && (pPn === lidUser || pLid === lidUser))
        );
      });

      if (participant && (participant.admin === "admin" || participant.admin === "superadmin")) {
        adminGroups.push({ id: gId, name: gMeta.subject || gId });
      }
    }
  } catch (err) {
    console.error("Failed to get admin groups for user:", err.message);
  }
  return adminGroups;
}

async function getTargetGroupJid(sock, senderJid = null) {
  if (senderJid) {
    const adminGroups = await getAdminGroupsForUser(sock, senderJid);
    if (adminGroups.length > 0) return adminGroups[0].id;
  }
  if (targetGroupJid) return targetGroupJid;
  try {
    const groups = await sock.groupFetchAllParticipating();
    for (const [gId, gMeta] of Object.entries(groups)) {
      groupMetadataCache.set(gId, gMeta);
      if (groupsConfig.isGroupAllowed(gId, gMeta.subject)) {
        targetGroupJid = gId;
        return gId;
      }
    }
  } catch (err) {
    console.error("Failed to fetch participating groups:", err.message);
  }
  return null;
}

/**
 * Lists all WhatsApp groups the bot is currently a participating member of,
 * displaying their group names (subjects), JIDs / LIDs, participant counts, and config status.
 */
async function handleListGroups(sock) {
  const activeSock = sock || botSock;
  let groups = {};

  if (activeSock && typeof activeSock.groupFetchAllParticipating === "function") {
    try {
      groups = await activeSock.groupFetchAllParticipating();
      if (groups && typeof groups === "object") {
        for (const [gId, gMeta] of Object.entries(groups)) {
          groupMetadataCache.set(gId, gMeta);
        }
      }
    } catch (err) {
      console.warn("[groups] Failed to fetch participating groups via socket, falling back to cache:", err.message);
    }
  }

  // Fallback to cached group metadata if socket fetch returned empty or failed
  if ((!groups || Object.keys(groups).length === 0) && groupMetadataCache.size > 0) {
    groups = {};
    for (const [gId, gMeta] of groupMetadataCache.entries()) {
      groups[gId] = gMeta;
    }
  }

  const groupEntries = Object.entries(groups || {});
  if (groupEntries.length === 0) {
    return "The bot is not currently a member of any WhatsApp groups.";
  }

  // Sort alphabetically by group subject
  groupEntries.sort((a, b) => (a[1]?.subject || "").localeCompare(b[1]?.subject || ""));

  const lines = [`👥 *WhatsApp Groups the bot is a member of* (${groupEntries.length}):\n`];

  for (let i = 0; i < groupEntries.length; i++) {
    const [gId, gMeta] = groupEntries[i];
    const subject = gMeta?.subject || "Unnamed Group";
    const count = Array.isArray(gMeta?.participants) ? gMeta.participants.length : (gMeta?.size || "Unknown");
    const isAllowed = groupsConfig.isGroupAllowed(gId, subject);
    const groupCfg = groupsConfig.getGroupConfig(gId, subject);

    let statusNote = "";
    if (!isAllowed) {
      statusNote = " ⛔ [Not in whitelist]";
    } else if (groupCfg?.alias || (groupCfg?.name && groupCfg.name !== gId)) {
      statusNote = " ⚙️ [Configured in groups.json]";
    }

    lines.push(`${i + 1}. *${subject}*${statusNote}`);
    lines.push(`   • JID: \`${gId}\``);
    lines.push(`   • Members: ${count}`);
    if (groupCfg?.alias) {
      lines.push(`   • Alias: ${groupCfg.alias}`);
    }
    lines.push("");
  }

  lines.push("💡 _Use the group JID as the key in groups.json for group-specific configuration._");
  return lines.join("\n").trim();
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
  if (k1 && k2 && !GENERIC_NAMES.has(k1) && !GENERIC_NAMES.has(k2)) {
    if (k1 === k2) return true;
    const m1 = namesStore.findIdByNameOrAlias(name1);
    const m2 = namesStore.findIdByNameOrAlias(name2);
    if (m1 && m2 && m1.id === m2.id) return true;
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

  // 3. Check prebookedPlayers (if default spot not overridden)
  if (Array.isArray(pollState.prebookedPlayers)) {
    const userKey = ratings.keyFor(userName);
    const resolvedName = userJid ? nameFor(userJid) : null;
    const resolvedKey = resolvedName ? ratings.keyFor(resolvedName) : null;

    for (const pb of pollState.prebookedPlayers) {
      const pbName = typeof pb === 'string' ? pb : (pb.defaultPlayer || pb.name || pb.canonicalName);
      const pbFullName = typeof pb === 'object' ? pb.fullName : null;
      const pbKey = ratings.keyFor(pbName);
      const pbFullKey = pbFullName ? ratings.keyFor(pbFullName) : null;

      if ((userKey && (userKey === pbKey || userKey === pbFullKey)) ||
          (resolvedKey && (resolvedKey === pbKey || resolvedKey === pbFullKey))) {
        return true;
      }
    }
  }

  // 4. Check lastPlayers if poll was resolved
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

  // Record participant name, LID mappings, and group membership for allowed groups
  const isAllowed = groupsConfig.isGroupAllowed(remoteJid, metadata?.subject);
  if (isAllowed && metadata?.participants) {
    namesStore.setGroupMembers(remoteJid, metadata.participants);
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
/**
 * Uses LLM to determine if a message is announcing that a tennis court
 * reservation / session is being cancelled due to lack of votes / not enough players in a match poll.
 * If so, returns { isCourtCancelledDueToLackOfVotes: true, pollId, reason }.
 */
async function checkCourtCancellationWithLLM(text, sender, chatId) {
  if (!anthropic.isAnthropicConfigured()) return null;

  const chatPolls = [...activePolls.entries()].filter(([, state]) =>
    state.remoteJid === chatId && state.status === 'active'
  );
  if (chatPolls.length === 0) return null;

  const prompt = `You are an intelligent assistant for a tennis group chat in San Jose, CA.
A group member sent this message in the chat:
Sender: "${sender}"
Message: "${text}"

Active Match Polls in this chat:
${chatPolls.map(([id, p]) => `- Poll ID: "${id}", Title: "${p.name || p.when}", Scheduled: "${p.when || p.playAt}", Status: "${p.status}", Spots: ${p.size || 'Opt-in'}`).join('\n')}

Task:
Analyze if the sender is announcing or stating that a tennis court (or court session/reservation) is being cancelled or released (e.g. "Cancelled the court", "Cancelling 2nd court due to lack of players", "Cancelled the 8:30am court since we only have 2", "I am cancelling the court because we don't have 4", "Releasing court because poll didn't fill", etc.).
Note: If they are simply asking a question, talking about general court availability, cancelling their own individual participation (e.g. "I have to cancel today"), or chatting about unrelated topics, set isCourtCancelledDueToLackOfVotes to false.

Respond ONLY with a JSON object in this exact format, with no extra text or markdown:
{
  "isCourtCancelled": boolean,
  "pollId": string or null,
  "reason": string
}`;

  try {
    return await anthropic.callAnthropicJson({
      prompt,
      maxTokens: 250
    });
  } catch (err) {
    console.error('[court-cancel-llm] Failed to check court cancellation with LLM:', err.message);
    return null;
  }
}

/**
 * Stops voting on a poll: closes voting, halts reminders, and sets status to 'stopped'
 * without deleting the poll message from WhatsApp.
 */

/**
 * Uses LLM to decode free-form or mentioned lineup messages
 * (e.g. "@132388105547860 @278081952608440 @169384953794573 @78636841447513 - Court 6 7.00 pm").
 */
async function parseLineupWithLLM(text, chatId) {
  if (!anthropic.isAnthropicConfigured()) return null;
  console.log(`[lineup-llm] Invoking Claude to parse manual lineup in ${chatId}: "${text}"`);

  const playerEntries = namesStore.getAllEntries();
  const playerListDesc = playerEntries.map((e) => {
    const rawId = e.id ? e.id.split('@')[0] : '';
    const rawPn = e.pn ? e.pn.split('@')[0] : '';
    const aliasesStr = e.aliases && e.aliases.length > 0 ? `, aliases: [${e.aliases.join(', ')}]` : '';
    const ids = [rawId, rawPn].filter(Boolean).join(', ');
    return `- "${e.name}"${e.fullName ? ` (${e.fullName})` : ''} [IDs/Mentions: ${ids || 'none'}${aliasesStr}]`;
  }).join('\n');

  const activePollsDesc = [...activePolls.entries()]
    .filter(([, p]) => p.remoteJid === chatId && (p.status === 'active' || p.status === 'filled' || p.status === 'stopped'))
    .map(([id, p]) => `- Poll "${p.name || p.when || id}" (size: ${p.size || 'opt-in'}, when: "${p.when || ''}", status: ${p.status})`)
    .join('\n');

  const prompt = `You are an expert tennis assistant parsing a WhatsApp group chat message in San Jose, CA.
A group member just posted this message:
"""
${text}
"""

Active tennis match polls in this chat:
${activePollsDesc || '(none)'}

Known registered players in this tennis group (with their WhatsApp mention IDs and aliases):
${playerListDesc}

Task:
Determine if this message is announcing or publishing match lineups, player court assignments, teams, or rotations (e.g. "@132388105547860 @278081952608440 @169384953794573 @78636841447513 - Court 6 7.00 pm", "Court 1: Alice & Bob vs Charlie & David", "Set 1: Court 2 Mike / Sara vs John / Alex", "Alice Bob vs Charlie Dave Court 3", etc.).

Rules:
1. Map any @<digits> or @<name> mentions to the correct player display name using the known registered players list. If a mention ID is not in the list, use the short name or phone number as the player name.
2. If 4 players are listed on a court without explicit "vs" (e.g. "@P1 @P2 @P3 @P4 - Court 6 7pm"), treat them as a doubles session on that court:
   - teamA: [Player 1, Player 2]
   - teamB: [Player 3, Player 4]
3. If 2 players are listed on a court without "vs", treat them as singles: teamA: [Player 1], teamB: [Player 2].
4. If this is just casual conversation, banter, a question, or a score report (e.g. "we won", "beat", "defeated", score like "6-4 6-2"), set "isLineup": false.

Respond ONLY with a JSON object in this exact format:
{
  "isLineup": boolean,
  "type": "singles" | "doubles",
  "time": string or null,
  "players": ["Player 1", "Player 2", ...],
  "sets": [
    {
      "set": 1,
      "courts": [
        {
          "court": 6,
          "teamA": ["Player 1", "Player 2"],
          "teamB": ["Player 3", "Player 4"]
        }
      ]
    }
  ]
}
If isLineup is false, return:
{
  "isLineup": false
}`;

  try {
    const parsed = await anthropic.callAnthropicJson({
      prompt,
      maxTokens: 500
    });

    if (!parsed || !parsed.isLineup || !Array.isArray(parsed.players) || parsed.players.length < 2 || !Array.isArray(parsed.sets) || parsed.sets.length === 0) {
      return null;
    }

    const resolvePlayer = (p) => {
      const clean = String(p).replace(/^@/, '').trim();
      const resolved = nameFor(clean);
      return resolved || clean;
    };

    const resolvedPlayers = parsed.players.map(resolvePlayer);
    const resolvedSets = parsed.sets.map((s) => ({
      ...s,
      courts: (s.courts || []).map((c) => ({
        ...c,
        teamA: (c.teamA || []).map(resolvePlayer),
        teamB: (c.teamB || []).map(resolvePlayer)
      }))
    }));

    console.log(`[lineup-llm] Decoded lineup (${parsed.type || 'doubles'}${parsed.time ? ` at ${parsed.time}` : ''}): ${resolvedPlayers.length} player(s) [${resolvedPlayers.join(', ')}]`);
    return {
      type: parsed.type || (resolvedPlayers.length === 2 ? 'singles' : 'doubles'),
      time: parsed.time ? String(parsed.time).trim() : null,
      players: resolvedPlayers,
      sets: resolvedSets
    };
  } catch (err) {
    console.error('[lineup-llm] Failed to parse lineup with LLM:', err.message);
    return null;
  }
}

async function handleStopPoll(sock, chatId, sender, senderJid, specificPollId = null) {
  let targetPollId = specificPollId || null;
  if (!targetPollId) {
    for (const [pollId, pollState] of [...activePolls.entries()].reverse()) {
      if (pollState.remoteJid === chatId && (pollState.status === 'active' || pollState.status === 'filled')) {
        targetPollId = pollId;
        break;
      }
    }
  }
  if (!targetPollId) {
    targetPollId = latestPollIdByChat.get(chatId);
  }
  if (!targetPollId || !activePolls.has(targetPollId)) {
    return 'No active poll to stop.';
  }

  const targetPollState = activePolls.get(targetPollId);
  if (targetPollState.status === 'stopped') {
    return `Poll "${targetPollState.name || targetPollState.when || targetPollId}" is already stopped.`;
  }
  if (targetPollState.status === 'cancelled') {
    return 'This poll was cancelled.';
  }

  const isCreator = targetPollState.creator ? isSameUser(targetPollState.creator.jid, senderJid, targetPollState.creator.name, sender) : false;
  const isAdmin = await isUserAdmin(sock, chatId, senderJid);

  if (!isCreator && !isAdmin) {
    return '⚠️ Only the poll creator or group admins can stop voting on this poll.';
  }

  targetPollState.status = 'stopped';
  persistPolls();

  const pollName = targetPollState.name || targetPollState.when || 'Match Poll';
  console.log(`[poll] Poll ${targetPollId} ("${pollName}") in ${chatId} status set to stopped by ${sender}`);
  return `🛑 Voting has been stopped for "${pollName}". Reminders are closed and status is set to stopped. You can generate matchups anytime with "!matchups".`;
}

/**
 * Resumes voting on a stopped poll: restores status to 'active' (or 'filled' if all slots are occupied),
 * resumes vote tracking, and re-enables upcoming reminders.
 */
async function handleResumePoll(sock, chatId, sender, senderJid, specificPollId = null) {
  let targetPollId = specificPollId || null;
  if (!targetPollId) {
    for (const [pollId, pollState] of [...activePolls.entries()].reverse()) {
      if (pollState.remoteJid === chatId && pollState.status === 'stopped') {
        targetPollId = pollId;
        break;
      }
    }
  }
  if (!targetPollId) {
    targetPollId = latestPollIdByChat.get(chatId);
  }
  if (!targetPollId || !activePolls.has(targetPollId)) {
    return 'No stopped poll to resume.';
  }

  const targetPollState = activePolls.get(targetPollId);
  if (targetPollState.status === 'active' || targetPollState.status === 'filled') {
    return `Poll "${targetPollState.name || targetPollState.when || targetPollId}" is already active.`;
  }
  if (targetPollState.status === 'resolved') {
    return `Poll "${targetPollState.name || targetPollState.when || targetPollId}" has already been resolved/drawn.`;
  }
  if (targetPollState.status === 'cancelled') {
    return 'This poll was cancelled and cannot be resumed.';
  }
  if (targetPollState.status === 'expired') {
    return `Poll "${targetPollState.name || targetPollState.when || targetPollId}" has expired (scheduled match play time has passed).`;
  }

  const isCreator = targetPollState.creator ? isSameUser(targetPollState.creator.jid, senderJid, targetPollState.creator.name, sender) : false;
  const isAdmin = await isUserAdmin(sock, chatId, senderJid);

  if (!isCreator && !isAdmin) {
    return '⚠️ Only the poll creator or group admins can resume voting on this poll.';
  }

  // Determine if it should be 'filled' or 'active'
  let newStatus = 'active';
  const isOptIn = targetPollState.type === 'opt_in' || targetPollState.options?.some((o) => /^yes$/i.test(o));

  if (!isOptIn) {
    if (targetPollState.isManual) {
      const totalOptionsCount = targetPollState.options ? targetPollState.options.length : 0;
      const filledCount = targetPollState.voteBuffer ? targetPollState.voteBuffer.size : 0;
      if (totalOptionsCount > 0 && filledCount >= totalOptionsCount) {
        newStatus = 'filled';
      }
    } else {
      const totalSpots = targetPollState.size || (targetPollState.options ? targetPollState.options.length : 4);
      const neededVotes = targetPollState.creator ? totalSpots - 1 : totalSpots;
      const filledVotes = targetPollState.voteBuffer ? targetPollState.voteBuffer.size : 0;
      if (neededVotes > 0 && filledVotes >= neededVotes) {
        newStatus = 'filled';
      }
    }
  }

  targetPollState.status = newStatus;
  latestPollIdByChat.set(chatId, targetPollId);
  persistPolls();

  const pollName = targetPollState.name || targetPollState.when || 'Match Poll';
  const reminderNote = newStatus === 'filled' ? 'all spots are currently filled (waiting for matchup request)' : 'reminders are active';
  console.log(`[poll] Poll ${targetPollId} ("${pollName}") in ${chatId} status resumed to ${newStatus} by ${sender}`);
  return `▶️ Voting has been resumed for "${pollName}". Status is now ${newStatus} and ${reminderNote}.`;
}

/**
 * Pauses reminders for a specific poll or for all active polls in the chat.
 * Any group member can run this command.
 */
/**
 * Helper to build and send a reminder message for an active poll.
 */
async function sendPollReminder(sock, pollId, pollState, isManualTrigger = false) {
  if (!sock || !pollState || pollState.status !== 'active') return false;

  const now = Date.now();
  const mePn = jidNormalizedUser(sock.user?.id || sock.authState?.creds?.me?.id || '');

  let hoursRemaining = 0;
  if (pollState.playAt) {
    const playAtMs = new Date(pollState.playAt).getTime();
    if (!Number.isNaN(playAtMs)) {
      hoursRemaining = Math.max(0, (playAtMs - now) / (60 * 60 * 1000));
    }
  }

  const isOptIn = pollState.type === 'opt_in' || pollState.options?.some((o) => /^yes$/i.test(o));

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
      players = [...interestedPlayers];
    } else {
      if (openSpots <= 0 && !isManualTrigger) return false;
      const { players: resolvedPlayers } = resolveManualPollPlayers(pollState, interestedPlayers);
      players = resolvedPlayers;
    }
  } else if (isOptIn) {
    yesCount = interestedPlayers.length;
    players = [...interestedPlayers];
  } else {
    const { players: resolvedPlayers, filledCount, totalSlotsCount } = resolveFixedPollRoster(pollState, aggregated);
    totalSpots = totalSlotsCount;
    openSpots = Math.max(0, totalSlotsCount - filledCount);
    neededVotes = totalSlotsCount;

    if (openSpots <= 0 && !isManualTrigger) return false;

    players = resolvedPlayers;
  }

  const playerList = players.length > 0 ? players.join(', ') : 'None yet';

  const targetH = POWERS_OF_2_REMINDER_HOURS.find((h) => hoursRemaining <= h) || (hoursRemaining || 1);
  const reminderText = buildPollReminderText(targetH, pollState, openSpots, totalSpots, playerList, isOptIn, yesCount, hoursRemaining);

  const storedMessage = messageStore.get(storeKey(pollState.remoteJid, pollId));
  const fromMe = !pollState.isManual;
  const participant = pollState.creator?.jid;

  const quotedMsg = {
    key: {
      remoteJid: pollState.remoteJid,
      id: pollId,
      fromMe: Boolean(fromMe),
      ...(participant ? { participant } : {})
    },
    ...(storedMessage ? { message: storedMessage } : {})
  };

  console.log(`[poll] Sending reminder for poll ${pollId} ("${pollState.name || pollState.when}") in ${pollState.remoteJid} (replying to poll message)`);
  await sock.sendMessage(pollState.remoteJid, { text: reminderText }, { quoted: quotedMsg });

  pollState.reminderCount = (pollState.reminderCount || 0) + 1;
  persistPolls();
  return true;
}

/**
 * Manually sends a reminder for a specific poll or all active polls in the chat.
 */
async function handleTriggerReminder(sock, chatId, sender, specificPollId = null) {
  const targetPolls = [];
  if (specificPollId) {
    if (activePolls.has(specificPollId)) {
      const p = activePolls.get(specificPollId);
      if (p.remoteJid === chatId && p.status === 'active') {
        targetPolls.push([specificPollId, p]);
      }
    }
  } else {
    for (const [id, state] of activePolls.entries()) {
      if (state.remoteJid === chatId && state.status === 'active') {
        targetPolls.push([id, state]);
      }
    }
  }

  if (targetPolls.length === 0) {
    return 'No active match polls found in this chat to send reminders for.';
  }

  let sentCount = 0;
  for (const [id, state] of targetPolls) {
    try {
      const sent = await sendPollReminder(sock, id, state, true);
      if (sent) sentCount++;
    } catch (err) {
      console.error(`[poll] Failed to send manual reminder for poll ${id}:`, err.message);
    }
  }

  console.log(`[reminders] Manual reminder triggered for ${sentCount}/${targetPolls.length} poll(s) in ${chatId} by ${sender}`);
  return null;
}

async function handlePauseReminders(sock, chatId, sender, specificPollId = null) {
  const targetPolls = [];
  if (specificPollId) {
    if (activePolls.has(specificPollId)) {
      const p = activePolls.get(specificPollId);
      if (p.remoteJid === chatId && p.status === 'active') {
        targetPolls.push([specificPollId, p]);
      }
    }
  } else {
    for (const [id, state] of activePolls.entries()) {
      if (state.remoteJid === chatId && state.status === 'active') {
        targetPolls.push([id, state]);
      }
    }
  }

  if (targetPolls.length === 0) {
    return 'No active match polls found in this chat to pause reminders for.';
  }

  const names = [];
  for (const [id, state] of targetPolls) {
    state.remindersPaused = true;
    names.push(`"${state.name || state.when || id}"`);
  }
  persistPolls();

  console.log(`[reminders] Reminders paused for ${targetPolls.length} poll(s) in ${chatId} by ${sender}`);
  return `⏸️ Reminders have been paused for ${names.join(', ')}. Use "!resumereminders" to resume them anytime.`;
}

/**
 * Resumes reminders for a specific poll or for all active polls in the chat.
 * Any group member can run this command.
 */
async function handleResumeReminders(sock, chatId, sender, specificPollId = null) {
  const targetPolls = [];
  if (specificPollId) {
    if (activePolls.has(specificPollId)) {
      const p = activePolls.get(specificPollId);
      if (p.remoteJid === chatId && p.status === 'active') {
        targetPolls.push([specificPollId, p]);
      }
    }
  } else {
    for (const [id, state] of activePolls.entries()) {
      if (state.remoteJid === chatId && state.status === 'active') {
        targetPolls.push([id, state]);
      }
    }
  }

  if (targetPolls.length === 0) {
    return 'No active match polls found in this chat to resume reminders for.';
  }

  const names = [];
  for (const [id, state] of targetPolls) {
    state.remindersPaused = false;
    names.push(`"${state.name || state.when || id}"`);
  }
  persistPolls();

  console.log(`[reminders] Reminders resumed for ${targetPolls.length} poll(s) in ${chatId} by ${sender}`);
  return `▶️ Reminders have been resumed for ${names.join(', ')}.`;
}

async function handleScheduleRecurringPoll(sock, chatId, sender, senderJid, params) {
  const targetChatId = chatId.endsWith('@g.us') ? chatId : (await getTargetGroupJid(sock) || chatId);
  return await recurringPollsModule.scheduleRecurringPoll({
    recurringPolls,
    persistPolls,
    targetChatId,
    sender,
    senderJid,
    params
  });
}

function handleListRecurringPolls(chatId) {
  return recurringPollsModule.listRecurringPolls({ recurringPolls, chatId });
}

async function handleCancelRecurringPoll(sock, chatId, sender, senderJid, scheduleId) {
  const cleanId = String(scheduleId || '').trim();
  if (!cleanId) {
    return 'Please provide the schedule ID to cancel, e.g. "!cancelrecurringpoll rec_1" (see "!recurringpolls" for IDs) or "!clearallrecurringpolls" to clear all.';
  }

  if (!recurringPolls.has(cleanId)) {
    return `Schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view all scheduled IDs.`;
  }

  const sched = recurringPolls.get(cleanId);
  const isCreator = sched.creator ? isSameUser(sched.creator.jid, senderJid, sched.creator.name, sender) : false;
  const isAdmin = await isUserAdmin(sock, chatId, senderJid);

  if (!isCreator && !isAdmin) {
    return '⚠️ Only the creator of this recurring poll or group admins can cancel it.';
  }

  return await recurringPollsModule.cancelRecurringPoll({ recurringPolls, persistPolls, sender, scheduleId: cleanId });
}

async function handleClearAllRecurringPolls(sock, chatId, sender, senderJid) {
  const isAdmin = await isUserAdmin(sock, chatId, senderJid);
  if (!isAdmin) {
    return '⚠️ Only group admins can clear all recurring polls.';
  }
  return await recurringPollsModule.clearAllRecurringPolls({ recurringPolls, persistPolls, sender, chatId });
}

function parseModifyInstanceCommand(rawText) {
  const text = (rawText || '').trim();
  let m = text.match(/^!(?:modifyinstance|modifyrecurringinstance|modifypoll|editpoll|updatepoll|editinstance|updateinstance)\s*(.*)$/i);
  let rest = m ? m[1].trim() : null;

  if (!m) {
    const m2 = text.match(/^!(?:modifyrecurringpoll|editrecurringpoll|updaterecurringpoll|changerecurringpoll)\s*(.*)$/i);
    if (m2) {
      const r = m2[1].trim();
      if (/\b(?:--instance|-i|instance)\b/i.test(r)) {
        rest = r.replace(/\b(?:--instance|-i|instance)\b/ig, ' ').trim();
      } else {
        return null;
      }
    } else {
      return null;
    }
  }

  if (!rest) {
    return { targetId: null, updates: {} };
  }

  let targetId = null;
  let rem = '';
  const qMatch = rest.match(/^["']([^"']+)["']\s*(.*)$/);
  if (qMatch) {
    targetId = qMatch[1].trim();
    rem = qMatch[2].trim();
  } else {
    const parts = rest.split(/\s+/, 2);
    targetId = parts[0].trim();
    rem = rest.slice(parts[0].length).trim();
  }

  const updates = {};
  let remForSize = rem;
  const courtM = rem.match(/\b(?:on\s+|at\s+|for\s+)?(?:the\s+)?(court\s*#?\s*\d+|pickleball\s*#?\s*\d+|pb\s*#?\s*\d+)\b/i);
  if (courtM) {
    remForSize = remForSize.replace(courtM[0], ' ');
    const rawCourt = courtM[1].replace(/#/g, '').replace(/\s+/g, ' ').trim();
    if (/^court\s*\d+$/i.test(rawCourt)) {
      updates.court = `Court ${rawCourt.match(/\d+/)[0]}`;
    } else {
      updates.court = rawCourt;
    }
  }
  remForSize = remForSize.replace(/\b(?:on\s+|at\s+|for\s+)?(?:the\s+)?(?:courts?|pickleball|pb)\s*#?\s*\d+\b/gi, ' ');

  if (/\b(?:opt-?in|yes\s*\/\s*no|yesno|open)\b/i.test(rem)) {
    updates.type = 'opt_in';
    updates.size = null;
  } else if (/\bauto\b/i.test(rem)) {
    updates.size = 'auto';
  } else {
    const sizeM = remForSize.match(new RegExp(`\\b(?:for|size|spots?|players?)\\s*[:=]?\\s*(\\d+|${NUMBER_WORDS_PATTERN})\\b`, 'i')) ||
                  remForSize.match(new RegExp(`\\b(\\d+|${NUMBER_WORDS_PATTERN})\\s*(?:spots?|players?|people)\\b`, 'i')) ||
                  remForSize.match(new RegExp(`\\b([248]|12|16|two|four|eight|twelve|sixteen)\\b`, 'i'));
    if (sizeM) {
      const raw = sizeM[1].toLowerCase();
      updates.size = WORD_TO_NUMBER[raw] || parseInt(raw, 10);
    } else if (/\bsingles\b/i.test(remForSize)) {
      updates.size = 2;
    } else if (/\bdoubles\b/i.test(remForSize)) {
      updates.size = 4;
    }
  }

  const timeM = rem.match(/\b(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm))\b/i) || rem.match(/\b(\d{1,2}[:.]\d{2})\b/i);
  if (timeM) {
    updates.timeWord = timeM[1].trim();
  }

  const dayM = rem.match(/\b(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i);
  if (dayM) {
    updates.dayWord = dayM[1].trim();
  }

  if (updates.dayWord && updates.timeWord) {
    const cap = updates.dayWord.charAt(0).toUpperCase() + updates.dayWord.slice(1).toLowerCase();
    updates.when = `${cap} ${updates.timeWord}`;
  } else if (updates.timeWord) {
    updates.when = updates.timeWord;
  } else if (updates.dayWord) {
    updates.when = updates.dayWord.charAt(0).toUpperCase() + updates.dayWord.slice(1).toLowerCase();
  }

  if (/(?:--no-?matchups?|no[-_\s]*matchups?|without[-_\s]*matchups?)/i.test(rem)) {
    updates.noMatchups = true;
  } else if (/(?:--auto-?matchups?|with[-_\s]*matchups?)/i.test(rem)) {
    updates.noMatchups = false;
  }

  if (/(?:--include-?courts?|--courts?|--check-?courts?|--court-?avail(?:ability)?|with[-_\s]*courts?|check[-_\s]*courts?|consider[-_\s]*courts?)/i.test(rem)) {
    updates.checkCourts = true;
  }

  if (/(?:--?prebooked[-_]?spots?|with[-_\s]*prebooked[-_]?spots?)/i.test(rem)) {
    updates.includePrebookedSpots = true;
  } else if (/(?:--?no-?prebooked[-_]?spots?|without[-_\s]*prebooked[-_]?spots?)/i.test(rem)) {
    updates.includePrebookedSpots = false;
  }

  return { targetId, updates };
}

/**
 * Modifies a specific active match poll or recurring poll instance by deleting
 * the older poll from WhatsApp and sending an updated poll with the new parameters.
 */
async function handleModifyPollInstance(sock, chatId, sender, senderJid, targetId, updates = {}) {
  const isDM = Boolean(chatId && !chatId.endsWith('@g.us'));
  const effectiveChatId = isDM ? (targetGroupJid || await getTargetGroupJid(sock) || chatId) : chatId;

  let cleanTarget = String(targetId || '').replace(/^["']|["']$/g, '').trim();

  // Find candidate poll in activePolls
  let matchedPollId = null;
  let matchedPollState = null;

  if (cleanTarget) {
    const cleanLower = cleanTarget.toLowerCase();

    // 1. Exact poll ID match
    for (const [id, state] of activePolls.entries()) {
      if ((state.remoteJid === effectiveChatId || isDM) && id.toLowerCase() === cleanLower) {
        matchedPollId = id;
        matchedPollState = state;
        break;
      }
    }

    // 2. Schedule ID match (for recurring poll instances)
    if (!matchedPollState) {
      for (const [id, state] of activePolls.entries()) {
        if ((state.remoteJid === effectiveChatId || isDM) && (state.status === 'active' || state.status === 'filled' || state.status === 'stopped')) {
          const sid = getPollScheduleId(state);
          if (sid && sid.toLowerCase() === cleanLower) {
            matchedPollId = id;
            matchedPollState = state;
            break;
          }
          if (state.scheduleId && state.scheduleId.toLowerCase() === cleanLower) {
            matchedPollId = id;
            matchedPollState = state;
            break;
          }
        }
      }
    }

    // 3. Name or when match
    if (!matchedPollState) {
      for (const [id, state] of activePolls.entries()) {
        if ((state.remoteJid === effectiveChatId || isDM) && (state.status === 'active' || state.status === 'filled' || state.status === 'stopped')) {
          const pName = (state.name || '').toLowerCase();
          const pWhen = (state.when || '').toLowerCase();
          if (pName.includes(cleanLower) || pWhen.includes(cleanLower) || cleanLower.includes(pWhen)) {
            matchedPollId = id;
            matchedPollState = state;
            break;
          }
        }
      }
    }
  } else {
    // If no target ID provided, check if exactly 1 active poll exists
    const chatPolls = [...activePolls.entries()].filter(([, state]) =>
      (state.remoteJid === effectiveChatId || isDM) && (state.status === 'active' || state.status === 'filled' || state.status === 'stopped')
    );
    if (chatPolls.length === 1) {
      matchedPollId = chatPolls[0][0];
      matchedPollState = chatPolls[0][1];
    } else if (chatPolls.length === 0) {
      return '📅 No active match polls found to modify.';
    } else {
      const descriptions = chatPolls.map(([id, state]) => `\`${id}\` (${state.when || state.name || 'unnamed'})`).join(', ');
      return `Please specify which poll instance to modify: ${descriptions}. Example: "!modifyinstance ${chatPolls[0][0]} 12 7pm"`;
    }
  }

  if (!matchedPollState) {
    return `⚠️ No active match poll instance found matching "${cleanTarget}". Use "!activepolls" or "!pollstatus" to view active polls.`;
  }

  // Permission check: schedule creator, poll creator, or group admin
  const schedId = getPollScheduleId(matchedPollState);
  const sched = schedId ? recurringPolls.get(schedId) : null;
  const isSchedCreator = sched?.creator ? isSameUser(sched.creator.jid, senderJid, sched.creator.name, sender) : false;
  const isPollCreator = matchedPollState.creator ? isSameUser(matchedPollState.creator.jid, senderJid, matchedPollState.creator.name, sender) : false;
  const isAdmin = await isUserAdmin(sock, effectiveChatId, senderJid);

  if (!isSchedCreator && !isPollCreator && !isAdmin) {
    return '⚠️ Only the creator of this poll/schedule or group admins can modify this poll instance.';
  }

  // Determine updated values, falling back to existing poll state
  const isAuto = updates.size === 'auto' || (updates.size === undefined && matchedPollState.isAuto);
  let newSize = updates.size;
  if (newSize === undefined) {
    newSize = isAuto ? 'auto' : (matchedPollState.type === 'opt_in' ? null : matchedPollState.size);
  }

  let newWhen = updates.when || null;
  let newDayWord = updates.dayWord || null;
  let newTimeWord = updates.timeWord || null;

  // If timeWord provided but not dayWord, keep the original day from playAt
  if (newTimeWord && !newDayWord && matchedPollState.playAt) {
    const oldPlayAt = new Date(matchedPollState.playAt);
    if (!Number.isNaN(oldPlayAt.getTime())) {
      const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long' }).format(oldPlayAt);
      newDayWord = weekday;
      newWhen = `${weekday} ${newTimeWord}`;
    }
  } else if (!newWhen && !newTimeWord && !newDayWord) {
    newWhen = matchedPollState.when;
  }

  const noMatchups = updates.noMatchups !== undefined ? updates.noMatchups : Boolean(matchedPollState.noMatchups);
  const checkCourts = updates.checkCourts !== undefined
    ? Boolean(updates.checkCourts)
    : (updates.includeCourts !== undefined
      ? Boolean(updates.includeCourts)
      : Boolean(matchedPollState.checkCourts));
  const includePrebookedSpots = updates.includePrebookedSpots !== undefined
    ? updates.includePrebookedSpots
    : Boolean(matchedPollState.prebookedPlayers && matchedPollState.prebookedPlayers.length > 0);

  const creatorName = matchedPollState.creator?.name || sender;
  const creatorJid = matchedPollState.creator?.jid || senderJid;
  const includeCreator = Boolean(matchedPollState.creator);
  const isRecurring = Boolean(matchedPollState.isRecurring || schedId);

  const targetRemoteJid = matchedPollState.remoteJid || effectiveChatId;

  const newCourt = updates.court !== undefined ? updates.court : (matchedPollState.court || null);

  const res = await createMatchPoll(
    sock,
    targetRemoteJid,
    newSize,
    newWhen,
    newDayWord,
    newTimeWord,
    creatorName,
    creatorJid,
    includeCreator,
    matchedPollId, // replacePollId: deletes older poll from WhatsApp and replaces it!
    false,
    true,
    noMatchups,
    checkCourts,
    includePrebookedSpots,
    isRecurring,
    schedId,
    newCourt
  );

  if (res?.err) {
    if (res.noCourtsAvailable) {
      return null;
    }
    return `Could not modify poll instance: ${res.err}`;
  }

  const instanceTitle = res?.when || newWhen || matchedPollState.when || 'Match';
  const sizeDesc = res?.isOptIn ? 'Opt-in (Yes/No)' : `${res?.size || newSize} spots`;
  const schedNote = schedId ? ` (Schedule: \`${schedId}\`)` : '';

  return `✅ Modified recurring poll instance for *${instanceTitle}*${schedNote}:\n` +
    `• *Format:* ${sizeDesc}\n` +
    `• *Matchups:* ${noMatchups ? 'Manual only' : 'Auto-generated when filled'}\n` +
    `Older poll was deleted from WhatsApp and replaced. (Note: Future recurring schedules remain unchanged).`;
}

/**
 * Internally sets or limits the number of slots for a poll instance without deleting
 * or modifying the WhatsApp poll. Emits warnings if votes cross the new limit.
 */
async function handleSetPollSlots(sock, chatId, sender, senderJid, targetId, count) {
  const isDM = Boolean(chatId && !chatId.endsWith('@g.us'));
  const effectiveChatId = isDM ? (targetGroupJid || await getTargetGroupJid(sock) || chatId) : chatId;

  let cleanTarget = String(targetId || '').replace(/^["']|["']$/g, '').trim();
  let cleanCount = count;

  // If user typed e.g. !setslots 8 (without targetId) and only 1 active poll exists
  if (!cleanCount && cleanTarget && (/^\d+$/.test(cleanTarget) || /^(?:reset|clear|none)$/i.test(cleanTarget))) {
    cleanCount = cleanTarget;
    cleanTarget = null;
  }

  // Find candidate poll in activePolls
  let matchedPollId = null;
  let matchedPollState = null;

  if (cleanTarget) {
    const cleanLower = cleanTarget.toLowerCase();

    // 1. Exact poll ID match
    for (const [id, state] of activePolls.entries()) {
      if ((state.remoteJid === effectiveChatId || isDM) && id.toLowerCase() === cleanLower) {
        matchedPollId = id;
        matchedPollState = state;
        break;
      }
    }

    // 2. Schedule ID match (for recurring poll instances)
    if (!matchedPollState) {
      for (const [id, state] of activePolls.entries()) {
        if ((state.remoteJid === effectiveChatId || isDM) && (state.status === 'active' || state.status === 'filled' || state.status === 'stopped')) {
          const sid = getPollScheduleId(state);
          if (sid && sid.toLowerCase() === cleanLower) {
            matchedPollId = id;
            matchedPollState = state;
            break;
          }
          if (state.scheduleId && state.scheduleId.toLowerCase() === cleanLower) {
            matchedPollId = id;
            matchedPollState = state;
            break;
          }
        }
      }
    }

    // 3. Name or when match
    if (!matchedPollState) {
      for (const [id, state] of activePolls.entries()) {
        if ((state.remoteJid === effectiveChatId || isDM) && (state.status === 'active' || state.status === 'filled' || state.status === 'stopped')) {
          const pName = (state.name || '').toLowerCase();
          const pWhen = (state.when || '').toLowerCase();
          if (pName.includes(cleanLower) || pWhen.includes(cleanLower) || cleanLower.includes(pWhen)) {
            matchedPollId = id;
            matchedPollState = state;
            break;
          }
        }
      }
    }
  } else {
    // Auto-select if exactly 1 active poll exists
    const chatPolls = [...activePolls.entries()].filter(([, state]) =>
      (state.remoteJid === effectiveChatId || isDM) && (state.status === 'active' || state.status === 'filled' || state.status === 'stopped')
    );
    if (chatPolls.length === 1) {
      matchedPollId = chatPolls[0][0];
      matchedPollState = chatPolls[0][1];
    } else if (chatPolls.length === 0) {
      return '📅 No active match polls found on record.';
    } else {
      const descriptions = chatPolls.map(([id, state]) => `\`${id}\` (${state.when || state.name || 'unnamed'})`).join(', ');
      return `Please specify which poll instance to limit: ${descriptions}. Example: "!setslots ${chatPolls[0][0]} 8"`;
    }
  }

  if (!matchedPollState) {
    return `⚠️ No active match poll instance found matching "${cleanTarget}". Use "!activepolls" or "!pollstatus" to view active polls.`;
  }

  // Permission check: schedule creator, poll creator, or group admin
  const schedId = getPollScheduleId(matchedPollState);
  const sched = schedId ? recurringPolls.get(schedId) : null;
  const isSchedCreator = sched?.creator ? isSameUser(sched.creator.jid, senderJid, sched.creator.name, sender) : false;
  const isPollCreator = matchedPollState.creator ? isSameUser(matchedPollState.creator.jid, senderJid, matchedPollState.creator.name, sender) : false;
  const isAdmin = await isUserAdmin(sock, effectiveChatId, senderJid);

  if (!isSchedCreator && !isPollCreator && !isAdmin) {
    return '⚠️ Only the creator of this poll/schedule or group admins can set slot limits.';
  }

  // Handle reset/clearing limit if user specifies 'reset', 'clear', or 0
  if (cleanCount === 'reset' || cleanCount === 'clear' || cleanCount === 'none' || cleanCount === '0' || cleanCount === 0) {
    matchedPollState.slotLimit = null;
    if (matchedPollState.originalSize) {
      matchedPollState.size = matchedPollState.originalSize;
    }
    matchedPollState.lastExcessSignature = null;
    persistPolls();
    return `🔄 Removed slot limit on poll "${matchedPollState.name || matchedPollState.when || matchedPollId}". Slots reverted to original size (${matchedPollState.size || 'default'}).`;
  }

  const num = parseInt(cleanCount, 10);
  if (!Number.isInteger(num) || num <= 0) {
    return 'Please provide a valid positive number of slots, e.g. "!setslots rec_1 8" or "!setslots 8".';
  }

  if (num > 40) {
    return 'Slot limit cannot exceed 40 players.';
  }

  if (!matchedPollState.originalSize) {
    matchedPollState.originalSize = matchedPollState.size;
  }
  matchedPollState.slotLimit = num;
  matchedPollState.size = num;

  const mePn = jidNormalizedUser(sock?.user?.id || sock?.authState?.creds?.me?.id || '');
  const { aggregated, interestedPlayers } = getPollVoters(matchedPollId, matchedPollState, mePn);

  let players = [];
  let excessPlayers = [];
  let isAllFilled = false;
  let filledCount = 0;

  if (matchedPollState.type === 'opt_in' || matchedPollState.options?.some((o) => /^yes$/i.test(o))) {
    const yesOption = aggregated.find((o) => /^yes$/i.test(o.name.trim()));
    const yesVoters = yesOption ? yesOption.voters.map(nameFor) : interestedPlayers;
    players = yesVoters.slice(0, num);
    excessPlayers = yesVoters.slice(num);
    filledCount = players.length;
    isAllFilled = (yesVoters.length >= num);
  } else {
    const roster = resolveFixedPollRoster(matchedPollState, aggregated);
    players = roster.players;
    excessPlayers = roster.excessPlayers;
    filledCount = roster.filledCount;
    isAllFilled = roster.isAllFilled;
  }

  if (isAllFilled) {
    matchedPollState.status = 'filled';
    matchedPollState.lastPlayers = players;
  } else if (matchedPollState.status === 'filled') {
    matchedPollState.status = 'active';
  }

  let excessWarning = '';
  if (excessPlayers.length > 0) {
    matchedPollState.lastExcessSignature = excessPlayers.join('|');
    excessWarning = `\n⚠️ *Warning:* Votes from [${excessPlayers.join(', ')}] exceed the new ${num}-slot limit and will not be considered!`;
  }

  persistPolls();

  // If auto-matchups are enabled and poll is filled and not manual/noMatchups, auto-generate matchups!
  let autoMatchupNote = '';
  if (isAllFilled && !matchedPollState.noMatchups && !matchedPollState.isManual && isValidPlayerCount(players.length)) {
    matchedPollState.status = 'resolved';
    persistPolls();
    setTimeout(async () => {
      try {
        await ratings.ensureRated(players);
        const prebookedCourts = await getPrebookedCourtsForPoll(matchedPollState);
        const schedule = generateMatchups(players, { prebookedCourts, chatId: matchedPollState.remoteJid });
        const whenHeader = formatMatchHeaderTime(matchedPollState);
        const header = whenHeader ? `📅 ${whenHeader}\n\n` : '';
        await sock.sendMessage(matchedPollState.remoteJid, { text: header + formatMatchups(schedule) });
        pairHistory.recordDraw(matchedPollId, schedule, Date.now(), matchedPollState.remoteJid);
        matchedPollState.lastSchedule = summarizeSchedule(schedule);
        persistPolls();
      } catch (err) {
        console.error('[poll] Auto matchups error after setslots:', err);
      }
    }, 500);
    autoMatchupNote = '\n🎉 Poll is now filled! Auto-generating matchups...';
  }

  const pollTitle = matchedPollState.when || matchedPollState.name || 'Match';
  const schedNote = schedId ? ` (Schedule: \`${schedId}\`)` : '';
  const statusNote = isAllFilled ? 'FILLED' : `${Math.max(0, num - filledCount)} spot(s) remaining`;

  return `🎯 Set slot limit for poll instance *${pollTitle}*${schedNote} to *${num} slots*:\n` +
    `• WhatsApp poll message was kept intact (not deleted).\n` +
    `• Slots filled: ${filledCount}/${num} (${statusNote}).\n` +
    `• Active roster (${players.length}): ${players.length ? players.join(', ') : 'None yet'}${excessWarning}${autoMatchupNote}`;
}

async function handleModifyRecurringPoll(sock, chatId, sender, senderJid, scheduleId, updates) {
  const cleanId = String(scheduleId || '').trim();
  if (!cleanId) {
    return 'Please provide the schedule ID to modify, e.g. "!modifyrecurringpoll rec_1 8 6pm at 7am mon-thu" (see "!recurringpolls" for active IDs).';
  }

  let targetKey = cleanId;
  if (!recurringPolls.has(targetKey)) {
    for (const key of recurringPolls.keys()) {
      if (key.toLowerCase() === cleanId.toLowerCase()) {
        targetKey = key;
        break;
      }
    }
  }

  if (!recurringPolls.has(targetKey)) {
    return `Schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view active schedules.`;
  }

  const sched = recurringPolls.get(targetKey);
  const isCreator = sched.creator ? isSameUser(sched.creator.jid, senderJid, sched.creator.name, sender) : false;
  const isAdmin = await isUserAdmin(sock, chatId, senderJid);

  if (!isCreator && !isAdmin) {
    return '⚠️ Only the creator of this recurring poll or group admins can modify it.';
  }

  return await recurringPollsModule.modifyRecurringPoll({
    recurringPolls,
    persistPolls,
    sender,
    scheduleId: targetKey,
    updates
  });
}

async function handlePauseRecurringPoll(sock, chatId, sender, senderJid, scheduleId) {
  const cleanId = String(scheduleId || '').replace(/^["']|["']$/g, '').trim();

  // If user says "all", pause all
  if (/^all$/i.test(cleanId)) {
    const isAdmin = await isUserAdmin(sock, chatId, senderJid);
    if (!isAdmin) {
      return '⚠️ Only group admins can pause all recurring polls.';
    }
    return await recurringPollsModule.pauseRecurringPoll({ recurringPolls, persistPolls, scheduleId: 'all', chatId });
  }

  const isAllChat = !chatId || !chatId.endsWith('@g.us');
  const chatSchedules = [...recurringPolls.entries()].filter(([, s]) => isAllChat || s.remoteJid === chatId);

  let targetKey = null;
  if (cleanId) {
    for (const [key, sched] of recurringPolls.entries()) {
      const sid = sched.id || sched.scheduleId || key;
      if (key.toLowerCase() === cleanId.toLowerCase() || sid.toLowerCase() === cleanId.toLowerCase()) {
        targetKey = key;
        break;
      }
    }
    if (!targetKey) {
      return `⚠️ Schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view active schedule IDs.`;
    }
  } else {
    // If no scheduleId provided, auto-select if only 1 schedule exists for this chat
    if (chatSchedules.length === 1) {
      targetKey = chatSchedules[0][0];
    } else if (chatSchedules.length === 0) {
      return '📅 No scheduled recurring polls found for this chat. Use "!recurringpolls" to check schedules.';
    } else {
      const ids = chatSchedules.map(([id]) => `\`${id}\``).join(', ');
      return `Please specify which schedule ID to pause (${ids}), or use "!pauserecurringpoll all".`;
    }
  }

  const sched = recurringPolls.get(targetKey);
  const isCreator = sched.creator ? isSameUser(sched.creator.jid, senderJid, sched.creator.name, sender) : false;
  const isAdmin = await isUserAdmin(sock, chatId, senderJid);

  if (!isCreator && !isAdmin) {
    return '⚠️ Only the creator of this recurring poll or group admins can pause it.';
  }
  return await recurringPollsModule.pauseRecurringPoll({ recurringPolls, persistPolls, scheduleId: targetKey, chatId });
}

async function handleResumeRecurringPoll(sock, chatId, sender, senderJid, scheduleId) {
  const cleanId = String(scheduleId || '').replace(/^["']|["']$/g, '').trim();

  // If user says "all", resume all
  if (/^all$/i.test(cleanId)) {
    const isAdmin = await isUserAdmin(sock, chatId, senderJid);
    if (!isAdmin) {
      return '⚠️ Only group admins can resume all recurring polls.';
    }
    return await recurringPollsModule.resumeRecurringPoll({ recurringPolls, persistPolls, scheduleId: 'all', chatId });
  }

  const isAllChat = !chatId || !chatId.endsWith('@g.us');
  const chatSchedules = [...recurringPolls.entries()].filter(([, s]) => isAllChat || s.remoteJid === chatId);

  let targetKey = null;
  if (cleanId) {
    for (const [key, sched] of recurringPolls.entries()) {
      const sid = sched.id || sched.scheduleId || key;
      if (key.toLowerCase() === cleanId.toLowerCase() || sid.toLowerCase() === cleanId.toLowerCase()) {
        targetKey = key;
        break;
      }
    }
    if (!targetKey) {
      return `⚠️ Schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view active schedule IDs.`;
    }
  } else {
    // If no scheduleId provided, auto-select if only 1 schedule exists for this chat
    if (chatSchedules.length === 1) {
      targetKey = chatSchedules[0][0];
    } else if (chatSchedules.length === 0) {
      return '📅 No scheduled recurring polls found for this chat. Use "!recurringpolls" to check schedules.';
    } else {
      const ids = chatSchedules.map(([id]) => `\`${id}\``).join(', ');
      return `Please specify which schedule ID to resume (${ids}), or use "!resumerecurringpoll all".`;
    }
  }

  const sched = recurringPolls.get(targetKey);
  const isCreator = sched.creator ? isSameUser(sched.creator.jid, senderJid, sched.creator.name, sender) : false;
  const isAdmin = await isUserAdmin(sock, chatId, senderJid);

  if (!isCreator && !isAdmin) {
    return '⚠️ Only the creator of this recurring poll or group admins can resume it.';
  }
  return await recurringPollsModule.resumeRecurringPoll({ recurringPolls, persistPolls, scheduleId: targetKey, chatId });
}


async function handleSkipRecurringPollInstance(sock, chatId, sender, senderJid, scheduleId, targetDayOrDate) {
  const isAllChat = !chatId || !chatId.endsWith('@g.us');
  const chatSchedules = [...recurringPolls.entries()].filter(([, s]) => isAllChat || s.remoteJid === chatId);

  let cleanId = String(scheduleId || '').replace(/^[\"']|[\"']$/g, '').trim();

  // If user passed targetDayOrDate as first param (e.g. !skipinstance wednesday) and there is only 1 schedule:
  if (cleanId && chatSchedules.length === 1 && !recurringPolls.has(cleanId)) {
    const isDayOrDate = recurringPollsModule.DAY_LOOKUP?.[cleanId.toLowerCase()] !== undefined ||
      /^(?:today|tomorrow|next|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)$/i.test(cleanId);
    if (isDayOrDate) {
      targetDayOrDate = cleanId;
      cleanId = chatSchedules[0][0];
    }
  }

  let targetKey = null;
  if (cleanId) {
    for (const [key, sched] of recurringPolls.entries()) {
      const sid = sched.id || sched.scheduleId || key;
      if (key.toLowerCase() === cleanId.toLowerCase() || sid.toLowerCase() === cleanId.toLowerCase()) {
        targetKey = key;
        break;
      }
    }
    if (!targetKey) {
      return `⚠️ Schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view active schedule IDs.`;
    }
  } else {
    if (chatSchedules.length === 1) {
      targetKey = chatSchedules[0][0];
    } else if (chatSchedules.length === 0) {
      return '📅 No scheduled recurring polls found for this chat. Use "!recurringpolls" to check schedules.';
    } else {
      const ids = chatSchedules.map(([id]) => `\`${id}\``).join(', ');
      return `Please specify which schedule ID to skip (${ids}). Example: "!skipinstance ${chatSchedules[0][0]}"`;
    }
  }

  const sched = recurringPolls.get(targetKey);
  const isCreator = sched.creator ? isSameUser(sched.creator.jid, senderJid, sched.creator.name, sender) : false;
  const isAdmin = await isUserAdmin(sock, chatId, senderJid);

  if (!isCreator && !isAdmin) {
    return '⚠️ Only the creator of this recurring poll or group admins can skip instances.';
  }

  return await recurringPollsModule.skipRecurringPollInstance({
    recurringPolls,
    activePolls,
    persistPolls,
    cancelOrDeletePoll,
    sock,
    scheduleId: targetKey,
    targetDayOrDate,
    chatId,
    sender
  });
}

async function handleUnskipRecurringPollInstance(sock, chatId, sender, senderJid, scheduleId, targetDayOrDate) {
  const isAllChat = !chatId || !chatId.endsWith('@g.us');
  const chatSchedules = [...recurringPolls.entries()].filter(([, s]) => isAllChat || s.remoteJid === chatId);

  let cleanId = String(scheduleId || '').replace(/^[\"']|[\"']$/g, '').trim();

  if (cleanId && chatSchedules.length === 1 && !recurringPolls.has(cleanId)) {
    const isDayOrDate = recurringPollsModule.DAY_LOOKUP?.[cleanId.toLowerCase()] !== undefined ||
      /^(?:today|tomorrow|next|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)$/i.test(cleanId);
    if (isDayOrDate) {
      targetDayOrDate = cleanId;
      cleanId = chatSchedules[0][0];
    }
  }

  let targetKey = null;
  if (cleanId) {
    for (const [key, sched] of recurringPolls.entries()) {
      const sid = sched.id || sched.scheduleId || key;
      if (key.toLowerCase() === cleanId.toLowerCase() || sid.toLowerCase() === cleanId.toLowerCase()) {
        targetKey = key;
        break;
      }
    }
    if (!targetKey) {
      return `⚠️ Schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view active schedule IDs.`;
    }
  } else {
    if (chatSchedules.length === 1) {
      targetKey = chatSchedules[0][0];
    } else if (chatSchedules.length === 0) {
      return '📅 No scheduled recurring polls found for this chat. Use "!recurringpolls" to check schedules.';
    } else {
      const ids = chatSchedules.map(([id]) => `\`${id}\``).join(', ');
      return `Please specify which schedule ID to unskip (${ids}). Example: "!unskipinstance ${chatSchedules[0][0]}"`;
    }
  }

  const sched = recurringPolls.get(targetKey);
  const isCreator = sched.creator ? isSameUser(sched.creator.jid, senderJid, sched.creator.name, sender) : false;
  const isAdmin = await isUserAdmin(sock, chatId, senderJid);

  if (!isCreator && !isAdmin) {
    return '⚠️ Only the creator of this recurring poll or group admins can unskip instances.';
  }

  return await recurringPollsModule.unskipRecurringPollInstance({
    recurringPolls,
    persistPolls,
    scheduleId: targetKey,
    targetDayOrDate,
    chatId,
    sender
  });
}

async function cancelOrDeletePoll(sock, remoteJid, pollId) {
  if (!pollId) return;
  handlePollDeleted(remoteJid, pollId);
  await deletePollFromWhatsApp(sock, remoteJid, pollId);
}

/**
 * Admin command to cancel and delete all tracked polls from WhatsApp and storage.
 */
async function handleDeleteAllPolls(sock, chatId, senderJid) {
  const isAdmin = await isUserAdmin(sock, chatId, senderJid);
  if (!isAdmin) {
    return '⚠️ Only group admins can delete all polls.';
  }

  const allPollEntries = [...activePolls.entries()];
  if (allPollEntries.length === 0) {
    return 'No polls on record to delete.';
  }

  let deletedCount = 0;
  for (const [pollId, pollState] of allPollEntries) {
    const targetChat = pollState.remoteJid || chatId;
    try {
      await cancelOrDeletePoll(sock, targetChat, pollId);
      deletedCount++;
    } catch (err) {
      console.error(`[poll] Failed to cancel/delete poll ${pollId}:`, err.message);
    }
  }

  activePolls.clear();
  latestPollIdByChat.clear();
  persistPolls();

  console.log(`[poll] Admin deleted all ${deletedCount} poll(s) from storage and WhatsApp.`);
  return `🗑️ Deleted ${deletedCount} poll(s) from storage and WhatsApp.`;
}

/**
 * Admin command to clear all polls from the bot's memory/state without deleting them from WhatsApp.
 */
async function handleClearAllPolls(sock, chatId, senderJid) {
  const isAdmin = await isUserAdmin(sock, chatId, senderJid);
  if (!isAdmin) {
    return '⚠️ Only group admins can clear all polls.';
  }

  const count = activePolls.size;
  if (count === 0) {
    return 'No polls on record to clear.';
  }

  activePolls.clear();
  latestPollIdByChat.clear();
  persistPolls();

  console.log(`[poll] Admin cleared all ${count} poll(s) from state (kept on WhatsApp).`);
  return `🧹 Cleared ${count} poll(s) from bot state (polls remain on WhatsApp).`;
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
  let statusChanged = false;

  for (const [pollId, pollState] of activePolls.entries()) {
    if (!pollState.playAt) continue; // no play time recorded -- never auto-expire it
    const playAtMs = new Date(pollState.playAt).getTime();
    if (Number.isNaN(playAtMs)) continue;

    // 1. If play time has passed and poll is still 'active', 'filled', or 'stopped', mark status as 'expired'
    if (now >= playAtMs && (pollState.status === 'active' || pollState.status === 'filled' || pollState.status === 'stopped')) {
      pollState.status = 'expired';
      statusChanged = true;
      console.log(`[poll] Match play time passed for poll ${pollId} ("${pollState.name || pollState.when}"): status automatically set to expired.`);
    }

    // 2. If exceeded 2-week retention period after play time, delete from storage
    if (now > playAtMs + graceMs) {
      console.log(`[poll] Deleting old poll ${pollId} ("${pollState.name || pollState.when}"): playAt=${pollState.playAt}, now=${new Date(now).toISOString()} (exceeded 2-week retention)`);
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

  if (removed.length > 0 || statusChanged) {
    persistPolls();
    if (removed.length > 0) {
      console.log(`[poll] Cleaned up ${removed.length} expired/completed poll(s) older than 2 weeks: ${removed.join(', ')}`);
    }
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
function buildPollReminderText(H, pollState, openSpots, totalSpots, playerList, isOptIn = false, yesCount = 0, hoursRemaining = null) {
  const whenStr = pollState.when ? pollState.when : (pollState.name || 'today');
  const spotWord = openSpots === 1 ? 'spot' : 'spots';
  const playerWord = openSpots === 1 ? 'player' : 'players';

  const effHours = typeof hoursRemaining === 'number' && hoursRemaining > 0 ? hoursRemaining : H;
  const currentH = Math.max(1, Math.round(effHours));
  const currentMins = Math.max(1, Math.round(effHours * 60));

  if (isOptIn) {
    if (effHours >= 24) {
      const days = Math.round(effHours / 24);
      const dayStr = days === 1 ? '1 Day' : `${days} Days`;
      return `⏰ *${currentH} Hours (${dayStr}) to Playtime!* We have *${yesCount} player(s) in* so far for *${whenStr}*.
` +
        `Players in: ${playerList}
` +
        `Don't miss out — cast your vote above to join the match!`;
    }
    if (effHours >= 16) {
      return `⏰ *${currentH} Hours to Playtime!* We have *${yesCount} player(s) in* so far for *${whenStr}*.
` +
        `Players in: ${playerList}
` +
        `Don't miss out — cast your vote above to join the match!`;
    }
    if (effHours >= 8) {
      return `🎾 *${currentH} Hours to Match Time!* We currently have *${yesCount} player(s) in* for *${whenStr}*.
` +
        `Current lineup: ${playerList}
` +
        `Who else is ready to play? Vote Yes in the poll above! 🎾⚡`;
    }
    if (effHours >= 4) {
      return `🔥 *${currentH} Hours Until Court Time!* *${yesCount} player(s)* lined up for *${whenStr}*!
` +
        `Roster: ${playerList}
` +
        `Cast your vote above if you want in on today's session!`;
    }
    if (effHours >= 2) {
      return `⚡ *${currentH} HOURS TO GO!* *${yesCount} player(s)* confirmed for *${whenStr}*!
` +
        `Ready on court: ${playerList}
` +
        `Vote Yes now before teams and matchups are drawn! 🎾🏃‍♂️💨`;
    }
    if (effHours >= 1) {
      const hourWord = currentH === 1 ? '1 HOUR LEFT' : `${currentH} HOURS LEFT`;
      return `🚨 *FINAL CALL: ${hourWord}!* *${yesCount} player(s) in* for *${whenStr}*!
` +
        `Current roster: ${playerList}
` +
        `Last chance to vote Yes before match time! 🏆🎾🔥`;
    }
    return `⚡ *${currentMins} MINUTES REMAINING!* *${yesCount} player(s) in* for *${whenStr}*!
` +
      `Current roster: ${playerList}
` +
      `Final countdown to vote Yes before matchups are locked in! 🏆🎾⚡`;
  }

  if (effHours >= 32) {
    return `🎾 *Match Alert:* The match poll for *${whenStr}* still has *${openSpots} open ${spotWord}* (${openSpots}/${totalSpots} needed).
` +
      `Current players: ${playerList}
` +
      `Vote in the poll above to lock in your spot!`;
  }
  if (effHours >= 24) {
    const days = Math.round(effHours / 24);
    const dayStr = days === 1 ? '1 Day' : `${days} Days`;
    return `⏰ *${currentH} Hours (${dayStr}) to Playtime!* We have *${openSpots} ${spotWord} remaining* for *${whenStr}* (${openSpots}/${totalSpots} needed).
` +
      `Roster so far: ${playerList}
` +
      `Don't miss out — cast your vote above to join the court!`;
  }
  if (effHours >= 16) {
    return `⏰ *${currentH} Hours to Playtime!* We have *${openSpots} ${spotWord} remaining* for *${whenStr}* (${openSpots}/${totalSpots} needed).
` +
      `Roster so far: ${playerList}
` +
      `Don't miss out — cast your vote above to join the court!`;
  }
  if (effHours >= 8) {
    return `🎾 *${currentH} Hours to Match Time!* We still need *${openSpots} more ${playerWord}* to complete the court for *${whenStr}* (${totalSpots} total spots).
` +
      `Current lineup: ${playerList}
` +
      `Who's ready to hit some winners today? Claim your spot!`;
  }
  if (effHours >= 4) {
    return `🔥 *${currentH} Hours Until Court Time!* Only *${openSpots} ${spotWord} left* for *${whenStr}*!
` +
      `Lined up to play: ${playerList}
` +
      `Racquets ready? Grab the open ${spotWord} before it fills up! 🎾⚡`;
  }
  if (effHours >= 2) {
    return `⚡ *${currentH} HOURS TO GO!* We only need *${openSpots} more ${playerWord}* to make the match happen at *${whenStr}*!
` +
      `Ready on court: ${playerList}
` +
      `Don't leave the squad hanging — step up and claim the final ${spotWord}! 🎾🏃‍♂️💨`;
  }
  if (effHours >= 1) {
    const hourWord = currentH === 1 ? '1 HOUR LEFT' : `${currentH} HOURS LEFT`;
    return `🚨 *FINAL CALL: ${hourWord}!* Just *${openSpots} ${spotWord} open* for *${whenStr}*!
` +
      `Current roster: ${playerList}
` +
      `Who's coming through in the clutch? Vote now and let's play! 🏆🎾🔥`;
  }
  return `⚡ *${currentMins} MINUTES TO GO!* Still need *${openSpots} more ${playerWord}* for *${whenStr}*!
` +
    `Current lineup: ${playerList}
` +
    `Last chance to grab the remaining ${spotWord} before match time! 🏆🎾⚡`;
}

/**
 * Sweeps active polls and sends escalating reminders at every power of 2
 * hours (64h, 32h, 16h, 8h, 4h, 2h, 1h) away from playtime.
 * Always silenced between 10pm and 8am in San Jose, CA (Pacific Time).
 */
function isAutoCreatedPoll(pollState) {
  if (!pollState) return false;
  if (pollState.isAuto || pollState.isRecurring || pollState.isAutoCreated || pollState.autoCreated) return true;
  if (Array.isArray(pollState.prebookedCourts) && pollState.prebookedCourts.length > 0) return true;
  if (Array.isArray(pollState.prebookedPlayers) && pollState.prebookedPlayers.length > 0) return true;
  if (pollState.scheduleId || pollState.recurringScheduleId) return true;
  return false;
}

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
      if (pollState.remindersPaused) continue; // reminders paused by group member
      if (!isAutoCreatedPoll(pollState) && (pollState.reminderCount || 0) >= MAX_POLL_REMINDERS) continue; // limit maximum number of reminders to 2 (only for non-auto created polls)
      if (!pollState.playAt) continue;

      const playAtMs = new Date(pollState.playAt).getTime();
      if (Number.isNaN(playAtMs)) continue;
      const diffMs = playAtMs - now;
      if (diffMs <= 0) {
        if (pollState.status === 'active' || pollState.status === 'filled' || pollState.status === 'stopped') {
          pollState.status = 'expired';
          persistPolls();
          console.log(`[poll] Match play time passed for poll ${pollId}: status automatically set to expired.`);
        }
        continue; // match time has passed
      }

      const hoursRemaining = diffMs / (60 * 60 * 1000);
      const isOptIn = pollState.type === 'opt_in' || pollState.options?.some((o) => /^yes$/i.test(o));

      // Do not send a reminder within one hour of creation of poll
      if (pollState.createdAt) {
        const pollAgeHours = (now - new Date(pollState.createdAt).getTime()) / (60 * 60 * 1000);
        if (pollAgeHours < 1.0) {
          continue;
        }
      }

      // Find the most immediate matching power-of-2 reminder bucket (smallest H where hoursRemaining <= H)
      const targetH = POWERS_OF_2_REMINDER_HOURS.find((h) => hoursRemaining <= h);
      if (!targetH) continue; // more than 64 hours away

      // For bot created polls, stop reminders after 2h reminder if there have been at least 4 reminders already
      if (!pollState.isManual && targetH < 2 && (pollState.reminderCount || 0) >= 4) {
        continue;
      }

      if (!Array.isArray(pollState.sentReminders)) {
        pollState.sentReminders = [];
      }

      if (pollState.sentReminders.includes(targetH)) continue;

      // If coming out of quiet hours (8:00 AM - 8:59 AM) and another reminder is scheduled within 1 hour, do not send missed reminder
      if (currentHour === 8) {
        const hasScheduledWithin1Hour = POWERS_OF_2_REMINDER_HOURS.some((h) =>
          h < targetH && (hoursRemaining - 1.0) <= h && h <= hoursRemaining
        );
        if (hasScheduledWithin1Hour) {
          console.log(`[poll] Bypassing missed reminder (${targetH}h) for poll ${pollId} after quiet hours because another reminder is scheduled within 1 hour.`);
          for (const h of POWERS_OF_2_REMINDER_HOURS) {
            if (h >= targetH && !pollState.sentReminders.includes(h)) {
              pollState.sentReminders.push(h);
            }
          }
          persistPolls();
          continue;
        }
      }

      try {
        const sent = await sendPollReminder(sock, pollId, pollState, false);
        if (sent) {
          // Mark this bucket and all LARGER buckets as sent ONLY AFTER successfully sending message
          for (const h of POWERS_OF_2_REMINDER_HOURS) {
            if (h >= targetH && !pollState.sentReminders.includes(h)) {
              pollState.sentReminders.push(h);
            }
          }

          // For bot created polls, stop reminders after 2h reminder if there have been at least 4 reminders already
          if (!pollState.isManual && targetH <= 2 && (pollState.reminderCount || 0) >= 4) {
            for (const h of POWERS_OF_2_REMINDER_HOURS) {
              if (h < 2 && !pollState.sentReminders.includes(h)) {
                pollState.sentReminders.push(h);
              }
            }
            console.log(`[poll] Stopped reminders for bot created poll ${pollId} after 2h reminder (${pollState.reminderCount} reminders sent)`);
          }

          persistPolls();
        }
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

// Check and automatically trigger recurring daily polls every 30 seconds
const RECURRING_POLL_CHECK_INTERVAL_MS = 30 * 1000;
setInterval(() => {
  if (botSock) {
    recurringPollsModule.checkAndPostRecurringPolls({
      sock: botSock,
      recurringPolls,
      persistPolls,
      createMatchPoll,
      getTargetGroupJid
    });
  }
}, RECURRING_POLL_CHECK_INTERVAL_MS);

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
  const mePnNorm = meId ? jidNormalizedUser(meId) : null;
  const meLidNorm = meLid ? jidNormalizedUser(meLid) : null;
  if (meLidNorm && mePnNorm && meLidNorm !== mePnNorm) {
    namesStore.setMapping(meLidNorm, mePnNorm, meName);
  } else if (meLidNorm && meName) {
    recordName(meLidNorm, meName);
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
      let changed = false;
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

      // Pre-warm group metadata cache so the very first message is recognized instantly
      try {
        const groups = await sock.groupFetchAllParticipating();
        let allowedCount = 0;
        for (const [gId, gMeta] of Object.entries(groups)) {
          groupMetadataCache.set(gId, gMeta);
          if (groupsConfig.isGroupAllowed(gId, gMeta.subject)) {
            allowedCount++;
            if (!targetGroupJid) targetGroupJid = gId;
            namesStore.setGroupMembers(gId, gMeta.participants);
            console.log(`[groups] Pre-cached allowed group "${gMeta.subject}" (id: ${gId})`);

            if (gMeta.participants) {
              for (const p of gMeta.participants) {
                const rawPn = p.id || p.jid;
                const rawLid = p.lid;
                const pn = rawPn && rawPn.endsWith("@s.whatsapp.net") ? jidNormalizedUser(rawPn) : null;
                const lid = rawLid && rawLid.endsWith("@lid") ? jidNormalizedUser(rawLid) : (rawPn && rawPn.endsWith("@lid") ? jidNormalizedUser(rawPn) : null);
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
        console.error("[groups] Failed to pre-fetch groups on connection open:", err.message);
      }

      checkAndSendPollReminders(sock);
      recurringPollsModule.checkAndPostRecurringPolls({
        sock,
        recurringPolls,
        persistPolls,
        createMatchPoll,
        getTargetGroupJid
      });
    }
  });

  // Track dynamic group participant joins and leaves
  sock.ev.on("group-participants.update", async ({ id, participants, action }) => {
    if (!id || !participants) return;
    try {
      const metadata = await getGroupMetadata(sock, id);
      if (metadata && metadata.participants) {
        namesStore.setGroupMembers(id, metadata.participants);
        for (const p of metadata.participants) {
          const rawPn = p.id || p.jid;
          const rawLid = p.lid;
          const pn = rawPn && rawPn.endsWith("@s.whatsapp.net") ? jidNormalizedUser(rawPn) : null;
          const lid = rawLid && rawLid.endsWith("@lid") ? jidNormalizedUser(rawLid) : (rawPn && rawPn.endsWith("@lid") ? jidNormalizedUser(rawPn) : null);
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
      console.error("[group-participants] Error updating group participants:", e.message);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      const remoteJid = msg.key?.remoteJid;
      if (!remoteJid) continue;

      const isGroup = remoteJid.endsWith('@g.us');
      const isDirect = !isGroup && (remoteJid.endsWith('@s.whatsapp.net') || remoteJid.endsWith('@lid'));

      if (!isGroup && !isDirect) continue;

      let groupName = "Direct Message";
      let isAllowedGroup = false;

      if (isGroup) {
        const metadata = await getGroupMetadata(sock, remoteJid);
        groupName = metadata?.subject || remoteJid;
        isAllowedGroup = groupsConfig.isGroupAllowed(remoteJid, groupName);

        if (!isAllowedGroup) {
          continue; // Ignore messages not meant for allowed groups
        }

        // Ensure group members are tracked in namesStore
        if (metadata?.participants && !namesStore.getGroupMembers(remoteJid)) {
          namesStore.setGroupMembers(remoteJid, metadata.participants);
        }
      } else if (isDirect) {
        // Direct message: only allowed if sender is an admin of at least ONE allowed group
        const adminGroups = await getAdminGroupsForUser(sock, remoteJid);
        if (adminGroups.length === 0) {
          console.log(`[DM] Ignored direct message from non-admin user ${remoteJid}`);
          continue;
        }
        console.log(`[DM] Authorized admin direct message received from ${remoteJid} (${msg.pushName || "Admin"}), admin of ${adminGroups.length} group(s)`);
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
      const senderPn = msg.key?.participantPn ? jidNormalizedUser(msg.key.participantPn) : (msg.participantPn ? jidNormalizedUser(msg.participantPn) : null);
      if (msg.pushName && msg.key?.participant) {
        recordName(msg.key.participant, msg.pushName, senderPn);
      } else if (msg.pushName && !msg.key?.fromMe && remoteJid && !remoteJid.endsWith('@g.us')) {
        recordName(remoteJid, msg.pushName, remoteJid.endsWith('@s.whatsapp.net') ? remoteJid : null);
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

          // If no explicit day word was in the poll title, ensure dayWord is null so resolvePlayDateTime rolls past times over to tomorrow
          const hasExplicitDayInPollTitle = /\b(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i.test(pollName);
          const effectiveDayWord = hasExplicitDayInPollTitle ? interpretation.dayWord : null;

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
          const manualSentReminders = POWERS_OF_2_REMINDER_HOURS.filter((h) => h > initialManualHours && h > 1);

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
            isManual: true, // user-created manual match poll, passively tracked
            creator: { name: creatorName, jid: creatorJid },
            lastConflictSignature: null,
            voteBuffer: new Map(),
            lastPlayers: null,
            sentReminders: manualSentReminders
          });
          latestPollIdByChat.set(remoteJid, pollId);
          persistPolls();

          // Fetch rating for creator if not seen before
          if (creatorName && !ratings.isPlaceholder(creatorName) && !GENERIC_NAMES.has(ratings.keyFor(creatorName))) {
            const creatorLid = creatorJid ? namesStore.resolveCanonicalId(creatorJid) : null;
            ratings.ensureRated([{
              name: creatorName,
              jid: creatorJid,
              lid: creatorLid && creatorLid.endsWith('@lid') ? creatorLid : null
            }]).catch(() => {});
          }
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
        const metadata = await getGroupMetadata(sock, remoteJid);
        const groupName = metadata?.subject || remoteJid;
        if (!groupsConfig.isGroupAllowed(remoteJid, groupName)) continue;

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
      if (jid && jid.endsWith("@g.us")) {
        const metadata = await getGroupMetadata(sock, jid);
        const groupName = metadata?.subject || jid;
        if (!groupsConfig.isGroupAllowed(jid, groupName)) return;
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
  const senderPn = msg.key?.participantPn ? jidNormalizedUser(msg.key.participantPn) : (msg.participantPn ? jidNormalizedUser(msg.participantPn) : null);
  if (msg.key.participant) {
    recordName(msg.key.participant, sender, senderPn);
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
    const court = input.court || null;
    const includeCreator = input.includeCreator !== false;
    const cancelExisting = input.cancelExisting === true;
    const replacePollId = input.replacePollId || null;
    const creatorName = sender !== 'Someone' ? sender : (msg?.key?.participant ? nameFor(msg.key.participant) : 'Player 1');
    const creatorJid = msg?.key?.participant || msg?.key?.remoteJid || null;
    const targetChatId = chatId.endsWith('@g.us') ? chatId : (await getTargetGroupJid(sock) || chatId);

    const noMatchups = input.noMatchups === true || input.autoMatchups === false;
    const checkCourts = input.checkCourts === true || input.includeCourts === true || input.considerCourts === true;
    const includePrebookedSpots = input['prebooked-spots'] === true || input.prebookedSpots === true || input.includePrebookedSpots === true;
    const res = await createMatchPoll(sock, targetChatId, size, when, dayWord, timeWord, creatorName, creatorJid, includeCreator, replacePollId, cancelExisting, false, noMatchups, checkCourts, includePrebookedSpots, false, null, court);
    if (res?.err) {
      return `Could not create poll: ${res.err}`;
    }
    const resolvedWhen = res?.when ? ` for ${res.when}` : (when ? ` for ${when}` : '');
    const replacedNote = res?.replacedOldPoll ? ' (older poll deleted from WhatsApp)' : '';
    if (res?.isOptIn) {
      return `Opt-in poll created with "Yes" and "No" options${resolvedWhen}${replacedNote}. Players can vote "Yes" to opt in. When ready, ask me to generate the matchups!`;
    }
    return 'Poll created and sent to WhatsApp. The poll title itself contains time and slots, so do not output a separate confirmation message.';
  }
  if (name === 'generate_matchups' || name === 'rematch') {
    const res = await generateMatchupsFromPoll(sock, chatId, input.pollId, input.pollName || input.when, {
      fixedPairs: input.fixedPairs || [],
      prebookedCourts: input.prebookedCourts || []
    });
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
    const res = namesStore.addAliasForPlayer(player, alias, null, chatId);
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
      const match = namesStore.findIdByNameOrAlias(targetAlias, chatId);
      if (match) resolvedPlayer = match.entry?.name;
    }

    const canManage = await canUserManagePlayerAlias(sock, chatId, senderJid, sender, resolvedPlayer || targetAlias);
    if (!canManage) {
      return '⚠️ Only group admins can delete aliases for other players. You can delete aliases for yourself.';
    }

    const res = namesStore.removeAliasForPlayer(targetPlayer, targetAlias, chatId);
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
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handleSetRating(sock, chatId, senderJid, sender, input.player || null, newRating);
  }
  if (name === 'reset_rating') {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handleResetRating(sock, chatId, senderJid, sender, input.player || null);
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
  if (name === 'stop_poll') {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handleStopPoll(sock, chatId, sender, senderJid, input.pollId || null);
  }
  if (name === 'resume_poll') {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handleResumePoll(sock, chatId, sender, senderJid, input.pollId || null);
  }
  if (name === 'pause_reminders') {
    return await handlePauseReminders(sock, chatId, sender, input.pollId || null);
  }
  if (name === 'resume_reminders') {
    return await handleResumeReminders(sock, chatId, sender, input.pollId || null);
  }
  if (name === 'trigger_reminder' || name === 'send_reminder') {
    const res = await handleTriggerReminder(sock, chatId, sender, input.pollId || null);
    return res || 'Reminder triggered and sent to group.';
  }
  if (name === 'schedule_recurring_poll') {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handleScheduleRecurringPoll(sock, chatId, sender, senderJid, input);
  }
  if (name === 'list_recurring_polls') {
    return handleListRecurringPolls(chatId);
  }
  if (name === 'pause_recurring_poll') {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handlePauseRecurringPoll(sock, chatId, sender, senderJid, input.scheduleId || null);
  }
  if (name === 'resume_recurring_poll') {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handleResumeRecurringPoll(sock, chatId, sender, senderJid, input.scheduleId || null);
  }
  if (name === 'limit_poll_slots' || name === 'set_poll_slots') {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handleSetPollSlots(sock, chatId, sender, senderJid, input.targetId || null, input.slots);
  }
  if (name === 'modify_poll_instance') {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handleModifyPollInstance(sock, chatId, sender, senderJid, input.targetId, input);
  }
  if (name === 'modify_recurring_poll') {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    if (input.modifyInstance === true) {
      return await handleModifyPollInstance(sock, chatId, sender, senderJid, input.scheduleId, input);
    }
    return await handleModifyRecurringPoll(sock, chatId, sender, senderJid, input.scheduleId, input);
  }
  if (name === 'skip_recurring_poll_instance' || name === 'skip_poll_instance') {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handleSkipRecurringPollInstance(sock, chatId, sender, senderJid, input.scheduleId || null, input.targetDayOrDate || input.dateOrDay || null);
  }
  if (name === 'unskip_recurring_poll_instance' || name === 'unskip_poll_instance') {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handleUnskipRecurringPollInstance(sock, chatId, sender, senderJid, input.scheduleId || null, input.targetDayOrDate || input.dateOrDay || null);
  }
  if (name === 'cancel_recurring_poll') {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handleCancelRecurringPoll(sock, chatId, sender, senderJid, input.scheduleId);
  }
    if (name === "list_groups" || name === "get_groups") {
    if (chatId && chatId.endsWith("@g.us")) {
      return "⚠️ The !groups command can only be called via Direct Message (DM) with the bot.";
    }
    return await handleListGroups(sock);
  }
  if (name === 'get_court_bookings' || name === 'get_court_reservations') {
    const res = await scvcc.getCourtBookings({ ...input, chatId });
    return res?.message || 'Retrieved court bookings.';
  }
  if (name === 'check_court_availability') {
    const res = await scvcc.checkCourtAvailability({ ...input, chatId });
    return res?.message || 'Checked court availability.';
  }
  if (name === 'book_court') {
    const res = await scvcc.bookCourt({ ...input, requester: input.requester || sender, chatId });
    return res?.message || 'Court booked.';
  }
  if (name === 'get_my_court_bookings') {
    const res = await scvcc.getMyReservations();
    return res?.message || 'Retrieved court reservations.';
  }
  if (name === 'clear_all_recurring_polls' || name === 'cancel_all_recurring_polls') {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handleClearAllRecurringPolls(sock, chatId, sender, senderJid);
  }
  if (name === 'clear_all_polls') {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handleClearAllPolls(sock, chatId, senderJid);
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
 * Helper to check if two player names refer to the same player
 * (handling case differences, registered aliases/LIDs, and first/full name prefixes).
 */
function isSamePlayerName(name1, name2) {
  if (!name1 || !name2) return false;
  if (ratings.isPlaceholder(name1) || ratings.isPlaceholder(name2)) return false;
  const k1 = ratings.keyFor(name1);
  const k2 = ratings.keyFor(name2);
  if (!k1 || !k2) return false;
  if (k1 === k2) return true;
  const m1 = namesStore.findIdByNameOrAlias(name1);
  const m2 = namesStore.findIdByNameOrAlias(name2);
  if (m1 && m2 && m1.id && m2.id && m1.id === m2.id) return true;
  if (k1.length >= 3 && k2.length >= 3) {
    if (k1.startsWith(k2 + ' ') || k2.startsWith(k1 + ' ')) return true;
  }
  return false;
}

/**
 * Extracts match time mentioned in a lineup message text or parsed lineup object.
 */
function extractTimeFromLineupMessage(text, lineup = null) {
  if (lineup && lineup.time) {
    const parsed = pollTime.parseTimeString(lineup.time);
    if (parsed) return { hour: parsed.hour, minute: parsed.minute, display: parsed.display };
  }
  if (!text || typeof text !== 'string') return null;
  const m1 = text.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/i);
  if (m1) {
    const rawH = parseInt(m1[1], 10);
    const minute = m1[2] ? parseInt(m1[2], 10) : 0;
    const ampm = m1[3].toLowerCase();
    let hour = rawH % 12;
    if (ampm === 'pm') hour += 12;
    return { hour, minute, display: `${m1[1]}${m1[2] ? ':' + m1[2] : ''}${ampm}` };
  }
  const m2 = text.match(/\b([01]?\d|2[0-3])[:.](\d{2})\b/);
  if (m2) {
    let hour = parseInt(m2[1], 10);
    const minute = parseInt(m2[2], 10);
    if (hour >= 1 && hour <= 6) hour += 12;
    return { hour, minute, display: `${hour}:${String(minute).padStart(2, '0')}` };
  }
  return null;
}

/**
 * Extracts wall-clock hour and minute in San Jose for a poll state.
 */
function getPollMatchTime(pollState) {
  if (!pollState) return null;
  if (pollState.playAt) {
    const d = new Date(pollState.playAt);
    if (!Number.isNaN(d.getTime())) {
      const sj = pollTime.getSanJoseParts(d);
      return { hour: sj.hour, minute: sj.minute };
    }
  }
  if (pollState.when) {
    const pt = pollTime.parseTimeString(pollState.when);
    if (pt) return { hour: pt.hour, minute: pt.minute };
  }
  if (pollState.name) {
    const pt = pollTime.parseTimeString(pollState.name);
    if (pt) return { hour: pt.hour, minute: pt.minute };
  }
  return null;
}

/**
 * Resolves all distinct voted / roster players for a poll.
 */
function getPollPlayerNames(pollId, pollState, mePn) {
  const { interestedPlayers, aggregated } = getPollVoters(pollId, pollState, mePn);
  const roster = resolveFixedPollRoster(pollState, aggregated);

  const players = [];
  const addPlayer = (name) => {
    if (!name || ratings.isPlaceholder(name)) return;
    if (!players.some((existing) => isSamePlayerName(existing, name))) {
      players.push(name);
    }
  };

  if (Array.isArray(roster.players)) {
    for (const p of roster.players) addPlayer(p);
  }
  if (Array.isArray(interestedPlayers)) {
    for (const p of interestedPlayers) addPlayer(p);
  }
  if (Array.isArray(pollState.lastPlayers)) {
    for (const p of pollState.lastPlayers) addPlayer(p);
  }

  const cleanRosterCount = roster.players ? roster.players.filter((p) => !ratings.isPlaceholder(p)).length : 0;
  return {
    players,
    rosterCount: cleanRosterCount,
    filledCount: roster.filledCount || 0,
    size: pollState.size || null
  };
}

/**
 * Attributes a deciphered lineup message to the appropriate poll when multiple active polls exist.
 * First tries to find an exact match for players and time.
 * If no exact match is found, gives preference to the poll with the most player name matches to votes.
 */
function findBestMatchingPollForLineup({ activePolls, chatId, lineup, messageText, mePn }) {
  let candidatePolls = [];
  for (const [pollId, pollState] of activePolls.entries()) {
    if (pollState.remoteJid === chatId && (pollState.status === 'active' || pollState.status === 'filled' || pollState.status === 'stopped')) {
      candidatePolls.push({ pollId, pollState });
    }
  }

  if (candidatePolls.length === 0) {
    for (const [pollId, pollState] of activePolls.entries()) {
      if (pollState.remoteJid === chatId && pollState.status === 'resolved') {
        candidatePolls.push({ pollId, pollState });
      }
    }
  }

  if (candidatePolls.length === 0) {
    const latestId = latestPollIdByChat.get(chatId);
    const latestState = latestId ? activePolls.get(latestId) : null;
    if (latestState) {
      return { targetPollId: latestId, targetPollState: latestState, matchInfo: 'fallback_latest' };
    }
    return { targetPollId: null, targetPollState: null, matchInfo: 'none' };
  }

  const msgTime = extractTimeFromLineupMessage(messageText, lineup);
  const lineupPlayers = (lineup?.players || []).filter((p) => !ratings.isPlaceholder(p));

  const scored = candidatePolls.map(({ pollId, pollState }, index) => {
    const pollTimeObj = getPollMatchTime(pollState);
    const isExactTimeMatch = Boolean(
      msgTime && pollTimeObj &&
      msgTime.hour === pollTimeObj.hour &&
      msgTime.minute === pollTimeObj.minute
    );

    const pollPlayerInfo = getPollPlayerNames(pollId, pollState, mePn);
    const pollPlayers = pollPlayerInfo.players;

    let matchCount = 0;
    const matchedPollIndices = new Set();
    const matchedNames = [];

    for (const lp of lineupPlayers) {
      for (let i = 0; i < pollPlayers.length; i++) {
        if (!matchedPollIndices.has(i) && isSamePlayerName(lp, pollPlayers[i])) {
          matchedPollIndices.add(i);
          matchedNames.push(pollPlayers[i]);
          matchCount++;
          break;
        }
      }
    }

    const isExactPlayerMatch = Boolean(
      lineupPlayers.length > 0 &&
      matchCount === lineupPlayers.length &&
      (
        pollPlayers.length === lineupPlayers.length ||
        (pollPlayerInfo.rosterCount > 0 && matchCount === pollPlayerInfo.rosterCount) ||
        (pollPlayerInfo.size && matchCount === pollPlayerInfo.size)
      )
    );

    const isExactBoth = Boolean(isExactPlayerMatch && isExactTimeMatch);

    const matchRatio = pollPlayers.length > 0
      ? matchCount / Math.max(lineupPlayers.length, pollPlayers.length)
      : 0;

    return {
      pollId,
      pollState,
      index,
      matchCount,
      matchedNames,
      matchRatio,
      isExactPlayerMatch,
      isExactTimeMatch,
      isExactBoth,
      statusWeight: pollState.status === 'filled' ? 2 : (pollState.status === 'active' ? 1 : 0)
    };
  });

  // Tier 1: Exact match for BOTH players AND time
  const exactBothMatches = scored.filter((s) => s.isExactBoth);
  if (exactBothMatches.length > 0) {
    exactBothMatches.sort((a, b) => b.index - a.index);
    const best = exactBothMatches[0];
    return {
      targetPollId: best.pollId,
      targetPollState: best.pollState,
      matchInfo: `exact_players_and_time (${best.matchCount} players, time: ${msgTime?.display || ''})`
    };
  }

  // Tier 2: Prefer poll with most player name matches to votes
  scored.sort((a, b) => {
    if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
    if (b.isExactTimeMatch !== a.isExactTimeMatch) return (b.isExactTimeMatch ? 1 : 0) - (a.isExactTimeMatch ? 1 : 0);
    if (b.matchRatio !== a.matchRatio) return b.matchRatio - a.matchRatio;
    if (b.statusWeight !== a.statusWeight) return b.statusWeight - a.statusWeight;
    return b.index - a.index;
  });

  const best = scored[0];
  return {
    targetPollId: best.pollId,
    targetPollState: best.pollState,
    matchInfo: best.matchCount > 0
      ? `player_votes_preference (${best.matchCount} player match(es): ${best.matchedNames.join(', ')})`
      : 'fallback_most_recent'
  };
}

/**
 * Records a manually published lineup in the chat into the active poll state
 * and pair history so score reports and partner memory work seamlessly.
 */
async function handleManualLineup(sock, chatId, sender, lineup, msg, rawText = '') {
  const messageText = rawText || msg?.message?.conversation || msg?.message?.extendedTextMessage?.text || '';
  const mePn = botSock?.authState?.creds?.me?.id || null;

  const matchResult = findBestMatchingPollForLineup({
    activePolls,
    chatId,
    lineup,
    messageText,
    mePn
  });

  const targetPollId = matchResult?.targetPollId || null;
  const targetPollState = matchResult?.targetPollState || null;

  if (targetPollState) {
    targetPollState.status = 'resolved';
    targetPollState.lastPlayers = lineup.players;
    targetPollState.lastSchedule = lineup;
    pairHistory.recordDraw(targetPollId, lineup, Date.now(), chatId);
    await ratings.ensureRated(lineup.players);
    persistPolls();
    console.log(`[lineup] Attributed manual lineup to poll ${targetPollId} in ${chatId} [${matchResult.matchInfo}] (${lineup.players.length} players: ${lineup.players.join(', ')})`);
  } else {
    pairHistory.recordDraw(`manual_${Date.now()}`, lineup, Date.now(), chatId);
    await ratings.ensureRated(lineup.players);
    console.log(`[lineup] Recorded standalone manual lineup in ${chatId} (${lineup.players.length} players: ${lineup.players.join(', ')})`);
  }

  if (msg?.key && sock) {
    try {
      await sock.sendMessage(chatId, {
        react: {
          text: '🤖',
          key: msg.key
        }
      });
      console.log(`[lineup] Added 🤖 reaction to lineup message in ${chatId}`);
    } catch (err) {
      console.error(`[lineup] Failed to add 🤖 reaction:`, err.message);
    }
  }

  return null;
}

async function getResponse(sock, rawText, chatId, sender, msg) {
  const text = (rawText || '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\u00A0\u202F\u2000-\u200A]/g, ' ')
    .trim();
  const lower = text.toLowerCase();

  // --- Basic commands ---
  if (lower === '!ping') return 'pong 🏓';

  if (lower === '!help' || lower.startsWith('!help ')) {
    const specificCmd = text.slice('!help'.length).trim().replace(/^!/, '').toLowerCase();
    return helpText(specificCmd || null);
  }

  if (
    lower === "!groups" || lower.startsWith("!groups ") ||
    lower === "!listgroups" || lower.startsWith("!listgroups ") ||
    lower === "!mygroups" ||
    lower === "!getgroups" ||
    lower === "!allgroups" ||
    lower === "!groupids" ||
    lower === "!grouplids"
  ) {
    if (chatId && chatId.endsWith("@g.us")) {
      return "⚠️ The `!groups` command can only be called via Direct Message (DM) with the bot.";
    }
    return await handleListGroups(sock);
  }

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

  // --- SCVCC Court Status & Booking Commands ---
  if (lower === '!courtbookings' || lower.startsWith('!courtbookings ') ||
      lower === '!bookings' || lower.startsWith('!bookings ') ||
      lower === '!courtreservations' || lower.startsWith('!courtreservations ') ||
      lower === '!reservations' || lower.startsWith('!reservations ') ||
      lower === '!courtschedule' || lower.startsWith('!courtschedule ')) {
    const parsed = scvcc.parseBookingsCommand(text);
    const res = await scvcc.getCourtBookings({ ...parsed, chatId });
    return res?.message || 'Could not retrieve court bookings.';
  }

  if (lower === '!courts' || lower.startsWith('!courts ') || lower === '!courtstatus' || lower.startsWith('!courtstatus ') || lower === '!courtavailability' || lower.startsWith('!courtavailability ')) {
    const parsed = scvcc.parseCourtsCommand(text);
    const res = await scvcc.checkCourtAvailability({ ...parsed, chatId });
    return res?.message || 'Could not retrieve court status.';
  }

  if (lower.startsWith('!bookcourt') || lower.startsWith('!reservecourt')) {
    return 'Court booking via bot is currently paused. Please check court availability using !courts.';
  }

  if (lower === '!mybookings' || lower === '!myreservations' || lower === '!mycourts') {
    return 'Court reservations viewing is currently paused.';
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
    const res = namesStore.addAliasForPlayer(parsed.name, parsed.alias, senderJid, chatId);
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
      const match = namesStore.findIdByNameOrAlias(targetAlias, chatId);
      if (match) resolvedPlayer = match.entry?.name;
    }

    const canManage = await canUserManagePlayerAlias(sock, chatId, senderJid, sender, resolvedPlayer || targetAlias);
    if (!canManage) {
      return '⚠️ Only group admins can delete aliases for other players. You can delete aliases for yourself (e.g. "!deletealias <your alias>").';
    }

    const res = namesStore.removeAliasForPlayer(targetPlayer, targetAlias, chatId);
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
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    const parsed = parseSetRatingCommand(text, sender);
    if (!parsed) {
      return `Please provide a valid rating between ${ratings.MIN_RATING} and ${ratings.MAX_RATING}, e.g. "!setrating 3.5" or "${TRIGGER_PREFIX} set my rating to 4.0".`;
    }
    return await handleSetRating(sock, chatId, senderJid, sender, parsed.name, parsed.rating);
  }

  if (lower.startsWith('!resetrating') || lower.startsWith('!ratingreset')) {
    const raw = text.replace(/^!(?:resetrating|ratingreset)\s*/i, '').trim();
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handleResetRating(sock, chatId, senderJid, sender, raw || null);
  }

  if (lower === '!ratings') {
    return formatRatings(chatId);
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

  // --- Check for manually published lineup (only if at least one poll is active, filled, or stopped) ---
  const hasActivePollForLineup = [...activePolls.values()].some(
    (p) => p.remoteJid === chatId && (p.status === 'active' || p.status === 'filled' || p.status === 'stopped')
  );
  if (hasActivePollForLineup) {
    let manualLineup = parseLineup(text, knownPlayers(chatId));

    if (!manualLineup) {
      // Check in order with short-circuit evaluation (lineup -> court -> set -> vs -> @)
      const hasLineupHint = /\blineups?\b/i.test(text) ||
                            /\bcourts?\b|\bct\b|\bc\d+\b/i.test(text) ||
                            /\bsets?\b/i.test(text) ||
                            /\b(?:vs\.?|v\.?|versus)\b/i.test(text) ||
                            /@\w+/i.test(text);

      if (hasLineupHint) {
        console.log(`[lineup] Matchup hint detected in "${text}" (sender: ${sender}). Calling parseLineupWithLLM...`);
        manualLineup = await parseLineupWithLLM(text, chatId);
      }
    }

    if (manualLineup) {
      return await handleManualLineup(sock, chatId, sender, manualLineup, msg, text);
    }
  }

  // --- Direct Command Poll creation (!createpoll / !poll / !makepoll / !newpoll / !optinpoll / !yesnopoll) ---
  if (/^!(?:createpoll|poll|makepoll|newpoll|optinpoll|yesnopoll|createoptinpoll|createyesnopoll)\b/i.test(text)) {
    const parsed = parsePollCreationText(text);
    if (parsed) {
      return await handleDirectPollCreation(sock, chatId, sender, msg, parsed, { isCommand: true });
    }
  }

  // --- Recurring daily poll commands ---
  if (lower.startsWith('!recurringpoll status') || lower.startsWith('!schedulepoll status') || lower.startsWith('!recurringpolls status') || lower.startsWith('!scheduledpolls status')) {
    const parts = text.trim().split(/\s+/);
    const targetId = parts.length > 2 ? parts.slice(2).join(' ').replace(/^["']|["']$/g, '').trim() : null;
    if (targetId) {
      return recurringPollsModule.getRecurringPollStatus({ recurringPolls, scheduleId: targetId, chatId });
    }
    return handleListRecurringPolls(chatId);
  }

  if (lower === '!recurringpolls' || lower === '!scheduledpolls' || lower === '!dailypolls' || lower === '!recurringpoll list' || lower === '!schedulepoll list') {
    return handleListRecurringPolls(chatId);
  }

  if (lower === '!clearallrecurringpolls' || lower === '!clearrecurringpolls' || lower === '!cancelallrecurringpolls' || lower === '!deleteallrecurringpolls' || lower === '!removeallrecurringpolls' || lower === '!clearallrecurring' || lower === '!cancelallrecurring') {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handleClearAllRecurringPolls(sock, chatId, sender, senderJid);
  }

  if (lower.startsWith('!cancelrecurringpoll') || lower.startsWith('!deleterecurringpoll') || lower.startsWith('!removerecurringpoll') || lower.startsWith('!clearrecurringpoll')) {
    const parts = text.split(/\s+/);
    const specificId = parts.length > 1 ? parts[1].trim() : null;
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    if (specificId && /^all$/i.test(specificId)) {
      return await handleClearAllRecurringPolls(sock, chatId, sender, senderJid);
    }
    return await handleCancelRecurringPoll(sock, chatId, sender, senderJid, specificId);
  }

  if (lower.startsWith('!setslots') || lower.startsWith('!limitslots') || lower.startsWith('!setpollslots') || lower.startsWith('!limitsize') || lower.startsWith('!setsize') || lower.startsWith('!pollslots')) {
    const parts = text.trim().split(/\s+/);
    let target = null;
    let count = null;
    if (parts.length === 2) {
      if (/^\d+$/.test(parts[1]) || /^(?:reset|clear|none)$/i.test(parts[1])) {
        count = parts[1];
      } else {
        target = parts[1];
      }
    } else if (parts.length >= 3) {
      target = parts[1];
      count = parts[2];
    }
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handleSetPollSlots(sock, chatId, sender, senderJid, target, count);
  }

  // Check for modifying specific poll / recurring poll instances
  const modifyInstanceCmd = parseModifyInstanceCommand(text);
  if (modifyInstanceCmd) {
    if (!modifyInstanceCmd.targetId) {
      return 'Please specify which poll instance to modify, e.g. "!modifyinstance rec_1 12 7pm" or "!modifyinstance <pollId> 8".';
    }
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handleModifyPollInstance(sock, chatId, sender, senderJid, modifyInstanceCmd.targetId, modifyInstanceCmd.updates);
  }

  if (/^!(?:modifyrecurringpoll|editrecurringpoll|updaterecurringpoll|changerecurringpoll|modifyrecurring|editrecurring|updaterecurring)\b/i.test(text)) {
    const parsed = recurringPollsModule.parseRecurringPollText(text);
    if (parsed && parsed.action === 'modify') {
      const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
      return await handleModifyRecurringPoll(sock, chatId, sender, senderJid, parsed.scheduleId, parsed.updates);
    }
  }

  if (lower.startsWith('!skipinstance') || lower.startsWith('!skiprecurringinstance') || lower.startsWith('!skiprecurringpoll') || lower.startsWith('!skiprecurring') || lower.startsWith('!skippoll')) {
    const parts = text.trim().split(/\s+/);
    const target = parts.length > 1 ? parts[1].trim() : null;
    const targetDayOrDate = parts.length > 2 ? parts.slice(2).join(' ').trim() : null;
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handleSkipRecurringPollInstance(sock, chatId, sender, senderJid, target, targetDayOrDate);
  }

  if (lower.startsWith('!unskipinstance') || lower.startsWith('!unskiprecurringinstance') || lower.startsWith('!unskiprecurringpoll') || lower.startsWith('!unskiprecurring') || lower.startsWith('!resumeskip')) {
    const parts = text.trim().split(/\s+/);
    const target = parts.length > 1 ? parts[1].trim() : null;
    const targetDayOrDate = parts.length > 2 ? parts.slice(2).join(' ').trim() : null;
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handleUnskipRecurringPollInstance(sock, chatId, sender, senderJid, target, targetDayOrDate);
  }

  if (lower.startsWith('!recurringpoll skip') || lower.startsWith('!recurringpolls skip') || lower.startsWith('!schedulepoll skip') || lower.startsWith('!scheduledpolls skip')) {
    const parts = text.trim().split(/\s+/);
    const target = parts.length > 2 ? parts[2].trim() : null;
    const targetDayOrDate = parts.length > 3 ? parts.slice(3).join(' ').trim() : null;
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handleSkipRecurringPollInstance(sock, chatId, sender, senderJid, target, targetDayOrDate);
  }

  if (lower.startsWith('!recurringpoll unskip') || lower.startsWith('!recurringpolls unskip') || lower.startsWith('!schedulepoll unskip') || lower.startsWith('!scheduledpolls unskip')) {
    const parts = text.trim().split(/\s+/);
    const target = parts.length > 2 ? parts[2].trim() : null;
    const targetDayOrDate = parts.length > 3 ? parts.slice(3).join(' ').trim() : null;
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handleUnskipRecurringPollInstance(sock, chatId, sender, senderJid, target, targetDayOrDate);
  }

  if (lower.startsWith('!pauseallrecurring') || lower.startsWith('!stopallrecurring') || lower === '!pauserecurringpolls' || lower === '!stoprecurringpolls') {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handlePauseRecurringPoll(sock, chatId, sender, senderJid, 'all');
  }

  if (lower.startsWith('!resumeallrecurring') || lower.startsWith('!startallrecurring') || lower === '!resumerecurringpolls' || lower === '!startrecurringpolls') {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handleResumeRecurringPoll(sock, chatId, sender, senderJid, 'all');
  }

  if (lower.startsWith('!recurringpoll pause') || lower.startsWith('!recurringpolls pause') || lower.startsWith('!schedulepoll pause') || lower.startsWith('!scheduledpolls pause')) {
    const parts = text.trim().split(/\s+/);
    const specificId = parts.length > 2 ? parts.slice(2).join(' ').trim() : null;
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handlePauseRecurringPoll(sock, chatId, sender, senderJid, specificId);
  }

  if (lower.startsWith('!recurringpoll resume') || lower.startsWith('!recurringpolls resume') || lower.startsWith('!schedulepoll resume') || lower.startsWith('!scheduledpolls resume')) {
    const parts = text.trim().split(/\s+/);
    const specificId = parts.length > 2 ? parts.slice(2).join(' ').trim() : null;
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handleResumeRecurringPoll(sock, chatId, sender, senderJid, specificId);
  }

  if (lower.startsWith('!pauserecurringpoll') || lower.startsWith('!stoprecurringpoll') || lower.startsWith('!pauserecurring') || lower.startsWith('!stoprecurring')) {
    const parts = text.split(/\s+/);
    const specificId = parts.length > 1 ? parts.slice(1).join(' ').trim() : null;
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handlePauseRecurringPoll(sock, chatId, sender, senderJid, specificId);
  }

  if (lower.startsWith('!resumerecurringpoll') || lower.startsWith('!startrecurringpoll') || lower.startsWith('!resumerecurring') || lower.startsWith('!startrecurring')) {
    const parts = text.split(/\s+/);
    const specificId = parts.length > 1 ? parts.slice(1).join(' ').trim() : null;
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handleResumeRecurringPoll(sock, chatId, sender, senderJid, specificId);
  }

  if (/^!(?:recurringpoll|dailypoll|schedulepoll|everydaypoll|repeatingpoll|recurringoptinpoll|dailyoptinpoll|recurringyesnopoll|dailyyesnopoll)\b/i.test(text)) {
    const parsed = recurringPollsModule.parseRecurringPollText(text);
    if (parsed) {
      if (parsed.action === 'status') {
        if (parsed.scheduleId) {
          return recurringPollsModule.getRecurringPollStatus({ recurringPolls, scheduleId: parsed.scheduleId, chatId });
        }
        return handleListRecurringPolls(chatId);
      }
      if (parsed.action === 'list') {
        return handleListRecurringPolls(chatId);
      }
      if (parsed.action === 'clear_all') {
        const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
        return await handleClearAllRecurringPolls(sock, chatId, sender, senderJid);
      }
      if (parsed.action === 'cancel') {
        const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
        return await handleCancelRecurringPoll(sock, chatId, sender, senderJid, parsed.scheduleId);
      }
      if (parsed.action === 'skip_instance') {
        const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
        return await handleSkipRecurringPollInstance(sock, chatId, sender, senderJid, parsed.scheduleId, parsed.targetDayOrDate);
      }
      if (parsed.action === 'unskip_instance') {
        const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
        return await handleUnskipRecurringPollInstance(sock, chatId, sender, senderJid, parsed.scheduleId, parsed.targetDayOrDate);
      }
      if (parsed.action === 'pause') {
        const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
        return await handlePauseRecurringPoll(sock, chatId, sender, senderJid, parsed.scheduleId);
      }
      if (parsed.action === 'modify') {
        const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
        return await handleModifyRecurringPoll(sock, chatId, sender, senderJid, parsed.scheduleId, parsed.updates);
      }
      if (parsed.action === 'resume') {
        const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
        return await handleResumeRecurringPoll(sock, chatId, sender, senderJid, parsed.scheduleId);
      }
      const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
      return await handleScheduleRecurringPoll(sock, chatId, sender, senderJid, parsed);
    }
  }

  // --- Poll management ---
  if (lower.startsWith('!stoppoll') || lower.startsWith('!closepoll') || lower === '!stop' || lower === '!close') {
    const parts = text.split(/\s+/);
    const specificPollId = parts.length > 1 ? parts[1].trim() : null;
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handleStopPoll(sock, chatId, sender, senderJid, specificPollId);
  }

  if (lower.startsWith('!resumepoll') || lower.startsWith('!reopenpoll') || lower === '!resume' || lower === '!reopen') {
    const parts = text.split(/\s+/);
    const specificPollId = parts.length > 1 ? parts[1].trim() : null;
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handleResumePoll(sock, chatId, sender, senderJid, specificPollId);
  }

  if (lower.startsWith('!pausereminder') || lower.startsWith('!pausereminders') || lower === '!silencereminders') {
    const parts = text.split(/\s+/);
    const specificPollId = parts.length > 1 ? parts[1].trim() : null;
    return await handlePauseReminders(sock, chatId, sender, specificPollId);
  }

  if (lower.startsWith('!resumereminder') || lower.startsWith('!resumereminders') || lower.startsWith('!unpausereminder') || lower.startsWith('!unpausereminders')) {
    const parts = text.split(/\s+/);
    const specificPollId = parts.length > 1 ? parts[1].trim() : null;
    return await handleResumeReminders(sock, chatId, sender, specificPollId);
  }

  if (lower.startsWith('!sendreminder') || lower.startsWith('!remindpoll') || lower === '!remind' || lower === '!sendreminders' || lower === '!triggerreminder') {
    const parts = text.split(/\s+/);
    const specificPollId = parts.length > 1 ? parts[1].trim() : null;
    return await handleTriggerReminder(sock, chatId, sender, specificPollId);
  }

  if (lower === '!clearallpolls' || lower === '!clearpolls') {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handleClearAllPolls(sock, chatId, senderJid);
  }

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

  if (lower === '!rematch' || lower === '!matchups' || lower === '!draw' || lower.startsWith('!rematch ') || lower.startsWith('!matchups ') || lower.startsWith('!draw ')) {
    const textFixedPairs = extractFixedPairsFromText(text);
    const cleanArg = text.replace(/^!(?:rematch|matchups|draw)\b/i, '')
      .replace(/\b(?:keeping|keep|put|with)\s+[a-z0-9\s._'-]+?\s+(?:and|&)\s+[a-z0-9\s._'-]+?\s+(?:in|on)\s+(?:the\s+)?(?:same\s+)?team\b/ig, '')
      .replace(/\b(?:keeping|keep|put|with)\s+[a-z0-9\s._'-]+?\s+(?:and|&)\s+[a-z0-9\s._'-]+?\s+together\b/ig, '')
      .replace(/\b[a-z0-9\s._'-]+?\s+(?:and|&)\s+[a-z0-9\s._'-]+?\s+(?:in|on)\s+(?:the\s+)?(?:same\s+)?team\b/ig, '')
      .trim();
    return await generateMatchupsFromPoll(sock, chatId, null, cleanArg || null, { fixedPairs: textFixedPairs });
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

  if (lower === '!activepolls' || lower === '!activepollstatus' || lower === '!active' || lower === '!pollstatus active' || lower === '!pollstatus -act') {
    return pollStatusText(null, { activeOnly: true });
  }

  if (lower === '!upcomingpolls' || lower === '!upcomingpollstatus' || lower === '!upcoming' || lower === '!pollstatus upcoming' || lower === '!pollstatus -u') {
    return pollStatusText(null, { upcomingOnly: true });
  }

  if (lower === '!allpolls' || lower === '!allpollstatus' || lower === '!pollstatus all' || lower === '!pollstatusall' || lower === '!pollstatus -a') {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    const isAdmin = await isUserAdmin(sock, chatId, senderJid);
    if (!isAdmin) {
      return '⚠️ Only group admins can view status of all polls.';
    }
    return pollStatusText(null);
  }

  if (lower === '!pollstatus') {
    const effectiveChatId = chatId.endsWith('@g.us') ? chatId : (targetGroupJid || await getTargetGroupJid(sock) || chatId);
    return pollStatusText(effectiveChatId);
  }

  if (lower.startsWith('!pollstatus ') || lower.startsWith('!pollstatus:')) {
    const rawTarget = text.trim().slice('!pollstatus'.length).replace(/^[:\s]+/, '').trim();
    const cleanTarget = rawTarget.replace(/^["']|["']$/g, '').replace(/^schedule\s+/i, '').trim();
    const effectiveChatId = chatId.endsWith('@g.us') ? chatId : (targetGroupJid || await getTargetGroupJid(sock) || chatId);
    if (cleanTarget) {
      if (cleanTarget === 'recurring' || cleanTarget === '-r' || cleanTarget === 'scheduled' || cleanTarget === '-s') {
        return pollStatusText(effectiveChatId, { recurringOnly: true });
      }
      return pollStatusText(effectiveChatId, { targetId: cleanTarget });
    }
    return pollStatusText(effectiveChatId);
  }

  // --- Check if message announces court cancellation due to lack of votes in poll ---
  const hasCancelWord = /\bcancel(?:l?ed|l?ing|s)?\b/i.test(text);
  const hasCourtWord = /\bcourts?\b/i.test(text);
  if (hasCancelWord && hasCourtWord) {
    const cancelAnalysis = await checkCourtCancellationWithLLM(text, sender, chatId);
    if (cancelAnalysis && cancelAnalysis.isCourtCancelled) {
      let targetPollId = cancelAnalysis.pollId;
      if (!targetPollId || !activePolls.has(targetPollId)) {
        for (const [pollId, pollState] of [...activePolls.entries()].reverse()) {
          if (pollState.remoteJid === chatId && (pollState.status === 'active' || pollState.status === 'filled')) {
            targetPollId = pollId;
            break;
          }
        }
      }
      if (!targetPollId) targetPollId = latestPollIdByChat.get(chatId);

      if (targetPollId && activePolls.has(targetPollId)) {
        const targetPollState = activePolls.get(targetPollId);
        targetPollState.status = 'stopped';
        persistPolls();
        const pollName = targetPollState.name || targetPollState.when || 'Match Poll';
        console.log(`[poll] LLM detected court cancellation due to: "${cancelAnalysis.reason}". Poll ${targetPollId} ("${pollName}") status set to stopped.`);

        if (msg?.key && sock) {
          try {
            await sock.sendMessage(chatId, {
              react: {
                text: '🤖',
                key: msg.key
              }
            });
            console.log(`[poll] Added 🤖 reaction to court cancellation message in ${chatId}`);
          } catch (err) {
            console.error('[poll] Failed to add 🤖 reaction:', err.message);
          }
        }
        return null;
      }
    }
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

  // --- Direct Recurring Poll Request (handled directly without LLM) ---
  const directRecurringParsed = recurringPollsModule.parseRecurringPollText(promptText);
  if (directRecurringParsed) {
    if (directRecurringParsed.action === 'status') {
      if (directRecurringParsed.scheduleId) {
        return recurringPollsModule.getRecurringPollStatus({ recurringPolls, scheduleId: directRecurringParsed.scheduleId, chatId });
      }
      return handleListRecurringPolls(chatId);
    }
    if (directRecurringParsed.action === 'list') {
      return handleListRecurringPolls(chatId);
    }
    if (directRecurringParsed.action === 'clear_all') {
      const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
      return await handleClearAllRecurringPolls(sock, chatId, sender, senderJid);
    }
    if (directRecurringParsed.action === 'cancel') {
      const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
      return await handleCancelRecurringPoll(sock, chatId, sender, senderJid, directRecurringParsed.scheduleId);
    }
      if (directRecurringParsed.action === 'skip_instance') {
        const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
        return await handleSkipRecurringPollInstance(sock, chatId, sender, senderJid, directRecurringParsed.scheduleId, directRecurringParsed.targetDayOrDate);
      }
      if (directRecurringParsed.action === 'unskip_instance') {
        const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
        return await handleUnskipRecurringPollInstance(sock, chatId, sender, senderJid, directRecurringParsed.scheduleId, directRecurringParsed.targetDayOrDate);
      }
    if (directRecurringParsed.action === 'pause') {
      const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
      return await handlePauseRecurringPoll(sock, chatId, sender, senderJid, directRecurringParsed.scheduleId);
    }
    if (directRecurringParsed.action === 'modify') {
      const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
      return await handleModifyRecurringPoll(sock, chatId, sender, senderJid, directRecurringParsed.scheduleId, directRecurringParsed.updates);
    }
    if (directRecurringParsed.action === 'resume') {
      const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
      return await handleResumeRecurringPoll(sock, chatId, sender, senderJid, directRecurringParsed.scheduleId);
    }
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await handleScheduleRecurringPoll(sock, chatId, sender, senderJid, directRecurringParsed);
  }

  // --- Direct Poll Creation Request (handled directly without LLM) ---
  const directPollParsed = parsePollCreationText(promptText);
  if (directPollParsed) {
    return await handleDirectPollCreation(sock, chatId, sender, msg, directPollParsed, { isCommand: false });
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



async function handleSetRating(sock, chatId, senderJid, senderName, playerName, ratingVal) {
  if (typeof ratingVal !== 'number' || Number.isNaN(ratingVal) || ratingVal < ratings.MIN_RATING || ratingVal > ratings.MAX_RATING) {
    return `Please provide a valid rating between ${ratings.MIN_RATING} and ${ratings.MAX_RATING}, e.g. "!setrating 3.5" or "${TRIGGER_PREFIX} set my rating to 4.0".`;
  }

  const targetPlayer = playerName || senderName || (senderJid ? nameFor(senderJid) : 'me');
  const canManage = await canUserManagePlayerAlias(sock, chatId, senderJid, senderName, targetPlayer);
  if (!canManage) {
    return '⚠️ Only group admins can update ratings for other players. You can set your own rating.';
  }

  let targetJid = null;
  const tKey = ratings.keyFor(targetPlayer);
  const isSelf = ['me', 'myself', 'my', 'i'].includes(tKey) ||
    (senderName && ratings.keyFor(senderName) === tKey) ||
    (senderJid && ratings.keyFor(nameFor(senderJid)) === tKey);

  let resolvedPlayerName = targetPlayer;
  if (isSelf) {
    targetJid = senderJid || null;
    resolvedPlayerName = senderName !== 'Someone' ? senderName : (senderJid ? nameFor(senderJid) : 'Player');
  } else {
    const match = namesStore.findIdByNameOrAlias(targetPlayer, chatId);
    if (match) {
      targetJid = match.id || null;
      resolvedPlayerName = match.entry?.name || targetPlayer;
    }
  }

  const updated = ratings.setRating(resolvedPlayerName, ratingVal, { jid: targetJid });
  return `Updated rating for ${resolvedPlayerName} to ${ratings.formatRating(updated)}.`;
}

async function handleResetRating(sock, chatId, senderJid, senderName, playerName) {
  const targetPlayer = playerName || senderName || (senderJid ? nameFor(senderJid) : 'me');
  const canManage = await canUserManagePlayerAlias(sock, chatId, senderJid, senderName, targetPlayer);
  if (!canManage) {
    return '⚠️ Only group admins can reset ratings for other players. You can reset your own rating.';
  }

  let targetJid = null;
  const tKey = ratings.keyFor(targetPlayer);
  const isSelf = ['me', 'myself', 'my', 'i'].includes(tKey) ||
    (senderName && ratings.keyFor(senderName) === tKey) ||
    (senderJid && ratings.keyFor(nameFor(senderJid)) === tKey);

  let resolvedPlayerName = targetPlayer;
  if (isSelf) {
    targetJid = senderJid || null;
    resolvedPlayerName = senderName !== 'Someone' ? senderName : (senderJid ? nameFor(senderJid) : 'Player');
  } else {
    const match = namesStore.findIdByNameOrAlias(targetPlayer, chatId);
    if (match) {
      targetJid = match.id || null;
      resolvedPlayerName = match.entry?.name || targetPlayer;
    }
  }

  const res = await ratings.resetRating(resolvedPlayerName, { jid: targetJid });
  if (!res) {
    return `Could not reset rating for "${resolvedPlayerName}".`;
  }

  const locStr = res.tennisRecordLocation ? ` (${res.tennisRecordLocation})` : '';
  const urlStr = res.tennisRecordUrl ? ` -> ${res.tennisRecordUrl}` : '';
  return `🔄 Reset rating for "${res.name}" to baseline ${ratings.formatRating(res.rating)}${locStr}${urlStr}.`;
}

function parseSetRatingCommand(text, defaultSenderName = null) {
  const raw = text.replace(/^!(?:myrating|setrating)\s*/i, '').trim();
  if (!raw) return null;

  const forMatch = raw.match(/^for\s+(.+?)\s*(?:=|\bto\b|:)?\s*(\d+(?:\.\d+)?)$/i) ||
                   raw.match(/^(.+?)\s+\bfor\b\s+(\d+(?:\.\d+)?)$/i);
  if (forMatch) {
    return { name: forMatch[1].trim(), rating: parseFloat(forMatch[2]) };
  }

  const delimMatch = raw.match(/^(.+?)\s*(?:=|:|->|\bto\b|\bas\b)\s*(\d+(?:\.\d+)?)$/i);
  if (delimMatch) {
    return { name: delimMatch[1].trim(), rating: parseFloat(delimMatch[2]) };
  }

  const spaceMatch = raw.match(/^(.+?)\s+(\d+(?:\.\d+)?)$/);
  if (spaceMatch && Number.isNaN(parseFloat(spaceMatch[1]))) {
    return { name: spaceMatch[1].trim(), rating: parseFloat(spaceMatch[2]) };
  }

  const num = parseFloat(raw);
  if (!Number.isNaN(num)) {
    return { name: defaultSenderName || 'me', rating: num };
  }

  return null;
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

    const match = namesStore.findIdByNameOrAlias(targetPlayer, chatId);
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
  const match = namesStore.findIdByNameOrAlias(targetPlayer, chatId);
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
    if (entry.fullName) add(entry.fullName, entry.name);
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


/** Helper to extract epoch timestamp for a poll to ensure deterministic chronological sorting. */
function getPollPlayTime(pollState) {
  if (pollState?.playAt) {
    const t = new Date(pollState.playAt).getTime();
    if (!Number.isNaN(t)) return t;
  }
  if (pollState?.createdAt) {
    const t = new Date(pollState.createdAt).getTime();
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

/** The most recent poll state for a chat, if there is one. */
function lastPollStateFor(chatId) {
  const matching = [...activePolls.entries()]
    .filter(([, p]) => p.remoteJid === chatId && (p.lastSchedule || p.lastPlayers))
    .sort((a, b) => getPollPlayTime(b[1]) - getPollPlayTime(a[1]));

  if (matching.length > 0) {
    return matching[0][1];
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
function formatRatings(chatId = null) {
  const board = ratings.getAllRatings();
  if (board.length === 0) {
    return `Nobody's rated yet -- everyone starts from their TennisRecord rating (or ${ratings.formatRating(ratings.INITIAL_RATING)}) once they play a poll or set their rating.`;
  }
  const groupMembers = chatId ? namesStore.getGroupMembers(chatId) : null;
  const filteredBoard = groupMembers
    ? board.filter((p) => {
        const idNorm = (p.id || "").toLowerCase();
        const numOnly = idNorm.split("@")[0];
        const pnNorm = (p.pn || "").toLowerCase();
        const pnNum = pnNorm.split("@")[0];
        const nameKey = ratings.keyFor(p.name);
        return (
          groupMembers.has(idNorm) ||
          (numOnly && groupMembers.has(numOnly)) ||
          (pnNorm && groupMembers.has(pnNorm)) ||
          (pnNum && groupMembers.has(pnNum)) ||
          groupMembers.has(nameKey)
        );
      })
    : board;

  if (filteredBoard.length === 0) {
    return `Nobody in this group has a recorded rating yet -- players start from their TennisRecord rating (or ${ratings.formatRating(ratings.INITIAL_RATING)}) once they vote in a match poll or set their rating.`;
  }

  const lines = filteredBoard.map((p, i) => `${i + 1}. ${p.name} — ${ratings.formatRating(p.rating)}`);
  return `📊 Player ratings (${ratings.formatRating(ratings.MIN_RATING)}–${ratings.MAX_RATING}):\n${lines.join('\n')}`;
}

/**
 * Retrieves the set of direct court booking user LIDs configured in .env.
 */
function getDirectCourtBookingLids() {
  const envVal = process.env.DIRECT_COURT_BOOKING_USER_LIDS ||
    process.env.DIRECT_COURT_BOOKING_LIDS ||
    process.env.DIRECT_BOOKING_USER_LIDS ||
    process.env.DIRECT_BOOKING_LIDS || '';
  if (!envVal || !envVal.trim()) return new Set();

  const lids = new Set();
  const tokens = envVal.split(/[,;\s]+/).map((t) => t.trim()).filter(Boolean);
  for (const token of tokens) {
    const raw = token.replace(/['"]/g, '');
    lids.add(raw.toLowerCase());
    if (!raw.endsWith('@lid')) {
      lids.add(`${raw}@lid`.toLowerCase());
    } else {
      lids.add(raw.replace(/@lid$/i, '').toLowerCase());
    }
  }
  return lids;
}

/**
 * Checks if a court is configured to be ignored in .env (e.g. IGNORED_COURTS=Court 4).
 */
function isIgnoredCourt(courtName) {
  if (!courtName) return false;
  const envVal = process.env.IGNORED_COURTS || process.env.IGNORED_COURT || '';
  if (!envVal || !envVal.trim()) return false;

  const cleanCourt = String(courtName).trim().toLowerCase();
  const ignoredList = envVal.split(/[,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);

  for (const item of ignoredList) {
    if (cleanCourt === item) return true;

    // Check by number: e.g. item "4" matches "Court 4", "Ct 4", "4"
    const itemNumMatch = item.match(/\b(\d+)\b/);
    const courtNumMatch = cleanCourt.match(/\b(?:court|ct)?\s*(\d+)\b/i);
    if (itemNumMatch && courtNumMatch && itemNumMatch[1] === courtNumMatch[1]) {
      return true;
    }

    // Regex boundary check: e.g. item "court 4" matches "court 4 (90m)"
    const itemEscaped = item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${itemEscaped}\\b`, 'i').test(cleanCourt)) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if a group member's LID (or phone number) matches any of the direct booking user LIDs.
 */
function isDirectBookingUser(member) {
  if (!member) return false;
  const directLids = getDirectCourtBookingLids();
  if (directLids.size === 0) return false;

  const id = (member.id || '').toLowerCase();
  const idNum = id.split('@')[0];
  const pn = (member.pn || '').toLowerCase();
  const pnNum = pn.split('@')[0];

  return directLids.has(id) || directLids.has(idNum) || (pn && (directLids.has(pn) || directLids.has(pnNum)));
}

/**
 * Checks if a player name is a placeholder (TBD, Blocked, etc.).
 */
function isPlaceholderPlayer(name) {
  if (!name) return true;
  const c = name.trim().toLowerCase();
  return !c || c === 'tbd' || c === 'blocked';
}

/**
 * Obtains a clean short display name for a member (e.g. "Conrad", "PI", "Vijay").
 */
function getPlayerShortName(entry) {
  if (!entry) return '';
  const name = entry.name || entry.fullName || '';
  const words = name.trim().split(/\s+/);
  return words.length > 1 ? words[0] : name.trim();
}

/**
 * Matches an SCVCC player name to a group member entry in namesStore.
 */
function matchScvccPlayerToGroupMember(scvccPlayerName) {
  if (!scvccPlayerName) return null;
  const clean = scvccPlayerName.trim().toLowerCase();
  if (!clean || clean === 'tbd' || clean === 'blocked') return null;

  const scvccWords = clean.split(/[^a-z0-9]+/i).filter(Boolean);
  if (scvccWords.length === 0) return null;

  const allEntries = namesStore.getAllEntries();

  // 1. Exact full name or display name match
  for (const entry of allEntries) {
    const full = (entry.fullName || '').trim().toLowerCase();
    const disp = (entry.name || '').trim().toLowerCase();
    if (full && clean === full) return entry;
    if (disp && clean === disp) return entry;
  }

  // 2. Handle "Last, First" format from SCVCC (e.g. "Immaneni, Pramod")
  if (clean.includes(',')) {
    const [last, first] = clean.split(',').map((s) => s.trim());
    if (first && last) {
      const reordered = `${first} ${last}`.toLowerCase();
      for (const entry of allEntries) {
        const full = (entry.fullName || '').trim().toLowerCase();
        if (full && reordered === full) return entry;
        const disp = (entry.name || '').trim().toLowerCase();
        if (disp && reordered === disp) return entry;
      }
    }
  }

  // 3. First and last name match (e.g. "First Middle Last" vs "First Last")
  if (scvccWords.length >= 2) {
    const scvccFirst = scvccWords[0];
    const scvccLast = scvccWords[scvccWords.length - 1];

    for (const entry of allEntries) {
      const full = (entry.fullName || '').trim().toLowerCase();
      if (full) {
        const fullWords = full.split(/[^a-z0-9]+/i).filter(Boolean);
        if (fullWords.length >= 2) {
          if (scvccFirst === fullWords[0] && scvccLast === fullWords[fullWords.length - 1]) {
            return entry;
          }
        }
      }
    }
  }

  // 3. Fallback to findIdByNameOrAlias
  const byAlias = namesStore.findIdByNameOrAlias(scvccPlayerName);
  if (byAlias && byAlias.entry) {
    return byAlias.entry;
  }

  return null;
}

/**
 * Detects if an SCVCC court booking is a prebooked court for this group.
 * Rule:
 * 1. Direct court booking user lids can be specified in .env file in a property:
 *    If any of these users appear in a court booking, then that is a prebooked court.
 * 2. Otherwise:
 *    ALL the players in the court booking must be members of this group.
 */
function detectPrebookedCourt(booking) {
  if (!booking || !Array.isArray(booking.players)) return null;
  if (isIgnoredCourt(booking.court)) return null;

  // Filter out TBD or blocked placeholders to inspect real players
  const actualPlayers = booking.players.filter((p) => !isPlaceholderPlayer(p));
  if (actualPlayers.length === 0) return null;

  let directBookingMember = null;
  let allMembers = true;
  const matchedMembers = [];

  for (const p of actualPlayers) {
    const member = matchScvccPlayerToGroupMember(p);
    if (member) {
      matchedMembers.push(member);
      if (isDirectBookingUser(member)) {
        if (!directBookingMember) directBookingMember = member;
      }
    } else {
      allMembers = false;
    }
  }

  // 1. If any direct booking user appears in the booking:
  if (directBookingMember) {
    const playerName = getPlayerShortName(directBookingMember);
    return {
      isPrebooked: true,
      player: playerName,
      fullName: directBookingMember.fullName || directBookingMember.name,
      member: directBookingMember
    };
  }

  // 2. Otherwise, ALL the players in the court booking must be members of this group:
  if (allMembers && matchedMembers.length > 0) {
    // In SCVCC booking system, the 1st player is the member who booked the court
    const ownerMember = matchedMembers[0];
    const playerName = getPlayerShortName(ownerMember);
    return {
      isPrebooked: true,
      player: playerName,
      fullName: ownerMember.fullName || ownerMember.name,
      member: ownerMember
    };
  }

  return null;
}

// ---- Poll creation & vote handling ----

const inFlightPollCreations = new Set();

/**
 * Creates and sends a WhatsApp poll.
 * - If size is given (2 for singles, 4/8/12 for doubles), numbered slots are created
 *   ("Player 2" .. "Player <size>" with creator as Player 1 by default).
 * - If size is omitted (null/undefined), creates an opt-in poll with only two options:
 *   "Yes" and "No". The bot then waits for a user prompt to generate matchups from Yes voters.
 * - If replacePollId or cancelExisting is specified, deletes the older poll from WhatsApp.
 */
async function createMatchPoll(sock, remoteJid, size = null, when = null, dayWord = null, timeWord = null, creatorName = null, creatorJid = null, includeCreator = true, replacePollId = null, cancelExisting = false, isCommand = false, noMatchups = false, checkCourts = false, includePrebookedSpots = false, isRecurring = false, scheduleId = null, targetCourt = null) {
  const isAuto = size === 'auto' || String(size).toLowerCase() === 'auto';
  const isOptIn = !size && !isAuto;

  if (size !== null && size !== undefined && !isAuto) {
    const num = parseInt(size, 10);
    if (!Number.isInteger(num) || num <= 0) {
      return { err: `Give me a valid number of players (2, 4, 8, 12, 16) or 'auto', e.g. "${TRIGGER_PREFIX} create a poll for 4" or "${TRIGGER_PREFIX} create a poll for auto", or leave size empty for a Yes/No poll.` };
    }
    if (num > 40) {
      return { err: 'That\'s a lot of players for one poll -- try 40 or fewer.' };
    }
    size = num;
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

  const flightKey = `${remoteJid}:${scheduleId || "manual"}:${playAt.toISOString()}`;
  if (inFlightPollCreations.has(flightKey)) {
    console.log(`[poll] Duplicate in-flight poll creation suppressed for ${flightKey}`);
    return { err: "Poll creation already in progress" };
  }

  // Deduplicate against existing active recurring poll on same match date (unless replacing)
  if (scheduleId && !cancelExisting && !replacePollId) {
    const playDateStr = playAt.toDateString();
    for (const [id, existingPoll] of activePolls.entries()) {
      if (id !== replacePollId && existingPoll.remoteJid === remoteJid && (existingPoll.status === "active" || existingPoll.status === "filled")) {
        if (existingPoll.scheduleId === scheduleId) {
          const exDate = existingPoll.playAt ? new Date(existingPoll.playAt).toDateString() : null;
          if (exDate && exDate === playDateStr) {
            console.log(`[poll] Active poll already exists for schedule ${scheduleId} on ${playDateStr}`);
            return { err: `Active poll already exists for schedule ${scheduleId} on ${playDateStr}` };
          }
        }
      }
    }
  }

  inFlightPollCreations.add(flightKey);
  try {

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

  let shouldIncludeCreator = isAuto ? false : includeCreator;
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
          const existingWhen = existingPoll.when || new Date(existingPoll.playAt).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' });
          excludedReason = `a poll already exists for ${creatorName || 'you'} within 90 minutes of this start time (${existingWhen})`;
          console.log(`[poll] Not auto-adding ${creatorName || 'creator'} as Player 1 in new poll: already in poll ${existingPollId} within 90 minutes`);
          break;
        }
      }
    }
  }

  let values;
  let pollTitle;
  let validCount = isAuto ? null : size;
  let leadingVirtualCount = 0;
  let startIdx = 1;
  let courtLine = '';

  let prebookedCourtPlayers = [];
  let prebookedInfo = [];
  let queryTime = effectiveTimeWord;
  if (!queryTime && playAt) {
    const sjParts = getSanJoseParts(playAt);
    const h = sjParts.hour === 0 ? 12 : (sjParts.hour > 12 ? sjParts.hour - 12 : sjParts.hour);
    const m = String(sjParts.minute).padStart(2, '0');
    const ampm = sjParts.hour >= 12 ? 'pm' : 'am';
    queryTime = `${h}:${m}${ampm}`;
  }
  const targetDateMDY = scvcc.resolveDateToMDY(effectiveDayWord || resolvedWhen || playAt);
  let selectedPrebooked = [];

  // Default behavior is NOT to check court availability unless checkCourts is true or size is auto
  const effectiveCheckCourts = Boolean(checkCourts);

  const hasCourtChecks = isAuto || (effectiveCheckCourts && Boolean(queryTime));
  let prebookedCourts = [];
  let freeCourts = [];

  if (hasCourtChecks) {
    const seenPrebooked = new Set();
    let courtCheckPerformed = false;

    try {
      const [avail, bookingsRes] = await Promise.all([
        scvcc.checkCourtAvailability({ when: targetDateMDY, time: queryTime, sport: 'tennis', chatId }).catch((err) => {
          console.warn('[poll] Error checking court availability:', err.message);
          return null;
        }),
        scvcc.getCourtBookings({ when: targetDateMDY, time: queryTime, sport: 'tennis', chatId }).catch((err) => {
          console.warn('[poll] Error checking court bookings:', err.message);
          return null;
        })
      ]);

      if (avail || bookingsRes) {
        courtCheckPerformed = true;
      }

      const bookings = bookingsRes?.bookings || [];
      for (const b of bookings) {
        if (isIgnoredCourt(b.court)) continue;
        if (seenPrebooked.has(b.court)) continue;
        const prebookedMatch = detectPrebookedCourt(b);
        if (prebookedMatch) {
          prebookedCourts.push({
            court: b.court,
            player: prebookedMatch.player,
            fullName: prebookedMatch.fullName
          });
          seenPrebooked.add(b.court);
        }
      }

      if (avail?.slots && avail.slots.length > 0) {
        const slot = avail.slots[0];
        for (const c of slot.courts) {
          if (isIgnoredCourt(c.court)) continue;
          if (c.status === 'prebooked' && !seenPrebooked.has(c.court)) {
            prebookedCourts.push({
              court: c.court,
              player: c.prebookedBy || 'Member',
              fullName: c.prebookedFullName || c.prebookedBy || 'Member'
            });
            seenPrebooked.add(c.court);
          } else if (
            c.status === 'available' &&
            (c.availableMinutes || 0) >= 90 &&
            !seenPrebooked.has(c.court)
          ) {
            freeCourts.push({ court: c.court });
          }
        }
      }
    } catch (err) {
      console.warn('[poll] Error checking court availability/bookings for poll:', err.message);
    }

    if (targetCourt && !seenPrebooked.has(targetCourt)) {
      prebookedCourts.push({
        court: targetCourt,
        player: creatorName || 'Member',
        fullName: creatorName || 'Member'
      });
      seenPrebooked.add(targetCourt);
    }

    const totalCourtsCount = prebookedCourts.length + freeCourts.length;
    if (courtCheckPerformed && totalCourtsCount === 0) {
      const displayDate = scvcc.formatDisplayDate(targetDateMDY);
      const timeLabel = resolvedWhen || `${displayDate} at ${queryTime}`;
      const noCourtsMsg = `⚠️ Cannot create poll for *${timeLabel}*: No live or prebooked courts are available at SCVCC (all courts are reserved or blocked).`;
      console.log(`[poll] Cancelling poll creation in ${remoteJid}: no live or prebooked courts for ${timeLabel}`);
      if (sock && remoteJid) {
        try {
          messageHistory.recordMessage(remoteJid, 'tenbot', noCourtsMsg, Date.now(), true);
          await sock.sendMessage(remoteJid, { text: noCourtsMsg });
        } catch (sendErr) {
          console.error('[poll] Error sending no courts message:', sendErr.message);
        }
      }
      return {
        err: noCourtsMsg,
        noCourtsAvailable: true,
        message: noCourtsMsg
      };
    }
  } else if (targetCourt) {
    // Court availability check disabled, but user requested a specific court
    prebookedCourts.push({
      court: targetCourt,
      player: creatorName || 'Member',
      fullName: creatorName || 'Member'
    });
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

  if (isAuto) {
    selectedPrebooked = prebookedCourts.slice(0, 3);
    const remainingNeeded = Math.min(freeCourts.length, Math.max(0, 3 - selectedPrebooked.length));
    const selectedFree = freeCourts.slice(0, remainingNeeded);

    const totalCourtsCount = selectedPrebooked.length + selectedFree.length;
    validCount = totalCourtsCount > 0 ? totalCourtsCount * 4 : 4;

    const courtLines = [];
    prebookedInfo = [];
    for (const pb of selectedPrebooked) {
      const match = namesStore.findIdByNameOrAlias(pb.player);
      const canonicalName = (match && match.entry?.name) ? match.entry.name : pb.player;
      courtLines.push(`${pb.court} - ${canonicalName}'s Booking`);
      if (includePrebookedSpots) {
        const slotPlayerName = addNextCreatorPlayer(prebookedCourtPlayers, canonicalName);
        const slotLabel = `${slotPlayerName}'s Spot`;
        prebookedInfo.push({
          slotName: slotLabel,
          defaultPlayer: slotPlayerName,
          fullName: pb.player,
          court: pb.court
        });
      }
    }
    for (const fc of selectedFree) {
      courtLines.push(`${fc.court} - Available`);
    }

    if (courtLines.length > 0) {
      courtLine = `\n\n${courtLines.join('\n')}\n`;
    }

    if (includePrebookedSpots && prebookedInfo.length > 0) {
      const prebookedCount = prebookedInfo.length;
      values = [];
      for (const pb of prebookedInfo) {
        values.push(pb.slotName);
      }
      for (let i = prebookedCount + 1; i <= validCount; i++) {
        values.push(`Player ${i}`);
      }
      startIdx = 1;
      leadingVirtualCount = 0;
    } else {
      startIdx = 1;
      leadingVirtualCount = 0;
      values = Array.from({ length: validCount }, (_, i) => `Player ${i + 1}`);
    }
  } else if (!isOptIn) {
    const givenCount = size;
    if (isValidPlayerCount(givenCount)) {
      validCount = givenCount;
      startIdx = shouldIncludeCreator ? 2 : 1;
      const count = shouldIncludeCreator ? givenCount - 1 : givenCount;
      leadingVirtualCount = shouldIncludeCreator ? 1 : 0;
      values = Array.from({ length: count }, (_, i) => `Player ${i + startIdx}`);
    } else {
      validCount = getNextValidPlayerCount(givenCount);
      leadingVirtualCount = validCount - givenCount;
      startIdx = validCount - givenCount + 1;
      const count = givenCount;
      values = Array.from({ length: count }, (_, i) => `Player ${i + startIdx}`);
    }

    const totalCourtsCount = prebookedCourts.length + freeCourts.length;
    if (targetCourt || (effectiveCheckCourts && totalCourtsCount > 0)) {
      if (targetCourt) {
        const pbMatch = prebookedCourts.find(pb => pb.court.toLowerCase() === targetCourt.toLowerCase());
        if (pbMatch && pbMatch.player && pbMatch.player !== 'Member') {
          courtLine = `\n\n${targetCourt} - ${pbMatch.player}'s Booking\n`;
        } else {
          const rawCourtText = `${targetCourt.toUpperCase()} AVAILABLE`;
          const largeCourtText = rawCourtText.replace(/[A-Z0-9]/g, (ch) => {
            const code = ch.charCodeAt(0);
            if (code >= 48 && code <= 57) return String.fromCodePoint(0x1D7EC + (code - 48));
            if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D5D4 + (code - 65));
            return ch;
          });
          courtLine = `\n\n_${largeCourtText}_\n`;
        }
      } else if (effectiveCheckCourts && totalCourtsCount > 0) {
        const courtWord = totalCourtsCount === 1 ? 'COURT' : 'COURTS';
        const rawCourtText = `${totalCourtsCount} ${courtWord} AVAILABLE`;
        const largeCourtText = rawCourtText.replace(/[A-Z0-9]/g, (ch) => {
          const code = ch.charCodeAt(0);
          if (code >= 48 && code <= 57) return String.fromCodePoint(0x1D7EC + (code - 48));
          if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D5D4 + (code - 65));
          return ch;
        });
        courtLine = `\n\n_${largeCourtText}_\n`;
      }
    }
  } else {
    values = ['Yes', 'No'];

    const totalCourtsCount = prebookedCourts.length + freeCourts.length;
    if (targetCourt || (effectiveCheckCourts && totalCourtsCount > 0)) {
      if (targetCourt) {
        const pbMatch = prebookedCourts.find(pb => pb.court.toLowerCase() === targetCourt.toLowerCase());
        if (pbMatch && pbMatch.player && pbMatch.player !== 'Member') {
          courtLine = `\n\n${targetCourt} - ${pbMatch.player}'s Booking\n`;
        } else {
          const rawCourtText = `${targetCourt.toUpperCase()} AVAILABLE`;
          const largeCourtText = rawCourtText.replace(/[A-Z0-9]/g, (ch) => {
            const code = ch.charCodeAt(0);
            if (code >= 48 && code <= 57) return String.fromCodePoint(0x1D7EC + (code - 48));
            if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D5D4 + (code - 65));
            return ch;
          });
          courtLine = `\n\n_${largeCourtText}_\n`;
        }
      } else if (effectiveCheckCourts && totalCourtsCount > 0) {
        const courtWord = totalCourtsCount === 1 ? 'COURT' : 'COURTS';
        const rawCourtText = `${totalCourtsCount} ${courtWord} AVAILABLE`;
        const largeCourtText = rawCourtText.replace(/[A-Z0-9]/g, (ch) => {
          const code = ch.charCodeAt(0);
          if (code >= 48 && code <= 57) return String.fromCodePoint(0x1D7EC + (code - 48));
          if (code >= 65 && code <= 90) return String.fromCodePoint(0x1D5D4 + (code - 65));
          return ch;
        });
        courtLine = `\n\n_${largeCourtText}_\n`;
      }
    }
  }
  const timeLabel = resolvedWhen ? resolvedWhen : 'today';

  const hasPrebooked = Array.isArray(prebookedCourtPlayers) && prebookedCourtPlayers.length > 0 && includePrebookedSpots;
  if (isOptIn) {
    const creatorLabel = shouldIncludeCreator && creatorName ? `${creatorName}'s poll: ` : '';
    pollTitle = `🎾 ${creatorLabel}${timeLabel} (Vote Yes/No)${courtLine}`;
  } else {
    const slotCount = values.length;
    const slotLabel = slotCount === 1 ? '1 slot' : `${slotCount} slots`;
    const creatorLabel = (!isAuto && !hasPrebooked && (shouldIncludeCreator || leadingVirtualCount > 0) && creatorName) ? `${creatorName}'s poll: ` : '';
    pollTitle = `🎾 ${creatorLabel}${timeLabel} (${slotLabel} / ${validCount})${courtLine}`;
  }

  const sent = await sock.sendMessage(remoteJid, {
    poll: {
      name: pollTitle,
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
    name: pollTitle,
    options: values,
    size: isOptIn ? null : validCount,
    type: isOptIn ? 'opt_in' : 'fixed',
    when: resolvedWhen || null,
    playAt: playAt.toISOString(),
    createdAt: new Date().toISOString(),
    status: 'active', // 'active' | 'filled' | 'resolved' | 'cancelled' | 'stopped' | 'expired'
    isManual: false,
    isCommand: Boolean(isCommand),
    isAuto: Boolean(isAuto),
    isRecurring: Boolean(isRecurring),
    isAutoCreated: Boolean(isAuto || isRecurring),
    scheduleId: scheduleId || null,
    noMatchups: Boolean(noMatchups),
    checkCourts: Boolean(effectiveCheckCourts),
    court: targetCourt || null,
    prebookedCourts: (selectedPrebooked && selectedPrebooked.length > 0)
      ? selectedPrebooked.map(pb => ({ court: pb.court, player: pb.player }))
      : (targetCourt ? [{ court: targetCourt, player: creatorName || 'Member' }] : null),
    prebookedPlayers: hasPrebooked ? prebookedInfo : null,
    creator: (!isAuto && !hasPrebooked && (shouldIncludeCreator || leadingVirtualCount > 0)) ? { name: (creatorName || 'Player 1'), jid: creatorJid || null } : null,
    lastConflictSignature: null,
    voteBuffer: new Map(), // voterJid -> raw pollUpdate entry
    lastPlayers: null,
    sentReminders
  });
  latestPollIdByChat.set(remoteJid, pollId);
  persistPolls();

  // Fetch rating for prebooked players & creator if not seen before
  if (hasPrebooked) {
    for (const pb of prebookedInfo) {
      if (pb.defaultPlayer && !ratings.isPlaceholder(pb.defaultPlayer)) {
        ratings.ensureRated([pb.defaultPlayer]).catch(() => {});
      }
    }
  } else if (!isAuto && creatorName && !ratings.isPlaceholder(creatorName) && !GENERIC_NAMES.has(ratings.keyFor(creatorName))) {
    const creatorLid = creatorJid ? namesStore.resolveCanonicalId(creatorJid) : null;
    ratings.ensureRated([{
      name: creatorName,
      jid: creatorJid,
      lid: creatorLid && creatorLid.endsWith('@lid') ? creatorLid : null
    }]).catch(() => {});
  }
  console.log(`[poll] Created poll ${pollId} (${isOptIn ? 'Yes/No opt-in' : `${validCount} spots (given: ${size})`}, creator/virtual: ${leadingVirtualCount > 0 ? (creatorName || 'Player 1') : 'none'}) in ${remoteJid}${resolvedWhen ? ` (${resolvedWhen})` : ''}, play time ${playAt.toISOString()}`);

  return {
    err: null,
    isOptIn,
    size: isOptIn ? null : validCount,
    givenCount: size,
    votingSpotsCount: values.length,
    startIdx,
    leadingVirtualCount,
    when: resolvedWhen,
    includedCreator: shouldIncludeCreator,
    reason: excludedReason,
    replacedOldPoll,
    checkCourts: Boolean(effectiveCheckCourts)
  };
  } finally {
    inFlightPollCreations.delete(flightKey);
  }
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

  if (pollState.status === 'cancelled' || pollState.status === 'stopped') return; // don't process votes on cancelled or stopped polls

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
    const hasSelectedOptions = Array.isArray(votePayload?.selectedOptions) && votePayload.selectedOptions.length > 0;

    if (!hasSelectedOptions) {
      // User unvoted / deselected all options in poll
      pollState.voteBuffer.delete(canonicalVoter);
      if (voterNormalized) pollState.voteBuffer.delete(voterNormalized);
      if (voterPn) pollState.voteBuffer.delete(voterPn);
      if (voterLid) pollState.voteBuffer.delete(voterLid);
      console.log(`[poll] Voter ${nameFor(canonicalVoter)} (${canonicalVoter}) unvoted / removed selection from poll ${pollId}. Removed from voteBuffer.`);
    } else {
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
    } catch (e) { }

    // When all voting slots are filled and not already resolved, transition status to 'filled'
    if (pollState.status !== 'resolved' && pollState.status !== 'cancelled' && pollState.status !== 'stopped') {
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
    const noCount = noOption ? noOption.voters.length : 0;

    if (pollState.slotLimit) {
      const yesVoters = yesOption ? yesOption.voters.map(nameFor) : [];
      if (yesVoters.length > pollState.slotLimit) {
        const excessVoters = yesVoters.slice(pollState.slotLimit);
        const excessSig = excessVoters.join('|');
        if (pollState.lastExcessSignature !== excessSig) {
          const prevExcess = (pollState.lastExcessSignature || '').split('|').filter(Boolean);
          const newExcess = excessVoters.filter((p) => !prevExcess.includes(p));
          pollState.lastExcessSignature = excessSig;
          persistPolls();
          if (newExcess.length > 0) {
            const warnText = `⚠️ *Notice:* The slot limit for this match poll has been set to ${pollState.slotLimit} players and the poll is already filled! The Yes vote(s) from *${newExcess.join(', ')}* cross this limit and will not be considered.`;
            console.log(`[poll] Sending excess opt-in votes warning in ${pollState.remoteJid}: ${newExcess.join(', ')}`);
            await sock.sendMessage(pollState.remoteJid, { text: warnText });
          }
        }
      }
    }

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

  const conflicts = aggregated.filter((o) => o.voters.length > 1);
  const options = pollState.options || [];

  const { players, excessPlayers, filledCount, totalSlotsCount, isAllFilled } = resolveFixedPollRoster(pollState, aggregated);

  // If slotLimit is set and there are excess players crossing the limit, emit warning message to chat
  if (pollState.slotLimit && excessPlayers && excessPlayers.length > 0) {
    const excessSig = excessPlayers.join('|');
    if (pollState.lastExcessSignature !== excessSig) {
      const prevExcess = (pollState.lastExcessSignature || '').split('|').filter(Boolean);
      const newExcess = excessPlayers.filter((p) => !prevExcess.includes(p));
      pollState.lastExcessSignature = excessSig;
      persistPolls();
      if (newExcess.length > 0) {
        const warnText = `⚠️ *Notice:* The slot limit for this match poll has been set to ${pollState.slotLimit} players and the poll is already filled! The vote(s) from *${newExcess.join(', ')}* cross this limit and will not be considered.`;
        console.log(`[poll] Sending excess votes warning in ${pollState.remoteJid}: ${newExcess.join(', ')}`);
        await sock.sendMessage(pollState.remoteJid, { text: warnText });
      }
    }
  }

  console.log(
    `[poll] Poll ${pollId}: ${filledCount}/${totalSlotsCount} slot(s) filled (${pollState.size} players total), ` +
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

  if (pollState.status !== 'active' && pollState.status !== 'filled') return;

  if (isAllFilled) {

    // If created with no-matchups option, do NOT auto-create matchups.
    // Set status to 'filled' and wait for explicit matchup request (!matchups / @tenbot matchups).
    if (pollState.noMatchups) {
      if (pollState.status !== 'filled') {
        pollState.status = 'filled';
        pollState.lastPlayers = players;
        persistPolls();
        console.log(`[poll] Poll ${pollId} filled (${players.length} players: ${players.join(', ')}). Auto-matchup disabled; status set to filled; waiting for matchup request.`);
      }
      return;
    }

    // Auto-create matchups immediately after voting completes
    pollState.status = 'resolved';
    pollState.lastPlayers = players;
    persistPolls();

    console.log(`[poll] Poll ${pollId} filled -- auto-posting matchups for: ${players.join(', ')}`);

    await ratings.ensureRated(players);
    const prebookedCourts = await getPrebookedCourtsForPoll(pollState);
    const schedule = generateMatchups(players, { prebookedCourts, chatId: pollState.remoteJid });
    const whenHeader = formatMatchHeaderTime(pollState);
    const header = whenHeader ? `📅 ${whenHeader}\n\n` : '';
    await sock.sendMessage(pollState.remoteJid, { text: header + formatMatchups(schedule) });
    pairHistory.recordDraw(pollId, schedule, Date.now(), pollState.remoteJid);

    // Kept so "we won" reports can work out who the opponents were.
    pollState.lastSchedule = summarizeSchedule(schedule);
    persistPolls();
  } else if (pollState.status === 'filled') {
    pollState.status = 'active';
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
function extractFixedPairsFromText(text) {
  if (!text) return [];
  const pairs = [];
  const patterns = [
    /\b(?:keeping|keep|put|with)\s+([a-z0-9\s._'-]+?)\s+(?:and|&)\s+([a-z0-9\s._'-]+?)\s+(?:in|on)\s+(?:the\s+)?(?:same\s+)?team\b/i,
    /\b(?:keeping|keep|put|with)\s+([a-z0-9\s._'-]+?)\s+(?:and|&)\s+([a-z0-9\s._'-]+?)\s+together\b/i,
    /\b([a-z0-9\s._'-]+?)\s+(?:and|&)\s+([a-z0-9\s._'-]+?)\s+(?:in|on)\s+(?:the\s+)?(?:same\s+)?team\b/i,
    /\b([a-z0-9\s._'-]+?)\s+(?:and|&)\s+([a-z0-9\s._'-]+?)\s+as\s+partners\b/i,
    /\b(?:partner|pair)\s+([a-z0-9\s._'-]+?)\s+(?:and|&|with)\s+([a-z0-9\s._'-]+?)\b/i
  ];

  for (const pat of patterns) {
    const match = text.match(pat);
    if (match) {
      const p1 = match[1].trim();
      const p2 = match[2].trim();
      if (p1 && p2 && p1.toLowerCase() !== p2.toLowerCase()) {
        pairs.push([p1, p2]);
        break;
      }
    }
  }
  return pairs;
}

/**
 * Formats a clean, dynamic, timezone-accurate match header time string for matchup announcements
 * preventing stale relative words like "Tomorrow" when drawn on match day.
 */
function formatMatchHeaderTime(pollState) {
  if (!pollState) return '';
  if (!pollState.playAt) return pollState.when || '';

  const playAt = new Date(pollState.playAt);
  if (Number.isNaN(playAt.getTime())) return pollState.when || '';

  const playParts = getSanJoseParts(playAt);
  const nowParts = getSanJoseParts(getSanJoseNow());

  const timeFormatted = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(playAt).replace(/\s+/g, '').toLowerCase();

  const weekdayName = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    weekday: 'long'
  }).format(playAt);

  // If match day is today in San Jose:
  if (playParts.year === nowParts.year && playParts.month === nowParts.month && playParts.day === nowParts.day) {
    if (pollState.when && !/^(?:tomorrow|tonight)\b/i.test(pollState.when.trim())) {
      return pollState.when;
    }
    return `${weekdayName} ${timeFormatted}`;
  }

  // If match day is tomorrow in San Jose:
  const tomorrowTemp = new Date(Date.UTC(nowParts.year, nowParts.month, nowParts.day + 1));
  if (playParts.year === tomorrowTemp.getUTCFullYear() && playParts.month === tomorrowTemp.getUTCMonth() && playParts.day === tomorrowTemp.getUTCDate()) {
    if (pollState.when && !/^(?:today|tonight)\b/i.test(pollState.when.trim())) {
      return pollState.when;
    }
    return `Tomorrow ${timeFormatted} (${weekdayName})`;
  }

  if (pollState.when && !/^(?:today|tomorrow|tonight)\b/i.test(pollState.when.trim())) {
    return pollState.when;
  }
  return `${weekdayName} ${timeFormatted}`;
}

async function getPrebookedCourtsForPoll(pollState) {
  if (!pollState) return [];
  const courts = [];

  // 1. From pollState.prebookedCourts
  if (Array.isArray(pollState.prebookedCourts)) {
    for (const c of pollState.prebookedCourts) {
      const courtName = typeof c === "string" ? c : c?.court;
      if (courtName && !isIgnoredCourt(courtName)) {
        courts.push(typeof c === "string" ? { court: c } : c);
      }
    }
  }

  // 1b. From pollState.court
  if (pollState.court && !isIgnoredCourt(pollState.court)) {
    if (!courts.some(c => (c.court || c).toLowerCase() === pollState.court.toLowerCase())) {
      courts.push({ court: pollState.court, player: pollState.createdBy || pollState.creator?.name || 'Member' });
    }
  }

  // 2. From pollState.prebookedPlayers
  if (Array.isArray(pollState.prebookedPlayers)) {
    for (const pb of pollState.prebookedPlayers) {
      if (pb && pb.court && !isIgnoredCourt(pb.court)) {
        courts.push({
          court: pb.court,
          player: pb.defaultPlayer || pb.name || pb.fullName
        });
      }
    }
  }

  // 3. From pollState.name (court booking lines in poll title)
  if (pollState.name) {
    const bookingRegex = /(?:^|\n)\s*(Court\s*\d+|PB\s*\d+|Pickleball\s*\d+)\s*-\s*([^'\n]+?)(?:\'s)?\s*Booking/gi;
    let m;
    while ((m = bookingRegex.exec(pollState.name)) !== null) {
      if (isIgnoredCourt(m[1])) continue;
      courts.push({ court: m[1], player: m[2].trim() });
    }
  }

  // 4. If still empty, query SCVCC for match date & time if available
  if (courts.length === 0 && (pollState.playAt || pollState.when)) {
    try {
      const targetDateMDY = scvcc.resolveDateToMDY(pollState.when || pollState.playAt);
      let queryTime = null;
      if (pollState.playAt) {
        const sjParts = getSanJoseParts(new Date(pollState.playAt));
        const h = sjParts.hour === 0 ? 12 : (sjParts.hour > 12 ? sjParts.hour - 12 : sjParts.hour);
        const m = String(sjParts.minute).padStart(2, "0");
        const ampm = sjParts.hour >= 12 ? "pm" : "am";
        queryTime = `${h}:${m}${ampm}`;
      } else if (pollState.when) {
        const timeMatch = pollState.when.match(/\b(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm))\b/i) || pollState.when.match(/\b(\d{1,2}[:.]\d{2})\b/i);
        if (timeMatch) queryTime = timeMatch[1];
      }

      if (targetDateMDY && queryTime) {
        const bookingsRes = await scvcc.getCourtBookings({ when: targetDateMDY, time: queryTime, sport: "tennis", chatId });
        const seen = new Set();
        for (const b of bookingsRes?.bookings || []) {
          if (isIgnoredCourt(b.court)) continue;
          if (seen.has(b.court)) continue;
          const prebookedMatch = detectPrebookedCourt(b);
          if (prebookedMatch) {
            courts.push({ court: b.court, player: prebookedMatch.player });
            seen.add(b.court);
          }
        }
      }
    } catch (err) {
      console.warn("[poll] Error checking SCVCC bookings in getPrebookedCourtsForPoll:", err.message);
    }
  }

  // Deduplicate courts preserving order
  const unique = [];
  const seenCourts = new Set();
  for (const c of courts) {
    if (isIgnoredCourt(c.court)) continue;
    const key = (c.court || "").trim().toLowerCase();
    if (key && !seenCourts.has(key)) {
      seenCourts.add(key);
      unique.push(c);
    }
  }
  return unique;
}

async function generateMatchupsFromPoll(sock, chatId, specificPollId = null, specificPollName = null, options = {}) {
  const lookupChatId = (chatId && chatId.endsWith('@g.us')) ? chatId : (await getTargetGroupJid(sock) || chatId);
  let targetPollId = null;
  let targetPollState = null;

  // 1. If a specific poll ID was requested, check if it exists in this chat
  if (specificPollId && activePolls.has(specificPollId)) {
    const poll = activePolls.get(specificPollId);
    if (poll.remoteJid === lookupChatId && poll.status !== 'cancelled') {
      targetPollId = specificPollId;
      targetPollState = poll;
    }
  }

  const hasVotersOrPlayers = (p) => {
    if (Array.isArray(p.lastPlayers) && p.lastPlayers.length > 0) return true;
    if (p.voteBuffer && p.voteBuffer instanceof Map && p.voteBuffer.size > 0) return true;
    if (Array.isArray(p.prebookedPlayers) && p.prebookedPlayers.length > 0) return true;
    return false;
  };

  const allChatPolls = [...activePolls.entries()]
    .filter(([, p]) => p.remoteJid === lookupChatId && p.status !== 'cancelled');

  // 2. If a specific poll name / time keyword was requested, search for it (sorted latest first)
  if (!targetPollState && specificPollName) {
    const q = String(specificPollName).toLowerCase().trim();
    const matching = allChatPolls
      .filter(([, p]) => {
        const pName = (p.name || '').toLowerCase();
        const pWhen = (p.when || '').toLowerCase();
        return pName.includes(q) || pWhen.includes(q) || q.includes(pName);
      })
      .sort((a, b) => getPollPlayTime(b[1]) - getPollPlayTime(a[1]));

    if (matching.length > 0) {
      targetPollId = matching[0][0];
      targetPollState = matching[0][1];
    }
  }

  // 3. Look for active opt-in or manual match poll first (nearest upcoming first)
  if (!targetPollState) {
    const activeOptInOrManual = allChatPolls
      .filter(([, p]) => (p.status === 'active' || p.status === 'filled') && (p.type === 'opt_in' || p.size === null || p.isManual) && hasVotersOrPlayers(p))
      .sort((a, b) => getPollPlayTime(a[1]) - getPollPlayTime(b[1]));

    if (activeOptInOrManual.length > 0) {
      targetPollId = activeOptInOrManual[0][0];
      targetPollState = activeOptInOrManual[0][1];
    }
  }

  // 4. Look for any active/filled match poll with votes or prebooked players (nearest upcoming first)
  if (!targetPollState) {
    const activeWithVotes = allChatPolls
      .filter(([, p]) => (p.status === 'active' || p.status === 'filled') && hasVotersOrPlayers(p))
      .sort((a, b) => getPollPlayTime(a[1]) - getPollPlayTime(b[1]));

    if (activeWithVotes.length > 0) {
      targetPollId = activeWithVotes[0][0];
      targetPollState = activeWithVotes[0][1];
    }
  }

  // 5. Look for any match poll with players/votes (including resolved, for rematch or re-draw)
  // Sorted by scheduled play time DESCENDING so the latest/most recent match is picked
  if (!targetPollState) {
    const resolvedOrPast = allChatPolls
      .filter(([, p]) => hasVotersOrPlayers(p))
      .sort((a, b) => getPollPlayTime(b[1]) - getPollPlayTime(a[1]));

    if (resolvedOrPast.length > 0) {
      targetPollId = resolvedOrPast[0][0];
      targetPollState = resolvedOrPast[0][1];
    }
  }

  if (!targetPollState) {
    const pollId = latestPollIdByChat.get(lookupChatId);
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
  const isOptIn = targetPollState.type === 'opt_in' || targetPollState.size === null || targetPollState.options?.some((o) => /^yes$/i.test(o.trim()));
  if (interestedPlayers && interestedPlayers.length > 0) {
    players = interestedPlayers;
    if (isOptIn) {
      const deduplicated = [];
      for (const p of players) {
        if (!deduplicated.some((existing) => ratings.keyFor(existing) === ratings.keyFor(p))) {
          deduplicated.push(p);
        }
      }
      players = deduplicated;
    } else if (targetPollState.isManual) {
      const { players: adjustedPlayers, addedExtra } = resolveManualPollPlayers(targetPollState, players);
      if (addedExtra && addedExtra.length > 0) {
        console.log(`[poll] Adjusted manual poll players: added extra [${addedExtra.join(', ')}] -> total ${adjustedPlayers.length} player(s)`);
      }
      players = adjustedPlayers;
    } else {
      const { aggregated } = getPollVoters(targetPollId, targetPollState, mePn);
      const { players: rosterPlayers } = resolveFixedPollRoster(targetPollState, aggregated);
      if (rosterPlayers.length > 0) {
        players = rosterPlayers;
      }
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
  const prebookedCourts = (options && Array.isArray(options.prebookedCourts) && options.prebookedCourts.length > 0)
    ? options.prebookedCourts
    : await getPrebookedCourtsForPoll(targetPollState);
  const schedule = generateMatchups(players, { ...options, prebookedCourts, chatId });
  const whenHeader = formatMatchHeaderTime(targetPollState);
  const header = whenHeader ? `📅 ${whenHeader}\n\n` : '';
  await sock.sendMessage(chatId, { text: header + formatMatchups(schedule) });
  pairHistory.recordDraw(targetPollId, schedule, Date.now(), chatId);
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
 * Resolves the recurring schedule ID for a poll instance, inferring it from
 * recurringPolls if it was created before scheduleId was explicitly recorded.
 */
function getPollScheduleId(pollState) {
  if (!pollState) return null;
  if (pollState.scheduleId) return pollState.scheduleId;
  if (!pollState.isRecurring) return null;
  if (typeof recurringPolls !== 'undefined' && recurringPolls) {
    for (const [key, sched] of recurringPolls.entries()) {
      if (sched.remoteJid && pollState.remoteJid && sched.remoteJid === pollState.remoteJid) {
        return sched.id || sched.scheduleId || key;
      }
    }
    if (recurringPolls.size === 1) {
      const s = [...recurringPolls.values()][0];
      return s.id || s.scheduleId || [...recurringPolls.keys()][0];
    }
  }
  return null;
}

/**
 * Debug helper: reports what the bot has actually recorded for the current
 * active poll(s), straight from the raw vote buffer (not the aggregated tally),
 * so you can tell whether votes are being received at all.
 */
function pollStatusText(chatId = null, opts = {}) {
  const targetId = opts.targetId ? opts.targetId.trim() : null;
  const isDM = Boolean(chatId && !chatId.endsWith('@g.us'));
  let effectiveChatId = isDM ? (targetGroupJid || null) : chatId;
  let isAll = (!effectiveChatId && !targetId) || (!chatId && !targetId);
  const upcomingOnly = opts.upcomingOnly === true;
  const activeOnly = opts.activeOnly === true;
  const recurringOnly = opts.recurringOnly === true;
  const now = Date.now();

  let chatPolls = [...activePolls.entries()];

  let chatRecurring = [];
  if (typeof recurringPolls !== 'undefined' && recurringPolls) {
    if (effectiveChatId) {
      chatRecurring = [...recurringPolls.values()].filter((s) => s.remoteJid === effectiveChatId);
    }
    if (chatRecurring.length === 0 && (isDM || !chatId)) {
      chatRecurring = [...recurringPolls.values()];
    }
  }

  if (targetId) {
    const targetLower = targetId.toLowerCase();
    const matched = chatPolls.filter(([pollId, state]) => {
      if (chatId && chatId.endsWith('@g.us') && state.remoteJid !== chatId) return false;
      if (pollId.toLowerCase() === targetLower) return true;
      const sId = getPollScheduleId(state);
      if (sId && sId.toLowerCase() === targetLower) return true;
      return false;
    });

    if (matched.length > 0) {
      chatPolls = matched;
    } else {
      const globalMatched = [...activePolls.entries()].filter(([pollId, state]) => {
        if (pollId.toLowerCase() === targetLower) return true;
        const sId = getPollScheduleId(state);
        if (sId && sId.toLowerCase() === targetLower) return true;
        return false;
      });
      if (globalMatched.length > 0) {
        chatPolls = globalMatched;
      } else {
        let targetSched = null;
        if (typeof recurringPolls !== 'undefined' && recurringPolls) {
          for (const [key, sched] of recurringPolls.entries()) {
            const sid = sched.id || sched.scheduleId || key;
            if (key.toLowerCase() === targetLower || sid.toLowerCase() === targetLower) {
              targetSched = sched;
              break;
            }
          }
        }
        if (targetSched) {
          const sid = targetSched.id || targetSched.scheduleId || targetId;
          const daysStr = targetSched.daysDisplay || targetSched.days || 'unspecified days';
          const matchStr = targetSched.matchDisplay || targetSched.matchTime || 'unspecified time';
          const postStr = targetSched.postDisplay || targetSched.postTime || 'unspecified post time';
          const statusStr = targetSched.enabled === false ? 'PAUSED' : (targetSched.status ? targetSched.status.toUpperCase() : 'ACTIVE');
          return `ℹ️ Recurring schedule \`${sid}\` (${statusStr}) is configured for ${daysStr} at ${matchStr} (posts at ${postStr}), but there is no active poll instance currently on record in active polls.\nUse "!recurringpolls" to inspect all schedules or wait for the next scheduled trigger.`;
        }
        return `⚠️ No active poll instance or recurring schedule found matching "${targetId}". Use "!pollstatus" to view current polls or "!recurringpolls" for schedule IDs.`;
      }
    }
  } else if (!isAll) {
    if (effectiveChatId) {
      const filtered = chatPolls.filter(([, state]) => state.remoteJid === effectiveChatId);
      if (filtered.length > 0) {
        chatPolls = filtered;
      } else if (isDM) {
        isAll = true; // Fall back to showing all polls in DM so admin sees group polls
      } else {
        chatPolls = [];
      }
    }
  }

  if (recurringOnly) {
    chatPolls = chatPolls.filter(([, state]) => Boolean(state.scheduleId || state.isRecurring));
  } else if (activeOnly) {
    chatPolls = chatPolls.filter(([, state]) => state.status === 'active' || state.status === 'filled' || state.status === 'stopped');
  } else if (upcomingOnly) {
    chatPolls = chatPolls.filter(([, state]) => {
      if (state.status === 'cancelled') return false;
      if (!state.playAt) return true;
      const playAtMs = new Date(state.playAt).getTime();
      return Number.isNaN(playAtMs) || playAtMs > now;
    });
  }

  // Build recurring schedules & instances summary for the group
  let recurringSummary = '';
  if (chatRecurring.length > 0 && !targetId && !activeOnly && !upcomingOnly) {
    const schedLines = chatRecurring.map((s) => {
      const sid = s.id || s.scheduleId;
      const daysStr = s.daysDisplay || s.days || 'everyday';
      const matchStr = s.matchDisplay || s.matchTime || 'unspecified time';
      const postStr = s.postDisplay || s.postTime || 'unspecified post time';
      const statusStr = s.enabled === false ? 'PAUSED' : 'ACTIVE';
      const linkedPolls = [...activePolls.entries()].filter(([, p]) => (p.scheduleId === sid || getPollScheduleId(p) === sid));
      let instanceDesc = 'no active poll instance right now';
      if (linkedPolls.length > 0) {
        instanceDesc = linkedPolls.map(([id, p]) => `Poll \`${id}\` (${p.when || p.status}) — Status: ${p.status}`).join(', ');
      }
      return `• \`${sid}\` (${statusStr}): ${daysStr} at ${matchStr} (posts at ${postStr})\n  └ Current Instance: ${instanceDesc}`;
    });
    recurringSummary = `\n\n━━━━━━━━━━━━━━━━━━━━━\n🔁 *Recurring Poll Schedules & Created Instances:*\n${schedLines.join('\n')}`;
  }

  if (chatPolls.length === 0) {
    if (activeOnly) {
      return '🎾 No active, filled, or stopped match polls on record.';
    }
    if (upcomingOnly) {
      return '📅 No upcoming match polls on record whose play time has not passed yet.';
    }
    if (recurringOnly) {
      if (chatRecurring.length > 0) {
        return `🔁 No poll instances created from recurring schedules found on record.${recurringSummary}`;
      }
      return '🔁 No recurring poll schedules or instances on record.';
    }
    if (chatRecurring.length > 0) {
      return `No active ad-hoc match polls on record for this chat.${recurringSummary}`;
    }
    return isAll
      ? 'No polls on record in bot storage.'
      : 'No poll on record for this chat -- create one with "' + TRIGGER_PREFIX + ' create a poll".';
  }

  const mePn = jidNormalizedUser(botSock?.user?.id || botSock?.authState?.creds?.me?.id || '');

  const sections = chatPolls.map(([pollId, pollState]) => {
    let timeRemainingNote = '';
    if (pollState.playAt) {
      const playAtMs = new Date(pollState.playAt).getTime();
      if (!Number.isNaN(playAtMs)) {
        const diffMs = playAtMs - now;
        if (diffMs > 0) {
          const totalMins = Math.round(diffMs / (60 * 1000));
          const hrs = Math.floor(totalMins / 60);
          const mins = totalMins % 60;
          timeRemainingNote = ` (in ${hrs > 0 ? `${hrs}h ` : ''}${mins}m)`;
        } else {
          timeRemainingNote = ' (play time passed)';
        }
      }
    }
    let playAtLocal = 'unknown';
    if (pollState.playAt) {
      const playDate = new Date(pollState.playAt);
      if (!Number.isNaN(playDate.getTime())) {
        const sjFormatted = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/Los_Angeles',
          year: 'numeric',
          month: 'numeric',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          second: '2-digit',
          timeZoneName: 'short'
        }).format(playDate);
        playAtLocal = `${sjFormatted}${timeRemainingNote}`;
      }
    }

    const groupName = isAll
      ? (groupMetadataCache.get(pollState.remoteJid)?.subject || pollState.remoteJid)
      : null;
    const groupHeader = isAll ? `Chat/Group: ${groupName}\n` : '';
    const remindersStr = Array.isArray(pollState.sentReminders) && pollState.sentReminders.length > 0
      ? pollState.sentReminders.map((h) => h < 1 ? `${Math.round(h * 60)}m` : `${h}h`).join(', ')
      : '(none yet)';
    const isAutoPoll = isAutoCreatedPoll(pollState);
    const stoppedAfter2h = !pollState.isManual && (pollState.reminderCount || 0) >= 4 && (pollState.sentReminders || []).includes(2);
    const countStr = isAutoPoll
      ? `(${pollState.reminderCount || 0} sent${stoppedAfter2h ? " - stopped after 2h" : ""})`
      : `(${pollState.reminderCount || 0}/${MAX_POLL_REMINDERS} sent)`;
    const remindersLine = pollState.remindersPaused
      ? `Reminders: PAUSED (sent so far: [${remindersStr}] ${countStr})`
      : `Sent reminders: [${remindersStr}] ${countStr}`;

    const isOptIn = pollState.type === 'opt_in' || pollState.size === null || pollState.options?.some((o) => /^yes$/i.test(o.trim()));

    if (isOptIn) {
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
      } catch (e) { }

      const manualDesc = pollState.isManual ? ' (Passively tracked)' : '';
      const lines = [
        `${groupHeader}Poll ${pollId}${pollState.when ? ` (${pollState.when})` : ''}: Opt-in (Yes/No).`,
        getPollScheduleId(pollState) ? `🔄 Recurring Schedule: \`${getPollScheduleId(pollState)}\` (created as per schedule)` : (pollState.isRecurring ? '🔄 Recurring Schedule: (created as per schedule)' : null),
        pollState.creator?.name ? `Creator: ${pollState.creator.name}` : null,
        `Status: ${pollState.status}${manualDesc}`,
        `Play time: ${playAtLocal} (kept for 2 weeks after scheduled play time)`,
        remindersLine,
        `Yes votes (${yesVoters.length}): ${yesVoters.length ? yesVoters.join(', ') : '(none yet)'}`,
        `No votes (${noVoters.length}): ${noVoters.length ? noVoters.join(', ') : '(none yet)'}`,
        'Matchups: Waiting for user prompt (!matchups or "@tenbot generate matchups")'
      ];
      return lines.filter(Boolean).join('\n');
    }

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
        `${groupHeader}Poll ${pollId}: User-Created Manual Match Poll "${pollState.name || 'Match Poll'}".`,
        getPollScheduleId(pollState) ? `🔄 Recurring Schedule: \`${getPollScheduleId(pollState)}\` (created as per schedule)` : (pollState.isRecurring ? '🔄 Recurring Schedule: (created as per schedule)' : null),
        `Creator: ${creatorName}`,
        `Status: ${pollState.status} (Passively tracked)`,
        `Play time: ${playAtLocal} (when: "${pollState.when || 'unspecified'}")`,
        remindersLine,
        `Total votes buffered: ${pollState.voteBuffer.size}`,
        `Options & Votes:\n  ${optionSummaries.length ? optionSummaries.join('\n  ') : '(none)'}`,
        `Voted so far (${interestedPlayers.length}): ${interestedPlayers.length ? interestedPlayers.join(', ') : '(none yet)'}`,
        `Currently playing (${playingPlayers.length}): ${playingPlayers.join(', ')}${additionStr}`,
        'Matchups: Passively tracked -- will generate matchups only upon explicit user request (!matchups or "@tenbot generate matchups")'
      ];
      return lines.filter(Boolean).join('\n');
    }

    const { aggregated } = getPollVoters(pollId, pollState, mePn);
    const { players: currentPlayers, excessPlayers, filledCount, totalSlotsCount, naturalTotalSlots } = resolveFixedPollRoster(pollState, aggregated);
    const options = pollState.options || [];
    const firstSlotNum = getFirstSlotNumber(options);
    const hasPrebooked = Array.isArray(pollState.prebookedPlayers) && pollState.prebookedPlayers.length > 0;
    const leadingSpots = (firstSlotNum && firstSlotNum > 1) ? (firstSlotNum - 1) : (pollState.creator && !hasPrebooked ? 1 : 0);
    const creatorDesc = leadingSpots > 1
      ? `Creator: ${pollState.creator?.name || 'Creator'} (holding spots 1..${leadingSpots})`
      : (pollState.creator && !hasPrebooked ? `Creator (Player 1): ${pollState.creator.name || 'Player 1'}` : 'Creator: None (all spots open)');

    const prebookedNote = hasPrebooked
      ? ` (pre-booked: ${pollState.prebookedPlayers.map(p => typeof p === 'string' ? `${p}'s Spot` : p.slotName).join(', ')})`
      : '';

    const limitNote = pollState.slotLimit ? ` (limit: ${pollState.slotLimit} spots, original: ${pollState.originalSize || naturalTotalSlots})` : '';
    const excessLine = (excessPlayers && excessPlayers.length > 0) ? `⚠️ Excess votes not considered (${excessPlayers.length}): ${excessPlayers.join(', ')}` : null;

    const lines = [
      `${groupHeader}Poll ${pollId}${pollState.when ? ` (${pollState.when})` : ''}: ${pollState.size} spots (${pollState.size === 2 ? 'Singles' : 'Doubles'})${limitNote}.`,
      getPollScheduleId(pollState) ? `🔁 Recurring Schedule: \`${getPollScheduleId(pollState)}\` (created as per schedule)` : (pollState.isRecurring ? '🔁 Recurring Schedule: (created as per schedule)' : null),
      creatorDesc,
      `Status: ${pollState.status}`,
      `Play time: ${playAtLocal} (kept for 2 weeks after scheduled play time)`,
      remindersLine,
      `Slots filled: ${filledCount}/${totalSlotsCount}${prebookedNote}`,
      `Currently playing (${currentPlayers.length}): ${currentPlayers.join(', ')}`,
      excessLine
    ];
    return lines.filter(Boolean).join('\n');
  });

  return sections.join('\n\n---\n\n') + recurringSummary;
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

      const isOptIn = pollState.type === 'opt_in' || pollState.size === null || pollState.options?.some((o) => /^yes$/i.test(o.trim()));

      if (isOptIn) {
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
        } catch (e) { }

        if (pollState.status === 'cancelled') {
          return `[Poll ${id}] a Yes/No opt-in poll${whenSuffix} was cancelled`;
        } else {
          const creatorDesc = pollState.creator?.name ? ` (created by ${pollState.creator.name})` : '';
          const statusNote = pollState.status === 'resolved' ? 'status: resolved/drawn (can rematch)' : (pollState.status === 'stopped' ? 'status: stopped (voting stopped)' : (pollState.status === 'expired' ? 'status: expired (play time passed, can still generate matchups if requested)' : 'status: active'));
          return `[Poll ${id}] a Yes/No opt-in poll${whenSuffix}${creatorDesc} is tracked with ${yesCount} "Yes" vote(s) (${yesNames.join(', ') || 'none yet'}) and ${noCount} "No" vote(s). (${statusNote})`;
        }
      }

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
          const statusNote = pollState.status === 'resolved' ? 'status: resolved/drawn (can generate matchups again / rematch)' : (pollState.status === 'filled' ? 'status: filled (all voting slots filled, waiting for matchup request)' : (pollState.status === 'stopped' ? 'status: stopped (voting stopped, call generate_matchups when ready)' : (pollState.status === 'expired' ? 'status: expired (play time passed, can still generate matchups if requested)' : 'status: active')));
          return `[Poll ${id}] a user-created manual match poll "${pollState.name || 'Match Poll'}" (created by ${creatorName}) is tracked with ${interestedPlayers.length} vote(s): [${optionDetails.join('; ') || 'no votes yet'}]. Players currently in/playing (${playingPlayers.length}): ${playingPlayers.join(', ')}${additionSuffix}. (${statusNote} -- when asked to generate matchups or draw, call generate_matchups)`;
        }
      }

      const { aggregated } = getPollVoters(id, pollState, mePn);
      const { players: currentPlayers, filledCount, totalSlotsCount } = resolveFixedPollRoster(pollState, aggregated);
      const hasPrebooked = Array.isArray(pollState.prebookedPlayers) && pollState.prebookedPlayers.length > 0;
      const creatorSuffix = pollState.creator && !hasPrebooked ? ` (created by ${pollState.creator.name || 'Player 1'}, who is Player 1)` : ' (all spots open)';
      const prebookedSuffix = hasPrebooked
        ? ` (includes prebooked spots: ${pollState.prebookedPlayers.map(p => typeof p === 'string' ? `${p}'s Spot` : p.slotName).join(', ')})`
        : '';
      if (pollState.status === 'cancelled') {
        return `[Poll ${id}] a ${pollState.size}-spot poll${whenSuffix} was cancelled`;
      } else {
        const statusNote = pollState.status === 'resolved' ? 'status: resolved/drawn (can rematch)' : (pollState.status === 'filled' ? 'status: filled (all slots filled, waiting for matchup request)' : (pollState.status === 'stopped' ? 'status: stopped (voting stopped)' : (pollState.status === 'expired' ? 'status: expired (play time passed, can still generate matchups if requested)' : 'status: active')));
        return `[Poll ${id}] a ${pollState.size}-spot poll${whenSuffix}${creatorSuffix}${prebookedSuffix} is tracked with ${filledCount}/${totalSlotsCount} slots filled. Players currently in/playing (${currentPlayers.length}): ${currentPlayers.join(', ')}. (${statusNote})`;
      }
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
 * Calls the Anthropic API with tools, recent chat history, and live context.
 * Enables Claude to handle general questions and conversational queries with live group context.
 */
async function callClaude(sock, chatId, sender, promptText, msg) {
  const history = chatHistories.get(chatId) || [];

  const userMessage = { role: 'user', content: `${sender}: ${promptText}` };
  const messages = [...history, userMessage];

  const systemWithContext = `${SYSTEM_PROMPT}\n\n${buildContextBlurb(chatId)}`;

  const makeApiCall = async (msgs) => {
    return await anthropic.callAnthropicMessages({
      messages: msgs,
      system: systemWithContext,
      tools: CLAUDE_TOOLS,
      maxTokens: 400
    });
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

  const replyText = anthropic.extractTextFromResponse(data);

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
  // Watchdog heartbeat every 30 seconds to keep process alive and verify connection
  setInterval(() => {
    // Keeps the event loop actively referenced
  }, 30000);

  launchBot();
}

module.exports = {
  createMatchPoll,
  handleDirectPollCreation,
  handleMessage,
  resolveManualPollPlayers
};
