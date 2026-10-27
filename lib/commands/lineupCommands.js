/**
 * Match Lineup Parsing & Attribution
 * Handles:
 *   - Deterministic and LLM-assisted lineup parsing
 *   - Attribution of published lineups to the best matching active poll
 *   - Recording manual lineups in pair history
 *   - Court cancellation detection via LLM
 */

const anthropic = require('../anthropic');
const namesStore = require('../names');
const ratings = require('../ratings');
const pollTime = require('../pollTime');
const pairHistory = require('../pairHistory');
const { getPollVoters, resolveManualPollPlayers, resolveFixedPollRoster, nameFor } = require('./pollCommands');
const { parseLineup } = require('../lineupParser');
const playerCommands = require('./playerCommands');

const LINEUP_PARSER_TOOL = {
  name: 'parse_lineup',
  description: 'Records and parses the tennis match lineup, court assignments, teams, or rotations from the message.',
  input_schema: {
    type: 'object',
    properties: {
      isLineup: {
        type: 'boolean',
        description: 'True if the message is announcing or publishing tennis match lineups, player court assignments, teams, or rotations.'
      },
      type: {
        type: 'string',
        enum: ['singles', 'doubles'],
        description: 'Format of the match: "singles" or "doubles".'
      },
      time: {
        type: ['string', 'null'],
        description: 'Scheduled match time mentioned in the message (e.g. "7:00pm", "9am"), or null if unspecified.'
      },
      players: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of all player names participating in the lineup.'
      },
      sets: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            set: { type: 'integer', description: 'Set number (e.g. 1, 2).' },
            courts: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  court: { type: 'integer', description: 'Court number (e.g. 1, 2, 6).' },
                  teamA: { type: 'array', items: { type: 'string' }, description: 'Players on Team A.' },
                  teamB: { type: 'array', items: { type: 'string' }, description: 'Players on Team B.' }
                },
                required: ['court', 'teamA', 'teamB']
              }
            }
          },
          required: ['set', 'courts']
        }
      }
    },
    required: ['isLineup']
  }
};

function isSamePlayerName(name1, name2) {
  if (!name1 || !name2) return false;
  if (ratings.isPlaceholder(name1) || ratings.isPlaceholder(name2)) return false;
  const k1 = ratings.keyFor(name1);
  const k2 = ratings.keyFor(name2);
  if (!k1 || !k2) return false;
  if (k1 === k2) return true;
  const m1 = namesStore.findIdByNameOrAlias(name1);
  const m2 = namesStore.findIdByNameOrAlias(name2);
  if (m1 && m2 && m1.id && m2.id && m1.id === m2.id) return true;
  if (k1.length >= 3 && k2.length >= 3) {
    if (k1.startsWith(k2 + ' ') || k2.startsWith(k1 + ' ')) return true;
  }
  return false;
}

function extractTimeFromLineupMessage(text, lineup = null) {
  if (lineup && lineup.time) {
    const parsed = pollTime.parseTimeString(lineup.time);
    if (parsed) return { hour: parsed.hour, minute: parsed.minute, display: parsed.display };
  }
  if (!text || typeof text !== 'string') return null;
  const m1 = text.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/i);
  if (m1) {
    const rawH = parseInt(m1[1], 10);
    const minute = m1[2] ? parseInt(m1[2], 10) : 0;
    const ampm = m1[3].toLowerCase();
    let hour = rawH % 12;
    if (ampm === 'pm') hour += 12;
    return { hour, minute, display: `${m1[1]}${m1[2] ? ':' + m1[2] : ''}${ampm}` };
  }
  const m2 = text.match(/\b([01]?\d|2[0-3])[:.](\d{2})\b/);
  if (m2) {
    let hour = parseInt(m2[1], 10);
    const minute = parseInt(m2[2], 10);
    if (hour >= 1 && hour <= 6) hour += 12;
    return { hour, minute, display: `${hour}:${String(minute).padStart(2, '0')}` };
  }
  return null;
}

