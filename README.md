# Tennis Group Bot (Baileys edition)

A WhatsApp bot for a tennis group, built with [Baileys](https://github.com/WhiskeySockets/Baileys). It coordinates who's free to play, schedules daily matches with a WhatsApp poll (auto-generating doubles matchups once it fills up), tracks match results and a leaderboard, checks weather for outdoor play, and answers general questions using Claude.

## Why Baileys instead of whatsapp-web.js

Baileys connects to WhatsApp directly over a WebSocket — no headless browser or Puppeteer involved — so it doesn't depend on scraping WhatsApp Web's internal (frequently-changing) JavaScript the way `whatsapp-web.js` does. It's still an **unofficial** client, so the usual caveat applies: you're automating a real personal WhatsApp account, which is against WhatsApp's Terms of Service. Fine for light personal/group use, but avoid high-volume/spammy behavior.

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

3. **Set your default location** for weather checks — edit `DEFAULT_LOCATION` in `index.js` (defaults to `"San Jose, CA"`).

4. **Confirm your target group name**
   - `TARGET_GROUP_NAME` in `index.js` is already set to `"Bot-testing"` — the bot only listens in a group with that exact name
   - Scan the QR code that appears in your terminal (WhatsApp app → Settings → Linked Devices → Link a Device)
   - If you rename the group or want to point at a different one, set `TARGET_GROUP_NAME` to `null`, restart, and send any message in the group you want — its name prints to the console — then copy that exact name back into `index.js`

5. **Run it**
   ```bash
   npm start
   ```

## Scheduling matches with polls

Send `@tenbot create a poll for 8` (or 4, 12, etc. — any multiple of 4) and the bot posts a native WhatsApp poll with numbered slots 1 through 8. Members tap a number to claim that spot.

You can optionally include a day and/or time — the bot echoes it back in the poll title:

```
@tenbot create a poll for 8 on Saturday at 9am
```
→ poll titled "🎾 Vote for a spot! (8 spots -- Saturday 9am)", and the matchup announcement is headed with "📅 Saturday 9am" once it fills up.

Times need an `am`/`pm` (e.g. `9am`, `6:30pm`) for the bot to recognize them as a time rather than the player count — a 24-hour time like `18:00` won't be picked up as "when". Day names (today, tomorrow, tonight, or Monday–Sunday, full or abbreviated) are recognized regardless of case. If no day/time is given, the poll just says "for today's matches".

Once every slot has exactly one vote, the bot automatically posts doubles matchups:

```
🎾 All spots filled! Here are today's matchups:

Court 1:
  Set 1: Mike & Sara vs John & Alex
  Set 2: Mike & John vs Sara & Alex

Court 2:
  Set 1: Priya & Ben vs Tom & Lisa
  Set 2: Priya & Tom vs Ben & Lisa
```

- **Courts**: players are randomly split into groups of 4 (one court each), so an 8-person poll makes 2 courts, a 4-person poll makes 1, a 12-person poll makes 3, etc.
- **Partner rotation**: within each court, set 2 always uses a different partner pairing than set 1, so nobody plays the same partner twice.
- **Conflicts**: if two people vote for the same numbered slot, the bot posts a heads-up naming who needs to switch, and won't generate matchups until every slot has exactly one voter.

Related commands:
- `!cancelpoll` — stop the current poll from auto-generating matchups (e.g. if plans changed)
- `!rematch` — re-run matchup generation from the same poll's final votes (useful if someone drops out and you want fresh random pairings among the rest — you'd still need to manually adjust the player list logic if the group size changes)

**Note on phrasing**: poll creation is triggered by any `@tenbot` message containing the word "poll" plus a number — it's a simple keyword match, not full natural-language understanding. `@tenbot create a poll for 8` works; something like `@tenbot what was that poll about pizza last week` would also trigger it, but only when it contains a number too, so it's a narrow enough phrase in practice not to misfire on typical group chatter. If you want a stricter phrase, edit the regex in `getResponse()` in `index.js`.

## Other commands

