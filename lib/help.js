/**
 * Help command and documentation for Tennis Group Bot.
 * Provides general command overview as well as detailed usage and examples
 * for specific commands when requested (e.g. `!help courts`, `!help poll`, `!help score`).
 */

const COMMAND_HELP = {
  courts: {
    title: '🎾 Court Availability (!courts)',
    description: 'Checks real-time tennis (Courts 1–6) and pickleball court availability and open slot durations at Silver Creek Valley Country Club (SCVCC).',
    usage: '!courts [when] [time] [court] [pb]',
    aliases: ['!courts', '!courtstatus', '!courtavailability', '!courtavail'],
    examples: [
      "!courts — View today's available court times",
      "!courts tomorrow — Full schedule for tomorrow",
      "!courts 6pm — Check 6:00 PM availability today",
      "!courts tomorrow 5pm — Check 5:00 PM availability tomorrow",
      "!courts saturday morning Court 2 — Check Court 2 on Saturday morning",
      "!courts pb tomorrow — Check Pickleball courts tomorrow",
      "!courts evening — Filter evening slots (5:00 PM onwards)"
    ]
  },
  poll: {
    title: '📋 Create Match Poll (!poll)',
    description: 'Creates a match scheduling WhatsApp poll for singles (2 spots), doubles (4, 8, 12 spots), or Yes/No opt-in.',
    usage: '!poll [size] [when] [--no-matchups] (or @tenbot create a poll [for <N>] [when])',
    aliases: ['!poll', '!createpoll', '!makepoll', '!newpoll', '!optinpoll', '!yesnopoll'],
    examples: [
      '!poll 4 tomorrow 9am — 4-player doubles poll for tomorrow at 9:00 AM (Player 1 is creator, voting for Players 2..4)',
      '!poll 2 today 6pm — 2-player singles poll',
      '!poll tomorrow 7pm — Yes/No opt-in poll (no player count specified)',
      '!poll 4 7pm --no-matchups — Fixed 4-spot poll without auto-generating matchups when filled',
      '@tenbot create a poll for 8 on Saturday 9am — 8-player doubles poll'
    ]
  },
  matchups: {
    title: '⚖️ Matchups & Rotations (!matchups)',
    description: 'Generates balanced singles/doubles pairings and rotations from current active or filled match poll votes using player ratings.',
    usage: '!matchups [pollName/time] (or !draw, !rematch)',
    aliases: ['!matchups', '!draw', '!rematch'],
    examples: [
      '!matchups — Generate matchups from the most recent active or filled poll',
      '!matchups 9am — Generate matchups specifically for the 9:00 AM poll',
      '!draw — Alias for !matchups',
      '!rematch — Re-shuffle and generate new rotations from existing players'
    ]
  },
  free: {
    title: '🙋 Player Availability (!free)',
    description: 'Tracks who is available to play tennis and when.',
    usage: '!free [when] | !notfree | !clearfree',
    aliases: ['!free', '!notfree', '!clearfree'],
    examples: [
      '!free Sat 9am — Mark yourself available for Saturday at 9:00 AM',
      '!free tomorrow evening — Mark yourself free tomorrow evening',
      '!free — View the list of who is currently free and when',
      '!notfree — Remove yourself from the availability list',
      '!clearfree — (Admin only) Clear the entire availability list'
    ]
  },
  score: {
    title: '🏆 Match Score Reporting (!score)',
    description: 'Records match results, updates player ratings dynamically, and updates the leaderboard.',
    usage: '!score <winner> def <loser> <score>',
    aliases: ['!score', '!leaderboard'],
    examples: [
      '!score Mike def John 6-4 6-2 — Singles match result',
      '!score Mike & Sara def John & Alex 6-4 7-5 — Doubles match result',
      '@tenbot Mike & Sara beat John & Alex 6-4 — Free-form report in words',
      '@tenbot we won — Record win for your team after a drawn matchup (defaults to 6-3)',
      '!leaderboard — View current win/loss standings'
    ]
  },
  leaderboard: {
    title: '🏅 Leaderboard (!leaderboard)',
    description: 'Displays the group win/loss standings from recorded match results.',
    usage: '!leaderboard',
    aliases: ['!leaderboard'],
    examples: [
      '!leaderboard — View player win/loss leaderboard'
    ]
  },
  ratings: {
    title: '📊 Player Ratings (!ratings)',
    description: 'Manages skill ratings (2.5 to 4.5 scale) used to create balanced matchups.',
    usage: '!ratings | !setrating <rating> | !resetrating [player] | !refreshratings',
    aliases: ['!ratings', '!setrating', '!myrating', '!resetrating', '!ratingreset', '!refreshratings'],
    examples: [
      '!ratings — View all player ratings in descending order',
      '!setrating 4.0 (or @tenbot my rating is 4.0) — Update your own rating',
      "!setrating John = 3.75 — (Admin only) Update another player's rating",
      '!resetrating (or @tenbot reset my rating) — Reset your rating to baseline TennisRecord rating',
      "!resetrating John — (Admin only) Reset another player's rating",
      '!refreshratings — (Admin only) Refresh player ratings from TennisRecord.com'
    ]
  },
  alias: {
    title: '🏷️ Player Aliases (!alias)',
    description: 'Manages player nicknames and aliases so the bot recognizes players under different names.',
    usage: '!alias <alias> | !alias <name> = <alias> | !deletealias <alias> | !aliases',
    aliases: ['!alias', '!addalias', '!deletealias', '!delalias', '!removealias', '!aliases'],
    examples: [
      '!alias PK — Add alias "PK" for yourself',
      '!alias Jonathan Doe = JD — (Admin only for others) Add alias "JD" for Jonathan Doe',
      '!deletealias PK — Remove alias "PK"',
      '!aliases — List all registered players and their aliases'
    ]
  },
  fullname: {
    title: '👤 Full Name & TennisRecord Sync (!fullname)',
    description: "Sets a player's full name and automatically fetches their baseline rating from TennisRecord.com.",
    usage: '!fullname <full name> (or !setfullname <player> = <full name>)',
    aliases: ['!fullname', '!setfullname'],
    examples: [
      '!fullname Roger Federer — Set your full name to Roger Federer',
      '!setfullname John = Johnathan Smith — (Admin only) Set full name for John'
    ]
  },
  stoppoll: {
    title: '🛑 Stop & Resume Poll (!stoppoll / !resumepoll)',
    description: 'Stops or resumes voting and reminders on a match poll without deleting the poll message.',
    usage: '!stoppoll [pollId] | !resumepoll [pollId]',
    aliases: ['!stoppoll', '!closepoll', '!resumepoll', '!reopenpoll', '!stop', '!resume'],
    examples: [
      '!stoppoll — Stop voting on the active poll (creator or admin only)',
      '!resumepoll — Reopen voting on the stopped poll (creator or admin only)'
    ]
  },
  reminders: {
    title: '⏰ Match Reminders (!remind / !pausereminders)',
    description: 'Manages automated upcoming match reminder notifications (sent at 64h, 32h, 16h, 8h, 4h, 2h, 1h before playtime).',
    usage: '!pausereminders [pollId] | !resumereminders [pollId] | !remind [pollId]',
    aliases: ['!pausereminders', '!pausereminder', '!resumereminders', '!resumereminder', '!remind', '!sendreminder', '!triggerreminder'],
    examples: [
      '!pausereminders — Pause reminders for active match poll(s)',
      '!resumereminders — Resume reminders for active match poll(s)',
      '!remind — Manually trigger an immediate reminder notification for active poll(s)'
    ]
  },
  cancelpoll: {
    title: '🗑️ Cancel Poll (!cancelpoll)',
    description: 'Cancels the active match poll and deletes the poll message directly from WhatsApp.',
    usage: '!cancelpoll [pollId] (or @tenbot cancel poll)',
    aliases: ['!cancelpoll', '!deletepoll'],
    examples: [
      '!cancelpoll — Cancel the active poll and delete from WhatsApp (creator or admin only)'
    ]
  },
  pollstatus: {
    title: '🔍 Poll Status & Debugging (!pollstatus)',
    description: 'Shows live vote counts, voter identities, and internal status of match polls.',
    usage: '!pollstatus | !activepolls | !upcomingpolls | !allpolls | !cleanuppolls',
    aliases: ['!pollstatus', '!activepolls', '!upcomingpolls', '!allpolls', '!cleanuppolls', '!active', '!upcoming'],
    examples: [
      '!pollstatus — Show vote breakdown for active poll(s) in this chat',
      '!activepolls — List active, filled, or stopped match polls',
      '!upcomingpolls — List match polls whose play time has not passed yet',
      '!allpolls — (Admin only) Show all polls in storage',
      '!cleanuppolls — (Admin only) Force cleanup sweep for expired polls'
    ]
  },
  recurringpoll: {
    title: '🔁 Recurring Daily Polls (!recurringpoll)',
    description: 'Schedules and manages automated match polls that are posted to the group on specific days of the week or everyday.',
    usage: '!recurringpoll [size] <matchTime> [at <postTime>] [days] [no-matchups]\n  !modifyrecurringpoll <id> [size] [matchTime] [at <postTime>] [days] [no-matchups]\n  !recurringpolls | !pauserecurringpoll <id> | !resumerecurringpoll <id> | !cancelrecurringpoll <id>',
    aliases: [
      '!recurringpoll', '!recurringpolls', '!schedulepoll', '!dailypoll',
      '!modifyrecurringpoll', '!editrecurringpoll', '!updaterecurringpoll', '!changerecurringpoll', '!modifyrecurring', '!editrecurring', '!updaterecurring',
      '!cancelrecurringpoll', '!pauserecurringpoll', '!resumerecurringpoll', '!clearallrecurringpolls'
    ],
    examples: [
      '!recurringpoll 4 7pm mon-thu — 4-spot poll for 7:00 PM on Mon–Thu (posted at 8:00 AM)',
      '!recurringpoll 12 7pm at 8pm Mon-Thu no-matchups — 12-spot poll for Mon–Thu matches, posted evening before at 8pm',
      '!recurringpoll 4 7pm at 8am on weekdays — Post at 8am on weekdays for 7pm match',
      '!recurringpoll 4 9am on weekends — Post for 9am matches on Sat and Sun',
      '!recurringpoll opt-in 7pm mon, wed, fri — Opt-in Yes/No poll on Mon, Wed, Fri',
      '!modifyrecurringpoll rec_1 8 6pm at 7am mon-thu — Modify spots to 8, match time to 6pm, post time to 7am on Mon–Thu',
      '!modifyrecurringpoll rec_1 7:30pm — Update match time to 7:30 PM',
      '!modifyrecurringpoll rec_1 weekends — Update scheduled days to weekends',
      '!recurringpolls — List all active recurring schedules',
      '!pauserecurringpoll rec_1 — Pause schedule rec_1',
      '!resumerecurringpoll rec_1 — Resume schedule rec_1',
      '!cancelrecurringpoll rec_1 — Cancel schedule rec_1 (creator or admin only)',
      '!clearallrecurringpolls — (Admin only) Clear all recurring schedules'
    ]
  },
  weather: {
    title: '☀️ Weather Forecast (!weather)',
    description: 'Checks the 3-day weather and outdoor tennis playability forecast.',
    usage: '!weather [location]',
    aliases: ['!weather'],
    examples: [
      '!weather — Check forecast for San Jose, CA (default location)',
      '!weather Sunnyvale — Check forecast for Sunnyvale, CA',
      '!weather San Francisco — Check forecast for San Francisco'
    ]
  },
  certcheck: {
    title: '🔒 SSL Certificate Verification (!certstatus)',
    description: '(Admin only) Manages TennisRecord.com SSL certificate validation settings.',
    usage: '!certstatus | !suspendcert | !resumecert',
    aliases: ['!certstatus', '!certcheck', '!suspendcert', '!resumecert', '!sslstatus'],
    examples: [
      '!certstatus — Check current SSL verification status',
      '!suspendcert — (Admin only) Suspend certificate verification (allow expired SSL certs)',
      '!resumecert — (Admin only) Resume strict SSL certificate validation'
    ]
  },
  reset: {
    title: '🔄 Reset Bot Memory (!reset)',
    description: '(Admin only) Clears bot conversation memory and recent 2-week group message logs.',
    usage: '!reset',
    aliases: ['!reset'],
    examples: ['!reset']
  },
  ping: {
    title: '🏓 Ping (!ping)',
    description: 'Checks bot connectivity and responsiveness.',
    usage: '!ping',
    aliases: ['!ping'],
    examples: ['!ping — Replies with "pong 🏓"']
  }
};

