/**
 * Central Command Dispatcher & Tool Execution Router
 * Coordinates:
 *   - groupCommands
 *   - courtCommands
 *   - playerCommands
 *   - recurringCommands
 *   - pollCommands
 *   - lineupCommands
 */

const { jidNormalizedUser } = require('@whiskeysockets/baileys');
const weather = require('../weather');
const { helpText } = require('../help');
const messageHistory = require('../messageHistory');
const groupsConfig = require('../groupsConfig');

const groupCommands = require('./groupCommands');
const courtCommands = require('./courtCommands');
const playerCommands = require('./playerCommands');
const recurringCommands = require('./recurringCommands');
const pollCommands = require('./pollCommands');
const lineupCommands = require('./lineupCommands');

const DEFAULT_LOCATION = 'San Jose, CA';

const TRIGGER_PREFIX = '@tenbot';

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripLeadingTrigger(text, triggerPrefix = TRIGGER_PREFIX) {
  if (!triggerPrefix) return text;
  const baseName = escapeRegex(triggerPrefix.replace(/^@/, ''));
  return text.replace(new RegExp(`^@${baseName}[:,]?\\s*`, 'i'), '').trim();
}

function isAddressedToBot(text, msg, botJids, triggerPrefix = TRIGGER_PREFIX) {
  if (!triggerPrefix) return { addressed: true, promptText: text };

  const mentionedJids = (msg?.message?.extendedTextMessage?.contextInfo?.mentionedJid || []).map(jidNormalizedUser);
  const normalizedBotJids = (botJids || []).map(jidNormalizedUser).filter(Boolean);
  const isDirectlyMentioned = mentionedJids.some((jid) => normalizedBotJids.includes(jid));

  const baseName = escapeRegex(triggerPrefix.replace(/^@/, ''));
  const prefixRegex = new RegExp(`^@${baseName}[:,]?\\s*`, 'i');
  const anywhereRegex = new RegExp(`@${baseName}[:,]?\\b`, 'ig');

  if (prefixRegex.test(text)) {
    const promptText = text.replace(prefixRegex, '').trim();
    return { addressed: true, promptText };
  }

  // Check if text starts with @<bot-number> or @<bot-lid> (e.g. @24104010813588)
  for (const jid of normalizedBotJids) {
    const num = jid.split('@')[0].split(':')[0];
    if (num) {
      const numPrefixRegex = new RegExp(`^@${escapeRegex(num)}[:,]?\\s*`, 'i');
      if (numPrefixRegex.test(text)) {
        const promptText = text.replace(numPrefixRegex, '').trim();
        return { addressed: true, promptText };
      }
    }
  }

  const hasBotNumAnywhere = normalizedBotJids.some((jid) => {
    const num = jid.split('@')[0].split(':')[0];
    return num && new RegExp(`@${escapeRegex(num)}[:,]?\\b`, 'i').test(text);
  });

  if (isDirectlyMentioned || anywhereRegex.test(text) || hasBotNumAnywhere) {
    let promptText = text.replace(anywhereRegex, '').trim();
    for (const jid of normalizedBotJids) {
      const num = jid.split('@')[0].split(':')[0];
      if (num) {
        promptText = promptText.replace(new RegExp(`@${escapeRegex(num)}[:,]?\\s*`, 'g'), '').trim();
      }
    }
    promptText = promptText.replace(/^[\s,:]+/, '').replace(/\s{2,}/g, ' ').trim();
    return { addressed: true, promptText };
  }

  return { addressed: false, promptText: text };
}


/**
 * Executes a tool called by Claude and returns the result string.
 */
async function executeTool(sock, chatId, sender, toolUse, msg, context) {
  const { name, input } = toolUse;

  // Poll tools
  if ([
    'create_poll',
    'generate_matchups',
    'rematch',
    'stop_poll',
    'resume_poll',
    'pause_reminders',
    'resume_reminders',
    'trigger_reminder',
    'send_reminder',
    'limit_poll_slots',
    'set_poll_slots',
    'modify_poll_instance',
    'clear_all_polls',
    'cancel_poll'
  ].includes(name)) {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await pollCommands.executePollTool(sock, name, input, sender, senderJid, chatId, msg, context);
  }

  // Player & Rating tools
  if (['add_alias', 'remove_alias', 'set_full_name', 'set_rating', 'reset_rating'].includes(name)) {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await playerCommands.executePlayerTool(sock, name, input, sender, senderJid, chatId);
  }

  // Court tools
  if ([
    'get_court_bookings',
    'get_court_reservations',
    'check_court_availability',
    'book_court',
    'cancel_court',
    'cancel_court_reservation',
    'cancel_court_booking',
    'get_my_court_bookings'
  ].includes(name)) {
    return await courtCommands.executeCourtTool(sock, name, input, sender, chatId);
  }

  // Recurring poll tools
  if ([
    'schedule_recurring_poll',
    'list_recurring_polls',
    'pause_recurring_poll',
    'resume_recurring_poll',
    'modify_recurring_poll',
    'skip_recurring_poll_instance',
    'skip_poll_instance',
    'unskip_recurring_poll_instance',
    'unskip_poll_instance',
    'cancel_recurring_poll',
    'clear_all_recurring_polls',
    'cancel_all_recurring_polls'
  ].includes(name)) {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await recurringCommands.executeRecurringTool(sock, name, input, sender, senderJid, chatId, {
      ...context,
      handleModifyPollInstance: (s, cId, snd, sndJid, tId, upd) =>
        pollCommands.handleModifyPollInstance(s, cId, snd, sndJid, tId, upd, context)
    });
  }

  // Group config tools
  if ([
    'list_groups',
    'get_groups',
    'add_group',
    'remove_group',
    'update_group_config',
    'set_group_config',
    'get_group_config'
  ].includes(name)) {
    const senderJid = msg?.key?.participant || msg?.key?.remoteJid;
    return await groupCommands.executeGroupTool(sock, name, input, senderJid, chatId);
  }

  // Lineup / Matchup tools
  if ([
    "parse_lineup",
    "parse_matchup",
    "parse_matchups",
    "record_lineup",
    "record_matchup",
    "record_matchups"
  ].includes(name)) {
    return await lineupCommands.executeLineupTool(sock, name, input, sender, chatId, msg, context);
  }

  // Weather tool
  if (name === 'get_weather') {
    const location = input?.location || DEFAULT_LOCATION;
    try {
      const forecast = await weather.getForecast(location);
      return weather.formatForecast(forecast);
    } catch (err) {
      return `Failed to get weather for ${location}: ${err.message}`;
    }
  }

  return `Unknown tool ${name}`;
}

