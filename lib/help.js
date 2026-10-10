/**
 * Help command and documentation for Tennis Group Bot.
 * Provides general command overview as well as detailed usage and examples
 * for specific commands when requested (e.g. `!help courts`, `!help poll`, `!help score`).
 */

const COMMAND_HELP = {
  bookings: {
    title: '📅 Court Bookings & Schedule (!courtbookings)',
    description: 'Retrieves active court bookings, reserved courts, match types, and player names at Silver Creek Valley Country Club (SCVCC).',
    usage: '!courtbookings [when] [time] [court] [pb] [player]',
    aliases: ['!courtbookings', '!bookings', '!courtreservations', '!reservations', '!courtschedule'],
    examples: [
      "!courtbookings — View today's court bookings",
      "!courtbookings tomorrow — Full booked court schedule for tomorrow",
      "!courtbookings tomorrow 6pm — Check booked courts tomorrow at 6:00 PM",
      "!courtbookings saturday morning — Bookings for Saturday morning",
      "!courtbookings Court 2 tomorrow — Bookings specifically on Court 2 tomorrow",
      "!courtbookings pb tomorrow — Pickleball court bookings tomorrow",
      "!courtbookings tomorrow for Pramod — Check when Pramod is booked to play tomorrow"
    ]
  },
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
    description: 'Creates a match scheduling WhatsApp poll for fixed spots (2, 4, 8, 12), auto-calculated spots based on SCVCC pre-booked & free courts, or Yes/No opt-in. By default, court availability is NOT checked unless --courts is specified.',
    usage: '!poll [size/auto] [when] [--courts] [--no-matchups] [prebooked-spots] (or @tenbot create a poll [for <N>/auto] [when])',
    aliases: ['!poll', '!createpoll', '!makepoll', '!newpoll', '!optinpoll', '!yesnopoll'],
    examples: [
      '!poll auto tomorrow 9am — Auto-calculates spots (4, 8, or 12) from SCVCC pre-booked & 90m free courts',
      '!poll 4 tomorrow 9am — 4-player doubles poll for tomorrow at 9:00 AM (default: does not check court availability)',
      '!poll 4 tomorrow 9am --courts — 4-player doubles poll considering SCVCC court availability',
      '!poll 2 today 6pm — 2-player singles poll',
      '!poll tomorrow 7pm — Yes/No opt-in poll (no player count specified)',
      '!poll 4 7pm --no-matchups — Fixed 4-spot poll without auto-generating matchups when filled',
      '!poll auto tomorrow 7pm prebooked-spots — Auto poll with named slots for booking players on prebooked courts',
      '@tenbot create a poll for auto on Saturday 9am — Auto poll for Saturday'
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
    title: '🗑️ Cancel & Clear Polls (!cancelpoll / !clearallpolls)',
    description: 'Cancels the active match poll and deletes the message from WhatsApp, or clears polls from bot memory.',
    usage: '!cancelpoll [pollId] | !clearallpolls',
    aliases: ['!cancelpoll', '!deletepoll', '!clearallpolls', '!clearpolls'],
    examples: [
      '!cancelpoll — Cancel active poll and delete from WhatsApp (creator or admin only)',
      '!clearallpolls — (Admin only) Clear all polls from bot state (keeps polls on WhatsApp)'
    ]
  },
  pollstatus: {
    title: '🔍 Poll Status & Debugging (!pollstatus)',
    description: 'Shows live vote counts, voter identities, and status of match polls and recurring poll instances.',
    usage: '!pollstatus [pollId/scheduleId/recurring] | !activepolls | !upcomingpolls | !allpolls | !cleanuppolls',
    aliases: ['!pollstatus', '!activepolls', '!upcomingpolls', '!allpolls', '!cleanuppolls', '!active', '!upcoming'],
    examples: [
      '!pollstatus — Show vote breakdown for active poll(s) in this chat',
      '!pollstatus rec_mujmt71n — Show the poll instance created from recurring schedule rec_mujmt71n',
      '!pollstatus recurring (or -r) — Filter status to polls created from recurring schedules',
      '!activepolls — List all active, filled, or stopped match polls across all groups',
      '!upcomingpolls — List match polls whose play time has not passed yet',
      '!allpolls — (Admin only) Show all polls in storage',
      '!cleanuppolls — (Admin only) Force cleanup sweep for expired polls'
    ]
  },
  setslots: {
    title: '🎯 Limit Poll Slots (!setslots)',
    description: 'Internally limits the number of player slots for an active match poll or recurring poll instance without deleting or modifying the WhatsApp poll message. If the new slot limit is reached, the poll is marked filled, and any votes crossing this limit will not be considered (a warning notification is automatically sent).',
    usage: '!setslots [pollId/scheduleId] <count/reset>',
    aliases: ['!setslots', '!limitslots', '!setpollslots', '!limitsize', '!setsize', '!pollslots'],
    examples: [
      '!setslots 8 — Set slot limit on the active poll to 8 spots (auto-selects if 1 active poll)',
      '!setslots rec_mujmt71n 8 — Set slot limit to 8 for the poll instance created from rec_mujmt71n',
      '!setslots 3EB05E96A2374C2FF716FE 4 — Set slot limit to 4 for specific poll ID',
      '!setslots rec_mujmt71n reset — Remove the slot limit and revert to original poll size'
    ]
  },
  modifyinstance: {
    title: '✏️ Modify Poll Instance (!modifyinstance)',
    description: 'Modifies a specific active match poll or recurring poll instance (e.g. changing spots, time, courts, or matchups). Deletes the older poll from WhatsApp and sends the updated poll. Leaves future recurring schedule templates intact.',
    usage: '!modifyinstance <scheduleId/pollId> [size/auto] [when] [--courts] [--no-matchups] [prebooked-spots]\n  (aliases: !modifypoll, !modifyrecurringinstance, !modifyrecurringpoll instance <id>)',
    aliases: ['!modifyinstance', '!modifyrecurringinstance', '!modifypoll', '!editpoll', '!updatepoll', '!editinstance', '!updateinstance'],
    examples: [
      '!modifyinstance rec_1 12 7:30pm — Modify active poll instance created from rec_1 to 12 spots at 7:30 PM',
      '!modifyinstance rec_1 auto 6pm — Modify active poll instance to auto spots at 6:00 PM',
      '!modifyinstance rec_1 opt-in — Modify active poll instance to Yes/No opt-in',
      '!modifyinstance rec_1 8 --no-matchups — Modify active poll instance to 8 spots with manual matchups',
      '!modifyinstance rec_1 --courts — Consider court availability for the active poll instance',
      '!modifypoll 3EB05E96A2374C2FF716FE 12 — Modify specific poll instance by its poll ID to 12 spots'
    ]
  },
  skipinstance: {
    title: '⏭️ Skip Recurring Poll Instance (!skipinstance)',
    description: 'Skips a single instance of a recurring match poll schedule (e.g. next upcoming instance or for a specific date/day) without pausing future schedules. If the poll instance was already created on WhatsApp, it is cancelled and deleted. Future instances will post automatically as scheduled.',
    usage: '!skipinstance [scheduleId] [day/date]\n  (aliases: !skiprecurringinstance, !skiprecurringpoll, !skiprecurring, !skippoll, !recurringpoll skip)',
    aliases: ['!skipinstance', '!skiprecurringinstance', '!skiprecurringpoll', '!skiprecurring', '!skippoll'],
    examples: [
      '!skipinstance rec_1 — Skip the next upcoming instance of schedule rec_1',
      '!skipinstance rec_1 wednesday — Skip the Wednesday instance of schedule rec_1',
      '!skipinstance rec_1 10/07 — Skip the instance for Oct 7 on schedule rec_1',
      '!skipinstance — Skip next instance of the chat\'s recurring schedule (if only 1 exists)',
      '!unskipinstance rec_1 — Restore the skipped instance of schedule rec_1'
    ]
  },
  unskipinstance: {
    title: '▶️ Restore Skipped Poll Instance (!unskipinstance)',
    description: 'Restores a previously skipped instance of a recurring match poll schedule so it will post automatically as scheduled.',
    usage: '!unskipinstance [scheduleId] [day/date]\n  (aliases: !unskiprecurringinstance, !unskiprecurringpoll, !unskiprecurring, !resumeskip, !recurringpoll unskip)',
    aliases: ['!unskipinstance', '!unskiprecurringinstance', '!unskiprecurringpoll', '!unskiprecurring', '!resumeskip'],
    examples: [
      '!unskipinstance rec_1 — Restore the skipped instance of schedule rec_1',
      '!unskipinstance rec_1 wednesday — Restore the skipped Wednesday instance of schedule rec_1'
    ]
  },
  recurringpoll: {
    title: '🔁 Recurring Daily Polls (!recurringpoll)',
    description: 'Schedules and manages automated match polls that are posted to the group on specific days of the week or everyday. Schedules can be paused or resumed by the creator or group admins. By default, court availability is NOT checked unless --courts is specified.',
    usage: '!recurringpoll [size/auto] <matchTime> [at <postTime>] [days] [--courts] [no-matchups] [prebooked-spots]\n  !modifyrecurringpoll <id> [size/auto] [matchTime] [at <postTime>] [days] [--courts] [no-matchups] [prebooked-spots]\n  !modifyinstance <id> [size/auto] [time] (modify current active poll instance)\n  !recurringpolls | !recurringpoll status <id>\n  !pauserecurringpoll [id/all] (or !recurringpoll pause [id])\n  !resumerecurringpoll [id/all] (or !recurringpoll resume [id])\n  !cancelrecurringpoll <id> | !clearallrecurringpolls',
    aliases: [
      '!recurringpoll', '!recurringpolls', '!schedulepoll', '!dailypoll',
      '!modifyrecurringpoll', '!editrecurringpoll', '!updaterecurringpoll', '!changerecurringpoll', '!modifyrecurring', '!editrecurring', '!updaterecurring',
      '!pauserecurringpoll', '!resumerecurringpoll', '!pauserecurring', '!resumerecurring', '!pauseallrecurring', '!resumeallrecurring',
      '!cancelrecurringpoll', '!clearallrecurringpolls'
    ],
    examples: [
      '!recurringpoll auto 7pm mon-thu — Auto poll (4, 8, or 12 spots based on courts) for 7:00 PM on Mon–Thu',
      '!recurringpoll 4 7pm mon-thu — 4-spot poll for 7:00 PM on Mon–Thu (posted at 8:00 AM, court check off by default)',
      '!recurringpoll 4 7pm mon-thu --courts — 4-spot poll considering SCVCC court availability',
      '!recurringpoll auto 7pm mon-thu prebooked-spots — Auto poll with prebooked court slots for Mon–Thu',
      '!recurringpoll 12 7pm at 8pm Mon-Thu no-matchups — 12-spot poll for Mon–Thu matches, posted evening before at 8pm',
      '!recurringpoll 4 7pm at 8am on weekdays — Post at 8am on weekdays for 7pm match',
      '!recurringpoll 4 9am on weekends — Post for 9am matches on Sat and Sun',
      '!recurringpoll opt-in 7pm mon, wed, fri — Opt-in Yes/No poll on Mon, Wed, Fri',
      '!modifyrecurringpoll rec_1 8 6pm at 7am mon-thu — Modify spots to 8, match time to 6pm, post time to 7am on Mon–Thu',
      '!modifyrecurringpoll rec_1 7:30pm — Update match time to 7:30 PM',
      '!modifyrecurringpoll rec_1 weekends — Update scheduled days to weekends',
      '!modifyrecurringpoll rec_1 prebooked-spots — Enable named slots for prebooked courts',
      '!modifyinstance rec_1 12 7:30pm — Modify current active instance of rec_1 (leaves future schedule unchanged)',
      '!recurringpolls — List all active recurring schedules',
      '!recurringpoll status rec_1 — Show recurring schedule details for rec_1',
      '!pauserecurringpoll rec_1 — Pause schedule rec_1 (or !recurringpoll pause rec_1)',
      '!resumerecurringpoll rec_1 — Resume schedule rec_1 (or !recurringpoll resume rec_1)',
      '!pauserecurringpoll all — (Admin only) Pause all recurring schedules in the chat',
      '!resumerecurringpoll all — (Admin only) Resume all recurring schedules in the chat',
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
  groups: {
    title: "👥 Group List & IDs (!groups)",
    description: "(DM only) Lists all WhatsApp groups the bot is currently a participating member of, showing their display names, WhatsApp JIDs/LIDs, member counts, and configuration status.",
    usage: "!groups",
    aliases: ["!groups", "!listgroups", "!mygroups", "!getgroups", "!allgroups"],
    examples: [
      "!groups — Show all participating WhatsApp groups with their names and JIDs"
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
  },
  help: {
    title: '❓ Help (!help)',
    description: 'Displays the command menu or detailed usage and examples for a specific command.',
    usage: '!help [command]',
    aliases: ['!help'],
    examples: [
      '!help — View overview of all available commands',
      '!help poll — Detailed help for creating match polls',
      '!help recurringpoll — Detailed help for recurring poll schedules',
      '!help courts — Detailed help for SCVCC court availability'
    ]
  }
};

const COMMAND_ALIAS_MAP = {
  bookings: 'bookings', courtbookings: 'bookings', booking: 'bookings', courtreservations: 'bookings', courtreservation: 'bookings', reservations: 'bookings', reservation: 'bookings', courtschedule: 'bookings',
  courts: 'courts', court: 'courts', courtstatus: 'courts', courtavailability: 'courts', courtavail: 'courts',
  poll: 'poll', createpoll: 'poll', makepoll: 'poll', newpoll: 'poll', optinpoll: 'poll', yesnopoll: 'poll', createoptinpoll: 'poll', createyesnopoll: 'poll',
  matchups: 'matchups', matchup: 'matchups', draw: 'matchups', rematch: 'matchups',
  free: 'free', notfree: 'free', clearfree: 'free', avail: 'free', availability: 'free',
  score: 'score', scores: 'score', result: 'score', results: 'score',
  leaderboard: 'leaderboard', standings: 'leaderboard',
  ratings: 'ratings', rating: 'ratings', setrating: 'ratings', myrating: 'ratings', resetrating: 'ratings', ratingreset: 'ratings', refreshratings: 'ratings',
  alias: 'alias', aliases: 'alias', addalias: 'alias', deletealias: 'alias', delalias: 'alias', removealias: 'alias', rmalias: 'alias',
  fullname: 'fullname', setfullname: 'fullname',
  stoppoll: 'stoppoll', closepoll: 'stoppoll', stop: 'stoppoll', close: 'stoppoll', resumepoll: 'stoppoll', reopenpoll: 'stoppoll', resume: 'stoppoll', reopen: 'stoppoll',
  remind: 'reminders', reminders: 'reminders', reminder: 'reminders', sendreminder: 'reminders', sendreminders: 'reminders', triggerreminder: 'reminders', remindpoll: 'reminders', pausereminder: 'reminders', pausereminders: 'reminders', resumereminder: 'reminders', resumereminders: 'reminders', silencereminders: 'reminders', unpausereminder: 'reminders', unpausereminders: 'reminders',
  cancelpoll: 'cancelpoll', deletepoll: 'cancelpoll', clearallpolls: 'cancelpoll', clearpolls: 'cancelpoll',
  pollstatus: 'pollstatus', activepolls: 'pollstatus', active: 'pollstatus', upcomingpolls: 'pollstatus', upcoming: 'pollstatus', allpolls: 'pollstatus', cleanuppolls: 'pollstatus', activepollstatus: 'pollstatus', upcomingpollstatus: 'pollstatus', allpollstatus: 'pollstatus', pollstatusall: 'pollstatus',
  setslots: 'setslots', limitslots: 'setslots', setpollslots: 'setslots', limitsize: 'setslots', setsize: 'setslots', pollslots: 'setslots',
  modifyinstance: 'modifyinstance', modifyrecurringinstance: 'modifyinstance', modifypoll: 'modifyinstance', editpoll: 'modifyinstance', updatepoll: 'modifyinstance', editinstance: 'modifyinstance', updateinstance: 'modifyinstance',
  skipinstance: 'skipinstance', skiprecurringinstance: 'skipinstance', skiprecurringpoll: 'skipinstance', skiprecurring: 'skipinstance', skippoll: 'skipinstance',
  unskipinstance: 'unskipinstance', unskiprecurringinstance: 'unskipinstance', unskiprecurringpoll: 'unskipinstance', unskiprecurring: 'unskipinstance', resumeskip: 'unskipinstance',
  recurringpoll: 'recurringpoll', recurringpolls: 'recurringpoll', schedulepoll: 'recurringpoll', scheduledpolls: 'recurringpoll', dailypoll: 'recurringpoll', dailypolls: 'recurringpoll', everydaypoll: 'recurringpoll', repeatingpoll: 'recurringpoll',
  modifyrecurringpoll: 'recurringpoll', editrecurringpoll: 'recurringpoll', updaterecurringpoll: 'recurringpoll', changerecurringpoll: 'recurringpoll', modifyrecurring: 'recurringpoll', editrecurring: 'recurringpoll', updaterecurring: 'recurringpoll',
  cancelrecurringpoll: 'recurringpoll', deleterecurringpoll: 'recurringpoll', removerecurringpoll: 'recurringpoll', clearrecurringpoll: 'recurringpoll', clearallrecurringpolls: 'recurringpoll', clearrecurringpolls: 'recurringpoll', cancelallrecurringpolls: 'recurringpoll', deleteallrecurringpolls: 'recurringpoll', removeallrecurringpolls: 'recurringpoll', clearallrecurring: 'recurringpoll', cancelallrecurring: 'recurringpoll',
  pauserecurringpoll: 'recurringpoll', stoprecurringpoll: 'recurringpoll', pauserecurring: 'recurringpoll', stoprecurring: 'recurringpoll', pauseallrecurring: 'recurringpoll', stopallrecurring: 'recurringpoll', pauserecurringpolls: 'recurringpoll', stoprecurringpolls: 'recurringpoll',
  resumerecurringpoll: 'recurringpoll', startrecurringpoll: 'recurringpoll', resumerecurring: 'recurringpoll', startrecurring: 'recurringpoll', resumeallrecurring: 'recurringpoll', startallrecurring: 'recurringpoll', resumerecurringpolls: 'recurringpoll', startrecurringpolls: 'recurringpoll',
  weather: 'weather', forecast: 'weather',
  certcheck: 'certcheck', certstatus: 'certcheck', suspendcert: 'certcheck', resumecert: 'certcheck', sslstatus: 'certcheck', suspendcertcheck: 'certcheck', resumecertcheck: 'certcheck',
  groups: 'groups', listgroups: 'groups', mygroups: 'groups', getgroups: 'groups', allgroups: 'groups', groupids: 'groups', grouplids: 'groups',
  reset: 'reset', ping: 'ping', help: 'help'
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
    '• `!courtbookings [when] [time] [court] [pb]` – View SCVCC court bookings & reservations',
    '',
    '🗳️ *Match Polls & Scheduling:*',
    '• `!poll [size/auto] [when] [--courts]` – Create match poll (fixed spots or Yes/No; use --courts to consider court availability)',
    '• `!matchups` (or `!draw`, `!rematch`) – Generate pairings and rotations',
    '• `!stoppoll` / `!resumepoll` – Stop or resume voting and reminders',
    '• `!pausereminders` / `!resumereminders` / `!remind` – Manage match reminders',
    '• `!cancelpoll` / `!clearallpolls` – Cancel active poll or clear bot memory',
    '• `!setslots [id] <count>` – Internally limit poll spots without modifying WhatsApp poll',
    '• `!pollstatus [id]` / `!activepolls` / `!upcomingpolls` – View poll status & voters',
    '',
    '🔁 *Recurring Daily Polls:*',
    '• `!recurringpoll [size] <matchTime> [at <postTime>] [days]` – Schedule daily poll',
    '• `!modifyrecurringpoll <id> [size] [matchTime] [at <postTime>] [days]` – Modify recurring schedule template',
    '• `!modifyinstance <id> [size] [time]` – Modify a specific active poll instance (leaves future schedule intact)',
    '• `!skipinstance [id] [day/date]` – Skip an instance of a recurring poll without pausing schedule',
    '• `!pauserecurringpoll [id/all]` / `!resumerecurringpoll [id/all]` – Pause or resume automated poll posting',
    '• `!recurringpolls` / `!recurringpoll status <id>` – List schedules or view schedule status',
    '• `!cancelrecurringpoll <id>` / `!clearallrecurringpolls` – Cancel recurring schedules',
    '',
    '🙋 *Availability & Matches:*',
    '• `!free <when>` / `!notfree` / `!clearfree` – Mark availability / view who is free',
    '• `!score <winner> def <loser> <score>` – Record match result & update ratings',
    '• `!leaderboard` – Show win/loss standings',
    '',
    '📊 *Ratings & Profile:*',
    '• `!ratings` – Show player ratings used for balanced matches',
    '• `!setrating <rating>` – Update rating (2.5–4.5 scale)',
    '• `!resetrating [player]` – Reset rating to baseline TennisRecord rating',
    '• `!refreshratings` – (Admin only) Force refresh ratings from TennisRecord',
    '• `!fullname <full name>` – Set real name & fetch TennisRecord rating',
    '• `!alias <alias>` / `!aliases` / `!deletealias` – Manage player aliases',
    '',
    '🌤️ *Utility & Maintenance:*',
    '• `!weather [location]` – Forecast for outdoor tennis play',
    '• `!ping` – Check bot connectivity',
    '• `!groups` – (DM only) List names and JIDs of all WhatsApp groups the bot is in',
    '• `!reset` – (Admin only) Clear conversation memory & recent logs',
    '• `!certstatus` / `!suspendcert` / `!resumecert` – (Admin only) Manage SSL cert verification',
    '',
    '💡 *Tip:* Send `!help <command>` (e.g. `!help courts`, `!help poll`, `!help recurringpoll`, `!help score`) for detailed usage and examples.'
  ].join('\n');
}

module.exports = {
  helpText,
  COMMAND_HELP,
  COMMAND_ALIAS_MAP
};
