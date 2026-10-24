/**
 * Player, Rating, Alias, Availability, and Score Commands
 * Handles:
 *   - Player ratings (!myrating, !setrating, !resetrating, !ratings, !refreshratings)
 *   - TennisRecord cert management (!certstatus, !suspendcert, !resumecert)
 *   - Full name management (!fullname, !setfullname)
 *   - Player aliases (!aliases, !alias, !deletealias)
 *   - Availability (!free, !notfree, !clearfree)
 *   - Match scores & leaderboard (!score, !leaderboard, free-form score reports)
 */

const { jidNormalizedUser } = require('@whiskeysockets/baileys');
const stats = require('../stats');
const ratings = require('../ratings');
const namesStore = require('../names');
const tennisRecord = require('../tennisRecord');
const { parseScoreReport } = require('../scoreReport');
const { findMatchupFor } = require('../matchups');
const { isUserAdmin } = require('./groupCommands');

const TRIGGER_PREFIX = '@tenbot';
const GENERIC_NAMES = new Set(['someone', 'player', 'player 1', 'player 2', 'player 3', 'player 4', 'me']);
const SELF_WORDS = new Set(['i', 'me', 'myself', 'we', 'us', 'my team', 'our team']);

const recentFreeformScores = new Map();
const FREEFORM_DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

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

function parseSide(side) {
  return side
    .split(/\s*(?:&|\+|\band\b)\s*/i)
    .map((name) => name.trim())
    .filter(Boolean);
}

const formatSide = (names) => names.join(' & ');
const formatSets = (sets) => sets.map(([a, b]) => `${a}-${b}`).join(' ');

/**
 * Checks if a user has permission to set/add an alias for a given target player.
 */
async function canUserManagePlayerAlias(sock, chatId, senderJid, senderName, targetPlayer) {
  if (!targetPlayer) return false;
  const tKey = ratings.keyFor(targetPlayer);
  if (['me', 'myself', 'my', 'i'].includes(tKey)) return true;

  if (senderName && ratings.keyFor(senderName) === tKey) return true;

  if (senderJid) {
    const senderCanonical = nameFor(senderJid);
    if (senderCanonical && ratings.keyFor(senderCanonical) === tKey) return true;

    const match = namesStore.findIdByNameOrAlias(targetPlayer, chatId);
    if (match) {
      const normSender = jidNormalizedUser(senderJid);
      const pn = namesStore.getPnByLid(normSender) || (normSender?.endsWith('@s.whatsapp.net') ? normSender : null);
      const lid = namesStore.resolveCanonicalId(normSender) || (normSender?.endsWith('@lid') ? normSender : null);

      if (match.id === normSender || match.id === pn || match.id === lid) return true;
      if (match.entry?.name && ratings.keyFor(match.entry.name) === ratings.keyFor(senderName)) return true;
    }
  }

  return await isUserAdmin(sock, chatId, senderJid);
}

// --- Ratings Handlers ---

async function handleSetRating(sock, chatId, senderJid, senderName, playerName, ratingVal) {
  if (typeof ratingVal !== 'number' || Number.isNaN(ratingVal) || ratingVal < ratings.MIN_RATING || ratingVal > ratings.MAX_RATING) {
    return `Please provide a valid rating between ${ratings.MIN_RATING} and ${ratings.MAX_RATING}, e.g. "!setrating 3.5" or "${TRIGGER_PREFIX} set my rating to 4.0".`;
  }

  const targetPlayer = playerName || senderName || (senderJid ? nameFor(senderJid) : 'me');
  const canManage = await canUserManagePlayerAlias(sock, chatId, senderJid, senderName, targetPlayer);
  if (!canManage) {
    return '⚠️ Only group admins can update ratings for other players. You can set your own rating.';
  }

  let targetJid = null;
  const tKey = ratings.keyFor(targetPlayer);
  const isSelf = ['me', 'myself', 'my', 'i'].includes(tKey) ||
    (senderName && ratings.keyFor(senderName) === tKey) ||
    (senderJid && ratings.keyFor(nameFor(senderJid)) === tKey);

  let resolvedPlayerName = targetPlayer;
  if (isSelf) {
    targetJid = senderJid || null;
    resolvedPlayerName = senderName !== 'Someone' ? senderName : (senderJid ? nameFor(senderJid) : 'Player');
  } else {
    const match = namesStore.findIdByNameOrAlias(targetPlayer, chatId);
    if (match) {
      targetJid = match.id || null;
      resolvedPlayerName = match.entry?.name || targetPlayer;
    }
  }

  const updated = ratings.setRating(resolvedPlayerName, ratingVal, { jid: targetJid });
  return `Updated rating for ${resolvedPlayerName} to ${ratings.formatRating(updated)}.`;
}

