/**
 * Matchup generation for tennis poll results (Singles and Doubles).
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
 * Splits a list of player names into singles (2 players) or doubles courts (multiples of 4).
 * For doubles, produces two different pairings -- one per set -- so partners rotate.
 */
function generateMatchups(players) {
  if (!Array.isArray(players) || players.length === 0) {
    throw new Error('Player list must not be empty');
  }

  if (players.length === 2) {
    return [{
      court: 1,
      type: 'singles',
      player1: players[0],
      player2: players[1]
    }];
  }

  if (players.length % 4 !== 0) {
    throw new Error('Player count must be 2 for singles or a positive multiple of 4 for doubles');
  }

  const shuffled = shuffle(players);
  const courts = [];

  for (let i = 0; i < shuffled.length; i += 4) {
    const [p1, p2, p3, p4] = shuffled.slice(i, i + 4);
    courts.push({
      court: courts.length + 1,
      type: 'doubles',
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
    if (c.type === 'singles') {
      lines.push(`Court ${c.court} (Singles):`);
      lines.push(`  ${c.player1} vs ${c.player2}`);
      lines.push('');
    } else {
      lines.push(`Court ${c.court}:`);
      lines.push(`  Set 1: ${c.set1.teamA.join(' & ')} vs ${c.set1.teamB.join(' & ')}`);
      lines.push(`  Set 2: ${c.set2.teamA.join(' & ')} vs ${c.set2.teamB.join(' & ')}`);
      lines.push('');
    }
  }
  return lines.join('\n').trim();
}

module.exports = { generateMatchups, formatMatchups };
