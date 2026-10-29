/**
 * Claude Tool Definitions & Schemas for Tenbot
 */

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
        lineupGeneration: {
          type: 'string',
          enum: ['filled', 'fallback', 'none'],
          description: "Lineup generation mode: 'filled' (generate lineups when poll is filled), 'fallback' (poll is filled but no manual lineups have been posted on group until lineupLeadTime before play time), or 'none' (no automatic lineup generation)."
        },
        lineupLeadTime: {
          type: 'string',
          description: "Configurable amount of time before play time to generate lineups if no manual lineups posted (e.g. '30m', '1h', '2 hours'). Defaults to 30 mins."
        },
        reminders: {
          type: 'boolean',
          description: "Whether automated match reminder notifications are enabled for this poll (default: true)."
        },
        slotCheck: {
          type: 'boolean',
          description: "Whether to warn if players vote on the same slot (true for separate slots like Player 1, Player 2; false for shared options like Yes/No)."
        },
        checkCourts: {
          type: 'boolean',
          description: 'Whether to check and consider SCVCC court availability for the match time (default: false). Set to true only if the user explicitly asks to consider or check court availability (e.g. "with courts", "check courts", "consider court availability", "--courts").'
        },
        includeCourts: {
          type: 'boolean',
          description: 'Alias for checkCourts. Whether to check and consider SCVCC court availability in the poll (default: false).'
        },
        '--pre-allocate-slots': {
          type: 'boolean',
          description: "Whether to include named voting slots for booking players on prebooked courts (e.g. \"Conrad's Spot\"). Defaults to false (standard numbered slots like Player 1, Player 2 are used)."
        },
        'pre-allocate-slots': {
          type: 'boolean',
          description: "Whether to include named voting slots for booking players on prebooked courts (e.g. \"Conrad's Spot\"). Defaults to false (standard numbered slots like Player 1, Player 2 are used)."
        },
        preAllocateSlots: {
          type: 'boolean',
          description: "Whether to include named voting slots for booking players on prebooked courts. Defaults to false."
        },
        'prebooked-spots': {
          type: 'boolean',
          description: "Legacy alias for pre-allocate-slots."
        },
        includePrebookedSpots: {
          type: 'boolean',
          description: "Legacy alias for pre-allocate-slots."
        },
        courtBookingType: {
          type: 'string',
          enum: ['pre-book', 'none'],
          description: 'Optional court booking type. If "pre-book", automatically books a court in advance before creating the poll instance.'
        },
        preBookCourts: {
          type: 'integer',
          description: "Optional number of courts to pre-book when poll size is 'auto'. If not specified, uses group setting or defaults to 1."
        },
        bookingPlayers: {
          description: 'Optional player names to use for court pre-booking. Can be a single list of names (e.g. ["P1", "P2"]) or multiple lists for booking more than one court (e.g. [["P1", "P2"], ["P3", "P4"]]). If omitted, the default list from group configuration is used.'
        },
        lookAround: {
          type: 'string',
          description: 'Optional look around period/window around poll start time (e.g. "1 hour", "1h", "30m", "60 mins") to search for prebooked courts and retry court booking across subsequent 30-min start times if needed.'
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
    name: "parse_lineup",
    description: "Parses, extracts, and records a tennis match lineup, court assignments, teams, or rotations from message text or structured input. Attributes the lineup to the matching active or resolved match poll in the chat, records the draw in pair history, and ensures player ratings are tracked. Always call this tool when a user shares, posts, updates, or asks to parse or record match lineups, court assignments, or matchups (e.g. \"Court 1: Alice & Bob vs Charlie & Dave\", \"Set 1: Court 2 Mike / Sara vs John / Alex\", \"@P1 @P2 @P3 @P4 - Court 6 7pm\").",
    input_schema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The raw message text containing the lineup, court assignments, or matchups."
        },
        pollId: {
          type: "string",
          description: "Optional specific poll ID to attribute the lineup to."
        },
        pollName: {
          type: "string",
          description: "Optional poll name or time keyword (e.g. \"9am\", \"6pm\") to match the specific poll."
        },
        lineup: {
          type: "object",
          description: "Optional pre-parsed structured lineup object with type (\"singles\"|\"doubles\"), optional time, players array, and sets array with courts and teamA/teamB.",
          properties: {
            type: {
              type: "string",
              enum: ["singles", "doubles"],
              description: "Format of the match: singles or doubles."
            },
            time: {
              type: "string",
              description: "Optional match time (e.g. \"9:00am\", \"7pm\")."
            },
            players: {
              type: "array",
              items: { type: "string" },
              description: "List of all player names participating in the lineup."
            },
            sets: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  set: { type: "integer" },
                  courts: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        court: { type: "integer" },
                        teamA: { type: "array", items: { type: "string" } },
                        teamB: { type: "array", items: { type: "string" } }
                      },
                      required: ["court", "teamA", "teamB"]
                    }
                  }
                },
                required: ["set", "courts"]
              }
            }
          }
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
        lineupGeneration: {
          type: 'string',
          enum: ['filled', 'fallback', 'none'],
          description: "Lineup generation mode: 'filled' (generate lineups when poll is filled), 'fallback' (poll is filled but no manual lineups have been posted on group until lineupLeadTime before play time), or 'none' (no automatic lineup generation)."
        },
        lineupLeadTime: {
          type: 'string',
          description: "Configurable amount of time before play time to generate lineups if no manual lineups posted (e.g. '30m', '1h', '2 hours'). Defaults to 30 mins."
        },
        reminders: {
          type: 'boolean',
          description: "Whether to enable automated match reminder notifications for poll instances created from this schedule (default: true)."
        },
        slotCheck: {
          type: 'boolean',
          description: "Whether to warn if players vote on the same slot (true for separate slots like Player 1, Player 2; false for shared options like Yes/No)."
        },
        checkCourts: {
          type: 'boolean',
          description: 'Optional: whether to check and consider SCVCC court availability when posting recurring polls (default: false).'
        },
        includeCourts: {
          type: 'boolean',
          description: 'Optional: whether to check and consider SCVCC court availability (default: false).'
        },
        '--pre-allocate-slots': {
          type: 'boolean',
          description: 'Whether to include named voting slots for booking players on prebooked courts in recurring polls. Defaults to false.'
        },
        'pre-allocate-slots': {
          type: 'boolean',
          description: 'Whether to include named voting slots for booking players on prebooked courts in recurring polls. Defaults to false.'
        },
        preAllocateSlots: {
          type: 'boolean',
          description: 'Whether to include named voting slots for booking players on prebooked courts in recurring polls. Defaults to false.'
        },
        'prebooked-spots': {
          type: 'boolean',
          description: 'Legacy alias for pre-allocate-slots.'
        },
        includePrebookedSpots: {
          type: 'boolean',
          description: 'Legacy alias for pre-allocate-slots.'
        },
        courtBookingType: {
          type: 'string',
          enum: ['pre-book', 'none'],
          description: 'Optional court booking type. If "pre-book", automatically books a court in advance before posting each recurring poll instance.'
        },
        preBookCourts: {
          type: 'integer',
          description: "Optional number of courts to pre-book when recurring poll size is 'auto'. If not specified, uses group setting or defaults to 1."
        },
        bookingPlayers: {
          description: 'Optional player names to use for advance court booking. Can be multiple lists for booking more than one court. If omitted, the group configuration default list will be used.'
        },
        bookingStrategy: {
          type: 'string',
          enum: ['advanced', 'instant', 'none'],
          description: 'Optional court booking strategy. Set to "advanced" to pre-book courts in advance according to bookingSchedule.'
        },
        bookingSchedule: {
          type: 'string',
          description: 'Optional schedule specifying when to book courts in advance (e.g. "-7days 7:00AM").'
        },
        startDate: {
          type: 'string',
          description: 'Optional start date for the recurring poll schedule (e.g. "2026-10-15", "10/15/2026", "Oct 15", "tomorrow", "next Monday"). No polls or bookings will be created for matches before this date.'
        },
        endDate: {
          type: 'string',
          description: 'Optional end date for the recurring poll schedule (e.g. "2026-11-15", "11/15/2026", "Nov 15"). No polls or bookings will be created for matches after this date.'
        },
        lookAround: {
          type: 'string',
          description: 'Optional look around period/window around poll start time (e.g. "1 hour", "1h", "30m", "60 mins") to search for prebooked courts and retry court booking across subsequent 30-min start times if needed.'
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
        lineupGeneration: {
          type: 'string',
          enum: ['filled', 'fallback', 'none'],
          description: "Lineup generation mode: 'filled' (generate lineups when poll is filled), 'fallback' (poll is filled but no manual lineups have been posted on group until lineupLeadTime before play time), or 'none' (no automatic lineup generation)."
        },
        lineupLeadTime: {
          type: 'string',
          description: "Configurable amount of time before play time to generate lineups if no manual lineups posted (e.g. '30m', '1h', '2 hours'). Defaults to 30 mins."
        },
        reminders: {
          type: 'boolean',
          description: "Optional: whether to enable (true) or disable (false) automated match reminders for poll instances."
        },
        slotCheck: {
          type: 'boolean',
          description: "Whether to warn if players vote on the same slot (true for separate slots like Player 1, Player 2; false for shared options like Yes/No)."
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
        '--pre-allocate-slots': {
          type: 'boolean',
          description: 'Optional: whether to include named voting slots for booking players on prebooked courts.'
        },
        'pre-allocate-slots': {
          type: 'boolean',
          description: 'Optional: whether to include named voting slots for booking players on prebooked courts.'
        },
        preAllocateSlots: {
          type: 'boolean',
          description: 'Optional alias for pre-allocate-slots.'
        },
        'prebooked-spots': {
          type: 'boolean',
          description: 'Legacy alias for pre-allocate-slots.'
        },
        includePrebookedSpots: {
          type: 'boolean',
          description: 'Legacy alias for pre-allocate-slots.'
        },
        courtBookingType: {
          type: 'string',
          enum: ['pre-book', 'none'],
          description: 'Optional new court booking type ("pre-book" or "none").'
        },
        preBookCourts: {
          type: 'integer',
          description: "Optional number of courts to pre-book when recurring poll size is 'auto'."
        },
        bookingPlayers: {
          description: 'Optional player names to use for advance booking (multiple lists supported for multiple courts).'
        },
        bookingStrategy: {
          type: 'string',
          enum: ['advanced', 'instant', 'none'],
          description: 'Optional new court booking strategy (e.g. "advanced").'
        },
        bookingSchedule: {
          type: 'string',
          description: 'Optional new schedule specifying when to book courts in advance (e.g. "-7days 7:00AM").'
        },
        startDate: {
          type: 'string',
          description: 'Optional new start date (e.g. "2026-10-15", "10/15/2026"), or "none"/"clear" to remove.'
        },
        endDate: {
          type: 'string',
          description: 'Optional new end date (e.g. "2026-11-15", "11/15/2026"), or "none"/"clear" to remove.'
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
        lineupGeneration: {
          type: 'string',
          enum: ['filled', 'fallback', 'none'],
          description: "Lineup generation mode: 'filled' (generate lineups when poll is filled), 'fallback' (poll is filled but no manual lineups have been posted on group until lineupLeadTime before play time), or 'none' (no automatic lineup generation)."
        },
        lineupLeadTime: {
          type: 'string',
          description: "Configurable amount of time before play time to generate lineups if no manual lineups posted (e.g. '30m', '1h', '2 hours'). Defaults to 30 mins."
        },
        reminders: {
          type: 'boolean',
          description: "Optional: whether automated match reminder notifications are enabled for this poll instance."
        },
        slotCheck: {
          type: 'boolean',
          description: "Whether to warn if players vote on the same slot (true for separate slots like Player 1, Player 2; false for shared options like Yes/No)."
        },
        checkCourts: {
          type: 'boolean',
          description: 'Optional: whether to check and consider SCVCC court availability.'
        },
        includeCourts: {
          type: 'boolean',
          description: 'Optional: whether to check and consider SCVCC court availability.'
        },
        '--pre-allocate-slots': {
          type: 'boolean',
          description: 'Optional: whether to include named slots for prebooked courts.'
        },
        'pre-allocate-slots': {
          type: 'boolean',
          description: 'Optional: whether to include named slots for prebooked courts.'
        },
        preAllocateSlots: {
          type: 'boolean',
          description: 'Optional alias for pre-allocate-slots.'
        },
        'prebooked-spots': {
          type: 'boolean',
          description: 'Legacy alias for pre-allocate-slots.'
        },
        courtBookingType: {
          type: 'string',
          enum: ['pre-book', 'none'],
          description: 'Optional court booking type ("pre-book" or "none").'
        },
        preBookCourts: {
          type: 'integer',
          description: "Optional number of courts to pre-book when poll size is 'auto'."
        },
        bookingPlayers: {
          description: 'Optional player names to use for advance booking (multiple lists supported for booking more than one court).'
        },
        lookAround: {
          type: 'string',
          description: 'Optional look around period/window around poll start time (e.g. "1 hour", "1h", "30m", "60 mins") to search for prebooked courts and retry court booking across subsequent 30-min start times if needed.'
        }
      },
      required: ['targetId']
    }
  },
  {
    name: 'pause_recurring_poll',
    description: 'Pauses a scheduled recurring match poll schedule so it will not automatically post polls until resumed, or until a specified date after which it resumes automatically. Can be paused by the schedule creator or group admins. Set scheduleId to "all" to pause all recurring polls.',
    input_schema: {
      type: 'object',
      properties: {
        scheduleId: {
          type: 'string',
          description: 'The schedule ID of the recurring poll to pause (e.g. "rec_1", "rec_mujmt71n") or "all" to pause all recurring schedules.'
        },
        untilDate: {
          type: 'string',
          description: 'Optional date or day until which the recurring poll is paused, after which it automatically resumes (e.g. "10/25/2026", "2026-10-25", "Oct 25", "Monday", "tomorrow"). If omitted, paused indefinitely until manually resumed.'
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
    description: 'Skips one or more specified upcoming instances (or the next N upcoming instances) of a scheduled recurring match poll without pausing or disabling future recurring schedules. If an instance was already created as an active poll on WhatsApp, it is cancelled and deleted. Subsequent instances remain active.',
    input_schema: {
      type: 'object',
      properties: {
        scheduleId: {
          type: 'string',
          description: 'The schedule ID of the recurring poll (e.g. "rec_1", "rec_mujmt71n"). If omitted and only one schedule exists, it will be automatically selected.'
        },
        count: {
          type: 'integer',
          description: 'Optional number of upcoming instances to skip (e.g. 1, 2, 3). Defaults to 1.'
        },
        targetDayOrDate: {
          type: 'string',
          description: 'Optional specific day of week (e.g. "wednesday", "tomorrow") or date (e.g. "2026-10-07", "10/7") of the instance to skip. If omitted, skips the next upcoming instance(s).'
        }
      }
    }
  },
  {
    name: 'unskip_recurring_poll_instance',
    description: 'Restores one or more previously skipped instances (or all skipped instances) for a scheduled recurring match poll so they will post automatically as scheduled.',
    input_schema: {
      type: 'object',
      properties: {
        scheduleId: {
          type: 'string',
          description: 'The schedule ID of the recurring poll (e.g. "rec_1", "rec_mujmt71n"). If omitted and only one schedule exists, it will be automatically selected.'
        },
        targetDayOrDate: {
          type: 'string',
          description: 'Optional specific day, date, count (e.g. "2"), or "all" to unskip. If omitted, restores the first skipped instance.'
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
    name: "cancel_court_reservation",
    description: "Cancels a tennis or pickleball court reservation at Silver Creek Valley Country Club (SCVCC) by reservation ID.",
    input_schema: {
      type: "object",
      properties: {
        reservationId: {
          type: "string",
          description: "The reservation ID to cancel (e.g. \"194192\", \"194147\")."
        }
      },
      required: ["reservationId"]
    }
  },
  {
    name: 'pause_court_bookings',
    description: 'Pauses court bookings (pre-booking and direct bookings) for a specific WhatsApp group or for all groups (superadmin only). Group admins can pause for their own group; superadmin can pause for any group or all groups.',
    input_schema: {
      type: 'object',
      properties: {
        group: {
          type: 'string',
          description: 'Group name or JID to pause court bookings for. Omit to pause for the current group, or set all=true for all groups.'
        },
        all: {
          type: 'boolean',
          description: 'Whether to pause court bookings across all groups (superadmin only).'
        }
      }
    }
  },
  {
    name: 'resume_court_bookings',
    description: 'Resumes court bookings (pre-booking and direct bookings) for a specific WhatsApp group or for all groups (superadmin only). Group admins can resume for their own group; superadmin can resume for any group or all groups.',
    input_schema: {
      type: 'object',
      properties: {
        group: {
          type: 'string',
          description: 'Group name or JID to resume court bookings for. Omit to resume for the current group, or set all=true for all groups.'
        },
        all: {
          type: 'boolean',
          description: 'Whether to resume court bookings across all groups (superadmin only).'
        }
      }
    }
  },
  {
    name: 'get_court_webcam',
    description: 'Retrieves and sends a live photo snapshot (or 10-second video clip) of the tennis courts at Silver Creek Valley Country Club (SCVCC). Call this tool whenever a user asks to see the court webcam, snapshot photo, check the camera feed, or see live conditions on the court (e.g. "show court webcam", "check webcam", "is it raining on the courts", "can I see the court camera", "show court video clip"). Default format is photo snapshot; set format="video" only when video/clip is specifically asked. Do not include live player links in user responses.',
    input_schema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['photo', 'video'],
          description: 'Format to retrieve: "photo" (default, instant snapshot) or "video" (10s video clip).'
        }
      }
    }
  },
  {
    name: "list_groups",
    description: "Lists all WhatsApp groups the bot is currently a participating member of, showing group names, WhatsApp JIDs, participant counts, and configuration status. Superadmin only via DM.",
    input_schema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "add_group",
    description: "Adds a WhatsApp group to the bot configuration (groups.json) and whitelist. Accepts group name or JID. Superadmin only via DM.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "WhatsApp group name/subject (or display name). If JID is not provided, the bot will search participating WhatsApp groups matching this name."
        },
        jid: {
          type: "string",
          description: "WhatsApp group JID (e.g. 120363403838804497@g.us). Optional if name is provided."
        },
        sport: {
          type: "string",
          enum: ["tennis", "pickleball"],
          description: "Default sport for the group."
        },
        courtBookingEnabled: {
          type: "boolean",
          description: "Whether court booking is enabled."
        },
        courtConfig: {
          type: "string",
          description: "Court configuration name from courts.json (e.g. 'SCVCC') if court functionality is available for the group."
        },
        autoMatchups: {
          type: "boolean",
          description: "Whether automatic player matchups are enabled."
        },
        directCourtBookingAccounts: {
          type: "array",
          items: { type: "string" },
          description: "Member full names authorized for direct court booking."
        },
        tentativeBookingTitles: {
          type: "array",
          items: { type: "string" },
          description: "Court booking titles that should be treated as tentative courts if booked (e.g. ['Club Event', 'Clinic'])."
        },
        preBookCourts: {
          type: "integer",
          description: "Number of courts to pre-book when poll size is 'auto' (defaults to 1 if not specified)."
        },
        defaultBookingPlayers: {
          description: "Default list of player names for pre-booking courts. Can be an array of player names (e.g. ['P1', 'P2']) or array of arrays for booking multiple courts (e.g. [['P1', 'P2'], ['P3', 'P4']])."
        },
        bookingNotifications: {
          type: "array",
          items: { type: "string" },
          description: "WhatsApp LIDs authorized to receive court booking confirmations and cancellation messages for this group."
        },
        bookingCourtPreference: {
          type: "array",
          items: { type: "integer" },
          description: "Preferred order of courts to book if available (e.g. [2, 3, 1, 5, 6])."
        },
        bookingStrategy: {
          type: "string",
          description: "Optional court booking strategy for this group ('advanced', 'instant', or 'none')."
        },
        bookingSchedule: {
          type: "string",
          description: "Optional schedule specifying when to book courts in advance (e.g. '-7days 7:00AM')."
        }
      }
    }
  },
  {
    name: "remove_group",
    description: "Removes a WhatsApp group from the bot configuration (groups.json) and whitelist. Superadmin only via DM.",
    input_schema: {
      type: "object",
      properties: {
        jidOrName: {
          type: "string",
          description: "WhatsApp group JID or group name to remove."
        }
      },
      required: ["jidOrName"]
    }
  },
  {
    name: "update_group_config",
    description: "Updates configuration settings for a WhatsApp group in groups.json. Superadmin only via DM.",
    input_schema: {
      type: "object",
      properties: {
        jidOrName: {
          type: "string",
          description: "WhatsApp group JID or group name to update."
        },
        name: {
          type: "string",
          description: "New display name."
        },
        alias: {
          type: "string",
          description: "Short alias for the group."
        },
        sport: {
          type: "string",
          enum: ["tennis", "pickleball"],
          description: "Sport for the group."
        },
        courtBookingEnabled: {
          type: "boolean",
          description: "Whether court booking is enabled."
        },
        courtConfig: {
          type: "string",
          description: "Court configuration name from courts.json (e.g. 'SCVCC') if court functionality is available for the group."
        },
        autoMatchups: {
          type: "boolean",
          description: "Whether automatic player matchups are enabled."
        },
        directCourtBookingAccounts: {
          type: "array",
          items: { type: "string" },
          description: "Authorized member full names for direct court booking."
        },
        ignoredCourts: {
          type: "array",
          items: { type: "string" },
          description: "Courts to ignore."
        },
        tentativeBookingTitles: {
          type: "array",
          items: { type: "string" },
          description: "Court booking titles that should be treated as tentative courts if booked (e.g. ['Club Event', 'Clinic'])."
        },
        preBookCourts: {
          type: "integer",
          description: "Number of courts to pre-book when poll size is 'auto' (defaults to 1 if not specified)."
        },
        defaultBookingPlayers: {
          description: "Default list of player names for pre-booking courts. Can be an array of player names (e.g. ['P1', 'P2']) or array of arrays for multiple courts (e.g. [['P1', 'P2'], ['P3', 'P4']])."
        },
        bookingNotifications: {
          type: "array",
          items: { type: "string" },
          description: "WhatsApp LIDs authorized to receive court booking confirmations and cancellation messages for this group."
        },
        bookingCourtPreference: {
          type: "array",
          items: { type: "integer" },
          description: "Preferred order of courts to book if available (e.g. [2, 3, 1, 5, 6])."
        },
        bookingStrategy: {
          type: "string",
          description: "Optional court booking strategy for this group ('advanced', 'instant', or 'none')."
        },
        bookingSchedule: {
          type: "string",
          description: "Optional schedule specifying when to book courts in advance (e.g. '-7days 7:00AM')."
        }
      },
      required: ["jidOrName"]
    }
  },
  {
    name: "get_group_config",
    description: "Retrieves configuration details for one or all groups from groups.json. Superadmin only via DM.",
    input_schema: {
      type: "object",
      properties: {
        jidOrName: {
          type: "string",
          description: "Optional group JID or name. If omitted, returns all configured groups."
        }
      }
    }
  },
];

// Attach cache_control to the last tool so Anthropic caches all tool definitions as a single prefix block
const CACHED_CLAUDE_TOOLS = CLAUDE_TOOLS.map((tool, idx) =>
  idx === CLAUDE_TOOLS.length - 1 ? { ...tool, cache_control: { type: 'ephemeral' } } : tool
);

module.exports = {
  CLAUDE_TOOLS,
  CACHED_CLAUDE_TOOLS
};