async function handleResetRating(sock, chatId, senderJid, senderName, playerName) {
  const targetPlayer = playerName || senderName || (senderJid ? nameFor(senderJid) : 'me');
  const canManage = await canUserManagePlayerAlias(sock, chatId, senderJid, senderName, targetPlayer);
  if (!canManage) {
    return '⚠️ Only group admins can reset ratings for other players. You can reset your own rating.';
  }

  let targetJid = null;
  const tKey = ratings.keyFor(targetPlayer);
  const isSelf = ['me', 'myself', 'my', 'i'].includes(tKey) ||
    (senderName && ratings.keyFor(senderName) === tKey) ||
    (senderJid && ratings.keyFor(nameFor(senderJid)) === tKey);

  let resolvedPlayerName = targetPlayer;
  if (isSelf) {
    targetJid = senderJid || null;
    resolvedPlayerName = senderName !== 'Someone' ? senderName : (senderJid ? nameFor(senderJid) : 'Player');
  } else {
    const match = namesStore.findIdByNameOrAlias(targetPlayer, chatId);
    if (match) {
      targetJid = match.id || null;
      resolvedPlayerName = match.entry?.name || targetPlayer;
    }
  }

  const res = await ratings.resetRating(resolvedPlayerName, { jid: targetJid, sock });
  if (!res) {
    return `Could not reset rating for "${resolvedPlayerName}".`;
  }

  if (res.tennisRecord === false) {
    return `🔄 Reset rating for "${res.name}" to default ${ratings.formatRating(res.rating)} (TennisRecord profile not verified; automatic updates paused).`;
  }

  const locStr = res.tennisRecordLocation ? ` (${res.tennisRecordLocation})` : '';
  const urlStr = res.tennisRecordUrl ? ` -> ${res.tennisRecordUrl}` : '';
  return `🔄 Reset rating for "${res.name}" to baseline ${ratings.formatRating(res.rating)}${locStr}${urlStr}.`;
}

function parseSetRatingCommand(text, defaultSenderName = null) {
  const raw = text.replace(/^!(?:myrating|setrating)\s*/i, '').trim();
  if (!raw) return null;

  const forMatch = raw.match(/^for\s+(.+?)\s*(?:=|\bto\b|:)?\s*(\d+(?:\.\d+)?)$/i) ||
                   raw.match(/^(.+?)\s+\bfor\b\s+(\d+(?:\.\d+)?)$/i);
  if (forMatch) {
    return { name: forMatch[1].trim(), rating: parseFloat(forMatch[2]) };
  }

  const delimMatch = raw.match(/^(.+?)\s*(?:=|:|->|\bto\b|\bas\b)\s*(\d+(?:\.\d+)?)$/i);
  if (delimMatch) {
    return { name: delimMatch[1].trim(), rating: parseFloat(delimMatch[2]) };
  }

  const spaceMatch = raw.match(/^(.+?)\s+(\d+(?:\.\d+)?)$/);
  if (spaceMatch && Number.isNaN(parseFloat(spaceMatch[1]))) {
    return { name: spaceMatch[1].trim(), rating: parseFloat(spaceMatch[2]) };
  }

  const num = parseFloat(raw);
  if (!Number.isNaN(num)) {
    return { name: defaultSenderName || 'me', rating: num };
  }

  return null;
}

