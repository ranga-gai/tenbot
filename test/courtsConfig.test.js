const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isIgnoredCourt,
  getAllCourtConfigs,
  getCourtConfig,
  isTentativeBookingTitle,
  matchesTentativePattern
} = require('../lib/courtsConfig');

describe('courtsConfig', () => {
  it('should retrieve court configuration by name (e.g. SCVCC)', () => {
    const config = getCourtConfig('SCVCC');
    if (config) {
      assert.equal(typeof config.name, 'string');
      assert.match(config.name, /SCVCC/i);
    }
  });

  it('should return all court configs as a map or array', () => {
    const all = getAllCourtConfigs();
    assert.ok(all);
    assert.equal(typeof all, 'object');
  });

  it('should return false for valid court when not configured as ignored', () => {
    assert.equal(isIgnoredCourt('Court 999'), false);
    assert.equal(isIgnoredCourt(''), false);
    assert.equal(isIgnoredCourt(null), false);
  });
  it("should support regex and string match for tentative booking titles in courtsConfig", () => {
    const courtsConfig = require("../lib/courtsConfig");
    const origGetTentative = courtsConfig.getTentativeBookingTitles;
    try {
      courtsConfig.getTentativeBookingTitles = () => [
        "Clinic",
        "/^Team Practice/i",
        "/Junior.*Clinic/i"
      ];
      assert.equal(isTentativeBookingTitle("Adult Tennis Clinic"), true);
      assert.equal(isTentativeBookingTitle("Team Practice Ct 1"), true);
      assert.equal(isTentativeBookingTitle("Early Team Practice"), false);
      assert.equal(isTentativeBookingTitle("Junior Tennis Clinic"), true);
      assert.equal(isTentativeBookingTitle("Private Lesson"), false);
    } finally {
      courtsConfig.getTentativeBookingTitles = origGetTentative;
    }
  });
});
