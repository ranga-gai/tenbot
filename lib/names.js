/**
 * Persistent Name & Alias Registry (names.json)
 * ---------------------------------------------
 * Maps player IDs (WhatsApp LID: <id>@lid)
 * to their canonical display name, full name, phone number JID (pn), and aliases.
 *
 * Schema:
 * {
 *   "12345678901234@lid": {
 *     "name": "Pramod",
 *     "fullName": "Pramod Immaneni",
 *     "pn": "xxxxxxx@s.whatsapp.net",
 *     "aliases": ["Pramod I", "PI"]
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
 * At startup, ensures any existing names entry missing fullName defaults fullName to name,
 * and cleans up duplicate top-level @s.whatsapp.net entries that correspond to an existing @lid entry.
 */
function defaultMissingFullNames() {
  const store = load();
  let changed = false;

  for (const [key, entry] of Object.entries(store)) {
    if (key.endsWith('@s.whatsapp.net')) {
      let mappedLid = null;
      for (const [lid, lidEntry] of Object.entries(store)) {
        if (lid.endsWith('@lid') && (lidEntry.pn === key || (entry.name && lidEntry.name && keyFor(lidEntry.name) === keyFor(entry.name)))) {
          mappedLid = lid;
          break;
        }
      }
      if (mappedLid) {
        const lidEntry = store[mappedLid];
        if (!lidEntry.pn) lidEntry.pn = key;
        if (Array.isArray(entry.aliases)) {
          if (!Array.isArray(lidEntry.aliases)) lidEntry.aliases = [];
          for (const a of entry.aliases) {
            if (a && !lidEntry.aliases.includes(a)) lidEntry.aliases.push(a);
          }
        }
        delete store[key];
        changed = true;
        console.log(`[names] Cleaned up duplicate @s.whatsapp.net entry "${key}" into "${mappedLid}" (${lidEntry.name})`);
      }
    }
  }

  for (const [id, entry] of Object.entries(store)) {
    if (entry && entry.name && (!entry.fullName || typeof entry.fullName !== 'string' || !entry.fullName.trim())) {
      entry.fullName = entry.name;
      changed = true;
    }
  }

  if (changed) {
    save(store);
  }
}

/**
 * Resolves an ID (such as a phone number JID @s.whatsapp.net) to its canonical Linked Identity (@lid).
 */
function resolveCanonicalId(id, store = null) {
  const cleanId = cleanStr(id);
  if (!cleanId) return null;
  if (cleanId.endsWith('@lid')) {
    return cleanId; // already LID
  }
  const currentStore = store || load();
  if (cleanId.endsWith('@s.whatsapp.net')) {
    for (const [lid, entry] of Object.entries(currentStore)) {
      if (entry && entry.pn === cleanId) return lid;
    }
  }
  return cleanId;
}

/**
 * Returns the LID for a given phone number JID, if known.
 */
function getLidByPn(pn, store = null) {
  const cleanPn = cleanStr(pn);
  if (!cleanPn) return null;
  const currentStore = store || load();
  for (const [lid, entry] of Object.entries(currentStore)) {
    if (entry && entry.pn === cleanPn) return lid;
  }
  return null;
}

/**
 * Returns the phone number JID for a given LID, if known.
 */
function getPnByLid(lid, store = null) {
  const cleanLid = cleanStr(lid);
  if (!cleanLid) return null;
  const currentStore = store || load();
  return currentStore[cleanLid]?.pn || null;
}

/**
 * Gets the display name for a given ID (LID, PN, or raw ID).
 */
function getName(id) {
  if (!id) return null;
  const store = load();
  const canonicalId = resolveCanonicalId(id, store);
  const rawId = cleanStr(id);

  const entry = store[canonicalId] || store[rawId];
  if (entry && entry.name) return entry.name;

  if (rawId.endsWith('@s.whatsapp.net')) {
    for (const [, e] of Object.entries(store)) {
      if (e && e.pn === rawId && e.name) return e.name;
    }
  }

  return null;
}

/**
 * Gets the full name for a given ID (LID, PN, or raw ID).
 */
