const fs = require('fs');
const path = require('path');

if (!process.env.SUPERADMIN_ACCOUNT && !process.env.SUPERADMIN_LID) {
  try { require('dotenv').config(); } catch (e) {}
}

const { CONFIG_DIR } = require('./paths');
const COURTS_FILE = path.join(CONFIG_DIR, 'courts.json');

function loadRawConfig() {
  if (!fs.existsSync(COURTS_FILE)) return null;
  try {
    const raw = fs.readFileSync(COURTS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('⚠️ Failed to read courts.json:', err.message);
    return null;
  }
}

let cachedConfig = loadRawConfig();

function reloadConfig() {
  cachedConfig = loadRawConfig();
  return cachedConfig;
}

/**
 * Normalizes court configurations supporting multiple court booking systems
 * (e.g. 'scvcc'), where each booking system defines common configuration
 * (such as 'host' URL) and contains multiple named configurations.
 *
 * Example structure in courts.json:
 * {
 *   "scvcc": {
 *     "host": "https://www.scvcc.com",
 *     "configs": [
 *       {
 *         "name": "SCVCC",
 *         "username": "pramod",
 *         "password": "...",
 *         "ignoredCourts": ["4"]
 *       }
 *     ]
 *   }
 * }
 */
function normalizeConfigs(raw) {
  const configs = new Map(); // key: lowercase config name -> config object
  const systems = new Map(); // key: lowercase system kind -> system common config
  if (!raw) return { configs, systems };

  const addConfig = (systemKind, name, obj, commonProps = {}) => {
    if (!obj || typeof obj !== 'object') return;
    const cleanName = String(name || obj.name || '').trim();
    if (!cleanName) return;

    const rawIgnored = obj.ignoredCourts !== undefined
      ? obj.ignoredCourts
      : (obj.ignoredCourt !== undefined ? obj.ignoredCourt : (commonProps.ignoredCourts || []));

    const ignoredCourts = Array.isArray(rawIgnored)
      ? rawIgnored.map(s => String(s).trim()).filter(Boolean)
      : (typeof rawIgnored === 'string'
        ? rawIgnored.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean)
        : (rawIgnored ? [String(rawIgnored)] : []));

    const cleanSystem = String(obj.system || obj.type || commonProps.system || systemKind || 'scvcc').trim().toLowerCase();

    const merged = {
      ...commonProps,
      ...obj,
      name: obj.name || cleanName,
      system: cleanSystem,
      type: cleanSystem,
      username: obj.username || commonProps.username || '',
      password: obj.password || commonProps.password || '',
      host: obj.host || commonProps.host || (cleanSystem === 'scvcc' ? 'https://www.scvcc.com' : ''),
      ignoredCourts
    };

    configs.set(cleanName.toLowerCase(), merged);
  };

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item === 'object') {
        const sys = String(item.system || item.type || 'scvcc').trim().toLowerCase();
        if (!systems.has(sys)) {
          systems.set(sys, { system: sys, host: item.host || (sys === 'scvcc' ? 'https://www.scvcc.com' : '') });
        }
        addConfig(sys, item.name, item, systems.get(sys) || {});
      }
    }
  } else if (typeof raw === 'object') {
    for (const [key, val] of Object.entries(raw)) {
      const systemKind = key.trim().toLowerCase();

      if (Array.isArray(val)) {
        // e.g. "scvcc": [ { "name": "SCVCC", ... } ]
        if (!systems.has(systemKind)) {
          systems.set(systemKind, { system: systemKind, host: systemKind === 'scvcc' ? 'https://www.scvcc.com' : '' });
        }
        for (const item of val) {
          if (item && typeof item === 'object') {
            addConfig(systemKind, item.name, item, systems.get(systemKind) || {});
          }
        }
      } else if (val && typeof val === 'object') {
        const subList = val.configs || val.configurations || val.venues || val.accounts;

        if (subList) {
          // Booking system level configuration with nested configs
          const { configs: _c1, configurations: _c2, venues: _c3, accounts: _c4, ...commonProps } = val;
          const systemCommon = {
            system: systemKind,
            host: commonProps.host || (systemKind === 'scvcc' ? 'https://www.scvcc.com' : ''),
            ...commonProps
          };
          systems.set(systemKind, systemCommon);

          if (Array.isArray(subList)) {
            for (const item of subList) {
              if (item && typeof item === 'object') {
                addConfig(systemKind, item.name, item, systemCommon);
              }
            }
          } else if (typeof subList === 'object') {
            for (const [subName, subItem] of Object.entries(subList)) {
              if (subItem && typeof subItem === 'object') {
                addConfig(systemKind, subItem.name || subName, subItem, systemCommon);
              }
            }
          }
        } else if (
          val.username !== undefined ||
          val.password !== undefined ||
          val.ignoredCourts !== undefined ||
          val.ignoredCourt !== undefined
        ) {
          // Single configuration: e.g. "SCVCC": { "username": ..., "password": ... }
          const sys = String(val.system || val.type || systemKind || 'scvcc').trim().toLowerCase();
          addConfig(sys, val.name || key, val);
        } else {
          // Nested dictionary of configs: e.g. "scvcc": { "SCVCC": { ... } }
          const { host: sysHost, ...commonProps } = val;
          const systemCommon = {
            system: systemKind,
            host: sysHost || (systemKind === 'scvcc' ? 'https://www.scvcc.com' : ''),
            ...commonProps
          };
          systems.set(systemKind, systemCommon);

          for (const [subKey, subVal] of Object.entries(val)) {
            if (subVal && typeof subVal === 'object') {
              addConfig(systemKind, subVal.name || subKey, subVal, systemCommon);
            }
          }
        }
      }
    }
  }

  return { configs, systems };
}

