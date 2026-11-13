# MAHNGUELOH VANTA 3.4.3 — Merged Release Notes

## What's genuinely new in this release
- Sports commands are now generated from one league/type registry (`getSportsCommands()`),
  so the command list can't drift out of sync with what's actually implemented.
  Added aliases (`.pl`, `.prem`, `.liga`, `.bundes`, `.champions`, `.europa`, `.worldcup`, etc.)
  and type aliases (`table`, `results`, `fixtures`, `next`).
- Match results/upcoming are now explicitly sorted by kickoff date before display
  (previously assumed the API already returned them sorted).
- `.sports` / `.sport` shows the valid command family.
- Added a lightweight, optional personality layer on plain text replies — toggle with
  `.funmode on|off` (default: on, ~45% of replies get a line, configurable via
  `FUN_RESPONSES` / `FUN_RESPONSE_CHANCE` in `.env`).
- `npm run audit:bot` — syntax-checks every file, validates the sports registry, and
  scans for hardcoded credential literals **everywhere**, config.js included.
- **Session ID no longer overwrites a live, already-registered `auth_info/creds.json`
  on every reconnect.** This was a real bug: every reconnect was re-decoding the
  original SESSION_ID snapshot and rewriting it over the current (more advanced)
  Signal session state — which can roll the ratchet backward and manufacture the
  exact Bad MAC symptoms this project spent a long time chasing.
- Bad MAC recovery is now targeted: it identifies the specific `session-*.json`
  file(s) implicated by the error instead of wiping the whole auth database, with
  a cooldown so recovery attempts can't storm.
- `connect()` is now serialized (a single in-flight connection attempt at a time)
  and stale sockets from a previous generation can no longer interfere with a
  newer one.
- Updated Baileys 6.7.23 → 6.7.24.

## Correcting a claim from an earlier version of these notes
An earlier changelog claimed hardcoded AI credentials had been "removed from
config.js." **That was not accurate** — the previous release still shipped a real,
live OpenAI key hardcoded as a fallback default in `config.js`. It's genuinely
removed now (verified via `npm run audit:bot`, which itself was previously
written to skip scanning config.js — that exemption has been removed too, since
this project gets pushed to GitHub via `.updatecode` and handed out as a
template, so "centralized in one file" was never actually safe).

**If you're the person who deployed this in earlier form: rotate your OpenAI key.**

## An advertised feature that was never actually implemented
An earlier changelog also claimed a "persistent AI Code Agent" with `.agent`,
`.remember`, `.agentrefresh`, and `.agentstatus` commands. None of those exist
anywhere in the delivered code — no trace of them at all. Treat that changelog
entry as false; it isn't in this release either, since it was never real.

## Setup
1. `.env` ships with this zip, blank, ready to fill in — no `npm install`/Start
   cycle needed just to see it.
2. Fill in **either** `SESSION_ID` or `PHONE_NUMBER` in `.env` (not `config.js` —
   `.env` is git-ignored and never committed; a value pasted into `config.js`
   risks being published the moment this gets pushed anywhere).
