/**
 * Recurring Polls module: manages creation, listing, cancellation, pausing,
 * modification, and automatic posting of recurring tennis match polls (daily or on specific days of the week).
 */

const { parseTimeString, getSanJoseParts } = require('./pollTime');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Sanitizes input text by removing zero-width characters and normalizing Unicode whitespace.
 */
function cleanIncomingText(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/[   - ]/g, ' ')
    .trim();
}

const DAY_LOOKUP = {
  sun: 0, sunday: 0, sundays: 0,
  mon: 1, monday: 1, mondays: 1,
  tue: 2, tues: 2, tuesday: 2, tuesdays: 2,
  wed: 3, weds: 3, wednesday: 3, wednesdays: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, thursdays: 4,
  fri: 5, friday: 5, fridays: 5,
  sat: 6, saturday: 6, saturdays: 6
};

/**
 * Parses days of the week from a string (e.g. "weekdays", "mon,wed,fri", "tuesdays and thursdays", "sat-sun", "everyday")
 * or array of numbers/strings into a normalized list of day indices (0=Sun .. 6=Sat) and human display text.
 */
function parseDaysOfWeek(input) {
  if (!input) return { days: [0, 1, 2, 3, 4, 5, 6], display: 'Every day', raw: 'everyday' };

  if (Array.isArray(input)) {
    const dayIndices = new Set();
    for (const item of input) {
      if (typeof item === 'number' && item >= 0 && item <= 6) {
        dayIndices.add(item);
      } else if (typeof item === 'string') {
        const sub = parseDaysOfWeek(item);
        for (const d of sub.days) dayIndices.add(d);
      }
    }
    if (dayIndices.size === 0) return { days: [0, 1, 2, 3, 4, 5, 6], display: 'Every day', raw: 'everyday' };
    const sorted = [...dayIndices].sort((a, b) => a - b);
    return formatDaysResult(sorted);
  }

  const str = String(input).toLowerCase().trim();
  if (!str || /^(?:everyday|every\s*day|daily|all|any)$/i.test(str)) {
    return { days: [0, 1, 2, 3, 4, 5, 6], display: 'Every day', raw: 'everyday' };
  }

  if (/\b(?:weekdays?|mon(?:day)?\s*(?:-|to|through)\s*fri(?:day)?)\b/i.test(str)) {
    return formatDaysResult([1, 2, 3, 4, 5], 'Weekdays (Mon–Fri)');
  }

  if (/\b(?:weekends?|sat(?:urday)?\s*(?:&|and)?\s*sun(?:day)?)\b/i.test(str)) {
    return formatDaysResult([0, 6], 'Weekends (Sat, Sun)');
  }

  const dayIndices = new Set();

  // Check for day ranges (e.g. mon-thu, monday-thursday, mon to thu, mon through thu, mon thru thu, fri-sun)
  const rangeRegex = /(?:\bfrom\s+)?\b(sun(?:day|days)?|mon(?:day|days)?|tue(?:s|sday|sdays)?|wed(?:nesday|nesdays)?|thu(?:r|rs|rsday|rsdays)?|fri(?:day|days)?|sat(?:urday|urdays)?)\s*(?:-|to|through|thru|until|till)\s*(sun(?:day|days)?|mon(?:day|days)?|tue(?:s|sday|sdays)?|wed(?:nesday|nesdays)?|thu(?:r|rs|rsday|rsdays)?|fri(?:day|days)?|sat(?:urday|urdays)?)\b/gi;
  let rMatch;
  while ((rMatch = rangeRegex.exec(str)) !== null) {
    const startIdx = DAY_LOOKUP[rMatch[1].toLowerCase()];
    const endIdx = DAY_LOOKUP[rMatch[2].toLowerCase()];
    if (startIdx !== undefined && endIdx !== undefined) {
      if (startIdx <= endIdx) {
        for (let i = startIdx; i <= endIdx; i++) dayIndices.add(i);
      } else {
        for (let i = startIdx; i <= 6; i++) dayIndices.add(i);
        for (let i = 0; i <= endIdx; i++) dayIndices.add(i);
      }
    }
  }

  // Check individual day words
  const singleRegex = /\b(sundays?|sun|mondays?|mon|tuesdays?|tues|tue|wednesdays?|weds|wed|thursdays?|thurs|thur|thu|fridays?|fri|saturdays?|sat)\b/gi;
  let sMatch;
  while ((sMatch = singleRegex.exec(str)) !== null) {
    const dIdx = DAY_LOOKUP[sMatch[1].toLowerCase()];
    if (dIdx !== undefined) dayIndices.add(dIdx);
  }

  if (dayIndices.size === 0) {
    return { days: [0, 1, 2, 3, 4, 5, 6], display: 'Every day', raw: 'everyday' };
  }

  const sorted = [...dayIndices].sort((a, b) => a - b);
  return formatDaysResult(sorted);
}