function getNormalizedData() {
  const raw = cachedConfig || loadRawConfig();
  return normalizeConfigs(raw);
}

/**
 * Returns court configuration for a given name/venue and optional system kind (case-insensitive),
 * or falls back to 'SCVCC' or the first configured venue.
 */
function getCourtConfig(name = null, system = null) {
  const { configs } = getNormalizedData();

  if (configs.size === 0) {
    // Fallback to .env if courts.json is empty or not yet configured
    const envUser = process.env.SCVCC_USERNAME;
    const envPass = process.env.SCVCC_PASSWORD;
    const envIgnored = (process.env.IGNORED_COURTS || process.env.IGNORED_COURT || '')
      .split(/[,;]+/)
      .map(s => s.trim())
      .filter(Boolean);

    if (envUser && envPass) {
      return {
        name: name || 'SCVCC',
        system: system || 'scvcc',
        type: system || 'scvcc',
        username: envUser,
        password: envPass,
        host: 'https://www.scvcc.com',
        ignoredCourts: envIgnored
      };
    }
    return null;
  }

  const cleanSystem = system ? String(system).trim().toLowerCase() : null;

  if (name) {
    const cleanName = String(name).trim().toLowerCase();
    if (configs.has(cleanName)) {
      const cfg = configs.get(cleanName);
      if (!cleanSystem || cfg.system === cleanSystem) {
        return cfg;
      }
    }
  }

  // If a specific system was requested, find the first config for that system
  if (cleanSystem) {
    for (const cfg of configs.values()) {
      if (cfg.system === cleanSystem) {
        return cfg;
      }
    }
  }

  // If no name specified or exact name not found, try 'scvcc' first
  if (configs.has('scvcc')) {
    return configs.get('scvcc');
  }

  // Otherwise return the first configured venue
  const first = configs.values().next().value;
  return first || null;
}

/**
 * Returns system-level common configuration (e.g. host URL) for a given booking system.
 */