function formatRatings(chatId = null) {
  const board = ratings.getAllRatings();
  if (board.length === 0) {
    return `Nobody's rated yet -- everyone starts from their TennisRecord rating (or ${ratings.formatRating(ratings.INITIAL_RATING)}) once they play a poll or set their rating.`;
  }
  const groupMembers = chatId ? namesStore.getGroupMembers(chatId) : null;
  const filteredBoard = groupMembers
    ? board.filter((p) => {
        const idNorm = (p.id || '').toLowerCase();
        const numOnly = idNorm.split('@')[0];
        const pnNorm = (p.pn || '').toLowerCase();
        const pnNum = pnNorm.split('@')[0];
        const nameKey = ratings.keyFor(p.name);
        return (
          groupMembers.has(idNorm) ||
          (numOnly && groupMembers.has(numOnly)) ||
          (pnNorm && groupMembers.has(pnNorm)) ||
          (pnNum && groupMembers.has(pnNum)) ||
          groupMembers.has(nameKey)
        );
      })
    : board;

  if (filteredBoard.length === 0) {
    return `Nobody in this group has a recorded rating yet -- players start from their TennisRecord rating (or ${ratings.formatRating(ratings.INITIAL_RATING)}) once they vote in a match poll or set their rating.`;
  }

  const lines = filteredBoard.map((p, i) => `${i + 1}. ${p.name} — ${ratings.formatRating(p.rating)}`);
  return `📊 Player ratings (${ratings.formatRating(ratings.MIN_RATING)}–${ratings.MAX_RATING}):\n${lines.join('\n')}`;
}

// --- Full Name Handlers ---

async function handleSetFullName(sock, chatId, senderJid, senderName, playerName, fullName) {
  const cleanFull = typeof fullName === 'string' ? fullName.trim() : '';
  if (!cleanFull) return 'Please provide a valid full name.';

  const targetPlayer = playerName || senderName || (senderJid ? nameFor(senderJid) : 'me');
  const canManage = await canUserManagePlayerAlias(sock, chatId, senderJid, senderName, targetPlayer);
  if (!canManage) {
    return '⚠️ Only group admins can update the full name for other players. You can set your own full name.';
  }

  let targetId = null;
  const match = namesStore.findIdByNameOrAlias(targetPlayer, chatId);
  if (match) {
    targetId = match.id;
  } else if (senderJid) {
    targetId = namesStore.resolveCanonicalId(jidNormalizedUser(senderJid));
  } else {
    targetId = targetPlayer;
  }

  const updatedEntry = namesStore.setFullName(targetId, cleanFull);
  const resolvedDisplayName = updatedEntry?.name || targetPlayer;

  const trResult = await ratings.updateRatingFromFullName(targetId, cleanFull, { jid: senderJid, sock });
  let ratingNote = '';
  if (trResult) {
    if (trResult.tennisRecord === false) {
      ratingNote = ` ⚠️ TennisRecord profile not found or ambiguous in San Jose/nearby area. Rating set to default ${ratings.formatRating(ratings.INITIAL_RATING)}. Superadmin alerted.`;
    } else {
      const locStr = trResult.tennisRecordLocation ? ` (${trResult.tennisRecordLocation})` : '';
      const urlStr = trResult.tennisRecordUrl ? ` -> ${trResult.tennisRecordUrl}` : '';
      ratingNote = ` Initial rating from TennisRecord set to ${ratings.formatRating(trResult.rating)}${locStr}${urlStr}.`;
    }
  }

  return `✅ Updated full name for "${resolvedDisplayName}" to "${cleanFull}".${ratingNote}`;
}

function parseFullNameCommand(text, defaultSenderName = null) {
  const raw = text.replace(/^!(?:setfullname|fullname)\s*/i, '').trim();
  if (!raw) return null;

  if (/\bfor\b/i.test(raw)) {
    const forMatch = raw.match(/^(.+?)\s+\bfor\b\s+(.+)$/i);
    if (forMatch) {
      return { name: forMatch[2].trim(), fullName: forMatch[1].trim() };
    }
  }

  const delimMatch = raw.match(/^(.+?)\s*(?:=|:|->|\bas\b|\bto\b)\s*(.+)$/i);
  if (delimMatch) {
    return { name: delimMatch[1].trim(), fullName: delimMatch[2].trim() };
  }

  return { name: defaultSenderName || 'me', fullName: raw };
}

// --- Alias Handlers ---