3. Start the bot.
4. Optional AI providers: set any of `OPENAI_API_KEY`, `GEMINI_API_KEY`,
   `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `SAVAGE_API_KEY` in `.env`. All are
   optional; leaving one blank just disables that provider.

## Round 2: merging a further "Mahngueloh-MD.zip" export
- Added the `.agent`/`.remember`/`.agentrefresh`/`.agentstatus` code agent
  commands — this time they genuinely exist and work (verified: owner-gated,
  built on the existing safe file-exclusion boundary in `lib/codeContext.js`).
- The exact same hardcoded OpenAI/Gemini/Savage keys from before showed up
  again in this export's `config.js`, and `scripts/audit.js` had reverted to
  exempting config.js from its own credential scan. Both fixed again. If
  you're regenerating zips from an earlier saved copy/conversation elsewhere,
  every regeneration is bringing the leaked key back — that source copy
  should be treated as compromised and not reused as a base going forward.
- Two more false claims found and corrected — see `AI_AGENT.md`: a claimed
  Ollama/local-model provider that doesn't exist in the code, and a claimed
  `.mycode` upgrade that never actually happened.

## Round 10: antibot — deadlier detection, instant-kick on overwhelming evidence
- New fingerprint: a reply containing "pong" + a latency figure + "uptime" together — nobody produces
  that combination by hand, every .ping handler in existence does. Scored as strong as openly saying
  "I'm a bot."
- New structured-status-card detector: counts "Label: value" lines (Dev:, Cmds:, Server:, Speed:, RAM:,
  Mode:, Prefix:, etc.) — the shape of nearly every bot's .menu/.status output regardless of its
  branding or wording, so a totally different bot codebase with its own theme still gets caught.
- When two independent strong signals agree (e.g. a Baileys-shaped message ID on a textbook status
  card) it's no longer treated as a borderline case needing 3 warnings first — it's removed
  immediately, on the first message, regardless of the group's configured antibot action.
- Verified against the actual foreign-bot output that was slipping through (PONG/latency/uptime cards
  and MUFASER-X-style menu cards): both now score well past the threshold.
- Reminder this doesn't change: `.antibot` is still per-group and off by default, and admins are still
  exempt unless `.antispare on` is also set — if a foreign bot is itself a group admin, both need to be
  on for it to be touched at all.

## Round 9: .antispare
- New `.antispare on|off` (per group, default off). On: admins — owner included — lose their
  exemption from antilink, antispam, antisticker, antivoicenote, antibug, antigroupmention and
  antibot, and get warned/deleted/kicked exactly like anyone else.
- Safety guard added alongside it: this bot's own connected account (fromMe) is now never acted on
  by any of those checks, regardless of antispare. Without this, enabling antispare on a self-bot
  (where the owner's number IS the bot's number) could have made the bot try to kick itself out of
  its own group the next time the owner's account triggered a check.

## Round 8: short (MH~) session ID support + fixed the generator app
- Found why the new short "MH~" session IDs looked like they worked but were
  actually dead ends: the pairing-site generator (encodeSession) stored the
  real session data in its own server memory, keyed by that short ID — but
  nothing in the generator ever served that data back out. Any bot pasted
  that ID could never actually redeem it. Fixed the generator (separate
  project, zipped alongside this one) by adding the missing
  GET /api/session/:id endpoint; it's one-time-use (deleted the moment it's
  fetched) on top of its existing 30-minute expiry.
- This bot now understands BOTH formats: MAHNGUELOH~... (self-contained,
  never expires, no network needed to redeem — still the most reliable) and
  MH~... (shorter, fetched from the pairing site, one-time use, ~30 min).
- Console login flow restaged to match: "Creating env and saving your
  session id..." → "Done" → "Starting..." for both formats and for phone
  pairing, with clearer colored output explaining the tradeoff between the
  two session formats up front.

## Round 7: news silence root-cause fix, Facebook token expiry warnings, stronger antibot, mentions by name
- **Root cause of "news posts for an hour or two then goes silent forever":** the news scheduler's
  timer (and a separate cleanup timer in antiSpam.js) were `.unref()`'d, meaning they didn't count
  towards keeping the whole Node process alive. If either was ever the last active thing Node saw,
  the process could exit quietly — no crash, no error, no log line, no auto-restart — which matches
  "goes silent, never to post again" far better than an actual crash (a crash gets logged and the
  host restarts the process, so news would eventually resume). Both are no longer unref'd.
- **Facebook token expiry — the other half of the same symptom:** a token copied straight from the
  Graph API Explorer without extending it is short-lived (~1 hour) and dies with zero warning.
  `.fbaccesstoken` now checks real expiry via `/debug_token` and tells you immediately if it's
  short-lived, with the exact expiry time and how to get one that never expires. The news cycle also
  warns the owner once when a connected token is within 20 minutes of expiring, and `.fb status`
  shows the expiry.
- Facebook posting now auto-disables itself on a PERMANENT failure (expired/invalid token) instead of
  retrying the same dead end on every future article forever, and tells the owner once, in their own
  chat, why. This was directly filling up console/log volume over hours on a memory-constrained host.
- `.news silent on|off` (default ON): stops mirroring every check/post to the console while still
  recording everything (`.news logs` shows it all either way) — the console spam from a broken,
  endlessly-retrying channel was a real contributor to the memory growth that crashed the bot.
- Capped sharp's internal image cache — unnecessary overhead for a bot that brands one image
  occasionally, and this host runs on a tight memory budget.
- `.antibot` is now much stronger: any message whose ID has the exact shape Baileys (official or any
  rebranded fork) generates is flagged immediately as automation output — proof of origin, not a
  content guess — catching a foreign bot's very first message instead of waiting for its text to look
  bot-like.
- `.repo`/`.menu`: the "hey @you" mention now shows the caller's name instead of their raw phone number.

## Round 6: human-style Hugging Face chatbot
- New teachable chatbot on Hugging Face Inference Providers (`lib/humanChat.js`, `plugins/humanChat.js`).
  Short, casual replies with a typing delay; answers DMs, and in groups only when @mentioned,
  replied to, or called by name. OFF by default: `.chatbot off|dm|group|all`.
- Teach it: `.chatteach <words> => <reply>` (instant exact replies, e.g. the repo link),
  `.chatfact`, `.chatpersona`, `.chatname`; manage with `.chatlist`, `.chatforget`, `.chatunteach`.
- Setup from chat: `.hftoken <token>` (DM only, message deleted, never echoed), `.hfmodel <id>`,
  `.chatstatus`. `.chat <text>` talks to it directly.
- Safety: replies as an assistant and admits it when sincerely asked; ignores the owner's own messages
  and other Baileys bots; per-sender / per-chat / global rate limits; errors stay silent in auto mode.
- Replaced the old `.chatbot` DM toggle; `.ai/.ask/.gpt` are unchanged.
- Taught data lives in `data/chatbrain.json` (git-ignored).

## Round 5: antiraid fix, command audit, chatbot off, Facebook setup commands
- Fixed `.antiraid` (plus `.antibadword`, `.everyone`, `.stealthtag`, `.count`): the handlers existed
  but the commands were missing from the group command list, so they were silently dropped.
- Anti-raid now counts every joiner in a batch, not one per event.
- `.status` now works (alias of `.botstatus`).
- DM chatbot is OFF by default (`config.chatbotEnabled`, `CHATBOT_ENABLED=true` or `.chatbot` to enable);
  `.ai/.ask/.gpt` are unaffected.
- New `.fbpageid <id>` and `.fbaccesstoken <token>`: saved to settings.json, validated against Facebook,
  publishing turns on automatically, no restart or .env needed. Token is never echoed, the message it was
  pasted in is deleted, and it is refused inside groups. `.fb on/test/status` no longer require .env.
- settings.json is now git-ignored (it can hold the Facebook token).

## Round 4: single Baileys swap to @neoxr/baileys + native group status
- Replaced the Baileys dependency with `@neoxr/baileys` (pinned 8.3.10) in
  package.json and every file that imported it. Startup version check now
  reads the installed version from disk.
- `.gstatus` now posts a real native Group Status via the `groupStatus: true`
  message flag (untested against live WhatsApp from the build environment).
- Added `.antideletepath`, removed `.autorecordtyping`, presence indicators
  hold 7s, antiraid now reports when the bot isn't admin.

## Round 3: wolfsocket swap + merging Claude's parallel fixes
- Swapped `@whiskeysockets/baileys` → `wolfsocket` (a Baileys-API-compatible
  library) consistently across every file that imported it directly (index.js,
  handler.js, and six plugin files) — verified via diff, not just index.js.
- **The hardcoded OpenAI/Gemini/Savage keys reappeared a third time**, this
  round in the zip that shipped the Bad-MAC console-suppression fix. Same
  pattern as before: fixed independently (not by trusting the changelog claim
  that it was already fixed), verified via `npm run audit:bot` passing clean.
  If credential leaks keep reappearing across regenerations like this, treat
  every new export as guilty until `npm run audit:bot` says otherwise — don't
  take a changelog's word for it.
- Bad-MAC console suppression genuinely improved: it now swallows the entire
  multi-line stack-trace block after a "Bad MAC"/"Failed to decrypt" line
  (previously only the first line was caught, so stack traces still flooded
  the console).
- **Recovery-logic change scoped, not fully removed.** An earlier version of
  this fix disabled Bad MAC recovery (reconnect + targeted session cleanup)
  entirely, on the reasoning that the recurring session ID is a stale
  session on a specific remote party's side that local recovery can never
  fix. That reasoning holds for *that specific, already-observed* id — but
  disabling recovery as a blanket policy would also skip it for any
  genuinely new problem that hasn't happened yet. Recovery is now scoped
  per session id: an id that's shown up repeatedly (3+ times) gets logged
  once and silenced, no reconnect attempted; a new id still gets the full
  conservative reconnect-then-targeted-cleanup treatment. Self-healing for
  unknown future problems isn't traded away to silence a known one.
- `.env.example` gained `SAVAGE_API_KEY`, `REMOVEBG_API_KEY`, and
  `YTDLP_COOKIES_FILE` entries (all optional; were missing from the template
  despite `config.js` reading them).

## Round 4: anti-raid / anti-rejoin / copy-paste-flood pack
Built directly rather than wiring in a described-but-unseen antiSpam.js —
no zip was actually provided for this round, only a written spec and three
groups.js edit snippets referencing functions with no visible
implementation. Wiring in calls to functions that don't exist yet breaks
`require()` immediately, so this was implemented from the spec instead:
- **Anti-rejoin** (`antiRejoinCheck`) — every kick mechanism (antilink,
  antispam, antisticker, antivoicenote, antibug, antibot, warn-limit, and
  manual `.kick`/`.kickall`/`.ban`) now records to a shared registry. Anyone
  who rejoins within 15 minutes of being kicked gets removed again
  automatically. `.ban` targets are additionally re-removed indefinitely,
  not just within the 15-minute window — banning was already permanent at
  the message-handling level (`isBanned()`), this extends that permanence
  to actual group re-entry.
- **Anti-raid** (`antiraid` setting, `.antiraid on|off`) — 6+ joins in 30s
  locks the group to admins-only for 5 minutes, then auto-unlocks. Off by
  default.
- **Copy-paste flood** — the same message 3× within 15s triggers `.antispam`'s
  configured action, independent of the existing rate-limiter (which only
  looks at message *count*, not content — this catches someone spacing
  identical messages out slowly enough to dodge that).
- **Bug payloads in captions/filenames/contact cards** — `.antibug`'s
  detection previously only scanned plain message text. It now also scans
  image/video/document captions, document filenames, and contact-card
  (vCard) display names and content — a payload hiding in any of those used
  to sail through entirely. Added signatures for flag-emoji floods and
  `@broadcast` injection attempts. The "repeated chunk" detector was
  deliberately NOT implemented as a backreference regex
  (`/(.{1,20})\1{60,}/`) — that shape is a textbook ReDoS risk on exactly
  the kind of adversarial input a bug payload is; implemented as a bounded
  non-backtracking loop instead (verified: <1ms even on a crafted
  worst-case near-repeat string).
- **Memory sweeper** — a 10-minute interval prunes all the new tracking
  maps (kicks, raid-lock state, join timestamps, copy-paste history) of
  anything past its own retention window.

## Round 5: antibot v2 — weighted scoring
Another round with no actual zip provided initially (a written spec only);
this one came with a real zip. Diffed it file-by-file against the working
tree rather than trusting the "every check passed" claim — worth doing:
**the same hardcoded OpenAI/Gemini/Savage credentials were back, a fourth
time**, in the zip claiming full verification. Fixed independently again.
If this keeps happening, the safe assumption going forward is that every
new export from this line of work needs `npm run audit:bot` run against it
before it's trusted, regardless of what the accompanying message claims.

The actual scoring engine (`scoreBotLikeness()`) was a genuine, well-designed
improvement over the old binary "5+ bulleted lines + wording" rule — it
catches self-identifying bot text, small-caps Unicode styling (ʜᴇʟᴘ, ᴍᴇɴᴜ —
a signal the old version had no equivalent for, and which specifically
catches SHORT bot replies that don't have enough lines to trip a bullet
count), and repeated bot-style output from the same sender. Adopted it, but
not as-is — three real issues found by testing against actual examples from
this conversation, not by inspection alone:
- **Calibration regression**: as shipped, the arrow-bulleted menu (`↠`) that
  was the very first real bug fixed for antibot scored 3, one point under
  the flag threshold — the new version would have UN-fixed an already-fixed
  case. Bumped the 5+-bulleted-lines weight from +2 to +3 to correct this;
  verified against 11 real cases from this conversation afterward, all pass.
- **False-positive risk specific to this bot's own group**: "baileys" and
  "wolfsocket" were in the STRONG self-identification tier (+4 alone, an
  instant flag). This bot's group is literally about WhatsApp bot
  development — "anyone know how to fix a baileys bug" is completely normal
  conversation there, and would have gotten an innocent member flagged
  outright. Moved bare engine-name mentions to the weak tier (+2, needs a
  second signal to actually flag); added a separate, more specific
  code-value signal so a genuine "pairing code: ABCD-1234"-style
  announcement still gets caught without penalizing the word "pairing code"
  on its own.
- **Same ReDoS-prone regex as before**: the accompanying BUG_PATTERNS still
  had `/(.{1,4})\1{60,}/s` — a backreference pattern, same vulnerability
  class flagged and fixed with a bounded loop in round 4. Not pulled in;
  kept the existing safe implementation.

## Round 6: the actual real-world miss — captions
User's own screenshot found what round 5's testing didn't catch: an
"AUDIO DOWNLOADER" bot reply (ERFAN-MD) with title/duration/status info
formatted as an image's CAPTION (cover art + text below it), not plain
message text. `antiBotCheck` only ever extracted `conversation`/
`extendedTextMessage.text` — captions were invisible to it entirely,
regardless of how good the scoring itself was. (`antiBugCheck` already had
caption/filename/contact-card scanning from round 4; it was never applied
to `antiBotCheck`.) Fixed: `antiBotCheck` now scores the full
`extractScannableText()` output (captions included) for bot-OUTPUT
detection, while still using plain-text-only for detecting an incoming
foreign-prefix COMMAND (a real typed command isn't hidden in a caption, so
narrowing that path avoids captions being misread as commands).
Verified end-to-end against the actual file (not a standalone snippet) with
a constructed message matching the real caption shape — confirmed it now
deletes and flags it. Also found and fixed a related edge case while
building the realistic multi-message regression test: the "repeated
bot-style output from the same sender" burst signal could itself be
triggered by a weak, ambiguous message (a bare self-id-weak mention alone,
score 2) if that same sender had recent moderate-scoring history — raised
the score floor for what counts toward the burst tally from 2 to 3 so a
single ambiguous message can't stack with itself into a false flag. Full
6-case regression suite (every real bot-output example from this
conversation, run through the actual live function) passes.