const COMMAND_ALIAS_MAP = {
  courts: 'courts', court: 'courts', courtstatus: 'courts', courtavailability: 'courts', courtavail: 'courts',
  poll: 'poll', createpoll: 'poll', makepoll: 'poll', newpoll: 'poll', optinpoll: 'poll', yesnopoll: 'poll',
  createoptinpoll: 'poll', createyesnopoll: 'poll',
  matchups: 'matchups', matchup: 'matchups', draw: 'matchups', rematch: 'matchups',
  free: 'free', notfree: 'free', clearfree: 'free', avail: 'free', availability: 'free',
  score: 'score', scores: 'score', result: 'score', results: 'score',
  leaderboard: 'leaderboard', standings: 'leaderboard',
  ratings: 'ratings', rating: 'ratings', setrating: 'ratings', myrating: 'ratings', resetrating: 'ratings', ratingreset: 'ratings', refreshratings: 'ratings',
  alias: 'alias', aliases: 'alias', addalias: 'alias', deletealias: 'alias', delalias: 'alias', removealias: 'alias',
  fullname: 'fullname', setfullname: 'fullname',
  stoppoll: 'stoppoll', closepoll: 'stoppoll', stop: 'stoppoll', close: 'stoppoll', resumepoll: 'stoppoll', reopenpoll: 'stoppoll', resume: 'stoppoll', reopen: 'stoppoll',
  remind: 'reminders', reminders: 'reminders', reminder: 'reminders', sendreminder: 'reminders', sendreminders: 'reminders', triggerreminder: 'reminders', remindpoll: 'reminders', pausereminder: 'reminders', pausereminders: 'reminders', resumereminder: 'reminders', resumereminders: 'reminders', silencereminders: 'reminders',
  cancelpoll: 'cancelpoll', deletepoll: 'cancelpoll', clearallpolls: 'cancelpoll', clearpolls: 'cancelpoll',
  pollstatus: 'pollstatus', activepolls: 'pollstatus', active: 'pollstatus', upcomingpolls: 'pollstatus', upcoming: 'pollstatus', allpolls: 'pollstatus', cleanuppolls: 'pollstatus',
  recurringpoll: 'recurringpoll', recurringpolls: 'recurringpoll', schedulepoll: 'recurringpoll', dailypoll: 'recurringpoll', everydaypoll: 'recurringpoll',
  modifyrecurringpoll: 'recurringpoll', editrecurringpoll: 'recurringpoll', updaterecurringpoll: 'recurringpoll', changerecurringpoll: 'recurringpoll', modifyrecurring: 'recurringpoll', editrecurring: 'recurringpoll', updaterecurring: 'recurringpoll',
  cancelrecurringpoll: 'recurringpoll', pauserecurringpoll: 'recurringpoll', resumerecurringpoll: 'recurringpoll', clearallrecurringpolls: 'recurringpoll',
  weather: 'weather', forecast: 'weather',
  certcheck: 'certcheck', certstatus: 'certcheck', suspendcert: 'certcheck', resumecert: 'certcheck', sslstatus: 'certcheck',
  reset: 'reset', ping: 'ping'
};