function parseAliasCommand(text, defaultSenderName = null) {
  const raw = text.replace(/^!(?:alias|addalias)\s*/i, '').trim();
  if (!raw) return null;

  if (/\bfor\b/i.test(raw)) {
    const forMatch = raw.match(/^(.+?)\s+\bfor\b\s+(.+)$/i);
    if (forMatch) {
      return { name: forMatch[2].trim(), alias: forMatch[1].trim() };
    }
  }

  const delimMatch = raw.match(/^(.+?)\s*(?:=|:|->|\bas\b|\bto\b)\s*(.+)$/i);
  if (delimMatch) {
    return { name: delimMatch[1].trim(), alias: delimMatch[2].trim() };
  }

  const singleQuoteMatch = raw.match(/^"([^"]+)"$/);
  if (singleQuoteMatch) {
    return { name: defaultSenderName || 'me', alias: singleQuoteMatch[1].trim() };
  }

  const quoteMatch = raw.match(/^"([^"]+)"\s+(.+)$/) || raw.match(/^(.+?)\s+"([^"]+)"$/);
  if (quoteMatch) {
    return { name: quoteMatch[1].trim(), alias: quoteMatch[2].trim() };
  }

  const spaceParts = raw.split(/\s+/);
  if (spaceParts.length >= 2) {
    const alias = spaceParts.pop();
    const name = spaceParts.join(' ');
    return { name, alias };
  }

  if (spaceParts.length === 1 && spaceParts[0]) {
    return { name: defaultSenderName || 'me', alias: spaceParts[0] };
  }

  return null;
}

function formatAliases() {
  const entries = namesStore.getAllEntries();
  if (entries.length === 0) {
    return 'No player aliases recorded yet. Use "!alias <name> = <alias>" to add one.';
  }
  const lines = entries.map((e) => {
    const aliasStr = e.aliases && e.aliases.length > 0 ? ` (aliases: ${e.aliases.join(', ')})` : ' (no aliases)';
    return `• ${e.name}${aliasStr}`;
  });
  return `📋 Player Names & Aliases:\n${lines.join('\n')}`;
}

// --- Availability Handlers ---

function formatAvailability() {
  const list = stats.getAvailability();
  if (list.length === 0) {
    return 'No one has marked themselves free yet. Use "!free <when>" to add yourself.';
  }
  const lines = list.map((a) => `• ${a.player} – ${a.when}`);
  return `Who's free:\n${lines.join('\n')}`;
}

// --- Leaderboard & Scores ---

function formatLeaderboard() {
  const board = stats.getLeaderboard();
  if (board.length === 0) {
    return 'No matches recorded yet. Use "!score <winner> def <loser> <score>" to log one.';
  }
  const lines = board.map(
    (p, i) => `${i + 1}. ${p.name} — ${p.wins}W ${p.losses}L`
  );
  return `🏆 Leaderboard:\n${lines.join('\n')}`;
}

function applyScoreReport({ winners, losers, sets, assumedScore = false, inferredOpponents = false }) {
  const winnerText = formatSide(winners);
  const loserText = formatSide(losers);
  const scoreText = formatSets(sets);

  stats.recordMatch(winnerText, loserText, scoreText);
  const { sets: rated, changes } = ratings.applyResult(winners, losers, sets);

  const lines = [`Recorded: ${winnerText} def ${loserText} (${scoreText}).`];

  const notes = [];
  if (assumedScore) notes.push(`no score given, so I assumed ${scoreText}`);
  if (inferredOpponents) notes.push("opponents from today's draw");
  if (notes.length > 0) lines.push(`(${notes.join('; ')})`);

  const upsets = rated.filter((s) => s.upset).length;
  if (upsets > 0) {
    lines.push(`${upsets === rated.length ? 'Upset' : `${upsets} upset set(s)`} -- the lower-rated pairing came through.`);
  }

  lines.push(...changes.map((c) => {
    const move = c.to === c.from ? 'no change' : `${c.to > c.from ? '▲' : '▼'} ${ratings.formatRating(Math.abs(c.to - c.from))}`;
    return `  ${c.name}: ${ratings.formatRating(c.from)} → ${ratings.formatRating(c.to)} (${move})`;
  }));
  lines.push('Check "!leaderboard" for standings, "!ratings" for ratings.');

  return lines.join('\n');
}

function handleScoreCommand(text) {
  const match = text.match(/^!score\s+(.+?)\s+def\s+(.+?)\s+((?:\d+\s*-\s*\d+[\s,]*)+)$/i);
  if (!match) {
    return 'Couldn\'t parse that. Use: !score <winner> def <loser> <score>\ne.g. "!score Mike def John 6-4 6-2" or "!score Mike & Sara def John & Alex 6-4 6-2"';
  }

  const [, winner, loser, score] = match;
  let winners = parseSide(winner);
  let losers = parseSide(loser);
  const sets = score.trim().split(/[\s,]+/).map((s) => s.split('-').map(Number));

  if (winners.length !== losers.length) {
    return `Both sides need the same number of players -- got ${winners.length} vs ${losers.length}.`;
  }

  const resolveCanonical = (n) => {
    const match = namesStore.findIdByNameOrAlias(n);
    return (match && match.entry?.name) ? match.entry.name : n;
  };
  winners = winners.map(resolveCanonical);
  losers = losers.map(resolveCanonical);

  return applyScoreReport({ winners, losers, sets });
}

