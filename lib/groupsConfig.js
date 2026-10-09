const fs = require('fs');
const path = require('path');

const GROUPS_FILE = path.join(__dirname, '..', 'groups.json');

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
 * Returns list of whitelisted group identifiers (names/subjects or JIDs),
 * or null if no whitelist is active (meaning all groups the bot is added to are allowed).
 */
function getWhitelistedGroups() {
  const list = [];

  // 1. From groups.json
  const cfg = cachedConfig || loadRawConfig();
  if (cfg) {
    if (Array.isArray(cfg.allowedGroups) && cfg.allowedGroups.length > 0) {
      list.push(...cfg.allowedGroups);
    }
  }

  // 2. From .env (TARGET_GROUP_NAMES or TARGET_GROUP_NAME)
  const envMulti = process.env.TARGET_GROUP_NAMES;
  if (envMulti && envMulti.trim()) {
    const items = envMulti.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
    list.push(...items);
  } else if (process.env.TARGET_GROUP_NAME && process.env.TARGET_GROUP_NAME.trim()) {
    list.push(process.env.TARGET_GROUP_NAME.trim());
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

  // Fallbacks: if no groups.json overrides, use .env or sensible defaults
  const envIgnoredCourts = (process.env.IGNORED_COURTS || process.env.IGNORED_COURT || '')
    .split(/[,;]+/)
    .map(s => s.trim())
    .filter(Boolean);

  return {
    name: groupSpecific?.name || subject || jid,
    sport: groupSpecific?.sport || defaults.sport || 'tennis',
    courtBookingEnabled: groupSpecific?.courtBookingEnabled !== undefined
      ? groupSpecific.courtBookingEnabled
      : (defaults.courtBookingEnabled !== undefined ? defaults.courtBookingEnabled : true),
    venue: groupSpecific?.venue || defaults.venue || 'SCVCC',
    ignoredCourts: Array.isArray(groupSpecific?.ignoredCourts)
      ? groupSpecific.ignoredCourts
      : (Array.isArray(defaults.ignoredCourts) ? defaults.ignoredCourts : envIgnoredCourts),
    autoMatchups: groupSpecific?.autoMatchups !== undefined
      ? groupSpecific.autoMatchups
      : (defaults.autoMatchups !== undefined ? defaults.autoMatchups : true),
    ...groupSpecific
  };
}

module.exports = {
  getWhitelistedGroups,
  hasWhitelist,
  isGroupAllowed,
  getGroupConfig,
  reloadConfig,
  GROUPS_FILE
};
