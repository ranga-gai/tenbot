/**
 * Lineup parser: detects and extracts manually published court lineups and rotations.
 *
 * Supports patterns like:
 *   Court 1: Mike & Sara vs John & Alex
 *   Court 2: Bob & David vs Alice & Eve
 *
 *   Court 6 - Mike - Sara vs John - Alex Court 1 - Bob - David vs Alice - Eve
 *
 *   C1: Alice / Bob vs Charlie / David
 *   C2: Eve / Frank vs Grace / Heidi
 *
 *   Set 1:
 *   Court 1: Mike & Sara vs John & Alex
 *   SECOND SET -
 *   Court 1: Mike & Bob vs Sara & David
 */

const STOP_WORDS = new Set([
  'you', 'your', 'yours', 'me', 'my', 'mine', 'we', 'our', 'ours', 'us',
  'something', 'someone', 'anything', 'anyone', 'nothing', 'typing', 'answers',
  'tells', 'tell', 'need', 'clean', 'model', 'versus', 'versus.', 'with', 'from',
  'this', 'that', 'these', 'those', 'what', 'why', 'how', 'when', 'where',
  'have', 'has', 'had', 'been', 'being', 'will', 'would', 'could', 'should',
  'come', 'know', 'think', 'feel', 'look', 'looks', 'sure', 'true', 'false'
]);

const WORD_NUMBERS = {
  first: 1, '1st': 1, one: 1, '1': 1,
  second: 2, '2nd': 2, two: 2, '2': 2,
  third: 3, '3rd': 3, three: 3, '3': 3,
  fourth: 4, '4th': 4, four: 4, '4': 4,
  fifth: 5, '5th': 5, five: 5, '5': 5,
  sixth: 6, '6th': 6, six: 6, '6': 6,
  seventh: 7, '7th': 7, seven: 7, '7': 7,
  eighth: 8, '8th': 8, eight: 8, '8': 8
};