function knownPlayers(chatId, activePolls = new Map()) {
  const byKey = new Map();
  const add = (name, canonicalName = null) => {
    const key = ratings.keyFor(name);
    const resolved = canonicalName ? String(canonicalName).trim() : String(name).trim();
    if (key && !byKey.has(key)) byKey.set(key, resolved);
  };

  for (const entry of namesStore.getAllEntries()) {
    if (entry.name) add(entry.name, entry.name);
    if (entry.fullName) add(entry.fullName, entry.name);
    for (const alias of entry.aliases || []) {
      add(alias, entry.name);
    }
  }
  for (const p of ratings.getAllRatings()) add(p.name, p.name);
  for (const p of stats.getLeaderboard()) add(p.name, p.name);
  for (const a of stats.getAvailability()) add(a.player, a.player);

  for (const [, pollState] of activePolls.entries()) {
    if (pollState.remoteJid === chatId) {
      if (pollState.creator?.name) add(pollState.creator.name);
      for (const name of pollState.lastPlayers || []) add(name);
      if (pollState.voteBuffer && pollState.voteBuffer instanceof Map) {
        for (const voterJid of pollState.voteBuffer.keys()) add(nameFor(voterJid));
      }
    }
  }

  return byKey;
}

function handleFreeformScore(candidates, chatId, sender, activePolls = new Map(), lastSchedule = null) {
  const roster = knownPlayers(chatId, activePolls);
  const self = roster.get(ratings.keyFor(sender)) || null;

  const options = {
    resolveName: (raw) => {
      const key = ratings.keyFor(raw);
      if (SELF_WORDS.has(key)) return self;
      return roster.get(key) || null;
    },
    findMatchup: (names, versus) => findMatchupFor(lastSchedule, names, versus)
  };

  let report = null;
  for (const candidate of new Set(candidates.filter(Boolean))) {
    report = parseScoreReport(candidate, options);
    if (report) break;
  }

  if (!report) return null;

  const signature = [
    formatSide(report.winners),
    formatSide(report.losers),
    formatSets(report.sets)
  ].join('|').toLowerCase();

  const previous = recentFreeformScores.get(chatId);
  if (previous?.signature === signature && Date.now() - previous.at < FREEFORM_DUPLICATE_WINDOW_MS) {
    console.log(`[score] Ignoring repeat free-form result: ${signature}`);
    return null;
  }
  recentFreeformScores.set(chatId, { signature, at: Date.now() });

  console.log(
    `[score] Free-form result understood: ${formatSide(report.winners)} def ` +
    `${formatSide(report.losers)} (${formatSets(report.sets)})` +
    `${report.assumedScore ? ' [assumed score]' : ''}${report.inferredOpponents ? ' [inferred opponents]' : ''}`
  );

  return applyScoreReport(report);
}

/**
 * Handles text commands for player ratings, aliases, full names, availability, and score reports.
 */
