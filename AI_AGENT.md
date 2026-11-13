# MAHNGUELOH MD — Persistent Code Agent

Owner-only commands that let the bot search and reason about its own source
code, with a small persistent memory across restarts.

## What's real and verified

- `lib/projectAgent.js` builds a searchable index of the bot's own source
  tree (via the existing `lib/codeContext.js`, which already excludes
  `.env`, `auth_info`, and `node_modules` — this agent inherits that safety
  boundary, it doesn't bypass it).
- `data/ai-agent/` stores the index and owner memories on disk.
- `plugins/codeAgent.js` adds `.agent`, `.remember`, `.agentrefresh`, and
  `.agentstatus` — all gated by the bot's existing owner check
  (`ownerOnlyCmds`), same as `.repair`/`.aitest`.
- Answers go through the normal Claude → OpenAI → Gemini → DeepSeek fallback
  chain in `lib/aiProviders.js`.

## Owner commands

- `.agent <question>` — ask the agent to inspect the repository and explain
  what it finds.
- `.remember <fact>` — store a durable project fact the agent recalls in
  future `.agent` answers.
- `.agentrefresh` — force a full source index rebuild.
- `.agentstatus` — show indexed file count, memory count, last index time.

## Two claims from an earlier version of this doc that were not true

- **"`lib/aiProviders.js` supports an optional Ollama/local model provider."**
  It doesn't — there is no Ollama code anywhere in that file. The
  `OLLAMA_ENABLED` setup instructions that used to be here did nothing.
  Removed rather than left in place to avoid someone configuring an env var
  that has no effect.
- **"`.mycode` now uses repository-wide retrieval instead of a fixed
  12k-character file limit."** It doesn't — `plugins/selfCode.js` is
  unchanged. `.mycode` still works exactly as before (single-file lookup or
  keyword search); `.agent` is the new, separate, repository-wide command.
  Use `.agent` when you want the broader search; `.mycode <file>` is still
  the fastest path for "explain this specific file."
