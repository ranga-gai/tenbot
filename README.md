# Tennis Group Bot

A WhatsApp bot for a tennis group. It coordinates who's free to play, schedules matches with WhatsApp polls (auto-generating singles/doubles matchups and rotations, or opt-in Yes/No polls), passively tracks user-created manual tennis match polls, tracks match results and a leaderboard, syncs player ratings from TennisRecord, checks weather for outdoor play, and answers general questions using Claude. It uses [Baileys](https://github.com/WhiskeySockets/Baileys) for WhatsApp integration.

# Development

Authors:

* Pramod Immaneni <pramod.immaneni@gmail.com>
* Google Antigravity, Anthropic Claude

## Setup

1. **Install dependencies** (requires Node.js 18+):
   ```bash
   npm install
   ```

2. **Add your Anthropic API key**
   - Copy `.env.example` to `.env`
   - Get a key from [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)
   - Paste it into `.env` as `ANTHROPIC_API_KEY=sk-ant-...`
   - Note: this is the paid API, billed per token, separate from a claude.ai subscription

3. **Set your default location & timezone** for weather checks and scheduling:
   - Edit `DEFAULT_LOCATION` in `index.js` (defaults to `"San Jose, CA"`).
   - Time resolution is anchored to San Jose, CA (`America/Los_Angeles` / Pacific Time).

4. **Confirm your target group name**
   - `TARGET_GROUP_NAME` in `index.js` is set to your group name — the bot only listens in a group with that exact name.
   - Scan the QR code that appears in your terminal (WhatsApp app → Settings → Linked Devices → Link a Device).
   - If you rename the group or want to point at a different one, set `TARGET_GROUP_NAME` to `null`, restart, and send any message in the group you want — its name prints to the console — then copy that exact name back into `index.js`.

5. **Run it**
   ```bash
   npm start
   ```

---

## Scheduling matches with polls

The bot supports bot-created match polls as well as user-created manual match polls:

### 1. Fixed-Spot Polls (Singles & Doubles)
Send `@tenbot create a poll for 8` (or 2 for singles, 4, 12, etc. — any multiple of 4 for doubles).
- The bot posts a native WhatsApp poll.
- By default, the person requesting the poll is automatically added as **Player 1**, with open voting slots starting from **Player 2** (`Player 2` .. `Player 8`).
- Once all spots are filled (each slot has exactly one voter), the bot automatically posts balanced singles/doubles matchups with court rotations.

### 2. Yes/No Opt-In Polls (Unspecified Player Count)
If no number of players is specified (e.g. `@tenbot create a poll for tomorrow 9am` or `@tenbot create a poll for tonight 6pm`):
- The bot creates a poll with two options: **"Yes"** and **"No"**.
- Players vote "Yes" to opt in.
- Since the total number of players is not fixed ahead of time, the bot waits for a user prompt to generate matchups.
- When ready, say `@tenbot generate matchups` (or `!matchups`, `!draw`, `!rematch`), and the bot generates singles (for 2 Yes voters) or doubles rotations (for 4, 8, 12... Yes voters), ignoring anyone who voted "No".

### 3. Manually Created Tennis Match Polls (Passive Tracking & Extra Player Resolution)
If a poll for scheduling matches is created manually by a user directly in WhatsApp:
- The bot **passively tracks** the match poll and its votes without making any changes to the poll or sending slot conflict warnings.
- The bot **will not automatically create matchups** when the poll is filled.
- The bot answers questions about the poll (e.g. `@tenbot who has voted for Saturday's poll?`, `@tenbot who is playing?`, `@tenbot how many spots left?`).
- **Poll Labels & Player Resolution Rules**:
  - **Label Check First (Starting Slot > 1)**: The bot performs a label check first. If the first label doesn't start with the first player (e.g. text like `3` or `Player 3`), the bot includes extra players equal to one less than the first label (e.g. `3 - 1 = 2` extra players: `cname`, `cname 2`).
  - **Valid Total Player Count Check (First Label Index 1 Only)**: Only if the first vote label has index 1 (starts with slot 1 / `Player 1` / opt-in) is the valid total player count check applied (2 for singles, multiples of 4 for doubles), and **only if all vote slots have been filled**. If voting is still in progress and not all slots are filled, extra players are not added.
  - **Extra Player Naming**: Extra player names are generated using the poll creator's name (`cname`): the first extra player is `cname`, the second is `cname 2`, the third is `cname 3`, and so on.
  - **Do Not Always Include Creator**: If a poll starts at slot 1 and already has a valid player count (e.g. 2 for singles, 4/8/12 for doubles), the creator is not automatically added unless they voted in the poll.
- **Matchup Generation on Demand**: If and only if users explicitly ask to create matchups on a manually created match poll (e.g. `@tenbot generate matchups`, `!matchups`, or `!draw`), the bot generates matchups using the exact same rules as bot-created polls.

### 4. Non-Match / General Polls
- Polls not related to tennis match scheduling (e.g. dinner options, ball brands, social plans) are **ignored completely and not tracked**.

---

## Time & Date Handling (San Jose, CA)

You can include a day and/or time in your request:

```
@tenbot create a poll for 8 on Saturday at 9am
```
→ Poll titled `🎾 Creator's match: Vote for a spot! (8 spots -- Saturday 9am)`.

