/**
 * Recurring Polls module: manages creation, listing, cancellation, pausing,
 * and automatic daily posting of recurring tennis match polls.
 */

const { parseTimeString, getSanJoseParts } = require('./pollTime');

/**
 * Parses user input to detect recurring/daily poll commands or natural language phrases.
 */
function parseRecurringPollText(text) {
  if (!text || typeof text !== 'string') return null;

  // 1. Check sub-commands (cancel/clear all, list, cancel, pause, resume)
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

  const cancelMatch = text.match(/^!(?:cancelrecurringpoll|deleterecurringpoll|removerecurringpoll|rmrecurringpoll|clearrecurringpoll)\s*(.*)$/i) ||
    text.match(/^!(?:recurringpoll|dailypoll|schedulepoll)\s+(?:cancel|delete|remove|rm|clear)\s*(.*)$/i) ||
    text.match(/\b(?:cancel|delete|remove|clear)\s+(?:daily|recurring|scheduled)\s+poll\s+(\w+)\b/i);
  if (cancelMatch) {
    const rawId = cancelMatch[1].trim();
    if (/^all$/i.test(rawId)) {
      return { action: 'clear_all' };
    }
    return { action: 'cancel', scheduleId: rawId || null };
  }

  const pauseMatch = text.match(/^!(?:pauserecurringpoll|stoprecurringpoll)\s*(.*)$/i) ||
    text.match(/^!(?:recurringpoll|dailypoll|schedulepoll)\s+(?:pause|stop)\s*(.*)$/i) ||
    text.match(/\b(?:pause|stop)\s+(?:daily|recurring|scheduled)\s+poll\s+(\w+)\b/i);
  if (pauseMatch) {
    return { action: 'pause', scheduleId: pauseMatch[1].trim() || null };
  }

  const resumeMatch = text.match(/^!(?:resumerecurringpoll|startrecurringpoll)\s*(.*)$/i) ||
    text.match(/^!(?:recurringpoll|dailypoll|schedulepoll)\s+(?:resume|start)\s*(.*)$/i) ||
    text.match(/\b(?:resume|start)\s+(?:daily|recurring|scheduled)\s+poll\s+(\w+)\b/i);
  if (resumeMatch) {
    return { action: 'resume', scheduleId: resumeMatch[1].trim() || null };
  }

  // 2. Check creation command or phrase
  const isCommand = /^!(?:recurringpoll|dailypoll|schedulepoll|everydaypoll|repeatingpoll|recurringoptinpoll|dailyoptinpoll|recurringyesnopoll|dailyyesnopoll)\b/i.test(text);
  const isPhrase = /\b(?:schedule|create|set\s*up|setup|start|post)\s+(?:a\s+)?(?:new\s+)?(?:daily\s+|recurring\s+|repeating\s+|every\s*day\s+)(?:match\s+)?(?:singles\s+|doubles\s+|yes\/no\s+|yesno\s+|opt-?in\s+)?poll\b|\b(?:daily|recurring|repeating)\s+(?:match\s+)?(?:yes\/no\s+|yesno\s+|opt-?in\s+)?poll\b|\bpoll\s+every\s*day\b/i.test(text);

  if (!isCommand && !isPhrase) {
    return null;
  }

  const isExplicitOptIn = /\b(?:opt-?in|yes\s*\/\s*no|yesno|open)\b/i.test(text) ||
    /^!(?:recurringoptinpoll|dailyoptinpoll|recurringyesnopoll|dailyyesnopoll)\b/i.test(text);

  // 3. Extract times (matchTime, postTime)
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
    // Check if any token is explicitly preceded by post/posted/posting at
    const postIdx = timeTokens.findIndex((t) => {
      const before = text.slice(Math.max(0, t.index - 15), t.index);
      return /\b(?:post(?:ed)?|posting)\s*(?:at)?\s*$/i.test(before);
    });
    if (postIdx !== -1) {
      postTime = timeTokens[postIdx].token;
      matchTime = timeTokens[postIdx === 0 ? 1 : 0].token;
    } else {
      // First is match time, second is post time
      matchTime = timeTokens[0].token;
      postTime = timeTokens[1].token;
    }
  }

  // 4. Extract player count / spots AFTER removing time tokens
  const textWithoutTime = text.replace(timeRegex, ' ');
  let size = null;
  if (!isExplicitOptIn) {
    const sizeExplicit = textWithoutTime.match(/\b(?:for|size|spots?|players?)\s*[:=]?\s*([1-9]|1[0-6])\b/i) ||
      textWithoutTime.match(/^!(?:recurringpoll|dailypoll|schedulepoll)\s+([1-9]|1[0-6])\b/i) ||
      textWithoutTime.match(/\b([1-9]|1[0-6])\s*(?:spots?|players?|people|courts?)\b/i) ||
      textWithoutTime.match(/\bpoll\s+for\s+([1-9]|1[0-6])\b/i);
    if (sizeExplicit) {
      size = parseInt(sizeExplicit[1], 10);
    } else if (/\bsingles\b/i.test(textWithoutTime)) {
      size = 2;
    } else if (/\bdoubles\b/i.test(textWithoutTime)) {
      size = 4;
    }
  }

  let includeCreator = false;
  if (/\b(?:include\s+me|with\s+me|count\s+me\s+in|i'm\s+playing|im\s+playing)\b/i.test(text)) {
    includeCreator = true;
  }

  // 5. Check if auto-matchup creation should be disabled (supports no-matchups, --no-matchups, no matchups, no-draw, --no-draw, etc.)
  const noMatchups = /(?:^|\s)(?:--no-?matchups?|--no-?draw)\b|\b(?:no[-_\s]*matchups?|no[-_\s]*draw|without\s+(?:auto[-_\s]*|automatic\s+)?matchups?|without\s+(?:auto[-_\s]*|automatic\s+)?draw|(?:do\s*not|don\x27?t)\s+(?:create|make|generate|post|auto-?generate)\s+(?:matchups?|draw|the\s+draw|the\s+matchups?)|no[-_\s]*(?:auto\s+|automatic\s+)?matchups?)\b/i.test(text);

  return {
    action: 'create',
    size,
    matchTime,
    postTime,
    days: 'everyday',
    includeCreator,
    autoMatchups: !noMatchups,
    noMatchups
  };
}

