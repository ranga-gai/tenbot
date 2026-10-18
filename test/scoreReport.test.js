const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseScoreReport, DEFAULT_SET } = require('../lib/scoreReport');

describe('scoreReport', () => {
  const dummyOptions = {
    resolveName: (raw) => {
      const lower = String(raw).trim().toLowerCase();
      const known = {
        mike: 'Mike',
        sara: 'Sara',
        john: 'John',
        alex: 'Alex',
        alice: 'Alice',
        bob: 'Bob'
      };
      return known[lower] || null;
    },
    findMatchup: () => null
  };

  it('should parse "A & B beat C & D <score>"', () => {
    const report = parseScoreReport('Mike & Sara beat John & Alex 6-4 6-2', dummyOptions);
    assert.ok(report);
    assert.deepEqual(report.winners, ['Mike', 'Sara']);
    assert.deepEqual(report.losers, ['John', 'Alex']);
    assert.deepEqual(report.sets, [[6, 4], [6, 2]]);
    assert.equal(report.assumedScore, false);
  });

  it('should parse "A def B <score>" in singles', () => {
    const report = parseScoreReport('Alice def Bob 6-3 6-4', dummyOptions);
    assert.ok(report);
    assert.deepEqual(report.winners, ['Alice']);
    assert.deepEqual(report.losers, ['Bob']);
    assert.deepEqual(report.sets, [[6, 3], [6, 4]]);
  });

  it('should parse score with tiebreak notation', () => {
    const report = parseScoreReport('Alice def Bob 7-6(4) 6-4', dummyOptions);
    assert.ok(report);
    assert.deepEqual(report.sets, [[7, 6], [6, 4]]);
  });

  it('should parse "we won" using findMatchup resolver', () => {
    const optionsWithMatchup = {
      resolveName: (raw) => (String(raw).trim().toLowerCase() === 'we' ? 'Alice' : null),
      findMatchup: (names) => {
        if (names.includes('Alice')) {
          return { team: ['Alice', 'Bob'], opponents: ['Charlie', 'Dave'] };
        }
        return null;
      }
    };

    const report = parseScoreReport('we won 6-4', optionsWithMatchup);
    assert.ok(report);
    assert.deepEqual(report.winners, ['Alice', 'Bob']);
    assert.deepEqual(report.losers, ['Charlie', 'Dave']);
    assert.deepEqual(report.sets, [[6, 4]]);
  });

  it('should return null for non-score messages and general banter', () => {
    assert.equal(parseScoreReport('we beat the traffic today', dummyOptions), null);
    assert.equal(parseScoreReport('who won the US Open?', dummyOptions), null);
    assert.equal(parseScoreReport('hello everyone', dummyOptions), null);
  });
});
