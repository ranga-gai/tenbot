/**
 * Persistent Name & Alias Registry (names.json)
 * ---------------------------------------------
 * Maps player IDs (WhatsApp LID: <id>@lid)
 * to their canonical display name and aliases.
 *
 * Schema:
 * {
 *   "12345678901234@lid": {
 *     "name": "Pramod",
 *     "aliases": ["Pramod K", "PK"]
 *   }
 * }
 */

const fs = require('fs');
const path = require('path');
const pollStore = require('./pollStore');

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
 * Resolves an ID (such as a phone number JID @s.whatsapp.net) to its canonical Linked Identity (@lid).
 */
function resolveCanonicalId(id) {
  const cleanId = cleanStr(id);
  if (!cleanId) return null;
  if (cleanId.endsWith('@lid')) {
    return cleanId; // already LID
  }
  if (cleanId.endsWith('@s.whatsapp.net')) {
    try {
      const { pnToLid } = pollStore.load();
      if (pnToLid instanceof Map && pnToLid.has(cleanId)) {
        return pnToLid.get(cleanId);
      }
    } catch (e) {}
  }
  return cleanId;
}

/**
 * Gets the display name for a given ID (LID or PN).
 */
function getName(id) {
  if (!id) return null;
  const store = load();
  const canonicalId = resolveCanonicalId(id);
  const rawId = cleanStr(id);
  const entry = store[canonicalId] || store[rawId];
  return entry && entry.name ? entry.name : null;
}

/**
 * Gets the aliases list for a given ID (LID or PN).
 */
function getAliases(id) {
  if (!id) return [];
  const store = load();
  const canonicalId = resolveCanonicalId(id);
  const rawId = cleanStr(id);
  const entry = store[canonicalId] || store[rawId];
  return entry && Array.isArray(entry.aliases) ? entry.aliases : [];
}

/**
 * Sets or updates the name and aliases for an ID (using canonical LID key).
 */
function setName(id, name, aliases = []) {
  const canonicalId = resolveCanonicalId(id);
  const cleanName = cleanStr(name);
  if (!canonicalId || !cleanName) return null;

  const store = load();
  const rawId = cleanStr(id);

  // If there was an old entry under a phone number key, merge aliases and remove the PN key
  if (rawId !== canonicalId && store[rawId]) {
    const pnEntry = store[rawId];
    if (Array.isArray(pnEntry.aliases)) {
      aliases = [...aliases, ...pnEntry.aliases];
    }
    delete store[rawId];
  }

  const existing = store[canonicalId] || { name: cleanName, aliases: [] };
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

  store[canonicalId] = existing;
  save(store);
  return existing;
}

/**
 * Adds an alias to an existing ID entry.
 */
function addAlias(id, alias) {
  const canonicalId = resolveCanonicalId(id);
  const a = cleanStr(alias);
  if (!canonicalId || !a) return false;

  const store = load();
  const rawId = cleanStr(id);
  const targetKey = store[canonicalId] ? canonicalId : (store[rawId] ? rawId : null);
  if (!targetKey) return false;

  if (!Array.isArray(store[targetKey].aliases)) {
    store[targetKey].aliases = [];
  }

  if (keyFor(store[targetKey].name) !== keyFor(a) && !store[targetKey].aliases.some((x) => keyFor(x) === keyFor(a))) {
    store[targetKey].aliases.push(a);
    save(store);
    return true;
  }
  return false;
}

/**
 * Removes an alias from an existing ID entry.
 */