function getFullName(id) {
  if (!id) return null;
  const store = load();
  const canonicalId = resolveCanonicalId(id, store);
  const rawId = cleanStr(id);

  const entry = store[canonicalId] || store[rawId];
  if (entry && entry.fullName) return entry.fullName;

  if (rawId.endsWith('@s.whatsapp.net')) {
    for (const [, e] of Object.entries(store)) {
      if (e && e.pn === rawId && e.fullName) return e.fullName;
    }
  }

  return entry?.name || null;
}

/**
 * Sets or updates the full name for an ID.
 */
function setFullName(id, fullName) {
  const rawId = cleanStr(id);
  const cleanFull = cleanStr(fullName);
  if (!rawId) return null;

  const store = load();
  const canonicalId = resolveCanonicalId(rawId, store);
  const targetKey = store[canonicalId] ? canonicalId : (store[rawId] ? rawId : canonicalId);

  const existing = store[targetKey] || { name: cleanFull || 'Player', fullName: cleanFull || 'Player', pn: null, aliases: [] };
  existing.fullName = cleanFull || existing.name || 'Player';
  store[targetKey] = existing;
  save(store);
  return existing;
}

/**
 * Gets the aliases list for a given ID (LID or PN).
 */
function getAliases(id) {
  if (!id) return [];
  const store = load();
  const canonicalId = resolveCanonicalId(id, store);
  const rawId = cleanStr(id);
  const entry = store[canonicalId] || store[rawId];
  return entry && Array.isArray(entry.aliases) ? entry.aliases : [];
}

/**
 * Sets or updates the name, full name, phone number, and aliases for an ID (keyed by LID).
 * If full name is not provided, defaults to name.
 */
function setName(id, name, aliases = [], pn = null, fullName = null) {
  const rawId = cleanStr(id);
  const cleanName = cleanStr(name);
  const cleanFullName = cleanStr(fullName);
  const cleanPn = cleanStr(pn) || (rawId.endsWith('@s.whatsapp.net') ? rawId : null);

  const store = load();
  let canonicalId = rawId.endsWith('@lid') ? rawId : (cleanPn ? (getLidByPn(cleanPn, store) || rawId) : rawId);

  // If this was a PN and we found an existing LID entry, migrate
  if (rawId !== canonicalId && store[rawId]) {
    const oldEntry = store[rawId];
    if (Array.isArray(oldEntry.aliases)) {
      aliases = [...aliases, ...oldEntry.aliases];
    }
    if (!cleanFullName && oldEntry.fullName) {
      fullName = oldEntry.fullName;
    }
    delete store[rawId];
  }

  const effectiveName = cleanName || 'Player';
  const effectiveFullName = cleanFullName || fullName || effectiveName;

  const existing = store[canonicalId] || {
    name: effectiveName,
    fullName: effectiveFullName,
    pn: cleanPn || null,
    aliases: []
  };

  if (cleanName) existing.name = cleanName;
  if (cleanFullName) existing.fullName = cleanFullName;
  else if (!existing.fullName) existing.fullName = cleanName || existing.name || 'Player';

  if (cleanPn) existing.pn = cleanPn;
  if (!Array.isArray(existing.aliases)) existing.aliases = [];

  const toAdd = Array.isArray(aliases) ? aliases : [aliases];
  for (const alias of toAdd) {
    const a = cleanStr(alias);
    if (a && keyFor(a) !== keyFor(existing.name) && !existing.aliases.some((x) => keyFor(x) === keyFor(a))) {
      existing.aliases.push(a);
    }
  }

  store[canonicalId] = existing;
  save(store);
  return existing;
}

/**
 * Associates an LID with its Phone Number JID, optional display name, and optional full name.
 * If full name is not provided, defaults to name.
 */
function setMapping(lid, pn, name = null, fullName = null) {
  const cleanLid = cleanStr(lid);
  const cleanPn = cleanStr(pn);
  const cleanName = cleanStr(name);
  const cleanFullName = cleanStr(fullName);
  if (!cleanLid || !cleanPn) return;

  const store = load();

  let existingAliases = [];
  let existingName = cleanName;
  let existingFullName = cleanFullName;

  if (store[cleanPn]) {
    existingAliases = store[cleanPn].aliases || [];
    if (!existingName && store[cleanPn].name) existingName = store[cleanPn].name;
    if (!existingFullName && store[cleanPn].fullName) existingFullName = store[cleanPn].fullName;
    delete store[cleanPn];
  }

  const effectiveName = existingName || 'Player';
  const effectiveFullName = existingFullName || fullName || effectiveName;

  const entry = store[cleanLid] || {
    name: effectiveName,
    fullName: effectiveFullName,
    pn: cleanPn,
    aliases: []
  };

  entry.pn = cleanPn;
  if (existingName) entry.name = existingName;
  if (existingFullName) entry.fullName = existingFullName;
  else if (!entry.fullName) entry.fullName = existingName || entry.name || 'Player';
  if (!Array.isArray(entry.aliases)) entry.aliases = [];

  for (const a of existingAliases) {
    if (a && keyFor(a) !== keyFor(entry.name) && !entry.aliases.some((x) => keyFor(x) === keyFor(a))) {
      entry.aliases.push(a);
    }
  }

  store[cleanLid] = entry;
  save(store);
}

