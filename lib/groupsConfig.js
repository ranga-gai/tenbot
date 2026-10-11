const fs = require('fs');
const path = require('path');
const courtsConfig = require('./courtsConfig');

if (!process.env.SUPERADMIN_ACCOUNT && !process.env.SUPERADMIN_LID) { try { require('dotenv').config(); } catch (e) {} }

const GROUPS_FILE = path.join(__dirname, '..', 'config', 'groups.json');

function loadRawConfig() {
  if (!fs.existsSync(GROUPS_FILE)) return null;
  try {
    const raw = fs.readFileSync(GROUPS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('⚠️ Failed to read groups.json:', err.message);
    return null;
  }
}

let cachedConfig = loadRawConfig();

function reloadConfig() {
  cachedConfig = loadRawConfig();
  return cachedConfig;
}

/**
 * Returns list of whitelisted group identifiers (names/subjects, aliases, or JIDs),
 * or null if no whitelist is active (meaning all groups the bot is added to are allowed).
 * Automatically uses the groups configured in groups.json (and allowedGroups if specified).
 */
function getWhitelistedGroups() {
  const list = [];
  const cfg = cachedConfig || loadRawConfig();

  if (cfg) {
    // 1. From groups configured in groups.json
    if (cfg.groups && typeof cfg.groups === 'object') {
      for (const [key, gVal] of Object.entries(cfg.groups)) {
        if (key && key.trim()) list.push(key.trim());
        if (gVal?.name && String(gVal.name).trim()) list.push(String(gVal.name).trim());
        if (gVal?.alias && String(gVal.alias).trim()) list.push(String(gVal.alias).trim());
      }
    }

    // 2. From explicit allowedGroups in groups.json (if specified)
    if (Array.isArray(cfg.allowedGroups) && cfg.allowedGroups.length > 0) {
      list.push(...cfg.allowedGroups);
    }
  }

  // If nothing specified, return null (open mode: all groups allowed)
  if (list.length === 0) return null;

  // Deduplicate case-insensitively
  const seen = new Set();
  const deduped = [];
  for (const item of list) {
    const key = item.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(item);
    }
  }
  return deduped;
}

function hasWhitelist() {
  return getWhitelistedGroups() !== null;
}

/**
 * Checks whether a group is allowed to interact with the bot.
 * If no whitelist is set, returns true (open mode).
 */
function isGroupAllowed(jid, subject) {
  const whitelist = getWhitelistedGroups();
  if (!whitelist) return true; // Open mode: all groups allowed

  const cleanJid = (jid || '').toLowerCase().trim();
  const cleanSubject = (subject || '').toLowerCase().trim();

  for (const item of whitelist) {
    const cleanItem = item.toLowerCase().trim();
    if (cleanJid === cleanItem || cleanSubject === cleanItem) {
      return true;
    }
  }
  return false;
}

/**
 * Returns merged configuration for a given group.
 */