function removeAlias(id, alias) {
  const canonicalId = resolveCanonicalId(id);
  const a = cleanStr(alias);
  if (!canonicalId || !a) return false;

  const store = load();
  const rawId = cleanStr(id);
  const targetKey = store[canonicalId] ? canonicalId : (store[rawId] ? rawId : null);
  if (!targetKey || !Array.isArray(store[targetKey].aliases)) return false;

  const aliasKey = keyFor(a);
  const beforeLen = store[targetKey].aliases.length;
  store[targetKey].aliases = store[targetKey].aliases.filter((item) => keyFor(item) !== aliasKey);
  if (store[targetKey].aliases.length !== beforeLen) {
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
  const canonicalId = resolveCanonicalId(target);
  if (store[canonicalId]) {
    return { id: canonicalId, entry: store[canonicalId] };
  }
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
 * Adds an alias for a player identified by display name, existing alias, or ID.
 */
function addAliasForPlayer(nameOrId, alias, optionalJid = null) {
  const cleanTarget = cleanStr(nameOrId);
  const cleanAlias = cleanStr(alias);
  if (!cleanTarget || !cleanAlias) return null;

  const store = load();
  let match = findIdByNameOrAlias(cleanTarget);
  if (!match && optionalJid) {
    match = findIdByNameOrAlias(optionalJid);
  }

  if (match) {
    const existing = store[match.id];
    if (!Array.isArray(existing.aliases)) existing.aliases = [];
    if (keyFor(existing.name) !== keyFor(cleanAlias) && !existing.aliases.some((x) => keyFor(x) === keyFor(cleanAlias))) {
      existing.aliases.push(cleanAlias);
      save(store);
    }
    return { id: match.id, name: existing.name, aliases: existing.aliases };
  }

  const primaryKey = resolveCanonicalId(optionalJid || cleanTarget);
  const newEntry = {
    name: cleanTarget,
    aliases: [cleanAlias]
  };
  store[primaryKey] = newEntry;
  save(store);
  return { id: primaryKey, name: cleanTarget, aliases: [cleanAlias] };
}

/**
 * Removes an alias for a player identified by display name, existing alias, or ID.
 * If alias is provided without nameOrId, removes that alias across whatever player owns it.
 */
function removeAliasForPlayer(nameOrId, alias) {
  const store = load();
  const cleanAlias = cleanStr(alias || nameOrId);
  const cleanTarget = alias ? cleanStr(nameOrId) : null;
  const aliasKey = keyFor(cleanAlias);

  if (!cleanAlias) return null;

  if (cleanTarget) {
    const match = findIdByNameOrAlias(cleanTarget);
    if (!match) return null;
    const entry = store[match.id];
    if (!Array.isArray(entry.aliases)) return null;

    const beforeLen = entry.aliases.length;
    entry.aliases = entry.aliases.filter((a) => keyFor(a) !== aliasKey);
    if (entry.aliases.length !== beforeLen) {
      save(store);
      return { id: match.id, name: entry.name, aliases: entry.aliases, removed: cleanAlias };
    }
    return null;
  }

  // Search across all entries
  for (const [id, entry] of Object.entries(store)) {
    if (Array.isArray(entry.aliases)) {
      const beforeLen = entry.aliases.length;
      entry.aliases = entry.aliases.filter((a) => keyFor(a) !== aliasKey);
      if (entry.aliases.length !== beforeLen) {
        save(store);
        return { id, name: entry.name, aliases: entry.aliases, removed: cleanAlias };
      }
    }
  }

  return null;
}

/**
 * Migrates any entries in names.json keyed by phone numbers to their LID keys.
 */
function deduplicateWithPnMap(pnToLidMap) {
  if (!pnToLidMap || !(pnToLidMap instanceof Map)) return;
  const store = load();
  let changed = false;

  for (const [pn, lid] of pnToLidMap.entries()) {
    if (store[pn]) {
      const pnEntry = store[pn];
      const lidEntry = store[lid] || { name: pnEntry.name, aliases: [] };
      if (Array.isArray(pnEntry.aliases)) {
        for (const a of pnEntry.aliases) {
          if (!lidEntry.aliases.includes(a) && keyFor(a) !== keyFor(lidEntry.name)) {
            lidEntry.aliases.push(a);
          }
        }
      }
      store[lid] = lidEntry;
      delete store[pn];
      changed = true;
    }
  }

  if (changed) {
    save(store);
    console.log('[names] Migrated legacy phone number entries to LID keys in names.json');
  }
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
  removeAlias,
  addAliasForPlayer,
  removeAliasForPlayer,
  findIdByNameOrAlias,
  deduplicateWithPnMap,
  getAllEntries,
  resolveCanonicalId,
  keyFor
};
