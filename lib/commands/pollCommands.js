/**
 * Match Poll Commands & Lifecycle Management
 * Handles:
 *   - Poll creation (fixed spots, Yes/No opt-in, pre-booked court spots)
 *   - Poll voting, vote decryption, conflict detection & tagging
 *   - Roster resolution (fixed-spot & manual user polls)
 *   - Matchup generation and re-draws/rematches
 *   - Poll reminders (powers-of-2 scheduling, quiet hours)
 *   - Poll control (!stoppoll, !resumepoll, !cancelpoll, !cleanuppolls, !clearallpolls, !deleteallpolls)
 *   - Poll status & inspection (!pollstatus, !activepolls, !upcomingpolls, !allpolls)
 *   - Poll instance modification & slot limits (!modifyinstance, !setslots)
 */

const {
  getAggregateVotesInPollMessage,
  decryptPollVote,
  jidNormalizedUser
} = require('@whiskeysockets/baileys');

const ratings = require('../ratings');
const namesStore = require('../names');
const messageHistory = require('../messageHistory');
const recurringPollsModule = require('../recurringPolls');
const scvcc = require('../scvcc');
const groupsConfig = require('../groupsConfig');
const courtsConfig = require('../courtsConfig');
const anthropic = require('../anthropic');
const pollTime = require('../pollTime');
const pairHistory = require('../pairHistory');
const {
  generateMatchups,
  formatMatchups,
  summarizeSchedule
} = require('../matchups');
const { isUserAdmin, isSameUser, getTargetGroupJid, getGroupMetadata } = require('./groupCommands');
const { sendBookingNotifications } = require('./courtCommands');

const { resolvePlayDateTime, getSanJoseNow, getSanJoseParts, WORD_TO_NUMBER, NUMBER_WORDS_PATTERN } = pollTime;

const TRIGGER_PREFIX = '@tenbot';
const GENERIC_NAMES = new Set(['someone', 'player', 'player 1', 'player 2', 'player 3', 'player 4', 'me']);
const POLL_EXPIRY_GRACE_DAYS = 14;
const POLL_REMINDER_HOURS = [1, 2, 4, 8, 16, 24, 32, 64];
const POWERS_OF_2_REMINDER_HOURS = POLL_REMINDER_HOURS;
const MAX_POLL_REMINDERS = 2;

const inFlightPollCreations = new Set();

const storeKey = (remoteJid, id) => `${remoteJid}:${id}`;

function nameFor(jid) {
  if (!jid || jid === 'me') return 'Me';
  const norm = jidNormalizedUser(jid) || jid;
  const registeredName = namesStore.getName(norm) || namesStore.getName(jid);
  if (registeredName) return registeredName;
  const pn = namesStore.getPnByLid(norm);
  const digits = (pn || norm || jid).split('@')[0].replace(/\D/g, '');
  if (digits.length >= 4) return `Player (${digits.slice(-4)})`;
  return digits ? `Player (${digits})` : 'Player';
}