function getPollMatchTime(pollState) {
  if (!pollState) return null;
  if (pollState.playAt) {
    const d = new Date(pollState.playAt);
    if (!Number.isNaN(d.getTime())) {
      const sj = pollTime.getSanJoseParts(d);
      return { hour: sj.hour, minute: sj.minute };
    }
  }
  if (pollState.when) {
    const m = pollState.when.match(/\b(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm))\b/i) || pollState.when.match(/\b(\d{1,2}[:.]\d{2})\b/);
    const pt = pollTime.parseTimeString(m ? m[1] : pollState.when);
    if (pt) return { hour: pt.hour, minute: pt.minute };
  }
  if (pollState.name) {
    const m = pollState.name.match(/\b(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm))\b/i) || pollState.name.match(/\b(\d{1,2}[:.]\d{2})\b/);
    const pt = pollTime.parseTimeString(m ? m[1] : pollState.name);
    if (pt) return { hour: pt.hour, minute: pt.minute };
  }
  return null;
}

function getPollPlayerNames(pollId, pollState, mePn, messageStore) {
  const { interestedPlayers, aggregated } = getPollVoters(pollId, pollState, mePn, messageStore);
  const players = [];
  const addPlayer = (name) => {
    if (!name || ratings.isPlaceholder(name)) return;
    if (!players.some((existing) => isSamePlayerName(existing, name))) {
      players.push(name);
    }
  };

  let rosterPlayers = [];
  let filledCount = 0;
  if (pollState.isManual) {
    const manualRoster = resolveManualPollPlayers(pollState, interestedPlayers);
    rosterPlayers = manualRoster.players || [];
    filledCount = interestedPlayers.length;
  } else {
    const roster = resolveFixedPollRoster(pollState, aggregated);
    rosterPlayers = roster.players || [];
    filledCount = roster.filledCount || 0;
  }

  if (Array.isArray(rosterPlayers)) {
    for (const p of rosterPlayers) addPlayer(p);
  }
  if (Array.isArray(interestedPlayers)) {
    for (const p of interestedPlayers) addPlayer(p);
  }
  if (Array.isArray(pollState.lastPlayers)) {
    for (const p of pollState.lastPlayers) addPlayer(p);
  }

  const cleanRosterCount = rosterPlayers.filter((p) => !ratings.isPlaceholder(p)).length;
  return {
    players,
    rosterCount: cleanRosterCount,
    filledCount,
    size: pollState.size || null
  };
}