function formatDaysResult(sortedDays, explicitDisplay = null) {
  if (sortedDays.length === 7) {
    return { days: sortedDays, display: 'Every day', raw: 'everyday' };
  }
  if (sortedDays.length === 5 && [1, 2, 3, 4, 5].every((d) => sortedDays.includes(d))) {
    return { days: sortedDays, display: 'Weekdays (Mon–Fri)', raw: 'weekdays' };
  }
  if (sortedDays.length === 4 && [1, 2, 3, 4].every((d) => sortedDays.includes(d))) {
    return { days: sortedDays, display: 'Mon–Thu (Mon, Tue, Wed, Thu)', raw: 'mon-thu' };
  }
  if (sortedDays.length === 2 && [0, 6].every((d) => sortedDays.includes(d))) {
    return { days: sortedDays, display: 'Weekends (Sat, Sun)', raw: 'weekends' };
  }

  // If consecutive range of 3 or more days, show range label with expanded days
  const isConsecutive = sortedDays.length >= 3 && sortedDays.every((val, idx) => idx === 0 || val === sortedDays[idx - 1] + 1);
  let defaultDisplay = sortedDays.map((d) => DAY_SHORT[d]).join(', ');
  if (isConsecutive && sortedDays.length < 5) {
    defaultDisplay = `${DAY_SHORT[sortedDays[0]]}–${DAY_SHORT[sortedDays[sortedDays.length - 1]]} (${defaultDisplay})`;
  }

  const display = explicitDisplay || defaultDisplay;
  const raw = sortedDays.map((d) => DAY_SHORT[d].toLowerCase()).join(',');
  return { days: sortedDays, display, raw };
}

/**
 * Extracts days of the week phrases from user text.
 */
function extractDaysFromText(text) {
  if (!text) return null;
  const lower = cleanIncomingText(text).toLowerCase();

  if (/\b(?:weekdays?|mon(?:day)?\s*(?:-|to|through)\s*fri(?:day)?)\b/i.test(lower)) {
    return 'weekdays';
  }
  if (/\b(?:weekends?|sat(?:urday)?\s*(?:&|and)?\s*sun(?:day)?)\b/i.test(lower)) {
    return 'weekends';
  }
  if (/\b(?:everyday|every\s+day|daily)\b/i.test(lower)) {
    return 'everyday';
  }

  const dayTokens = [];
  let textForExtract = lower;
  const rangeRegex = /(?:\b(?:on|every|from)\s+)?\b(sun(?:days?)?|mon(?:days?)?|tue(?:s(?:days?)?)?|wed(?:nesdays?)?|thu(?:r(?:s(?:days?)?)?)?|fri(?:days?)?|sat(?:urdays?)?)\s*(?:-|to|through|thru|until|till)\s*(sun(?:days?)?|mon(?:days?)?|tue(?:s(?:days?)?)?|wed(?:nesdays?)?|thu(?:r(?:s(?:days?)?)?)?|fri(?:days?)?|sat(?:urdays?)?)\b/gi;
  let rMatch;
  while ((rMatch = rangeRegex.exec(textForExtract)) !== null) {
    dayTokens.push(`${rMatch[1]}-${rMatch[2]}`);
  }
  textForExtract = textForExtract.replace(rangeRegex, ' ');

  const singleRegex = /\b(?:on\s+|every\s+)?(sundays?|sun|mondays?|mon|tuesdays?|tues|tue|wednesdays?|weds|wed|thursdays?|thurs|thur|thu|fridays?|fri|saturdays?|sat)\b/gi;
  let sMatch;
  while ((sMatch = singleRegex.exec(textForExtract)) !== null) {
    dayTokens.push(sMatch[1]);
  }

  if (dayTokens.length > 0) {
    return dayTokens.join(',');
  }

  return null;
}

/**
 * Parses user input to detect recurring/daily poll commands or natural language phrases.
 */
