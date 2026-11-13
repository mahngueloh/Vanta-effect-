# AI provider chain — what changed

All AI-powered features (`.ai`/`.ask`/`.gpt`/auto-reply in DM, and `.repair`)
now go through **one** shared chain: `lib/aiProviders.js`. Previously
`aiChat.js` and `repair.js` each had their own separate, inconsistent
fallback logic (and `aiChat.js` didn't even fall back to Claude at all).

## Order (Claude first, Gemini last)

```
claude → openai → gemini → deepseek
```

Set `AI_PROVIDER_ORDER` in `.env` to change it, e.g. `AI_PROVIDER_ORDER=openai,claude,gemini`.

## How the handoff works

- Each provider is tried in order with the **same prompt, image, and
  conversation history** — if one fails, the next one picks up right where
  it left off, so the person chatting never has to repeat themselves.
- A provider that returns a 429 (rate limit) is put on a **5-minute
  cooldown** and skipped automatically on the next few messages instead of
  being retried and failing every time.
- Whichever provider answered last is tried **first** on the next message
  ("sticky" routing), so a working provider doesn't keep losing to a broken
  one ahead of it in the order.
- `.claude`, `.gemini`, `.deepseek` force that specific provider to go
  first (still falling back to the others if it's unavailable).

## New commands

- `.aistatus` (owner only) — shows which providers are configured, which
  key type they're using, cooldown state, and success/fail counts.
- `.aitest` (owner only) — sends a test prompt through every provider one
  at a time and reports pass/fail for each. Use this after editing `.env`.
- `.claude <question>` — same as `.ai` but pins Claude first.

## Vision (image) support — new

`.ai`, `.claude`, `.gpt`, `.ask`, `.bot`, and the plain-text DM auto-reply
now all understand images:

- Send a photo **with your question as the caption** — works directly.
- Or send a photo first, then **reply to it** with your question as a
  separate message (same pattern as `.remini`).
- Only Claude, OpenAI, and Gemini can see images (DeepSeek is text-only) —
  the chain skips straight past DeepSeek automatically when an image is
  attached.
- Images over 5MB are rejected with a clear message instead of silently
  failing.

## ⚠️ About the "Savage API" Claude/DeepSeek endpoints

Your project already used `https://savage-api-production.up.railway.app`
as a no-signup way to get "Claude" and "DeepSeek" replies (`config.savageApiKey`,
`config.savageApiBase`). I kept it as a fallback since it was already wired
in — but flagging honestly: **it's an unofficial third-party relay**, not
Anthropic or DeepSeek directly. There's no way for me to verify:

- that it's actually forwarding to the real models it claims to be (rather
  than something else relabeled),
- that the shared public key (set via `SAVAGE_API_KEY` in `.env`) won't get cut off or rate
  limited with zero notice since it's shared across every user of that API,
  or
- that it's authorized to resell access to those models at all.

It also **can't do images at all** — text prompt only.

**Recommended fix:** get your own key from
[console.anthropic.com](https://console.anthropic.com) and set
`ANTHROPIC_API_KEY` in `.env`. The moment that's set, the chain
automatically uses the real Anthropic API instead of the Savage relay for
Claude — full quality, vision-capable, no code changes needed. Same idea
for DeepSeek via `DEEPSEEK_API_KEY` from platform.deepseek.com.

## New `.env` variables (all optional — sensible defaults are already set)

```
ANTHROPIC_API_KEY=       # get a real, vision-capable Claude — recommended
ANTHROPIC_MODEL=claude-sonnet-4-6
DEEPSEEK_API_KEY=        # get a real DeepSeek instead of the Savage relay
OPENAI_VISION_MODEL=gpt-4o-mini
GEMINI_VISION_MODEL=gemini-3.5-flash
AI_PROVIDER_ORDER=claude,openai,gemini,deepseek
```

## Files touched

- `lib/aiProviders.js` — **new**, the shared chain
- `config.js` — new AI env vars
- `plugins/aiChat.js` — rewritten to use the chain + image support
- `plugins/repair.js` — `.repair` now uses the same chain (was duplicated,
  Gemini-first logic before)
- `handler.js` — `.claude` command added, `.gemini`/`.deepseek` actually
  force their provider now (previously `.gemini` had dead code that didn't
  do anything), `.aistatus`/`.aitest` added
- `lib/envCheck.js` — boot diagnostics show the new AI env vars
- `plugins/menu.js` — `.claude` added to the AI menu
