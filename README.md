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

Set 1:
  Court 1: Mike & Sara (6.98) vs John & Alex (6.98)
  Court 2: Priya & Ben (7.02) vs Tom & Lisa (7.00)

Set 2:
  Court 1: Mike & Ben (6.90) vs Tom & Alex (7.10)
  Court 2: Priya & John (7.04) vs Sara & Lisa (6.96)

(numbers are pairing ratings -- the sum of both players' ratings)
```

- **Courts**: players are split four to a court, so an 8-person poll makes 2 courts, a 4-person poll makes 1, a 12-person poll makes 3, etc. Matchups are listed by set, not by court, because the whole group is re-drawn for each set — you move courts as well as partners.
- **Rotation**: each set is scored on the pairings it repeats, and the lowest-repeat draw wins. Within a session nobody partners the same person twice, and where the court count allows it you don't face the same opponents twice either. With 2 courts a complete swap would just put the same four people back together, so half the players stay put and the foursomes reshuffle instead.
- **Freshness across weeks**: partners and opponents from the last 3 weeks are remembered in `pair-history.json` and counted against repeat pairings, weighted so last week's pairing matters about twice as much as one from two weeks ago. Over six weekly 8-person polls this typically uses all 28 possible partnerships before repeating any of them. Deleting the file is harmless — draws just go back to being unbiased.
- **Even courts**: the draw also tries to keep the two pairing ratings on a court within **0.49** of each other (see [Player ratings](#player-ratings)). With 8 or more players this essentially always succeeds while still avoiding every repeat pairing.
- **Conflicts**: if two people vote for the same numbered slot, the bot posts a heads-up naming who needs to switch, and won't generate matchups until every slot has exactly one voter.

Related commands:
- `!cancelpoll` — stop the current poll from auto-generating matchups (e.g. if plans changed)
- `!rematch` — re-run matchup generation from the same poll's final votes (useful if someone drops out and you want fresh pairings among the rest — you'd still need to manually adjust the player list logic if the group size changes). A rematch replaces that poll's entry in the pairing history rather than adding a second one, so re-rolling doesn't make the session count double against future draws.

**Note on phrasing**: poll creation is triggered by any `@tenbot` message containing the word "poll" plus a number — it's a simple keyword match, not full natural-language understanding. `@tenbot create a poll for 8` works; something like `@tenbot what was that poll about pizza last week` would also trigger it, but only when it contains a number too, so it's a narrow enough phrase in practice not to misfire on typical group chatter. If you want a stricter phrase, edit the regex in `getResponse()` in `index.js`.

## Other commands

| Command | What it does |
|---|---|
| `!free <when>` | Marks you as free to play, e.g. `!free Sat 9am` |
| `!free` | Shows everyone currently marked as free |
| `!notfree` | Removes you from the availability list |
| `!clearfree` | Clears the whole availability list |
| `!score <winner> def <loser> <score>` | Records a match and updates ratings, e.g. `!score Mike & Sara def John & Alex 6-4 6-2` |
| `!leaderboard` | Shows the win/loss leaderboard |
| `!ratings` | Shows player ratings, strongest first |
| `!weather [location]` | 3-day forecast; defaults to `DEFAULT_LOCATION` if you don't specify one |
| `!reset` | Clears the bot's conversation memory for this chat |
| `!ping` / `!help` | Health check / command list |
| `@tenbot <question>` | Ask anything — answered by Claude, with live availability/leaderboard/poll data as context |

The `@tenbot` prefix keeps the bot from replying to every single message. Change or remove it via `TRIGGER_PREFIX` in `index.js`.

## Player ratings

Every player carries a rating between **2.50 and 4.50**, to two decimals, starting at **3.49**. A **pairing's rating is the sum of its two players'**, so two fresh players pair at 6.98. Ratings are stored in `ratings.json` and shown by `!ratings`; a player is seeded at the starting rating the first time a poll they're in fills up.

Ratings do two things: they balance the draw (courts aim to be within 0.49, see above), and they move when you record a set with `!score`.

**How a set moves ratings** — each set in a recorded score is applied in order, and what happens depends on the pairing ratings going into that set:

| Outcome | Movement per player |
|---|---|
| Higher-rated pairing wins | `0.01 × game margin` — up for the winners, down for the losers |
| Lower-rated pairing wins (upset) | `pairing-rating gap × (game margin / 12)` — up for the winners, down for the losers |

So a 6-4 win by the favourites moves everyone 0.02. The same 6-4 as an upset, with a 0.40 gap between the pairings, moves everyone `0.40 × 2/12 = 0.07` — beating a stronger pairing is worth more, and worth most when you beat them convincingly. Deltas are rounded to the nearest 0.01 and every rating is capped to the 2.50–4.50 band. Equal pairing ratings count as a favourite win, since there'd be no gap for the upset formula to divide up. A tied set (e.g. `6-6`) moves nobody.

Multi-set scores are applied set by set, each seeing the ratings the previous set left behind — so the favourite can change partway through a match, as in `!score Mike & Sara def John & Alex 4-6 6-2`.

## How data is stored

Availability and match results are saved to a local `data.json` file (created automatically on first use) so they survive restarts. Recent partner/opponent pairings go in `pair-history.json` (see "Freshness across weeks" above), pruned to the last 3 weeks each time it's written. Player ratings live in `ratings.json`.

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