function formatCommandHelp(topicKey) {
  const item = COMMAND_HELP[topicKey];
  if (!item) return null;

  const lines = [
    item.title,
    '─'.repeat(30),
    `📖 ${item.description}`,
    '',
    `⚙️ *Usage:*\n  ${item.usage}`,
    '',
    `🔀 *Aliases:* ${item.aliases.join(', ')}`,
    '',
    `💡 *Examples:*`,
    ...item.examples.map(ex => `  • ${ex}`)
  ];
  return lines.join('\n');
}

function helpText(specificCmd = null) {
  if (specificCmd) {
    const cleanCmd = specificCmd.trim().replace(/^!/, '').toLowerCase();
    const topicKey = COMMAND_ALIAS_MAP[cleanCmd];
    if (topicKey && COMMAND_HELP[topicKey]) {
      return formatCommandHelp(topicKey);
    }
    return `⚠️ Unknown command "!${cleanCmd}". Send "!help" to view all available commands.`;
  }

  return [
    '📋 *Tennis Group Bot Commands:*',
    '',
    '🎾 *Courts & Club:*',
    '• `!courts [when] [time] [court] [pb]` – Check SCVCC court availability',
    '',
    '🗳️ *Match Polls & Scheduling:*',
    '• `!poll [size] [when] [--no-matchups]` – Create match poll (fixed spots or Yes/No)',
    '• `!matchups` (or `!draw`, `!rematch`) – Generate pairings and rotations',
    '• `!stoppoll` / `!resumepoll` – Stop or resume voting and reminders',
    '• `!pausereminders` / `!resumereminders` / `!remind` – Manage match reminders',
    '• `!cancelpoll` – Cancel and delete active poll from WhatsApp',
    '• `!pollstatus` / `!activepolls` / `!upcomingpolls` – View poll status & voters',
    '',
    '🔁 *Recurring Daily Polls:*',
    '• `!recurringpoll [size] <matchTime> [at <postTime>] [days]` – Schedule daily poll',
    '• `!modifyrecurringpoll <id> [size] [matchTime] [at <postTime>] [days]` – Modify schedule',
    '• `!recurringpolls` – List all active recurring schedules',
    '• `!cancelrecurringpoll <id>` – Cancel a recurring schedule',
    '',
    '🙋 *Availability & Matches:*',
    '• `!free <when>` / `!notfree` – Mark availability / view who is free',
    '• `!score <winner> def <loser> <score>` – Record match result & update ratings',
    '• `!leaderboard` – Show win/loss standings',
    '',
    '📊 *Ratings & Profile:*',
    '• `!ratings` – Show player ratings used for balanced matches',
    '• `!setrating <rating>` – Update rating (2.5–4.5 scale)',
    '• `!resetrating [player]` – Reset rating to baseline TennisRecord rating',
    '• `!fullname <full name>` – Set real name & fetch TennisRecord rating',
    '• `!alias <alias>` / `!aliases` – Add nickname/alias or list aliases',
    '',
    '🌤️ *Utility & General:*',
    '• `!weather [location]` – Forecast for outdoor tennis play',
    '• `!ping` – Check bot connectivity',
    '',
    '💡 *Tip:* Send `!help <command>` (e.g. `!help courts`, `!help poll`, `!help recurringpoll`, `!help score`) for detailed usage and examples.'
  ].join('\n');
}

module.exports = {
  helpText,
  COMMAND_HELP,
  COMMAND_ALIAS_MAP
};
