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
 *   Set 2:
 *   Court 1: Mike & Bob vs Sara & David
 */

function parseLineup(text, roster = new Map()) {
  if (!text || typeof text !== 'string') return null;

  // Reject messages that are score reports or result summaries
  if (/\b(?:def|defeated|beat|beats|beaten|won|lost|score|scores)\b/i.test(text)) return null;
  if (/\b\d+-\d+\b/.test(text) && !/\bcourt|\bct\b|\bvs\b/i.test(text)) return null;

  // Must contain vs / v / versus
  if (!/\b(?:vs\.?|v\.?|versus)\b/i.test(text)) return null;

  // Normalize text: if multiple courts are concatenated on a single line, insert newlines before "Court X" / "Ct X" / "C<N>"
  let normalized = text.replace(/([^\n\r])\s+(?=(?:court|ct|match)\s*\d+\b|c\s*\d+\b)/gi, '$1\n');

  const rawLines = normalized.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const sets = [];
  let currentSetNumber = 1;
  let currentCourts = [];
  let courtCounter = 1;

  const courtPrefixRegex = /^(?:(?:court|ct|match)\s*(\d+)?|c\s*(\d+))[.:\-)]?\s*/i;
  const setHeaderRegex = /^(?:set|round|rotation)\s*(\d+)[.:\-)]?/i;

  for (const line of rawLines) {
    const setMatch = line.match(setHeaderRegex);
    if (setMatch) {
      if (currentCourts.length > 0) {
        sets.push({ set: currentSetNumber, courts: currentCourts });
        currentCourts = [];
        courtCounter = 1;
      }
      currentSetNumber = parseInt(setMatch[1], 10) || (sets.length + 1);
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

    const courtNum = explicitCourtNum ? parseInt(explicitCourtNum, 10) : courtCounter++;
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