function findBestMatchingPollForLineup({ activePolls, latestPollIdByChat, chatId, lineup, messageText, mePn, messageStore }) {
  let candidatePolls = [];
  for (const [pollId, pollState] of activePolls.entries()) {
    if (pollState.remoteJid === chatId && (pollState.status === 'active' || pollState.status === 'filled' || pollState.status === 'stopped' || pollState.status === 'resolved')) {
      candidatePolls.push({ pollId, pollState });
    }
  }

  if (candidatePolls.length === 0) {
    const latestId = latestPollIdByChat ? latestPollIdByChat.get(chatId) : null;
    const latestState = latestId ? activePolls.get(latestId) : null;
    if (latestState) {
      return { targetPollId: latestId, targetPollState: latestState, matchInfo: 'fallback_latest' };
    }
    return { targetPollId: null, targetPollState: null, matchInfo: 'none' };
  }

  const msgTime = extractTimeFromLineupMessage(messageText, lineup);
  const lineupPlayers = (lineup?.players || []).filter((p) => !ratings.isPlaceholder(p));

  const scored = candidatePolls.map(({ pollId, pollState }, index) => {
    const pollTimeObj = getPollMatchTime(pollState);
    const isExactTimeMatch = Boolean(
      msgTime && pollTimeObj &&
      msgTime.hour === pollTimeObj.hour &&
      msgTime.minute === pollTimeObj.minute
    );

    const pollPlayerInfo = getPollPlayerNames(pollId, pollState, mePn, messageStore);
    const pollPlayers = pollPlayerInfo.players;

    let matchCount = 0;
    const matchedPollIndices = new Set();
    const matchedNames = [];

    for (const lp of lineupPlayers) {
      for (let i = 0; i < pollPlayers.length; i++) {
        if (!matchedPollIndices.has(i) && isSamePlayerName(lp, pollPlayers[i])) {
          matchedPollIndices.add(i);
          matchedNames.push(pollPlayers[i]);
          matchCount++;
          break;
        }
      }
    }

    const isExactPlayerMatch = Boolean(
      lineupPlayers.length > 0 &&
      matchCount === lineupPlayers.length &&
      (
        pollPlayers.length === lineupPlayers.length ||
        (pollPlayerInfo.rosterCount > 0 && matchCount === pollPlayerInfo.rosterCount) ||
        (pollPlayerInfo.size && matchCount === pollPlayerInfo.size)
      )
    );

    const isExactBoth = Boolean(isExactPlayerMatch && isExactTimeMatch);

    const matchRatio = pollPlayers.length > 0
      ? matchCount / Math.max(lineupPlayers.length, pollPlayers.length)
      : 0;

    return {
      pollId,
      pollState,
      index,
      matchCount,
      matchedNames,
      matchRatio,
      pollPlayersCount: pollPlayers.length,
      isExactPlayerMatch,
      isExactTimeMatch,
      isExactBoth,
      statusWeight: pollState.status === 'filled' ? 3 : (pollState.status === 'active' ? 2 : (pollState.status === 'resolved' ? 1 : 0))
    };
  });

  const exactBothMatches = scored.filter((s) => s.isExactBoth);
  if (exactBothMatches.length > 0) {
    exactBothMatches.sort((a, b) => b.index - a.index);
    const best = exactBothMatches[0];
    return {
      targetPollId: best.pollId,
      targetPollState: best.pollState,
      matchInfo: `exact_players_and_time (${best.matchCount} players, time: ${msgTime?.display || ''})`
    };
  }

  const qualifyingMatches = scored.filter((s) => {
    const isTimeEligible = !msgTime || s.isExactTimeMatch;
    const isHalfLineupMatch = lineupPlayers.length > 0 && s.matchCount >= (lineupPlayers.length / 2);
    return Boolean(isTimeEligible && isHalfLineupMatch);
  });

  if (qualifyingMatches.length > 0) {
    qualifyingMatches.sort((a, b) => {
      if (b.isExactTimeMatch !== a.isExactTimeMatch) return (b.isExactTimeMatch ? 1 : 0) - (a.isExactTimeMatch ? 1 : 0);
      if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
      if (b.matchRatio !== a.matchRatio) return b.matchRatio - a.matchRatio;
      if (b.statusWeight !== a.statusWeight) return b.statusWeight - a.statusWeight;
      return b.index - a.index;
    });
    const best = qualifyingMatches[0];
    return {
      targetPollId: best.pollId,
      targetPollState: best.pollState,
      matchInfo: `qualifying_match (${best.matchCount}/${lineupPlayers.length} lineup players, time: ${msgTime ? (best.isExactTimeMatch ? 'exact' : 'mismatch') : 'unspecified'})`
    };
  }

  return {
    targetPollId: null,
    targetPollState: null,
    matchInfo: 'none'
  };
}