function extractSetNumber(line) {
  if (!line || typeof line !== 'string') return null;
  const clean = line.trim();

  // 1. "Second Set -", "2nd set", "1st round", "First rotation"
  const prefixMatch = clean.match(/^(first|second|third|fourth|fifth|sixth|seventh|eighth|1st|2nd|3rd|4th|5th|6th|7th|8th|\d+)\s+(?:set|round|rotation)[.:\-–—\s]*$/i);
  if (prefixMatch) {
    const raw = prefixMatch[1].toLowerCase();
    return WORD_NUMBERS[raw] || parseInt(raw, 10) || null;
  }

  // 2. "Set 2 -", "Set: 2", "Set #2", "Set two", "Set 2nd", "Round 2", "Rotation 3"
  const postfixMatch = clean.match(/^(?:set|round|rotation)\s*(?:#|no\.?|num\.?)?\s*(first|second|third|fourth|fifth|sixth|seventh|eighth|1st|2nd|3rd|4th|5th|6th|7th|8th|one|two|three|four|five|six|seven|eight|\d+)[.:\-–—\s]*$/i);
  if (postfixMatch) {
    const raw = postfixMatch[1].toLowerCase();
    return WORD_NUMBERS[raw] || parseInt(raw, 10) || null;
  }

  return null;
}

function isValidPlayerNameToken(token, roster = new Map()) {
  if (!token || typeof token !== 'string') return false;
  const clean = token.trim();
  if (!clean || clean.length > 30) return false;

  // Reject full sentences with punctuation
  if (/[!?\r\n]/.test(clean)) return false;
  if (/\.\s+\w/.test(clean)) return false; // period followed by text (sentence end)

  // If known in roster, it is valid
  if (roster.has(clean.toLowerCase())) return true;

  const words = clean.split(/\s+/);
  if (words.length > 3) return false; // Name should not be more than 3 words

  // Check if any word is an obvious conversational stop-word
  for (const w of words) {
    const norm = w.toLowerCase().replace(/[^a-z]/g, '');
    if (STOP_WORDS.has(norm)) return false;
  }

  return true;
}

function parseLineup(text, roster = new Map()) {
  if (!text || typeof text !== 'string') return null;

  // Reject messages that are score reports or result summaries
  if (/\b(?:def|defeated|beat|beats|beaten|won|lost|score|scores)\b/i.test(text)) return null;
  if (/\b\d+-\d+\b/.test(text) && !/\bcourt|\bct\b|\bvs\b/i.test(text)) return null;

  // Must contain vs / v / versus
  if (!/\b(?:vs\.?|v\.?|versus)\b/i.test(text)) return null;

  // Normalize text: if multiple courts are concatenated on a single line, insert newlines before "Court X" / "Ct X" / "C<N>" that have a subsequent "vs"
  let normalized = text.replace(/([^\n\r])\s+(?=(?:(?:court|ct|match)\s*\d+|c\s*\d+)[^]*?\b(?:vs\.?|v\.?|versus)\b)/gi, '$1\n');

  const rawLines = normalized.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const sets = [];
  let currentSetNumber = 1;
  let currentCourts = [];
  let courtCounter = 1;

  const courtPrefixRegex = /^(?:(?:court|ct|match)\s*(\d+)?|c\s*(\\d+))[.:\-)]?\s*/i;

  for (const line of rawLines) {
    const setNum = extractSetNumber(line);
    if (setNum) {
      if (currentCourts.length > 0) {
        sets.push({ set: currentSetNumber, courts: currentCourts });
        currentCourts = [];
        courtCounter = 1;
      }
      currentSetNumber = setNum;
      continue;
    }

    // Check if line has vs / v / versus
    const vsSplit = line.split(/\s+\b(?:vs\.?|v\.?|versus)\b\s+/i);
    if (vsSplit.length !== 2) continue;

    let [sideA, sideB] = vsSplit;

    // Extract court number from sideA if present
    let explicitCourtNum = null;
    const cpMatch = sideA.match(courtPrefixRegex);
    if (cpMatch) {
      explicitCourtNum = cpMatch[1] || cpMatch[2] || null;
      sideA = sideA.slice(cpMatch[0].length).replace(/^-\s*/, '').trim();
    } else {
      const leadingNumMatch = sideA.match(/^(\d+)[.:\-)]\s*/);
      if (leadingNumMatch) {
        explicitCourtNum = leadingNumMatch[1];
        sideA = sideA.slice(leadingNumMatch[0].length).replace(/^-\s*/, '').trim();
      }
    }

    // Clean any leading court/team label from sideB as well
    const cpMatchB = sideB.match(courtPrefixRegex);
    if (cpMatchB) {
      sideB = sideB.slice(cpMatchB[0].length).replace(/^-\s*/, '').trim();
    }

    // Extract trailing court number and match time from sideB (e.g. "- Court 2 7 pm", "(Court 2, 7pm)", "- Court 3")
    const trailingCourtMatch = sideB.match(/(?:[-:,/(]|\s)\s*(?:(?:court|ct|match)\s*(\d+)|c\s*(\d+))\b.*$/i);
    if (trailingCourtMatch) {
      if (!explicitCourtNum) {
        explicitCourtNum = trailingCourtMatch[1] || trailingCourtMatch[2] || null;
      }
      sideB = sideB.slice(0, trailingCourtMatch.index).trim();
    } else {
      // Also strip generic trailing time if present (e.g. "- 7 pm", "- 7:30pm")
      sideB = sideB.replace(/(?:[-:,/(]|\s)\s*\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b.*$/i, "").trim();
    }

    const resolveSide = (raw) => {
      // Split on &, +, and, /, comma, or dash (-) with surrounding spaces or between words
      let tokens = raw.split(/\s*(?:&|\+|\band\b|\/|,|\s+-\s*|\s*-\s+)\s*/i).map((n) => n.trim()).filter(Boolean);
      if (tokens.length === 1 && tokens[0].includes('-')) {
        // Handle "Alice-Bob" without spaces
        const sub = tokens[0].split(/\s*-\s*/).map((n) => n.trim()).filter(Boolean);
        if (sub.length === 2) tokens = sub;
      }
      return tokens.map((n) => {
        const key = n.toLowerCase();
        return roster.get(key) || n;
      });
    };

    const teamA = resolveSide(sideA);
    const teamB = resolveSide(sideB);

    if (teamA.length === 0 || teamB.length === 0) continue;
    if (teamA.length !== teamB.length) continue;
    if (teamA.length > 2 || teamB.length > 2) continue;

    // Validate that all tokens on both sides look like valid player names
    const allValidA = teamA.every((p) => isValidPlayerNameToken(p, roster));
    const allValidB = teamB.every((p) => isValidPlayerNameToken(p, roster));
    if (!allValidA || !allValidB) continue;

    // If no explicit court or set header, require ALL players to be recognized in the roster
    if (!explicitCourtNum && sets.length === 0 && !cpMatch) {
      const allKnownPlayers = [...teamA, ...teamB].every((p) =>
        roster.has(p.toLowerCase()) || roster.has(p)
      );
      if (!allKnownPlayers) {
        continue;
      }
    }

    const courtNum = explicitCourtNum ? parseInt(explicitCourtNum, 10) : courtCounter++;

    // If this court number already exists in currentCourts, roll over to the next set
    if (explicitCourtNum && currentCourts.some((c) => c.court === courtNum)) {
      sets.push({ set: currentSetNumber, courts: currentCourts });
      currentCourts = [];
      currentSetNumber = sets.length + 1;
      courtCounter = 1;
    }

    currentCourts.push({
      court: courtNum,
      teamA,
      teamB
    });
  }

  if (currentCourts.length > 0) {
    sets.push({ set: currentSetNumber, courts: currentCourts });
  }

  if (sets.length === 0) return null;

  const allPlayers = new Set();
  let isSingles = true;

  for (const s of sets) {
    for (const c of s.courts) {
      if (c.teamA.length > 1 || c.teamB.length > 1) isSingles = false;
      c.teamA.forEach((p) => allPlayers.add(p));
      c.teamB.forEach((p) => allPlayers.add(p));
    }
  }

  if (allPlayers.size < 2) return null;

  return {
    type: isSingles ? 'singles' : 'doubles',
    players: [...allPlayers],
    sets
  };
}

module.exports = {
  parseLineup
};