/**
 * Creates and registers a new recurring daily poll schedule.
 */
async function scheduleRecurringPoll({ recurringPolls, persistPolls, targetChatId, sender, senderJid, params }) {
  const { size, matchTime, postTime, days, includeCreator, autoMatchups, noMatchups } = params || {};
  if (!matchTime) {
    return 'Please provide a match time for the recurring daily poll (e.g. "!recurringpoll 4 7pm at 8am" or "!recurringpoll opt-in 7pm").';
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
    days: days || 'everyday',
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
  console.log(`[recurring-poll] Created recurring daily poll schedule ${scheduleId}: ${spotDesc} for ${parsedMatch.display}, posting daily at ${parsedPost.display} in ${targetChatId}, autoMatchups: ${effectiveAutoMatchups}`);

  return `📅 *Scheduled Daily Recurring Poll (ID: \`${scheduleId}\`):*\n` +
    `• *Match Time:* ${parsedMatch.display} every day\n` +
    `• *Daily Post Time:* ${parsedPost.display} in this group\n` +
    `• *Format:* ${spotDesc}${creatorDesc}\n` +
    `• *Matchups:* ${matchupDesc}\n` +
    `• *Status:* Active\n\n` +
    `Use "!recurringpolls" to view all schedules or "!cancelrecurringpoll ${scheduleId}" to cancel.`;
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
    return '📅 No recurring match polls scheduled yet. Use "!recurringpoll [size] <matchTime> [at <postTime>] [no-matchups]" (e.g. "!recurringpoll 4 7pm at 8am" or "!recurringpoll opt-in 7pm") to schedule one.';
  }

  const lines = list.map((s, i) => {
    const spotDesc = s.size ? `${s.size} spots` : 'Opt-in (Yes/No)';
    const statusStr = s.enabled ? '🟢 Active' : '⏸️ Paused';
    const lastPostedStr = s.lastPostedDate ? ` (last posted: ${s.lastPostedDate})` : ' (not posted yet)';
    const matchupNote = s.noMatchups || s.autoMatchups === false ? ' (no auto-matchups)' : '';
    return `${i + 1}. *ID: \`${s.id}\`* — ${spotDesc} for *${s.matchDisplay}*${matchupNote}\n` +
      `   • Posts: Daily at ${s.postDisplay}\n` +
      `   • Status: ${statusStr}${lastPostedStr}\n` +
      `   • Created by: ${s.creator?.name || 'Player'}`;
  });

  return `📅 *Scheduled Recurring Daily Polls:*\n\n${lines.join('\n\n')}\n\n_Manage with !cancelrecurringpoll <id> (or !clearallrecurringpolls)_`;
}

/**
 * Cancels and deletes a recurring poll schedule.
 */
