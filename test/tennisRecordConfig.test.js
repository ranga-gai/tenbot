const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const tennisRecordConfig = require('../lib/tennisRecordConfig');
const tennisRecord = require('../lib/tennisRecord');
const { TENNIS_RECORD_FILE } = require('../lib/paths');

describe('tennisRecordConfig', () => {
  let origConfigFileContent = null;
  const testConfigFile = TENNIS_RECORD_FILE;

  beforeEach(() => {
    if (fs.existsSync(testConfigFile)) {
      origConfigFileContent = fs.readFileSync(testConfigFile, 'utf8');
    } else {
      origConfigFileContent = null;
    }
  });

  afterEach(() => {
    delete process.env.TENNISRECORD_URL;
    delete process.env.TENNISRECORD_TIMEOUT;
    delete process.env.TENNISRECORD_CERT_STATUS;
    delete process.env.TENNISRECORD_ENABLED;

    if (origConfigFileContent !== null) {
      fs.writeFileSync(testConfigFile, origConfigFileContent, 'utf8');
    } else if (fs.existsSync(testConfigFile)) {
      fs.unlinkSync(testConfigFile);
    }
    tennisRecordConfig.reloadConfig();
  });

  describe('normalization helpers', () => {
    it('should normalize URLs with protocols and strip trailing slashes', () => {
      assert.equal(tennisRecordConfig.normalizeUrl('tennisrecord.com/'), 'https://tennisrecord.com');
      assert.equal(tennisRecordConfig.normalizeUrl('http://custom.com///'), 'http://custom.com');
      assert.equal(tennisRecordConfig.normalizeUrl('https://www.tennisrecord.com'), 'https://www.tennisrecord.com');
      assert.equal(tennisRecordConfig.normalizeUrl(null), 'https://www.tennisrecord.com');
    });

    it('should normalize certStatus values', () => {
      assert.equal(tennisRecordConfig.normalizeCertStatus('suspended'), 'suspended');
      assert.equal(tennisRecordConfig.normalizeCertStatus('insecure'), 'suspended');
      assert.equal(tennisRecordConfig.normalizeCertStatus('skip'), 'suspended');
      assert.equal(tennisRecordConfig.normalizeCertStatus(true), 'suspended');

      assert.equal(tennisRecordConfig.normalizeCertStatus('active'), 'active');
      assert.equal(tennisRecordConfig.normalizeCertStatus('strict'), 'active');
      assert.equal(tennisRecordConfig.normalizeCertStatus('resumed'), 'active');
      assert.equal(tennisRecordConfig.normalizeCertStatus(false), 'active');

      assert.equal(tennisRecordConfig.normalizeCertStatus('unknown'), 'suspended');
    });

    it('should normalize timeout settings in ms or seconds', () => {
      assert.equal(tennisRecordConfig.normalizeTimeout(8000), 8000);
      assert.equal(tennisRecordConfig.normalizeTimeout('8000'), 8000);
      // Seconds conversion (< 100)
      assert.equal(tennisRecordConfig.normalizeTimeout(10), 10000);
      assert.equal(tennisRecordConfig.normalizeTimeout('6.5'), 6500);
      // Defaults
      assert.equal(tennisRecordConfig.normalizeTimeout(null), 6000);
      assert.equal(tennisRecordConfig.normalizeTimeout(0), 6000);
      assert.equal(tennisRecordConfig.normalizeTimeout(-5), 6000);
    });
  });

  describe('configuration loading and getters', () => {
    it('should return default configuration when no overrides are set', () => {
      const cfg = tennisRecordConfig.getConfig();
      assert.ok(cfg);
      assert.equal(cfg.url, 'https://www.tennisrecord.com');
      assert.equal(cfg.searchUrl, 'https://www.tennisrecord.com/adult/search.aspx');
      assert.equal(typeof cfg.timeout, 'number');
      assert.ok(cfg.timeout >= 1000);
      assert.equal(typeof cfg.certStatus, 'string');
      assert.equal(typeof cfg.isCertCheckSuspended, 'boolean');
      assert.equal(cfg.enabled, true);
      assert.equal(cfg.preferredCity, 'San Jose');
      assert.ok(Array.isArray(cfg.nearbyCities));
      assert.ok(cfg.nearbyCities.includes('santa clara'));
    });

    it('should respect environment variable overrides', () => {
      process.env.TENNISRECORD_URL = 'https://custom-tr.example.com';
      process.env.TENNISRECORD_TIMEOUT = '12000';
      process.env.TENNISRECORD_CERT_STATUS = 'strict';
      process.env.TENNISRECORD_ENABLED = 'false';

      const cfg = tennisRecordConfig.reloadConfig();
      assert.equal(cfg.url, 'https://custom-tr.example.com');
      assert.equal(cfg.searchUrl, 'https://custom-tr.example.com/adult/search.aspx');
      assert.equal(cfg.timeout, 12000);
      assert.equal(cfg.certStatus, 'active');
      assert.equal(cfg.isCertCheckSuspended, false);
      assert.equal(cfg.enabled, false);
    });
  });

  describe('updating and persisting configuration', () => {
    it('should update configuration and save to file', () => {
      const updated = tennisRecordConfig.updateConfig({
        timeout: 9000,
        certStatus: 'active'
      });

      assert.equal(updated.timeout, 9000);
      assert.equal(updated.certStatus, 'active');
      assert.equal(tennisRecordConfig.getTimeout(), 9000);
      assert.equal(tennisRecordConfig.getCertStatus(), 'active');
      assert.equal(tennisRecordConfig.isCertCheckSuspended(), false);

      // Verify file persistence
      assert.ok(fs.existsSync(testConfigFile));
      const parsed = JSON.parse(fs.readFileSync(testConfigFile, 'utf8'));
      assert.equal(parsed.timeout, 9000);
      assert.equal(parsed.certStatus, 'active');
    });

    it('should toggle SSL certificate check with setCertCheckSuspended', () => {
      tennisRecordConfig.setCertCheckSuspended(true);
      assert.equal(tennisRecordConfig.getCertStatus(), 'suspended');
      assert.equal(tennisRecordConfig.isCertCheckSuspended(), true);

      tennisRecordConfig.setCertCheckSuspended(false);
      assert.equal(tennisRecordConfig.getCertStatus(), 'active');
      assert.equal(tennisRecordConfig.isCertCheckSuspended(), false);
    });

    it('should format configuration as readable string', () => {
      const formatted = tennisRecordConfig.formatConfig();
      assert.ok(formatted.includes('TennisRecord Configuration'));
      assert.ok(formatted.includes('URL'));
      assert.ok(formatted.includes('SSL Cert Status'));
      assert.ok(formatted.includes('Timeout'));
    });
  });

  describe('tennisRecord module integration', () => {
    it('should expose config through tennisRecord module', () => {
      assert.ok(tennisRecord.config);
      assert.equal(typeof tennisRecord.getConfig, 'function');
      assert.equal(typeof tennisRecord.updateConfig, 'function');
      assert.equal(typeof tennisRecord.formatConfig, 'function');

      const cfg = tennisRecord.getConfig();
      assert.equal(cfg.url, tennisRecordConfig.getUrl());
    });

    it('should keep tennisRecord.suspendCertCheck and resumeCertCheck in sync with config', () => {
      tennisRecord.suspendCertCheck();
      assert.equal(tennisRecord.getCertCheckSuspended(), true);
      assert.equal(tennisRecordConfig.isCertCheckSuspended(), true);

      tennisRecord.resumeCertCheck();
      assert.equal(tennisRecord.getCertCheckSuspended(), false);
      assert.equal(tennisRecordConfig.isCertCheckSuspended(), false);
    });

    it('should return disabled reason when TennisRecord is disabled in config', async () => {
      tennisRecordConfig.updateConfig({ enabled: false });
      try {
        const res = await tennisRecord.fetchTennisRecordRating('Roger Federer');
        assert.ok(res);
        assert.equal(res.success, false);
        assert.equal(res.disabled, true);
        assert.equal(res.reason, 'disabled');
      } finally {
        tennisRecordConfig.updateConfig({ enabled: true });
      }
    });
  });
});