function getGroupConfig(jid, subject) {
  const cfg = cachedConfig || loadRawConfig() || {};
  const defaults = cfg.defaults || {};

  const cleanJid = (jid || '').toLowerCase().trim();
  const cleanSubject = (subject || '').toLowerCase().trim();

  let groupSpecific = null;
  if (cfg.groups && typeof cfg.groups === 'object') {
    for (const [key, gVal] of Object.entries(cfg.groups)) {
      const cleanKey = key.toLowerCase().trim();
      const gName = (gVal.name || '').toLowerCase().trim();
      const gAlias = (gVal.alias || '').toLowerCase().trim();
      if (cleanJid === cleanKey || cleanSubject === cleanKey || (gName && cleanSubject === gName) || (gAlias && cleanSubject === gAlias)) {
        groupSpecific = gVal;
        break;
      }
    }
  }

  // Fallbacks: if no groups.json overrides, use courts.json or .env
  const targetVenue = groupSpecific?.venue || defaults.venue || 'SCVCC';
  const courtIgnoredCourts = courtsConfig.getIgnoredCourts(targetVenue);
  const envIgnoredCourts = (process.env.IGNORED_COURTS || process.env.IGNORED_COURT || '')
    .split(/[,;]+/)
    .map(s => s.trim())
    .filter(Boolean);
  const fallbackIgnored = courtIgnoredCourts.length > 0 ? courtIgnoredCourts : envIgnoredCourts;

  const rawDirectAccounts = groupSpecific?.directCourtBookingAccounts !== undefined
    ? groupSpecific.directCourtBookingAccounts
    : (defaults.directCourtBookingAccounts !== undefined ? defaults.directCourtBookingAccounts : []);

  const cleanDirectAccounts = Array.isArray(rawDirectAccounts)
    ? rawDirectAccounts
    : (typeof rawDirectAccounts === 'string' ? rawDirectAccounts.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean) : []);

  return {
    name: groupSpecific?.name || subject || jid,
    sport: groupSpecific?.sport || defaults.sport || 'tennis',
    courtBookingEnabled: groupSpecific?.courtBookingEnabled !== undefined
      ? groupSpecific.courtBookingEnabled
      : (defaults.courtBookingEnabled !== undefined ? defaults.courtBookingEnabled : true),
    venue: targetVenue,
    ignoredCourts: Array.isArray(groupSpecific?.ignoredCourts)
      ? groupSpecific.ignoredCourts
      : (Array.isArray(defaults.ignoredCourts) ? defaults.ignoredCourts : fallbackIgnored),
    autoMatchups: groupSpecific?.autoMatchups !== undefined
      ? groupSpecific.autoMatchups
      : (defaults.autoMatchups !== undefined ? defaults.autoMatchups : true),
    directCourtBookingAccounts: cleanDirectAccounts,
    ...groupSpecific
  };
}