| Command | What it does |
|---|---|
| `!free <when>` | Marks you as free to play, e.g. `!free Sat 9am` |
| `!free` | Shows everyone currently marked as free |
| `!notfree` | Removes you from the availability list |
| `!clearfree` | Clears the whole availability list |
| `!score <winner> def <loser> <score>` | Records a match, e.g. `!score Mike def John 6-4 6-2` |
| `!leaderboard` | Shows the win/loss leaderboard |
| `!weather [location]` | 3-day forecast; defaults to `DEFAULT_LOCATION` if you don't specify one |
| `!reset` | Clears the bot's conversation memory for this chat |
| `!ping` / `!help` | Health check / command list |
| `@tenbot <question>` | Ask anything — answered by Claude, with live availability/leaderboard/poll data as context |

The `@tenbot` prefix keeps the bot from replying to every single message. Change or remove it via `TRIGGER_PREFIX` in `index.js`.

## How data is stored

Availability and match results are saved to a local `data.json` file (created automatically on first use) so they survive restarts.

**Polls are different**: poll state (who's voted for what, whether it's resolved) lives in memory only, not in `data.json`, because the data involves WhatsApp's internal message/vote objects which don't serialize cleanly to JSON. This means **if the bot restarts while a poll is still open, that poll's vote progress is lost** — people would need to re-vote, or you'd create a new poll. For a same-day, same-session use case (create the poll, everyone votes over the next hour, matchups get posted) this isn't a practical issue, but it's worth knowing if you're planning to leave polls open across bot restarts.

## Grounding the LLM in real data

When someone asks the bot something via `@tenbot`, it includes a live snapshot of current availability, the top of the leaderboard, recent match results, and the status of any active poll in the system prompt — so questions like "who's free this weekend?" or "has the poll filled up yet?" get answered from your actual group data instead of the model guessing. The instructions also tell it to say so if the answer isn't in that data, rather than making something up.

## Weather

Uses [Open-Meteo](https://open-meteo.com) — free, no API key needed. It geocodes whatever location you give it (or `DEFAULT_LOCATION` if none), then pulls a 3-day forecast with expected temps and rain probability.

## Session persistence

The bot uses `useMultiFileAuthState`, saving your login session to a local `auth_info_baileys/` folder after the first QR scan. If you ever get logged out, delete that folder and re-scan.

## Troubleshooting

- **QR code not scanning / times out**: restart the bot and try again; make sure your phone has an internet connection.
- **Connection keeps closing and reconnecting in a loop**: usually a stale session — delete `auth_info_baileys/` and re-scan.
- **Bot not responding in group**: double check `TARGET_GROUP_NAME` matches the group name exactly (case-sensitive — currently `"Bot-testing"`), and that your message uses a valid command or starts with `@tenbot`.
- **`!score` says it couldn't parse the message**: the format is strict — `!score <winner> def <loser> <score>`, with scores as space-separated `N-N` pairs (e.g. `6-4 6-2`).
- **Weather lookup fails**: usually means the location name didn't match anything in the geocoding lookup — try a more specific or differently-spelled name.
- **Poll doesn't trigger matchups even though it looks full**: check the console log for a conflict warning — if two people picked the same number, the bot is waiting for one of them to switch before it'll generate matchups. Also confirm the poll size was a multiple of 4 when created.
- **Voter shows up as "Player (1234)" instead of their name**: the bot labels voters using names it's seen from their regular text messages in the group. If someone votes in a poll without ever having sent a text message the bot saw, it won't have a name for them yet — ask them to send any message in the group once, and future polls will show their name correctly.

## Ideas to extend further

- **Persist poll state properly** — swap the in-memory poll tracking for a lightweight database if you want polls to survive restarts
- **Court booking reminders** — combine with `node-cron` to auto-create the daily poll at a set time each morning
- **Head-to-head stats** — extend `getLeaderboard()` in `lib/storage.js` to show win/loss records between specific pairs of players
- **Rain-check auto-nudge** — check `!weather` automatically the morning of a scheduled match and warn the group if rain is likely