async function handlePlayerCommand(sock, text, chatId, sender, senderJid, msg, activePolls = new Map()) {
  const lower = text.toLowerCase();

  // Availability
  if (lower.startsWith('!free')) {
    const when = text.slice('!free'.length).trim();
    if (!when) return formatAvailability();
    stats.setAvailable(sender, when);
    return `Got it, ${sender} is free ${when}. Send "!free" to see the full list.`;
  }

  if (lower === '!notfree') {
    stats.removeAvailable(sender);
    return `Removed ${sender} from the availability list.`;
  }

  if (lower === '!clearfree') {
    const isAdmin = await isUserAdmin(sock, chatId, senderJid);
    if (!isAdmin) {
      return '⚠️ Only group admins can use !clearfree.';
    }
    stats.clearAvailability();
    return 'Availability list cleared for everyone.';
  }

  // Aliases
  if (lower === '!aliases' || lower === '!alias list') {
    return formatAliases();
  }

  if (lower.startsWith('!alias') || lower.startsWith('!addalias')) {
    const senderDisplayName = sender !== 'Someone' ? sender : (senderJid ? nameFor(senderJid) : 'me');
    const parsed = parseAliasCommand(text, senderDisplayName);
    if (!parsed || !parsed.name || !parsed.alias) {
      return 'Couldn\'t parse that. Use: "!alias <alias>" (for yourself) or "!alias <player name> = <alias>"\ne.g. "!alias PK" or "!alias Jonathan Doe = JD"';
    }
    const canManage = await canUserManagePlayerAlias(sock, chatId, senderJid, sender, parsed.name);
    if (!canManage) {
      return '⚠️ Only group admins can add aliases for other players. You can add aliases for yourself (e.g. "!alias <your alias>").';
    }
    const res = namesStore.addAliasForPlayer(parsed.name, parsed.alias, senderJid, chatId);
    if (res) {
      return `✅ Added alias "${parsed.alias}" for player "${res.name}". Current aliases: [${res.aliases.join(', ')}].`;
    } else {
      return `Could not add alias for "${parsed.name}".`;
    }
  }

  if (/^!(?:deletealias|delalias|removealias|rmalias)\b/i.test(lower)) {
    const parsed = parseAliasCommand(text) || { name: null, alias: text.replace(/^!(?:deletealias|delalias|removealias|rmalias)\s*/i, '').trim() };
    if (!parsed || (!parsed.name && !parsed.alias)) {
      return 'Use: !deletealias <player name> = <alias> or !deletealias <alias>\ne.g. "!deletealias Jonathan Doe = JD" or "!deletealias JD"';
    }
    const targetAlias = parsed.alias || parsed.name;
    const targetPlayer = parsed.alias ? parsed.name : null;

    let resolvedPlayer = targetPlayer;
    if (!resolvedPlayer) {
      const match = namesStore.findIdByNameOrAlias(targetAlias, chatId);
      if (match) resolvedPlayer = match.entry?.name;
    }

    const canManage = await canUserManagePlayerAlias(sock, chatId, senderJid, sender, resolvedPlayer || targetAlias);
    if (!canManage) {
      return '⚠️ Only group admins can delete aliases for other players. You can delete aliases for yourself (e.g. "!deletealias <your alias>").';
    }

    const res = namesStore.removeAliasForPlayer(targetPlayer, targetAlias, chatId);
    if (res) {
      return `✅ Removed alias "${res.removed}" from player "${res.name}". Current aliases: [${res.aliases.join(', ')}].`;
    } else {
      return `Alias "${targetAlias}" was not found.`;
    }
  }

  // Full Name
  if (lower.startsWith('!setfullname') || lower.startsWith('!fullname')) {
    const senderDisplayName = sender !== 'Someone' ? sender : (senderJid ? nameFor(senderJid) : 'me');
    const parsed = parseFullNameCommand(text, senderDisplayName);
    if (!parsed || !parsed.fullName) {
      return 'Please provide a full name. Use: "!fullname <full name>" or "!setfullname <player name> = <full name>"\ne.g. "!fullname Roger Federer" or "!setfullname John = Johnathan Smith"';
    }
    return await handleSetFullName(sock, chatId, senderJid, sender, parsed.name, parsed.fullName);
  }

  // Scores & Leaderboard
  if (lower.startsWith('!score')) {
    return handleScoreCommand(text);
  }

  if (lower === '!leaderboard') {
    return formatLeaderboard();
  }

  // Ratings
  if (lower.startsWith('!myrating') || lower.startsWith('!setrating')) {
    const parsed = parseSetRatingCommand(text, sender);
    if (!parsed) {
      return `Please provide a valid rating between ${ratings.MIN_RATING} and ${ratings.MAX_RATING}, e.g. "!setrating 3.5" or "${TRIGGER_PREFIX} set my rating to 4.0".`;
    }
    return await handleSetRating(sock, chatId, senderJid, sender, parsed.name, parsed.rating);
  }

  if (lower.startsWith('!resetrating') || lower.startsWith('!ratingreset')) {
    const raw = text.replace(/^!(?:resetrating|ratingreset)\s*/i, '').trim();
    return await handleResetRating(sock, chatId, senderJid, sender, raw || null);
  }

  if (lower === '!ratings') {
    return formatRatings(chatId);
  }

  // TennisRecord Certificate Check Management
  if (lower === '!suspendcert' || lower === '!suspendcertcheck' || lower === '!certcheck suspend' || lower === '!certcheck off') {
    const isAdmin = await isUserAdmin(sock, chatId, senderJid);
    if (!isAdmin) {
      return '⚠️ Only group admins can change SSL certificate verification settings.';
    }
    tennisRecord.suspendCertCheck();
    return '🔓 TennisRecord SSL certificate validation suspended. Lookups will proceed even if certificates are expired or invalid.';
  }

  if (lower === '!resumecert' || lower === '!resumecertcheck' || lower === '!certcheck resume' || lower === '!certcheck on') {
    const isAdmin = await isUserAdmin(sock, chatId, senderJid);
    if (!isAdmin) {
      return '⚠️ Only group admins can change SSL certificate verification settings.';
    }
    tennisRecord.resumeCertCheck();
    return '🔒 TennisRecord SSL certificate validation resumed (strict verification enabled).';
  }

  if (lower === '!certstatus' || lower === '!certcheck' || lower === '!sslstatus') {
    const isSuspended = tennisRecord.getCertCheckSuspended();
    return `🔒 TennisRecord SSL certificate check status: ${isSuspended ? 'SUSPENDED (insecure / expired certs allowed)' : 'ACTIVE (strict verification enabled)'}.`;
  }

  if (lower === '!refreshratings') {
    const isAdmin = await isUserAdmin(sock, chatId, senderJid);
    if (!isAdmin) {
      return '⚠️ Only group admins can use !refreshratings.';
    }
    const { checkedCount, updatedCount } = await ratings.refreshPeriodicRatings({ force: true });
    return `Checked ${checkedCount} player(s) on TennisRecord.com: updated ${updatedCount} rating(s).`;
  }

  return null;
}

