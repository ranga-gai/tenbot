const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeBookingPlayerLists,
  parseBookingSchedule,
  isSuperAdmin,
  loadRawConfig,
  saveRawConfig,
  getGroupJid,
  pauseCourtBookings,
  resumeCourtBookings,
  isTentativeBookingTitle,
  matchesTentativePattern
} = require('../lib/groupsConfig');

describe('groupsConfig', () => {
  describe('normalizeBookingPlayerLists', () => {
    it('should normalize comma/semicolon delimited string to array of arrays', () => {
      const res = normalizeBookingPlayerLists('Alice, Bob; Charlie');
      assert.deepEqual(res, [['Alice', 'Bob'], ['Charlie']]);
    });

    it('should normalize 1D array of player names to 2D array', () => {
      const res = normalizeBookingPlayerLists(['Alice', 'Bob']);
      assert.deepEqual(res, [['Alice', 'Bob']]);
    });

    it('should preserve 2D array for multi-court bookings', () => {
      const input = [['Alice', 'Bob'], ['Charlie', 'Dave']];
      const res = normalizeBookingPlayerLists(input);
      assert.deepEqual(res, [['Alice', 'Bob'], ['Charlie', 'Dave']]);
    });

    it('should return empty array for null/undefined/empty input', () => {
      assert.deepEqual(normalizeBookingPlayerLists(null), []);
      assert.deepEqual(normalizeBookingPlayerLists(''), []);
      assert.deepEqual(normalizeBookingPlayerLists([]), []);
    });
  });

  describe('parseBookingSchedule', () => {
    it('should parse "-7days 7:00AM"', () => {
      const res = parseBookingSchedule('-7days 7:00AM');
      assert.ok(res);
      assert.equal(res.daysBefore, 7);
      assert.equal(res.hour, 7);
      assert.equal(res.minute, 0);
      assert.equal(res.formatted, '7am');
    });

    it('should parse "-1day 8:30pm"', () => {
      const res = parseBookingSchedule('-1day 8:30pm');
      assert.ok(res);
      assert.equal(res.daysBefore, 1);
      assert.equal(res.hour, 20);
      assert.equal(res.minute, 30);
      assert.equal(res.formatted, '8:30pm');
    });

    it('should return null for empty input', () => {
      assert.equal(parseBookingSchedule(''), null);
      assert.equal(parseBookingSchedule(null), null);
    });
  });

  describe('isSuperAdmin', () => {
    it('should return false for null or undefined sender', () => {
      assert.equal(isSuperAdmin(null), false);
      assert.equal(isSuperAdmin(undefined), false);
    });
  });

  describe('getGroupJid', () => {
    it('should resolve group JID by name, alias, or direct JID', () => {
      const jidByName = getGroupJid('Bot-testing');
      assert.ok(jidByName);
      assert.ok(jidByName.endsWith('@g.us'));
      const jidByDirect = getGroupJid(jidByName);
      assert.equal(jidByDirect, jidByName);
    });
  });

  describe('pauseCourtBookings and resumeCourtBookings', () => {
    it('should pause and resume court bookings for a specific group while preserving courtConfig', () => {
      const origConfig = JSON.parse(JSON.stringify(loadRawConfig() || {}));
      try {
        const resPause = pauseCourtBookings('Bot-testing');
        assert.ok(resPause);
        assert.equal(resPause.all, false);
        const cfgPaused = loadRawConfig();
        const groupKey = resPause.jid;
        assert.equal(cfgPaused.groups[groupKey].courtBookingEnabled, false);
        assert.equal(cfgPaused.groups[groupKey].courtConfig, 'SCVCC');

        const resResume = resumeCourtBookings('Bot-testing');
        assert.ok(resResume);
        assert.equal(resResume.all, false);
        const cfgResumed = loadRawConfig();
        assert.equal(cfgResumed.groups[groupKey].courtBookingEnabled, true);
        assert.equal(cfgResumed.groups[groupKey].courtConfig, 'SCVCC');
      } finally {
        saveRawConfig(origConfig);
      }
    });

    it('should pause and resume court bookings for all groups', () => {
      const origConfig = JSON.parse(JSON.stringify(loadRawConfig() || {}));
      try {
        const resPause = pauseCourtBookings('all');
        assert.ok(resPause);
        assert.equal(resPause.all, true);
        assert.ok(Array.isArray(resPause.affected));
        const cfgPaused = loadRawConfig();
        assert.equal(cfgPaused.defaults.courtBookingEnabled, false);
        for (const g of Object.values(cfgPaused.groups)) {
          assert.equal(g.courtBookingEnabled, false);
        }

        const resResume = resumeCourtBookings('all');
        assert.ok(resResume);
        assert.equal(resResume.all, true);
        const cfgResumed = loadRawConfig();
        assert.equal(cfgResumed.defaults.courtBookingEnabled, true);
        for (const g of Object.values(cfgResumed.groups)) {
          assert.equal(g.courtBookingEnabled, true);
        }
      } finally {
        saveRawConfig(origConfig);
      }
    });
  });

  describe("isTentativeBookingTitle and matchesTentativePattern", () => {
    it("should match plain string substrings case-insensitively", () => {
      assert.equal(matchesTentativePattern("Adult Tennis Clinic", "Clinic"), true);
      assert.equal(matchesTentativePattern("tennis clinic", "Clinic"), true);
      assert.equal(matchesTentativePattern("Private Lesson", "Clinic"), false);
      assert.equal(matchesTentativePattern(null, "Clinic"), false);
      assert.equal(matchesTentativePattern("Clinic", null), false);
    });

    it("should match regex literal string in /pattern/flags format", () => {
      assert.equal(matchesTentativePattern("Team Practice - Ct 1", "/^Team Practice/i"), true);
      assert.equal(matchesTentativePattern("team practice", "/^Team Practice/i"), true);
      assert.equal(matchesTentativePattern("Morning Team Practice", "/^Team Practice/i"), false);

      assert.equal(matchesTentativePattern("Junior Tennis Clinic", "/Junior.*Clinic/i"), true);
      assert.equal(matchesTentativePattern("Adult Clinic", "/Junior.*Clinic/i"), false);

      // Exact matching with ^...$
      assert.equal(matchesTentativePattern("Club Event", "/^Club Event$/i"), true);
      assert.equal(matchesTentativePattern("Club Event Special", "/^Club Event$/i"), false);
    });

    it("should match raw regex pattern strings", () => {
      assert.equal(matchesTentativePattern("Junior Tennis Clinic", "^Junior.*Clinic"), true);
      assert.equal(matchesTentativePattern("Adult Clinic", "^Junior.*Clinic"), false);
      assert.equal(matchesTentativePattern("Clinic Match Play", "^Clinic.*Play$"), true);
      assert.equal(matchesTentativePattern("Sunday Clinic Match Play", "^Clinic.*Play$"), false);
    });

    it("should support RegExp instances", () => {
      assert.equal(matchesTentativePattern("Adult Clinic", /^Adult Clinic$/i), true);
      assert.equal(matchesTentativePattern("Junior Clinic", /^Adult Clinic$/i), false);
    });

    it("should safely handle invalid regex strings without throwing", () => {
      assert.equal(matchesTentativePattern("Some Title", "/[unclosed/i"), false);
      assert.equal(matchesTentativePattern("Some Title", "[unclosed"), false);
    });

    it("should evaluate tentative booking titles using isTentativeBookingTitle", () => {
      const groupsConfig = require("../lib/groupsConfig");
      const origGetConfig = groupsConfig.getGroupConfig;
      try {
        groupsConfig.getGroupConfig = () => ({
          tentativeBookingTitles: [
            "Clinic",
            "/^Team Practice/i",
            "/Junior.*Clinic/i",
            "/^Club Event$/i"
          ]
        });
        assert.equal(isTentativeBookingTitle("Adult Tennis Clinic"), true);
        assert.equal(isTentativeBookingTitle("Team Practice - 1"), true);
        assert.equal(isTentativeBookingTitle("Early Team Practice"), false);
        assert.equal(isTentativeBookingTitle("Junior League Clinic"), true);
        assert.equal(isTentativeBookingTitle("Club Event"), true);
        assert.equal(isTentativeBookingTitle("Club Event Party"), false);
        assert.equal(isTentativeBookingTitle("Regular Booking"), false);
        assert.equal(isTentativeBookingTitle(""), false);
        assert.equal(isTentativeBookingTitle(null), false);
      } finally {
        groupsConfig.getGroupConfig = origGetConfig;
      }
    });
  });
});