/**
 * Routes and handles incoming command messages.
 * Returns response text if a command was handled, or null if unhandled.
 */
async function routeCommand(sock, rawText, chatId, sender, msg, context, opts = {}) {
  const text = (rawText || '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\u00A0\u202F\u2000-\u200A]/g, ' ')
    .trim();
  const lower = text.toLowerCase();
  const senderJid = msg?.key?.participant || msg?.key?.remoteJid;

  // 1. Basic commands
  if (lower === '!ping') return 'pong 🏓';

  if (lower === '!help' || lower.startsWith('!help ')) {
    const specificCmd = text.slice('!help'.length).trim().replace(/^!/, '').toLowerCase();
    const isSuper = groupsConfig.isSuperAdmin(senderJid);
    return helpText(specificCmd || null, isSuper);
  }

  // 2. Group management commands
  const groupRes = await groupCommands.handleGroupCommand(sock, text, chatId, senderJid);
  if (groupRes !== null) return groupRes;

  // 3. Reset conversation history
  if (lower === '!reset') {
    const isAdmin = await groupCommands.isUserAdmin(sock, chatId, senderJid);
    if (!isAdmin) {
      return '⚠️ Only group admins can use !reset.';
    }
    if (context.chatHistories) context.chatHistories.delete(chatId);
    messageHistory.clear(chatId);
    return 'Conversation history and recent 2-week group message logs cleared.';
  }

  // 4. SCVCC Court commands
  const courtRes = await courtCommands.handleCourtCommand(sock, text, chatId, sender);
  if (courtRes !== null) return courtRes;

  // 5. Player, rating, alias, full name, score, and leaderboard commands
  const playerRes = await playerCommands.handlePlayerCommand(sock, text, chatId, sender, senderJid, msg, context.activePolls);
  if (playerRes !== null) return playerRes;

  // 6. Weather
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

  // 7. Direct poll creation command (!createpoll, !poll, etc.)
  if (/^!(?:createpoll|poll|makepoll|newpoll|optinpoll|yesnopoll|createoptinpoll|createyesnopoll)\b/i.test(text)) {
    const parsed = pollCommands.parsePollCreationText(text);
    if (parsed) {
      return await pollCommands.handleDirectPollCreation(sock, chatId, sender, msg, parsed, { isCommand: true }, context);
    }
  }

  // 8. Recurring poll commands
  const recurringRes = await recurringCommands.handleRecurringCommand(sock, text, chatId, sender, senderJid, {
    ...context,
    cancelOrDeletePoll: (s, rJid, pId) => pollCommands.cancelOrDeletePoll(s, rJid, pId, context)
  });
  if (recurringRes !== null) return recurringRes;

  // 9. Poll management commands (!stoppoll, !pollstatus, !setslots, etc.)
  const pollRes = await pollCommands.handlePollCommand(sock, text, chatId, sender, senderJid, msg, context);
  if (pollRes !== null) return pollRes;

  // 10. Court cancellation due to lack of votes check
  const hasCancelWord = /\bcancel(?:l?ed|l?ing|s)?\b/i.test(text);
  const hasCourtWord = /\bcourts?\b/i.test(text);
  if (hasCancelWord && hasCourtWord) {
    const cancelAnalysis = await lineupCommands.checkCourtCancellationWithLLM(text, sender, chatId, context.activePolls);
    if (cancelAnalysis && cancelAnalysis.isCourtCancelled) {
      let targetPollId = cancelAnalysis.pollId;
      if (!targetPollId || !context.activePolls.has(targetPollId)) {
        for (const [pollId, pollState] of [...context.activePolls.entries()].reverse()) {
          if (pollState.remoteJid === chatId && (pollState.status === 'active' || pollState.status === 'filled')) {
            targetPollId = pollId;
            break;
          }
        }
      }
      if (!targetPollId && context.latestPollIdByChat) targetPollId = context.latestPollIdByChat.get(chatId);

      if (targetPollId && context.activePolls.has(targetPollId)) {
        const targetPollState = context.activePolls.get(targetPollId);
        targetPollState.status = 'stopped';
        if (context.persistPolls) context.persistPolls();
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

  return null;
}

module.exports = {
  executeTool,
  routeCommand,
  groupCommands,
  courtCommands,
  playerCommands,
  recurringCommands,
  pollCommands,
  lineupCommands,
  isAddressedToBot,
  stripLeadingTrigger
};
