const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const playerActivity = require('../lib/playerActivity');
const groupsConfig = require('../lib/groupsConfig');
const namesStore = require('../lib/names');
const playerCommands = require('../lib/commands/playerCommands');
const pollCommands = require('../lib/commands/pollCommands');
const lineupCommands = require('../lib/commands/lineupCommands');
const ratings = require('../lib/ratings');
const { DATA_DIR } = require('../lib/paths');

const TEST_ACTIVITY_FILE = path.join(DATA_DIR, 'player-activity.json');

describe('playerActivity', () => {
  let originalFileBackup = null;

  beforeEach(() => {
    if (fs.existsSync(TEST_ACTIVITY_FILE)) {
      originalFileBackup = fs.readFileSync(TEST_ACTIVITY_FILE, 'utf-8');
    } else {
      originalFileBackup = null;
    }
    playerActivity.reset();
  });

  afterEach(() => {
    if (originalFileBackup !== null) {
      fs.writeFileSync(TEST_ACTIVITY_FILE, originalFileBackup);
    } else if (fs.existsSync(TEST_ACTIVITY_FILE)) {
      try { fs.unlinkSync(TEST_ACTIVITY_FILE); } catch (e) {}
    }
  });

  describe('recordActivity (played, voted, messaged)', () => {
    it('should record played activity with timestamp for a single player', () => {
      const ts = '2026-11-06T19:00:00.000Z';
      playerActivity.recordPlayed('Alice', ts);

      const act = playerActivity.getPlayerActivity('Alice');
      assert.ok(act);
      assert.equal(act.name, 'Alice');
      assert.equal(act.played, ts);
      assert.equal(act.voted, null);
      assert.equal(act.messaged, null);
      assert.equal(act.latestType, 'played');
      assert.equal(act.latestTime, ts);
    });

    it('should record played activity for an array of players', () => {
      const ts = '2026-11-06T19:00:00.000Z';
      playerActivity.recordPlayed(['Alice', 'Bob', 'Charlie'], ts);

      assert.equal(playerActivity.getPlayerActivity('Alice').played, ts);
      assert.equal(playerActivity.getPlayerActivity('Bob').played, ts);
      assert.equal(playerActivity.getPlayerActivity('Charlie').played, ts);
    });

    it('should record voted activity for a player', () => {
      const ts = '2026-11-06T09:30:00.000Z';
      playerActivity.recordVoted('Alice', ts);

      const act = playerActivity.getPlayerActivity('Alice');
      assert.equal(act.voted, ts);
      assert.equal(act.latestType, 'voted');
      assert.equal(act.latestTime, ts);
    });

    it('should record messaged activity for a player', () => {
      const ts = '2026-11-06T14:15:00.000Z';
      playerActivity.recordMessaged('Alice', ts);

      const act = playerActivity.getPlayerActivity('Alice');
      assert.equal(act.messaged, ts);
      assert.equal(act.latestType, 'messaged');
      assert.equal(act.latestTime, ts);
    });

    it('should only update activity if newer timestamp arrives', () => {
      const older = '2026-11-05T10:00:00.000Z';
      const newer = '2026-11-06T12:00:00.000Z';

      playerActivity.recordMessaged('Alice', newer);
      assert.equal(playerActivity.getPlayerActivity('Alice').messaged, newer);

      // Attempt recording older timestamp
      playerActivity.recordMessaged('Alice', older);
      assert.equal(playerActivity.getPlayerActivity('Alice').messaged, newer);
    });
  });

  describe('single latest activity time', () => {
    it('should correctly determine the single latest activity among played, voted, and messaged', () => {
      const tPlayed = '2026-11-04T19:00:00.000Z';
      const tVoted = '2026-11-05T09:00:00.000Z';
      const tMessaged = '2026-11-06T11:00:00.000Z';

      playerActivity.recordPlayed('Alice', tPlayed);
      playerActivity.recordVoted('Alice', tVoted);
      playerActivity.recordMessaged('Alice', tMessaged);

      const act = playerActivity.getLatestActivity('Alice');
      assert.equal(act.latestType, 'messaged');
      assert.equal(act.latestTime, tMessaged);
      assert.equal(playerActivity.getLatestActivityTime('Alice'), tMessaged);

      // Now player plays a later match
      const tPlayedNew = '2026-11-07T19:00:00.000Z';
      playerActivity.recordPlayed('Alice', tPlayedNew);

      const act2 = playerActivity.getLatestActivity('Alice');
      assert.equal(act2.latestType, 'played');
      assert.equal(act2.latestTime, tPlayedNew);
      assert.equal(playerActivity.getLatestActivityTime('Alice'), tPlayedNew);
    });

    it('should return null when player has no recorded activity', () => {
      assert.equal(playerActivity.getLatestActivityTime('UnknownPlayer'), null);
      const act = playerActivity.getLatestActivity('UnknownPlayer');
      assert.equal(act, null);
    });
  });

  describe('canonical player identification', () => {
    it('should resolve player across LID, phone JID, and display name in namesStore', () => {
      const lid = '99990001@lid';
      const pn = '15551234567@s.whatsapp.net';
      namesStore.setName(lid, 'David Test', ['Davey'], pn, 'David Test Player');

      playerActivity.recordVoted(pn, '2026-11-05T08:00:00.000Z');
      playerActivity.recordPlayed('David Test', '2026-11-06T19:00:00.000Z');
      playerActivity.recordMessaged(lid, '2026-11-07T10:00:00.000Z');

      // Query by alias 'Davey'
      const actByAlias = playerActivity.getPlayerActivity('Davey');
      assert.ok(actByAlias);
      assert.equal(actByAlias.name, 'David Test');
      assert.equal(actByAlias.voted, '2026-11-05T08:00:00.000Z');
      assert.equal(actByAlias.played, '2026-11-06T19:00:00.000Z');
      assert.equal(actByAlias.messaged, '2026-11-07T10:00:00.000Z');
      assert.equal(actByAlias.latestType, 'messaged');
      assert.equal(actByAlias.latestTime, '2026-11-07T10:00:00.000Z');
    });
  });

  describe('getAllActivity', () => {
    it('should return all activity records sorted descending by latest time', () => {
      playerActivity.recordPlayed('Charlie', '2026-11-01T10:00:00.000Z');
      playerActivity.recordVoted('Alice', '2026-11-06T10:00:00.000Z');
      playerActivity.recordMessaged('Bob', '2026-11-04T10:00:00.000Z');

      const all = playerActivity.getAllActivity();
      assert.equal(all.length, 3);
      assert.equal(all[0].name, 'Alice');
      assert.equal(all[1].name, 'Bob');
      assert.equal(all[2].name, 'Charlie');
    });
  });

  describe('parsePeriod', () => {
    it('should parse days, weeks, months, hours', () => {
      const msDay = 24 * 60 * 60 * 1000;
      assert.equal(playerActivity.parsePeriod('30d'), 30 * msDay);
      assert.equal(playerActivity.parsePeriod('30 days'), 30 * msDay);
      assert.equal(playerActivity.parsePeriod('2w'), 14 * msDay);
      assert.equal(playerActivity.parsePeriod('2 weeks'), 14 * msDay);
      assert.equal(playerActivity.parsePeriod('1m'), 30 * msDay);
      assert.equal(playerActivity.parsePeriod('1 month'), 30 * msDay);
      assert.equal(playerActivity.parsePeriod('24h'), 24 * 60 * 60 * 1000);
      assert.equal(playerActivity.parsePeriod(60), 60 * msDay);
      assert.equal(playerActivity.parsePeriod('invalid'), 30 * msDay); // default
    });
  });

  describe('getInactivePlayers', () => {
    it('should list inactive players whose last activity time is before the configured time period from the latest time', () => {
      // Latest activity time across players is 2026-11-06T19:00:00.000Z
      playerActivity.recordPlayed('Alice', '2026-11-06T19:00:00.000Z'); // latest time
      playerActivity.recordVoted('Bob', '2026-10-25T10:00:00.000Z'); // 12 days before latest
      playerActivity.recordPlayed('Charlie', '2026-09-15T10:00:00.000Z'); // 52 days before latest
      playerActivity.recordMessaged('Dave', '2026-10-01T10:00:00.000Z'); // 36 days before latest

      // With period = 30d, cutoff is 2026-11-06 minus 30 days = 2026-10-07
      const res = playerActivity.getInactivePlayers({ period: '30d' });

      assert.equal(res.referenceTime, '2026-11-06T19:00:00.000Z');
      assert.equal(res.periodDays, 30);
      assert.equal(res.inactiveCount, 2);

      const inactiveNames = res.inactivePlayers.map(p => p.name);
      assert.ok(inactiveNames.includes('Charlie'));
      assert.ok(inactiveNames.includes('Dave'));
      assert.ok(!inactiveNames.includes('Alice'));
      assert.ok(!inactiveNames.includes('Bob'));
    });

    it('should identify players with no activity as neverActive', () => {
      const lidInactive = '99990002@lid';
      namesStore.setName(lidInactive, 'Inactive Person', [], '15559998888@s.whatsapp.net', 'Inactive Person Full');
      namesStore.setGroupMembers('test-group@g.us', [
        { lid: lidInactive, id: '15559998888@s.whatsapp.net' },
        { lid: '99990003@lid', id: '15559997777@s.whatsapp.net', name: 'Active Person' }
      ]);

      playerActivity.recordPlayed('99990003@lid', '2026-11-06T19:00:00.000Z');

      const res = playerActivity.getInactivePlayers({ groupJid: 'test-group@g.us', period: '30d' });
      const found = res.inactivePlayers.find(p => p.name === 'Inactive Person');
      assert.ok(found);
      assert.equal(found.neverActive, true);
      assert.equal(found.latestTime, null);
    });
  });

  describe('disk persistence', () => {
    it('should persist activity to disk and reload accurately', () => {
      playerActivity.recordPlayed('Alice', '2026-11-06T19:00:00.000Z');
      playerActivity.recordVoted('Bob', '2026-11-05T09:00:00.000Z');
      playerActivity.save();

      assert.ok(fs.existsSync(TEST_ACTIVITY_FILE));
      const content = JSON.parse(fs.readFileSync(TEST_ACTIVITY_FILE, 'utf-8'));
      assert.ok(content.alice || Object.values(content).some(v => v.name === 'Alice'));

      playerActivity.reset();
      assert.equal(Object.keys(playerActivity.load()).length, 0);

      // Force reload from disk
      const reloaded = JSON.parse(fs.readFileSync(TEST_ACTIVITY_FILE, 'utf-8'));
      playerActivity.save(reloaded);

      assert.equal(playerActivity.getPlayerActivity('Alice').played, '2026-11-06T19:00:00.000Z');
      assert.equal(playerActivity.getPlayerActivity('Bob').voted, '2026-11-05T09:00:00.000Z');
    });
  });

  describe('playerCommands handlers', () => {
    it('should handle !activity for a single player', async () => {
      playerActivity.recordPlayed('Alice', '2026-11-06T19:00:00.000Z');
      playerActivity.recordVoted('Alice', '2026-11-05T09:00:00.000Z');
      playerActivity.recordMessaged('Alice', '2026-11-07T00:30:00.000Z');

      const reply = await playerCommands.handlePlayerActivity(null, 'chat1', 'Me', 'Alice');
      assert.ok(reply.includes('Activity for Alice:'));
      assert.ok(reply.includes('Last Played:'));
      assert.ok(reply.includes('Last Voted:'));
      assert.ok(reply.includes('Last Messaged:'));
      assert.ok(reply.includes('Details:'));
      assert.ok(reply.includes('Messaged'));
    });

    it('should label future match as Next Match instead of Last Played and not count it as Latest Activity', async () => {
      const futureMatch = new Date(Date.now() + 86400000).toISOString();
      playerActivity.recordPlayed('FuturePlayer', futureMatch);
      playerActivity.recordMessaged('FuturePlayer', new Date(Date.now() - 3600000).toISOString());

      const reply = await playerCommands.handlePlayerActivity(null, 'chat1', 'Me', 'FuturePlayer');
      assert.ok(reply.includes('Next Match:'));
      assert.ok(!reply.includes('Last Played:'));
      assert.ok(reply.includes('Messaged'));
    });

    it('should handle !activity for all players', async () => {
      playerActivity.recordPlayed('Alice', '2026-11-06T19:00:00.000Z');
      playerActivity.recordVoted('Bob', '2026-11-05T09:00:00.000Z');

      const reply = await playerCommands.handlePlayerActivity(null, 'chat1', 'Me', null);
      assert.ok(reply.includes('Player Activity Log'));
      assert.ok(reply.includes('Alice'));
      assert.ok(reply.includes('Bob'));
    });

    it('should handle !latestactivity for a player', async () => {
      playerActivity.recordPlayed('Alice', '2026-11-06T19:00:00.000Z');
      const reply = await playerCommands.handleLatestActivity(null, 'chat1', 'Me', 'Alice');
      assert.ok(reply.includes('Latest Activity for Alice'));
      assert.ok(reply.includes('Played'));
    });

    it('should handle !inactiveplayers with configured or custom period', async () => {
      playerActivity.recordPlayed('Alice', '2026-11-06T19:00:00.000Z'); // latest reference
      playerActivity.recordPlayed('OldPlayer', '2026-09-01T19:00:00.000Z'); // 66 days ago

      const reply = await playerCommands.handleInactivePlayers(null, 'chat1', 'Me', '30d');
      assert.ok(reply.includes('Inactive Players'));
      assert.ok(reply.includes('OldPlayer'));
      assert.ok(!reply.includes('*Alice*'));
    });

    it('should route !activity, !latestactivity, and !inactive commands via handlePlayerCommand', async () => {
      playerActivity.recordPlayed('Alice', '2026-11-06T19:00:00.000Z');
      playerActivity.recordPlayed('OldPlayer', '2026-08-01T19:00:00.000Z');

      const actReply = await playerCommands.handlePlayerCommand(null, '!activity Alice', 'chat1', 'Me');
      assert.ok(actReply && actReply.includes('Activity for Alice'));

      const latestReply = await playerCommands.handlePlayerCommand(null, '!latestactivity Alice', 'chat1', 'Me');
      assert.ok(latestReply && latestReply.includes('Latest Activity for Alice'));

      const inactiveReply = await playerCommands.handlePlayerCommand(null, '!inactive 30d', 'chat1', 'Me');
      assert.ok(inactiveReply && inactiveReply.includes('Inactive Players'));
    });

    it('should execute player activity tools in executePlayerTool', async () => {
      playerActivity.recordPlayed('Alice', '2026-11-06T19:00:00.000Z');

      const actRes = await playerCommands.executePlayerTool(null, 'get_player_activity', { player: 'Alice' }, 'Me', 'jid', 'chat1');
      assert.ok(actRes.includes('Activity for Alice'));

      const latestRes = await playerCommands.executePlayerTool(null, 'get_latest_activity', { player: 'Alice' }, 'Me', 'jid', 'chat1');
      assert.ok(latestRes.includes('Latest Activity for Alice'));

      const inactiveRes = await playerCommands.executePlayerTool(null, 'get_inactive_players', { period: '30d' }, 'Me', 'jid', 'chat1');
      assert.ok(typeof inactiveRes === 'string');
    });
  });

  describe('integration hooks', () => {
    it('should record played activity when handleManualLineup is executed', async () => {
      const targetPoll = {
        remoteJid: 'test_chat@g.us',
        playAt: '2026-11-08T19:00:00.000Z',
        when: 'Tomorrow 7pm',
        size: 4,
        status: 'active',
        lastPlayers: null
      };
      const activePolls = new Map([['poll_lineup_test', targetPoll]]);
      const dummySock = {
        user: { id: 'bot@s.whatsapp.net' },
        sendMessage: async () => ({ key: { id: 'm1' } })
      };
      const newLineup = {
        type: 'doubles',
        players: ['PlayerAlpha', 'PlayerBeta', 'PlayerGamma', 'PlayerDelta'],
        sets: [{
          set: 1,
          courts: [{ court: 1, teamA: ['PlayerAlpha', 'PlayerBeta'], teamB: ['PlayerGamma', 'PlayerDelta'] }]
        }]
      };
      const context = {
        activePolls,
        persistPolls: () => {},
        messageStore: new Map(),
        latestPollIdByChat: new Map([['test_chat@g.us', 'poll_lineup_test']])
      };

      await lineupCommands.handleManualLineup(
        dummySock,
        'test_chat@g.us',
        'PlayerAlpha',
        newLineup,
        { key: { id: 'msg_l' } },
        'Court 1: PlayerAlpha & PlayerBeta vs PlayerGamma & PlayerDelta',
        context
      );

      const act = playerActivity.getPlayerActivity('PlayerAlpha');
      assert.ok(act);
      assert.ok(act.played);
      assert.equal(act.latestType, 'played');

      const actBeta = playerActivity.getPlayerActivity('PlayerBeta');
      assert.ok(actBeta.played);
    });

    it('should record voted activity when processPollVoteEvent is executed', async () => {
      const pollState = {
        remoteJid: 'test_vote_chat@g.us',
        size: 4,
        status: 'active',
        voteBuffer: new Map(),
        options: ['Player 1', 'Player 2', 'Player 3', 'Player 4']
      };
      const activePolls = new Map([['poll_vote_test', pollState]]);
      const messageStore = new Map([['test_vote_chat@g.us:poll_vote_test', {
        message: { pollCreationMessage: { name: 'Tennis 7pm', options: [{ optionName: 'Player 1' }, { optionName: 'Player 2' }] } }
      }]]);
      const context = { activePolls, messageStore, persistPolls: () => {} };

      const pollKey = { id: 'poll_vote_test', remoteJid: 'test_vote_chat@g.us' };
      const updateEntry = {
        pollUpdateMessageKey: { participant: 'voter123@s.whatsapp.net', id: 'vote1' },
        vote: { selectedOptions: [Buffer.from('opt1')] },
        senderTimestampMs: 1794000000000
      };
      const sock = { user: { id: 'bot@s.whatsapp.net', lid: 'bot@lid' } };
      await pollCommands.processPollVoteEvent(sock, pollKey, [updateEntry], context);

      const act = playerActivity.getPlayerActivity('voter123@s.whatsapp.net');
      assert.ok(act);
      assert.equal(act.voted, new Date(1794000000000).toISOString());
      assert.equal(act.latestType, 'voted');
    });
  });

  describe('inactivity period in weeks', () => {
    it('should parse weeks from integers or strings', () => {
      assert.equal(groupsConfig.parseInactivityWeeks(4), 4);
      assert.equal(groupsConfig.parseInactivityWeeks('4'), 4);
      assert.equal(groupsConfig.parseInactivityWeeks('4w'), 4);
      assert.equal(groupsConfig.parseInactivityWeeks('4 weeks'), 4);
      assert.equal(groupsConfig.parseInactivityWeeks('28d'), 4);
      assert.equal(groupsConfig.parseInactivityWeeks('60d'), 9);
      assert.equal(groupsConfig.parseInactivityWeeks(null), 12);
    });

    it('should retrieve configured inactivity period in weeks for a group', () => {
      const weeks = groupsConfig.getInactivityPeriodWeeks('120363403838804497@g.us');
      assert.equal(weeks, 12);
    });
  });

  describe('weekly activity tracking', () => {
    it('should record and increment weekly activity counts for messages, votes, and lineups', () => {
      const now = new Date('2026-11-08T12:00:00.000Z').getTime();
      const weekKey = playerActivity.getWeekKey(now);

      playerActivity.recordMessaged('Alice', now);
      playerActivity.recordMessaged('Alice', now + 1000);
      playerActivity.recordVoted('Alice', now + 2000);
      playerActivity.recordPlayed('Alice', now + 3000);

      const weekly = playerActivity.getWeeklyActivity('Alice');
      assert.ok(weekly[weekKey]);
      assert.equal(weekly[weekKey].messages, 2);
      assert.equal(weekly[weekKey].votes, 1);
      assert.equal(weekly[weekKey].lineups, 1);
    });

    it('should separate activity counts into different ISO week keys across weeks', () => {
      const week1 = new Date('2026-11-02T10:00:00.000Z').getTime();
      const week2 = new Date('2026-11-09T10:00:00.000Z').getTime();
      const k1 = playerActivity.getWeekKey(week1);
      const k2 = playerActivity.getWeekKey(week2);
      assert.notEqual(k1, k2);

      playerActivity.recordMessaged('Bob', week1);
      playerActivity.recordPlayed('Bob', week2);

      const weekly = playerActivity.getWeeklyActivity('Bob');
      assert.equal(weekly[k1].messages, 1);
      assert.equal(weekly[k1].lineups, 0);
      assert.equal(weekly[k2].messages, 0);
      assert.equal(weekly[k2].lineups, 1);
    });

    it('should automatically prune weekly activity older than configured inactivity period', () => {
      const now = new Date('2026-11-08T12:00:00.000Z').getTime();
      const msDay = 24 * 60 * 60 * 1000;
      const oldTime = now - 14 * 7 * msDay; // 14 weeks ago (> 12 weeks)
      const recentTime = now - 2 * 7 * msDay; // 2 weeks ago
      const oldWeekKey = playerActivity.getWeekKey(oldTime);
      const recentWeekKey = playerActivity.getWeekKey(recentTime);

      playerActivity.recordMessaged('OldActivePlayer', oldTime);
      playerActivity.recordMessaged('OldActivePlayer', recentTime);

      playerActivity.pruneAllWeeklyActivity(12, now);

      const weekly = playerActivity.getWeeklyActivity('OldActivePlayer');
      assert.equal(weekly[oldWeekKey], undefined, 'Week older than 12 weeks should be pruned');
      assert.ok(weekly[recentWeekKey], 'Recent week should be retained');
    });
  });

  describe('checkInactivityMilestones (50%, 75%, 100%)', () => {
    const msDay = 24 * 60 * 60 * 1000;
    const testChat = '120363403838804497@g.us';

    it('should send encouragement message in group tagging player at 50% mark', async () => {
      const baseNow = new Date('2026-11-01T12:00:00.000Z').getTime();
      const lastAct = baseNow - 45 * msDay;
      const lid = '99991111@lid';
      const pn = '15551239999@s.whatsapp.net';
      namesStore.setName(lid, 'Inactive Halfway', [], pn, 'Inactive Halfway');
      namesStore.setGroupMembers(testChat, [{ lid, id: pn, name: 'Inactive Halfway' }]);
      playerActivity.recordMessaged(lid, lastAct, testChat);

      const messagesSent = [];
      const mockSock = {
        sendMessage: async (dest, msg) => { messagesSent.push({ dest, msg }); }
      };

      const res = await playerActivity.checkInactivityMilestones(mockSock, testChat, {}, baseNow);
      assert.ok(res.halfway.includes('Inactive Halfway'));

      const grpMsg = messagesSent.find(m => m.dest === testChat);
      assert.ok(grpMsg);
      assert.match(grpMsg.msg.text, /missed you on the court/i);
      assert.ok(grpMsg.msg.text.includes('@15551239999'));
      assert.ok(grpMsg.msg.mentions.includes(pn));

      messagesSent.length = 0;
      const res2 = await playerActivity.checkInactivityMilestones(mockSock, testChat, {}, baseNow);
      assert.equal(res2.halfway.length, 0);
      assert.equal(messagesSent.length, 0);
    });

    it('should send participation check message in group tagging player at 75% mark', async () => {
      const baseNow = new Date('2026-11-01T12:00:00.000Z').getTime();
      const lastAct = baseNow - 65 * msDay;
      const lid = '99992222@lid';
      const pn = '15551238888@s.whatsapp.net';
      namesStore.setName(lid, 'Inactive ThreeQuarter', [], pn, 'Inactive ThreeQuarter');
      namesStore.setGroupMembers(testChat, [{ lid, id: pn, name: 'Inactive ThreeQuarter' }]);
      playerActivity.recordMessaged(lid, lastAct, testChat);

      const messagesSent = [];
      const mockSock = {
        sendMessage: async (dest, msg) => { messagesSent.push({ dest, msg }); }
      };

      const res = await playerActivity.checkInactivityMilestones(mockSock, testChat, {}, baseNow);
      assert.ok(res.threeQuarter.includes('Inactive ThreeQuarter'));

      const grpMsg = messagesSent.find(m => m.dest === testChat);
      assert.ok(grpMsg);
      assert.match(grpMsg.msg.text, /still want to be part of the group/i);
      assert.ok(grpMsg.msg.text.includes('@15551238888'));
      assert.ok(grpMsg.msg.mentions.includes(pn));
    });

    it('should mark inactive at 100% mark and send DM to notifications recipients', async () => {
      const baseNow = new Date('2026-11-01T12:00:00.000Z').getTime();
      const lastAct = baseNow - 86 * msDay;
      const lid = '99993333@lid';
      const pn = '15551237777@s.whatsapp.net';
      namesStore.setName(lid, 'Fully Inactive Player', [], pn, 'Fully Inactive Player');
      namesStore.setGroupMembers(testChat, [{ lid, id: pn, name: 'Fully Inactive Player' }]);
      playerActivity.recordMessaged(lid, lastAct, testChat);

      const messagesSent = [];
      const mockSock = {
        sendMessage: async (dest, msg) => { messagesSent.push({ dest, msg }); }
      };

      const res = await playerActivity.checkInactivityMilestones(mockSock, testChat, {}, baseNow);
      assert.ok(res.inactive.includes('Fully Inactive Player'));

      const act = playerActivity.getPlayerActivity(lid);
      assert.equal(act.status, 'inactive');
      assert.ok(act.inactiveAt);

      const notifs = groupsConfig.getNotifications(testChat);
      assert.ok(notifs.length > 0);
      const dmMsg = messagesSent.find(m => notifs.includes(m.dest));
      assert.ok(dmMsg, 'DM must be sent to notifications recipient');
      assert.match(dmMsg.msg.text, /marked as inactive/i);
      assert.match(dmMsg.msg.text, /Fully Inactive Player/);
    });

    it('should reactivate an inactive player and reset warnings when new activity is recorded', () => {
      const baseNow = new Date('2026-11-01T12:00:00.000Z').getTime();
      const lastAct = baseNow - 86 * msDay;
      const player = 'Zoe';
      playerActivity.recordMessaged(player, lastAct);

      const actBefore = playerActivity.getPlayerActivity(player);
      playerActivity.load()[actBefore.key].status = 'inactive';
      playerActivity.load()[actBefore.key].warnings = { halfwaySent: true, threeQuarterSent: true, inactiveSent: true };

      playerActivity.recordPlayed(player, baseNow);

      const actAfter = playerActivity.getPlayerActivity(player);
      assert.equal(actAfter.status, 'active');
      assert.equal(actAfter.warnings.halfwaySent, false);
      assert.equal(actAfter.warnings.threeQuarterSent, false);
      assert.equal(actAfter.warnings.inactiveSent, false);
    });

    it('should set created on new player entries', () => {
      playerActivity.recordMessaged('CreatedTestPlayer', '2026-11-08T12:00:00.000Z');
      const act = playerActivity.getPlayerActivity('CreatedTestPlayer');
      assert.ok(act.created);
    });

    it('should resolve bare numeric IDs and mentions to canonical LID without creating numeric entries', () => {
      const lid = '90611059302558@lid';
      const bareNumber = '90611059302558';
      const atMention = '@90611059302558';
      const now = new Date('2026-11-09T14:00:00.000Z').getTime();

      // Ensure names store has the test player
      namesStore.setName(lid, 'PI');

      // 1. Resolve canonical player key
      const resolvedBare = playerActivity.resolveCanonicalPlayerKey(bareNumber);
      assert.equal(resolvedBare.key, lid);
      assert.equal(resolvedBare.name, 'PI');
      assert.equal(resolvedBare.id, lid);

      const resolvedAt = playerActivity.resolveCanonicalPlayerKey(atMention);
      assert.equal(resolvedAt.key, lid);
      assert.equal(resolvedAt.name, 'PI');

      // 2. Record played via bare number
      playerActivity.recordPlayed(bareNumber, now);

      const storeData = playerActivity.load();
      // Should be stored under canonical LID, NOT under bare number
      assert.ok(storeData[lid], 'Entry should exist under canonical LID');
      assert.strictEqual(storeData[bareNumber], undefined, 'Bare number should not exist in store');
      assert.equal(storeData[lid].played, new Date(now).toISOString());

      // 3. Record played via @mention
      const later = now + 3600000;
      playerActivity.recordPlayed(atMention, later);
      assert.equal(storeData[lid].played, new Date(later).toISOString());
      assert.strictEqual(storeData[bareNumber], undefined);
    });
    it('should exclude tenbot from player activity, names, and ratings', () => {
      const botLid = '24104010813588@lid';
      const botPn = '16693124812@s.whatsapp.net';

      // 1. Player activity resolution and recording
      assert.strictEqual(playerActivity.resolveCanonicalPlayerKey('tenbot'), null);
      assert.strictEqual(playerActivity.resolveCanonicalPlayerKey('@tenbot'), null);
      assert.strictEqual(playerActivity.resolveCanonicalPlayerKey(botLid), null);
      assert.strictEqual(playerActivity.resolveCanonicalPlayerKey(botPn), null);

      assert.strictEqual(playerActivity.recordPlayed('tenbot'), null);
      assert.strictEqual(playerActivity.recordPlayed(botLid), null);
      assert.strictEqual(playerActivity.recordVoted('@tenbot'), null);
      assert.strictEqual(playerActivity.recordMessaged(botPn), null);

      const allActivity = playerActivity.getAllActivity();
      assert.ok(!allActivity.some((a) => a.name?.toLowerCase() === 'tenbot' || a.key === botLid));

      // 2. Names store exclusion
      assert.strictEqual(namesStore.findIdByNameOrAlias('tenbot'), null);
      assert.strictEqual(namesStore.findIdByNameOrAlias('@tenbot'), null);
      assert.strictEqual(namesStore.setName(botLid, 'tenbot'), null);
      assert.strictEqual(namesStore.setName('99999999@lid', 'tenbot'), null);
      namesStore.setMapping(botLid, botPn, 'tenbot');
      assert.strictEqual(namesStore.getName(botLid), null);

      // 3. Ratings exclusion
      assert.strictEqual(ratings.isPlaceholder('tenbot'), true);
      assert.strictEqual(ratings.isPlaceholder('@tenbot'), true);
      assert.strictEqual(ratings.isPlaceholder(botLid), true);
      assert.strictEqual(ratings.isPlaceholder(botPn), true);

      assert.strictEqual(ratings.setRating('tenbot', 4.0), null);
      assert.strictEqual(ratings.setRating(botLid, 4.0), null);

      const allRatings = ratings.getAllRatings();
      assert.ok(!allRatings.some((r) => r.name?.toLowerCase() === 'tenbot' || r.id === botLid));
    });
  });
});
