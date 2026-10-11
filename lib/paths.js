const path = require('path');
const fs = require('fs');

if (!process.env.CONFIG_DIR && !process.env.DATA_DIR) {
  try {
    require('dotenv').config();
  } catch (e) {}
}

const APP_ROOT = path.resolve(__dirname, '..');

/**
 * Resolves an application path.
 * If envVal is provided and absolute, returns normalized absolute path.
 * If envVal is provided and relative, resolves relative to APP_ROOT.
 * If envVal is omitted or empty, resolves defaultRelative relative to APP_ROOT.
 */
function resolveAppPath(envVal, defaultRelative) {
  const raw = (envVal && typeof envVal === 'string') ? envVal.trim() : '';
  const target = raw || defaultRelative;
  return path.isAbsolute(target) ? path.normalize(target) : path.resolve(APP_ROOT, target);
}

function getConfigDir() {
  return resolveAppPath(
    process.env.CONFIG_DIR || process.env.CONFIG_PATH || process.env.CONFIG_FOLDER,
    'config'
  );
}

function getDataDir() {
  return resolveAppPath(
    process.env.DATA_DIR || process.env.DATA_PATH || process.env.DATA_FOLDER,
    'data'
  );
}

module.exports = {
  APP_ROOT,
  resolveAppPath,
  getConfigDir,
  getDataDir,
  get CONFIG_DIR() {
    return getConfigDir();
  },
  get DATA_DIR() {
    return getDataDir();
  },
  get GROUPS_FILE() {
    return path.join(getConfigDir(), 'groups.json');
  },
  get COURTS_FILE() {
    return path.join(getConfigDir(), 'courts.json');
  }
};
