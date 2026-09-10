/**
 * Simple JSON-file persistence for the tennis group's data.
 * Good enough for a single-process bot with light traffic -- not built for
 * concurrent writers, but that's not a concern here.
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data.json');

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { availability: [], matches: [] };
  }
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      availability: parsed.availability || [],
      matches: parsed.matches || []
    };
  } catch (err) {
    console.error('⚠️  Failed to read data.json, starting fresh:', err.message);
    return { availability: [], matches: [] };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ---- Availability ----

/** Add or update a player's availability entry (one active entry per player). */
function setAvailable(player, when) {
  const data = loadData();
  const existingIndex = data.availability.findIndex(
    (a) => a.player.toLowerCase() === player.toLowerCase()
  );
  const entry = { player, when, addedAt: new Date().toISOString() };
  if (existingIndex >= 0) {
    data.availability[existingIndex] = entry;
  } else {
    data.availability.push(entry);
  }
  saveData(data);
  return data.availability;
}

function removeAvailable(player) {
  const data = loadData();
  data.availability = data.availability.filter(
    (a) => a.player.toLowerCase() !== player.toLowerCase()
  );
  saveData(data);
  return data.availability;
}

function clearAvailability() {
  const data = loadData();
  data.availability = [];
  saveData(data);
}

function getAvailability() {
  return loadData().availability;
}

// ---- Match results / leaderboard ----

function recordMatch(winner, loser, score) {
  const data = loadData();
  data.matches.push({
    winner,
    loser,
    score,
    date: new Date().toISOString()
  });
  saveData(data);
  return data.matches;
}

function getLeaderboard() {
  const { matches } = loadData();
  const stats = new Map(); // name -> { wins, losses }

  const getStats = (name) => {
    const key = name.toLowerCase();
    if (!stats.has(key)) {
      stats.set(key, { name, wins: 0, losses: 0 });
    }
    return stats.get(key);
  };

  for (const m of matches) {
    getStats(m.winner).wins += 1;
    getStats(m.loser).losses += 1;
  }

  return [...stats.values()].sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    return a.losses - b.losses;
  });
}

function getRecentMatches(limit = 5) {
  const { matches } = loadData();
  return matches.slice(-limit).reverse();
}

module.exports = {
  setAvailable,
  removeAvailable,
  clearAvailability,
  getAvailability,
  recordMatch,
  getLeaderboard,
  getRecentMatches
};
