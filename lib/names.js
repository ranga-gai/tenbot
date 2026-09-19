/**
 * Persistent Name & Alias Registry (names.json)
 * ---------------------------------------------
 * Maps player IDs (WhatsApp JID/LID) to their canonical display name and aliases.
 *
 * Schema:
 * {
 *   "14081234567@s.whatsapp.net": {
 *     "name": "Pramod",
 *     "aliases": ["Pramod K", "PK"]
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');

const NAMES_FILE = path.join(__dirname, '..', 'names.json');

function cleanStr(s) {
  return typeof s === 'string' ? s.trim() : '';
}

function keyFor(s) {
  return cleanStr(s).toLowerCase();
}

function load() {
  if (!fs.existsSync(NAMES_FILE)) return {};
  try {
    const raw = fs.readFileSync(NAMES_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    console.error('⚠️ Failed to read names.json:', err.message);
    return {};
  }
}

function save(data) {
  try {
    fs.writeFileSync(NAMES_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('⚠️ Failed to save names.json:', err.message);
  }
}

/**
 * Gets the display name for a given ID.
 */
function getName(id) {
  if (!id) return null;
  const store = load();
  const cleanId = cleanStr(id);
  const entry = store[cleanId];
  return entry && entry.name ? entry.name : null;
}

/**
 * Gets the aliases list for a given ID.
 */
function getAliases(id) {
  if (!id) return [];
  const store = load();
  const cleanId = cleanStr(id);
  const entry = store[cleanId];
  return entry && Array.isArray(entry.aliases) ? entry.aliases : [];
}

/**
 * Sets or updates the name and aliases for an ID.
 */
function setName(id, name, aliases = []) {
  const cleanId = cleanStr(id);
  const cleanName = cleanStr(name);
  if (!cleanId || !cleanName) return null;

  const store = load();
  const existing = store[cleanId] || { name: cleanName, aliases: [] };

  existing.name = cleanName;
  if (!Array.isArray(existing.aliases)) {
    existing.aliases = [];
  }

  const toAdd = Array.isArray(aliases) ? aliases : [aliases];
  for (const alias of toAdd) {
    const a = cleanStr(alias);
    if (a && keyFor(a) !== keyFor(cleanName) && !existing.aliases.some((x) => keyFor(x) === keyFor(a))) {
      existing.aliases.push(a);
    }
  }

  store[cleanId] = existing;
  save(store);
  return existing;
}

/**
 * Adds an alias to an existing ID entry.
 */
function addAlias(id, alias) {
  const cleanId = cleanStr(id);
  const a = cleanStr(alias);
  if (!cleanId || !a) return false;

  const store = load();
  if (!store[cleanId]) return false;

  if (!Array.isArray(store[cleanId].aliases)) {
    store[cleanId].aliases = [];
  }

  if (keyFor(store[cleanId].name) !== keyFor(a) && !store[cleanId].aliases.some((x) => keyFor(x) === keyFor(a))) {
    store[cleanId].aliases.push(a);
    save(store);
    return true;
  }
  return false;
}

/**
 * Finds an ID matching a display name or any alias (case-insensitive).
 * Returns { id, entry: { name, aliases } } or null.
 */
function findIdByNameOrAlias(nameOrAlias) {
  const target = cleanStr(nameOrAlias);
  if (!target) return null;
  const targetKey = keyFor(target);
  const store = load();

  // 1. Check exact ID key match
  if (store[target]) {
    return { id: target, entry: store[target] };
  }

  // 2. Check display name match
  for (const [id, entry] of Object.entries(store)) {
    if (entry.name && keyFor(entry.name) === targetKey) {
      return { id, entry };
    }
  }

  // 3. Check aliases match
  for (const [id, entry] of Object.entries(store)) {
    if (Array.isArray(entry.aliases)) {
      if (entry.aliases.some((a) => keyFor(a) === targetKey)) {
        return { id, entry };
      }
    }
  }

  return null;
}

/**
 * Returns all registered name entries as an array: [{ id, name, aliases }]
 */
function getAllEntries() {
  const store = load();
  return Object.entries(store).map(([id, entry]) => ({
    id,
    name: entry.name,
    aliases: Array.isArray(entry.aliases) ? entry.aliases : []
  }));
}

module.exports = {
  load,
  save,
  getName,
  getAliases,
  setName,
  addAlias,
  findIdByNameOrAlias,
  getAllEntries,
  keyFor
};