function parseRecurringPollText(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const text = cleanIncomingText(rawText);

  // 1. Check sub-commands (cancel/clear all, list, cancel, pause, resume, modify/edit)
  if (/^!(?:clearallrecurringpolls|clearrecurringpolls|cancelallrecurringpolls|deleteallrecurringpolls|removeallrecurringpolls|clearallrecurring|cancelallrecurring)\b/i.test(text) ||
      /^!(?:clearallrecurringpoll|cancelallrecurringpoll)\b/i.test(text) ||
      /^!(?:cancelrecurringpoll|deleterecurringpoll|removerecurringpoll|recurringpoll|dailypoll|schedulepoll|recurringpolls|dailypolls)\s+(?:all|clearall|cancelall|deleteall|clear|cancel\s+all|delete\s+all)\b/i.test(text) ||
      /\b(?:clear|cancel|delete|remove)\s+all\s+(?:daily|recurring|scheduled)\s+polls\b/i.test(text)) {
    return { action: 'clear_all' };
  }

  if (/^!(?:recurringpolls|scheduledpolls|dailypolls)\b/i.test(text) ||
      /^!(?:recurringpoll|dailypoll|schedulepoll)\s+(?:list|status|show)\b/i.test(text) ||
      /\b(?:list|show|view|display)\s+(?:all\s+)?(?:daily|recurring|scheduled)\s+polls\b/i.test(text)) {
    return { action: 'list' };
  }

  const cancelMatch = text.match(/^!(?:cancelrecurringpoll|deleterecurringpoll|removerecurringpoll|rmrecurringpoll|clearrecurringpoll)\s*(?:poll\s+)?(?:[`'"])?([^\s`'"]+)?(?:[`'"])?\s*$/i) ||
    text.match(/^!(?:recurringpoll|dailypoll|schedulepoll)\s+(?:cancel|delete|remove|rm|clear)\s*(?:poll\s+)?(?:[`'"])?([^\s`'"]+)?(?:[`'"])?\s*$/i) ||
    text.match(/\b(?:cancel|delete|remove|clear)\s+(?:daily|recurring|scheduled)\s+poll\s+(?:[`'"])?([^\s`'"]+)(?:[`'"])?\b/i);
  if (cancelMatch) {
    const rawId = String(cancelMatch[1] || '').trim();
    if (/^all$/i.test(rawId)) {
      return { action: 'clear_all' };
    }
    return { action: 'cancel', scheduleId: rawId || null };
  }

  const pauseMatch = text.match(/^!(?:pauserecurringpoll|stoprecurringpoll)\s*(?:poll\s+)?(?:[`'"])?([^\s`'"]+)?(?:[`'"])?\s*$/i) ||
    text.match(/^!(?:recurringpoll|dailypoll|schedulepoll)\s+(?:pause|stop)\s*(?:poll\s+)?(?:[`'"])?([^\s`'"]+)?(?:[`'"])?\s*$/i) ||
    text.match(/\b(?:pause|stop)\s+(?:daily|recurring|scheduled)\s+poll\s+(?:[`'"])?([^\s`'"]+)(?:[`'"])?\b/i);
  if (pauseMatch) {
    return { action: 'pause', scheduleId: pauseMatch[1]?.trim() || null };
  }

  const resumeMatch = text.match(/^!(?:resumerecurringpoll|startrecurringpoll)\s*(?:poll\s+)?(?:[`'"])?([^\s`'"]+)?(?:[`'"])?\s*$/i) ||
    text.match(/^!(?:recurringpoll|dailypoll|schedulepoll)\s+(?:resume|start)\s*(?:poll\s+)?(?:[`'"])?([^\s`'"]+)?(?:[`'"])?\s*$/i) ||
    text.match(/\b(?:resume|start)\s+(?:daily|recurring|scheduled)\s+poll\s+(?:[`'"])?([^\s`'"]+)(?:[`'"])?\b/i);
  if (resumeMatch) {
    return { action: 'resume', scheduleId: resumeMatch[1]?.trim() || null };
  }

  const modifyMatch = text.match(/^!(?:modifyrecurringpoll|editrecurringpoll|updaterecurringpoll|changerecurringpoll|modifyrecurring|editrecurring|updaterecurring)\s+(?:poll\s+)?(?:[`'"])?([^\s`'"]+)?(?:[`'"])?\s*(.*)$/i) ||
    text.match(/^!(?:recurringpoll|dailypoll|schedulepoll)\s+(?:modify|edit|update|change)\s+(?:poll\s+)?(?:[`'"])?([^\s`'"]+)?(?:[`'"])?\s*(.*)$/i) ||
    text.match(/\b(?:modify|edit|update|change)\s+(?:daily|recurring|scheduled)\s+poll\s+(?:[`'"])?([^\s`'"]+)(?:[`'"])?\s*(.*)$/i);
  if (modifyMatch) {
    const scheduleId = modifyMatch[1]?.trim() || null;
    const rest = modifyMatch[2]?.trim() || '';

    const isExplicitOptIn = /\b(?:opt-?in|yes\s*\/\s*no|yesno|open)\b/i.test(rest);
    const daysString = extractDaysFromText(rest);

    const timeRegex = /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b|\b(\d{1,2}:\d{2})\b/gi;
    const timeTokens = [];
    let tm;
    while ((tm = timeRegex.exec(rest)) !== null) {
      timeTokens.push({ token: (tm[1] || tm[2]).trim(), index: tm.index });
    }

    let matchTime = null;
    let postTime = null;
    if (timeTokens.length === 1) {
      const before = rest.slice(Math.max(0, timeTokens[0].index - 15), timeTokens[0].index);
      if (/\b(?:post(?:ed)?|posting|at)\s*$/i.test(before)) {
        postTime = timeTokens[0].token;
      } else {
        matchTime = timeTokens[0].token;
      }
    } else if (timeTokens.length >= 2) {
      const postIdx = timeTokens.findIndex((t) => {
        const before = rest.slice(Math.max(0, t.index - 15), t.index);
        return /\b(?:post(?:ed)?|posting)\s*(?:at)?\s*$/i.test(before);
      });
      if (postIdx !== -1) {
        postTime = timeTokens[postIdx].token;
        matchTime = timeTokens[postIdx === 0 ? 1 : 0].token;
      } else {
        matchTime = timeTokens[0].token;
        postTime = timeTokens[1].token;
      }
    }

    let textCleaned = rest.replace(timeRegex, ' ');
    textCleaned = textCleaned.replace(/\b(?:weekdays?|weekends?|everyday|every\s+day|daily|sundays?|sun|mondays?|mon|tuesdays?|tues|tue|wednesdays?|weds|wed|thursdays?|thurs|thur|thu|fridays?|fri|saturdays?|sat)\b/gi, ' ');

    let size = null;
    if (!isExplicitOptIn) {
      const sizeExplicit = textCleaned.match(/\b(?:for|size|spots?|players?)\s*[:=]?\s*([1-9]|1[0-6])\b/i) ||
        textCleaned.match(/\b([1-9]|1[0-6])\s*(?:spots?|players?|people|courts?)\b/i) ||
        textCleaned.match(/\b([1-9]|1[0-6])\b/);
      if (sizeExplicit) {
        size = parseInt(sizeExplicit[1], 10);
      } else if (/\bsingles\b/i.test(textCleaned)) {
        size = 2;
      } else if (/\bdoubles\b/i.test(textCleaned)) {
        size = 4;
      }
    }

    let autoMatchups = undefined;
    let noMatchups = undefined;
    if (/(?:^|\s)(?:--no-?matchups?|--no-?draw)\b|\b(?:no[-_\s]*matchups?|no[-_\s]*draw|without\s+(?:auto[-_\s]*|automatic\s+)?matchups?|without\s+(?:auto[-_\s]*|automatic\s+)?draw|(?:do\s*not|don\x27?t)\s+(?:create|make|generate|post|auto-?generate)\s+(?:matchups?|draw|the\s+draw|the\s+matchups?)|no[-_\s]*(?:auto\s+|automatic\s+)?matchups?)\b/i.test(rest)) {
      autoMatchups = false;
      noMatchups = true;
    } else if (/\b(?:auto-?matchups?|auto-?draw|with\s+matchups?|enable\s+matchups?)\b/i.test(rest)) {
      autoMatchups = true;
      noMatchups = false;
    }

    let includeCreator = undefined;
    if (/\b(?:include\s+me|with\s+me|count\s+me\s+in|i'm\s+playing|im\s+playing)\b/i.test(rest)) {
      includeCreator = true;
    } else if (/\b(?:exclude\s+me|without\s+me|not\s+playing)\b/i.test(rest)) {
      includeCreator = false;
    }

    return {
      action: 'modify',
      scheduleId,
      updates: {
        size,
        matchTime,
        postTime,
        days: daysString,
        isExplicitOptIn,
        autoMatchups,
        noMatchups,
        includeCreator
      }
    };
  }

  // 2. Check creation command or phrase
  const isCommand = /^!(?:recurringpoll|dailypoll|schedulepoll|everydaypoll|repeatingpoll|recurringoptinpoll|dailyoptinpoll|recurringyesnopoll|dailyyesnopoll)\b/i.test(text);
  const isPhrase = /\b(?:schedule|create|set\s*up|setup|start|post)\s+(?:a\s+)?(?:new\s+)?(?:daily\s+|recurring\s+|repeating\s+|every\s*day\s+)(?:match\s+)?(?:singles\s+|doubles\s+|yes\/no\s+|yesno\s+|opt-?in\s+)?poll\b|\b(?:daily|recurring|repeating)\s+(?:match\s+)?(?:yes\/no\s+|yesno\s+|opt-?in\s+)?poll\b|\bpoll\s+every\s*day\b|\b(?:schedule|create|set\s*up|setup|post)\s+(?:a\s+)?(?:match\s+)?poll\s+(?:every|on)\s+(?:weekdays?|weekends?|mondays?|tuesdays?|wednesdays?|thursdays?|fridays?|saturdays?|sundays?)\b/i.test(text);

  if (!isCommand && !isPhrase) {
    return null;
  }

  const isExplicitOptIn = /\b(?:opt-?in|yes\s*\/\s*no|yesno|open)\b/i.test(text) ||
    /^!(?:recurringoptinpoll|dailyoptinpoll|recurringyesnopoll|dailyyesnopoll)\b/i.test(text);

  // 3. Extract days of week
  const daysString = extractDaysFromText(text) || 'everyday';
  const parsedDays = parseDaysOfWeek(daysString);

  // 4. Extract times (matchTime, postTime)
  const timeRegex = /\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b|\b(\d{1,2}:\d{2})\b/gi;
  const timeTokens = [];
  let tm;
  while ((tm = timeRegex.exec(text)) !== null) {
    timeTokens.push({
      token: (tm[1] || tm[2]).trim(),
      index: tm.index
    });
  }

  let matchTime = null;
  let postTime = null;

  if (timeTokens.length === 1) {
    matchTime = timeTokens[0].token;
  } else if (timeTokens.length >= 2) {
    const postIdx = timeTokens.findIndex((t) => {
      const before = text.slice(Math.max(0, t.index - 15), t.index);
      return /\b(?:post(?:ed)?|posting)\s*(?:at)?\s*$/i.test(before);
    });
    if (postIdx !== -1) {
      postTime = timeTokens[postIdx].token;
      matchTime = timeTokens[postIdx === 0 ? 1 : 0].token;
    } else {
      matchTime = timeTokens[0].token;
      postTime = timeTokens[1].token;
    }
  }

  // 5. Extract player count / spots AFTER removing time tokens and day tokens
  let textCleaned = text.replace(timeRegex, ' ');
  textCleaned = textCleaned.replace(/\b(?:weekdays?|weekends?|everyday|every\s+day|daily|sundays?|sun|mondays?|mon|tuesdays?|tues|tue|wednesdays?|weds|wed|thursdays?|thurs|thur|thu|fridays?|fri|saturdays?|sat)\b/gi, ' ');

  let size = null;
  if (!isExplicitOptIn) {
    const sizeExplicit = textCleaned.match(/\b(?:for|size|spots?|players?)\s*[:=]?\s*([1-9]|1[0-6])\b/i) ||
      textCleaned.match(/^!(?:recurringpoll|dailypoll|schedulepoll)\s+([1-9]|1[0-6])\b/i) ||
      textCleaned.match(/\b([1-9]|1[0-6])\s*(?:spots?|players?|people|courts?)\b/i) ||
      textCleaned.match(/\bpoll\s+for\s+([1-9]|1[0-6])\b/i);
    if (sizeExplicit) {
      size = parseInt(sizeExplicit[1], 10);
    } else if (/\bsingles\b/i.test(textCleaned)) {
      size = 2;
    } else if (/\bdoubles\b/i.test(textCleaned)) {
      size = 4;
    }
  }

  let includeCreator = false;
  if (/\b(?:include\s+me|with\s+me|count\s+me\s+in|i'm\s+playing|im\s+playing)\b/i.test(text)) {
    includeCreator = true;
  }

  // 6. Check if auto-matchup creation should be disabled
  const noMatchups = /(?:^|\s)(?:--no-?matchups?|--no-?draw)\b|\b(?:no[-_\s]*matchups?|no[-_\s]*draw|without\s+(?:auto[-_\s]*|automatic\s+)?matchups?|without\s+(?:auto[-_\s]*|automatic\s+)?draw|(?:do\s*not|don\x27?t)\s+(?:create|make|generate|post|auto-?generate)\s+(?:matchups?|draw|the\s+draw|the\s+matchups?)|no[-_\s]*(?:auto\s+|automatic\s+)?matchups?)\b/i.test(text);

  return {
    action: 'create',
    size,
    matchTime,
    postTime,
    days: parsedDays.raw,
    daysList: parsedDays.days,
    daysDisplay: parsedDays.display,
    includeCreator,
    autoMatchups: !noMatchups,
    noMatchups
  };
}

/**
 * Creates and registers a new recurring poll schedule.
 */
async function scheduleRecurringPoll({ recurringPolls, persistPolls, targetChatId, sender, senderJid, params }) {
  const { size, matchTime, postTime, days, includeCreator, autoMatchups, noMatchups } = params || {};
  if (!matchTime) {
    return 'Please provide a match time for the recurring poll (e.g. "!recurringpoll 4 7pm at 8am on weekdays" or "!recurringpoll opt-in 7pm").';
  }

  const parsedMatch = parseTimeString(matchTime);
  if (!parsedMatch) {
    return `Could not understand match time "${matchTime}". Please specify a time like "7pm", "9am", or "6:30pm".`;
  }

  let parsedPost = null;
  if (postTime) {
    parsedPost = parseTimeString(postTime);
    if (!parsedPost) {
      return `Could not understand post time "${postTime}". Please specify a time like "8am" or "7:30am".`;
    }
  } else {
    // Default post time:
    // If match is before 8am (e.g. 6am, 7am) -> post at 7pm previous evening
    // Otherwise -> post at 8:00 AM in the morning
    if (parsedMatch.hour < 8) {
      parsedPost = parseTimeString('7pm');
    } else {
      parsedPost = parseTimeString('8am');
    }
  }

  let validSize = null;
  if (size !== undefined && size !== null) {
    const num = parseInt(size, 10);
    if (Number.isFinite(num) && num > 0) {
      validSize = num;
    }
  }

  const parsedDays = parseDaysOfWeek(days || params?.daysList || 'everyday');
  const effectiveAutoMatchups = autoMatchups !== undefined ? Boolean(autoMatchups) : !Boolean(noMatchups);

  const scheduleId = `rec_${Date.now().toString(36)}`;
  const scheduleObj = {
    id: scheduleId,
    remoteJid: targetChatId,
    size: validSize,
    matchTime: parsedMatch.formatted,
    matchDisplay: parsedMatch.display,
    matchHour: parsedMatch.hour,
    matchMinute: parsedMatch.minute,
    postTime: parsedPost.formatted,
    postDisplay: parsedPost.display,
    postHour: parsedPost.hour,
    postMinute: parsedPost.minute,
    days: parsedDays.raw,
    daysList: parsedDays.days,
    daysDisplay: parsedDays.display,
    includeCreator: Boolean(includeCreator),
    autoMatchups: effectiveAutoMatchups,
    noMatchups: !effectiveAutoMatchups,
    enabled: true,
    createdAt: new Date().toISOString(),
    lastPostedDate: null,
    creator: { name: sender !== 'Someone' ? sender : 'Player', jid: senderJid || null }
  };

  recurringPolls.set(scheduleId, scheduleObj);
  persistPolls();

  const spotDesc = validSize ? `${validSize} spots (${validSize === 2 ? 'Singles' : 'Doubles'})` : 'Opt-in (Yes/No)';
  const creatorDesc = includeCreator ? ` (auto-including ${sender} as Player 1)` : (validSize ? ' (all spots open)' : '');
  const matchupDesc = effectiveAutoMatchups ? (validSize ? 'Auto-generated when poll fills' : 'Manual on request (!matchups)') : 'Manual only (use !matchups)';
  console.log(`[recurring-poll] Created recurring poll schedule ${scheduleId}: ${spotDesc} for ${parsedMatch.display} (${parsedDays.display}), posting at ${parsedPost.display} in ${targetChatId}, autoMatchups: ${effectiveAutoMatchups}`);

  return `📅 *Scheduled Recurring Poll (ID: \`${scheduleId}\`):*\n` +
    `• *Match Time:* ${parsedMatch.display}\n` +
    `• *Days:* ${parsedDays.display}\n` +
    `• *Post Time:* ${parsedPost.display} in this group\n` +
    `• *Format:* ${spotDesc}${creatorDesc}\n` +
    `• *Matchups:* ${matchupDesc}\n` +
    `• *Status:* Active\n\n` +
    `Use "!recurringpolls" to view all schedules, "!modifyrecurringpoll ${scheduleId} ..." to modify, or "!cancelrecurringpoll ${scheduleId}" to cancel.`;
}

/**
 * Modifies an existing recurring poll schedule.
 */
async function modifyRecurringPoll({ recurringPolls, persistPolls, sender, scheduleId, updates = {} }) {
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
  const changes = [];

  // Update match time if provided
  if (updates.matchTime) {
    const parsedMatch = parseTimeString(updates.matchTime);
    if (!parsedMatch) {
      return `Could not understand match time "${updates.matchTime}". Please specify a time like "7pm", "9am", or "6:30pm".`;
    }
    const oldDisplay = sched.matchDisplay;
    sched.matchTime = parsedMatch.formatted;
    sched.matchDisplay = parsedMatch.display;
    sched.matchHour = parsedMatch.hour;
    sched.matchMinute = parsedMatch.minute;
    if (oldDisplay !== sched.matchDisplay) {
      changes.push(`Match Time: ${oldDisplay} → *${sched.matchDisplay}*`);
    }
  }

  // Update post time if provided
  if (updates.postTime) {
    const parsedPost = parseTimeString(updates.postTime);
    if (!parsedPost) {
      return `Could not understand post time "${updates.postTime}". Please specify a time like "8am" or "7:30am".`;
    }
    const oldDisplay = sched.postDisplay;
    sched.postTime = parsedPost.formatted;
    sched.postDisplay = parsedPost.display;
    sched.postHour = parsedPost.hour;
    sched.postMinute = parsedPost.minute;
    if (oldDisplay !== sched.postDisplay) {
      changes.push(`Post Time: ${oldDisplay} → *${sched.postDisplay}*`);
    }
  }

  // Update days if provided
  if (updates.days || updates.daysList) {
    const parsedDays = parseDaysOfWeek(updates.days || updates.daysList);
    const oldDisplay = sched.daysDisplay || sched.days;
    sched.days = parsedDays.raw;
    sched.daysList = parsedDays.days;
    sched.daysDisplay = parsedDays.display;
    if (oldDisplay !== sched.daysDisplay) {
      changes.push(`Days: ${oldDisplay} → *${sched.daysDisplay}*`);
    }
  }

  // Update size if provided
  if (updates.isExplicitOptIn || updates.type === 'opt_in') {
    const oldSizeDesc = sched.size ? `${sched.size} spots` : 'Opt-in';
    sched.size = null;
    if (oldSizeDesc !== 'Opt-in') {
      changes.push(`Format: ${oldSizeDesc} → *Opt-in (Yes/No)*`);
    }
  } else if (updates.size !== undefined && updates.size !== null) {
    const num = parseInt(updates.size, 10);
    if (Number.isFinite(num) && num > 0) {
      const oldSizeDesc = sched.size ? `${sched.size} spots` : 'Opt-in';
      sched.size = num;
      const newSizeDesc = `${num} spots (${num === 2 ? 'Singles' : 'Doubles'})`;
      if (oldSizeDesc !== newSizeDesc) {
        changes.push(`Format: ${oldSizeDesc} → *${newSizeDesc}*`);
      }
    }
  }

  // Update autoMatchups / noMatchups if provided
  if (updates.autoMatchups !== undefined || updates.noMatchups !== undefined) {
    const newAuto = updates.autoMatchups !== undefined ? Boolean(updates.autoMatchups) : !Boolean(updates.noMatchups);
    if (sched.autoMatchups !== newAuto) {
      sched.autoMatchups = newAuto;
      sched.noMatchups = !newAuto;
      changes.push(`Auto-matchups: *${newAuto ? 'Enabled' : 'Disabled (manual !matchups)'}*`);
    }
  }

  // Update includeCreator if provided
  if (updates.includeCreator !== undefined) {
    const newInclude = Boolean(updates.includeCreator);
    if (sched.includeCreator !== newInclude) {
      sched.includeCreator = newInclude;
      changes.push(`Auto-include creator: *${newInclude ? 'Yes' : 'No'}*`);
    }
  }

  if (changes.length === 0) {
    const spotDesc = sched.size ? `${sched.size} spots (${sched.size === 2 ? 'Singles' : 'Doubles'})` : 'Opt-in (Yes/No)';
    return `ℹ️ Schedule \`${targetKey}\` is already configured with those settings (no changes needed):\n` +
      `• *Match Time:* ${sched.matchDisplay}\n` +
      `• *Days:* ${sched.daysDisplay}\n` +
      `• *Post Time:* ${sched.postDisplay}\n` +
      `• *Format:* ${spotDesc}\n` +
      `• *Status:* ${sched.enabled ? 'Active' : 'Paused'}`;
  }

  sched.updatedAt = new Date().toISOString();
  persistPolls();

  const spotDesc = sched.size ? `${sched.size} spots (${sched.size === 2 ? 'Singles' : 'Doubles'})` : 'Opt-in (Yes/No)';
  const matchupDesc = sched.autoMatchups ? (sched.size ? 'Auto-generated when poll fills' : 'Manual on request (!matchups)') : 'Manual only (use !matchups)';

  console.log(`[recurring-poll] Modified recurring poll schedule ${targetKey} by ${sender}: ${changes.join(', ')}`);

  return `✏️ *Updated Recurring Poll Schedule (ID: \`${targetKey}\`):*\n` +
    changes.map(c => `• ${c}`).join('\n') +
    `\n\n📋 *Current Configuration:*\n` +
    `• *Match Time:* ${sched.matchDisplay}\n` +
    `• *Days:* ${sched.daysDisplay}\n` +
    `• *Post Time:* ${sched.postDisplay}\n` +
    `• *Format:* ${spotDesc}\n` +
    `• *Matchups:* ${matchupDesc}\n` +
    `• *Status:* ${sched.enabled ? 'Active' : 'Paused'}`;
}

/**
 * Lists all recurring poll schedules for the given chat.
 */
function listRecurringPolls({ recurringPolls, chatId }) {
  const isAll = !chatId || !chatId.endsWith('@g.us');
  let list = [...recurringPolls.values()];
  if (!isAll) {
    list = list.filter((s) => s.remoteJid === chatId);
  }

  if (list.length === 0) {
    return '📅 No recurring match polls scheduled yet. Use "!recurringpoll [size] <matchTime> [at <postTime>] [days] [no-matchups]" (e.g. "!recurringpoll 4 7pm at 8am on weekdays" or "!recurringpoll opt-in 7pm on weekends") to schedule one.';
  }

  const lines = list.map((s, i) => {
    const spotDesc = s.size ? `${s.size} spots` : 'Opt-in (Yes/No)';
    const statusStr = s.enabled ? '🟢 Active' : '⏸️ Paused';
    const lastPostedStr = s.lastPostedDate ? ` (last posted: ${s.lastPostedDate})` : ' (not posted yet)';
    const matchupNote = s.noMatchups || s.autoMatchups === false ? ' (no auto-matchups)' : '';
    const daysStr = s.daysDisplay || (parseDaysOfWeek(s.days || s.daysList).display);
    return `${i + 1}. *ID: \`${s.id}\`* — ${spotDesc} for *${s.matchDisplay}* (${daysStr})${matchupNote}\n` +
      `   • Days: ${daysStr}\n` +
      `   • Posts: Daily at ${s.postDisplay}\n` +
      `   • Status: ${statusStr}${lastPostedStr}\n` +
      `   • Created by: ${s.creator?.name || 'Player'}`;
  });

  return `📅 *Scheduled Recurring Polls:*\n\n${lines.join('\n\n')}\n\n_Manage with !modifyrecurringpoll <id> ..., !cancelrecurringpoll <id> (or !clearallrecurringpolls)_`;
}

/**
 * Cancels and deletes a recurring poll schedule.
 */
async function cancelRecurringPoll({ recurringPolls, persistPolls, sender, scheduleId }) {
  const cleanId = String(scheduleId || '').trim();
  if (!cleanId) {
    return 'Please provide the schedule ID to cancel, e.g. "!cancelrecurringpoll rec_1" (see "!recurringpolls" for IDs) or "!clearallrecurringpolls" to clear all.';
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
    return `Schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view all scheduled IDs.`;
  }

  const sched = recurringPolls.get(targetKey);
  recurringPolls.delete(targetKey);
  persistPolls();

  console.log(`[recurring-poll] Deleted recurring poll schedule ${targetKey} (${sched.matchDisplay}) by ${sender}`);
  return `🗑️ Cancelled and deleted recurring poll schedule \`${targetKey}\` (Match time: ${sched.matchDisplay} ${sched.daysDisplay || ''}).`;
}

/**
 * Clears and cancels all recurring poll schedules for the given chat.
 */
async function clearAllRecurringPolls({ recurringPolls, persistPolls, sender, chatId }) {
  const isAll = !chatId || !chatId.endsWith('@g.us');
  const toDelete = [];

  for (const [id, sched] of recurringPolls.entries()) {
    if (isAll || sched.remoteJid === chatId) {
      toDelete.push(id);
    }
  }

  if (toDelete.length === 0) {
    return '📅 No scheduled recurring polls found to clear.';
  }

  for (const id of toDelete) {
    recurringPolls.delete(id);
  }
  persistPolls();

  console.log(`[recurring-poll] Cleared all ${toDelete.length} recurring poll schedules by ${sender} in ${chatId}`);
  return `🗑️ Cleared and deleted all ${toDelete.length} recurring poll schedule(s).`;
}

/**
 * Pauses a recurring poll schedule.
 */
async function pauseRecurringPoll({ recurringPolls, persistPolls, scheduleId }) {
  const cleanId = String(scheduleId || '').trim();
  if (!cleanId) {
    return 'Please provide the schedule ID to pause. Use "!recurringpolls" to view active IDs.';
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
    return `Schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view active IDs.`;
  }
  const sched = recurringPolls.get(targetKey);
  sched.enabled = false;
  persistPolls();
  return `⏸️ Paused recurring poll schedule \`${targetKey}\` (${sched.matchDisplay}). Use "!resumerecurringpoll ${targetKey}" to re-enable.`;
}

/**
 * Resumes a recurring poll schedule.
 */
async function resumeRecurringPoll({ recurringPolls, persistPolls, scheduleId }) {
  const cleanId = String(scheduleId || '').trim();
  if (!cleanId) {
    return 'Please provide the schedule ID to resume. Use "!recurringpolls" to view active IDs.';
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
    return `Schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view active IDs.`;
  }
  const sched = recurringPolls.get(targetKey);
  sched.enabled = true;
  persistPolls();
  return `▶️ Resumed recurring poll schedule \`${targetKey}\` (${sched.matchDisplay}). It will post at ${sched.postDisplay} on ${sched.daysDisplay || 'scheduled days'}.`;
}

/**
 * Sweeps all recurring poll schedules and automatically creates and posts polls whose post time has arrived on scheduled days.
 */
async function checkAndPostRecurringPolls({ sock, recurringPolls, persistPolls, createMatchPoll, getTargetGroupJid }) {
  if (!sock || recurringPolls.size === 0) return;
  try {
    const sj = getSanJoseParts();
    const todayKey = `${sj.year}-${String(sj.month + 1).padStart(2, '0')}-${String(sj.day).padStart(2, '0')}`;
    const currentMinutes = sj.hour * 60 + sj.minute;

    const DAY_MAP = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const currentDayIndex = DAY_MAP[sj.weekday] !== undefined ? DAY_MAP[sj.weekday] : (new Date(sj.year, sj.month, sj.day).getDay());

    for (const [scheduleId, sched] of recurringPolls.entries()) {
      if (!sched.enabled) continue;
      if (sched.lastPostedDate === todayKey) continue;

      const schedPostMinutes = sched.postHour * 60 + sched.postMinute;
      const schedMatchMinutes = sched.matchHour * 60 + sched.matchMinute;

      // Check if post time has arrived in San Jose
      if (currentMinutes >= schedPostMinutes) {
        // If post time >= match time (e.g. post at 7pm for 7pm match or 8pm for 6am match), poll is posted for tomorrow
        const isPostDayBefore = schedPostMinutes >= schedMatchMinutes;
        const targetMatchDayIndex = isPostDayBefore ? (currentDayIndex + 1) % 7 : currentDayIndex;

        const schedDays = (Array.isArray(sched.daysList) && sched.daysList.length > 0)
          ? sched.daysList
          : parseDaysOfWeek(sched.days).days;

        // Check if the target match day is in the scheduled days of the week
        if (!schedDays.includes(targetMatchDayIndex)) {
          continue; // Today is not a posting day for this schedule
        }

        // If posting on match day and match time has already passed today, skip today
        if (!isPostDayBefore && currentMinutes >= schedMatchMinutes && schedMatchMinutes >= schedPostMinutes) {
          sched.lastPostedDate = todayKey;
          persistPolls();
          console.log(`[recurring-poll] Match time already passed today for schedule ${scheduleId} (${sched.matchTime}). Marking today as handled.`);
          continue;
        }

        const targetChatId = sched.remoteJid.endsWith('@g.us') ? sched.remoteJid : (await getTargetGroupJid(sock) || sched.remoteJid);
        const creatorName = sched.creator?.name || 'Daily Poll';
        const creatorJid = sched.creator?.jid || null;

        const targetDayName = DAY_NAMES[targetMatchDayIndex];
        const dayWord = isPostDayBefore ? 'tomorrow' : 'today';
        const whenStr = isPostDayBefore ? `Tomorrow ${sched.matchTime}` : `Today ${sched.matchTime}`;
        const autoMatchups = sched.autoMatchups !== undefined ? sched.autoMatchups : !sched.noMatchups;
        const isCommand = !autoMatchups;
        const noMatchups = !autoMatchups;

        console.log(`[recurring-poll] Triggering recurring match poll for schedule ${scheduleId} (${whenStr} [${targetDayName}], ${sched.size || 'opt-in'} spots, autoMatchups: ${autoMatchups}) in ${targetChatId}`);

        const res = await createMatchPoll(
          sock,
          targetChatId,
          sched.size,
          whenStr,
          dayWord,
          sched.matchTime,
          creatorName,
          creatorJid,
          sched.includeCreator,
          null,
          false,
          isCommand,
          noMatchups
        );

        sched.lastPostedDate = todayKey;
        persistPolls();

        if (res?.err) {
          console.error(`[recurring-poll] Failed to create recurring poll ${scheduleId}:`, res.err);
        } else {
          console.log(`[recurring-poll] Successfully posted recurring poll for schedule ${scheduleId} in ${targetChatId}`);
        }
      }
    }
  } catch (err) {
    console.error(`⚠️ [${new Date().toISOString()}] Error in checkAndPostRecurringPolls:`, err);
  }
}

module.exports = {
  parseDaysOfWeek,
  parseRecurringPollText,
  scheduleRecurringPoll,
  modifyRecurringPoll,
  listRecurringPolls,
  cancelRecurringPoll,
  clearAllRecurringPolls,
  cancelAllRecurringPolls: clearAllRecurringPolls,
  pauseRecurringPoll,
  resumeRecurringPoll,
  checkAndPostRecurringPolls,
  cleanIncomingText
};