function normalizeAccountsSet(rawItems) {
  const accounts = new Set();
  const addToken = (token) => {
    if (!token) return;
    const raw = String(token).replace(/['"]/g, '').trim().toLowerCase();
    if (!raw) return;
    accounts.add(raw);
    if (!raw.endsWith('@lid')) {
      accounts.add(`${raw}@lid`);
    } else {
      accounts.add(raw.replace(/@lid$/i, ''));
    }
  };

  if (Array.isArray(rawItems)) {
    rawItems.forEach(addToken);
  } else if (typeof rawItems === 'string') {
    rawItems.split(/[,;\s]+/).forEach(addToken);
  }
  return accounts;
}

/**
 * Returns the set of direct court booking accounts for a specific group (or across all groups if jid is null).
 */
function getDirectCourtBookingAccounts(jid = null) {
  const cfg = cachedConfig || loadRawConfig() || {};
  const defaults = cfg.defaults || {};

  if (jid) {
    const groupCfg = getGroupConfig(jid);
    if (groupCfg && groupCfg.directCourtBookingAccounts && groupCfg.directCourtBookingAccounts.length > 0) {
      return normalizeAccountsSet(groupCfg.directCourtBookingAccounts);
    }
  }

  // If no group-specific or jid was null, collect from all groups and defaults
  const allAccounts = [];
  if (defaults.directCourtBookingAccounts) {
    allAccounts.push(defaults.directCourtBookingAccounts);
  }
  if (cfg.groups && typeof cfg.groups === 'object') {
    for (const gVal of Object.values(cfg.groups)) {
      if (gVal && gVal.directCourtBookingAccounts) {
        allAccounts.push(gVal.directCourtBookingAccounts);
      }
    }
  }

  const result = new Set();
  for (const item of allAccounts) {
    const s = normalizeAccountsSet(item);
    for (const acc of s) result.add(acc);
  }
  return result;
}


/**
 * Retrieves the set of superadmin accounts (LIDs or phone JIDs) configured in .env.
 */
function getSuperAdminAccounts() {
  const raw = process.env.SUPERADMIN_ACCOUNT || process.env.SUPERADMIN_LID || process.env.SUPERADMIN_LIDS || process.env.SUPERADMIN || '';
  if (!raw || !raw.trim()) return new Set();
  const tokens = raw.split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const set = new Set();
  for (const t of tokens) {
    const clean = t.replace(/['"]/g, '');
    set.add(clean);
    if (!clean.endsWith('@lid')) {
      set.add(`${clean}@lid`);
    } else {
      set.add(clean.replace(/@lid$/i, ''));
    }
  }
  return set;
}

const getSuperAdminLids = getSuperAdminAccounts;

/**
 * Checks whether a sender JID is an authorized bot superadmin.
 */
function isSuperAdmin(senderJid) {
  if (!senderJid) return false;
  const superAccounts = getSuperAdminAccounts();
  if (superAccounts.size === 0) return false;

  const rawUser = String(senderJid).trim().toLowerCase();
  const numOnly = rawUser.split('@')[0];

  if (superAccounts.has(rawUser) || superAccounts.has(numOnly)) return true;

  try {
    const namesStore = require('./names');
    const lid = namesStore.resolveCanonicalId(rawUser);
    const pn = namesStore.getPnByLid(rawUser);

    if (lid && (superAccounts.has(lid.toLowerCase()) || superAccounts.has(lid.split('@')[0]))) return true;
    if (pn && (superAccounts.has(pn.toLowerCase()) || superAccounts.has(pn.split('@')[0]))) return true;
  } catch (err) {}

  return false;
}

/**
 * Persists raw configuration directly to groups.json and refreshes memory cache.
 */
function saveRawConfig(cfg) {
  try {
    fs.writeFileSync(GROUPS_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
    cachedConfig = cfg;
    return true;
  } catch (err) {
    console.error('⚠️ Failed to save groups.json:', err.message);
    return false;
  }
}

/**
 * Helper to locate an existing group key in cfg.groups by JID, name, or alias.
 */
function findConfigGroupKey(cfg, jidOrName) {
  if (!cfg || !cfg.groups || typeof cfg.groups !== 'object' || !jidOrName) return null;
  const target = String(jidOrName).trim().toLowerCase();
  for (const [key, gVal] of Object.entries(cfg.groups)) {
    if (
      key.toLowerCase() === target ||
      (gVal?.name && gVal.name.toLowerCase() === target) ||
      (gVal?.alias && gVal.alias.toLowerCase() === target)
    ) {
      return key;
    }
  }
  return null;
}

/**
 * Adds a new group to groups.json (and allowedGroups if whitelist active).
 * Accepts jidOrName as either a JID (e.g. 120363403838804497@g.us) or a group name.
 * groupData can be an object with group properties or a string display name.
 */
function addGroup(jidOrName, groupData = {}) {
  const cfg = loadRawConfig() || { defaults: {}, groups: {} };
  if (!cfg.groups) cfg.groups = {};

  let data = typeof groupData === 'string'
    ? { name: groupData }
    : (groupData && typeof groupData === 'object' ? { ...groupData } : {});

  if (typeof jidOrName === 'object' && jidOrName !== null) {
    data = { ...jidOrName, ...data };
    jidOrName = data.jid || data.name;
  }

  const target = String(jidOrName || data.jid || data.name || '').trim();
  if (!target) {
    throw new Error('Group JID or name is required.');
  }

  let cleanJid = data.jid ? String(data.jid).trim() : null;
  if (!cleanJid) {
    if (target.includes('@')) {
      cleanJid = target;
    } else {
      const existingKey = findConfigGroupKey(cfg, target);
      cleanJid = existingKey || target;
    }
  }

  const existing = cfg.groups[cleanJid] || {};

  const cleanAccounts = Array.isArray(data.directCourtBookingAccounts)
    ? data.directCourtBookingAccounts
    : (typeof data.directCourtBookingAccounts === 'string'
      ? data.directCourtBookingAccounts.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean)
      : (existing.directCourtBookingAccounts || []));

  const resolvedName = data.name || (target !== cleanJid ? target : (existing.name || cleanJid));

  cfg.groups[cleanJid] = {
    ...existing,
    ...data,
    name: resolvedName,
    sport: data.sport || existing.sport || cfg.defaults?.sport || 'tennis',
    courtBookingEnabled: data.courtBookingEnabled !== undefined
      ? (String(data.courtBookingEnabled).toLowerCase() === 'true' || data.courtBookingEnabled === true || data.courtBookingEnabled === 1)
      : (existing.courtBookingEnabled !== undefined ? existing.courtBookingEnabled : true),
    venue: data.venue || existing.venue || cfg.defaults?.venue || 'SCVCC',
    autoMatchups: data.autoMatchups !== undefined
      ? (String(data.autoMatchups).toLowerCase() === 'true' || data.autoMatchups === true || data.autoMatchups === 1)
      : (existing.autoMatchups !== undefined ? existing.autoMatchups : true),
    directCourtBookingAccounts: cleanAccounts
  };

  if (data.ignoredCourts !== undefined) {
    cfg.groups[cleanJid].ignoredCourts = Array.isArray(data.ignoredCourts)
      ? data.ignoredCourts
      : String(data.ignoredCourts).split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  }

  // If allowedGroups array is explicitly maintained in groups.json, keep it in sync
  if (Array.isArray(cfg.allowedGroups)) {
    if (!cfg.allowedGroups.includes(cleanJid)) {
      cfg.allowedGroups.push(cleanJid);
    }
    if (resolvedName && resolvedName !== cleanJid && !cfg.allowedGroups.includes(resolvedName)) {
      cfg.allowedGroups.push(resolvedName);
    }
  }

  saveRawConfig(cfg);
  return { jid: cleanJid, ...cfg.groups[cleanJid] };
}

/**
 * Removes a group from groups.json (and allowedGroups if present).
 */
function removeGroup(jidOrName) {
  const cfg = loadRawConfig() || { defaults: {}, groups: {} };
  if (!cfg.groups) return null;

  const foundKey = findConfigGroupKey(cfg, jidOrName);
  if (!foundKey) return null;

  const removed = cfg.groups[foundKey];
  delete cfg.groups[foundKey];

  if (Array.isArray(cfg.allowedGroups)) {
    const target = String(jidOrName).trim().toLowerCase();
    const removedName = (removed?.name || '').toLowerCase();
    cfg.allowedGroups = cfg.allowedGroups.filter((g) => {
      const gLower = g.toLowerCase();
      return gLower !== foundKey.toLowerCase() && gLower !== target && gLower !== removedName;
    });
  }

  saveRawConfig(cfg);
  return { jid: foundKey, ...removed };
}

/**
 * Updates settings for a group in groups.json.
 */
function updateGroupConfig(jidOrName, updates = {}) {
  const cfg = loadRawConfig() || { defaults: {}, groups: {} };
  if (!cfg.groups) cfg.groups = {};

  let foundKey = findConfigGroupKey(cfg, jidOrName);

  if (!foundKey) {
    const target = String(jidOrName).trim();
    if (target.includes('@')) {
      foundKey = target;
      cfg.groups[foundKey] = {};
    } else {
      return null;
    }
  }

  const current = cfg.groups[foundKey] || {};
  const processed = { ...updates };

  if (processed.courtBookingEnabled !== undefined) {
    processed.courtBookingEnabled = String(processed.courtBookingEnabled).toLowerCase() === 'true' || processed.courtBookingEnabled === true || processed.courtBookingEnabled === 1;
  }
  if (processed.autoMatchups !== undefined) {
    processed.autoMatchups = String(processed.autoMatchups).toLowerCase() === 'true' || processed.autoMatchups === true || processed.autoMatchups === 1;
  }
  if (processed.directCourtBookingAccounts !== undefined) {
    processed.directCourtBookingAccounts = Array.isArray(processed.directCourtBookingAccounts)
      ? processed.directCourtBookingAccounts
      : String(processed.directCourtBookingAccounts).split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  }
  if (processed.ignoredCourts !== undefined) {
    processed.ignoredCourts = Array.isArray(processed.ignoredCourts)
      ? processed.ignoredCourts
      : String(processed.ignoredCourts).split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  }

  cfg.groups[foundKey] = {
    ...current,
    ...processed
  };

  saveRawConfig(cfg);
  return { jid: foundKey, ...cfg.groups[foundKey] };
}

/**
 * Returns a formatted summary string of a group configuration or all groups.
 */
function formatGroupConfig(jidOrName = null) {
  const cfg = loadRawConfig() || { defaults: {}, groups: {} };
  const groups = cfg.groups || {};

  if (jidOrName) {
    const foundKey = findConfigGroupKey(cfg, jidOrName);
    const foundVal = foundKey ? groups[foundKey] : null;
    if (!foundVal) {
      return `⚠️ Group "${jidOrName}" not found in groups.json.`;
    }
    const lines = [`⚙️ *Group Configuration for ${foundVal.name || foundKey}:*`];
    lines.push(`• *JID:* \`${foundKey}\``);
    if (foundVal.alias) lines.push(`• *Alias:* ${foundVal.alias}`);
    lines.push(`• *Sport:* ${foundVal.sport || cfg.defaults?.sport || 'tennis'}`);
    lines.push(`• *Venue:* ${foundVal.venue || cfg.defaults?.venue || 'SCVCC'}`);
    lines.push(`• *Court Booking:* ${foundVal.courtBookingEnabled !== false ? 'Enabled' : 'Disabled'}`);
    lines.push(`• *Auto Matchups:* ${foundVal.autoMatchups !== false ? 'Enabled' : 'Disabled'}`);
    const accounts = foundVal.directCourtBookingAccounts || [];
    lines.push(`• *Direct Booking Accounts:* ${accounts.length > 0 ? accounts.join(', ') : 'None'}`);
    if (foundVal.ignoredCourts && foundVal.ignoredCourts.length > 0) {
      lines.push(`• *Ignored Courts:* ${foundVal.ignoredCourts.join(', ')}`);
    }
    return lines.join('\n');
  }

  const entries = Object.entries(groups);
  if (entries.length === 0) {
    return 'No groups currently configured in groups.json.';
  }

  const lines = [`⚙️ *Configured Groups in groups.json* (${entries.length}):\n`];
  for (let i = 0; i < entries.length; i++) {
    const [gId, gVal] = entries[i];
    lines.push(`${i + 1}. *${gVal.name || gId}*`);
    lines.push(`   • JID: \`${gId}\``);
    if (gVal.alias) lines.push(`   • Alias: ${gVal.alias}`);
    lines.push(`   • Sport: ${gVal.sport || cfg.defaults?.sport || 'tennis'}`);
    lines.push(`   • Court Booking: ${gVal.courtBookingEnabled !== false ? 'Enabled' : 'Disabled'}`);
    const accounts = gVal.directCourtBookingAccounts || [];
    if (accounts.length > 0) {
      lines.push(`   • Direct Booking Accounts: ${accounts.join(', ')}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

module.exports = {
  getWhitelistedGroups,
  hasWhitelist,
  isGroupAllowed,
  getGroupConfig,
  getDirectCourtBookingAccounts,
  getSuperAdminAccounts,
  getSuperAdminLids,
  isSuperAdmin,
  saveRawConfig,
  findConfigGroupKey,
  addGroup,
  removeGroup,
  updateGroupConfig,
  formatGroupConfig,
  reloadConfig,
  GROUPS_FILE
};
