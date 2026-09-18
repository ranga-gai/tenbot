/**
 * Lineup parser: detects and extracts manually published court lineups and rotations.
 *
 * Supports patterns like:
 *   Court 1: Mike & Sara vs John & Alex
 *   Court 2: Bob & David vs Alice & Eve
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
  if (/\b\d+-\d+\b/.test(text)) return null;

  // Must contain vs / v / versus
  if (!/\b(?:vs\.?|v\.?|versus)\b/i.test(text)) return null;

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const sets = [];
  let currentSetNumber = 1;
  let currentCourts = [];
  let courtCounter = 1;

  const courtRegex = /^(?:(?:court|ct|c|match)\s*(\d+)?[.:\-)]?\s*|(\d+)[.:\-)]\s*)?([^\n\r]+?)\s+(?:vs\.?|v\.?|versus)\s+([^\n\r]+)$/i;
  const setHeaderRegex = /^(?:set|round|rotation)\s*(\d+)[.:\-)]?/i;

  for (const line of lines) {
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

    const match = line.match(courtRegex);
    if (!match) continue;

    const explicitCourtNum = match[1] || match[2];
    const rawSideA = match[3];
    const rawSideB = match[4];

    // Clean extraneous labels like "Court 1:", "Team 1:", etc.
    const cleanSideA = rawSideA.replace(/^(?:court|ct|c|match)\s*\d+[.:\-)]\s*/i, '').trim();
    const cleanSideB = rawSideB.replace(/^(?:court|ct|c|match)\s*\d+[.:\-)]\s*/i, '').trim();

    const resolveSide = (raw) => {
      const names = raw.split(/\s*(?:&|\+|\band\b|\/|,)\s*/i).map((n) => n.trim()).filter(Boolean);
      return names.map((n) => {
        const key = n.toLowerCase();
        return roster.get(key) || n;
      });
    };

    const teamA = resolveSide(cleanSideA);
    const teamB = resolveSide(cleanSideB);

    if (teamA.length === 0 || teamB.length === 0) continue;
    if (teamA.length !== teamB.length) continue; // Must be balanced (1v1 for singles or 2v2 for doubles)
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

  // Must have at least 2 players
  if (allPlayers.size < 2) return null;

  // Check how many players match known roster
  let recognizedCount = 0;
  for (const p of allPlayers) {
    if (roster.has(p.toLowerCase())) recognizedCount++;
  }

  // If roster has members, ensure a reasonable fraction of names are recognized players
  if (roster.size > 0 && recognizedCount / allPlayers.size < 0.3) {
    return null;
  }

  return {
    type: isSingles ? 'singles' : 'doubles',
    players: [...allPlayers],
    sets
  };
}

module.exports = {
  parseLineup
};
