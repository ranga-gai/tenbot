# Tennis Group Bot

A WhatsApp bot for a tennis group. It coordinates who's free to play, schedules matches with WhatsApp polls (auto-generating singles/doubles matchups and rotations, or opt-in Yes/No polls), tracks match results and a leaderboard, syncs player ratings from TennisRecord, checks weather for outdoor play, and answers general questions using Claude. It uses [Baileys](https://github.com/WhiskeySockets/Baileys) for WhatsApp integration.

# Development

Authors:

Pramod Immaneni <pramod.immaneni@gmail.com>
Google Antigravity
Anthropic Claude

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
   - `TARGET_GROUP_NAME` in `index.js` is set to `"Bot-testing"` (or your group name in production) — the bot only listens in a group with that exact name.
   - Scan the QR code that appears in your terminal (WhatsApp app → Settings → Linked Devices → Link a Device).
   - If you rename the group or want to point at a different one, set `TARGET_GROUP_NAME` to `null`, restart, and send any message in the group you want — its name prints to the console — then copy that exact name back into `index.js`.

5. **Run it**
   ```bash
   npm start
   ```

---

## Scheduling matches with polls

The bot supports two types of match polls:

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

---

## Time & Date Handling (San Jose, CA)

You can include a day and/or time in your request:

```
@tenbot create a poll for 8 on Saturday at 9am
```
→ Poll titled `🎾 Creator's match: Vote for a spot! (8 spots -- Saturday 9am)`.

* **Timezone**: All times are resolved in San Jose, California (Pacific Time).
* **Past Day + Time Rejection**: If both a day and time are specified (e.g. `@tenbot create a poll for today at 9am` or `@tenbot create a poll for Saturday 9am` when it is Saturday evening) and that time has already passed, the bot **will not create the poll** and will ask the user to fix the day or time to an upcoming schedule.
* **Past Time-Only Rollover**: If only a time is specified without a day (e.g. `@tenbot create a poll for 9am` requested in the evening), and that time has already passed today, the bot automatically schedules the poll for **the next day at that time** (`Tomorrow 9am`).
* **Time formatting**: Times require an `am`/`pm` (e.g. `9am`, `6:30pm`, `7pm`). Day names (`today`, `tomorrow`, `tonight`, or `Monday`–`Sunday`) are recognized case-insensitively.

---

## Multiple Polls & 1-Hour Conflict Protection

Multiple polls can be created concurrently for different times or by different members.
* **1-Hour Window Check**: If an active match poll already exists within **1 hour** of a new poll's start time that includes the creator, the bot creates the new poll with **all slots open** (`Player 1` .. `Player <N>`) rather than auto-assigning the creator as Player 1.

---

## Matchup Rotations & Court Balancing

Once a fixed poll fills or an opt-in poll draw is requested:

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
- **Slot Conflicts**: In fixed-spot polls, if multiple voters pick the same number, the bot alerts the group to switch slots before generating matchups.

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
@tenbot Mike & Sara beat John & Alex 6-4 6-2   → recorded as written
@tenbot John & Alex lost to Mike & Sara 6-4    → same result, sides swapped
@tenbot Mike & Sara vs John & Alex 4-6 6-3     → neutral, winner parsed from score
@tenbot Mike beat John                         → no score given, 6-3 assumed
@tenbot Mike & Sara won                        → opponents filled in from today's draw
@tenbot we beat John & Alex 6-1                → "we" resolves to sender and partner
```

---

## Command Reference

| Command | What it does |
|---|---|
| `!free <when>` | Marks you as free to play, e.g. `!free Sat 9am` |
| `!free` | Shows everyone currently marked as free |
| `!notfree` | Removes you from the availability list |
| `!clearfree` | Clears the whole availability list |
| `!score <winner> def <loser> <score>` | Records a match and updates ratings, e.g. `!score Mike & Sara def John & Alex 6-4 6-2` |
| `!leaderboard` | Shows the win/loss leaderboard |
| `!ratings` | Shows all player ratings, strongest first |
| `!setrating <rating>` | Sets or updates your player rating (`2.50`–`4.50`), e.g. `!setrating 4.0` |
| `!matchups` / `!draw` / `!rematch` | Generates matchups from Yes votes in an opt-in poll, or re-draws an existing match |
| `!cancelpoll` | Cancels the active poll |
| `!pollstatus` | Debug: shows raw vote tallies and voter lists for active polls |
| `!cleanuppolls` | Debug: removes expired/completed polls |
| `!weather [location]` | 3-day forecast for outdoor play (defaults to San Jose, CA) |
| `!reset` | Clears the bot's conversation memory for the chat |
| `!ping` / `!help` | Health check / command list |
| `@tenbot <message>` | Ask anything — answered by Claude with live group, poll, and ratings context |

---

## Data & Persistence

- **Polls**: Tracked in `poll-state.json` and survives bot restarts.
- **Availability & Leaderboard**: Saved in `data.json`.
- **Pairing History**: Saved in `pair-history.json`.
- **Ratings**: Saved in `ratings.json`.
- **WhatsApp Session**: Stored in `auth_info_baileys/`.