/**
 * Adds an alias to an existing ID entry.
 */
function addAlias(id, alias) {
  const store = load();
  const canonicalId = resolveCanonicalId(id, store);
  const a = cleanStr(alias);
  if (!canonicalId || !a) return false;

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
  const store = load();
  const canonicalId = resolveCanonicalId(id, store);
  const a = cleanStr(alias);
  if (!canonicalId || !a) return false;

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
 * Finds an ID matching a display name, full name, phone number, or any alias (case-insensitive).
 * Returns { id, entry: { name, fullName, pn, aliases } } or null.
 */
function findIdByNameOrAlias(nameOrAlias) {
  const target = cleanStr(nameOrAlias);
  if (!target) return null;
  const targetKey = keyFor(target);
  const store = load();

  // 1. Check exact LID key match
  if (store[target]) {
    return { id: target, entry: store[target] };
  }

  // 2. Check PN match
  for (const [id, entry] of Object.entries(store)) {
    if (entry.pn && (entry.pn === target || keyFor(entry.pn) === targetKey)) {
      return { id, entry };
    }
  }

  // 3. Check display name match
  for (const [id, entry] of Object.entries(store)) {
    if (entry.name && keyFor(entry.name) === targetKey) {
      return { id, entry };
    }
  }

  // 4. Check full name match
  for (const [id, entry] of Object.entries(store)) {
    if (entry.fullName && keyFor(entry.fullName) === targetKey) {
      return { id, entry };
    }
  }

  // 5. Check aliases match
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
 * Adds an alias for a player identified by display name, full name, existing alias, or ID.
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
    return { id: match.id, name: existing.name, fullName: existing.fullName || existing.name || 'Player', aliases: existing.aliases, pn: existing.pn || null };
  }

  const primaryKey = resolveCanonicalId(optionalJid || cleanTarget, store);
  const newEntry = {
    name: cleanTarget,
    fullName: cleanTarget,
    pn: optionalJid && optionalJid.endsWith('@s.whatsapp.net') ? optionalJid : null,
    aliases: [cleanAlias]
  };
  store[primaryKey] = newEntry;
  save(store);
  return { id: primaryKey, name: cleanTarget, fullName: cleanTarget, aliases: [cleanAlias], pn: newEntry.pn };
}

/**
 * Removes an alias for a player identified by display name, full name, existing alias, or ID.
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
      return { id: match.id, name: entry.name, fullName: entry.fullName || entry.name || 'Player', aliases: entry.aliases, pn: entry.pn || null, removed: cleanAlias };
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
        return { id, name: entry.name, fullName: entry.fullName || entry.name || 'Player', aliases: entry.aliases, pn: entry.pn || null, removed: cleanAlias };
      }
    }
  }

  return null;
}

/**
 * Returns all registered name entries as an array: [{ id, name, fullName, pn, aliases }]
 */
function getAllEntries() {
  const store = load();
  return Object.entries(store).map(([id, entry]) => ({
    id,
    name: entry.name,
    fullName: entry.fullName || entry.name || 'Player',
    pn: entry.pn || null,
    aliases: Array.isArray(entry.aliases) ? entry.aliases : []
  }));
}

module.exports = {
  load,
  save,
  getName,
  getFullName,
  setFullName,
  getAliases,
  getPnByLid,
  getLidByPn,
  setName,
  setMapping,
  addAlias,
  removeAlias,
  addAliasForPlayer,
  removeAliasForPlayer,
  findIdByNameOrAlias,
  defaultMissingFullNames,
  getAllEntries,
  resolveCanonicalId,
  keyFor
};
