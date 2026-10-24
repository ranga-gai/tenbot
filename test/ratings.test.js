const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  keyFor,
  isPlaceholder,
  pairRating,
  formatRating,
  applyResult,
  MIN_RATING,
  MAX_RATING
} = require('../lib/ratings');

describe('ratings', () => {
  describe('keyFor', () => {
    it('should normalize and lowercase names', () => {
      assert.equal(keyFor('Roger Federer'), 'roger federer');
      assert.equal(keyFor('  ALICE  '), 'alice');
    });

    it('should return empty string for null/undefined/empty', () => {
      assert.equal(keyFor(''), '');
      assert.equal(keyFor(null), '');
      assert.equal(keyFor(undefined), '');
    });
  });

  describe('isPlaceholder', () => {
    it('should return true for generic placeholders', () => {
      assert.equal(isPlaceholder('Player 1'), true);
      assert.equal(isPlaceholder('player 2'), true);
      assert.equal(isPlaceholder('someone'), true);
      assert.equal(isPlaceholder('me'), true);
      assert.equal(isPlaceholder('creator'), true);
      assert.equal(isPlaceholder(''), true);
    });

    it('should return false for actual player names', () => {
      assert.equal(isPlaceholder('Roger'), false);
      assert.equal(isPlaceholder('Alice'), false);
      assert.equal(isPlaceholder('Pramod Immaneni'), false);
    });
  });

  describe('pairRating', () => {
    it('should sum ratings of players from ratingMap', () => {
      const map = new Map([
        ['Alice', 3.5],
        ['Bob', 4.0]
      ]);
      assert.equal(pairRating(['Alice', 'Bob'], map), 7.5);
    });
  });

  describe('formatRating', () => {
    it('should format numbers with 2 decimal places', () => {
      assert.equal(formatRating(3.5), '3.50');
      assert.equal(formatRating(4), '4.00');
      assert.equal(formatRating(3.75), '3.75');
    });
  });

  describe('applyResult', () => {
    it('should adjust ratings upward for winners and downward for losers', () => {
      const winners = ['Alice'];
      const losers = ['Bob'];
      const sets = [[6, 4]];

      const res = applyResult(winners, losers, sets);
      assert.ok(res);
      assert.ok(Array.isArray(res.sets));
      assert.ok(Array.isArray(res.changes));

      const aliceChange = res.changes.find((c) => c.name === 'Alice');
      const bobChange = res.changes.find((c) => c.name === 'Bob');

      assert.ok(aliceChange);
      assert.ok(bobChange);
      assert.ok(aliceChange.to >= aliceChange.from);
      assert.ok(bobChange.to <= bobChange.from);
    });
  });

  describe("tennisRecord location classification", () => {
    const {
      isSanJoseLocation,
      isSanJoseOrNearbyLocation,
      rankLocation
    } = require("../lib/tennisRecord");

    it("should correctly identify San Jose locations", () => {
      assert.equal(isSanJoseLocation("San Jose, CA"), true);
      assert.equal(isSanJoseLocation("San Jose"), true);
      assert.equal(isSanJoseLocation("Santa Clara, CA"), false);
      assert.equal(isSanJoseLocation("Dallas, TX"), false);
      assert.equal(isSanJoseLocation(""), false);
    });

    it("should correctly identify San Jose and nearby Bay Area locations", () => {
      assert.equal(isSanJoseOrNearbyLocation("San Jose, CA"), true);
      assert.equal(isSanJoseOrNearbyLocation("Santa Clara, CA"), true);
      assert.equal(isSanJoseOrNearbyLocation("Sunnyvale, CA"), true);
      assert.equal(isSanJoseOrNearbyLocation("Fremont, CA"), true);
      assert.equal(isSanJoseOrNearbyLocation("Dallas, TX"), false);
      assert.equal(isSanJoseOrNearbyLocation("Austin, TX"), false);
      assert.equal(isSanJoseOrNearbyLocation("New York, NY"), false);
      assert.equal(isSanJoseOrNearbyLocation(""), false);
    });
  });

  describe("tennisRecord: false handling and superadmin alerts", () => {
    const tennisRecord = require("../lib/tennisRecord");
    const ratings = require("../lib/ratings");
    const origFetch = tennisRecord.fetchTennisRecordRating;

    function restore() {
      tennisRecord.fetchTennisRecordRating = origFetch;
      ratings.clearAlertsCache();
      ratings.setBotSocket(null);
    }

    it("should set tennisRecord: false and rating to 3.49 and alert superadmin when profile not found", async () => {
      tennisRecord.fetchTennisRecordRating = async () => ({
        success: false,
        tennisRecord: false,
        rating: null,
        profileUrl: null,
        location: null,
        reason: "not_found"
      });

      const sentAlerts = [];
      const mockSock = {
        sendMessage: async (jid, content) => {
          sentAlerts.push({ jid, content });
          return { key: { id: "alert-1" } };
        }
      };
      ratings.setBotSocket(mockSock);

      try {
        const res = await ratings.updateRatingFromFullName("test_player_not_found", "Unknown Person", { sock: mockSock });
        assert.equal(res.rating, 3.49);
        assert.equal(res.tennisRecord, false);
        assert.equal(res.failureReason, "not_found");

        assert.equal(sentAlerts.length >= 1, true, "Superadmin should have received an alert message");
        assert.match(sentAlerts[0].content.text, /Profile not found on TennisRecord.com/);
        assert.match(sentAlerts[0].content.text, /Unknown Person/);
        assert.match(sentAlerts[0].content.text, /tennisRecord: false/);
      } finally {
        restore();
      }
    });

    it("should set tennisRecord: false, rating to 3.49 and alert superadmin when not in San Jose or nearby areas", async () => {
      tennisRecord.fetchTennisRecordRating = async () => ({
        success: false,
        tennisRecord: false,
        rating: null,
        profileUrl: null,
        location: null,
        reason: "not_in_area",
        details: { locations: ["Dallas, TX", "Austin, TX"] }
      });

      const sentAlerts = [];
      const mockSock = {
        sendMessage: async (jid, content) => {
          sentAlerts.push({ jid, content });
          return { key: { id: "alert-2" } };
        }
      };
      ratings.setBotSocket(mockSock);

      try {
        const res = await ratings.updateRatingFromFullName("test_player_tx", "Texas Player", { sock: mockSock });
        assert.equal(res.rating, 3.49);
        assert.equal(res.tennisRecord, false);
        assert.equal(res.failureReason, "not_in_area");

        assert.equal(sentAlerts.length >= 1, true);
        assert.match(sentAlerts[0].content.text, /not within San Jose or nearby areas/);
        assert.match(sentAlerts[0].content.text, /Dallas, TX/);
      } finally {
        restore();
      }
    });

    it("should set tennisRecord: false, rating to 3.49 and alert superadmin when multiple players found in San Jose", async () => {
      tennisRecord.fetchTennisRecordRating = async () => ({
        success: false,
        tennisRecord: false,
        rating: null,
        profileUrl: null,
        location: "San Jose, CA",
        reason: "multiple_in_san_jose",
        details: {
          sanJoseCount: 2,
          candidates: [
            { pName: "David Lee", location: "San Jose, CA" },
            { pName: "David Lee", location: "San Jose, CA" }
          ]
        }
      });

      const sentAlerts = [];
      const mockSock = {
        sendMessage: async (jid, content) => {
          sentAlerts.push({ jid, content });
          return { key: { id: "alert-3" } };
        }
      };
      ratings.setBotSocket(mockSock);

      try {
        const res = await ratings.updateRatingFromFullName("test_player_multiple", "David Lee", { sock: mockSock });
        assert.equal(res.rating, 3.49);
        assert.equal(res.tennisRecord, false);
        assert.equal(res.failureReason, "multiple_in_san_jose");

        assert.equal(sentAlerts.length >= 1, true);
        assert.match(sentAlerts[0].content.text, /Multiple players \(2\) with the name "\*David Lee\*" were found in San Jose/);
      } finally {
        restore();
      }
    });

    it("should send alert to the superadmin configured in .env (SUPERADMIN_ACCOUNT)", async () => {
      const origEnvSuperadmin = process.env.SUPERADMIN_ACCOUNT;
      process.env.SUPERADMIN_ACCOUNT = "1234567890@lid";
      ratings.clearAlertsCache();

      tennisRecord.fetchTennisRecordRating = async () => ({
        success: false,
        tennisRecord: false,
        rating: null,
        profileUrl: null,
        location: null,
        reason: "not_found"
      });

      const sentAlerts = [];
      const mockSock = {
        sendMessage: async (jid, content) => {
          sentAlerts.push({ jid, content });
          return { key: { id: "alert-env" } };
        }
      };

      try {
        await ratings.updateRatingFromFullName("test_player_env", "Unknown Player", { sock: mockSock });
        assert.equal(sentAlerts.length, 1);
        assert.equal(sentAlerts[0].jid, "1234567890@lid");
        assert.match(sentAlerts[0].content.text, /Profile not found on TennisRecord\.com/);
      } finally {
        process.env.SUPERADMIN_ACCOUNT = origEnvSuperadmin;
        restore();
      }
    });

    it("should not try to update rating from tennisrecord.com when tennisRecord is false in refreshPeriodicRatings", async () => {
      const fetchedNames = [];
      tennisRecord.fetchTennisRecordRating = async (name) => {
        fetchedNames.push(name);
        return { success: true, tennisRecord: true, rating: 3.5, profileUrl: "https://example.com" };
      };

      const data = ratings.load();
      data.players["mock_false_tr@lid"] = {
        rating: 3.49,
        locallyModified: false,
        tennisRecord: false,
        tennisRecordUrl: null,
        tennisRecordLocation: null,
        lastRefreshedAt: "2020-01-01T00:00:00.000Z"
      };

      try {
        await ratings.refreshPeriodicRatings({ force: true, delayMs: 0 });
        assert.equal(fetchedNames.includes("mock_false_tr@lid"), false, "Should NOT call fetchTennisRecordRating for player with tennisRecord: false");
      } finally {
        delete data.players["mock_false_tr@lid"];
        restore();
      }
    });

    it("should keep old rating already in file if fetching rating fails during a refresh", async () => {
      const namesStore = require("../lib/names");
      namesStore.setName("mock_refresh_fetch_fail@lid", "Fetch Fail Player");

      tennisRecord.fetchTennisRecordRating = async () => ({
        success: false,
        tennisRecord: false,
        rating: null,
        profileUrl: null,
        location: null,
        reason: "not_found"
      });

      const data = ratings.load();
      data.players["mock_refresh_fetch_fail@lid"] = {
        rating: 4.15,
        locallyModified: false,
        tennisRecord: true,
        tennisRecordUrl: "https://example.com/fetch_fail",
        tennisRecordLocation: "San Jose, CA",
        lastRefreshedAt: "2020-01-01T00:00:00.000Z"
      };

      try {
        await ratings.refreshPeriodicRatings({ force: true, delayMs: 0 });
        const updated = data.players["mock_refresh_fetch_fail@lid"];
        assert.equal(updated.rating, 4.15, "Rating should remain 4.15 (old rating in file) when fetching fails");
        assert.equal(updated.tennisRecord, false, "tennisRecord flag should be false");
      } finally {
        delete data.players["mock_refresh_fetch_fail@lid"];
        restore();
      }
    });

    it("should keep old rating already in file if decoding rating fails during a refresh", async () => {
      const namesStore = require("../lib/names");
      namesStore.setName("mock_refresh_decode_fail@lid", "Decode Fail Player");

      tennisRecord.fetchTennisRecordRating = async () => ({
        success: true,
        tennisRecord: true,
        rating: null,
        profileUrl: "https://example.com/decode_fail",
        location: "San Jose, CA"
      });

      const data = ratings.load();
      data.players["mock_refresh_decode_fail@lid"] = {
        rating: 3.85,
        locallyModified: false,
        tennisRecord: true,
        tennisRecordUrl: "https://example.com/decode_fail",
        tennisRecordLocation: "San Jose, CA",
        lastRefreshedAt: "2020-01-01T00:00:00.000Z"
      };

      try {
        await ratings.refreshPeriodicRatings({ force: true, delayMs: 0 });
        const updated = data.players["mock_refresh_decode_fail@lid"];
        assert.equal(updated.rating, 3.85, "Rating should remain 3.85 (old rating in file) when decoding rating fails");
        assert.equal(updated.tennisRecord, true);
      } finally {
        delete data.players["mock_refresh_decode_fail@lid"];
        restore();
      }
    });

    it("should not try to query tennisrecord.com on resetRating when tennisRecord is false", async () => {
      let fetchCalled = false;
      tennisRecord.fetchTennisRecordRating = async () => {
        fetchCalled = true;
        return { success: true, tennisRecord: true, rating: 4.0, profileUrl: "https://example.com" };
      };

      const data = ratings.load();
      data.players["mock_false_reset@lid"] = {
        rating: 3.8,
        locallyModified: true,
        tennisRecord: false,
        tennisRecordUrl: null,
        tennisRecordLocation: null
      };

      try {
        const res = await ratings.resetRating("mock_false_reset@lid");
        assert.equal(fetchCalled, false, "Should NOT call fetchTennisRecordRating on resetRating if tennisRecord: false");
        assert.equal(res.rating, 3.49);
        assert.equal(res.tennisRecord, false);
      } finally {
        delete data.players["mock_false_reset@lid"];
        restore();
      }
    });
  });
});
