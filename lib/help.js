/**
 * Help command and documentation for Tennis Group Bot.
 * Provides general command overview as well as detailed usage, options, and examples
 * for specific commands when requested (e.g. `!help courts`, `!help poll`, `!help score`).
 */

const COMMAND_HELP = {
  bookings: {
    title: '📅 Court Bookings & Schedule (!courtbookings)',
    description: 'Retrieves active court bookings, reserved courts, match types, and player names at Silver Creek Valley Country Club (SCVCC).',
    usage: '!courtbookings [when] [time] [court] [pb] [player]',
    options: [
      '`[when]` — Date or day of the week to inspect bookings for (e.g. "today", "tomorrow", "saturday", "10/25"; defaults to today)',
      '`[time]` — Filter bookings by start time or period of day (e.g. "6pm", "9:30am", "morning", "afternoon", "evening")',
      '`[court]` — Filter bookings to a specific court (e.g. "Court 2", "Court 4")',
      '`[pb]` — Check pickleball court bookings instead of tennis courts',
      '`[player]` — Filter bookings by member or player name (e.g. "for Pramod")'
    ],
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
  bookcourt: {
    title: '🎾 Book Court (!bookcourt / !reservecourt)',
    description: 'Books a tennis or pickleball court at Silver Creek Valley Country Club (SCVCC) directly for a given date, time, duration, and players using club member credentials.',
    usage: '!bookcourt [Court <N>] <time> [when] [singles/doubles] [duration] [pb] [for <requester>] [with <players>]',
    options: [
      '`<time>` — Booking start time (e.g. "9am", "6:30pm", "18:00")',
      '`[Court <N>]` — Specific court to book (e.g. "Court 2", "Court 4"; defaults to first available court)',
      '`[when]` — Reservation date or day (e.g. "today", "tomorrow", "10/25/2026"; defaults to today)',
      '`[singles/doubles]` — Match format: "singles" (2 players) or "doubles" (4 players; default)',
      '`[duration]` — Length of booking (e.g. "60min", "90min", "120min"; defaults to 90 minutes)',
      '`[pb]` — Book a pickleball court instead of a tennis court',
      '`[for <requester>]` — Club member account whose credentials are used to make the booking',
      '`[with <players>]` — Comma-separated list of teammates to include on the reservation'
    ],
    aliases: ['!bookcourt', '!reservecourt', '!book', '!reserve'],
    examples: [
      '!bookcourt Court 2 9am tomorrow — Book Court 2 tomorrow at 9:00 AM',
      '!bookcourt 6pm tomorrow with Alice, Bob — Book doubles court at 6:00 PM with teammates',
      '!bookcourt Court 1 10:30am today doubles 90min for Roger with Rafa, Novak — Book specific court, duration, and players',
      '!bookcourt pb 6pm tomorrow — Book a pickleball court tomorrow at 6:00 PM'
    ]
  },
  cancelcourt: {
    title: '🗑️ Cancel Court Reservation (!cancelcourt)',
    description: 'Cancels an existing SCVCC court reservation by its confirmation or reservation ID number.',
    usage: '!cancelcourt <reservationId> | !cancelreservation <reservationId>',
    options: [
      '`<reservationId>` — Confirmation or reservation number of the SCVCC booking to cancel'
    ],
    aliases: ['!cancelcourt', '!cancelreservation'],
    examples: [
      '!cancelcourt 194193 — Cancel reservation #194193',
      '!cancelreservation 194192 — Cancel reservation #194192'
    ]
  },
  mybookings: {
    title: '📋 My Court Bookings (!mybookings)',
    description: 'Retrieves upcoming court reservations and details for club member accounts.',
    usage: '!mybookings',
    options: [
      'No options — Displays all upcoming club court reservations and details for configured member accounts'
    ],
    aliases: ['!mybookings', '!myreservations', '!mycourts'],
    examples: [
      '!mybookings — View your upcoming club court reservations'
    ]
  },
  pausecourtbookings: {
    title: '⏸️ Pause & Resume Court Bookings (!pausecourtbookings / !resumecourtbookings)',
    description: 'Pauses or resumes court bookings for a group (group admins or superadmin) or across all groups (superadmin only). When paused, automatic court pre-bookings and direct court bookings are suspended while preserving existing venue configurations.',
    usage: '!pausecourtbookings [group|all] | !resumecourtbookings [group|all]\n  (aliases: !pauseallcourtbookings, !resumeallcourtbookings, !pausecourts, !resumecourts)',
    options: [
      '`[group]` — Specific group name or WhatsApp JID to pause or resume court bookings for (defaults to current group; group admins or superadmin)',
      '`all` — (Superadmin only) Pause or resume automated and direct court bookings across all groups'
    ],
    aliases: ['!pausecourtbookings', '!resumecourtbookings', '!pausecourtbooking', '!resumecourtbooking', '!pausecourts', '!resumecourts', '!pausecourt', '!resumecourt', '!pauseallcourtbookings', '!resumeallcourtbookings'],
    examples: [
      '!pausecourtbookings — (Admin) Pause court bookings for the current group',
      '!resumecourtbookings — (Admin) Resume court bookings for the current group',
      '!pausecourtbookings Bot-testing — (Admin/Superadmin) Pause court bookings for a specific group',
      '!resumecourtbookings Bot-testing — (Admin/Superadmin) Resume court bookings for a specific group',
      '!pausecourtbookings all — (Superadmin only) Pause court bookings across all groups',
      '!resumecourtbookings all — (Superadmin only) Resume court bookings across all groups',
      '!pauseallcourtbookings — (Superadmin only) Pause court bookings across all groups with a single command',
      '!resumeallcourtbookings — (Superadmin only) Resume court bookings across all groups with a single command'
    ]
  },
  webcam: {
    title: '📹 Court Webcam (!webcam / !camera / !courtcam)',
    description: 'Sends a real-time photo snapshot of the tennis courts at Silver Creek Valley Country Club (SCVCC), with an option to capture a 10-second video clip.',
    usage: '!webcam [video] | !camera [video] | !courtcam [video] | !cam',
    options: [
      '`video` — Capture and send a 10-second live court video clip instead of a static photo snapshot',
      'No options — Send a real-time photo snapshot of the SCVCC tennis courts (default)'
    ],
    aliases: ['!webcam', '!camera', '!courtcam', '!cam', '!courtwebcam', '!courtswebcam'],
    examples: [
      '!webcam — Send a live court photo snapshot (default)',
      '!webcam video — Send a live 10-second court video clip',
      '!camera — Check court conditions via live camera'
    ]
  },
  courts: {
    title: '🎾 Court Availability (!courts)',
    description: 'Checks real-time tennis (Courts 1–6) and pickleball court availability and open slot durations at Silver Creek Valley Country Club (SCVCC).',
    usage: '!courts [when] [time] [court] [pb]',
    options: [
      '`[when]` — Date or day of the week to check availability for (e.g. "today", "tomorrow", "saturday", "10/25"; defaults to today)',
      '`[time]` — Filter availability by start time or period (e.g. "6pm", "9:30am", "morning", "evening")',
      '`[court]` — Filter availability to a specific court (e.g. "Court 2")',
      '`[pb]` — Check pickleball court availability instead of tennis courts'
    ],
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
    description: 'Creates a match scheduling WhatsApp poll for fixed spots (2, 4, 8, 12), auto-calculated spots based on SCVCC pre-booked & free courts, or Yes/No opt-in. By default, court availability is NOT checked unless --courts is specified. Supports automated court pre-booking with custom player rosters, advance strategies, and look-around search windows.',
    usage: '!poll [size/auto] [when] [--courts] [--lineups=filled|fallback|none] [--lineup-lead-time=<duration>] [--slot-check|--no-slot-check] [--pre-allocate-slots] [--reminders|--no-reminders] [--court-booking-type=pre-book|none] [--pre-book-courts=<N>] [--booking-players="..."] [--booking-strategy=advanced|standard] [--booking-schedule="..."] [--look-around="<window>"] (or @tenbot create a poll [for <N>/auto] [when])',
    options: [
      '`size` or `auto` — Number of player spots (2 for singles, 4/8/12/16 for doubles) or "auto" to calculate spots based on SCVCC court availability. Leave empty for a Yes/No opt-in poll',
      '`when` — Match day and/or start time (e.g. "today", "tomorrow 7pm", "saturday 9am")',
      '`--courts` — Check SCVCC court availability before creating the poll',
      '`--lineups=filled|fallback|none` — Lineup generation mode: "filled" (auto-generate when full; default), "fallback" (auto-generate at lead time if no manual lineup posted), or "none" (manual only)',
      '`--lineup-lead-time=<duration>` — Lead time before play time for fallback lineup generation and reminders (e.g. "30m", "1h"; default: 30m)',
      '`--slot-check` / `--no-slot-check` — Enable or disable slot conflict checking (warns voters who pick an already-claimed slot)',
      '`--pre-allocate-slots` — Include pre-allocated court slots as named voting options',
      '`--reminders` / `--no-reminders` — Enable or disable automated match reminder notifications (default: on)',
      '`--court-booking-type=pre-book|none` — Automatically pre-book courts at SCVCC when poll is created',
      '`--pre-book-courts=<N>` — Number of courts to pre-book (e.g. 1 or 2; defaults to group setting)',
      '`--booking-players="..."` — Comma-separated list of club member names to use for court reservations',
      '`--booking-strategy=advanced|standard` — Court booking strategy: "advanced" (pre-book on custom schedule) or "standard" (instant pre-book when poll is created)',
      '`--booking-schedule="<offset>"` — Advance booking trigger schedule (e.g. "-7days 7:00AM")',
      '`--look-around="<window>"` — Time window to search for available/prebooked courts around requested time (e.g. "30m", "1 hour")'
    ],
    aliases: ['!poll', '!createpoll', '!makepoll', '!newpoll', '!optinpoll', '!yesnopoll', '!createoptinpoll', '!createyesnopoll'],
    examples: [
      '!poll auto tomorrow 6:30pm --courts --look-around=1h — Auto poll searching 6:30pm, 7pm, and 7:30pm for available/prebooked courts',
      '!poll auto tomorrow 9am — Auto-calculates spots (4, 8, or 12) from SCVCC pre-booked & 90m free courts',
      '!poll 4 tomorrow 9am — 4-player doubles poll for tomorrow at 9:00 AM (default: does not check court availability)',
      '!poll 4 tomorrow 9am --courts — 4-player doubles poll considering SCVCC court availability',
      '!poll 4 tomorrow 6:30pm with look around of 30 mins — 4-player poll looking for courts at 6:30pm and 7pm',
      '!poll 4 tomorrow 9am --court-booking-type=pre-book — Create poll and automatically pre-book 1 court at SCVCC',
      '!poll 8 tomorrow 9am --pre-book-courts=2 — Create 8-player poll and pre-book 2 courts',
      '!poll 4 tomorrow 9am with players ["Pramod Immaneni, Kejal Patel"] — Pre-book court with specific players',
      '!poll 2 today 6pm — 2-player singles poll',
      '!poll tomorrow 7pm — Yes/No opt-in poll (no player count specified)',
      '!poll 4 7pm --lineups=none — Fixed 4-spot poll with manual matchups only',
      '!poll auto tomorrow 7pm --pre-allocate-slots — Auto poll with named slots for booking players on prebooked courts',
      '@tenbot create a poll for auto on Saturday 9am — Auto poll for Saturday'
    ]
  },
  matchups: {
    title: '⚖️ Matchups & Rotations (!matchups)',
    description: 'Generates balanced singles/doubles pairings and rotations from current active or filled match poll votes using player ratings.',
    usage: '!matchups [pollName/time] (or !draw, !rematch)',
    options: [
      '`[pollName/time]` — Target a specific active or filled poll by title, match time, or poll ID (defaults to most recent active or filled poll)',
      '`keeping <A> and <B> on same team` — Force specified players to be partnered together on the same team'
    ],
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
    options: [
      '`[when]` — Day and/or time you are free to play (e.g. "Sat 9am", "tomorrow evening", "today 6pm")',
      'No options — View the current list of who is marked available and when',
      '`!notfree` — Remove yourself from the availability list',
      '`!clearfree` — (Admin only) Clear the entire player availability list'
    ],
    aliases: ['!free', '!notfree', '!clearfree', '!avail', '!availability'],
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
    options: [
      '`<winner>` — Name(s) of the winning player or doubles pair (e.g. "Mike" or "Mike & Sara")',
      '`<loser>` — Name(s) of the losing player or doubles pair (e.g. "John" or "John & Alex")',
      '`<score>` — Match scores by set (e.g. "6-4 6-2", "6-4 5-7 10-8")'
    ],
    aliases: ['!score', '!scores', '!result', '!results'],
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
    options: [
      'No options — Displays group player win/loss records, match counts, and rankings from reported scores'
    ],
    aliases: ['!leaderboard', '!standings'],
    examples: [
      '!leaderboard — View player win/loss leaderboard'
    ]
  },
  ratings: {
    title: '📊 Player Ratings (!ratings)',
    description: 'Manages skill ratings (2.5 to 4.5 scale) used to create balanced matchups.',
    usage: '!ratings | !setrating <rating> | !resetrating [player] | !refreshratings',
    options: [
      'No options — Display all registered player ratings in descending order',
      '`!setrating <rating>` — Update your own rating on the 2.5–4.5 skill scale',
      '`!setrating <player> = <rating>` — (Admin only) Update rating for another player',
      '`!resetrating [player]` — Reset your rating (or specified player) to baseline TennisRecord rating',
      '`!refreshratings` — (Admin only) Force refresh all player ratings from TennisRecord.com'
    ],
    aliases: ['!ratings', '!rating', '!setrating', '!myrating', '!resetrating', '!ratingreset', '!refreshratings'],
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
    options: [
      '`<alias>` — Register a nickname or alias for yourself so the bot recognizes you under this name',
      '`<player> = <alias>` — (Admin only) Register an alias for another player',
      '`!deletealias <alias>` — Remove an existing alias',
      '`!aliases` — List all registered players and their active aliases'
    ],
    aliases: ['!alias', '!aliases', '!addalias', '!deletealias', '!delalias', '!removealias', '!rmalias'],
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
    options: [
      '`<full name>` — Set your full name and automatically fetch your baseline rating from TennisRecord.com',
      '`<player> = <full name>` — (Admin only) Set full name for another player'
    ],
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
    options: [
      '`[pollId]` — Target specific poll ID to stop or resume voting on (defaults to latest active poll; creator or admin only)'
    ],
    aliases: ['!stoppoll', '!closepoll', '!resumepoll', '!reopenpoll', '!stop', '!resume', '!close', '!reopen'],
    examples: [
      '!stoppoll — Stop voting on the active poll (creator or admin only)',
      '!resumepoll — Reopen voting on the stopped poll (creator or admin only)'
    ]
  },
  reminders: {
    title: '⏰ Match Reminders (!remind / !pausereminders)',
    description: 'Manages automated upcoming match reminder notifications (sent at 64h, 32h, 16h, 8h, 4h, 2h, 1h before playtime).',
    usage: '!pausereminders [pollId] | !resumereminders [pollId] | !remind [pollId]',
    options: [
      '`!remind [pollId]` — Manually trigger an immediate reminder notification for active poll(s)',
      '`!pausereminders [pollId]` — Pause automated match reminder notifications for active poll(s)',
      '`!resumereminders [pollId]` — Resume automated match reminder notifications for active poll(s)'
    ],
    aliases: ['!pausereminders', '!pausereminder', '!resumereminders', '!resumereminder', '!remind', '!sendreminder', '!sendreminders', '!triggerreminder', '!remindpoll', '!silencereminders', '!unpausereminder', '!unpausereminders'],
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
    options: [
      '`!cancelpoll [pollId]` — Cancel active poll and delete the poll message from WhatsApp (creator or admin only)',
      '`!clearallpolls` — (Admin only) Clear all polls from bot state while preserving messages on WhatsApp'
    ],
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
    options: [
      '`[pollId/scheduleId]` — Target specific poll instance or recurring schedule by ID to inspect',
      '`recurring` (or `-r`) — Filter poll status to instances created from recurring schedules',
      '`active` (or `!activepolls`) — List all active, filled, or stopped match polls',
      '`upcoming` (or `!upcomingpolls`) — List match polls whose scheduled play time has not passed yet',
      '`all` (or `!allpolls`) — (Admin only) Show status of all polls across all chats in storage',
      '`!cleanuppolls` — (Admin only) Force cleanup sweep for expired polls (>2 weeks old)'
    ],
    aliases: ['!pollstatus', '!activepolls', '!upcomingpolls', '!allpolls', '!cleanuppolls', '!active', '!upcoming', '!activepollstatus', '!upcomingpollstatus', '!allpollstatus', '!pollstatusall'],
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
    options: [
      '`[pollId/scheduleId]` — Target poll ID or recurring schedule ID (defaults to active poll if only 1 exists)',
      '`<count>` — Maximum player slot limit (e.g. 8, 12). Excess votes will not be considered',
      '`reset` / `clear` / `none` — Remove the slot limit and restore the poll\'s original capacity'
    ],
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
    usage: '!modifyinstance <scheduleId/pollId> [size/auto] [when] [--courts] [--lineups=filled|fallback|none] [--lineup-lead-time=<duration>] [--slot-check|--no-slot-check] [--pre-allocate-slots] [--reminders|--no-reminders] [--court-booking-type=pre-book|none] [--pre-book-courts=<N>] [--booking-players=\"...\"] [--look-around=\"<window>\"]\n  (aliases: !modifypoll, !modifyrecurringinstance, !modifyrecurringpoll instance <id>)',
    options: [
      '`<scheduleId/pollId>` — Target poll ID or recurring schedule ID whose current active instance to modify',
      '`size` or `auto` — Update player spots (2, 4, 8, 12, 16), "auto", or "opt-in"',
      '`when` / `time` — Update match day or start time (e.g. "7:30pm", "tomorrow 6pm")',
      '`--courts` — Enable court availability checking for this instance',
      '`--lineups=filled|fallback|none` — Update lineup generation mode: "filled", "fallback", or "none"',
      '`--lineup-lead-time=<duration>` — Update lead time before play time for lineup generation and reminders',
      '`--slot-check` / `--no-slot-check` — Enable or disable slot conflict checking in-place',
      '`--pre-allocate-slots` — Include pre-allocated court slots as named voting options',
      '`--reminders` / `--no-reminders` — Enable or disable match reminder notifications in-place for this poll instance',
      '`--court-booking-type=pre-book|none` — Update court pre-booking behavior',
      '`--pre-book-courts=<N>` — Update number of courts to pre-book',
      '`--booking-players="..."` — Update roster of players for court booking',
      '`--look-around="<window>"` — Update or remove ("none") look-around search window'
    ],
    aliases: ['!modifyinstance', '!modifyrecurringinstance', '!modifypoll', '!editpoll', '!updatepoll', '!editinstance', '!updateinstance'],
    examples: [
      '!modifyinstance rec_1 12 7:30pm — Modify active poll instance created from rec_1 to 12 spots at 7:30 PM',
      '!modifyinstance rec_1 auto 6pm — Modify active poll instance to auto spots at 6:00 PM',
      '!modifyinstance rec_1 opt-in — Modify active poll instance to Yes/No opt-in',
      '!modifyinstance rec_1 8 --lineups=none — Modify active poll instance to 8 spots with manual matchups',
      '!modifyinstance rec_1 --courts — Consider court availability for the active poll instance',
      '!modifyinstance rec_1 --look-around=30m — Update look-around search window for active poll instance',
      '!modifypoll 3EB05E96A2374C2FF716FE 12 — Modify specific poll instance by its poll ID to 12 spots'
    ]
  },
  skipinstance: {
    title: '⏭️ Skip Recurring Poll Instance (!skipinstance)',
    description: 'Skips one or more specified upcoming instances (or the next N upcoming instances) of a recurring match poll schedule without pausing future schedules. If a poll instance was already created on WhatsApp, it is cancelled and deleted. Future instances will post automatically as scheduled.',
    usage: '!skipinstance [scheduleId] [count/day/date]\n  (aliases: !skipinstances, !skiprecurringinstance, !skiprecurringinstances, !skiprecurringpoll, !skiprecurring, !skippoll, !recurringpoll skip)',
    options: [
      '`[scheduleId]` — Target recurring schedule ID (optional if only 1 recurring schedule exists in chat)',
      '`[count]` — Number of upcoming instances to skip (e.g. 1, 2, 3)',
      '`[day/date]` — Specific day of week (e.g. "wednesday") or date (e.g. "10/25") to skip'
    ],
    aliases: ['!skipinstance', '!skipinstances', '!skiprecurringinstance', '!skiprecurringinstances', '!skiprecurringpoll', '!skiprecurring', '!skippoll'],
    examples: [
      '!skipinstance rec_1 — Skip the next upcoming instance of schedule rec_1',
      '!skipinstance rec_1 3 — Skip the next 3 upcoming instances of schedule rec_1',
      '!skipinstance 2 — Skip next 2 upcoming instances (if only 1 recurring schedule exists)',
      '!skipinstance rec_1 wednesday — Skip the Wednesday instance of schedule rec_1',
      '!skipinstance rec_1 10/25 — Skip the instance for Oct 25 on schedule rec_1',
      "!skipinstance — Skip next instance of the chat's recurring schedule (if only 1 exists)",
      '!unskipinstance rec_1 — Restore the first skipped instance of schedule rec_1',
      '!unskipinstance rec_1 all — Restore all skipped instances of schedule rec_1'
    ]
  },
  unskipinstance: {
    title: '▶️ Restore Skipped Poll Instance (!unskipinstance)',
    description: 'Restores one or more previously skipped instances (or all skipped instances) of a recurring match poll schedule so they will post automatically as scheduled.',
    usage: '!unskipinstance [scheduleId] [count/day/date/all]\n  (aliases: !unskiprecurringinstance, !unskiprecurringpoll, !unskiprecurring, !resumeskip, !recurringpoll unskip)',
    options: [
      '`[scheduleId]` — Target recurring schedule ID (optional if only 1 recurring schedule exists in chat)',
      '`[count]` — Number of skipped instances to restore (e.g. 1, 2)',
      '`[day/date]` — Specific day of week (e.g. "wednesday") or date to restore',
      '`all` — Restore all skipped instances for the schedule'
    ],
    aliases: ['!unskipinstance', '!unskiprecurringinstance', '!unskiprecurringpoll', '!unskiprecurring', '!resumeskip'],
    examples: [
      '!unskipinstance rec_1 — Restore the first skipped instance of schedule rec_1',
      '!unskipinstance rec_1 all — Restore all skipped instances of schedule rec_1',
      '!unskipinstance rec_1 2 — Restore the next 2 skipped instances of schedule rec_1',
      '!unskipinstance rec_1 wednesday — Restore the skipped Wednesday instance of schedule rec_1'
    ]
  },
  recurringpoll: {
    title: '🔁 Recurring Daily Polls (!recurringpoll)',
    description: 'Schedules and manages automated match polls that are posted to the group on specific days of the week or everyday. Schedules can be paused or resumed by the creator or group admins. Supports advance court pre-booking strategies (e.g. booking 7 days early at 7:00 AM), custom posting schedules (e.g. day before, hours before), court availability checks, look-around search windows, and automatic pairings.',
    usage: '!recurringpoll [size/auto] <matchTime> [at <postTime>] [days] [--courts] [--lineups=filled|fallback|none] [--lineup-lead-time=<duration>] [--slot-check|--no-slot-check] [--pre-allocate-slots] [--reminders|--no-reminders] [--booking-strategy=advanced|standard] [--booking-schedule=\"<offset>\"] [--court-booking-type=pre-book|none] [--pre-book-courts=<N>] [--booking-players=\"...\"] [--look-around=\"<window>\"] [--start-date=<date>] [--end-date=<date>]\n  !modifyrecurringpoll <id> [size/auto] [matchTime] [at <postTime>] [days] ...\n  !modifyinstance <id> [size/auto] [time] (modify current active poll instance)\n  !recurringpolls | !recurringpoll status <id>\n  !pauserecurringpoll [id/all] [until <date>] (or !recurringpoll pause [id] [until <date>])\n  !resumerecurringpoll [id/all] (or !recurringpoll resume [id])\n  !cancelrecurringpoll <id> | !clearallrecurringpolls',
    options: [
      '`size` or `auto` — Number of player spots (2, 4, 8, 12, 16) or "auto" to calculate spots based on court availability',
      '`<matchTime>` — Scheduled match play time (e.g. "7pm", "9:30am")',
      '`[at <postTime>]` — When to post the poll to the group (e.g. "at 8am", "at 1 day before at 6pm", "at 2h before")',
      '`[days]` — Days of the week to post (e.g. "everyday", "weekdays", "weekends", "mon-thu", "tue,thu")',
      '`--courts` — Check SCVCC court availability when posting the poll',
      '`--lineups=filled|fallback|none` — Lineup generation mode: "filled" (auto-generate when full), "fallback" (auto-generate at lead time if no manual lineup posted), or "none" (manual only)',
      '`--lineup-lead-time=<duration>` — Lead time before play time for fallback lineup generation and reminders (e.g. "30m", "1h"; default: 30m)',
      '`--slot-check` / `--no-slot-check` — Enable or disable slot conflict checking',
      '`--pre-allocate-slots` — Include pre-allocated court slots as named voting options',
      '`--reminders` / `--no-reminders` — Enable or disable automated match reminder notifications for poll instances (default: on)',
      '`--court-booking-type=pre-book|none` — Automatically pre-book courts at SCVCC',
      '`--pre-book-courts=<N>` — Number of courts to pre-book (e.g. 1 or 2)',
      '`--booking-players="..."` — Comma-separated list of club member names to use for court reservations',
      '`--booking-strategy=advanced|standard` — Booking strategy: "advanced" (scheduled advance booking) or "standard" (instant booking when poll is posted)',
      '`--booking-schedule="<offset>"` — Advance booking trigger schedule (e.g. "-7days 7:00AM")',
      '`--look-around="<window>"` — Time window to search for available/prebooked courts (e.g. "30m", "1 hour", "none" to remove)',
      '`--start-date=<date>` — Date when recurring schedule starts posting (e.g. "10/15/2026", "tomorrow")',
      '`--end-date=<date>` — Date after which recurring schedule stops posting (or "none" to remove)'
    ],
    aliases: [
      '!recurringpoll', '!recurringpolls', '!schedulepoll', '!scheduledpolls', '!dailypoll', '!dailypolls', '!everydaypoll', '!repeatingpoll',
      '!modifyrecurringpoll', '!editrecurringpoll', '!updaterecurringpoll', '!changerecurringpoll', '!modifyrecurring', '!editrecurring', '!updaterecurring',
      '!pauserecurringpoll', '!stoprecurringpoll', '!pauserecurring', '!stoprecurring', '!pauseallrecurring', '!stopallrecurring', '!pauserecurringpolls', '!stoprecurringpolls',
      '!resumerecurringpoll', '!startrecurringpoll', '!resumerecurring', '!startrecurring', '!resumeallrecurring', '!startallrecurring', '!resumerecurringpolls', '!startrecurringpolls',
      '!cancelrecurringpoll', '!deleterecurringpoll', '!removerecurringpoll', '!clearrecurringpoll', '!clearallrecurringpolls', '!clearrecurringpolls', '!cancelallrecurringpolls', '!deleteallrecurringpolls', '!removeallrecurringpolls', '!clearallrecurring', '!cancelallrecurring'
    ],
    examples: [
      '!recurringpoll 4 8pm on weekdays at 8am --booking-strategy=advanced --booking-schedule="-7days 7:00AM" — 4-player weekday poll with advance court pre-booking 7 days early at 7:00 AM',
      '!recurringpoll auto 7pm mon-thu from 10/15/2026 to 11/15/2026 — Recurring poll starting on Oct 15 and ending on Nov 15',
      '!recurringpoll 4 7pm mon-thu --start-date=tomorrow --end-date=11/30/2026 — 4-player poll with start date and end date',
      '!recurringpoll auto 6:30pm mon-thu with look around of 1 hour — Weekday auto poll with 1-hour look-around search for courts',
      '!recurringpoll auto 7pm mon-thu — Auto poll (4, 8, or 12 spots based on courts) for 7:00 PM on Mon–Thu',
      '!recurringpoll 4 7pm mon-thu — 4-spot poll for 7:00 PM on Mon–Thu (posted at 8:00 AM, court check off by default)',
      '!recurringpoll 4 7pm mon-thu --courts — 4-spot poll considering SCVCC court availability',
      '!recurringpoll 4 7pm mon-thu --court-booking-type=pre-book --pre-book-courts=1 — Automatically pre-book 1 court when poll is posted',
      '!recurringpoll auto 7pm mon-thu --pre-allocate-slots — Auto poll with pre-allocated court slots for Mon–Thu',
      '!recurringpoll 4 7pm mon-thu --no-reminders — 4-player weekday poll with match reminders disabled',
      '!recurringpoll 12 7pm at 8pm Mon-Thu --lineups=none — 12-spot poll for Mon–Thu matches with manual matchups only, posted evening before at 8pm',
      '!recurringpoll 4 7pm at 8am on weekdays — Post at 8am on weekdays for 7pm match',
      '!recurringpoll 4 9am on weekends — Post for 9am matches on Sat and Sun',
      '!recurringpoll 4 7pm at 1 day before at 6pm mon-thu — Post 1 day prior at 6:00 PM',
      '!recurringpoll opt-in 7pm mon, wed, fri — Opt-in Yes/No poll on Mon, Wed, Fri',
      '!modifyrecurringpoll rec_1 --booking-strategy=advanced --booking-schedule="-7days 7:00AM" — Configure advance court pre-booking for schedule rec_1',
      '!modifyrecurringpoll rec_1 8 6pm at 7am mon-thu — Modify spots to 8, match time to 6pm, post time to 7am on Mon–Thu',
      '!modifyrecurringpoll rec_1 7:30pm — Update match time to 7:30 PM',
      '!modifyrecurringpoll rec_1 weekends — Update scheduled days to weekends',
      '!modifyrecurringpoll rec_1 --end-date=11/30/2026 — Set or update end date for schedule rec_1',
      '!modifyrecurringpoll rec_1 --end-date=none — Remove end date for schedule rec_1',
      '!modifyrecurringpoll rec_1 --pre-allocate-slots — Enable named slots for prebooked courts',
      '!modifyrecurringpoll rec_1 --look-around=30m — Update look-around window for schedule rec_1',
      '!modifyrecurringpoll rec_1 --look-around=none — Remove look-around window for schedule rec_1',
      '!modifyinstance rec_1 12 7:30pm — Modify current active instance of rec_1 (leaves future schedule unchanged)',
      '!recurringpolls — List all active recurring schedules',
      '!recurringpoll status rec_1 — Show recurring schedule details for rec_1',
      '!pauserecurringpoll rec_1 — Pause schedule rec_1 (or !recurringpoll pause rec_1)',
      '!pauserecurringpoll rec_1 until 10/25/2026 — Pause schedule rec_1 until Oct 25, 2026 (resumes automatically after date)',
      '!pauserecurringpoll rec_1 until Monday — Pause schedule rec_1 until next Monday',
      '!pauserecurringpoll all until 10/25 — (Admin only) Pause all recurring schedules until Oct 25',
      '!resumerecurringpoll rec_1 — Resume schedule rec_1 (or !recurringpoll resume rec_1)',
      '!skipinstance rec_1 3 — Skip the next 3 upcoming instances of schedule rec_1',
      '!unskipinstance rec_1 all — Restore all skipped instances of schedule rec_1',
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
    options: [
      '`[location]` — City or location name to check 3-day forecast for (defaults to "San Jose, CA")'
    ],
    aliases: ['!weather', '!forecast'],
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
    options: [
      '`!certstatus` — Check current SSL certificate validation status for TennisRecord.com',
      '`!suspendcert` — (Admin only) Suspend certificate verification (allow expired SSL certs)',
      '`!resumecert` — (Admin only) Resume strict SSL certificate validation'
    ],
    aliases: ['!certstatus', '!certcheck', '!suspendcert', '!resumecert', '!sslstatus', '!suspendcertcheck', '!resumecertcheck'],
    examples: [
      '!certstatus — Check current SSL verification status',
      '!suspendcert — (Admin only) Suspend certificate verification (allow expired SSL certs)',
      '!resumecert — (Admin only) Resume strict SSL certificate validation'
    ]
  },
  groups: {
    title: '👥 Group List & IDs (!groups)',
    description: '(Superadmin only via DM) Lists all WhatsApp groups the bot is currently a participating member of, showing their display names, WhatsApp JIDs/LIDs, member counts, and configuration status.',
    usage: '!groups',
    options: [
      'No options — Lists all WhatsApp groups the bot is participating in with JIDs, LIDs, and member counts'
    ],
    aliases: ['!groups', '!listgroups', '!mygroups', '!getgroups', '!allgroups', '!groupids', '!grouplids'],
    examples: [
      '!groups — Show all participating WhatsApp groups with their names and JIDs'
    ]
  },
  superadmin: {
    title: '👑 Superadmin Group Management (!groupconfig / !setgroupconfig / !addgroup / !removegroup)',
    description: '(Superadmin only via DM) Manage WhatsApp group configurations, whitelist, and settings in groups.json.',
    usage: '!groupconfig [jid/name] | !addgroup <jid/name> [displayName] | !removegroup <jid/name> | !setgroupconfig <jid/name> <key=value>... | !pauseallcourtbookings | !resumeallcourtbookings',
    options: [
      '`!groupconfig [jid/name]` — View configuration for all groups or a specific group in groups.json',
      '`!addgroup <jid/name> [displayName]` — Add group to configuration and whitelist',
      '`!removegroup <jid/name>` — Remove group from configuration and whitelist',
      '`!setgroupconfig <jid/name> <key=value>...` — Configure group settings in groups.json',
      '`!pauseallcourtbookings` / `!resumeallcourtbookings` — Pause or resume court bookings across all groups',
      '`sport="tennis"|"pickleball"` — Primary sport for the group',
      '`courtBookingEnabled=true|false` — Enable or disable automated court bookings for the group',
      '`courtConfig="SCVCC"` — Venue configuration identifier',
      '`bookingStrategy="advanced"|"standard"` — Advance booking strategy',
      '`bookingSchedule="<offset>"` — Offset schedule for advance booking (e.g. "-7days 7:00AM")',
      '`preBookCourts=<N>` — Default number of courts to pre-book (e.g. 1 or 2)',
      '`bookingCourtPreference="2, 3, 1, 5, 6"` — Preferred court numbers in priority order',
      '`directCourtBookingAccounts="..."` — Comma-separated member names with club booking credentials',
      '`defaultBookingPlayers="..."` — Comma-separated player names used to fill bookings',
      '`bookingNotifications="..."` — WhatsApp LIDs/JIDs to notify on booking confirmations and cancellations',
      '`autoMatchups=true|false` — Auto-generate balanced pairings when poll fills',
      '`ignoredCourts="4, 5"` — Court numbers to exclude from availability checks',
      '`tentativeBookingTitles="..."` — Court booking titles (e.g. "Club Event, Clinic") treated as tentative if booked',
      '`lookAround="<window>"` — Default look-around search window for group polls (e.g. "30m", "1 hour")'
    ],
    aliases: ['!addgroup', '!removegroup', '!deletegroup', '!rmgroup', '!setgroupconfig', '!updategroupconfig', '!groupconfig', '!getgroupconfig'],
    examples: [
      '!groupconfig — View all configured groups in groups.json',
      '!groupconfig Bot-testing — View configuration for Bot-testing',
      '!addgroup Bot-testing — Add group to configuration and whitelist by name',
      '!addgroup 120363403838804497@g.us Bot-testing — Add group by JID with custom name',
      '!setgroupconfig Bot-testing sport=tennis courtBookingEnabled=true courtConfig=SCVCC — Update group settings',
      '!setgroupconfig Bot-testing bookingStrategy=advanced bookingSchedule="-7days 7:00AM" — Configure advance court pre-booking',
      '!setgroupconfig Bot-testing directCourtBookingAccounts="Pramod Immaneni, Conrad Rodricks, Kejal Patel" — Set club booking accounts',
      '!setgroupconfig Bot-testing defaultBookingPlayers="Ghufran Ahmed, Mausam Bhatt, Gaurav Puri" — Set player roster for bookings',
      '!setgroupconfig Bot-testing bookingCourtPreference="2, 3, 1, 5, 6" preBookCourts=1 — Set court preference order',
      '!setgroupconfig Bot-testing bookingNotifications="90611059302558@lid" — Set booking confirmation notification recipient',
      '!setgroupconfig Bot-testing lookAround="30m" — Set default look-around window for group',
      '!setgroupconfig Bot-testing tentativeBookingTitles="Clinic, Team Practice" — Configure tentative court booking titles',
      '!removegroup Bot-testing — Remove group from configuration and whitelist'
    ]
  },
  reset: {
    title: '🔄 Reset Bot Memory (!reset)',
    description: '(Admin only) Clears bot conversation memory and recent 2-week group message logs.',
    usage: '!reset',
    options: [
      'No options — (Admin only) Clears bot conversation memory and recent 2-week message logs'
    ],
    aliases: ['!reset'],
    examples: ['!reset']
  },
  ping: {
    title: '🏓 Ping (!ping)',
    description: 'Checks bot connectivity and responsiveness.',
    usage: '!ping',
    options: [
      'No options — Checks bot connectivity and responsiveness (replies with "pong 🏓")'
    ],
    aliases: ['!ping'],
    examples: ['!ping — Replies with "pong 🏓"']
  },
  help: {
    title: '❓ Help (!help)',
    description: 'Displays the command menu or detailed usage and examples for a specific command.',
    usage: '!help [command]',
    options: [
      '`[command]` — Specific command name or alias to view detailed documentation, options, and examples for (e.g. "poll", "courts", "bookcourt")',
      'No options — View overview of all available commands grouped by category'
    ],
    aliases: ['!help'],
    examples: [
      '!help — View overview of all available commands',
      '!help poll — Detailed help for creating match polls',
      '!help recurringpoll — Detailed help for recurring poll schedules',
      '!help courts — Detailed help for SCVCC court availability',
      '!help bookcourt — Detailed help for direct court bookings',
      '!help pausecourtbookings — Detailed help for pausing & resuming court bookings',
      '!help superadmin — Detailed help for superadmin group settings'
    ]
  }
};

const COMMAND_ALIAS_MAP = {
  webcam: 'webcam', camera: 'webcam', courtcam: 'webcam', cam: 'webcam', courtwebcam: 'webcam', courtswebcam: 'webcam',
  bookings: 'bookings', courtbookings: 'bookings', booking: 'bookings', courtreservations: 'bookings', courtreservation: 'bookings', reservations: 'bookings', reservation: 'bookings', courtschedule: 'bookings',
  bookcourt: 'bookcourt', reservecourt: 'bookcourt', book: 'bookcourt', reserve: 'bookcourt',
  cancelcourt: 'cancelcourt', cancelreservation: 'cancelcourt',
  mybookings: 'mybookings', myreservations: 'mybookings', mycourts: 'mybookings',
  pausecourtbookings: 'pausecourtbookings', pausecourtbooking: 'pausecourtbookings', pausecourts: 'pausecourtbookings', pausecourt: 'pausecourtbookings', pauseallcourtbookings: 'pausecourtbookings',
  resumecourtbookings: 'pausecourtbookings', resumecourtbooking: 'pausecourtbookings', resumecourts: 'pausecourtbookings', resumecourt: 'pausecourtbookings', resumeallcourtbookings: 'pausecourtbookings',
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
  skipinstance: 'skipinstance', skipinstances: 'skipinstance', skiprecurringinstance: 'skipinstance', skiprecurringinstances: 'skipinstance', skiprecurringpoll: 'skipinstance', skiprecurring: 'skipinstance', skippoll: 'skipinstance',
  unskipinstance: 'unskipinstance', unskiprecurringinstance: 'unskipinstance', unskiprecurringpoll: 'unskipinstance', unskiprecurring: 'unskipinstance', resumeskip: 'unskipinstance',
  recurringpoll: 'recurringpoll', recurringpolls: 'recurringpoll', schedulepoll: 'recurringpoll', scheduledpolls: 'recurringpoll', dailypoll: 'recurringpoll', dailypolls: 'recurringpoll', everydaypoll: 'recurringpoll', repeatingpoll: 'recurringpoll',
  modifyrecurringpoll: 'recurringpoll', editrecurringpoll: 'recurringpoll', updaterecurringpoll: 'recurringpoll', changerecurringpoll: 'recurringpoll', modifyrecurring: 'recurringpoll', editrecurring: 'recurringpoll', updaterecurring: 'recurringpoll',
  cancelrecurringpoll: 'recurringpoll', deleterecurringpoll: 'recurringpoll', removerecurringpoll: 'recurringpoll', clearrecurringpoll: 'recurringpoll', clearallrecurringpolls: 'recurringpoll', clearrecurringpolls: 'recurringpoll', cancelallrecurringpolls: 'recurringpoll', deleteallrecurringpolls: 'recurringpoll', removeallrecurringpolls: 'recurringpoll', clearallrecurring: 'recurringpoll', cancelallrecurring: 'recurringpoll',
  pauserecurringpoll: 'recurringpoll', stoprecurringpoll: 'recurringpoll', pauserecurring: 'recurringpoll', stoprecurring: 'recurringpoll', pauseallrecurring: 'recurringpoll', stopallrecurring: 'recurringpoll', pauserecurringpolls: 'recurringpoll', stoprecurringpolls: 'recurringpoll',
  resumerecurringpoll: 'recurringpoll', startrecurringpoll: 'recurringpoll', resumerecurring: 'recurringpoll', startrecurring: 'recurringpoll', resumeallrecurring: 'recurringpoll', startallrecurring: 'recurringpoll', resumerecurringpolls: 'recurringpoll', startrecurringpolls: 'recurringpoll',
  weather: 'weather', forecast: 'weather',
  certcheck: 'certcheck', certstatus: 'certcheck', suspendcert: 'certcheck', resumecert: 'certcheck', sslstatus: 'certcheck', suspendcertcheck: 'certcheck', resumecertcheck: 'certcheck',
  groups: 'groups', listgroups: 'groups', mygroups: 'groups', getgroups: 'groups', allgroups: 'groups', groupids: 'groups', grouplids: 'groups',
  superadmin: 'superadmin', groupconfig: 'superadmin', setgroupconfig: 'superadmin', updategroupconfig: 'superadmin', getgroupconfig: 'superadmin', addgroup: 'superadmin', removegroup: 'superadmin', deletegroup: 'superadmin', rmgroup: 'superadmin',
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
    `⚙️ *Usage:*
  ${item.usage}`
  ];

  if (Array.isArray(item.options) && item.options.length > 0) {
    lines.push('');
    lines.push('📋 *Options:*');
    for (const opt of item.options) {
      if (typeof opt === 'string') {
        lines.push(`  • ${opt}`);
      } else if (opt && typeof opt === 'object') {
        const flag = opt.name || opt.option || opt.flag || '';
        const desc = opt.description || opt.desc || '';
        const prefix = flag ? `\`${flag}\` — ` : '';
        lines.push(`  • ${prefix}${desc}`);
      }
    }
  }

  lines.push(
    '',
    `🔀 *Aliases:* ${item.aliases.join(', ')}`,
    '',
    `💡 *Examples:*`,
    ...item.examples.map(ex => `  • ${ex}`)
  );
  return lines.join('\n');
}

const SUPERADMIN_TOPIC_KEYS = new Set(['groups', 'superadmin']);

function helpText(specificCmd = null, isSuperAdmin = false) {
  if (typeof specificCmd === 'boolean') {
    isSuperAdmin = specificCmd;
    specificCmd = null;
  } else if (typeof isSuperAdmin === 'object' && isSuperAdmin !== null) {
    isSuperAdmin = Boolean(isSuperAdmin.isSuperAdmin);
  }

  if (specificCmd) {
    const cleanCmd = specificCmd.trim().replace(/^!/, '').toLowerCase();
    const topicKey = COMMAND_ALIAS_MAP[cleanCmd];
    if (topicKey && SUPERADMIN_TOPIC_KEYS.has(topicKey) && !isSuperAdmin) {
      return `⚠️ Unknown command "!${cleanCmd}". Send "!help" to view all available commands.`;
    }
    if (topicKey && COMMAND_HELP[topicKey]) {
      return formatCommandHelp(topicKey);
    }
    return `⚠️ Unknown command "!${cleanCmd}". Send "!help" to view all available commands.`;
  }

  const lines = [
    '📋 *Tennis Group Bot Commands:*',
    '',
    '🎾 *Courts & Club:*',
    '• `!courts [when] [time] [court] [pb]` – Check SCVCC court availability',
    '• `!courtbookings [when] [time] [court] [pb]` – View SCVCC court bookings & reservations',
    '• `!bookcourt [court] <time> [when] [players]` – Book a court directly at SCVCC',
    '• `!cancelcourt <id>` – Cancel SCVCC court reservation by ID',
    '• `!mybookings` – View your upcoming club court reservations',
    '• `!pausecourtbookings [group|all]` / `!resumecourtbookings [group|all]` – (Admin/Superadmin) Pause or resume court bookings',
    '• `!webcam` / `!camera` – Send live SCVCC tennis court photo (or 10s video clip with `!webcam video`)',
    '',
    '🗳️ *Match Polls & Scheduling:*',
    '• `!poll [size/auto] [when] [--courts] [--pre-book] [--look-around]` – Create match poll (supports court pre-booking, availability checks, & look-around search window)',
    '• `!matchups` (or `!draw`, `!rematch`) – Generate pairings and rotations',
    '• `!stoppoll` / `!resumepoll` – Stop or resume voting and reminders',
    '• `!pausereminders` / `!resumereminders` / `!remind` – Manage match reminders',
    '• `!cancelpoll` / `!clearallpolls` – Cancel active poll or clear bot memory',
    '• `!setslots [id] <count>` – Internally limit poll spots without modifying WhatsApp poll',
    '• `!pollstatus [id]` / `!activepolls` / `!upcomingpolls` – View poll status & voters',
    '',
    '🔁 *Recurring Daily Polls:*',
    '• `!recurringpoll [size] <matchTime> [at <postTime>] [days] [--booking-strategy=advanced] [--look-around]` – Schedule daily recurring poll with optional advance court booking & look-around',
    '• `!modifyrecurringpoll <id> [size] [matchTime] [at <postTime>] [days]` – Modify recurring schedule template',
    '• `!modifyinstance <id> [size] [time]` – Modify a specific active poll instance (leaves future schedule intact)',
    '• `!skipinstance [id] [count/day/date]` – Skip 1 or more instances of a recurring poll without pausing schedule',
    '• `!pauserecurringpoll [id/all] [until <date>]` / `!resumerecurringpoll [id/all]` – Pause (with auto-resume date) or resume automated poll posting',
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
    '• `!ping` – Check bot connectivity'
  ];

  if (isSuperAdmin) {
    lines.push(
      '• `!groups` – (Superadmin only via DM) List names and JIDs of all WhatsApp groups the bot is in',
      '• `!groupconfig` / `!setgroupconfig` / `!addgroup` / `!removegroup` – (Superadmin only via DM) Manage groups & configuration (sport, bookingStrategy, bookingSchedule, courtConfig, player accounts, notifications)',
      '• `!pauseallcourtbookings` / `!resumeallcourtbookings` – (Superadmin only) Single command to pause or resume court bookings across all groups'
    );
  }

  lines.push(
    '• `!reset` – (Admin only) Clear conversation memory & recent logs',
    '• `!certstatus` / `!suspendcert` / `!resumecert` – (Admin only) Manage SSL cert verification',
    '',
    '💡 *Tip:* Send `!help <command>` (e.g. `!help courts`, `!help bookcourt`, `!help poll`, `!help recurringpoll`, `!help score`) for detailed usage and examples.'
  );

  return lines.join('\n');
}

module.exports = {
  helpText,
  COMMAND_HELP,
  COMMAND_ALIAS_MAP,
  SUPERADMIN_TOPIC_KEYS
};
