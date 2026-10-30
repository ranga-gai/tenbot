/**
 * Recurring Match Poll Commands
 * Handles scheduling, listing, cancelling, modifying, pausing, resuming,
 * and skipping recurring match polls.
 */

const recurringPollsModule = require('../recurringPolls');
const { isUserAdmin, isSameUser, getTargetGroupJid } = require('./groupCommands');

async function handleScheduleRecurringPoll(sock, chatId, sender, senderJid, params, context) {
  const { recurringPolls, persistPolls } = context;
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

function handleListRecurringPolls(chatId, context) {
  const { recurringPolls } = context;
  return recurringPollsModule.listRecurringPolls({ recurringPolls, chatId });
}

async function handleCancelRecurringPoll(sock, chatId, sender, senderJid, scheduleId, context) {
  const { recurringPolls, persistPolls } = context;
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

async function handleClearAllRecurringPolls(sock, chatId, sender, senderJid, context) {
  const { recurringPolls, persistPolls } = context;
  const isAdmin = await isUserAdmin(sock, chatId, senderJid);
  if (!isAdmin) {
    return '⚠️ Only group admins can clear all recurring polls.';
  }
  return await recurringPollsModule.clearAllRecurringPolls({ recurringPolls, persistPolls, sender, chatId });
}

async function handleModifyRecurringPoll(sock, chatId, sender, senderJid, scheduleId, updates, context) {
  const { recurringPolls, persistPolls } = context;
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

async function handlePauseRecurringPoll(sock, chatId, sender, senderJid, scheduleId, untilDate = null, context) {
  const { recurringPolls, persistPolls } = context;
  const extracted = recurringPollsModule.extractPauseArgs(scheduleId);
  let cleanId = extracted.scheduleId ? String(extracted.scheduleId).replace(/^["']|["']$/g, '').trim() : '';
  const effUntil = untilDate || extracted.untilDate || null;

  // If user says "all", pause all
  if (/^all$/i.test(cleanId)) {
    const isAdmin = await isUserAdmin(sock, chatId, senderJid);
    if (!isAdmin) {
      return '⚠️ Only group admins can pause all recurring polls.';
    }
    return await recurringPollsModule.pauseRecurringPoll({ recurringPolls, persistPolls, scheduleId: 'all', chatId, untilDate: effUntil });
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
  return await recurringPollsModule.pauseRecurringPoll({ recurringPolls, persistPolls, scheduleId: targetKey, chatId, untilDate: effUntil });
}

async function handleResumeRecurringPoll(sock, chatId, sender, senderJid, scheduleId, context) {
  const { recurringPolls, persistPolls } = context;
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

async function handleSkipRecurringPollInstance(sock, chatId, sender, senderJid, scheduleId, targetDayOrDate = null, count = 1, context) {
  const { recurringPolls, activePolls, persistPolls, cancelOrDeletePoll } = context;
  const isAllChat = !chatId || !chatId.endsWith('@g.us');
  const chatSchedules = [...recurringPolls.entries()].filter(([, s]) => isAllChat || s.remoteJid === chatId);

  const extracted = recurringPollsModule.extractSkipArgs(scheduleId, targetDayOrDate);
  let cleanId = extracted.scheduleId ? String(extracted.scheduleId).replace(/^["']|["']$/g, '').trim() : '';
  let effTarget = extracted.targetDayOrDate;
  let effCount = (count && parseInt(count, 10) > 1) ? parseInt(count, 10) : extracted.count;

  // If user passed targetDayOrDate or count as first param and there is only 1 schedule:
  if (cleanId && chatSchedules.length === 1 && !recurringPolls.has(cleanId)) {
    const isDayOrDate = recurringPollsModule.DAY_LOOKUP?.[cleanId.toLowerCase()] !== undefined ||
      /^(?:today|tomorrow|next|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)$/i.test(cleanId);
    if (isDayOrDate) {
      effTarget = cleanId;
      cleanId = chatSchedules[0][0];
    } else if (/^\d+$/.test(cleanId)) {
      effCount = parseInt(cleanId, 10);
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
    targetDayOrDate: effTarget,
    count: effCount,
    chatId,
    sender
  });
}

async function handleUnskipRecurringPollInstance(sock, chatId, sender, senderJid, scheduleId, targetDayOrDate, context) {
  const { recurringPolls, persistPolls } = context;
  const isAllChat = !chatId || !chatId.endsWith('@g.us');
  const chatSchedules = [...recurringPolls.entries()].filter(([, s]) => isAllChat || s.remoteJid === chatId);

  let cleanId = String(scheduleId || '').replace(/^["']|["']$/g, '').trim();

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

async function handleSimulateRecurringPoll(sock, chatId, sender, senderJid, rawArgs, context = {}) {
  const { recurringPolls } = context;
  let scheduleId = null;
  let targetDayOrDate = null;

  if (rawArgs && typeof rawArgs === 'string') {
    const parts = rawArgs.trim().split(/\s+/);
    if (parts.length > 1) {
      scheduleId = parts[0];
      targetDayOrDate = parts.slice(1).join(' ');
    } else if (parts.length === 1 && parts[0]) {
      scheduleId = parts[0];
    }
  }

  return await recurringPollsModule.simulateRecurringPoll({
    sock,
    recurringPolls,
    scheduleId,
    targetDayOrDate,
    chatId,
    sender,
    senderJid,
    createMatchPoll: context.createMatchPoll
  });
}

/**
 * Handles text commands for recurring polls.
 */
async function handleRecurringCommand(sock, text, chatId, sender, senderJid, context) {
  const lower = text.toLowerCase();

  // Simulation commands
  if (
    lower.startsWith('!simulaterecurringpoll') || lower.startsWith('!simulaterecurring') ||
    lower.startsWith('!simrecurringpoll') || lower.startsWith('!simrecurring') ||
    lower.startsWith('!recurringpoll simulate') || lower.startsWith('!recurringpolls simulate') ||
    lower.startsWith('!recurringpoll sim') || lower.startsWith('!recurringpolls sim') ||
    lower.startsWith('!schedulepoll simulate') || lower.startsWith('!scheduledpolls simulate') ||
    lower.startsWith('!recurringpoll mock') || lower.startsWith('!recurringpolls mock')
  ) {
    const rawArgs = text.replace(/^!(?:simulaterecurringpoll|simulaterecurring|simrecurringpoll|simrecurring|(?:recurringpolls?|scheduledpolls?)\s+(?:simulate|sim|mock))\s*/i, '').trim();
    return await handleSimulateRecurringPoll(sock, chatId, sender, senderJid, rawArgs, context);
  }

  // Status & listing
  if (
    lower.startsWith('!recurringpoll status') || lower.startsWith('!schedulepoll status') ||
    lower.startsWith('!recurringpolls status') || lower.startsWith('!scheduledpolls status')
  ) {
    const parts = text.trim().split(/\s+/);
    const targetId = parts.length > 2 ? parts.slice(2).join(' ').replace(/^["']|["']$/g, '').trim() : null;
    if (targetId) {
      return recurringPollsModule.getRecurringPollStatus({ recurringPolls: context.recurringPolls, scheduleId: targetId, chatId });
    }
    return handleListRecurringPolls(chatId, context);
  }

  if (
    lower === '!recurringpolls' || lower === '!scheduledpolls' || lower === '!dailypolls' ||
    lower === '!recurringpoll list' || lower === '!schedulepoll list'
  ) {
    return handleListRecurringPolls(chatId, context);
  }

  // Clear all & cancel
  if (
    lower === '!clearallrecurringpolls' || lower === '!clearrecurringpolls' ||
    lower === '!cancelallrecurringpolls' || lower === '!deleteallrecurringpolls' ||
    lower === '!removeallrecurringpolls' || lower === '!clearallrecurring' || lower === '!cancelallrecurring'
  ) {
    return await handleClearAllRecurringPolls(sock, chatId, sender, senderJid, context);
  }

  if (
    lower.startsWith('!cancelrecurringpoll') || lower.startsWith('!deleterecurringpoll') ||
    lower.startsWith('!removerecurringpoll') || lower.startsWith('!clearrecurringpoll')
  ) {
    const parts = text.split(/\s+/);
    const specificId = parts.length > 1 ? parts[1].trim() : null;
    if (specificId && /^all$/i.test(specificId)) {
      return await handleClearAllRecurringPolls(sock, chatId, sender, senderJid, context);
    }
    return await handleCancelRecurringPoll(sock, chatId, sender, senderJid, specificId, context);
  }

  // Modifying recurring schedule template
  if (/^!(?:modifyrecurringpoll|editrecurringpoll|updaterecurringpoll|changerecurringpoll|modifyrecurring|editrecurring|updaterecurring)\b/i.test(text)) {
    const parsed = recurringPollsModule.parseRecurringPollText(text);
    if (parsed && parsed.action === 'modify') {
      return await handleModifyRecurringPoll(sock, chatId, sender, senderJid, parsed.scheduleId, parsed.updates, context);
    }
  }

  // Skipping instances
  if (
    lower.startsWith('!skipinstance') || lower.startsWith('!skipinstances') ||
    lower.startsWith('!skiprecurringinstance') || lower.startsWith('!skiprecurringinstances') ||
    lower.startsWith('!skiprecurringpoll') || lower.startsWith('!skiprecurring') || lower.startsWith('!skippoll')
  ) {
    const rawArgs = text.replace(/^!(?:skipinstances|skipinstance|skiprecurringinstances|skiprecurringinstance|skiprecurringpoll|skiprecurring|skippoll)\s*/i, '').trim();
    const { scheduleId: sId, targetDayOrDate: tTarget, count: cCount } = recurringPollsModule.extractSkipArgs(rawArgs);
    return await handleSkipRecurringPollInstance(sock, chatId, sender, senderJid, sId, tTarget, cCount, context);
  }

  if (
    lower.startsWith('!unskipinstance') || lower.startsWith('!unskiprecurringinstance') ||
    lower.startsWith('!unskiprecurringpoll') || lower.startsWith('!unskiprecurring') || lower.startsWith('!resumeskip')
  ) {
    const parts = text.trim().split(/\s+/);
    const target = parts.length > 1 ? parts[1].trim() : null;
    const targetDayOrDate = parts.length > 2 ? parts.slice(2).join(' ').trim() : null;
    return await handleUnskipRecurringPollInstance(sock, chatId, sender, senderJid, target, targetDayOrDate, context);
  }

  if (
    lower.startsWith('!recurringpoll skip') || lower.startsWith('!recurringpolls skip') ||
    lower.startsWith('!schedulepoll skip') || lower.startsWith('!scheduledpolls skip')
  ) {
    const rawArgs = text.replace(/^!(?:recurringpolls?|scheduledpolls?)\s+skip(?:instances?|poll)?\s*/i, '').trim();
    const { scheduleId: sId, targetDayOrDate: tTarget, count: cCount } = recurringPollsModule.extractSkipArgs(rawArgs);
    return await handleSkipRecurringPollInstance(sock, chatId, sender, senderJid, sId, tTarget, cCount, context);
  }

  if (
    lower.startsWith('!recurringpoll unskip') || lower.startsWith('!recurringpolls unskip') ||
    lower.startsWith('!schedulepoll unskip') || lower.startsWith('!scheduledpolls unskip')
  ) {
    const parts = text.trim().split(/\s+/);
    const target = parts.length > 2 ? parts[2].trim() : null;
    const targetDayOrDate = parts.length > 3 ? parts.slice(3).join(' ').trim() : null;
    return await handleUnskipRecurringPollInstance(sock, chatId, sender, senderJid, target, targetDayOrDate, context);
  }

  // Pausing & resuming
  if (
    lower.startsWith('!pauseallrecurring') || lower.startsWith('!stopallrecurring') ||
    lower === '!pauserecurringpolls' || lower === '!stoprecurringpolls'
  ) {
    const rawArgs = text.replace(/^!(?:pauseallrecurring|stopallrecurring|pauserecurringpolls|stoprecurringpolls)\s*/i, '').trim();
    const { untilDate } = recurringPollsModule.extractPauseArgs(rawArgs);
    return await handlePauseRecurringPoll(sock, chatId, sender, senderJid, 'all', untilDate, context);
  }

  if (
    lower.startsWith('!resumeallrecurring') || lower.startsWith('!startallrecurring') ||
    lower === '!resumerecurringpolls' || lower === '!startrecurringpolls'
  ) {
    return await handleResumeRecurringPoll(sock, chatId, sender, senderJid, 'all', context);
  }

  if (
    lower.startsWith('!recurringpoll pause') || lower.startsWith('!recurringpolls pause') ||
    lower.startsWith('!schedulepoll pause') || lower.startsWith('!scheduledpolls pause')
  ) {
    const rawArgs = text.replace(/^!(?:recurringpolls?|scheduledpolls?)\s+(?:pause|stop)\s*/i, '').trim();
    const { scheduleId: sId, untilDate } = recurringPollsModule.extractPauseArgs(rawArgs);
    return await handlePauseRecurringPoll(sock, chatId, sender, senderJid, sId, untilDate, context);
  }

  if (
    lower.startsWith('!recurringpoll resume') || lower.startsWith('!recurringpolls resume') ||
    lower.startsWith('!schedulepoll resume') || lower.startsWith('!scheduledpolls resume')
  ) {
    const parts = text.trim().split(/\s+/);
    const specificId = parts.length > 2 ? parts.slice(2).join(' ').trim() : null;
    return await handleResumeRecurringPoll(sock, chatId, sender, senderJid, specificId, context);
  }

  if (
    lower.startsWith('!pauserecurringpoll') || lower.startsWith('!stoprecurringpoll') ||
    lower.startsWith('!pauserecurring') || lower.startsWith('!stoprecurring')
  ) {
    const rawArgs = text.replace(/^!(?:pauserecurringpoll|stoprecurringpoll|pauserecurring|stoprecurring)\s*/i, '').trim();
    const { scheduleId: sId, untilDate } = recurringPollsModule.extractPauseArgs(rawArgs);
    return await handlePauseRecurringPoll(sock, chatId, sender, senderJid, sId, untilDate, context);
  }

  if (
    lower.startsWith('!resumerecurringpoll') || lower.startsWith('!startrecurringpoll') ||
    lower.startsWith('!resumerecurring') || lower.startsWith('!startrecurring')
  ) {
    const parts = text.split(/\s+/);
    const specificId = parts.length > 1 ? parts.slice(1).join(' ').trim() : null;
    return await handleResumeRecurringPoll(sock, chatId, sender, senderJid, specificId, context);
  }

  // Creation & natural language command
  if (/^!(?:recurringpoll|dailypoll|schedulepoll|everydaypoll|repeatingpoll|recurringoptinpoll|dailyoptinpoll|recurringyesnopoll|dailyyesnopoll)\b/i.test(text)) {
    const parsed = recurringPollsModule.parseRecurringPollText(text);
    if (parsed) {
      if (parsed.action === 'simulate') {
        const rawArgs = parsed.scheduleId ? `${parsed.scheduleId} ${parsed.targetDayOrDate || ''}`.trim() : (parsed.targetDayOrDate || '');
        return await handleSimulateRecurringPoll(sock, chatId, sender, senderJid, rawArgs, context);
      }
      if (parsed.action === 'status') {
        if (parsed.scheduleId) {
          return recurringPollsModule.getRecurringPollStatus({ recurringPolls: context.recurringPolls, scheduleId: parsed.scheduleId, chatId });
        }
        return handleListRecurringPolls(chatId, context);
      }
      if (parsed.action === 'list') {
        return handleListRecurringPolls(chatId, context);
      }
      if (parsed.action === 'clear_all') {
        return await handleClearAllRecurringPolls(sock, chatId, sender, senderJid, context);
      }
      if (parsed.action === 'cancel') {
        return await handleCancelRecurringPoll(sock, chatId, sender, senderJid, parsed.scheduleId, context);
      }
      if (parsed.action === 'skip_instance') {
        return await handleSkipRecurringPollInstance(sock, chatId, sender, senderJid, parsed.scheduleId, parsed.targetDayOrDate, parsed.count, context);
      }
      if (parsed.action === 'unskip_instance') {
        return await handleUnskipRecurringPollInstance(sock, chatId, sender, senderJid, parsed.scheduleId, parsed.targetDayOrDate, context);
      }
      if (parsed.action === 'pause') {
        return await handlePauseRecurringPoll(sock, chatId, sender, senderJid, parsed.scheduleId, parsed.untilDate, context);
      }
      if (parsed.action === 'modify') {
        return await handleModifyRecurringPoll(sock, chatId, sender, senderJid, parsed.scheduleId, parsed.updates, context);
      }
      if (parsed.action === 'resume') {
        return await handleResumeRecurringPoll(sock, chatId, sender, senderJid, parsed.scheduleId, context);
      }
      return await handleScheduleRecurringPoll(sock, chatId, sender, senderJid, parsed, context);
    }
  }

  return null;
}

/**
 * Handles LLM tool calls for recurring polls.
 */
async function executeRecurringTool(sock, name, input, sender, senderJid, chatId, context) {
  if (name === 'schedule_recurring_poll') {
    return await handleScheduleRecurringPoll(sock, chatId, sender, senderJid, input, context);
  }
  if (name === 'list_recurring_polls') {
    return handleListRecurringPolls(chatId, context);
  }
  if (name === 'pause_recurring_poll') {
    return await handlePauseRecurringPoll(sock, chatId, sender, senderJid, input.scheduleId || null, input.untilDate || null, context);
  }
  if (name === 'resume_recurring_poll') {
    return await handleResumeRecurringPoll(sock, chatId, sender, senderJid, input.scheduleId || null, context);
  }
  if (name === 'modify_recurring_poll') {
    if (input.modifyInstance === true) {
      if (context.handleModifyPollInstance) {
        return await context.handleModifyPollInstance(sock, chatId, sender, senderJid, input.scheduleId, input);
      }
    }
    return await handleModifyRecurringPoll(sock, chatId, sender, senderJid, input.scheduleId, input, context);
  }
  if (name === 'skip_recurring_poll_instance' || name === 'skip_poll_instance') {
    return await handleSkipRecurringPollInstance(sock, chatId, sender, senderJid, input.scheduleId || null, input.targetDayOrDate || input.dateOrDay || null, input.count || 1, context);
  }
  if (name === 'unskip_recurring_poll_instance' || name === 'unskip_poll_instance') {
    return await handleUnskipRecurringPollInstance(sock, chatId, sender, senderJid, input.scheduleId || null, input.targetDayOrDate || input.dateOrDay || null, context);
  }
  if (name === 'cancel_recurring_poll') {
    return await handleCancelRecurringPoll(sock, chatId, sender, senderJid, input.scheduleId, context);
  }
  if (name === 'simulate_recurring_poll') {
    const rawArgs = input.scheduleId ? `${input.scheduleId} ${input.targetDayOrDate || input.dateOrDay || input.when || ''}`.trim() : (input.targetDayOrDate || input.dateOrDay || input.when || '');
    return await handleSimulateRecurringPoll(sock, chatId, sender, senderJid, rawArgs, context);
  }
  if (name === 'clear_all_recurring_polls' || name === 'cancel_all_recurring_polls') {
    return await handleClearAllRecurringPolls(sock, chatId, sender, senderJid, context);
  }
  return `Unknown recurring tool ${name}`;
}

module.exports = {
  handleScheduleRecurringPoll,
  handleListRecurringPolls,
  handleCancelRecurringPoll,
  handleClearAllRecurringPolls,
  handleModifyRecurringPoll,
  handlePauseRecurringPoll,
  handleResumeRecurringPoll,
  handleSkipRecurringPollInstance,
  handleUnskipRecurringPollInstance,
  handleSimulateRecurringPoll,
  handleRecurringCommand,
  executeRecurringTool
};