async function parseLineupWithLLM(text, chatId, activePolls = new Map()) {
  if (!anthropic.isAnthropicConfigured()) return null;
  console.log(`[lineup-llm] Invoking Claude to parse manual lineup in ${chatId}: "${text}"`);

  const playerEntries = namesStore.getAllEntries();
  const playerListDesc = playerEntries.map((e) => {
    const rawId = e.id ? e.id.split('@')[0] : '';
    const rawPn = e.pn ? e.pn.split('@')[0] : '';
    const aliasesStr = e.aliases && e.aliases.length > 0 ? `, aliases: [${e.aliases.join(', ')}]` : '';
    const ids = [rawId, rawPn].filter(Boolean).join(', ');
    return `- "${e.name}"${e.fullName ? ` (${e.fullName})` : ''} [IDs/Mentions: ${ids || 'none'}${aliasesStr}]`;
  }).join('\n');

  const activePollsDesc = [...activePolls.entries()]
    .filter(([, p]) => p.remoteJid === chatId && (p.status === 'active' || p.status === 'filled' || p.status === 'stopped' || p.status === 'resolved'))
    .map(([id, p]) => {
      const lastPlayersStr = Array.isArray(p.lastPlayers) && p.lastPlayers.length > 0 ? `, previous players: [${p.lastPlayers.join(', ')}]` : '';
      return `- Poll "${p.name || p.when || id}" (size: ${p.size || 'opt-in'}, when: "${p.when || ''}", status: ${p.status}${lastPlayersStr})`;
    })
    .join('\n');

  const prompt = `You are an expert tennis assistant parsing a WhatsApp group chat message in San Jose, CA.
A group member just posted this message:
"""
${text}
"""

Active tennis match polls in this chat:
${activePollsDesc || '(none)'}

Known registered players in this tennis group (with their WhatsApp mention IDs and aliases):
${playerListDesc}

Task:
Determine if this message is announcing or publishing match lineups, player court assignments, teams, or rotations (including initial or updated/changed matchups for an existing poll) (e.g. "@132388105547860 @278081952608440 @169384953794573 @78636841447513 - Court 6 7.00 pm", "Court 1: Alice & Bob vs Charlie & David", "Set 1: Court 2 Mike / Sara vs John / Alex", "Alice Bob vs Charlie Dave Court 3", etc.).

Rules:
1. Map any @<digits> or @<name> mentions to the correct player display name using the known registered players list. If a mention ID is not in the list, use the short name or phone number as the player name.
2. If 4 players are listed on a court without explicit "vs" (e.g. "@P1 @P2 @P3 @P4 - Court 6 7pm"), treat them as a doubles session on that court:
   - teamA: [Player 1, Player 2]
   - teamB: [Player 3, Player 4]
3. If 2 players are listed on a court without "vs", treat them as singles: teamA: [Player 1], teamB: [Player 2].
4. If this is just casual conversation, banter, a question, or a score report (e.g. "we won", "beat", "defeated", score like "6-4 6-2"), set "isLineup": false.

Respond ONLY with a JSON object in this exact format:
{
  "isLineup": boolean,
  "type": "singles" | "doubles",
  "time": string or null,
  "players": ["Player 1", "Player 2", ...],
  "sets": [
    {
      "set": 1,
      "courts": [
        {
          "court": 6,
          "teamA": ["Player 1", "Player 2"],
          "teamB": ["Player 3", "Player 4"]
        }
      ]
    }
  ]
}
If isLineup is false, return:
{
  "isLineup": false
}`;

  try {
    const parsed = await anthropic.callAnthropicJson({
      prompt,
      maxTokens: 600
    });

    if (!parsed || !parsed.isLineup || !Array.isArray(parsed.players) || parsed.players.length < 2 || !Array.isArray(parsed.sets) || parsed.sets.length === 0) {
      return null;
    }

    const resolvePlayer = (p) => {
      const clean = String(p).replace(/^@/, '').trim();
      if (!clean) return clean;
      if (/^\d+$/.test(clean) || clean.includes('@')) {
        const resolved = nameFor(clean);
        if (resolved && resolved !== 'Player') return resolved;
      }
      const byName = namesStore.findIdByNameOrAlias(clean);
      if (byName && byName.name) return byName.name;
      return clean;
    };

    const resolvedPlayers = parsed.players.map(resolvePlayer);
    const resolvedSets = parsed.sets.map((s) => ({
      ...s,
      courts: (s.courts || []).map((c) => ({
        ...c,
        teamA: (c.teamA || []).map(resolvePlayer),
        teamB: (c.teamB || []).map(resolvePlayer)
      }))
    }));

    console.log(`[lineup-llm] Decoded lineup (${parsed.type || 'doubles'}${parsed.time ? ` at ${parsed.time}` : ''}): ${resolvedPlayers.length} player(s) [${resolvedPlayers.join(', ')}]`);
    return {
      type: parsed.type || (resolvedPlayers.length === 2 ? 'singles' : 'doubles'),
      time: parsed.time ? String(parsed.time).trim() : null,
      players: resolvedPlayers,
      sets: resolvedSets
    };
  } catch (err) {
    console.error('[lineup-llm] Failed to parse lineup with LLM:', err.message);
    return null;
  }
}

