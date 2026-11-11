/**
 * Recurring Match Poll Commands
 * Handles scheduling, listing, cancelling, modifying, pausing, resuming,
 * and skipping recurring match polls.
 */

const recurringPollsModule = require('../recurringPolls');
const { isUserAdmin, isSameUser, getTargetGroupJid, resolveAllowedGroup, resolveTargetChat, extractGroupFlag } = require('./groupCommands');
const groupsConfig = require('../groupsConfig');

async function handleScheduleRecurringPoll(sock, chatId, sender, senderJid, params, context) {
  const { recurringPolls, persistPolls } = context;
  const groupQuery = params?.group || null;
  let targetChatId = chatId.endsWith('@g.us') ? chatId : (await getTargetGroupJid(sock) || chatId);
  if (groupQuery || (chatId && !chatId.endsWith('@g.us'))) {
    const targetRes = await resolveTargetChat(sock, chatId, senderJid, groupQuery, context, { requireAdmin: true, actionDesc: 'schedule recurring polls' });
    if (targetRes?.error) return targetRes.error;
    targetChatId = targetRes.targetChatId;
  }
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
  const effectiveChat = sched.remoteJid || chatId;
  const isCreator = sched.creator ? isSameUser(sched.creator.jid, senderJid, sched.creator.name, sender) : false;
  const isAdmin = await isUserAdmin(sock, effectiveChat, senderJid);

  if (!isCreator && !isAdmin) {
    return '⚠️ Only the creator of this recurring poll or group admins can cancel it.';
  }

  return await recurringPollsModule.cancelRecurringPoll({ recurringPolls, persistPolls, sender, scheduleId: cleanId });
}

async function handleClearAllRecurringPolls(sock, chatId, sender, senderJid, context) {
  const { recurringPolls, persistPolls } = context;
  let targetChatId = chatId;
  if (chatId && !chatId.endsWith('@g.us')) {
    const targetRes = await resolveTargetChat(sock, chatId, senderJid, null, context, { requireAdmin: true, actionDesc: 'clear recurring polls' });
    if (targetRes?.error) return targetRes.error;
    targetChatId = targetRes.targetChatId;
  }
  const isAdmin = await isUserAdmin(sock, targetChatId, senderJid);
  if (!isAdmin) {
    return '⚠️ Only group admins can clear all recurring polls.';
  }
  return await recurringPollsModule.clearAllRecurringPolls({ recurringPolls, persistPolls, sender, chatId });
}

