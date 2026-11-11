try { require('dotenv').config(); } catch (e) {}
const fs = require('fs');
const path = require('path');
const { TENNIS_RECORD_FILE, CONFIG_DIR, GROUPS_FILE } = require('./paths');

const DEFAULT_NEARBY_CITIES = [
  'santa clara', 'sunnyvale', 'cupertino', 'saratoga', 'campbell',
  'milpitas', 'mountain view', 'los gatos', 'palo alto', 'los altos',
  'fremont', 'newark', 'union city', 'morgan hill', 'gilroy',
  'san francisco', 'oakland', 'pleasanton', 'dublin', 'san ramon',
  'san mateo', 'redwood city', 'menlo park', 'foster city', 'san carlos',
  'belmont', 'burlingame'
];

const DEFAULT_CONFIG = {
  url: 'https://www.tennisrecord.com',
  certStatus: 'suspended', // 'suspended' (insecure/skip) or 'active' (strict verification)
  timeout: 6000,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  maxRedirects: 3,
  preferredLocation: 'San Jose, CA',
  preferredCity: 'San Jose',
  nearbyCities: DEFAULT_NEARBY_CITIES,
  refreshIntervalDays: 14,
  enabled: true
};

function normalizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return DEFAULT_CONFIG.url;
  let trimmed = rawUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }
  return trimmed.replace(/\/+$/, '');
}

function normalizeCertStatus(val) {
  if (val === true || val === 'true') return 'suspended';
  if (val === false || val === 'false') return 'active';
  if (typeof val === 'string') {
    const lower = val.trim().toLowerCase();
    if (['suspended', 'insecure', 'skip', 'disabled', 'off'].includes(lower)) {
      return 'suspended';
    }
    if (['active', 'strict', 'resumed', 'enabled', 'on', 'verify', 'verified'].includes(lower)) {
      return 'active';
    }
  }
  return 'suspended';
}

function normalizeTimeout(val) {
  if (val === undefined || val === null || val === '') return DEFAULT_CONFIG.timeout;
  const num = Number(val);
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_CONFIG.timeout;
  // If provided in seconds (e.g. 6 or 10), convert to ms
  if (num <= 100) return Math.round(num * 1000);
  return Math.round(num);
}

function normalizeCities(cities) {
  if (!cities) return DEFAULT_NEARBY_CITIES;
  if (Array.isArray(cities)) {
    const list = cities.map(c => String(c).trim().toLowerCase()).filter(Boolean);
    return list.length > 0 ? list : DEFAULT_NEARBY_CITIES;
  }
  if (typeof cities === 'string') {
    const list = cities.split(/[,;\n]+/).map(c => c.trim().toLowerCase()).filter(Boolean);
    return list.length > 0 ? list : DEFAULT_NEARBY_CITIES;
  }
  return DEFAULT_NEARBY_CITIES;
}

function loadRawConfig() {
  try {
    const filePath = TENNIS_RECORD_FILE;
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error('⚠️ Failed to read tennisrecord.json:', err.message);
  }

  // Fallback: check groups.json for a "tennisRecord" entry
  try {
    if (fs.existsSync(GROUPS_FILE)) {
      const gRaw = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf-8'));
      if (gRaw && typeof gRaw === 'object') {
        if (gRaw.tennisRecord && typeof gRaw.tennisRecord === 'object') {
          return gRaw.tennisRecord;
        }
        if (gRaw.defaults?.tennisRecord && typeof gRaw.defaults.tennisRecord === 'object') {
          return gRaw.defaults.tennisRecord;
        }
      }
    }
  } catch (err) {
    // Ignore fallback failure
  }

  return null;
}

let cachedConfig = null;

function resolveConfig() {
  const raw = loadRawConfig() || {};

  // Environment variable overrides
  const envUrl = process.env.TENNISRECORD_URL || process.env.TENNIS_RECORD_URL;
  const envCertStatus = process.env.TENNISRECORD_CERT_STATUS || process.env.TENNISRECORD_CERTSTATUS || process.env.TENNIS_RECORD_CERTSTATUS;
  const envTimeout = process.env.TENNISRECORD_TIMEOUT || process.env.TENNIS_RECORD_TIMEOUT;
  const envEnabled = process.env.TENNISRECORD_ENABLED;
  const envUserAgent = process.env.TENNISRECORD_USER_AGENT;
  const envPrefLoc = process.env.TENNISRECORD_PREFERRED_LOCATION;
  const envRefreshDays = process.env.TENNISRECORD_REFRESH_INTERVAL_DAYS;

  const url = normalizeUrl(envUrl || raw.url || raw.baseUrl || raw.host);
  const certStatus = normalizeCertStatus(envCertStatus !== undefined ? envCertStatus : (raw.certStatus !== undefined ? raw.certStatus : raw.certstatus));
  const timeout = normalizeTimeout(envTimeout !== undefined ? envTimeout : (raw.timeout !== undefined ? raw.timeout : raw.timeoutMs));
  const userAgent = (envUserAgent || raw.userAgent || raw.user_agent || DEFAULT_CONFIG.userAgent).trim();
  const maxRedirects = Number.isInteger(Number(raw.maxRedirects)) ? Math.max(0, Number(raw.maxRedirects)) : DEFAULT_CONFIG.maxRedirects;
  const preferredLocation = (envPrefLoc || raw.preferredLocation || raw.location || DEFAULT_CONFIG.preferredLocation).trim();
  const preferredCity = (raw.preferredCity || preferredLocation.split(',')[0] || DEFAULT_CONFIG.preferredCity).trim();
  const nearbyCities = normalizeCities(raw.nearbyCities);
  const refreshIntervalDays = Math.max(1, Number(envRefreshDays || raw.refreshIntervalDays) || DEFAULT_CONFIG.refreshIntervalDays);
  const enabled = envEnabled !== undefined ? (envEnabled === 'true' || envEnabled === '1') : (raw.enabled !== undefined ? Boolean(raw.enabled) : DEFAULT_CONFIG.enabled);

  return {
    url,
    searchUrl: `${url}/adult/search.aspx`,
    certStatus,
    isCertCheckSuspended: certStatus === 'suspended',
    timeout,
    userAgent,
    maxRedirects,
    preferredLocation,
    preferredCity,
    nearbyCities,
    refreshIntervalDays,
    refreshIntervalMs: refreshIntervalDays * 24 * 60 * 60 * 1000,
    enabled
  };
}