async function handleManualLineup(sock, chatId, sender, lineup, msg, rawText = '', context) {
  const { activePolls, latestPollIdByChat, persistPolls, messageStore } = context;
  const messageText = rawText || msg?.message?.conversation || msg?.message?.extendedTextMessage?.text || '';
  const mePn = sock?.user?.id || sock?.authState?.creds?.me?.id || null;

  const matchResult = findBestMatchingPollForLineup({
    activePolls,
    latestPollIdByChat,
    chatId,
    lineup,
    messageText,
    mePn,
    messageStore
  });

  const targetPollId = matchResult?.targetPollId || null;
  const targetPollState = matchResult?.targetPollState || null;

  if (targetPollState) {
    targetPollState.status = 'resolved';
    targetPollState.lastPlayers = lineup.players;
    targetPollState.lastSchedule = lineup;
    targetPollState.manualLineupPosted = true;
    targetPollState.manualLineupText = messageText;
    pairHistory.recordDraw(targetPollId, lineup, Date.now(), chatId);
    await ratings.ensureRated(lineup.players);
    if (persistPolls) persistPolls();
    console.log(`[lineup] Attributed manual lineup to poll ${targetPollId} in ${chatId} [${matchResult.matchInfo}] (${lineup.players.length} players: ${lineup.players.join(', ')})`);
  } else {
    pairHistory.recordDraw(`manual_${Date.now()}`, lineup, Date.now(), chatId);
    await ratings.ensureRated(lineup.players);
    console.log(`[lineup] Recorded standalone manual lineup in ${chatId} (${lineup.players.length} players: ${lineup.players.join(', ')})`);
  }

  if (msg?.key && sock) {
    try {
      await sock.sendMessage(chatId, {
        react: {
          text: '🤖',
          key: msg.key
        }
      });
      console.log(`[lineup] Added 🤖 reaction to lineup message in ${chatId}`);
    } catch (err) {
      console.error('[lineup] Failed to add 🤖 reaction:', err.message);
    }
  }

  return null;
}

/**
 * Executes the parse_lineup Claude tool.
 * Attributes and records manual match lineups/rotations.
 */