* **Timezone**: All times are resolved in San Jose, California (Pacific Time).
* **Past Day + Time Rejection**: If both a day and time are specified (e.g. `@tenbot create a poll for today at 9am` or `@tenbot create a poll for Saturday 9am` when it is Saturday evening) and that time has already passed, the bot **will not create the poll** and will ask the user to fix the day or time to an upcoming schedule.
* **Past Time-Only Rollover**: If only a start time was specified for creating the poll and the current time is greater than the start time, the bot automatically creates the poll for **the next day with that start time** (`Tomorrow <time>`).
* **Time formatting**: Times require an `am`/`pm` (e.g. `9am`, `6:30pm`, `7pm`). Day names (`today`, `tomorrow`, `tonight`, or `Monday`–`Sunday`) are recognized case-insensitively.

---

## Multiple Polls & 90-Minute Window Protection

Multiple polls can be created concurrently for different times or by different members.
* **90-Minute Separation**: If the same creator has other polls but the new poll's start time is **90 minutes or more** from other polls' start times, the bot creates the poll directly without requiring extra confirmation and includes the creator as Player 1.
* **Conflict Window (< 90 minutes)**: If an active match poll already exists within **less than 90 minutes** of a new poll's start time that includes the creator, the bot creates the new poll with **all spots open** (`Player 1` .. `Player <N>`) rather than auto-assigning the creator as Player 1.

---

## Poll Deletion & Modifications on WhatsApp

* **Cancelling / Deleting Polls**: When a poll is cancelled via `!cancelpoll` / `!deletepoll` or by asking `@tenbot cancel the poll` / `@tenbot delete the poll`, the bot cancels the poll internally and **deletes the poll message directly from WhatsApp**.
* **Modifying Polls**: If a user requests changes to an existing poll (e.g. changing the number of spots, day, or time), the bot creates the updated poll and automatically **deletes the older poll message from WhatsApp**.\n* **Deleted in WhatsApp**: When a poll is deleted for everyone directly in the WhatsApp app (by the creator, an admin, or the bot), the bot listens for the revocation / deletion event across `messages.upsert`, `messages.update`, and `messages.delete`, and automatically clears it from active tracked polls and stored messages.

---

## Matchup Rotations & Court Balancing

Once a fixed poll fills or an opt-in/manual poll draw is requested:

```
🎾 All spots filled! Here are today's matchups:

Set 1:
  Court 1: Mike & Sara vs John & Alex
  Court 2: Priya & Ben vs Tom & Lisa

Set 2:
  Court 1: Mike & Ben vs Tom & Alex
  Court 2: Priya & John vs Sara & Lisa
```

- **Courts**: Players are split 4 to a court (8 players = 2 courts, 12 players = 3 courts, etc.).
- **Rotations**: Lowest-repeat draws ensure players partner with different teammates each set and face different opponents.
- **Freshness across weeks**: Past partnerships from the last 3 weeks are remembered in `pair-history.json` and weighted to avoid repeat pairings across sessions.
- **Even courts**: The draw balances pairings so court rating sums are within **0.49** of each other.
- **Slot Conflicts**: In bot fixed-spot polls, if multiple voters pick the same number, the bot alerts the group to switch slots before generating matchups.

---

## Player Ratings

Every player carries a rating between **2.50 and 4.50**, formatted to two decimals:
- **Initial Rating**: When a player is first encountered, the bot looks up their estimated dynamic rating or NTRP benchmark rating on [TennisRecord.com](https://www.tennisrecord.com/). If not found, their rating starts at **3.49**.
- **User Rating Adjustments**: Users can update their own rating anytime:
  - `@tenbot my rating is 4.0` or `@tenbot set my rating to 3.5`
  - Command: `!setrating 4.0` (or `!myrating 4.0`)
- **Rating Movement**: Ratings adjust dynamically after match scores are reported:
  - Higher-rated pairing wins: `0.01 × game margin`
  - Underdog wins (upset): `gap × (game margin / 12)`
- Ratings are saved in `ratings.json` and viewed with `!ratings`.

---

## Reporting Results in Plain Words

Results can be logged using `!score` or in plain conversational text addressed to `@tenbot`:

```
@tenbot Mike & Sara beat John & Alex 6-4
```
or simply:
```
@tenbot we won 6-4
```
(If no score is mentioned, e.g. `@tenbot we won`, it logs a default 6-3 set).

---

## Commands Summary

| Command | Description |
|---|---|
| `@tenbot create a poll for <N> [when]` | Create a fixed-spot poll with creator as Player 1 |
| `@tenbot create a poll [when]` | Create a Yes/No opt-in poll |
| `@tenbot generate matchups` / `!matchups` | Generate matchups from active poll (opt-in or manual) |
| `@tenbot cancel poll` / `!cancelpoll` | Cancel active poll and delete poll message from WhatsApp |
| `!free <when>` / `!notfree` / `!clearfree` | Manage casual player availability |
| `!score <winner> def <loser> <score>` | Log match score and update ratings / leaderboard |
| `!leaderboard` | View win/loss leaderboard |
| `!ratings` / `!setrating <rating>` | View ratings or set your rating |
| `!weather [location]` | View outdoor tennis weather forecast |
| `!pollstatus` | Debug: inspect active polls and raw vote tally |
| `!cleanuppolls` | Debug: sweep and remove expired polls |
| `!reset` | Clear conversational chat memory |
