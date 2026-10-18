const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  generateMatchups,
  formatMatchups,
  summarizeSchedule,
  findMatchupFor,
  SETS_PER_SESSION
} = require('../lib/matchups');

describe('matchups', () => {
  describe('generateMatchups', () => {
    it('should generate a singles matchup for 2 players', () => {
      const players = ['Alice', 'Bob'];
      const schedule = generateMatchups(players);

      assert.equal(schedule.type, 'singles');
      assert.equal(schedule.sets.length, 1);
      assert.equal(schedule.sets[0].courts.length, 1);
      assert.equal(schedule.sets[0].courts[0].teamA[0].name, 'Alice');
      assert.equal(schedule.sets[0].courts[0].teamB[0].name, 'Bob');
    });

    it('should generate rotating doubles matchups for 4 players across SETS_PER_SESSION sets', () => {
      const players = ['Alice', 'Bob', 'Charlie', 'Dave'];
      const schedule = generateMatchups(players);

      assert.equal(schedule.type, 'doubles');
      assert.equal(schedule.sets.length, SETS_PER_SESSION);
      for (const set of schedule.sets) {
        assert.equal(set.courts.length, 1);
        const court = set.courts[0];
        assert.equal(court.teamA.length, 2);
        assert.equal(court.teamB.length, 2);
        const allSetPlayers = [...court.teamA.map((p) => p.name), ...court.teamB.map((p) => p.name)].sort();
        assert.deepEqual(allSetPlayers, ['Alice', 'Bob', 'Charlie', 'Dave'].sort());
      }
    });

    it('should generate 2 courts for 8 players', () => {
      const players = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'];
      const schedule = generateMatchups(players);

      assert.equal(schedule.type, 'doubles');
      assert.equal(schedule.sets.length, SETS_PER_SESSION);
      for (const set of schedule.sets) {
        assert.equal(set.courts.length, 2);
      }
    });

    it('should respect fixedPairs pairing constraints across sets', () => {
      const players = ['Alice', 'Bob', 'Charlie', 'Dave'];
      const fixedPairs = [['Alice', 'Bob']];
      const schedule = generateMatchups(players, { fixedPairs });

      assert.equal(schedule.type, 'doubles');
      for (const set of schedule.sets) {
        const court = set.courts[0];
        const teamA = court.teamA.map((p) => p.name.toLowerCase());
        const teamB = court.teamB.map((p) => p.name.toLowerCase());
        const aliceInA = teamA.includes('alice');
        const bobInA = teamA.includes('bob');
        const aliceInB = teamB.includes('alice');
        const bobInB = teamB.includes('bob');

        // Alice and Bob must always be on the same team together!
        assert.ok((aliceInA && bobInA) || (aliceInB && bobInB), 'Alice and Bob must partner together in every set');
      }
    });

    it('should assign prebooked court names when provided', () => {
      const players = ['Alice', 'Bob', 'Charlie', 'Dave'];
      const schedule = generateMatchups(players, { prebookedCourts: ['Court 2'] });

      assert.equal(schedule.sets[0].courts[0].court, 'Court 2');
    });
  });

  describe('formatMatchups', () => {
    it('should format singles matchup readable string', () => {
      const schedule = generateMatchups(['Alice', 'Bob']);
      const formatted = formatMatchups(schedule);

      assert.match(formatted, /Singles/i);
      assert.match(formatted, /Alice vs Bob/);
    });

    it('should format doubles matchups with sets', () => {
      const schedule = generateMatchups(['Alice', 'Bob', 'Charlie', 'Dave']);
      const formatted = formatMatchups(schedule);

      assert.match(formatted, /Set 1:/);
      assert.match(formatted, /Set 2:/);
    });
  });

  describe('summarizeSchedule & findMatchupFor', () => {
    it('should find matchup for a player in a singles schedule', () => {
      const schedule = generateMatchups(['Alice', 'Bob']);
      const summary = summarizeSchedule(schedule);

      assert.equal(summary.type, 'singles');
      assert.equal(summary.sets.length, 1);

      const found = findMatchupFor(summary, ['Alice']);
      assert.ok(found);
      assert.deepEqual(found.team, ['Alice']);
      assert.deepEqual(found.opponents, ['Bob']);
    });

    it('should find unique matchup in doubles when opponents are specified', () => {
      const schedule = generateMatchups(['Alice', 'Bob', 'Charlie', 'Dave']);
      const summary = summarizeSchedule(schedule);

      const firstCourt = summary.sets[0].courts[0];
      const found = findMatchupFor(summary, firstCourt.teamA, firstCourt.teamB);
      assert.ok(found);
      assert.deepEqual(found.team, firstCourt.teamA);
      assert.deepEqual(found.opponents, firstCourt.teamB);
    });

    it('should return null when player is not in schedule', () => {
      const schedule = generateMatchups(['Alice', 'Bob', 'Charlie', 'Dave']);
      const summary = summarizeSchedule(schedule);

      const found = findMatchupFor(summary, ['Stranger']);
      assert.equal(found, null);
    });
  });
});