/**
 * Handles LLM tool calls for player profile and rating management.
 */
async function executePlayerTool(sock, name, input, sender, senderJid, chatId) {
  if (name === 'add_alias') {
    const { player, alias } = input;
    if (!player || !alias) return 'Please provide both player name and alias.';
    const canManage = await canUserManagePlayerAlias(sock, chatId, senderJid, sender, player);
    if (!canManage) {
      return '⚠️ Only group admins can add aliases for other players. You can add aliases for yourself.';
    }
    const res = namesStore.addAliasForPlayer(player, alias, null, chatId);
    if (res) {
      return `Added alias "${alias}" for player "${res.name}". Current aliases: [${res.aliases.join(', ')}].`;
    }
    return `Could not add alias for "${player}".`;
  }

  if (name === 'remove_alias') {
    const { player, alias } = input;
    const targetAlias = alias || player;
    const targetPlayer = alias ? player : null;
    if (!targetAlias) return 'Please provide the alias to remove.';

    let resolvedPlayer = targetPlayer;
    if (!resolvedPlayer) {
      const match = namesStore.findIdByNameOrAlias(targetAlias, chatId);
      if (match) resolvedPlayer = match.entry?.name;
    }

    const canManage = await canUserManagePlayerAlias(sock, chatId, senderJid, sender, resolvedPlayer || targetAlias);
    if (!canManage) {
      return '⚠️ Only group admins can delete aliases for other players. You can delete aliases for yourself.';
    }

    const res = namesStore.removeAliasForPlayer(targetPlayer, targetAlias, chatId);
    if (res) {
      return `Removed alias "${res.removed}" from player "${res.name}". Current aliases: [${res.aliases.join(', ')}].`;
    }
    return `Alias "${targetAlias}" was not found.`;
  }

  if (name === 'set_full_name') {
    const { fullName, player } = input;
    return await handleSetFullName(sock, chatId, senderJid, sender, player, fullName);
  }

  if (name === 'set_rating') {
    const newRating = input.rating;
    return await handleSetRating(sock, chatId, senderJid, sender, input.player || null, newRating);
  }

  if (name === 'reset_rating') {
    return await handleResetRating(sock, chatId, senderJid, sender, input.player || null);
  }

  return `Unknown player tool ${name}`;
}

module.exports = {
  formatAvailability,
  formatAliases,
  parseAliasCommand,
  canUserManagePlayerAlias,
  parseFullNameCommand,
  handleSetFullName,
  formatRatings,
  parseSetRatingCommand,
  handleSetRating,
  handleResetRating,
  formatLeaderboard,
  parseSide,
  applyScoreReport,
  handleScoreCommand,
  knownPlayers,
  handleFreeformScore,
  handlePlayerCommand,
  executePlayerTool,
  nameFor
};