async function handleModifyRecurringPoll(sock, chatId, sender, senderJid, scheduleId, updates, context) {
  const { recurringPolls, persistPolls, activePolls } = context;
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
  const effectiveChat = sched.remoteJid || chatId;
  const isCreator = sched.creator ? isSameUser(sched.creator.jid, senderJid, sched.creator.name, sender) : false;
  const isAdmin = await isUserAdmin(sock, effectiveChat, senderJid);

  if (!isCreator && !isAdmin) {
    return '⚠️ Only the creator of this recurring poll or group admins can modify it.';
  }

  return await recurringPollsModule.modifyRecurringPoll({
    recurringPolls,
    persistPolls,
    activePolls,
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
  const effectiveChat = sched.remoteJid || chatId;
  const isCreator = sched.creator ? isSameUser(sched.creator.jid, senderJid, sched.creator.name, sender) : false;
  const isAdmin = await isUserAdmin(sock, effectiveChat, senderJid);

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
  const effectiveChat = sched.remoteJid || chatId;
  const isCreator = sched.creator ? isSameUser(sched.creator.jid, senderJid, sched.creator.name, sender) : false;
  const isAdmin = await isUserAdmin(sock, effectiveChat, senderJid);

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
  const effectiveChat = sched.remoteJid || chatId;
  const isCreator = sched.creator ? isSameUser(sched.creator.jid, senderJid, sched.creator.name, sender) : false;
  const isAdmin = await isUserAdmin(sock, effectiveChat, senderJid);

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
  const effectiveChat = sched.remoteJid || chatId;
  const isCreator = sched.creator ? isSameUser(sched.creator.jid, senderJid, sched.creator.name, sender) : false;
  const isAdmin = await isUserAdmin(sock, effectiveChat, senderJid);

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

async function handleOverrideRecurringPollInstanceSlots(sock, chatId, sender, senderJid, scheduleId, targetDayOrDate = null, slots = null, context = {}) {
  const { recurringPolls, activePolls, persistPolls } = context;
  const isAllChat = !chatId || !chatId.endsWith('@g.us');
  const chatSchedules = [...recurringPolls.entries()].filter(([, s]) => isAllChat || s.remoteJid === chatId);

  const rawArgs = `${scheduleId || ''} ${targetDayOrDate || ''} ${slots !== null && slots !== undefined ? slots : ''}`.trim();
  const extracted = recurringPollsModule.extractOverrideSlotsArgs(rawArgs);
  let cleanId = extracted.scheduleId ? String(extracted.scheduleId).replace(/^[\"'\`]|[{\"'\`]$/g, '').trim() : '';
  let effTarget = extracted.targetDayOrDate;
  let effSlots = extracted.slots;

  // If user passed targetDayOrDate or slots as first param and there is only 1 schedule:
  if (cleanId && chatSchedules.length === 1 && !recurringPolls.has(cleanId)) {
    const isDayOrDate = recurringPollsModule.DAY_LOOKUP?.[cleanId.toLowerCase()] !== undefined ||
      /^(?:today|tomorrow|next|all|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)$/i.test(cleanId);
    const isSlotsVal = /^\d+$/.test(cleanId) || /^(?:opt-?in|optin|yesno|reset|clear|none|remove)$/i.test(cleanId);
    if (isDayOrDate && effSlots === null) {
      effTarget = cleanId;
      cleanId = chatSchedules[0][0];
    } else if (isSlotsVal && effSlots === null) {
      effSlots = /^\d+$/.test(cleanId) ? parseInt(cleanId, 10) : cleanId;
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
      return `Please specify which schedule ID to override slots for (${ids}). Example: "!setslots ${chatSchedules[0][0]} Friday 8"`;
    }
  }

  const sched = recurringPolls.get(targetKey);
  const effectiveChat = sched.remoteJid || chatId;
  const isCreator = sched.creator ? isSameUser(sched.creator.jid, senderJid, sched.creator.name, sender) : false;
  const isSuper = groupsConfig.isSuperAdmin(senderJid);
  const isAdmin = isSuper || (await isUserAdmin(sock, effectiveChat, senderJid));

  if (!isCreator && !isAdmin) {
    return '⚠️ Only the creator of this recurring poll or group admins can override instance slots.';
  }

  return await recurringPollsModule.overrideRecurringPollInstanceSlots({
    recurringPolls,
    activePolls,
    persistPolls,
    sock,
    scheduleId: targetKey,
    targetDayOrDate: effTarget,
    slots: effSlots,
    chatId,
    sender,
    senderJid
  });
}

async function handleSkipRecurringPollInstanceCourt(sock, chatId, sender, senderJid, scheduleId, targetDayOrDate = null, courts = null, isUnskip = false, context = {}) {
  const { recurringPolls, activePolls, persistPolls } = context;
  const isAllChat = !chatId || !chatId.endsWith('@g.us');
  const chatSchedules = [...recurringPolls.entries()].filter(([, s]) => isAllChat || s.remoteJid === chatId);

  let cleanId = scheduleId ? String(scheduleId).replace(/^[\"\'\`]|[\"\'\`]$/g, '').trim() : '';
  let effTarget = targetDayOrDate;

  if (cleanId && chatSchedules.length === 1 && !recurringPolls.has(cleanId)) {
    const isDayOrDate = recurringPollsModule.DAY_LOOKUP?.[cleanId.toLowerCase()] !== undefined ||
      /^(?:today|tomorrow|next|all|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)$/i.test(cleanId);
    if (isDayOrDate) {
      effTarget = cleanId;
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
      if (chatSchedules.length === 1) {
        targetKey = chatSchedules[0][0];
      } else {
        return `⚠️ Schedule ID "\`${cleanId}\`" was not found. Use "!recurringpolls" to view active schedule IDs.`;
      }
    }
  } else {
    if (chatSchedules.length === 1) {
      targetKey = chatSchedules[0][0];
    } else if (chatSchedules.length === 0) {
      return '📅 No scheduled recurring polls found for this chat. Use "!recurringpolls" to check schedules.';
    } else {
      const ids = chatSchedules.map(([id]) => `\`${id}\``).join(', ');
      return `Please specify which schedule ID (${ids}). Example: "!modifyinstance ${chatSchedules[0][0]} Friday --skip-court 3"`;
    }
  }

  const sched = recurringPolls.get(targetKey);
  const isCreator = sched.creator ? isSameUser(sched.creator.jid, senderJid, sched.creator.name, sender) : false;
  const isAdmin = await isUserAdmin(sock, chatId, senderJid);

  if (!isCreator && !isAdmin) {
    return '⚠️ Only the creator of this recurring poll or group admins can skip courts for instances.';
  }

  return await recurringPollsModule.overrideRecurringPollInstanceCourtSkip({
    recurringPolls,
    activePolls,
    persistPolls,
    scheduleId: targetKey,
    targetDayOrDate: effTarget,
    courts,
    action: isUnskip ? 'unskip' : 'skip',
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
  if (!text) return null;
  const { groupQuery, cleanText } = extractGroupFlag(text);
  let targetChatId = chatId;

  if (groupQuery) {
    const isRequireAdmin = /^!(?:clearallrecurringpolls|clearrecurringpolls|cancelallrecurringpolls|deleteallrecurringpolls|removeallrecurringpolls|clearallrecurring|cancelallrecurring|pauseallrecurring|stopallrecurring|pauserecurringpolls|stoprecurringpolls|resumeallrecurring|startallrecurring|resumerecurringpolls|startrecurringpolls)/i.test(cleanText.trim()) ||
      (/^!(?:recurringpoll|dailypoll|schedulepoll|everydaypoll|repeatingpoll|recurringoptinpoll|dailyoptinpoll|recurringyesnopoll|dailyyesnopoll)/i.test(cleanText.trim()) && !/\b(?:simulate|mock|dry-?run|test|status|list|skip|unskip)\b/i.test(cleanText.trim()));

    const targetRes = await resolveTargetChat(sock, chatId, senderJid, groupQuery, context, {
      requireAdmin: isRequireAdmin,
      actionDesc: isRequireAdmin ? "manage recurring polls" : undefined
    });
    if (targetRes?.error) return targetRes.error;
    targetChatId = targetRes.targetChatId;
  }

  const lower = cleanText.toLowerCase();

  // Simulation commands
  if (
    lower.startsWith("!simulaterecurringpoll") || lower.startsWith("!simulaterecurring") ||
    lower.startsWith("!simrecurringpoll") || lower.startsWith("!simrecurring") ||
    lower.startsWith("!recurringpoll simulate") || lower.startsWith("!recurringpolls simulate") ||
    lower.startsWith("!recurringpoll sim") || lower.startsWith("!recurringpolls sim") ||
    lower.startsWith("!schedulepoll simulate") || lower.startsWith("!scheduledpolls simulate") ||
    lower.startsWith("!recurringpoll mock") || lower.startsWith("!recurringpolls mock")
  ) {
    const rawArgs = cleanText.replace(/^!(?:simulaterecurringpoll|simulaterecurring|simrecurringpoll|simrecurring|(?:recurringpolls?|scheduledpolls?)\s+(?:simulate|sim|mock))\s*/i, "").trim();
    return await handleSimulateRecurringPoll(sock, targetChatId, sender, senderJid, rawArgs, context);
  }

  // Status & listing
  if (
    lower.startsWith("!recurringpoll status") || lower.startsWith("!schedulepoll status") ||
    lower.startsWith("!recurringpolls status") || lower.startsWith("!scheduledpolls status")
  ) {
    const parts = cleanText.trim().split(/\s+/);
    const targetId = parts.length > 2 ? parts.slice(2).join(" ").replace(/^[\"\']|[\"\']$/g, "").trim() : null;
    if (targetId) {
      return recurringPollsModule.getRecurringPollStatus({ recurringPolls: context.recurringPolls, scheduleId: targetId, chatId: targetChatId });
    }
    return handleListRecurringPolls(targetChatId, context);
  }

  if (
    lower === "!recurringpolls" || lower === "!scheduledpolls" || lower === "!dailypolls" ||
    lower === "!recurringpoll list" || lower === "!schedulepoll list"
  ) {
    return handleListRecurringPolls(targetChatId, context);
  }

  // Clear all & cancel
  if (
    lower === "!clearallrecurringpolls" || lower === "!clearrecurringpolls" ||
    lower === "!cancelallrecurringpolls" || lower === "!deleteallrecurringpolls" ||
    lower === "!removeallrecurringpolls" || lower === "!clearallrecurring" || lower === "!cancelallrecurring"
  ) {
    return await handleClearAllRecurringPolls(sock, targetChatId, sender, senderJid, context);
  }

  if (
    lower.startsWith("!cancelrecurringpoll") || lower.startsWith("!deleterecurringpoll") ||
    lower.startsWith("!removerecurringpoll") || lower.startsWith("!clearrecurringpoll")
  ) {
    const parts = cleanText.split(/\s+/);
    const specificId = parts.length > 1 ? parts[1].trim() : null;
    if (specificId && /^all$/i.test(specificId)) {
      return await handleClearAllRecurringPolls(sock, targetChatId, sender, senderJid, context);
    }
    return await handleCancelRecurringPoll(sock, targetChatId, sender, senderJid, specificId, context);
  }

  // Modifying recurring schedule template
  if (/^!(?:modifyrecurringpoll|editrecurringpoll|updaterecurringpoll|changerecurringpoll|modifyrecurring|editrecurring|updaterecurring)\b/i.test(cleanText)) {
    const parsed = recurringPollsModule.parseRecurringPollText(cleanText);
    if (parsed && parsed.action === "modify") {
      if (groupQuery) parsed.updates.group = groupQuery;
      return await handleModifyRecurringPoll(sock, targetChatId, sender, senderJid, parsed.scheduleId, parsed.updates, context);
    }
  }

  // Skipping instances
  if (
    lower.startsWith("!skipinstance") || lower.startsWith("!skipinstances") ||
    lower.startsWith("!skiprecurringinstance") || lower.startsWith("!skiprecurringinstances") ||
    lower.startsWith("!skiprecurringpoll") || lower.startsWith("!skiprecurring") || lower.startsWith("!skippoll")
  ) {
    const rawArgs = cleanText.replace(/^!(?:skipinstances|skipinstance|skiprecurringinstances|skiprecurringinstance|skiprecurringpoll|skiprecurring|skippoll)\s*/i, "").trim();
    const { scheduleId: sId, targetDayOrDate: tTarget, count: cCount } = recurringPollsModule.extractSkipArgs(rawArgs);
    return await handleSkipRecurringPollInstance(sock, targetChatId, sender, senderJid, sId, tTarget, cCount, context);
  }

  if (
    lower.startsWith("!unskipinstance") || lower.startsWith("!unskiprecurringinstance") ||
    lower.startsWith("!unskiprecurringpoll") || lower.startsWith("!unskiprecurring") || lower.startsWith("!resumeskip")
  ) {
    const parts = cleanText.trim().split(/\s+/);
    const target = parts.length > 1 ? parts[1].trim() : null;
    const targetDayOrDate = parts.length > 2 ? parts.slice(2).join(" ").trim() : null;
    return await handleUnskipRecurringPollInstance(sock, targetChatId, sender, senderJid, target, targetDayOrDate, context);
  }

  // Skipping or unskipping courts on future instances
  if (
    lower.startsWith("!recurringpoll skipcourt") || lower.startsWith("!recurringpolls skipcourt") ||
    lower.startsWith("!schedulepoll skipcourt") || lower.startsWith("!scheduledpolls skipcourt") ||
    lower.startsWith("!recurringpoll unskipcourt") || lower.startsWith("!recurringpolls unskipcourt") ||
    lower.startsWith("!schedulepoll unskipcourt") || lower.startsWith("!scheduledpolls unskipcourt")
  ) {
    const isUnskip = lower.includes("unskip");
    const rawArgs = cleanText.replace(/^!(?:recurringpolls?|scheduledpolls?)\s+(?:un)?skipcourts?\s*/i, "").trim();
    const parts = rawArgs.split(/\s+/);
    let sId = null;
    let tTarget = null;
    let courts = null;
    if (parts.length >= 3) {
      sId = parts[0];
      tTarget = parts[1];
      courts = parts.slice(2).join(" ");
    } else if (parts.length === 2) {
      tTarget = parts[0];
      courts = parts[1];
    } else if (parts.length === 1) {
      courts = parts[0];
    }
    return await handleSkipRecurringPollInstanceCourt(sock, targetChatId, sender, senderJid, sId, tTarget, courts, isUnskip, context);
  }

  if (
    /^!(?:recurringpolls?|scheduledpolls?)\s+skip\b/i.test(lower) || lower.startsWith("!recurringpolls skip") ||
    lower.startsWith("!schedulepoll skip") || lower.startsWith("!scheduledpolls skip")
  ) {
    const rawArgs = cleanText.replace(/^!(?:recurringpolls?|scheduledpolls?)\s+skip(?:instances?|poll)?\s*/i, "").trim();
    const { scheduleId: sId, targetDayOrDate: tTarget, count: cCount } = recurringPollsModule.extractSkipArgs(rawArgs);
    return await handleSkipRecurringPollInstance(sock, targetChatId, sender, senderJid, sId, tTarget, cCount, context);
  }

  if (
    /^!(?:recurringpolls?|scheduledpolls?)\s+unskip\b/i.test(lower)
  ) {
    const parts = cleanText.trim().split(/\s+/);
    const target = parts.length > 2 ? parts[2].trim() : null;
    const targetDayOrDate = parts.length > 3 ? parts.slice(3).join(" ").trim() : null;
    return await handleUnskipRecurringPollInstance(sock, targetChatId, sender, senderJid, target, targetDayOrDate, context);
  }

  // Setting future instance slots on a recurring schedule via recurringpoll namespace
  if (
    lower.startsWith("!recurringpoll setslots") || lower.startsWith("!recurringpolls setslots") ||
    lower.startsWith("!schedulepoll setslots") || lower.startsWith("!scheduledpolls setslots")
  ) {
    const rawArgs = cleanText.replace(/^!(?:recurringpolls?|scheduledpolls?)\s+setslots\s*/i, "").trim();
    const { scheduleId: sId, targetDayOrDate: tTarget, slots: sSlots } = recurringPollsModule.extractOverrideSlotsArgs(rawArgs);
    return await handleOverrideRecurringPollInstanceSlots(sock, targetChatId, sender, senderJid, sId, tTarget, sSlots, context);
  }

  // Pausing & resuming
  if (
    lower.startsWith("!pauseallrecurring") || lower.startsWith("!stopallrecurring") ||
    lower === "!pauserecurringpolls" || lower === "!stoprecurringpolls"
  ) {
    const rawArgs = cleanText.replace(/^!(?:pauseallrecurring|stopallrecurring|pauserecurringpolls|stoprecurringpolls)\s*/i, "").trim();
    const { untilDate } = recurringPollsModule.extractPauseArgs(rawArgs);
    return await handlePauseRecurringPoll(sock, targetChatId, sender, senderJid, "all", untilDate, context);
  }

  if (
    lower.startsWith("!resumeallrecurring") || lower.startsWith("!startallrecurring") ||
    lower === "!resumerecurringpolls" || lower === "!startrecurringpolls"
  ) {
    return await handleResumeRecurringPoll(sock, targetChatId, sender, senderJid, "all", context);
  }

  if (
    lower.startsWith("!recurringpoll pause") || lower.startsWith("!recurringpolls pause") ||
    lower.startsWith("!schedulepoll pause") || lower.startsWith("!scheduledpolls pause")
  ) {
    const rawArgs = cleanText.replace(/^!(?:recurringpolls?|scheduledpolls?)\s+(?:pause|stop)\s*/i, "").trim();
    const { scheduleId: sId, untilDate } = recurringPollsModule.extractPauseArgs(rawArgs);
    return await handlePauseRecurringPoll(sock, targetChatId, sender, senderJid, sId, untilDate, context);
  }

  if (
    lower.startsWith("!recurringpoll resume") || lower.startsWith("!recurringpolls resume") ||
    lower.startsWith("!schedulepoll resume") || lower.startsWith("!scheduledpolls resume")
  ) {
    const parts = cleanText.trim().split(/\s+/);
    const specificId = parts.length > 2 ? parts.slice(2).join(" ").trim() : null;
    return await handleResumeRecurringPoll(sock, targetChatId, sender, senderJid, specificId, context);
  }

  if (
    lower.startsWith("!pauserecurringpoll") || lower.startsWith("!stoprecurringpoll") ||
    lower.startsWith("!pauserecurring") || lower.startsWith("!stoprecurring")
  ) {
    const rawArgs = cleanText.replace(/^!(?:pauserecurringpoll|stoprecurringpoll|pauserecurring|stoprecurring)\s*/i, "").trim();
    const { scheduleId: sId, untilDate } = recurringPollsModule.extractPauseArgs(rawArgs);
    return await handlePauseRecurringPoll(sock, targetChatId, sender, senderJid, sId, untilDate, context);
  }

  if (
    lower.startsWith("!resumerecurringpoll") || lower.startsWith("!startrecurringpoll") ||
    lower.startsWith("!resumerecurring") || lower.startsWith("!startrecurring")
  ) {
    const parts = cleanText.split(/\s+/);
    const specificId = parts.length > 1 ? parts.slice(1).join(" ").trim() : null;
    return await handleResumeRecurringPoll(sock, targetChatId, sender, senderJid, specificId, context);
  }

  // Creation & natural language command
  if (/^!(?:recurringpoll|dailypoll|schedulepoll|everydaypoll|repeatingpoll|recurringoptinpoll|dailyoptinpoll|recurringyesnopoll|dailyyesnopoll)\b/i.test(cleanText)) {
    const parsed = recurringPollsModule.parseRecurringPollText(cleanText);
    if (parsed) {
      if (groupQuery) {
        parsed.group = groupQuery;
        if (parsed.updates) parsed.updates.group = groupQuery;
      }
      if (parsed.action === "simulate") {
        const rawArgs = parsed.scheduleId ? `${parsed.scheduleId} ${parsed.targetDayOrDate || ""}`.trim() : (parsed.targetDayOrDate || "");
        return await handleSimulateRecurringPoll(sock, targetChatId, sender, senderJid, rawArgs, context);
      }
      if (parsed.action === "status") {
        if (parsed.scheduleId) {
          return recurringPollsModule.getRecurringPollStatus({ recurringPolls: context.recurringPolls, scheduleId: parsed.scheduleId, chatId: targetChatId });
        }
        return handleListRecurringPolls(targetChatId, context);
      }
      if (parsed.action === "list") {
        return handleListRecurringPolls(targetChatId, context);
      }
      if (parsed.action === "clear_all") {
        return await handleClearAllRecurringPolls(sock, targetChatId, sender, senderJid, context);
      }
      if (parsed.action === "cancel") {
        return await handleCancelRecurringPoll(sock, targetChatId, sender, senderJid, parsed.scheduleId, context);
      }
      if (parsed.action === "skip_instance") {
        return await handleSkipRecurringPollInstance(sock, targetChatId, sender, senderJid, parsed.scheduleId, parsed.targetDayOrDate, parsed.count, context);
      }
      if (parsed.action === "unskip_instance") {
        return await handleUnskipRecurringPollInstance(sock, targetChatId, sender, senderJid, parsed.scheduleId, parsed.targetDayOrDate, context);
      }
      if (parsed.action === "pause") {
        return await handlePauseRecurringPoll(sock, targetChatId, sender, senderJid, parsed.scheduleId, parsed.untilDate, context);
      }
      if (parsed.action === "modify") {
        return await handleModifyRecurringPoll(sock, targetChatId, sender, senderJid, parsed.scheduleId, parsed.updates, context);
      }
      if (parsed.action === "resume") {
        return await handleResumeRecurringPoll(sock, targetChatId, sender, senderJid, parsed.scheduleId, context);
      }
      return await handleScheduleRecurringPoll(sock, chatId, sender, senderJid, parsed, context);
    }
  }

  return null;
}

async function executeRecurringTool(sock, name, input, sender, senderJid, chatId, context) {
  const groupQuery = input.group || input.targetGroup || input.groupName || null;
  let targetChatId = chatId.endsWith('@g.us') ? chatId : (await getTargetGroupJid(sock) || chatId);
  if (groupQuery || (chatId && !chatId.endsWith('@g.us'))) {
    const isRequireAdmin = (name === 'schedule_recurring_poll' || name === 'clear_all_recurring_polls' || name === 'cancel_all_recurring_polls');
    const targetRes = await resolveTargetChat(sock, chatId, senderJid, groupQuery, context, {
      requireAdmin: isRequireAdmin,
      actionDesc: isRequireAdmin ? 'manage recurring polls' : undefined
    });
    if (targetRes?.error) return targetRes.error;
    targetChatId = targetRes.targetChatId;
  }
  if (name === 'schedule_recurring_poll') {
    return await handleScheduleRecurringPoll(sock, chatId, sender, senderJid, input, context);
  }
  if (name === 'list_recurring_polls') {
    return handleListRecurringPolls(targetChatId, context);
  }
  if (name === 'pause_recurring_poll') {
    return await handlePauseRecurringPoll(sock, targetChatId, sender, senderJid, input.scheduleId || null, input.untilDate || null, context);
  }
  if (name === 'resume_recurring_poll') {
    return await handleResumeRecurringPoll(sock, targetChatId, sender, senderJid, input.scheduleId || null, context);
  }
  if (name === 'modify_recurring_poll') {
    if (input.modifyInstance === true) {
      if (context.handleModifyPollInstance) {
        return await context.handleModifyPollInstance(sock, targetChatId, sender, senderJid, input.scheduleId, input);
      }
    }
    return await handleModifyRecurringPoll(sock, targetChatId, sender, senderJid, input.scheduleId, input, context);
  }
  if (name === 'skip_recurring_poll_instance' || name === 'skip_poll_instance') {
    return await handleSkipRecurringPollInstance(sock, targetChatId, sender, senderJid, input.scheduleId || null, input.targetDayOrDate || input.dateOrDay || null, input.count || 1, context);
  }
  if (name === 'unskip_recurring_poll_instance' || name === 'unskip_poll_instance') {
    return await handleUnskipRecurringPollInstance(sock, targetChatId, sender, senderJid, input.scheduleId || null, input.targetDayOrDate || input.dateOrDay || null, context);
  }
  if (name === 'cancel_recurring_poll') {
    return await handleCancelRecurringPoll(sock, targetChatId, sender, senderJid, input.scheduleId, context);
  }
  if (name === 'simulate_recurring_poll') {
    const rawArgs = input.scheduleId ? `${input.scheduleId} ${input.targetDayOrDate || input.dateOrDay || input.when || ''}`.trim() : (input.targetDayOrDate || input.dateOrDay || input.when || '');
    return await handleSimulateRecurringPoll(sock, targetChatId, sender, senderJid, rawArgs, context);
  }
  if (name === 'override_recurring_instance_slots' || name === 'set_recurring_instance_slots') {
    return await handleOverrideRecurringPollInstanceSlots(
      sock,
      targetChatId,
      sender,
      senderJid,
      input.scheduleId,
      input.targetDayOrDate || input.dateOrDay || input.when || null,
      input.slots !== undefined ? input.slots : (input.size !== undefined ? input.size : null),
      context
    );
  }
  if (name === 'clear_all_recurring_polls' || name === 'cancel_all_recurring_polls') {
    return await handleClearAllRecurringPolls(sock, targetChatId, sender, senderJid, context);
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
  handleOverrideRecurringPollInstanceSlots,
  handleSkipRecurringPollInstanceCourt,
  handleSimulateRecurringPoll,
  handleRecurringCommand,
  executeRecurringTool
};