function isMatchSchedulingPoll(title = '', options = []) {
  const text = `${title} ${options.join(' ')}`.toLowerCase();
  const matchKeywords = /\b(tennis|match|matches|court|courts|singles|doubles|play|playing|players|player|game|games|drill|drills|session|hit|hitting|schedule|scheduling|scvcc)\b/i;
  const timeKeywords = /\b(today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|morning|evening|afternoon)\b|\b\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)\b|\b\d{1,2}[:.]\d{2}\b/i;
  const slotKeywords = /\b(?:player|spot|slot|court|p)\s*#?\s*\d+|\b\d+\b/i;
  const hasOptInOrSlot = options.some((opt) => /^(yes|no|in|out|playing|can't play)$/i.test(opt.trim()) || slotKeywords.test(opt.trim()));

  if (matchKeywords.test(text)) return true;
  if (timeKeywords.test(title) && hasOptInOrSlot) return true;
  return false;
}

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

CRITICAL INSTRUCTION: You MUST return strictly valid JSON format only, starting with { and ending with }. Do NOT enclose in markdown code blocks and do not output any preamble, commentary, or extra text.
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
    if (parsed.dayWord && !/^(?:today|tomorrow|tonight)$/i.test(parsed.dayWord) && /^(?:tomorrow|today)\b/i.test(resolvedWhenStr)) {
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

function isValidPlayerCount(n) {
  return n === 2 || (n >= 4 && n % 4 === 0);
}

function getNextValidPlayerCount(n) {
  if (n <= 2) return 2;
  return Math.ceil(n / 4) * 4;
}

function getFirstSlotNumber(options) {
  if (!options || options.length === 0) return null;
  const firstLabel = String(options[0]).trim();
  const match = firstLabel.match(/^(?:player|spot|slot|court|p|#|no\.?|num\.?)\s*#?\s*(\d+)\b/i) ||
    firstLabel.match(/\b(\d+)\b/);
  if (match) {
    const num = parseInt(match[1], 10);
    if (Number.isFinite(num) && num >= 1) return num;
  }
  return null;
}

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

function resolveManualPollPlayers(targetPollState, currentPlayers) {
  const creatorName = targetPollState.creator?.name || (targetPollState.creator?.jid ? nameFor(targetPollState.creator.jid) : 'Creator');
  const options = targetPollState.options || [];
  const firstSlotNum = getFirstSlotNumber(options);

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

  if (firstSlotNum && firstSlotNum > 1) {
    const leadingNeeded = firstSlotNum - 1;
    for (let i = 0; i < leadingNeeded; i++) {
      const name = addNextCreatorPlayer(players, creatorName);
      addedFromLabel.push(name);
    }
  }

  for (const p of currentPlayers) {
    if (!players.some((existing) => ratings.keyFor(existing) === ratings.keyFor(p))) {
      players.push(p);
    }
  }

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
  for (let i = 0; i < leadingSpots; i++) {
    addNextCreatorPlayer(allPlayers, creatorName);
  }

  let filledCount = leadingSpots;
  const totalSlotsCount = leadingSpots + options.length;

  for (const opt of options) {
    const voterJid = slotMap.get(opt);
    if (voterJid) {
      const playerName = nameFor(voterJid);
      allPlayers.push(playerName);
      filledCount++;
    } else if (prebookedSlotMap.has(opt)) {
      const defaultPlayer = prebookedSlotMap.get(opt);
      allPlayers.push(defaultPlayer);
      filledCount++;
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

function getPollVoters(pollId, pollState, mePn, messageStore) {
  let pollCreationMessage = messageStore ? messageStore.get(storeKey(pollState.remoteJid, pollId)) : null;
  if (!pollCreationMessage && messageStore) {
    for (const [k, v] of messageStore.entries()) {
      if (k.endsWith(`:${pollId}`)) {
        pollCreationMessage = v;
        break;
      }
    }
  }

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

function parsePollCreationText(text) {
  if (!text) return null;

  const isPollCreationCommand = /^!(?:createpoll|poll|makepoll|newpoll|optinpoll|yesnopoll|createoptinpoll|createyesnopoll)\b/i.test(text);
  const isPollCreationPhrase = /\b(?:create|make|post|start|set\s*up|setup|open|put|put\s*up|add|send|run|do)\s+(?:a\s+)?(?:match\s+)?(?:singles\s+|doubles\s+|yes\/no\s+|yesno\s+|opt-?in\s+)?poll\b|\bnew\s+(?:match\s+)?(?:singles\s+|doubles\s+|yes\/no\s+|yesno\s+|opt-?in\s+)?poll\b|\b(?:opt-?in|yes\s*\/\s*no|yesno)\s+poll\b|\bpoll\s+for\b/i.test(text);

  if (!isPollCreationCommand && !isPollCreationPhrase) {
    return null;
  }

  if (/\b(?:daily|recurring|repeating|every\s*day)\b/i.test(text)) {
    return null;
  }

  const { flags, remainingText: textCleanFlags } = recurringPollsModule.extractCommonFlags(text);

  let timeWord = null;
  const timeMatch = textCleanFlags.match(/\b(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm))\b/i) || textCleanFlags.match(/\b(\d{1,2}[:.]\d{2})\b/i);
  if (timeMatch) {
    timeWord = timeMatch[1].trim();
  }

  let dayWord = null;
  const dayMatch = textCleanFlags.match(/\b(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i);
  if (dayMatch) {
    dayWord = dayMatch[1];
  }

  let when = null;
  if (dayWord && timeWord) {
    const capDay = dayWord.charAt(0).toUpperCase() + dayWord.slice(1).toLowerCase();
    when = `${capDay} ${timeWord}`;
  } else if (timeWord) {
    when = timeWord;
  } else if (dayWord) {
    when = dayWord.charAt(0).toUpperCase() + dayWord.slice(1).toLowerCase();
  }

  let court = null;
  const courtMatch = textCleanFlags.match(/\b(?:on\s+|at\s+|for\s+)?(?:the\s+)?(court\s*#?\s*\d+|pickleball\s*#?\s*\d+|pb\s*#?\s*\d+)\b/i);
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

  let textWithoutTime = textCleanFlags;
  if (timeMatch) {
    textWithoutTime = textWithoutTime.replace(timeMatch[0], ' ');
  }
  textWithoutTime = textWithoutTime.replace(/\b\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)\b/ig, ' ').replace(/\b\d{1,2}[:.]\d{2}\b/g, ' ');
  let textCleanedForSize = textWithoutTime.replace(/\b(?:on\s+|at\s+|for\s+)?(?:the\s+)?(?:courts?|pickleball|pb)\s*#?\s*\d+\b/gi, ' ');

  const isExplicitOptIn = /\b(?:opt-?in|yes\s*\/\s*no|yesno|open)\b/i.test(textCleanFlags) ||
    /^!(?:optinpoll|yesnopoll|createoptinpoll|createyesnopoll)\b/i.test(text);
  let size = null;
  if (!isExplicitOptIn) {
    if (/\bauto\b/i.test(textCleanedForSize) || /\bauto[-_\s]*(?:spots?|players?|courts?|size)\b/i.test(textCleanedForSize)) {
      size = 'auto';
    } else {
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

  let includeCreator = flags.includeCreator !== undefined
    ? flags.includeCreator
    : !(/\b(?:not\s+playing|won't\s+play|wont\s+play|without\s+me|exclude\s+me|not\s+for\s+me|i'm\s+not\s+playing|im\s+not\s+playing)\b/i.test(text));

  let cancelExisting = false;
  if (/\b(?:replace|cancel\s+existing|cancel\s+previous|update\s+poll|change\s+poll|reschedule)\b/i.test(text)) {
    cancelExisting = true;
  }

  const noMatchups = flags.noMatchups !== undefined ? flags.noMatchups : false;
  const checkCourts = flags.checkCourts !== undefined ? flags.checkCourts : false;
  const includePrebookedSpots = flags.includePrebookedSpots !== undefined ? flags.includePrebookedSpots : false;
  const courtBookingType = flags.courtBookingType || null;
  const preBookCourts = flags.preBookCourts || null;
  const bookingPlayers = flags.bookingPlayers || null;
  const bookingStrategy = flags.bookingStrategy || null;
  const bookingSchedule = flags.bookingSchedule || null;

  return {
    courtBookingType,
    preBookCourts,
    bookingPlayers,
    bookingStrategy,
    bookingSchedule,
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

async function handleDirectPollCreation(sock, chatId, sender, msg, parsed, opts = {}, context) {
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

  const courtBookingType = parsed.courtBookingType || null;
  const bookingPlayers = parsed.bookingPlayers || null;

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
    court,
    courtBookingType,
    bookingPlayers,
    parsed.preBookCourts || null,
    null,
    null,
    context
  );

  if (res?.err) {
    if (res.noCourtsAvailable) {
      return null;
    }
    return `Could not create poll: ${res.err}`;
  }

  return null;
}

function isUserInPoll(pollState, userJid, userName) {
  if (!pollState) return false;

  if (pollState.creator) {
    if (isSameUser(pollState.creator.jid, userJid, pollState.creator.name, userName)) {
      return true;
    }
  }

  if (pollState.voteBuffer && pollState.voteBuffer instanceof Map) {
    for (const voterJid of pollState.voteBuffer.keys()) {
      const voterName = nameFor(voterJid);
      if (isSameUser(voterJid, userJid, voterName, userName)) {
        return true;
      }
    }
  }

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

function getMessageSecret(creationMessage) {
  const secret = creationMessage?.messageContextInfo?.messageSecret;
  if (!secret) return null;
  if (Buffer.isBuffer(secret)) return secret;
  if (secret instanceof Uint8Array) return Buffer.from(secret);
  if (typeof secret === 'string') return Buffer.from(secret, 'base64');
  if (secret.type === 'Buffer' && Array.isArray(secret.data)) return Buffer.from(secret.data);
  return Buffer.from(secret);
}

function normalizeVotePayload(vote) {
  if (!vote) return vote;
  if (Array.isArray(vote.selectedOptions)) {
    return {
      ...vote,
      selectedOptions: vote.selectedOptions.map((opt) => {
        if (Buffer.isBuffer(opt)) return opt;
        if (opt && opt.__type === 'Uint8Array' && opt.base64) return Buffer.from(opt.base64, 'base64');
        if (typeof opt === 'string') return Buffer.from(opt, 'base64');
        if (opt instanceof Uint8Array || Array.isArray(opt)) return Buffer.from(opt);
        if (opt && opt.type === 'Buffer' && Array.isArray(opt.data)) return Buffer.from(opt.data);
        return Buffer.from(opt);
      })
    };
  }
  return vote;
}

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

function handlePollDeleted(remoteJid, pollId, context) {
  if (!pollId || !context) return;
  const { activePolls, messageStore, latestPollIdByChat, persistPolls } = context;
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

  for (const key of messageStore.keys()) {
    if (key.endsWith(`:${pollId}`)) {
      messageStore.delete(key);
      changed = true;
    }
  }

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

async function cancelOrDeletePoll(sock, remoteJid, pollId, context) {
  if (!pollId) return;
  handlePollDeleted(remoteJid, pollId, context);
  await deletePollFromWhatsApp(sock, remoteJid, pollId);
}

async function handleDeleteAllPolls(sock, chatId, senderJid, context) {
  const { activePolls, latestPollIdByChat, persistPolls } = context;
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
      await cancelOrDeletePoll(sock, targetChat, pollId, context);
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

async function handleClearAllPolls(sock, chatId, senderJid, context) {
  const { activePolls, latestPollIdByChat, persistPolls } = context;
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

function cleanupExpiredPolls(context) {
  const { activePolls, messageStore, latestPollIdByChat, persistPolls } = context;
  const now = Date.now();
  const graceMs = POLL_EXPIRY_GRACE_DAYS * 24 * 60 * 60 * 1000;
  const removed = [];
  let statusChanged = false;

  for (const [pollId, pollState] of activePolls.entries()) {
    if (!pollState.playAt) continue;
    const playAtMs = new Date(pollState.playAt).getTime();
    if (Number.isNaN(playAtMs)) continue;

    if (now >= playAtMs && (pollState.status === 'active' || pollState.status === 'filled' || pollState.status === 'stopped')) {
      pollState.status = 'expired';
      statusChanged = true;
      console.log(`[poll] Match play time passed for poll ${pollId} ("${pollState.name || pollState.when}"): status automatically set to expired.`);
    }

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
      return `⏰ *${currentH} Hours (${dayStr}) to Playtime!* We have *${yesCount} player(s) in* so far for *${whenStr}*.\n` +
        `Players in: ${playerList}\n` +
        `Don't miss out — cast your vote above to join the match!`;
    }
    if (effHours >= 16) {
      return `⏰ *${currentH} Hours to Playtime!* We have *${yesCount} player(s) in* so far for *${whenStr}*.\n` +
        `Players in: ${playerList}\n` +
        `Don't miss out — cast your vote above to join the match!`;
    }
    if (effHours >= 8) {
      return `🎾 *${currentH} Hours to Match Time!* We currently have *${yesCount} player(s) in* for *${whenStr}*.\n` +
        `Current lineup: ${playerList}\n` +
        `Who else is ready to play? Vote Yes in the poll above! 🎾⚡`;
    }
    if (effHours >= 4) {
      return `🔥 *${currentH} Hours Until Court Time!* *${yesCount} player(s)* lined up for *${whenStr}*!\n` +
        `Roster: ${playerList}\n` +
        `Cast your vote above if you want in on today's session!`;
    }
    if (effHours >= 2) {
      return `⚡ *${currentH} HOURS TO GO!* *${yesCount} player(s)* confirmed for *${whenStr}*!\n` +
        `Ready on court: ${playerList}\n` +
        `Vote Yes now before teams and matchups are drawn! 🎾🏃‍♂️💨`;
    }
    if (effHours >= 1) {
      const hourWord = currentH === 1 ? '1 HOUR LEFT' : `${currentH} HOURS LEFT`;
      return `🚨 *FINAL CALL: ${hourWord}!* *${yesCount} player(s) in* for *${whenStr}*!\n` +
        `Current roster: ${playerList}\n` +
        `Last chance to vote Yes before match time! 🏆🎾🔥`;
    }
    return `⚡ *${currentMins} MINUTES REMAINING!* *${yesCount} player(s) in* for *${whenStr}*!\n` +
      `Current roster: ${playerList}\n` +
      `Final countdown to vote Yes before matchups are locked in! 🏆🎾⚡`;
  }

  if (effHours >= 32) {
    return `🎾 *Match Alert:* The match poll for *${whenStr}* still has *${openSpots} open ${spotWord}* (${openSpots}/${totalSpots} needed).\n` +
      `Current players: ${playerList}\n` +
      `Vote in the poll above to lock in your spot!`;
  }
  if (effHours >= 24) {
    const days = Math.round(effHours / 24);
    const dayStr = days === 1 ? '1 Day' : `${days} Days`;
    return `⏰ *${currentH} Hours (${dayStr}) to Playtime!* We have *${openSpots} ${spotWord} remaining* for *${whenStr}* (${openSpots}/${totalSpots} needed).\n` +
      `Roster so far: ${playerList}\n` +
      `Don't miss out — cast your vote above to join the court!`;
  }
  if (effHours >= 16) {
    return `⏰ *${currentH} Hours to Playtime!* We have *${openSpots} ${spotWord} remaining* for *${whenStr}* (${openSpots}/${totalSpots} needed).\n` +
      `Roster so far: ${playerList}\n` +
      `Don't miss out — cast your vote above to join the court!`;
  }
  if (effHours >= 8) {
    return `🎾 *${currentH} Hours to Match Time!* We still need *${openSpots} more ${playerWord}* to complete the court for *${whenStr}* (${totalSpots} total spots).\n` +
      `Current lineup: ${playerList}\n` +
      `Who's ready to hit some winners today? Claim your spot!`;
  }
  if (effHours >= 4) {
    return `🔥 *${currentH} Hours Until Court Time!* Only *${openSpots} ${spotWord} left* for *${whenStr}*!\n` +
      `Lined up to play: ${playerList}\n` +
      `Racquets ready? Grab the open ${spotWord} before it fills up! 🎾⚡`;
  }
  if (effHours >= 2) {
    return `⚡ *${currentH} HOURS TO GO!* We only need *${openSpots} more ${playerWord}* to make the match happen at *${whenStr}*!\n` +
      `Ready on court: ${playerList}\n` +
      `Don't leave the squad hanging — step up and claim the final ${spotWord}! 🎾🏃‍♂️💨`;
  }
  if (effHours >= 1) {
    const hourWord = currentH === 1 ? '1 HOUR LEFT' : `${currentH} HOURS LEFT`;
    return `🚨 *FINAL CALL: ${hourWord}!* Just *${openSpots} ${spotWord} open* for *${whenStr}*!\n` +
      `Current roster: ${playerList}\n` +
      `Who's coming through in the clutch? Vote now and let's play! 🏆🎾🔥`;
  }
  return `⚡ *${currentMins} MINUTES TO GO!* Still need *${openSpots} more ${playerWord}* for *${whenStr}*!\n` +
    `Current lineup: ${playerList}\n` +
    `Last chance to grab the remaining ${spotWord} before match time! 🏆🎾⚡`;
}

function isAutoCreatedPoll(pollState) {
  if (!pollState) return false;
  if (pollState.isAuto || pollState.isRecurring || pollState.isAutoCreated || pollState.autoCreated) return true;
  if (Array.isArray(pollState.prebookedCourts) && pollState.prebookedCourts.length > 0) return true;
  if (Array.isArray(pollState.prebookedPlayers) && pollState.prebookedPlayers.length > 0) return true;
  if (pollState.scheduleId || pollState.recurringScheduleId) return true;
  return false;
}

async function sendPollReminder(sock, pollId, pollState, isManualTrigger = false, context) {
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

  let totalSpots = 0;
  let neededVotes = 0;
  let openSpots = 0;
  let yesCount = 0;

  const { interestedPlayers, aggregated } = getPollVoters(pollId, pollState, mePn, context.messageStore);
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

  const storedMessage = context.messageStore ? context.messageStore.get(storeKey(pollState.remoteJid, pollId)) : null;
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
  if (context.persistPolls) context.persistPolls();
  return true;
}

function findSpecificPoll(target, activePolls, recurringPolls) {
  if (!target) return null;
  const clean = String(target).replace(/^["']|["']$/g, '').trim().toLowerCase();

  for (const [id, state] of activePolls.entries()) {
    if (id.toLowerCase() === clean) return { pollId: id, pollState: state };
  }

  for (const [id, state] of activePolls.entries()) {
    const sid = getPollScheduleId(state, recurringPolls);
    if ((sid && sid.toLowerCase() === clean) || (state.scheduleId && state.scheduleId.toLowerCase() === clean)) {
      return { pollId: id, pollState: state };
    }
  }

  for (const [id, state] of activePolls.entries()) {
    const pName = (state.name || '').toLowerCase();
    const pWhen = (state.when || '').toLowerCase();
    if (pName.includes(clean) || pWhen.includes(clean) || clean.includes(pWhen)) {
      return { pollId: id, pollState: state };
    }
  }

  return null;
}

function getPollScheduleId(pollState, recurringPolls) {
  if (!pollState) return null;
  if (pollState.scheduleId) return pollState.scheduleId;
  if (!pollState.isRecurring) return null;
  if (recurringPolls) {
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

async function handleTriggerReminder(sock, chatId, sender, specificPollId = null, context) {
  const { activePolls, recurringPolls } = context;
  let targetPolls = [];

  if (specificPollId) {
    const found = findSpecificPoll(specificPollId, activePolls, recurringPolls);
    if (!found) {
      return `⚠️ No match poll found matching "${specificPollId}". Use "!activepolls" or "!pollstatus" to check active poll IDs.`;
    }
    const { pollId, pollState } = found;
    if (pollState.status === 'active') {
      targetPolls.push([pollId, pollState]);
    } else {
      return `⚠️ Poll "${pollState.name || pollState.when || pollId}" has status "${pollState.status}" (reminders can only be triggered for active polls).`;
    }
  } else {
    const isDM = Boolean(chatId && !chatId.endsWith('@g.us'));
    const effectiveChatId = isDM ? (context.targetGroupJid || null) : chatId;
    for (const [id, state] of activePolls.entries()) {
      if ((isDM || state.remoteJid === effectiveChatId) && state.status === 'active') {
        targetPolls.push([id, state]);
      }
    }
  }

  if (targetPolls.length === 0) {
    return 'No active match polls found to send reminders for.';
  }

  let sentCount = 0;
  for (const [id, state] of targetPolls) {
    try {
      const sent = await sendPollReminder(sock, id, state, true, context);
      if (sent) sentCount++;
    } catch (err) {
      console.error(`[poll] Failed to send manual reminder for poll ${id}:`, err.message);
    }
  }

  console.log(`[reminders] Manual reminder triggered for ${sentCount}/${targetPolls.length} poll(s) in ${chatId} by ${sender}`);
  return null;
}

async function handlePauseReminders(sock, chatId, sender, specificPollId = null, context) {
  const { activePolls, recurringPolls, persistPolls } = context;
  if (specificPollId) {
    const found = findSpecificPoll(specificPollId, activePolls, recurringPolls);
    if (!found) {
      return `⚠️ No match poll found matching "${specificPollId}". Use "!activepolls" or "!pollstatus" to check active poll IDs.`;
    }

    const { pollId, pollState } = found;
    const pollName = pollState.name || pollState.when || pollId;

    if (pollState.status === 'resolved') {
      return `ℹ️ Poll "${pollName}" has already been resolved and drawn (reminders are not active).`;
    }
    if (pollState.status === 'expired') {
      return `ℹ️ Poll "${pollName}" has expired (scheduled match play time has passed).`;
    }
    if (pollState.status === 'cancelled') {
      return `ℹ️ Poll "${pollName}" was cancelled.`;
    }
    if (pollState.remindersPaused) {
      return `⏸️ Reminders for "${pollName}" are already paused. Use "!resumereminders" to resume them anytime.`;
    }

    pollState.remindersPaused = true;
    persistPolls();
    console.log(`[reminders] Reminders paused for poll ${pollId} ("${pollName}") by ${sender}`);
    return `⏸️ Reminders have been paused for "${pollName}". Use "!resumereminders ${pollId}" to resume them anytime.`;
  }

  const isDM = Boolean(chatId && !chatId.endsWith('@g.us'));
  const effectiveChatId = isDM ? (context.targetGroupJid || null) : chatId;
  const targetPolls = [];

  for (const [id, state] of activePolls.entries()) {
    if ((isDM || state.remoteJid === effectiveChatId) && (state.status === 'active' || state.status === 'filled')) {
      targetPolls.push([id, state]);
    }
  }

  if (targetPolls.length === 0) {
    return 'No active match polls found to pause reminders for.';
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

async function handleResumeReminders(sock, chatId, sender, specificPollId = null, context) {
  const { activePolls, recurringPolls, persistPolls } = context;
  if (specificPollId) {
    const found = findSpecificPoll(specificPollId, activePolls, recurringPolls);
    if (!found) {
      return `⚠️ No match poll found matching "${specificPollId}". Use "!activepolls" or "!pollstatus" to check active poll IDs.`;
    }

    const { pollId, pollState } = found;
    const pollName = pollState.name || pollState.when || pollId;

    if (pollState.status === 'resolved') {
      return `ℹ️ Poll "${pollName}" has already been resolved and drawn.`;
    }
    if (pollState.status === 'expired') {
      return `ℹ️ Poll "${pollName}" has expired (scheduled match play time has passed).`;
    }
    if (pollState.status === 'cancelled') {
      return `ℹ️ Poll "${pollName}" was cancelled.`;
    }
    if (!pollState.remindersPaused) {
      return `▶️ Reminders for "${pollName}" are already active.`;
    }

    pollState.remindersPaused = false;
    persistPolls();
    console.log(`[reminders] Reminders resumed for poll ${pollId} ("${pollName}") by ${sender}`);
    return `▶️ Reminders have been resumed for "${pollName}".`;
  }

  const isDM = Boolean(chatId && !chatId.endsWith('@g.us'));
  const effectiveChatId = isDM ? (context.targetGroupJid || null) : chatId;
  const targetPolls = [];

  for (const [id, state] of activePolls.entries()) {
    if ((isDM || state.remoteJid === effectiveChatId) && (state.status === 'active' || state.status === 'filled')) {
      targetPolls.push([id, state]);
    }
  }

  if (targetPolls.length === 0) {
    return 'No active match polls found to resume reminders for.';
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
  const { flags, remainingText: remClean } = recurringPollsModule.extractCommonFlags(rem);
  if (flags.courtBookingType !== undefined) updates.courtBookingType = flags.courtBookingType;
  if (flags.preBookCourts !== undefined) updates.preBookCourts = flags.preBookCourts;
  if (flags.bookingPlayers !== undefined) updates.bookingPlayers = flags.bookingPlayers;
  if (flags.bookingStrategy !== undefined) updates.bookingStrategy = flags.bookingStrategy;
  if (flags.bookingSchedule !== undefined) updates.bookingSchedule = flags.bookingSchedule;
  if (flags.checkCourts !== undefined) updates.checkCourts = flags.checkCourts;
  if (flags.noMatchups !== undefined) updates.noMatchups = flags.noMatchups;
  if (flags.includePrebookedSpots !== undefined) updates.includePrebookedSpots = flags.includePrebookedSpots;

  let remForSize = remClean;
  const courtM = remClean.match(/\b(?:on\s+|at\s+|for\s+)?(?:the\s+)?(court\s*#?\s*\d+|pickleball\s*#?\s*\d+|pb\s*#?\s*\d+)\b/i);
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

  if (/\b(?:opt-?in|yes\s*\/\s*no|yesno|open)\b/i.test(remClean)) {
    updates.type = 'opt_in';
    updates.size = null;
  } else if (/\bauto\b/i.test(remClean)) {
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

  const timeM = remClean.match(/\b(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm))\b/i) || remClean.match(/\b(\d{1,2}[:.]\d{2})\b/i);
  if (timeM) {
    updates.timeWord = timeM[1].trim();
  }

  const dayM = remClean.match(/\b(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/i);
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

  return { targetId, updates };
}

async function handleModifyPollInstance(sock, chatId, sender, senderJid, targetId, updates = {}, context) {
  const { activePolls, recurringPolls } = context;
  const isDM = Boolean(chatId && !chatId.endsWith('@g.us'));
  const effectiveChatId = isDM ? (context.targetGroupJid || await getTargetGroupJid(sock) || chatId) : chatId;

  let cleanTarget = String(targetId || '').replace(/^["']|["']$/g, '').trim();

  let matchedPollId = null;
  let matchedPollState = null;

  if (cleanTarget) {
    const cleanLower = cleanTarget.toLowerCase();

    for (const [id, state] of activePolls.entries()) {
      if ((state.remoteJid === effectiveChatId || isDM) && id.toLowerCase() === cleanLower) {
        matchedPollId = id;
        matchedPollState = state;
        break;
      }
    }

    if (!matchedPollState) {
      for (const [id, state] of activePolls.entries()) {
        if ((state.remoteJid === effectiveChatId || isDM) && (state.status === 'active' || state.status === 'filled' || state.status === 'stopped')) {
          const sid = getPollScheduleId(state, recurringPolls);
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

  const schedId = getPollScheduleId(matchedPollState, recurringPolls);
  const sched = schedId ? recurringPolls.get(schedId) : null;
  const isSchedCreator = sched?.creator ? isSameUser(sched.creator.jid, senderJid, sched.creator.name, sender) : false;
  const isPollCreator = matchedPollState.creator ? isSameUser(matchedPollState.creator.jid, senderJid, matchedPollState.creator.name, sender) : false;
  const isAdmin = await isUserAdmin(sock, effectiveChatId, senderJid);

  if (!isSchedCreator && !isPollCreator && !isAdmin) {
    return '⚠️ Only the creator of this poll/schedule or group admins can modify this poll instance.';
  }

  const isAuto = updates.size === 'auto' || (updates.size === undefined && matchedPollState.isAuto);
  let newSize = updates.size;
  if (newSize === undefined) {
    newSize = isAuto ? 'auto' : (matchedPollState.type === 'opt_in' ? null : matchedPollState.size);
  }

  let newWhen = updates.when || null;
  let newDayWord = updates.dayWord || null;
  let newTimeWord = updates.timeWord || null;

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

  const courtBookingType = updates.courtBookingType !== undefined
    ? updates.courtBookingType
    : (matchedPollState.courtBookingType || null);
  const bookingPlayers = updates.bookingPlayers !== undefined
    ? updates.bookingPlayers
    : (matchedPollState.bookingPlayers || null);
  const preBookCourts = updates.preBookCourts !== undefined
    ? updates.preBookCourts
    : (updates.preBookCourtsCount !== undefined ? updates.preBookCourtsCount : (matchedPollState.preBookCourts || null));

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
    matchedPollId,
    false,
    true,
    noMatchups,
    checkCourts,
    includePrebookedSpots,
    isRecurring,
    schedId,
    newCourt,
    courtBookingType,
    bookingPlayers,
    preBookCourts,
    null,
    null,
    context
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

async function handleSetPollSlots(sock, chatId, sender, senderJid, targetId, count, context) {
  const { activePolls, recurringPolls, persistPolls } = context;
  const isDM = Boolean(chatId && !chatId.endsWith('@g.us'));
  const effectiveChatId = isDM ? (context.targetGroupJid || await getTargetGroupJid(sock) || chatId) : chatId;

  let cleanTarget = String(targetId || '').replace(/^["']|["']$/g, '').trim();
  let cleanCount = count;

  if (!cleanCount && cleanTarget && (/^\d+$/.test(cleanTarget) || /^(?:reset|clear|none)$/i.test(cleanTarget))) {
    cleanCount = cleanTarget;
    cleanTarget = null;
  }

  let matchedPollId = null;
  let matchedPollState = null;

  if (cleanTarget) {
    const cleanLower = cleanTarget.toLowerCase();

    for (const [id, state] of activePolls.entries()) {
      if ((state.remoteJid === effectiveChatId || isDM) && id.toLowerCase() === cleanLower) {
        matchedPollId = id;
        matchedPollState = state;
        break;
      }
    }

    if (!matchedPollState) {
      for (const [id, state] of activePolls.entries()) {
        if ((state.remoteJid === effectiveChatId || isDM) && (state.status === 'active' || state.status === 'filled' || state.status === 'stopped')) {
          const sid = getPollScheduleId(state, recurringPolls);
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

  const schedId = getPollScheduleId(matchedPollState, recurringPolls);
  const sched = schedId ? recurringPolls.get(schedId) : null;
  const isSchedCreator = sched?.creator ? isSameUser(sched.creator.jid, senderJid, sched.creator.name, sender) : false;
  const isPollCreator = matchedPollState.creator ? isSameUser(matchedPollState.creator.jid, senderJid, matchedPollState.creator.name, sender) : false;
  const isAdmin = await isUserAdmin(sock, effectiveChatId, senderJid);

  if (!isSchedCreator && !isPollCreator && !isAdmin) {
    return '⚠️ Only the creator of this poll/schedule or group admins can set slot limits.';
  }

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
  const { aggregated, interestedPlayers } = getPollVoters(matchedPollId, matchedPollState, mePn, context.messageStore);

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

  let autoMatchupNote = '';
  if (isAllFilled && !matchedPollState.noMatchups && !matchedPollState.isManual && isValidPlayerCount(players.length)) {
    matchedPollState.status = 'resolved';
    persistPolls();
    setTimeout(async () => {
      try {
        await ratings.ensureRated(players);
        const prebookedCourts = await getPrebookedCourtsForPoll(matchedPollState, matchedPollState.remoteJid);
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

async function handleStopPoll(sock, chatId, sender, senderJid, specificPollId = null, context) {
  const { activePolls, latestPollIdByChat, persistPolls } = context;
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

async function handleResumePoll(sock, chatId, sender, senderJid, specificPollId = null, context) {
  const { activePolls, latestPollIdByChat, persistPolls } = context;
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

  if (playParts.year === nowParts.year && playParts.month === nowParts.month && playParts.day === nowParts.day) {
    if (pollState.when && !/^(?:tomorrow|tonight)\b/i.test(pollState.when.trim())) {
      return pollState.when;
    }
    return `${weekdayName} ${timeFormatted}`;
  }

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

async function getPrebookedCourtsForPoll(pollState, chatId = null) {
  if (!pollState) return [];
  const courts = [];

  if (Array.isArray(pollState.prebookedCourts)) {
    for (const c of pollState.prebookedCourts) {
      const courtName = typeof c === 'string' ? c : c?.court;
      if (courtName && !courtsConfig.isIgnoredCourt(courtName)) {
        courts.push(typeof c === 'string' ? { court: c } : c);
      }
    }
  }

  if (pollState.court && !courtsConfig.isIgnoredCourt(pollState.court)) {
    if (!courts.some((c) => (c.court || c).toLowerCase() === pollState.court.toLowerCase())) {
      courts.push({ court: pollState.court, player: pollState.createdBy || pollState.creator?.name || 'Member' });
    }
  }

  if (Array.isArray(pollState.prebookedPlayers)) {
    for (const pb of pollState.prebookedPlayers) {
      if (pb && pb.court && !courtsConfig.isIgnoredCourt(pb.court)) {
        courts.push({
          court: pb.court,
          player: pb.defaultPlayer || pb.name || pb.fullName
        });
      }
    }
  }

  if (pollState.name) {
    const bookingRegex = /(?:^|\n)\s*(Court\s*\d+|PB\s*\d+|Pickleball\s*\d+)\s*-\s*(?:([^'\n]+?)(?:\'s)?\s*Booking|Booked)/gi;
    let m;
    while ((m = bookingRegex.exec(pollState.name)) !== null) {
      if (courtsConfig.isIgnoredCourt(m[1])) continue;
      courts.push({ court: m[1], player: m[2]?.trim() || 'Member' });
    }
  }

  const unique = [];
  const seenCourts = new Set();
  for (const c of courts) {
    if (courtsConfig.isIgnoredCourt(c.court)) continue;
    const key = (c.court || '').trim().toLowerCase();
    if (key && !seenCourts.has(key)) {
      seenCourts.add(key);
      unique.push(c);
    }
  }
  return unique;
}

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

async function generateMatchupsFromPoll(sock, chatId, specificPollId = null, specificPollName = null, options = {}, context) {
  const { activePolls, latestPollIdByChat, persistPolls, messageStore } = context;
  const lookupChatId = (chatId && chatId.endsWith('@g.us')) ? chatId : (await getTargetGroupJid(sock) || chatId);
  let targetPollId = null;
  let targetPollState = null;

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

  if (!targetPollState) {
    const activeOptInOrManual = allChatPolls
      .filter(([, p]) => (p.status === 'active' || p.status === 'filled') && (p.type === 'opt_in' || p.size === null || p.isManual) && hasVotersOrPlayers(p))
      .sort((a, b) => getPollPlayTime(a[1]) - getPollPlayTime(b[1]));

    if (activeOptInOrManual.length > 0) {
      targetPollId = activeOptInOrManual[0][0];
      targetPollState = activeOptInOrManual[0][1];
    }
  }

  if (!targetPollState) {
    const activeWithVotes = allChatPolls
      .filter(([, p]) => (p.status === 'active' || p.status === 'filled') && hasVotersOrPlayers(p))
      .sort((a, b) => getPollPlayTime(a[1]) - getPollPlayTime(b[1]));

    if (activeWithVotes.length > 0) {
      targetPollId = activeWithVotes[0][0];
      targetPollState = activeWithVotes[0][1];
    }
  }

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

  let players = [];
  const { interestedPlayers, yesOption } = getPollVoters(targetPollId, targetPollState, mePn, messageStore);
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
      const { aggregated } = getPollVoters(targetPollId, targetPollState, mePn, messageStore);
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
    : await getPrebookedCourtsForPoll(targetPollState, chatId);
  const schedule = generateMatchups(players, { ...options, prebookedCourts, chatId });
  const whenHeader = formatMatchHeaderTime(targetPollState);
  const header = whenHeader ? `📅 ${whenHeader}\n\n` : '';
  await sock.sendMessage(chatId, { text: header + formatMatchups(schedule) });
  pairHistory.recordDraw(targetPollId, schedule, Date.now(), chatId);
  targetPollState.lastSchedule = summarizeSchedule(schedule);
  persistPolls();
  return null;
}

function pollStatusText(chatId = null, opts = {}, context) {
  const { activePolls, recurringPolls, messageStore, targetGroupJid } = context;
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
  if (recurringPolls) {
    if (effectiveChatId) {
      chatRecurring = [...recurringPolls.values()].filter((s) => s.remoteJid === effectiveChatId);
    }
    if (chatRecurring.length === 0 && (isDM || !chatId)) {
      chatRecurring = [...recurringPolls.values()];
    }
  }

  if (targetId) {
    const targetLower = targetId.toLowerCase();
    const isTargetManual = targetLower === 'manual' || targetLower === 'adhoc';
    const isTargetRecurring = targetLower === 'recurring' || targetLower === 'scheduled';

    const matchesPoll = (pollId, state) => {
      if (pollId.toLowerCase() === targetLower) return true;
      const sId = getPollScheduleId(state, recurringPolls);
      if (sId && sId.toLowerCase() === targetLower) return true;
      if (isTargetManual && state.isManual) return true;
      if (isTargetRecurring && (state.isRecurring || Boolean(state.scheduleId))) return true;
      const pName = (state.name || '').toLowerCase();
      const pWhen = (state.when || '').toLowerCase();
      if (pName.includes(targetLower) || pWhen.includes(targetLower)) return true;
      if (state.creator?.name && state.creator.name.toLowerCase().includes(targetLower)) return true;
      return false;
    };

    const matched = chatPolls.filter(([pollId, state]) => {
      if (chatId && chatId.endsWith('@g.us') && state.remoteJid !== chatId) return false;
      return matchesPoll(pollId, state);
    });

    if (matched.length > 0) {
      chatPolls = matched;
    } else {
      const globalMatched = [...activePolls.entries()].filter(([pollId, state]) => matchesPoll(pollId, state));
      if (globalMatched.length > 0) {
        chatPolls = globalMatched;
      } else {
        let targetSched = null;
        if (recurringPolls) {
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
          const isPreBook = targetSched.courtBookingType === 'pre-book' || targetSched.bookingStrategy === 'advanced' || Boolean(targetSched.bookingSchedule);
          const bookingTypeDesc = isPreBook ? 'Pre-book' : 'None';
          return `ℹ️ Recurring schedule \`${sid}\` (${statusStr}) is configured for ${daysStr} at ${matchStr} (posts at ${postStr}, court booking type: ${bookingTypeDesc}), but there is no active poll instance currently on record in active polls.\nUse "!recurringpolls" to inspect all schedules or wait for the next scheduled trigger.`;
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
        isAll = true;
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

  let recurringSummary = '';
  if (chatRecurring.length > 0 && !targetId && !activeOnly && !upcomingOnly) {
    const schedLines = chatRecurring.map((s) => {
      const sid = s.id || s.scheduleId;
      const daysStr = s.daysDisplay || s.days || 'everyday';
      const matchStr = s.matchDisplay || s.matchTime || 'unspecified time';
      const postStr = s.postDisplay || s.postTime || 'unspecified post time';
      const statusStr = s.enabled === false ? 'PAUSED' : 'ACTIVE';
      const linkedPolls = [...activePolls.entries()].filter(([, p]) => (p.scheduleId === sid || getPollScheduleId(p, recurringPolls) === sid));
      let instanceDesc = 'no active poll instance right now';
      if (linkedPolls.length > 0) {
        instanceDesc = linkedPolls.map(([id, p]) => `Poll \`${id}\` (${p.when || p.status}) — Status: ${p.status}`).join(', ');
      }
      const isPreBook = s.courtBookingType === 'pre-book' || s.bookingStrategy === 'advanced' || Boolean(s.bookingSchedule);
      const bookingTypeStr = isPreBook ? ', court booking: Pre-book' : '';
      return `• \`${sid}\` (${statusStr}): ${daysStr} at ${matchStr} (posts at ${postStr}${bookingTypeStr})\n  └ Current Instance: ${instanceDesc}`;
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

  const mePn = jidNormalizedUser(context.botSock?.user?.id || context.botSock?.authState?.creds?.me?.id || '');

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
      ? (context.groupMetadataCache?.get(pollState.remoteJid)?.subject || pollState.remoteJid)
      : null;
    const groupHeader = isAll ? `Chat/Group: ${groupName}\n` : '';
    const remindersStr = Array.isArray(pollState.sentReminders) && pollState.sentReminders.length > 0
      ? pollState.sentReminders.map((h) => h < 1 ? `${Math.round(h * 60)}m` : `${h}h`).join(', ')
      : '(none yet)';
    const isAutoPoll = isAutoCreatedPoll(pollState);
    const stoppedAfter2h = !pollState.isManual && (pollState.reminderCount || 0) >= 4 && (pollState.sentReminders || []).includes(2);
    const countStr = isAutoPoll
      ? `(${pollState.reminderCount || 0} sent${stoppedAfter2h ? ' - stopped after 2h' : ''})`
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
        getPollScheduleId(pollState, recurringPolls) ? `🔄 Recurring Schedule: \`${getPollScheduleId(pollState, recurringPolls)}\` (created as per schedule)` : (pollState.isRecurring ? '🔄 Recurring Schedule: (created as per schedule)' : null),
        pollState.courtBookingType ? `Court Booking Type: ${pollState.courtBookingType === 'pre-book' ? 'Pre-book' : pollState.courtBookingType}` : null,
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
      const { aggregated, interestedPlayers } = getPollVoters(pollId, pollState, mePn, messageStore);
      const optionSummaries = aggregated.map((opt) => `${opt.name} (${opt.voters.length}): ${opt.voters.map(nameFor).join(', ') || '(none)'}`);
      const { players: playingPlayers, addedFromLabel, addedFromValidCount } = resolveManualPollPlayers(pollState, interestedPlayers);
      const creatorName = pollState.creator?.name || 'Someone';

      let additionNotes = [];
      if (addedFromLabel.length > 0) additionNotes.push(`${addedFromLabel.join(', ')} from poll slot labels`);
      if (addedFromValidCount.length > 0) additionNotes.push(`${addedFromValidCount.join(', ')} to reach valid player count`);
      const additionStr = additionNotes.length > 0 ? ` (includes ${additionNotes.join(' and ')})` : '';

      const lines = [
        `${groupHeader}Poll ${pollId}: User-Created Manual Match Poll "${pollState.name || 'Match Poll'}".`,
        getPollScheduleId(pollState, recurringPolls) ? `🔄 Recurring Schedule: \`${getPollScheduleId(pollState, recurringPolls)}\` (created as per schedule)` : (pollState.isRecurring ? '🔄 Recurring Schedule: (created as per schedule)' : null),
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

    const { aggregated } = getPollVoters(pollId, pollState, mePn, messageStore);
    const { players: currentPlayers, excessPlayers, filledCount, totalSlotsCount, naturalTotalSlots } = resolveFixedPollRoster(pollState, aggregated);
    const options = pollState.options || [];
    const firstSlotNum = getFirstSlotNumber(options);
    const hasPrebooked = Array.isArray(pollState.prebookedPlayers) && pollState.prebookedPlayers.length > 0;
    const leadingSpots = (firstSlotNum && firstSlotNum > 1) ? (firstSlotNum - 1) : (pollState.creator && !hasPrebooked ? 1 : 0);
    const creatorDesc = leadingSpots > 1
      ? `Creator: ${pollState.creator?.name || 'Creator'} (holding spots 1..${leadingSpots})`
      : (pollState.creator && !hasPrebooked ? `Creator (Player 1): ${pollState.creator.name || 'Player 1'}` : 'Creator: None (all spots open)');

    const prebookedNote = hasPrebooked
      ? ` (pre-booked: ${pollState.prebookedPlayers.map((p) => typeof p === 'string' ? `${p}'s Spot` : p.slotName).join(', ')})`
      : '';

    const limitNote = pollState.slotLimit ? ` (limit: ${pollState.slotLimit} spots, original: ${pollState.originalSize || naturalTotalSlots})` : '';
    const excessLine = (excessPlayers && excessPlayers.length > 0) ? `⚠️ Excess votes not considered (${excessPlayers.length}): ${excessPlayers.join(', ')}` : null;

    const lines = [
      `${groupHeader}Poll ${pollId}${pollState.when ? ` (${pollState.when})` : ''}: ${pollState.size} spots (${pollState.size === 2 ? 'Singles' : 'Doubles'})${limitNote}.`,
      getPollScheduleId(pollState, recurringPolls) ? `🔁 Recurring Schedule: \`${getPollScheduleId(pollState, recurringPolls)}\` (created as per schedule)` : (pollState.isRecurring ? '🔁 Recurring Schedule: (created as per schedule)' : null),
      pollState.courtBookingType ? `Court Booking Type: ${pollState.courtBookingType === 'pre-book' ? 'Pre-book' : pollState.courtBookingType}` : null,
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

function getVoteTimestamp(pollState, voterJid) {
  if (!pollState?.voteBuffer) return 0;
  const norm = jidNormalizedUser(voterJid);
  const canonicalId = namesStore.resolveCanonicalId(norm);
  const entry = (norm && pollState.voteBuffer.get(norm)) ||
                (canonicalId && pollState.voteBuffer.get(canonicalId)) ||
                pollState.voteBuffer.get(voterJid);
  if (!entry) return 0;
  const rawTs = entry.senderTimestampMs || entry.timestamp || entry.pollUpdateMessageKey?.timestamp;
  if (!rawTs) return 0;
  if (typeof rawTs === 'number') return rawTs;
  if (typeof rawTs === 'string') return parseInt(rawTs, 10) || 0;
  if (typeof rawTs?.toNumber === 'function') return rawTs.toNumber();
  if (typeof rawTs === 'bigint') return Number(rawTs);
  return Number(rawTs) || 0;
}

function getVoteArrivalIndex(pollState, voterJid) {
  if (!pollState?.voteBuffer) return 0;
  const norm = jidNormalizedUser(voterJid);
  const canonicalId = namesStore.resolveCanonicalId(norm);
  let idx = 0;
  for (const k of pollState.voteBuffer.keys()) {
    if (k === norm || k === canonicalId || k === voterJid) return idx;
    idx++;
  }
  return 999999;
}

async function checkAndNotifySlotConflicts(sock, pollId, pollState, aggregated, context) {
  if (!pollState || !aggregated || !Array.isArray(aggregated)) return false;

  const isOptIn = pollState.type === 'opt_in' || pollState.options?.some((o) => /^yes$/i.test(o.trim()));
  if (isOptIn) return false;

  const conflicts = aggregated.filter((o) => {
    if (/^(no|out|can't play|cannot play)$/i.test(o.name.trim())) return false;
    return Array.isArray(o.voters) && o.voters.length > 1;
  });

  if (conflicts.length === 0) {
    if (pollState.lastConflictSignature !== null) {
      pollState.lastConflictSignature = null;
      if (context.persistPolls) context.persistPolls();
    }
    return false;
  }

  const signature = conflicts.map((c) => `${c.name}:${[...c.voters].sort().join(',')}`).join('|');
  if (pollState.lastConflictSignature === signature) {
    return true;
  }
  pollState.lastConflictSignature = signature;
  if (context.persistPolls) context.persistPolls();

  const openSlotOptions = aggregated.filter((o) => {
    if (/^(no|out|can't play|cannot play)$/i.test(o.name.trim())) return false;
    return !o.voters || o.voters.length === 0;
  });
  const openSlotNames = openSlotOptions.map((o) => o.name.trim());

  let openSlotsText = '';
  if (openSlotNames.length > 0) {
    openSlotsText = `👉 Available open slot(s): *${openSlotNames.join('*, *')}*`;
  } else {
    openSlotsText = 'ℹ️ All other slots are currently taken.';
  }

  const alertLines = [];
  const allMentions = [];

  for (const conf of conflicts) {
    const slotName = conf.name.trim();

    const sortedVoters = [...conf.voters].sort((a, b) => {
      const tA = getVoteTimestamp(pollState, a);
      const tB = getVoteTimestamp(pollState, b);
      if (tA && tB && tA !== tB) return tA - tB;
      const idxA = getVoteArrivalIndex(pollState, a);
      const idxB = getVoteArrivalIndex(pollState, b);
      return idxA - idxB;
    });

    const firstVoterJid = sortedVoters[0];
    const firstVoterName = nameFor(firstVoterJid);
    const subsequentVoters = sortedVoters.slice(1);

    for (const secondVoterJid of subsequentVoters) {
      const norm = jidNormalizedUser(secondVoterJid);
      const pn = namesStore.getPnByLid(norm) || (norm?.endsWith('@s.whatsapp.net') ? norm : null);
      const lid = namesStore.resolveCanonicalId(norm) || (norm?.endsWith('@lid') ? norm : null);
      const voterName = nameFor(secondVoterJid);

      const phoneDigits = (pn || norm || lid || secondVoterJid).split('@')[0].replace(/\D/g, '');
      const tagStr = phoneDigits ? `@${phoneDigits}` : `@${voterName}`;

      if (pn) allMentions.push(pn);
      if (lid) allMentions.push(lid);
      if (norm) allMentions.push(norm);

      alertLines.push(`⚠️ ${tagStr}, *${slotName}* is already taken by *${firstVoterName}*! Please switch your vote to an open slot.`);
    }
  }

  if (openSlotsText) {
    alertLines.push('');
    alertLines.push(openSlotsText);
  }

  const fullAlertText = alertLines.join('\n');
  const uniqueMentions = [...new Set(allMentions)];

  let pollCreationMessage = context.messageStore ? context.messageStore.get(storeKey(pollState.remoteJid, pollId)) : null;
  if (!pollCreationMessage && context.messageStore) {
    for (const key of context.messageStore.keys()) {
      if (key.endsWith(`:${pollId}`)) {
        pollCreationMessage = context.messageStore.get(key);
        break;
      }
    }
  }

  const fromMe = !pollState.isManual;
  const participant = pollState.creator?.jid;

  const quotedMsg = {
    key: {
      remoteJid: pollState.remoteJid,
      id: pollId,
      fromMe: Boolean(fromMe),
      ...(participant ? { participant } : {})
    },
    ...(pollCreationMessage ? { message: pollCreationMessage } : {})
  };

  console.log(`[poll] Sending slot conflict alert in ${pollState.remoteJid} for poll ${pollId} (tagging ${uniqueMentions.length} mention(s)): \n${fullAlertText}`);
  try {
    messageHistory.recordMessage(pollState.remoteJid, 'tenbot', fullAlertText, Date.now(), true);
    await sock.sendMessage(pollState.remoteJid, {
      text: fullAlertText,
      mentions: uniqueMentions
    }, { quoted: quotedMsg });
  } catch (err) {
    console.error(`[poll] Failed to send slot conflict alert for poll ${pollId}:`, err.message);
  }

  return true;
}

/**
 * Helper to determine the slot number for an option label (e.g. "Player 9" -> 9).
 */
function getSlotNumberForOption(optName, index, pollState = {}) {
  if (optName) {
    const match = String(optName).match(/\b(\d+)\b/);
    if (match) {
      return parseInt(match[1], 10);
    }
  }
  const leadingSpots = (!pollState?.prebookedPlayers?.length && pollState?.creator) ? 1 : 0;
  return (typeof index === 'number' ? index : 0) + 1 + leadingSpots;
}

/**
 * Checks for votes on invalid slots (beyond pollState.slotLimit) and notifies the group
 * tagging the voter and quoting the original poll.
 */
async function checkAndNotifyInvalidSlotVotes(sock, pollId, pollState, aggregated, context = {}) {
  if (!pollState || !pollState.slotLimit || typeof pollState.slotLimit !== 'number') {
    return false;
  }
  if (!Array.isArray(aggregated)) {
    return false;
  }

  const validLimit = pollState.slotLimit;
  if (!Array.isArray(pollState.invalidSlotVotesNotified)) {
    pollState.invalidSlotVotesNotified = [];
  }

  let pollCreationMessage = context.messageStore ? context.messageStore.get(storeKey(pollState.remoteJid, pollId)) : null;
  if (!pollCreationMessage && context.messageStore) {
    for (const key of context.messageStore.keys()) {
      if (key.endsWith(':' + pollId)) {
        pollCreationMessage = context.messageStore.get(key);
        break;
      }
    }
  }

  const fromMe = !pollState.isManual;
  const participant = pollState.creator?.jid;

  const quotedMsg = {
    key: {
      remoteJid: pollState.remoteJid,
      id: pollId,
      fromMe: Boolean(fromMe),
      ...(participant ? { participant } : {})
    },
    ...(pollCreationMessage ? { message: pollCreationMessage } : {})
  };

  let newlyNotified = false;

  for (let idx = 0; idx < aggregated.length; idx++) {
    const opt = aggregated[idx];
    if (!opt || !Array.isArray(opt.voters) || opt.voters.length === 0) continue;
    if (/^(no|out|can't play|cannot play)$/i.test(opt.name.trim())) continue;

    const slotNum = getSlotNumberForOption(opt.name, idx, pollState);
    if (slotNum <= validLimit) continue;

    for (const voterJid of opt.voters) {
      const notifyKey = `${voterJid}:${slotNum}`;
      if (pollState.invalidSlotVotesNotified.includes(notifyKey)) {
        continue;
      }

      const norm = jidNormalizedUser(voterJid);
      const pn = namesStore.getPnByLid(norm) || (norm?.endsWith('@s.whatsapp.net') ? norm : null);
      const lid = namesStore.resolveCanonicalId(norm) || (norm?.endsWith('@lid') ? norm : null);
      const voterName = nameFor(voterJid);

      const phoneDigits = (pn || norm || lid || voterJid).split('@')[0].replace(/\D/g, '');
      const tagStr = phoneDigits ? `@${phoneDigits}` : `@${voterName}`;

      const voterMentions = [];
      if (pn) voterMentions.push(pn);
      if (lid) voterMentions.push(lid);
      if (norm) voterMentions.push(norm);
      voterMentions.push(voterJid);
      const uniqueMentions = [...new Set(voterMentions.filter(Boolean))];

      const warnText = `⚠️ ${tagStr}, *${opt.name.trim()}* is no longer valid. Only *${validLimit} voting slots* are valid for this match poll.`;

      console.log(`[poll] Sending invalid slot notification in ${pollState.remoteJid} for poll ${pollId} to ${voterName} (${tagStr}) for slot ${slotNum}`);
      if (sock && pollState.remoteJid) {
        try {
          messageHistory.recordMessage(pollState.remoteJid, 'tenbot', warnText, Date.now(), true);
          await sock.sendMessage(pollState.remoteJid, {
            text: warnText,
            mentions: uniqueMentions
          }, { quoted: quotedMsg });
        } catch (err) {
          console.error(`[poll] Failed to send invalid slot notification for poll ${pollId}:`, err.message);
        }
      }

      pollState.invalidSlotVotesNotified.push(notifyKey);
      newlyNotified = true;
    }
  }

  if (newlyNotified && context.persistPolls) {
    context.persistPolls();
  }

  return newlyNotified;
}

async function checkAndSendPollReminders(sock, context) {
  if (!sock) return;
  const { activePolls, persistPolls } = context;
  try {
    const sjParts = getSanJoseParts();
    const currentHour = sjParts.hour;

    if (currentHour >= 22 || currentHour < 8) return;

    const now = Date.now();

    for (const [pollId, pollState] of activePolls.entries()) {
      if (pollState.status !== 'active') continue;
      if (pollState.remindersPaused) continue;
      if (!isAutoCreatedPoll(pollState) && (pollState.reminderCount || 0) >= MAX_POLL_REMINDERS) continue;
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
        continue;
      }

      const hoursRemaining = diffMs / (60 * 60 * 1000);

      if (pollState.createdAt) {
        const pollAgeHours = (now - new Date(pollState.createdAt).getTime()) / (60 * 60 * 1000);
        if (pollAgeHours < 1.0) {
          continue;
        }
      }

      const targetH = POWERS_OF_2_REMINDER_HOURS.find((h) => hoursRemaining <= h);
      if (!targetH) continue;

      if (!pollState.isManual && targetH < 2 && (pollState.reminderCount || 0) >= 4) {
        continue;
      }

      if (!Array.isArray(pollState.sentReminders)) {
        pollState.sentReminders = [];
      }

      if (pollState.sentReminders.includes(targetH)) continue;

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
        const sent = await sendPollReminder(sock, pollId, pollState, false, context);
        if (sent) {
          for (const h of POWERS_OF_2_REMINDER_HOURS) {
            if (h >= targetH && !pollState.sentReminders.includes(h)) {
              pollState.sentReminders.push(h);
            }
          }

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

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function preBookCourtsForMatch({
  sock,
  remoteJid,
  targetDateMDY,
  queryTime,
  size = null,
  isAuto = true,
  preBookCourts = null,
  bookingPlayers = null,
  creatorName = 'Member',
  creatorJid = null,
  existingAdvanceBookedCourts = null,
  existingPrebookedCourts = null,
  isAdvanceBooking = false
}) {
  const advanceBookedCourts = Array.isArray(existingAdvanceBookedCourts) ? [...existingAdvanceBookedCourts] : [];
  const prebookedCourts = Array.isArray(existingPrebookedCourts) ? [...existingPrebookedCourts] : [];

  if (!groupsConfig.isCourtBookingEnabled(remoteJid)) {
    return { advanceBookedCourts, prebookedCourts };
  }

  const groupCfg = groupsConfig.getGroupConfig(remoteJid);
  const sport = groupCfg?.sport || 'tennis';

  let targetCourtsCount = 1;
  if (!isAuto && size && parseInt(size, 10) > 0) {
    const numPlayers = parseInt(size, 10);
    targetCourtsCount = Math.max(1, Math.ceil(numPlayers / 4));
  } else {
    const explicitCourts = (preBookCourts !== undefined && preBookCourts !== null && parseInt(preBookCourts, 10) > 0)
      ? parseInt(preBookCourts, 10)
      : null;
    const cfgCourts = (groupCfg?.preBookCourts !== undefined && groupCfg?.preBookCourts !== null && parseInt(groupCfg.preBookCourts, 10) > 0)
      ? parseInt(groupCfg.preBookCourts, 10)
      : (groupCfg?.preBookCourtsCount !== undefined && groupCfg?.preBookCourtsCount !== null && parseInt(groupCfg.preBookCourtsCount, 10) > 0
        ? parseInt(groupCfg.preBookCourtsCount, 10)
        : 1);

    targetCourtsCount = explicitCourts || cfgCourts || 1;
  }

  console.log(`[poll] Pre-book court calculation for ${remoteJid}: size=${size}, isAuto=${isAuto}, targetCourtsCount=${targetCourtsCount}`);

  const shuffleArray = (arr) => {
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };

  const directNames = groupCfg?.directCourtBookingAccounts || [];
  const directBookingPlayers = [];
  const directKeysSet = new Set();
  for (const name of directNames) {
    const resolved = namesStore.resolveFullName(name);
    const key = resolved.toLowerCase().trim();
    if (!directBookingPlayers.some((dp) => dp.toLowerCase().trim() === key)) {
      directBookingPlayers.push(resolved);
    }
    directKeysSet.add(key);
  }

  let rawPool = [];
  if (bookingPlayers) {
    rawPool = Array.isArray(bookingPlayers) ? bookingPlayers : (typeof bookingPlayers === 'string' ? bookingPlayers.split(/[,;]+/).map((s) => s.trim()).filter(Boolean) : []);
  }
  if (!rawPool || rawPool.length === 0) {
    rawPool = groupsConfig.getDefaultBookingPlayers(remoteJid);
  }
  if (!rawPool || rawPool.length === 0) {
    rawPool = [creatorName || 'Member'];
  }

  const seenTeammateNames = new Set();
  const defaultBookingPool = [];
  for (const p of rawPool) {
    const resolved = namesStore.resolveFullName(p);
    const key = resolved.toLowerCase().trim();
    if (!directKeysSet.has(key) && !seenTeammateNames.has(key)) {
      seenTeammateNames.add(key);
      defaultBookingPool.push(resolved);
    }
  }

  const playersPerCourt = (!isAuto && size && parseInt(size, 10) === 2) ? 2 : 4;
  const bookedPlayerKeys = new Set();
  for (const b of advanceBookedCourts) {
    if (Array.isArray(b.players)) {
      for (const p of b.players) {
        if (p) bookedPlayerKeys.add(p.toLowerCase().trim());
      }
    }
  }
  let availableDirectAccounts = shuffleArray(directBookingPlayers).filter((p) => !bookedPlayerKeys.has(p.toLowerCase().trim()));

  const alreadyBookedCount = advanceBookedCourts.length;
  if (alreadyBookedCount >= targetCourtsCount) {
    console.log(`[poll] Target courts count (${targetCourtsCount}) already reached for ${remoteJid} on ${targetDateMDY} (${alreadyBookedCount} booked).`);
    return { advanceBookedCourts, prebookedCourts };
  }

  for (let courtIdx = alreadyBookedCount; courtIdx < targetCourtsCount; courtIdx++) {
    let courtBooked = false;
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 45 * 1000;
    const MAX_ATTEMPTS = 1 + MAX_RETRIES;
    const triedSetsForCourt = new Set();

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const unbookedDirect = availableDirectAccounts.filter((p) => !bookedPlayerKeys.has(p.toLowerCase().trim()));
      let unbookedTeammates = defaultBookingPool.filter((p) => !bookedPlayerKeys.has(p.toLowerCase().trim()));

      let p1 = null;
      if (unbookedDirect.length > 0) {
        const shuffledDirect = shuffleArray(unbookedDirect);
        p1 = shuffledDirect[0];
      } else {
        const shuffledTeammates = shuffleArray(unbookedTeammates);
        p1 = shuffledTeammates[0] || (creatorName || 'Member');
      }

      const availableTeammates = unbookedTeammates.filter((p) => p.toLowerCase().trim() !== p1.toLowerCase().trim());
      const neededTeammates = Math.max(0, playersPerCourt - 1);
      let selectedTeammates = [];

      if (availableTeammates.length > 0 && neededTeammates > 0) {
        let foundNewCombo = false;
        for (let sampleTry = 0; sampleTry < 15; sampleTry++) {
          const shuffledTeammates = shuffleArray(availableTeammates);
          const candidateTeammates = shuffledTeammates.slice(0, neededTeammates);
          const setSig = [p1, ...candidateTeammates].map((x) => x.toLowerCase().trim()).sort().join('|');
          if (!triedSetsForCourt.has(setSig)) {
            selectedTeammates = candidateTeammates;
            triedSetsForCourt.add(setSig);
            foundNewCombo = true;
            break;
          }
        }
        if (!foundNewCombo) {
          selectedTeammates = shuffleArray(availableTeammates).slice(0, neededTeammates);
          const setSig = [p1, ...selectedTeammates].map((x) => x.toLowerCase().trim()).sort().join('|');
          triedSetsForCourt.add(setSig);
        }
      } else {
        const setSig = [p1].map((x) => x.toLowerCase().trim()).join('|');
        triedSetsForCourt.add(setSig);
      }

      const currentCourtPlayers = [p1, ...selectedTeammates];
      const retryLabel = attempt > 1 ? ` (retry ${attempt - 1}/${MAX_RETRIES})` : '';
      console.log(`[poll] Pre-booking court ${courtIdx + 1}/${targetCourtsCount}${retryLabel} for ${remoteJid} on ${targetDateMDY} at ${queryTime} with players:`, currentCourtPlayers);

      try {
        const alreadyBookedCourtNames = advanceBookedCourts.map((b) => b.court);
        const bookRes = await scvcc.bookCourt({
          when: targetDateMDY,
          date: targetDateMDY,
          time: queryTime,
          players: currentCourtPlayers,
          requester: currentCourtPlayers[0] || creatorName || 'Member',
          requestedBy: creatorName || 'Member',
          sport,
          chatId: remoteJid,
          excludeCourts: alreadyBookedCourtNames
        });

        if (bookRes && bookRes.success) {
          advanceBookedCourts.push({
            court: bookRes.court,
            players: bookRes.players || currentCourtPlayers,
            date: bookRes.date,
            time: bookRes.time,
            reservationId: bookRes.reservationId || null,
            duration: bookRes.duration || '90 Minutes',
            partySize: bookRes.partySize || (playersPerCourt === 2 ? 'Singles' : 'Doubles')
          });
          prebookedCourts.push({
            court: bookRes.court,
            player: currentCourtPlayers[0] || creatorName || 'Member',
            fullName: (currentCourtPlayers && currentCourtPlayers.length > 0) ? currentCourtPlayers.join(', ') : (creatorName || 'Member')
          });

          currentCourtPlayers.forEach((p) => bookedPlayerKeys.add(p.toLowerCase().trim()));
          availableDirectAccounts = availableDirectAccounts.filter((p) => p.toLowerCase().trim() !== p1.toLowerCase().trim());

          if (sock && remoteJid && bookRes.message) {
            await sendBookingNotifications(sock, remoteJid, bookRes.message);
          }

          courtBooked = true;
          break;
        } else {
          console.warn(`[poll] Advance court booking failed for court ${courtIdx + 1}/${targetCourtsCount}${retryLabel}:`, bookRes?.message);
        }
      } catch (bookErr) {
        console.error(`[poll] Error during advance court booking for court ${courtIdx + 1}/${targetCourtsCount}${retryLabel}:`, bookErr.message);
      }

      if (!courtBooked && attempt <= MAX_RETRIES) {
        console.log(`[poll] Waiting 45s before retrying court ${courtIdx + 1}/${targetCourtsCount} with another set of random players...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }

    if (!courtBooked) {
      console.warn(`[poll] Advance court booking failed for court ${courtIdx + 1}/${targetCourtsCount} after all ${MAX_ATTEMPTS} attempts.`);
    }
  }

  if (!isAdvanceBooking && sock && remoteJid) {
    const isAllBooked = advanceBookedCourts.length >= targetCourtsCount && targetCourtsCount > 0;
    const summaryMsg = scvcc.buildBookingSummaryMessage({
      targetDateMDY,
      queryTime,
      sport,
      targetCourtsCount,
      advanceBookedCourts,
      isExhausted: !isAllBooked
    });
    console.log(`[poll] Sending booking summary notification for ${remoteJid}:\n${summaryMsg}`);
    await sendBookingNotifications(sock, remoteJid, summaryMsg);
  }

  return { advanceBookedCourts, prebookedCourts };
}

function formatCourtLabel(court) {
  if (!court) return 'Court';
  const str = String(court).trim();
  if (/^court\s*\d+/i.test(str)) {
    return str.replace(/^court\s*/i, 'Court ');
  }
  if (/^\d+$/.test(str)) {
    return `Court ${str}`;
  }
  return str;
}

/**
 * Books an available court on demand when player openings fall below 3.
 * If booking fails, posts a message to the group that the court is no longer available,
 * sets pollState.slotLimit to the valid number of slots, and notifies voters on invalid slots.
 */
async function handleOnDemandCourtBooking(sock, pollId, pollState, aggregated, context = {}) {
  if (pollState.onDemandBookingInProgress && pollState._bookingActive) return;
  if (!Array.isArray(pollState.unbookedCourts) || pollState.unbookedCourts.length === 0) return;

  pollState.onDemandBookingInProgress = true;
  pollState._bookingActive = true;
  const courtToBook = pollState.unbookedCourts[0];
  const remoteJid = pollState.remoteJid;
  const playersPerCourt = pollState.courtBookingType === 'singles' ? 2 : 4;
  const sport = 'tennis';

  try {
    const targetDateMDY = pollState.targetDateMDY || scvcc.resolveDateToMDY(pollState.playAt || pollState.when || 'today');
    let queryTime = pollState.queryTime;
    if (!queryTime && pollState.playAt) {
      const sjParts = getSanJoseParts(new Date(pollState.playAt));
      const h = sjParts.hour === 0 ? 12 : (sjParts.hour > 12 ? sjParts.hour - 12 : sjParts.hour);
      const m = String(sjParts.minute).padStart(2, '0');
      const ampm = sjParts.hour >= 12 ? 'pm' : 'am';
      queryTime = `${h}:${m}${ampm}`;
    }

    // 1. Identify players already on prebooked courts bookings to exclude them
    const bookedPlayerKeys = new Set();
    if (Array.isArray(pollState.advanceBookedCourts)) {
      for (const b of pollState.advanceBookedCourts) {
        if (Array.isArray(b.players)) {
          for (const p of b.players) {
            if (p) {
              bookedPlayerKeys.add(p.toLowerCase().trim());
              const resolved = namesStore.resolveFullName(p);
              if (resolved) bookedPlayerKeys.add(resolved.toLowerCase().trim());
            }
          }
        }
        if (b.requester) {
          bookedPlayerKeys.add(b.requester.toLowerCase().trim());
          const resolved = namesStore.resolveFullName(b.requester);
          if (resolved) bookedPlayerKeys.add(resolved.toLowerCase().trim());
        }
      }
    }
    if (Array.isArray(pollState.prebookedCourts)) {
      for (const pb of pollState.prebookedCourts) {
        if (pb.player) {
          bookedPlayerKeys.add(pb.player.toLowerCase().trim());
          const resolved = namesStore.resolveFullName(pb.player);
          if (resolved) bookedPlayerKeys.add(resolved.toLowerCase().trim());
        }
        if (pb.fullName) {
          const names = String(pb.fullName).split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
          for (const n of names) {
            bookedPlayerKeys.add(n.toLowerCase().trim());
            const resolved = namesStore.resolveFullName(n);
            if (resolved) bookedPlayerKeys.add(resolved.toLowerCase().trim());
          }
        }
      }
    }

    // 2. Collect players that have voted so far
    const votedPlayers = [];
    if (Array.isArray(aggregated)) {
      for (const opt of aggregated) {
        if (!opt || !Array.isArray(opt.voters)) continue;
        if (/^(no|out|can't play|cannot play)$/i.test(opt.name.trim())) continue;
        for (const vJid of opt.voters) {
          const pName = nameFor(vJid);
          if (pName && !ratings.isPlaceholder(pName)) {
            votedPlayers.push(pName);
          }
        }
      }
    }
    const tempRoster = resolveFixedPollRoster(pollState, aggregated);
    if (Array.isArray(tempRoster?.allPlayers)) {
      for (const p of tempRoster.allPlayers) {
        if (p && !ratings.isPlaceholder(p) && !votedPlayers.includes(p)) {
          votedPlayers.push(p);
        }
      }
    }

    // 3. Collect default booking players
    let rawDefaultPool = [];
    if (pollState.bookingPlayers) {
      rawDefaultPool = Array.isArray(pollState.bookingPlayers)
        ? pollState.bookingPlayers
        : (typeof pollState.bookingPlayers === 'string' ? pollState.bookingPlayers.split(/[,;]+/).map((s) => s.trim()).filter(Boolean) : []);
    }
    if (!rawDefaultPool || rawDefaultPool.length === 0) {
      rawDefaultPool = groupsConfig.getDefaultBookingPlayers(remoteJid) || [];
    }

    // 4. Build candidate booking pool (voted players + default booking players, excluding prebooked courts players)
    const candidateBookingPool = [];
    const seenCandidateKeys = new Set();

    const addCandidate = (name) => {
      if (!name) return;
      const resolved = namesStore.resolveFullName(name);
      const key = resolved.toLowerCase().trim();
      if (bookedPlayerKeys.has(key)) return; // Exclude players on prebooked courts
      if (seenCandidateKeys.has(key)) return;
      seenCandidateKeys.add(key);
      candidateBookingPool.push(resolved);
    };

    for (const p of votedPlayers) {
      addCandidate(p);
    }
    for (const p of rawDefaultPool) {
      addCandidate(p);
    }

    // 5. Direct booking accounts
    const groupCfg = groupsConfig.getGroupConfig(remoteJid);
    const directNames = groupCfg?.directCourtBookingAccounts || [];
    const directBookingPlayers = [];
    for (const name of directNames) {
      const resolved = namesStore.resolveFullName(name);
      const key = resolved.toLowerCase().trim();
      if (!bookedPlayerKeys.has(key) && !directBookingPlayers.some((dp) => dp.toLowerCase().trim() === key)) {
        directBookingPlayers.push(resolved);
      }
    }

    // Exclude other courts from SCVCC so only courtToBook can be booked
    const alreadyBookedCourtNames = (pollState.advanceBookedCourts || []).map((b) => b.court);
    if (Array.isArray(pollState.prebookedCourts)) {
      alreadyBookedCourtNames.push(...pollState.prebookedCourts.map((pb) => pb.court));
    }

    const avail = await scvcc.checkCourtAvailability({ when: targetDateMDY, time: queryTime, sport, chatId: remoteJid }).catch(() => null);
    const slot = avail?.slots?.find((s) => s.time === queryTime) || avail?.slots?.[0];
    const otherCourts = slot?.courts
      ? slot.courts.filter((c) => c.court.toLowerCase() !== courtToBook.court.toLowerCase()).map((c) => c.court)
      : [];
    const excludeCourts = [...new Set([...alreadyBookedCourtNames, ...otherCourts])];

    // 6. Booking attempt loop with 2 retries (total 3 attempts)
    const MAX_RETRIES = 2;
    const MAX_ATTEMPTS = 1 + MAX_RETRIES;
    const RETRY_DELAY_MS = (process.env.NODE_ENV === 'test' || typeof describe === 'function') ? 10 : 2000;
    const triedSetsForCourt = new Set();
    let isSuccess = false;
    let lastBookRes = null;
    let lastCourtPlayers = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const unbookedDirect = directBookingPlayers.filter((p) => !bookedPlayerKeys.has(p.toLowerCase().trim()));
      let p1 = null;
      if (unbookedDirect.length > 0) {
        p1 = shuffleArray(unbookedDirect)[0];
      } else if (candidateBookingPool.length > 0) {
        p1 = candidateBookingPool[0];
      } else {
        p1 = pollState.creator?.name || 'Member';
      }

      const availableTeammates = candidateBookingPool.filter((p) => p.toLowerCase().trim() !== p1.toLowerCase().trim());
      const neededTeammates = Math.max(0, playersPerCourt - 1);
      let selectedTeammates = [];

      if (availableTeammates.length > 0 && neededTeammates > 0) {
        let foundNewCombo = false;
        for (let sampleTry = 0; sampleTry < 15; sampleTry++) {
          const shuffledTeammates = shuffleArray(availableTeammates);
          const candidateTeammates = shuffledTeammates.slice(0, neededTeammates);
          const setSig = [p1, ...candidateTeammates].map((x) => x.toLowerCase().trim()).sort().join('|');
          if (!triedSetsForCourt.has(setSig)) {
            selectedTeammates = candidateTeammates;
            triedSetsForCourt.add(setSig);
            foundNewCombo = true;
            break;
          }
        }
        if (!foundNewCombo) {
          selectedTeammates = shuffleArray(availableTeammates).slice(0, neededTeammates);
          const setSig = [p1, ...selectedTeammates].map((x) => x.toLowerCase().trim()).sort().join('|');
          triedSetsForCourt.add(setSig);
        }
      } else {
        const setSig = [p1].map((x) => x.toLowerCase().trim()).join('|');
        triedSetsForCourt.add(setSig);
      }

      const currentCourtPlayers = [p1, ...selectedTeammates];
      lastCourtPlayers = currentCourtPlayers;

      const retryLabel = attempt > 1 ? ` (retry ${attempt - 1}/${MAX_RETRIES})` : '';
      console.log(`[poll] On-demand booking attempting court ${courtToBook.court}${retryLabel} for ${remoteJid} on ${targetDateMDY} at ${queryTime} with players:`, currentCourtPlayers);

      const bookRes = await scvcc.bookCourt({
        when: targetDateMDY,
        date: targetDateMDY,
        time: queryTime,
        court: courtToBook.court,
        players: currentCourtPlayers,
        requester: currentCourtPlayers[0] || 'Member',
        requestedBy: currentCourtPlayers[0] || 'Member',
        sport,
        chatId: remoteJid,
        excludeCourts
      }).catch((err) => {
        console.error(`[poll] Error during on-demand booking for court ${courtToBook.court}${retryLabel}:`, err.message);
        return { success: false, message: err.message };
      });

      lastBookRes = bookRes;

      if (bookRes && bookRes.success && (!bookRes.court || formatCourtLabel(bookRes.court).toLowerCase() === formatCourtLabel(courtToBook.court).toLowerCase())) {
        isSuccess = true;
        break;
      }

      if (attempt < MAX_ATTEMPTS) {
        console.log(`[poll] On-demand booking failed for court ${courtToBook.court}${retryLabel}. Waiting ${RETRY_DELAY_MS}ms before retry...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }

    if (isSuccess) {
      console.log(`[poll] On-demand booking succeeded for ${courtToBook.court} on ${targetDateMDY} at ${queryTime}`);
      if (!Array.isArray(pollState.prebookedCourts)) pollState.prebookedCourts = [];
      pollState.prebookedCourts.push({
        court: lastBookRes.court || courtToBook.court,
        player: lastCourtPlayers[0] || 'Member',
        fullName: lastCourtPlayers.join(', ')
      });

      if (!Array.isArray(pollState.advanceBookedCourts)) pollState.advanceBookedCourts = [];
      pollState.advanceBookedCourts.push({
        court: lastBookRes.court || courtToBook.court,
        players: lastBookRes.players || lastCourtPlayers,
        date: lastBookRes.date || targetDateMDY,
        time: lastBookRes.time || queryTime,
        reservationId: lastBookRes.reservationId || null,
        duration: lastBookRes.duration || '90 Minutes',
        partySize: lastBookRes.partySize || (playersPerCourt === 2 ? 'Singles' : 'Doubles')
      });

      pollState.unbookedCourts = pollState.unbookedCourts.filter(
        (c) => formatCourtLabel(c.court).toLowerCase() !== formatCourtLabel(courtToBook.court).toLowerCase()
      );

      // On successful booking: do NOT send booking notifications to the group chat,
      // only send DMs to those listed in bookingNotifications.
      if (sock && remoteJid && lastBookRes.message) {
        await sendBookingNotifications(sock, remoteJid, lastBookRes.message);
      }

      // Send a simple one liner message to the group that court x is booked and how many players can now play
      const totalPlayersCanPlay = (Array.isArray(pollState.prebookedCourts) ? pollState.prebookedCourts.length : 0) * playersPerCourt;
      const playerWord = totalPlayersCanPlay === 1 ? 'player' : 'players';
      const courtLabel = formatCourtLabel(lastBookRes.court || courtToBook.court);
      const bookedGroupMsg = `🎾 *${courtLabel}* is booked! *${totalPlayersCanPlay} ${playerWord}* can now play.`;

      if (sock && remoteJid) {
        try {
          messageHistory.recordMessage(remoteJid, 'tenbot', bookedGroupMsg, Date.now(), true);
          await sock.sendMessage(remoteJid, { text: bookedGroupMsg });
          console.log(`[poll] Sent on-demand booking notification to group ${remoteJid}: "${bookedGroupMsg}"`);
        } catch (sendErr) {
          console.error('[poll] Error sending on-demand court booked notification to group:', sendErr.message);
        }
      }

      if (context.persistPolls) context.persistPolls();

      // Check if poll is now filled with the new court
      const currentRoster = resolveFixedPollRoster(pollState, aggregated);
      if (currentRoster.isAllFilled && pollState.status !== 'resolved' && pollState.status !== 'cancelled' && pollState.status !== 'stopped') {
        if (pollState.noMatchups) {
          if (pollState.status !== 'filled') {
            pollState.status = 'filled';
            pollState.lastPlayers = currentRoster.players;
            if (context.persistPolls) context.persistPolls();
          }
        } else {
          pollState.status = 'resolved';
          pollState.lastPlayers = currentRoster.players;
          if (context.persistPolls) context.persistPolls();
          await ratings.ensureRated(currentRoster.players);
          const prebookedCourts = await getPrebookedCourtsForPoll(pollState, pollState.remoteJid);
          const schedule = generateMatchups(currentRoster.players, { prebookedCourts, chatId: pollState.remoteJid });
          const whenHeader = formatMatchHeaderTime(pollState);
          const header = whenHeader ? `📅 ${whenHeader}\n\n` : '';
          await sock.sendMessage(pollState.remoteJid, { text: header + formatMatchups(schedule) });
          pairHistory.recordDraw(pollId, schedule, Date.now(), pollState.remoteJid);
          pollState.lastSchedule = summarizeSchedule(schedule);
          if (context.persistPolls) context.persistPolls();
        }
      }
    } else {
      console.warn(`[poll] On-demand booking failed for ${courtToBook.court} after ${MAX_ATTEMPTS} attempts: ${lastBookRes?.message || 'Court not available'}`);

      pollState.unbookedCourts = pollState.unbookedCourts.filter(
        (c) => formatCourtLabel(c.court).toLowerCase() !== formatCourtLabel(courtToBook.court).toLowerCase()
      );

      const validSlotsCount = (Array.isArray(pollState.prebookedCourts) ? pollState.prebookedCourts.length : 0) * playersPerCourt;
      const courtLabel = formatCourtLabel(courtToBook.court);
      const failMsg = `⚠️ *${courtLabel}* is no longer available. Only *${validSlotsCount} voting slots* are valid for this match poll.`;

      if (sock && remoteJid) {
        try {
          messageHistory.recordMessage(remoteJid, 'tenbot', failMsg, Date.now(), true);
          await sock.sendMessage(remoteJid, { text: failMsg });
        } catch (sendErr) {
          console.error('[poll] Error sending court unavailable notification:', sendErr.message);
        }
      }

      pollState.slotLimit = validSlotsCount;
      pollState.size = validSlotsCount;

      if (context.persistPolls) context.persistPolls();

      await checkAndNotifyInvalidSlotVotes(sock, pollId, pollState, aggregated, context);

      // Check if poll is filled after setting slotLimit
      const currentRoster = resolveFixedPollRoster(pollState, aggregated);
      if (currentRoster.isAllFilled && pollState.status !== 'resolved' && pollState.status !== 'cancelled' && pollState.status !== 'stopped') {
        if (pollState.noMatchups) {
          if (pollState.status !== 'filled') {
            pollState.status = 'filled';
            pollState.lastPlayers = currentRoster.players;
            if (context.persistPolls) context.persistPolls();
          }
        } else {
          pollState.status = 'resolved';
          pollState.lastPlayers = currentRoster.players;
          if (context.persistPolls) context.persistPolls();
          await ratings.ensureRated(currentRoster.players);
          const prebookedCourts = await getPrebookedCourtsForPoll(pollState, pollState.remoteJid);
          const schedule = generateMatchups(currentRoster.players, { prebookedCourts, chatId: pollState.remoteJid });
          const whenHeader = formatMatchHeaderTime(pollState);
          const header = whenHeader ? `📅 ${whenHeader}\n\n` : '';
          await sock.sendMessage(pollState.remoteJid, { text: header + formatMatchups(schedule) });
          pairHistory.recordDraw(pollId, schedule, Date.now(), pollState.remoteJid);
          pollState.lastSchedule = summarizeSchedule(schedule);
          if (context.persistPolls) context.persistPolls();
        }
      }
    }
  } catch (err) {
    console.error('[poll] Unexpected error in handleOnDemandCourtBooking:', err.message);
  } finally {
    pollState.onDemandBookingInProgress = false;
    pollState._bookingActive = false;
  }
}
async function createMatchPoll(
  sock,
  remoteJid,
  size = null,
  when = null,
  dayWord = null,
  timeWord = null,
  creatorName = null,
  creatorJid = null,
  includeCreator = true,
  replacePollId = null,
  cancelExisting = false,
  isCommand = false,
  noMatchups = false,
  checkCourts = false,
  includePrebookedSpots = false,
  isRecurring = false,
  scheduleId = null,
  targetCourt = null,
  courtBookingType = null,
  bookingPlayers = null,
  preBookCourts = null,
  bookingStrategy = null,
  preExistingBookings = null,
  context = {}
) {
  const { activePolls, messageStore, latestPollIdByChat, persistPolls } = context;
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

  if (effectiveDayWord && effectiveTimeWord && playAt.getTime() <= sjNow.getTime()) {
    const specifiedStr = when || `${effectiveDayWord} ${effectiveTimeWord}`;
    return {
      err: `The specified time (${specifiedStr}) has already passed. Please specify an upcoming day or time to create the poll.`
    };
  }

  const flightKey = `${remoteJid}:${scheduleId || 'manual'}:${playAt.toISOString()}`;
  if (inFlightPollCreations.has(flightKey)) {
    console.log(`[poll] Duplicate in-flight poll creation suppressed for ${flightKey}`);
    return { err: 'Poll creation already in progress' };
  }

  if (scheduleId && !cancelExisting && !replacePollId && activePolls) {
    const playDateStr = playAt.toDateString();
    for (const [id, existingPoll] of activePolls.entries()) {
      if (id !== replacePollId && existingPoll.remoteJid === remoteJid && (existingPoll.status === 'active' || existingPoll.status === 'filled')) {
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

    if (shouldIncludeCreator && (creatorJid || creatorName) && activePolls) {
      const CONFLICT_WINDOW_MS = 90 * 60 * 1000;
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
    let unbookedCourtsForPoll = [];

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

    let prebookedCourts = [];
    let freeCourts = [];
    const advanceBookedCourts = [];

    if (preExistingBookings && Array.isArray(preExistingBookings.advanceBookedCourts) && preExistingBookings.advanceBookedCourts.length > 0) {
      advanceBookedCourts.push(...preExistingBookings.advanceBookedCourts);
      if (Array.isArray(preExistingBookings.prebookedCourts)) {
        prebookedCourts.push(...preExistingBookings.prebookedCourts);
      }
      console.log(`[poll] Using pre-existing advance booked courts for ${remoteJid} on ${targetDateMDY}:`, advanceBookedCourts);
    } else {
      const isPreBook = String(courtBookingType).toLowerCase() === 'pre-book' || String(courtBookingType).toLowerCase() === 'prebook';
      if (isPreBook && groupsConfig.isCourtBookingEnabled(remoteJid)) {
        const groupCfg = groupsConfig.getGroupConfig(remoteJid);
        const effectiveStrategy = bookingStrategy || groupCfg?.bookingStrategy || 'instant';
        if (effectiveStrategy !== 'advanced') {
          const bookRes = await preBookCourtsForMatch({
            sock,
            remoteJid,
            targetDateMDY,
            queryTime,
            size,
            isAuto,
            preBookCourts,
            bookingPlayers,
            creatorName,
            creatorJid
          });
          if (bookRes.advanceBookedCourts?.length > 0) {
            advanceBookedCourts.push(...bookRes.advanceBookedCourts);
          }
          if (bookRes.prebookedCourts?.length > 0) {
            prebookedCourts.push(...bookRes.prebookedCourts);
          }
        } else {
          console.log(`[poll] bookingStrategy is 'advanced' for ${remoteJid}; court pre-booking is managed by bookingSchedule.`);
        }
      }
    }

    const effectiveCheckCourts = Boolean(checkCourts);
    const hasCourtChecks = isAuto || (effectiveCheckCourts && Boolean(queryTime));

    if (hasCourtChecks) {
      const seenPrebooked = new Set(prebookedCourts.map((c) => c.court));
      let courtCheckPerformed = false;

      try {
        const [avail, bookingsRes] = await Promise.all([
          scvcc.checkCourtAvailability({ when: targetDateMDY, time: queryTime, sport: 'tennis', chatId: remoteJid }).catch((err) => {
            console.warn('[poll] Error checking court availability:', err.message);
            return null;
          }),
          scvcc.getCourtBookings({ when: targetDateMDY, time: queryTime, sport: 'tennis', chatId: remoteJid }).catch((err) => {
            console.warn('[poll] Error checking court bookings:', err.message);
            return null;
          })
        ]);

        if (avail || bookingsRes) {
          courtCheckPerformed = true;
        }

        const bookings = bookingsRes?.bookings || [];
        for (const b of bookings) {
          if (courtsConfig.isIgnoredCourt(b.court)) continue;
          if (seenPrebooked.has(b.court)) continue;
          const prebookedMatch = detectPrebookedCourt(b, remoteJid);
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
            if (courtsConfig.isIgnoredCourt(c.court)) continue;
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
            } else if (
              c.status === 'unavailable' &&
              (!Array.isArray(c.prebookedPlayers) || c.prebookedPlayers.length === 0) &&
              !c.blockTitle &&
              !seenPrebooked.has(c.court)
            ) {
              freeCourts.push({ court: c.court, isOverride: true });
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
      prebookedCourts.push({
        court: targetCourt,
        player: creatorName || 'Member',
        fullName: creatorName || 'Member'
      });
    }

    let replacedOldPoll = false;
    if (replacePollId && activePolls && activePolls.has(replacePollId)) {
      await cancelOrDeletePoll(sock, remoteJid, replacePollId, context);
      replacedOldPoll = true;
    } else if (cancelExisting && activePolls) {
      for (const [pollId, pollState] of [...activePolls.entries()].reverse()) {
        if (pollState.remoteJid === remoteJid && pollState.status === 'active' && !pollState.isManual) {
          await cancelOrDeletePoll(sock, remoteJid, pollId, context);
          replacedOldPoll = true;
          break;
        }
      }
    }

    if (isAuto) {
      const maxAutoCourts = Math.max(3, advanceBookedCourts.length, (preBookCourts ? parseInt(preBookCourts, 10) : 0));
      selectedPrebooked = prebookedCourts.slice(0, maxAutoCourts);
      const remainingNeeded = Math.min(freeCourts.length, Math.max(0, maxAutoCourts - selectedPrebooked.length));
      const selectedFree = freeCourts.slice(0, remainingNeeded);
      unbookedCourtsForPoll = selectedFree.map((fc) => ({ court: fc.court, isOverride: Boolean(fc.isOverride) }));

      const totalCourtsCount = selectedPrebooked.length + selectedFree.length;
      validCount = totalCourtsCount > 0 ? totalCourtsCount * 4 : 4;

      const courtLines = [];
      prebookedInfo = [];
      for (const pb of selectedPrebooked) {
        const match = namesStore.findIdByNameOrAlias(pb.player);
        const canonicalName = (match && match.entry?.name) ? match.entry.name : pb.player;
        courtLines.push(`${formatCourtLabel(pb.court)} - Booked`);
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
        courtLines.push(`${formatCourtLabel(fc.court)} - Available`);
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
      if (targetCourt || (effectiveCheckCourts && totalCourtsCount > 0) || prebookedCourts.length > 0) {
        const courtsPerMatch = courtBookingType === 'singles' ? 2 : 4;
        const courtsNeeded = Math.ceil(validCount / courtsPerMatch);
        const pbCount = prebookedCourts.length;
        const neededFree = Math.min(freeCourts.length, Math.max(0, courtsNeeded - pbCount));
        const selectedFree = freeCourts.slice(0, neededFree);
        if (selectedFree.length > 0) {
          unbookedCourtsForPoll = selectedFree.map((fc) => ({ court: fc.court, isOverride: Boolean(fc.isOverride) }));
        }

        if (prebookedCourts.length > 0 && !targetCourt) {
          const pbLines = prebookedCourts.map((pb) => `${formatCourtLabel(pb.court)} - Booked`);
          for (const fc of selectedFree) {
            pbLines.push(`${formatCourtLabel(fc.court)} - Available`);
          }
          courtLine = `\n\n${pbLines.join('\n')}\n`;
        } else if (targetCourt) {
          const pbMatch = prebookedCourts.find((pb) => pb.court.toLowerCase() === targetCourt.toLowerCase());
          if (pbMatch) {
            courtLine = `\n\n${formatCourtLabel(targetCourt)} - Booked\n`;
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
      if (targetCourt || (effectiveCheckCourts && totalCourtsCount > 0) || prebookedCourts.length > 0) {
        if (prebookedCourts.length > 0 && !targetCourt) {
          const pbLines = prebookedCourts.map((pb) => `${formatCourtLabel(pb.court)} - Booked`);
          courtLine = `\n\n${pbLines.join('\n')}\n`;
        } else if (targetCourt) {
          const pbMatch = prebookedCourts.find((pb) => pb.court.toLowerCase() === targetCourt.toLowerCase());
          if (pbMatch) {
            courtLine = `\n\n${formatCourtLabel(targetCourt)} - Booked\n`;
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

    if (messageStore) messageStore.set(storeKey(sent.key.remoteJid, pollId), sent.message);
    const initialHours = (playAt.getTime() - Date.now()) / (60 * 60 * 1000);
    const sentReminders = POWERS_OF_2_REMINDER_HOURS.filter((h) => h > initialHours && h > 1);

    if (activePolls) {
      activePolls.set(pollId, {
        remoteJid,
        name: pollTitle,
        options: values,
        size: isOptIn ? null : validCount,
        type: isOptIn ? 'opt_in' : 'fixed',
        when: resolvedWhen || null,
        playAt: playAt.toISOString(),
        createdAt: new Date().toISOString(),
        status: 'active',
        isManual: false,
        isCommand: Boolean(isCommand),
        isAuto: Boolean(isAuto),
        isRecurring: Boolean(isRecurring),
        isAutoCreated: Boolean(isAuto || isRecurring),
        scheduleId: scheduleId || null,
        noMatchups: Boolean(noMatchups),
        checkCourts: Boolean(effectiveCheckCourts),
        court: targetCourt || null,
        courtBookingType: courtBookingType || null,
        preBookCourts: (preBookCourts !== undefined && preBookCourts !== null && parseInt(preBookCourts, 10) > 0) ? parseInt(preBookCourts, 10) : null,
        advanceBookedCourts: advanceBookedCourts.length > 0 ? advanceBookedCourts : null,
        bookingPlayers: bookingPlayers || null,
        targetDateMDY: targetDateMDY || null,
        queryTime: queryTime || null,
        prebookedCourts: (selectedPrebooked && selectedPrebooked.length > 0)
          ? selectedPrebooked.map((pb) => ({ court: pb.court, player: pb.player }))
          : (prebookedCourts.length > 0 ? prebookedCourts.map((pb) => ({ court: pb.court, player: pb.player })) : (targetCourt ? [{ court: targetCourt, player: creatorName || 'Member' }] : null)),
        prebookedPlayers: hasPrebooked ? prebookedInfo : null,
        unbookedCourts: unbookedCourtsForPoll.length > 0 ? unbookedCourtsForPoll : null,
        onDemandBookingInProgress: false,
        invalidSlotVotesNotified: [],
        creator: (!isAuto && !hasPrebooked && (shouldIncludeCreator || leadingVirtualCount > 0)) ? { name: (creatorName || 'Player 1'), jid: creatorJid || null } : null,
        lastConflictSignature: null,
        voteBuffer: new Map(),
        lastPlayers: null,
        sentReminders
      });
    }

    if (latestPollIdByChat) latestPollIdByChat.set(remoteJid, pollId);
    if (persistPolls) persistPolls();

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
      checkCourts: Boolean(effectiveCheckCourts),
      courtBookingType: courtBookingType || null,
      preBookCourts: (preBookCourts !== undefined && preBookCourts !== null && parseInt(preBookCourts, 10) > 0) ? parseInt(preBookCourts, 10) : null,
      advanceBookedCourts
    };
  } finally {
    inFlightPollCreations.delete(flightKey);
  }
}

function isDirectBookingUser(member, chatId = null) {
  if (!member) return false;
  const directAccounts = groupsConfig.getDirectCourtBookingAccounts(chatId);
  if (directAccounts.size === 0) return false;

  const id = (member.id || '').toLowerCase();
  const idNum = id.split('@')[0];
  const pn = (member.pn || '').toLowerCase();
  const pnNum = pn.split('@')[0];
  const full = (member.fullName || '').toLowerCase().trim();
  const disp = (member.name || '').toLowerCase().trim();

  return directAccounts.has(id) || directAccounts.has(idNum) || (pn && (directAccounts.has(pn) || directAccounts.has(pnNum))) || (full && directAccounts.has(full)) || (disp && directAccounts.has(disp));
}

function isPlaceholderPlayer(name) {
  if (!name) return true;
  const c = name.trim().toLowerCase();
  return !c || c === 'tbd' || c === 'blocked';
}

function getPlayerShortName(entry) {
  if (!entry) return '';
  const name = entry.name || entry.fullName || '';
  const words = name.trim().split(/\s+/);
  return words.length > 1 ? words[0] : name.trim();
}

function matchScvccPlayerToGroupMember(scvccPlayerName) {
  if (!scvccPlayerName) return null;
  const clean = scvccPlayerName.trim().toLowerCase();
  if (!clean || clean === 'tbd' || clean === 'blocked') return null;

  const scvccWords = clean.split(/[^a-z0-9]+/i).filter(Boolean);
  if (scvccWords.length === 0) return null;

  const allEntries = namesStore.getAllEntries();

  for (const entry of allEntries) {
    const full = (entry.fullName || '').trim().toLowerCase();
    const disp = (entry.name || '').trim().toLowerCase();
    if (full && clean === full) return entry;
    if (disp && clean === disp) return entry;
  }

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

  const byAlias = namesStore.findIdByNameOrAlias(scvccPlayerName);
  if (byAlias && byAlias.entry) {
    return byAlias.entry;
  }

  return null;
}

function detectPrebookedCourt(booking, chatId = null) {
  if (!booking || !Array.isArray(booking.players)) return null;
  if (courtsConfig.isIgnoredCourt(booking.court)) return null;

  const actualPlayers = booking.players.filter((p) => !isPlaceholderPlayer(p));
  if (actualPlayers.length === 0) return null;

  let directBookingMember = null;
  let allMembers = true;
  const matchedMembers = [];

  for (const p of actualPlayers) {
    const member = matchScvccPlayerToGroupMember(p);
    if (member) {
      matchedMembers.push(member);
      if (isDirectBookingUser(member, chatId)) {
        if (!directBookingMember) directBookingMember = member;
      }
    } else {
      allMembers = false;
    }
  }

  if (directBookingMember) {
    const playerName = getPlayerShortName(directBookingMember);
    return {
      isPrebooked: true,
      player: playerName,
      fullName: directBookingMember.fullName || directBookingMember.name,
      member: directBookingMember
    };
  }

  if (allMembers && matchedMembers.length > 0) {
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

async function processPollVoteEvent(sock, pollMessageKey, rawPollUpdates, context) {
  const { activePolls, messageStore, persistPolls } = context;
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
  if (!pollCreationMessage && messageStore) {
    for (const [k, v] of messageStore.entries()) {
      if (k.endsWith(`:${pollId}`)) {
        pollCreationMessage = v;
        break;
      }
    }
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

  if (pollState.status === 'cancelled' || pollState.status === 'stopped') return;

  if (pollState.remoteJid && pollState.remoteJid.endsWith('@g.us')) {
    await getGroupMetadata(sock, pollState.remoteJid);
  }

  const meLid = jidNormalizedUser(sock.user?.lid || sock.authState?.creds?.me?.lid || '');
  const mePn = jidNormalizedUser(sock.user?.id || sock.authState?.creds?.me?.id || '');

  const creatorJid = pollState.creator?.jid ? jidNormalizedUser(pollState.creator.jid) : null;
  const creationMsgParticipant = pollCreationMessage?.key?.participant ? jidNormalizedUser(pollCreationMessage.key.participant) : null;

  const pollCreatorCandidates = [
    meLid,
    mePn,
    creatorJid,
    creatorJid && namesStore.resolveCanonicalId(creatorJid),
    creatorJid && namesStore.getPnByLid(creatorJid),
    creationMsgParticipant,
    creationMsgParticipant && namesStore.resolveCanonicalId(creationMsgParticipant),
    creationMsgParticipant && namesStore.getPnByLid(creationMsgParticipant),
    pollMessageKey.participant ? jidNormalizedUser(pollMessageKey.participant) : null,
    pollMessageKey.participant && namesStore.resolveCanonicalId(jidNormalizedUser(pollMessageKey.participant)),
    pollMessageKey.participant && namesStore.getPnByLid(jidNormalizedUser(pollMessageKey.participant)),
    pollCreationMessage?.key?.remoteJid ? jidNormalizedUser(pollCreationMessage.key.remoteJid) : null,
    pollMessageKey.remoteJid ? jidNormalizedUser(pollMessageKey.remoteJid) : null
  ];

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
  persistPolls();

  const merged = [...pollState.voteBuffer.values()].map((u) => ({
    ...u,
    vote: normalizeVotePayload(u.vote)
  }));

  if (pollState.isManual) {
    let yesCount = 0;
    let noCount = 0;
    let filledCount = 0;
    let totalOptionsCount = pollState.options ? pollState.options.length : 0;
    let aggregated = [];
    try {
      aggregated = getAggregateVotesInPollMessage(
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

    if (pollState.type !== 'opt_in' && !pollState.options?.some((o) => /^yes$/i.test(o.trim()))) {
      const hasConflict = await checkAndNotifySlotConflicts(sock, pollId, pollState, aggregated, context);
      if (hasConflict) {
        return;
      }
    }

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

  const hasConflict = await checkAndNotifySlotConflicts(sock, pollId, pollState, aggregated, context);
  if (hasConflict) {
    return;
  }

  // On-demand court booking when player openings fall below 3
  if (
    pollState.type !== 'opt_in' &&
    Array.isArray(pollState.unbookedCourts) &&
    pollState.unbookedCourts.length > 0 &&
    Array.isArray(pollState.prebookedCourts) &&
    pollState.prebookedCourts.length > 0 &&
    !pollState.onDemandBookingInProgress
  ) {
    const bookedCourtsCount = pollState.prebookedCourts.length;
    const playersPerCourt = pollState.courtBookingType === 'singles' ? 2 : 4;
    const bookedCapacity = bookedCourtsCount * playersPerCourt;
    const tempRoster = resolveFixedPollRoster(pollState, aggregated);
    const playerOpenings = bookedCapacity - tempRoster.filledCount;

    if (playerOpenings < 3) {
      pollState.onDemandBookingInProgress = true;
      handleOnDemandCourtBooking(sock, pollId, pollState, aggregated, context).catch((err) => {
        console.error(`[poll] Unhandled error in background on-demand court booking for poll ${pollId}:`, err);
      });
    }
  }

  // Check and notify if any voters selected invalid slots (when slotLimit is set)
  await checkAndNotifyInvalidSlotVotes(sock, pollId, pollState, aggregated, context);

  const { players, excessPlayers, filledCount, totalSlotsCount, isAllFilled } = resolveFixedPollRoster(pollState, aggregated);

  if (pollState.slotLimit && excessPlayers && excessPlayers.length > 0) {
    const excessSig = excessPlayers.join('|');
    if (pollState.lastExcessSignature !== excessSig) {
      const prevExcess = (pollState.lastExcessSignature || '').split('|').filter(Boolean);
      const newExcess = excessPlayers.filter((p) => !prevExcess.includes(p));
      pollState.lastExcessSignature = excessSig;
      persistPolls();
      const alreadyNotifiedAny = Array.isArray(pollState.invalidSlotVotesNotified) && pollState.invalidSlotVotesNotified.length > 0;
      if (newExcess.length > 0 && !alreadyNotifiedAny) {
        const warnText = `⚠️ *Notice:* The slot limit for this match poll has been set to ${pollState.slotLimit} players and the poll is already filled! The vote(s) from *${newExcess.join(', ')}* cross this limit and will not be considered.`;
        console.log(`[poll] Sending excess votes warning in ${pollState.remoteJid}: ${newExcess.join(', ')}`);
        await sock.sendMessage(pollState.remoteJid, { text: warnText });
      }
    }
  }

  console.log(
    `[poll] Poll ${pollId}: ${filledCount}/${totalSlotsCount} slot(s) filled (${pollState.size} players total), ` +
    `0 conflicting slot(s), ${pollState.voteBuffer.size} raw vote(s) buffered.`
  );

  if (pollState.status !== 'active' && pollState.status !== 'filled') return;

  if (isAllFilled) {
    if (pollState.noMatchups) {
      if (pollState.status !== 'filled') {
        pollState.status = 'filled';
        pollState.lastPlayers = players;
        persistPolls();
        console.log(`[poll] Poll ${pollId} filled (${players.length} players: ${players.join(', ')}). Auto-matchup disabled; status set to filled; waiting for matchup request.`);
      }
      return;
    }

    pollState.status = 'resolved';
    pollState.lastPlayers = players;
    persistPolls();

    console.log(`[poll] Poll ${pollId} filled -- auto-posting matchups for: ${players.join(', ')}`);

    await ratings.ensureRated(players);
    const prebookedCourts = await getPrebookedCourtsForPoll(pollState, pollState.remoteJid);
    const schedule = generateMatchups(players, { prebookedCourts, chatId: pollState.remoteJid });
    const whenHeader = formatMatchHeaderTime(pollState);
    const header = whenHeader ? `📅 ${whenHeader}\n\n` : '';
    await sock.sendMessage(pollState.remoteJid, { text: header + formatMatchups(schedule) });
    pairHistory.recordDraw(pollId, schedule, Date.now(), pollState.remoteJid);

    pollState.lastSchedule = summarizeSchedule(schedule);
    persistPolls();
  } else if (pollState.status === 'filled') {
    pollState.status = 'active';
    persistPolls();
  }
}

/**
 * Handles text commands for poll management:
 * !stoppoll, !resumepoll, !cancelpoll, !rematch, !matchups, !draw,
 * !pollstatus, !activepolls, !upcomingpolls, !allpolls, !cleanuppolls,
 * !clearallpolls, !pausereminder, !resumereminder, !sendreminder,
 * !setslots, !modifyinstance
 */
async function handlePollCommand(sock, text, chatId, sender, senderJid, msg, context) {
  const lower = text.toLowerCase();
  const { activePolls, latestPollIdByChat, persistPolls, targetGroupJid } = context;

  // Poll control (!stoppoll, !closepoll, !resumepoll, !reopenpoll)
  if (lower.startsWith('!stoppoll') || lower.startsWith('!closepoll') || lower === '!stop' || lower === '!close') {
    const parts = text.split(/\s+/);
    const specificPollId = parts.length > 1 ? parts[1].trim() : null;
    return await handleStopPoll(sock, chatId, sender, senderJid, specificPollId, context);
  }

  if (lower.startsWith('!resumepoll') || lower.startsWith('!reopenpoll') || lower === '!resume' || lower === '!reopen') {
    const parts = text.split(/\s+/);
    const specificPollId = parts.length > 1 ? parts[1].trim() : null;
    return await handleResumePoll(sock, chatId, sender, senderJid, specificPollId, context);
  }

  // Reminders control (!pausereminder, !resumereminder, !sendreminder)
  if (lower.startsWith('!pausereminder') || lower.startsWith('!pausereminders') || lower === '!silencereminders') {
    const parts = text.split(/\s+/);
    const specificPollId = parts.length > 1 ? parts[1].trim() : null;
    return await handlePauseReminders(sock, chatId, sender, specificPollId, context);
  }

  if (lower.startsWith('!resumereminder') || lower.startsWith('!resumereminders') || lower.startsWith('!unpausereminder') || lower.startsWith('!unpausereminders')) {
    const parts = text.split(/\s+/);
    const specificPollId = parts.length > 1 ? parts[1].trim() : null;
    return await handleResumeReminders(sock, chatId, sender, specificPollId, context);
  }

  if (lower.startsWith('!sendreminder') || lower.startsWith('!remindpoll') || lower === '!remind' || lower === '!sendreminders' || lower === '!triggerreminder') {
    const parts = text.split(/\s+/);
    const specificPollId = parts.length > 1 ? parts[1].trim() : null;
    return await handleTriggerReminder(sock, chatId, sender, specificPollId, context);
  }

  // Clear / delete polls (!clearallpolls, !cancelpoll, !deletepoll)
  if (lower === '!clearallpolls' || lower === '!clearpolls') {
    return await handleClearAllPolls(sock, chatId, senderJid, context);
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
    const isCreator = targetPollState.creator ? isSameUser(targetPollState.creator.jid, senderJid, targetPollState.creator.name, sender) : false;
    const isAdmin = await isUserAdmin(sock, chatId, senderJid);

    if (!isCreator && !isAdmin) {
      return '⚠️ Only the poll creator or group admins can cancel this poll.';
    }

    await cancelOrDeletePoll(sock, chatId, targetPollId, context);
    return 'Poll cancelled and deleted from WhatsApp -- I won\'t auto-generate matchups from it anymore.';
  }

  // Rematch / Draw / Matchups
  if (lower === '!rematch' || lower === '!matchups' || lower === '!draw' || lower.startsWith('!rematch ') || lower.startsWith('!matchups ') || lower.startsWith('!draw ')) {
    const textFixedPairs = extractFixedPairsFromText(text);
    const cleanArg = text.replace(/^!(?:rematch|matchups|draw)\b/i, '')
      .replace(/\b(?:keeping|keep|put|with)\s+[a-z0-9\s._'-]+?\s+(?:and|&)\s+[a-z0-9\s._'-]+?\s+(?:in|on)\s+(?:the\s+)?(?:same\s+)?team\b/ig, '')
      .replace(/\b(?:keeping|keep|put|with)\s+[a-z0-9\s._'-]+?\s+(?:and|&)\s+[a-z0-9\s._'-]+?\s+together\b/ig, '')
      .replace(/\b[a-z0-9\s._'-]+?\s+(?:and|&)\s+[a-z0-9\s._'-]+?\s+(?:in|on)\s+(?:the\s+)?(?:same\s+)?team\b/ig, '')
      .trim();
    return await generateMatchupsFromPoll(sock, chatId, null, cleanArg || null, { fixedPairs: textFixedPairs }, context);
  }

  // Cleanup old polls
  if (lower === '!cleanuppolls') {
    const isAdmin = await isUserAdmin(sock, chatId, senderJid);
    if (!isAdmin) {
      return '⚠️ Only group admins can use !cleanuppolls.';
    }
    const removed = cleanupExpiredPolls(context);
    return removed.length
      ? `Cleaned up ${removed.length} old poll(s).`
      : 'Nothing to clean up yet -- no polls have passed their play time + grace period.';
  }

  // Slot limit (!setslots, !limitslots)
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
    return await handleSetPollSlots(sock, chatId, sender, senderJid, target, count, context);
  }

  // Modify instance (!modifyinstance)
  const modifyInstanceCmd = parseModifyInstanceCommand(text);
  if (modifyInstanceCmd) {
    if (!modifyInstanceCmd.targetId) {
      return 'Please specify which poll instance to modify, e.g. "!modifyinstance rec_1 12 7pm" or "!modifyinstance <pollId> 8".';
    }
    return await handleModifyPollInstance(sock, chatId, sender, senderJid, modifyInstanceCmd.targetId, modifyInstanceCmd.updates, context);
  }

  // Status queries (!activepolls, !upcomingpolls, !allpolls, !pollstatus)
  if (lower === '!activepolls' || lower === '!activepollstatus' || lower === '!active' || lower === '!pollstatus active' || lower === '!pollstatus -act') {
    return pollStatusText(null, { activeOnly: true }, context);
  }

  if (lower === '!upcomingpolls' || lower === '!upcomingpollstatus' || lower === '!upcoming' || lower === '!pollstatus upcoming' || lower === '!pollstatus -u') {
    return pollStatusText(null, { upcomingOnly: true }, context);
  }

  if (lower === '!allpolls' || lower === '!allpollstatus' || lower === '!pollstatus all' || lower === '!pollstatusall' || lower === '!pollstatus -a') {
    const isAdmin = await isUserAdmin(sock, chatId, senderJid);
    if (!isAdmin) {
      return '⚠️ Only group admins can view status of all polls.';
    }
    return pollStatusText(null, {}, context);
  }

  if (lower === '!pollstatus') {
    const effectiveChatId = chatId.endsWith('@g.us') ? chatId : (targetGroupJid || await getTargetGroupJid(sock) || chatId);
    return pollStatusText(effectiveChatId, {}, context);
  }

  if (lower.startsWith('!pollstatus ') || lower.startsWith('!pollstatus:')) {
    const rawTarget = text.trim().slice('!pollstatus'.length).replace(/^[:\s]+/, '').trim();
    const cleanTarget = rawTarget.replace(/^["']|["']$/g, '').replace(/^schedule\s+/i, '').trim();
    const effectiveChatId = chatId.endsWith('@g.us') ? chatId : (targetGroupJid || await getTargetGroupJid(sock) || chatId);
    if (cleanTarget) {
      if (cleanTarget === 'recurring' || cleanTarget === '-r' || cleanTarget === 'scheduled' || cleanTarget === '-s') {
        return pollStatusText(effectiveChatId, { recurringOnly: true }, context);
      }
      return pollStatusText(effectiveChatId, { targetId: cleanTarget }, context);
    }
    return pollStatusText(effectiveChatId, {}, context);
  }

  return null;
}

/**
 * Handles LLM tool calls for match polls.
 */
async function executePollTool(sock, name, input, sender, senderJid, chatId, msg, context) {
  const { activePolls, latestPollIdByChat } = context;

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
    const courtBookingType = input.courtBookingType || null;
    const bookingPlayers = input.bookingPlayers ? groupsConfig.normalizeBookingPlayerLists(input.bookingPlayers) : null;
    const preBookCourts = (input.preBookCourts !== undefined && input.preBookCourts !== null && parseInt(input.preBookCourts, 10) > 0)
      ? parseInt(input.preBookCourts, 10)
      : (input.preBookCourtsCount !== undefined && input.preBookCourtsCount !== null && parseInt(input.preBookCourtsCount, 10) > 0
        ? parseInt(input.preBookCourtsCount, 10)
        : null);

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
      replacePollId,
      cancelExisting,
      false,
      noMatchups,
      checkCourts,
      includePrebookedSpots,
      false,
      null,
      court,
      courtBookingType,
      bookingPlayers,
      preBookCourts,
      null,
      null,
      context
    );

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
    }, context);
    return res || 'Matchups generated and posted.';
  }

  if (name === 'stop_poll') {
    return await handleStopPoll(sock, chatId, sender, senderJid, input.pollId || null, context);
  }

  if (name === 'resume_poll') {
    return await handleResumePoll(sock, chatId, sender, senderJid, input.pollId || null, context);
  }

  if (name === 'pause_reminders') {
    return await handlePauseReminders(sock, chatId, sender, input.pollId || null, context);
  }

  if (name === 'resume_reminders') {
    return await handleResumeReminders(sock, chatId, sender, input.pollId || null, context);
  }

  if (name === 'trigger_reminder' || name === 'send_reminder') {
    const res = await handleTriggerReminder(sock, chatId, sender, input.pollId || null, context);
    return res || 'Reminder triggered and sent to group.';
  }

  if (name === 'limit_poll_slots' || name === 'set_poll_slots') {
    return await handleSetPollSlots(sock, chatId, sender, senderJid, input.targetId || null, input.slots, context);
  }

  if (name === 'modify_poll_instance') {
    return await handleModifyPollInstance(sock, chatId, sender, senderJid, input.targetId, input, context);
  }

  if (name === 'clear_all_polls') {
    return await handleClearAllPolls(sock, chatId, senderJid, context);
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
    const isCreator = targetPollState.creator ? isSameUser(targetPollState.creator.jid, senderJid, targetPollState.creator.name, sender) : false;
    const isAdmin = await isUserAdmin(sock, chatId, senderJid);

    if (!isCreator && !isAdmin) {
      return '⚠️ Only the poll creator or group admins can cancel this poll.';
    }

    await cancelOrDeletePoll(sock, chatId, targetPollId, context);
    return 'Poll cancelled and deleted from WhatsApp successfully.';
  }

  return `Unknown poll tool ${name}`;
}

module.exports = {
  isMatchSchedulingPoll,
  interpretManualPollWithLLM,
  isValidPlayerCount,
  getNextValidPlayerCount,
  getFirstSlotNumber,
  addNextCreatorPlayer,
  resolveManualPollPlayers,
  resolveFixedPollRoster,
  getPollVoters,
  parsePollCreationText,
  handleDirectPollCreation,
  isUserInPoll,
  getMessageSecret,
  normalizeVotePayload,
  safeDecryptPollVote,
  deletePollFromWhatsApp,
  handlePollDeleted,
  cancelOrDeletePoll,
  handleDeleteAllPolls,
  handleClearAllPolls,
  cleanupExpiredPolls,
  buildPollReminderText,
  sendPollReminder,
  isAutoCreatedPoll,
  checkAndSendPollReminders,
  findSpecificPoll,
  getPollScheduleId,
  handleTriggerReminder,
  handlePauseReminders,
  handleResumeReminders,
  parseModifyInstanceCommand,
  handleModifyPollInstance,
  handleSetPollSlots,
  handleStopPoll,
  handleResumePoll,
  extractFixedPairsFromText,
  formatMatchHeaderTime,
  getPrebookedCourtsForPoll,
  generateMatchupsFromPoll,
  pollStatusText,
  getVoteTimestamp,
  getVoteArrivalIndex,
  checkAndNotifySlotConflicts,
  getSlotNumberForOption,
  checkAndNotifyInvalidSlotVotes,
  handleOnDemandCourtBooking,
  preBookCourtsForMatch,
  createMatchPoll,
  processPollVoteEvent,
  handlePollCommand,
  executePollTool,
  nameFor
};