function getConfig() {
  if (!cachedConfig) {
    cachedConfig = resolveConfig();
  }
  return cachedConfig;
}

function reloadConfig() {
  cachedConfig = resolveConfig();
  return cachedConfig;
}

function saveConfig(newConfig) {
  try {
    const configDir = CONFIG_DIR;
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    const current = loadRawConfig() || {};
    const toSave = {
      ...current,
      ...newConfig
    };
    fs.writeFileSync(TENNIS_RECORD_FILE, JSON.stringify(toSave, null, 2), 'utf-8');
    cachedConfig = resolveConfig();
    return cachedConfig;
  } catch (err) {
    console.error('⚠️ Failed to save tennisrecord.json:', err.message);
    throw err;
  }
}

function updateConfig(partial) {
  if (!partial || typeof partial !== 'object') return getConfig();
  const allowedKeys = [
    'url', 'certStatus', 'certstatus', 'timeout', 'userAgent',
    'maxRedirects', 'preferredLocation', 'preferredCity', 'nearbyCities',
    'refreshIntervalDays', 'enabled'
  ];
  const toUpdate = {};
  for (const [k, v] of Object.entries(partial)) {
    if (allowedKeys.includes(k) && v !== undefined) {
      if (k === 'certstatus') toUpdate.certStatus = normalizeCertStatus(v);
      else if (k === 'certStatus') toUpdate.certStatus = normalizeCertStatus(v);
      else if (k === 'url') toUpdate.url = normalizeUrl(v);
      else if (k === 'timeout') toUpdate.timeout = normalizeTimeout(v);
      else toUpdate[k] = v;
    }
  }
  return saveConfig(toUpdate);
}

function getUrl() {
  return getConfig().url;
}

function getSearchUrl() {
  return getConfig().searchUrl;
}

function getCertStatus() {
  return getConfig().certStatus;
}

function isCertCheckSuspended() {
  return getConfig().isCertCheckSuspended;
}

function setCertStatus(status) {
  const norm = normalizeCertStatus(status);
  updateConfig({ certStatus: norm });
  return norm;
}

function setCertCheckSuspended(suspended) {
  return setCertStatus(suspended ? 'suspended' : 'active') === 'suspended';
}

function getTimeout() {
  return getConfig().timeout;
}

function getUserAgent() {
  return getConfig().userAgent;
}

function getMaxRedirects() {
  return getConfig().maxRedirects;
}

function getPreferredLocation() {
  return getConfig().preferredLocation;
}

function getPreferredCity() {
  return getConfig().preferredCity;
}

function getNearbyCities() {
  return getConfig().nearbyCities;
}

function getRefreshIntervalMs() {
  return getConfig().refreshIntervalMs;
}

function getRefreshIntervalDays() {
  return getConfig().refreshIntervalDays;
}

function isEnabled() {
  return getConfig().enabled;
}

function formatConfig() {
  const cfg = getConfig();
  const certDesc = cfg.isCertCheckSuspended
    ? '*SUSPENDED* (insecure / expired certs allowed)'
    : '*ACTIVE* (strict SSL verification)';
  const timeoutSec = (cfg.timeout / 1000).toFixed(1);

  return (
    `⚙️ *TennisRecord Configuration*:\n` +
    `• *URL*: ${cfg.url}\n` +
    `• *SSL Cert Status*: ${certDesc}\n` +
    `• *Timeout*: ${cfg.timeout}ms (${timeoutSec}s)\n` +
    `• *Status*: ${cfg.enabled ? 'Enabled' : 'Disabled'}\n` +
    `• *Preferred Location*: ${cfg.preferredLocation}\n` +
    `• *Refresh Interval*: ${cfg.refreshIntervalDays} days\n` +
    `• *Max Redirects*: ${cfg.maxRedirects}`
  );
}

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_NEARBY_CITIES,
  loadRawConfig,
  getConfig,
  reloadConfig,
  saveConfig,
  updateConfig,
  normalizeUrl,
  normalizeCertStatus,
  normalizeTimeout,
  getUrl,
  getSearchUrl,
  getCertStatus,
  isCertCheckSuspended,
  setCertStatus,
  setCertCheckSuspended,
  getTimeout,
  getUserAgent,
  getMaxRedirects,
  getPreferredLocation,
  getPreferredCity,
  getNearbyCities,
  getRefreshIntervalMs,
  getRefreshIntervalDays,
  isEnabled,
  formatConfig
};