function getSystemConfig(system = 'scvcc') {
  const { systems } = getNormalizedData();
  const cleanSystem = String(system || 'scvcc').trim().toLowerCase();
  if (systems.has(cleanSystem)) {
    return systems.get(cleanSystem);
  }
  return {
    system: cleanSystem,
    host: cleanSystem === 'scvcc' ? 'https://www.scvcc.com' : ''
  };
}

/**
 * Returns all configured court configurations as an array, optionally filtered by system.
 */
function getAllCourtConfigs(system = null) {
  const { configs } = getNormalizedData();
  const all = Array.from(configs.values());
  if (!system) return all;
  const cleanSystem = String(system).trim().toLowerCase();
  return all.filter(c => c.system === cleanSystem);
}

/**
 * Returns all court configurations belonging to a specific booking system.
 */
function getCourtConfigsBySystem(system) {
  return getAllCourtConfigs(system);
}

/**
 * Returns list of distinct booking systems configured in courts.json.
 */
function getCourtSystems() {
  const { configs, systems } = getNormalizedData();
  const allSystems = new Set();
  for (const s of systems.keys()) allSystems.add(s);
  for (const cfg of configs.values()) {
    if (cfg.system) allSystems.add(cfg.system);
  }
  return Array.from(allSystems);
}

/**
 * Returns the list of ignored courts for a venue/configuration.
 */
function getIgnoredCourts(venueOrName = null) {
  const cfg = getCourtConfig(venueOrName);
  if (cfg && Array.isArray(cfg.ignoredCourts) && cfg.ignoredCourts.length > 0) {
    return cfg.ignoredCourts;
  }
  const envVal = process.env.IGNORED_COURTS || process.env.IGNORED_COURT || '';
  if (envVal && envVal.trim()) {
    return envVal.split(/[,;]+/).map(s => s.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Checks whether a given court name is configured to be ignored.
 */
function isIgnoredCourt(courtName, venueOrName = null) {
  if (!courtName) return false;
  const ignoredList = getIgnoredCourts(venueOrName);
  if (!ignoredList || ignoredList.length === 0) return false;

  const cleanCourt = String(courtName).trim().toLowerCase();

  for (const item of ignoredList) {
    const cleanItem = String(item).trim().toLowerCase();
    if (!cleanItem) continue;
    if (cleanCourt === cleanItem) return true;

    // Check by number: e.g. item "4" matches "Court 4", "Ct 4", "4"
    const itemNumMatch = cleanItem.match(/\b(\d+)\b/);
    const courtNumMatch = cleanCourt.match(/\b(?:court|ct)?\s*(\\d+)\b/i);
    if (itemNumMatch && courtNumMatch && itemNumMatch[1] === courtNumMatch[1]) {
      return true;
    }

    // Regex boundary check: e.g. item "court 4" matches "court 4 (90m)"
    const itemEscaped = cleanItem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`\\b${itemEscaped}\\b`, 'i').test(cleanCourt)) {
      return true;
    }
  }

  return false;
}

/**
 * Logs court configurations found in courts.json to the console.
 */
function logCourtConfigs() {
  const configs = getAllCourtConfigs();
  if (configs.length > 0) {
    const summary = configs.map((c) => `${c.name} (${c.system})`).join(", ");
    console.log(`🎾 Court configurations found from courts.json: [${summary}]`);
  } else {
    console.log("🎾 No court configurations found in config/courts.json.");
  }
}

function saveRawConfig(cfg) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    fs.writeFileSync(COURTS_FILE, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
    cachedConfig = cfg;
    return true;
  } catch (err) {
    console.error('⚠️ Failed to save courts.json:', err.message);
    return false;
  }
}

module.exports = {
  CONFIG_DIR,
  COURTS_FILE,
  loadRawConfig,
  reloadConfig,
  getCourtConfig,
  getSystemConfig,
  getAllCourtConfigs,
  getCourtConfigsBySystem,
  getCourtSystems,
  getIgnoredCourts,
  isIgnoredCourt,
  saveRawConfig,
  normalizeConfigs,
  logCourtConfigs
};
