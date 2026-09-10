/**
 * Doubles matchup generation for tennis poll results.
 */

function shuffle(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Splits a list of player names into courts of 4, and for each court
 * produces two different doubles pairings -- one per set -- so partners
 * change between set 1 and set 2. `players.length` must be a positive
 * multiple of 4.
 */
function generateMatchups(players) {
  if (!Array.isArray(players) || players.length === 0 || players.length % 4 !== 0) {
    throw new Error('Player count must be a positive multiple of 4');
  }

  const shuffled = shuffle(players);
  const courts = [];

  for (let i = 0; i < shuffled.length; i += 4) {
    const [p1, p2, p3, p4] = shuffled.slice(i, i + 4);
    courts.push({
      court: courts.length + 1,
      set1: { teamA: [p1, p2], teamB: [p3, p4] },
      set2: { teamA: [p1, p3], teamB: [p2, p4] }
    });
  }

  return courts;
}

/** Formats generated courts/matchups into a WhatsApp-friendly message. */
function formatMatchups(courts) {
  const lines = ["🎾 All spots filled! Here are today's matchups:", ''];
  for (const c of courts) {
    lines.push(`Court ${c.court}:`);
    lines.push(`  Set 1: ${c.set1.teamA.join(' & ')} vs ${c.set1.teamB.join(' & ')}`);
    lines.push(`  Set 2: ${c.set2.teamA.join(' & ')} vs ${c.set2.teamB.join(' & ')}`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

module.exports = { generateMatchups, formatMatchups };