async function cancelRecurringPoll({ recurringPolls, persistPolls, sender, scheduleId }) {
  const cleanId = String(scheduleId || '').trim();
  if (!cleanId) {
    return 'Please provide the schedule ID to cancel, e.g. "!cancelrecurringpoll rec_1" (see "!recurringpolls" for IDs) or "!clearallrecurringpolls" to clear all.';
  }

  if (!recurringPolls.has(cleanId)) {
    return `Schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view all scheduled IDs.`;
  }

  const sched = recurringPolls.get(cleanId);
  recurringPolls.delete(cleanId);
  persistPolls();

  console.log(`[recurring-poll] Deleted recurring poll schedule ${cleanId} (${sched.matchDisplay}) by ${sender}`);
  return `🗑️ Cancelled and deleted recurring daily poll schedule \`${cleanId}\` (Match time: ${sched.matchDisplay}).`;
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
  return `🗑️ Cleared and deleted all ${toDelete.length} recurring daily poll schedule(s).`;
}

/**
 * Pauses a recurring poll schedule.
 */
async function pauseRecurringPoll({ recurringPolls, persistPolls, scheduleId }) {
  const cleanId = String(scheduleId || '').trim();
  if (!cleanId || !recurringPolls.has(cleanId)) {
    return `Schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view active IDs.`;
  }
  const sched = recurringPolls.get(cleanId);
  sched.enabled = false;
  persistPolls();
  return `⏸️ Paused daily recurring poll schedule \`${cleanId}\` (${sched.matchDisplay}). Use "!resumerecurringpoll ${cleanId}" to re-enable.`;
}

/**
 * Resumes a recurring poll schedule.
 */
async function resumeRecurringPoll({ recurringPolls, persistPolls, scheduleId }) {
  const cleanId = String(scheduleId || '').trim();
  if (!cleanId || !recurringPolls.has(cleanId)) {
    return `Schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view active IDs.`;
  }
  const sched = recurringPolls.get(cleanId);
  sched.enabled = true;
  persistPolls();
  return `▶️ Resumed daily recurring poll schedule \`${cleanId}\` (${sched.matchDisplay}). It will post daily at ${sched.postDisplay}.`;
}

/**
 * Sweeps all recurring poll schedules and automatically creates and posts polls whose post time has arrived.
 */
async function checkAndPostRecurringPolls({ sock, recurringPolls, persistPolls, createMatchPoll, getTargetGroupJid }) {
  if (!sock || recurringPolls.size === 0) return;
  try {
    const sj = getSanJoseParts();
    const todayKey = `${sj.year}-${String(sj.month + 1).padStart(2, '0')}-${String(sj.day).padStart(2, '0')}`;
    const currentMinutes = sj.hour * 60 + sj.minute;

    for (const [scheduleId, sched] of recurringPolls.entries()) {
      if (!sched.enabled) continue;
      if (sched.lastPostedDate === todayKey) continue;

      const schedPostMinutes = sched.postHour * 60 + sched.postMinute;
      const schedMatchMinutes = sched.matchHour * 60 + sched.matchMinute;

      // Check if post time has arrived in San Jose
      if (currentMinutes >= schedPostMinutes) {
        // If post time >= match time (e.g. post at 7pm for 7pm match or 8pm for 6am match), poll is posted for tomorrow
        const isPostDayBefore = schedPostMinutes >= schedMatchMinutes;

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

        const dayWord = isPostDayBefore ? 'tomorrow' : 'today';
        const whenStr = isPostDayBefore ? `Tomorrow ${sched.matchTime}` : `Today ${sched.matchTime}`;
        const autoMatchups = sched.autoMatchups !== undefined ? sched.autoMatchups : !sched.noMatchups;
        const isCommand = !autoMatchups;
        const noMatchups = !autoMatchups;

        console.log(`[recurring-poll] Triggering daily match poll for schedule ${scheduleId} (${whenStr}, ${sched.size || 'opt-in'} spots, autoMatchups: ${autoMatchups}) in ${targetChatId}`);

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
          console.error(`[recurring-poll] Failed to create daily poll ${scheduleId}:`, res.err);
        } else {
          console.log(`[recurring-poll] Successfully posted daily poll for schedule ${scheduleId} in ${targetChatId}`);
        }
      }
    }
  } catch (err) {
    console.error(`⚠️ [${new Date().toISOString()}] Error in checkAndPostRecurringPolls:`, err);
  }
}

module.exports = {
  parseRecurringPollText,
  scheduleRecurringPoll,
  listRecurringPolls,
  cancelRecurringPoll,
  clearAllRecurringPolls,
  cancelAllRecurringPolls: clearAllRecurringPolls,
  pauseRecurringPoll,
  resumeRecurringPoll,
  checkAndPostRecurringPolls
};
