const { describe, it, before, beforeEach, after } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const tennisRecord = require('../lib/tennisRecord');
const assert = require('node:assert/strict');
const namesStore = require('../lib/names');
const ratings = require('../lib/ratings');
const playerActivity = require('../lib/playerActivity');
const groupsConfig = require('../lib/groupsConfig');
const groupSync = require('../lib/groupSync');
const { getGroupMetadataCache } = require('../lib/commands/groupCommands');
const { routeCommand } = require('../lib/commands');

describe('Group Membership Synchronization', () => {
  const originalFetch = tennisRecord.fetchTennisRecordRating;
  const allowedGroupJid = '120363403838804497@g.us';
  const allowedGroupName = 'Bot-testing';
  const secondAllowedGroupJid = '120363111111111111@g.us';
  const secondAllowedGroupName = 'Second-Group';
  const unallowedGroupJid = '120363999999999999@g.us';
  const unallowedGroupName = 'Unallowed-Group';

  const adminJid = '11111111111@s.whatsapp.net';
  const nonAdminJid = '22222222222@s.whatsapp.net';

  let snapshotNames = null;
  let snapshotRatings = null;
  let snapshotPlayerActivity = null;
  let snapshotGroupsConfig = null;
  const namesFile = path.resolve(__dirname, '../data/names.json');
  const ratingsFile = path.resolve(__dirname, '../data/ratings.json');
  const activityFile = path.resolve(__dirname, '../data/player-activity.json');
  const groupsConfigFile = path.resolve(__dirname, '../config/groups.json');

  before(() => {
    if (fs.existsSync(namesFile)) snapshotNames = fs.readFileSync(namesFile, 'utf8');
    if (fs.existsSync(ratingsFile)) snapshotRatings = fs.readFileSync(ratingsFile, 'utf8');
    if (fs.existsSync(activityFile)) snapshotPlayerActivity = fs.readFileSync(activityFile, 'utf8');
    if (fs.existsSync(groupsConfigFile)) snapshotGroupsConfig = fs.readFileSync(groupsConfigFile, 'utf8');
  });

  beforeEach(() => {
    // Reset in-memory stores and group memberships
    getGroupMetadataCache().clear();
    const namesData = namesStore.load();
    for (const k of Object.keys(namesData)) delete namesData[k];
    namesStore.save();

    const ratingsData = ratings.load();
    ratingsData.players = {};
    ratings.save();

    playerActivity.reset();
    tennisRecord.fetchTennisRecordRating = async (name) => ({
      rating: 3.5,
      profileUrl: `https://www.tennisrecord.com/adult/profile.aspx?playername=${encodeURIComponent(name)}`,
      location: 'San Jose, CA',
      tennisRecord: true
    });

    // Reset group memberships in namesStore
    if (namesStore.getAllGroupMemberships) {
      namesStore.getAllGroupMemberships().clear();
    }
  });

  after(() => {
    tennisRecord.fetchTennisRecordRating = originalFetch;
    tennisRecord.config.updateConfig({ enabled: true });

    // Restore persistent data stores to pre-test state
    if (snapshotNames !== null) {
      namesStore.save(JSON.parse(snapshotNames));
    }
    if (snapshotRatings !== null) {
      ratings.save(JSON.parse(snapshotRatings));
    }
    if (snapshotPlayerActivity !== null) {
      playerActivity.save(JSON.parse(snapshotPlayerActivity));
    }
    if (snapshotGroupsConfig !== null) {
      fs.writeFileSync(groupsConfigFile, snapshotGroupsConfig, 'utf8');
      groupsConfig.reloadConfig();
    }
    if (namesStore.getAllGroupMemberships) {
      namesStore.getAllGroupMemberships().clear();
    }
    getGroupMetadataCache().clear();
  });

  describe('Store removal helpers', () => {
    it('namesStore.removeEntry removes entry by canonicalId, PN, or name', () => {
      namesStore.setName('p1@lid', 'Player One', ['P1'], '14155550001@s.whatsapp.net', 'Player One Full');
      assert.ok(namesStore.getName('p1@lid'));

      const removed = namesStore.removeEntry('p1@lid');
      assert.equal(removed, true);
      assert.equal(namesStore.getName('p1@lid'), null);
      assert.equal(namesStore.findIdByNameOrAlias('Player One'), null);
      assert.equal(namesStore.findIdByNameOrAlias('14155550001@s.whatsapp.net'), null);
    });

    it('ratings.removeRating removes entry by key, LID, PN, or name', () => {
      ratings.setRating('p1@lid', 3.75, { name: 'Player One' });
      assert.equal(ratings.getRating('p1@lid'), 3.75);

      const removed = ratings.removeRating('p1@lid');
      assert.equal(removed, true);
      assert.equal(ratings.getRating('p1@lid'), 3.0); // defaults to 3.00 after deletion
      assert.equal(ratings.load().players['p1@lid'], undefined);
    });

    it('playerActivity.removePlayerActivity removes activity record', () => {
      playerActivity.recordActivity('p1@lid', 'played', Date.now());
      assert.ok(playerActivity.getPlayerActivity('p1@lid'));

      const removed = playerActivity.removePlayerActivity('p1@lid');
      assert.equal(removed, true);
      assert.equal(playerActivity.load()['p1@lid'], undefined);
    });
  });

  describe('Real-time join & leave events (group-participants.update)', () => {
    const mockSock = {
      groupMetadata: async (jid) => {
        if (jid === allowedGroupJid) {
          return {
            id: allowedGroupJid,
            subject: allowedGroupName,
            participants: [
              { id: '14155550001@s.whatsapp.net', lid: 'p1@lid', name: 'Alice' },
              { id: '14155550002@s.whatsapp.net', lid: 'p2@lid', name: 'Bob' }
            ]
          };
        }
        return null;
      }
    };

    it('adds new participant to names, ratings, and activity when action is "add"', async () => {
      // Simulate Alice joining the allowed group
      await groupSync.handleParticipantsUpdate(mockSock, {
        id: allowedGroupJid,
        participants: ['14155550001@s.whatsapp.net'],
        action: 'add'
      });

      // 1. Verify namesStore
      const entry = namesStore.findIdByNameOrAlias('Alice');
      assert.ok(entry);
      assert.equal(entry.entry.name, 'Alice');
      assert.equal(entry.entry.pn, '14155550001@s.whatsapp.net');

      // 2. Verify ratings
      const r = ratings.findPlayer('Alice', 'p1@lid');
      assert.ok(r);
      assert.ok(r.entry.rating >= 2.5);

      // 3. Verify playerActivity
      const act = playerActivity.getPlayerActivity('p1@lid');
      assert.ok(act);
      assert.equal(act.name, 'Alice');
    });

    it('removes departed participant from names, ratings, and activity when action is "remove"', async () => {
      // First, add Alice
      await groupSync.handleParticipantsUpdate(mockSock, {
        id: allowedGroupJid,
        participants: ['14155550001@s.whatsapp.net'],
        action: 'add'
      });
      assert.ok(namesStore.findIdByNameOrAlias('Alice'));
      assert.ok(ratings.findPlayer('Alice', 'p1@lid'));
      assert.ok(playerActivity.getPlayerActivity('p1@lid'));

      // Now simulate Alice leaving the group
      await groupSync.handleParticipantsUpdate(mockSock, {
        id: allowedGroupJid,
        participants: ['14155550001@s.whatsapp.net'],
        action: 'remove'
      });

      // Verify removed from all 3 stores
      assert.equal(namesStore.findIdByNameOrAlias('Alice'), null);
      assert.equal(ratings.findPlayer('Alice', 'p1@lid'), null);
      assert.equal(playerActivity.load()['p1@lid'], undefined);
    });

    it('does not touch stores when event is for an unallowed group', async () => {
      namesStore.setName('p1@lid', 'Alice', [], '14155550001@s.whatsapp.net');
      ratings.setRating('p1@lid', 3.75, { name: 'Alice' });
      playerActivity.addPlayerActivity('p1@lid', null, 'Alice');

      // Remove from unallowed group
      await groupSync.handleParticipantsUpdate(mockSock, {
        id: unallowedGroupJid,
        participants: ['14155550001@s.whatsapp.net'],
        action: 'remove'
      });

      // Should still be in stores because event was for an unallowed group
      assert.ok(namesStore.getName('p1@lid'));
      assert.ok(ratings.load().players['p1@lid']);
      assert.ok(playerActivity.load()['p1@lid']);
    });
  });

  describe('Multi-group member retention', () => {
    it('retains member in stores if they leave one group but remain in another allowed group', async () => {
      // Setup: Bob is in both allowedGroupJid and secondAllowedGroupJid
      // In groups.json or config, let's configure both groups as allowed
      groupsConfig.addGroup(secondAllowedGroupJid, secondAllowedGroupName);

      const mockSock = {
        groupMetadata: async (jid) => {
          if (jid === allowedGroupJid) {
            return {
              id: allowedGroupJid,
              subject: allowedGroupName,
              participants: [{ id: '14155550002@s.whatsapp.net', lid: 'p2@lid', name: 'Bob' }]
            };
          }
          if (jid === secondAllowedGroupJid) {
            return {
              id: secondAllowedGroupJid,
              subject: secondAllowedGroupName,
              participants: [{ id: '14155550002@s.whatsapp.net', lid: 'p2@lid', name: 'Bob' }]
            };
          }
          return null;
        }
      };

      // Add Bob to group 1 and group 2
      await groupSync.handleParticipantsUpdate(mockSock, {
        id: allowedGroupJid,
        participants: ['14155550002@s.whatsapp.net'],
        action: 'add'
      });
      await groupSync.handleParticipantsUpdate(mockSock, {
        id: secondAllowedGroupJid,
        participants: ['14155550002@s.whatsapp.net'],
        action: 'add'
      });

      assert.ok(namesStore.findIdByNameOrAlias('Bob'));
      assert.ok(ratings.findPlayer('Bob', 'p2@lid'));
      assert.ok(playerActivity.getPlayerActivity('p2@lid'));

      // Bob leaves group 1
      await groupSync.handleParticipantsUpdate(mockSock, {
        id: allowedGroupJid,
        participants: ['14155550002@s.whatsapp.net'],
        action: 'remove'
      });

      // Bob should STILL be in stores because he is in secondAllowedGroupJid!
      assert.ok(namesStore.findIdByNameOrAlias('Bob'));
      assert.ok(ratings.findPlayer('Bob', 'p2@lid'));
      assert.ok(playerActivity.getPlayerActivity('p2@lid'));

      // Now Bob leaves group 2 as well
      await groupSync.handleParticipantsUpdate(mockSock, {
        id: secondAllowedGroupJid,
        participants: ['14155550002@s.whatsapp.net'],
        action: 'remove'
      });

      // Now Bob is in 0 allowed groups -> removed from stores!
      assert.equal(namesStore.findIdByNameOrAlias('Bob'), null);
      assert.equal(ratings.findPlayer('Bob', 'p2@lid'), null);
      assert.equal(playerActivity.load()['p2@lid'], undefined);

      // Clean up second allowed group
      groupsConfig.removeGroup(secondAllowedGroupJid);
    });
  });

  describe('Full reconciliation (syncGroupMembership)', () => {
    it('populates missing members and prunes departed members across all 3 stores', async () => {
      // Suppose stores currently contain:
      // 1. Charlie (current group member)
      // 2. OldDave (former member who left the group long ago)
      namesStore.setName('charlie@lid', 'Charlie', [], '14155550003@s.whatsapp.net', 'Charlie Brown');
      ratings.setRating('charlie@lid', 4.10, { name: 'Charlie' });
      playerActivity.addPlayerActivity('charlie@lid', null, 'Charlie');

      namesStore.setName('olddave@lid', 'OldDave', [], '14155550099@s.whatsapp.net', 'Old Dave');
      ratings.setRating('olddave@lid', 3.50, { name: 'OldDave' });
      playerActivity.addPlayerActivity('olddave@lid', null, 'OldDave');

      // WhatsApp group currently contains:
      // - Charlie
      // - Alice (new member not yet in stores)
      const mockSock = {
        groupFetchAllParticipating: async () => ({
          [allowedGroupJid]: {
            id: allowedGroupJid,
            subject: allowedGroupName,
            participants: [
              { id: '14155550003@s.whatsapp.net', lid: 'charlie@lid', name: 'Charlie' },
              { id: '14155550001@s.whatsapp.net', lid: 'alice@lid', name: 'Alice' }
            ]
          }
        }),
        groupMetadata: async (jid) => {
          if (jid === allowedGroupJid) {
            return {
              id: allowedGroupJid,
              subject: allowedGroupName,
              participants: [
                { id: '14155550003@s.whatsapp.net', lid: 'charlie@lid', name: 'Charlie' },
                { id: '14155550001@s.whatsapp.net', lid: 'alice@lid', name: 'Alice' }
              ]
            };
          }
          return null;
        }
      };

      const res = await groupSync.syncGroupMembership(mockSock, allowedGroupJid);
      assert.equal(res.totalMembers, 2);
      assert.ok(res.removed.names >= 1);
      assert.ok(res.removed.ratings >= 1);
      assert.ok(res.removed.activity >= 1);

      // 1. Charlie (existing member) should be retained with rating intact
      assert.ok(namesStore.findIdByNameOrAlias('Charlie'));
      assert.equal(ratings.getRating('charlie@lid'), 4.1);
      assert.ok(playerActivity.getPlayerActivity('charlie@lid'));

      // 2. Alice (new member) should be added to names, ratings, and activity
      assert.ok(namesStore.findIdByNameOrAlias('Alice'));
      assert.ok(ratings.findPlayer('Alice', 'alice@lid'));
      assert.ok(playerActivity.getPlayerActivity('alice@lid'));

      // 3. OldDave (former member) should be pruned from names, ratings, and activity
      assert.equal(namesStore.findIdByNameOrAlias('OldDave'), null);
      assert.equal(ratings.findPlayer('OldDave', 'olddave@lid'), null);
      assert.equal(playerActivity.load()['olddave@lid'], undefined);
    });

    it('safely aborts and avoids pruning if 0 participants are retrieved (e.g. network failure)', async () => {
      namesStore.setName('charlie@lid', 'Charlie', [], '14155550003@s.whatsapp.net');
      ratings.setRating('charlie@lid', 4.10, { name: 'Charlie' });
      playerActivity.addPlayerActivity('charlie@lid', null, 'Charlie');

      const mockFailingSock = {
        groupMetadata: async () => null,
        groupFetchAllParticipating: async () => ({})
      };

      const res = await groupSync.syncGroupMembership(mockFailingSock, allowedGroupJid);
      assert.ok(res.error);

      // Charlie should NOT be deleted!
      assert.ok(namesStore.getName('charlie@lid'));
      assert.ok(ratings.load().players['charlie@lid']);
      assert.ok(playerActivity.load()['charlie@lid']);
    });
  });

  describe('!syncmembers command', () => {
    const mockSock = {
      groupMetadata: async (jid) => {
        if (jid === allowedGroupJid) {
          return {
            id: allowedGroupJid,
            subject: allowedGroupName,
            participants: [
              { id: adminJid, admin: 'admin', lid: 'admin@lid', name: 'Admin' },
              { id: nonAdminJid, admin: null, lid: 'nonadmin@lid', name: 'NonAdmin' }
            ]
          };
        }
        return null;
      },
      groupFetchAllParticipating: async () => ({
        [allowedGroupJid]: {
          id: allowedGroupJid,
          subject: allowedGroupName,
          participants: [
            { id: adminJid, admin: 'admin', lid: 'admin@lid', name: 'Admin' },
            { id: nonAdminJid, admin: null, lid: 'nonadmin@lid', name: 'NonAdmin' }
          ]
        }
      })
    };

    it('allows group admin to execute !syncmembers in group chat', async () => {
      const msg = { key: { participant: adminJid, remoteJid: allowedGroupJid } };
      const res = await routeCommand(
        mockSock,
        '!syncmembers',
        allowedGroupJid,
        'Admin',
        msg,
        {}
      );
      assert.ok(res);
      assert.match(res, /Synced group membership for \*Bot-testing\*/);
      assert.match(res, /Names:/);
      assert.match(res, /Ratings:/);
      assert.match(res, /Activity:/);
    });

    it('allows group admin to execute !syncmembers with --group in DM', async () => {
      const msg = { key: { participant: adminJid, remoteJid: 'dm@s.whatsapp.net' } };
      const res = await routeCommand(
        mockSock,
        '!syncmembers --group="Bot-testing"',
        'dm@s.whatsapp.net',
        'Admin',
        msg,
        {}
      );
      assert.ok(res);
      assert.match(res, /Synced group membership for \*Bot-testing\*/);
    });

    it('rejects non-admin from executing !syncmembers', async () => {
      const msg = { key: { participant: nonAdminJid, remoteJid: allowedGroupJid } };
      const res = await routeCommand(
        mockSock,
        '!syncmembers',
        allowedGroupJid,
        'NonAdmin',
        msg,
        {}
      );
      assert.ok(res);
      assert.match(res, /Only group admins/);
    });

    it('rejects --group flag when called from within group chat', async () => {
      const msg = { key: { participant: adminJid, remoteJid: allowedGroupJid } };
      const res = await routeCommand(
        mockSock,
        '!syncmembers --group="Bot-testing"',
        allowedGroupJid,
        'Admin',
        msg,
        {}
      );
      assert.ok(res);
      assert.match(res, /The --group option can only be used when sending commands in a direct message/);
    });
  });
});