async function executeLineupTool(sock, name, input, sender, chatId, msg, context) {
  const { activePolls, latestPollIdByChat, messageStore } = context || {};
  const mePn = sock?.user?.id || sock?.authState?.creds?.me?.id || null;

  const rawText = input?.text || input?.message || input?.lineupText || '';
  let lineup = null;

  const resolvePlayer = (p) => {
    const clean = String(p).replace(/^@/, '').trim();
    if (!clean) return clean;
    if (/^\d+$/.test(clean) || clean.includes('@')) {
      const resolved = nameFor(clean);
      if (resolved && resolved !== 'Player') return resolved;
    }
    const byName = namesStore.findIdByNameOrAlias(clean);
    if (byName && byName.name) return byName.name;
    return clean;
  };

  // 1. If structured lineup was passed directly in input
  if (input?.lineup && Array.isArray(input.lineup.players) && Array.isArray(input.lineup.sets) && input.lineup.players.length >= 2) {
    lineup = {
      type: input.lineup.type || (input.lineup.players.length === 2 ? 'singles' : 'doubles'),
      time: input.lineup.time ? String(input.lineup.time).trim() : null,
      players: input.lineup.players.map(resolvePlayer),
      sets: input.lineup.sets.map((s) => ({
        set: s.set || 1,
        courts: (s.courts || []).map((c) => ({
          court: c.court,
          teamA: (c.teamA || []).map(resolvePlayer),
          teamB: (c.teamB || []).map(resolvePlayer)
        }))
      }))
    };
  }

  // 2. If no valid structured lineup provided, parse rawText
  if (!lineup && rawText) {
    const roster = playerCommands?.knownPlayers ? playerCommands.knownPlayers(chatId, activePolls) : [];
    lineup = parseLineup(rawText, roster);

    if (!lineup && anthropic.isAnthropicConfigured()) {
      lineup = await parseLineupWithLLM(rawText, chatId, activePolls);
    }
  }

  if (!lineup || !Array.isArray(lineup.players) || lineup.players.length < 2) {
    return 'Could not parse a valid match lineup from the provided text. Please ensure player names and court assignments (e.g. "Court 1: Player A & Player B vs Player C & Player D") are included.';
  }

  // 3. Find matching poll
  let targetPollId = input?.pollId || null;
  let targetPollState = (targetPollId && activePolls) ? activePolls.get(targetPollId) : null;

  if (!targetPollState && input?.pollName && activePolls) {
    const kw = input.pollName.toLowerCase().trim();
    for (const [id, state] of activePolls.entries()) {
      if (state.remoteJid === chatId) {
        const nameMatch = state.name && state.name.toLowerCase().includes(kw);
        const whenMatch = state.when && state.when.toLowerCase().includes(kw);
        if (nameMatch || whenMatch) {
          targetPollId = id;
          targetPollState = state;
          break;
        }
      }
    }
  }

  if (!targetPollState && activePolls) {
    const matchResult = findBestMatchingPollForLineup({
      activePolls,
      latestPollIdByChat,
      chatId,
      lineup,
      messageText: rawText,
      mePn,
      messageStore
    });
    targetPollId = matchResult?.targetPollId || null;
    targetPollState = matchResult?.targetPollState || null;
  }

  // 4. Record and handle lineup
  await handleManualLineup(sock, chatId, sender, lineup, msg, rawText, context);

  const pollDesc = targetPollState ? ` for poll "${targetPollState.name || targetPollState.when || targetPollId}"` : '';
  const totalCourts = (lineup.sets || []).reduce((sum, s) => sum + (s.courts?.length || 0), 0);
  return `Successfully parsed and recorded lineup${pollDesc}: ${lineup.players.length} players (${lineup.players.join(', ')}) across ${totalCourts || 1} court(s). Pair history and ratings updated.`;
}

async function checkCourtCancellationWithLLM(text, sender, chatId, activePolls = new Map()) {
  if (!anthropic.isAnthropicConfigured()) return null;

  const chatPolls = [...activePolls.entries()].filter(([, state]) =>
    state.remoteJid === chatId && state.status === 'active'
  );
  if (chatPolls.length === 0) return null;

  const prompt = `You are an intelligent assistant for a tennis group chat in San Jose, CA.
A group member sent this message in the chat:
Sender: "${sender}"
Message: "${text}"

Active Match Polls in this chat:
${chatPolls.map(([id, p]) => `- Poll ID: "${id}", Title: "${p.name || p.when}", Scheduled: "${p.when || p.playAt}", Status: "${p.status}", Spots: ${p.size || 'Opt-in'}`).join('\n')}

Task:
Analyze if the sender is announcing or stating that a tennis court (or court session/reservation) is being cancelled or released (e.g. "Cancelled the court", "Cancelling 2nd court due to lack of players", "Cancelled the 8:30am court since we only have 2", "I am cancelling the court because we don't have 4", "Releasing court because poll didn't fill", etc.).
Note: If they are simply asking a question, talking about general court availability, cancelling their own individual participation (e.g. "I have to cancel today"), or chatting about unrelated topics, set isCourtCancelledDueToLackOfVotes to false.

Respond ONLY with a JSON object in this exact format, with no extra text or markdown:
{
  "isCourtCancelled": boolean,
  "pollId": string or null,
  "reason": string
}`;

  try {
    return await anthropic.callAnthropicJson({
      prompt,
      maxTokens: 250
    });
  } catch (err) {
    console.error('[court-cancel-llm] Failed to check court cancellation with LLM:', err.message);
    return null;
  }
}

module.exports = {
  isSamePlayerName,
  extractTimeFromLineupMessage,
  getPollMatchTime,
  getPollPlayerNames,
  findBestMatchingPollForLineup,
  parseLineupWithLLM,
  handleManualLineup,
  checkCourtCancellationWithLLM,
  executeLineupTool,
  LINEUP_PARSER_TOOL
};
