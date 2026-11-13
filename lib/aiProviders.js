'use strict'

// ─────────────────────────────────────────────────────────────────────────
// Unified AI provider chain.
//
// Every place in the bot that needs an AI text/vision reply (aiChat.js,
// repair.js, and anything added later) should call `chatCompletion()` here
// instead of hitting a provider's HTTP API directly. That gives the whole
// bot ONE fallback chain instead of several copy-pasted ones that could
// drift out of sync.
//
// Order of preference (config.aiProviderOrder, default below):
//   1. Claude   — official Anthropic API if ANTHROPIC_API_KEY is set,
//                 otherwise the Savage relay (text-only, see note below).
//   2. OpenAI
//   3. Gemini
//   4. DeepSeek — official API if DEEPSEEK_API_KEY is set, otherwise Savage.
//
// Handoff behaviour:
//   - Providers are tried in order. The moment one throws (bad key, 429,
//     network error, empty response, no vision support for an image
//     request, etc.) the chain immediately moves to the next provider
//     using the SAME prompt/history/image — nothing is lost, the person
//     on the other end never has to repeat themselves.
//   - A provider that just got rate-limited (HTTP 429) is put on a cooldown
//     timer and skipped automatically on the next few messages, instead of
//     being retried and failing again every single time.
//   - The provider that answered last is tried FIRST on the next call
//     ("sticky" routing) — once the primary recovers from a cooldown it
//     naturally becomes first-try again next time its cooldown expires.
//
// ⚠️ A note on the Savage relay (savage-api-production.up.railway.app):
// it's a convenient no-signup fallback already used by this project, but it
// is an unofficial third party — there's no way to verify it's genuinely
// proxying Anthropic/DeepSeek rather than something else entirely, and a
// shared public API key like this can vanish or get rate-limited with zero
// notice. It also can't do vision (image input) at all. Set ANTHROPIC_API_KEY
// / DEEPSEEK_API_KEY in your .env for guaranteed-real, vision-capable access —
// the official key is always preferred automatically the moment it's set.
// ─────────────────────────────────────────────────────────────────────────

const config = require('../config')

// ── Small helpers ───────────────────────────────────────────────────────

function httpErr(status, message) {
    const e = new Error(message || `HTTP ${status}`)
    e.status = status
    return e
}

async function readJson(res) {
    try { return await res.json() } catch { return {} }
}

// ── Per-provider health/cooldown state (in-memory, resets on restart) ───

const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes

const _state = {}
function getState(id) {
    if (!_state[id]) _state[id] = { cooldownUntil: 0, lastError: null, lastOkAt: 0, calls: 0, fails: 0 }
    return _state[id]
}
function isCoolingDown(id) { return getState(id).cooldownUntil > Date.now() }
function markCooldown(id, ms) { getState(id).cooldownUntil = Date.now() + ms }
function markOk(id) {
    const s = getState(id)
    s.lastOkAt = Date.now()
    s.lastError = null
    s.cooldownUntil = 0
    s.calls++
}
function markFail(id, err) {
    const s = getState(id)
    s.lastError = err?.message || String(err)
    s.fails++
}

// The provider that most recently answered successfully — tried first next
// time so a working provider doesn't get bumped by a dead one ahead of it
// in the configured order.
let lastGoodProvider = null

// ── Message-shape builders ───────────────────────────────────────────────

function toAnthropicMessages(history, prompt, image) {
    const msgs = (history || []).map(h => ({
        role: h.role === 'assistant' ? 'assistant' : 'user',
        content: h.content,
    }))
    const content = []
    if (image) content.push({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.base64 } })
    content.push({ type: 'text', text: prompt })
    msgs.push({ role: 'user', content })
    return msgs
}

function toOpenAiMessages(system, history, prompt, image) {
    const msgs = [{ role: 'system', content: system }]
    for (const h of (history || [])) msgs.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content })
    if (image) {
        msgs.push({
            role: 'user',
            content: [
                { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` } },
                { type: 'text', text: prompt },
            ],
        })
    } else {
        msgs.push({ role: 'user', content: prompt })
    }
    return msgs
}

function toGeminiContents(history, prompt, image) {
    const contents = (history || []).map(h => ({
        role: h.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: h.content }],
    }))
    const parts = []
    if (image) parts.push({ inlineData: { mimeType: image.mimeType, data: image.base64 } })
    parts.push({ text: prompt })
    contents.push({ role: 'user', parts })
    return contents
}

// ── Individual provider callers ──────────────────────────────────────────
// Each returns { text, provider, model }. Each throws on failure (with
// `.status` set when it's an HTTP status code, so 429 can be detected).

async function callAnthropicOfficial({ prompt, system, history, image }) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': config.anthropicApiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: config.anthropicModel,
            max_tokens: 1024,
            system,
            messages: toAnthropicMessages(history, prompt, image),
        }),
        signal: AbortSignal.timeout(90000),
    })
    const data = await readJson(res)
    if (!res.ok || data.error) throw httpErr(res.status, data.error?.message || `Anthropic HTTP ${res.status}`)
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim()
    if (!text) throw new Error('Empty Claude response')
    return { text, provider: 'claude', model: config.anthropicModel }
}

async function callClaudeSavage({ prompt, image }) {
    if (image) throw new Error('Savage Claude relay has no vision support')
    if (!config.savageApiKey) throw new Error('No Savage API key configured')
    const url = new URL('/ai/claude3opus', config.savageApiBase)
    url.searchParams.set('apikey', config.savageApiKey)
    url.searchParams.set('prompt', prompt)
    const res = await fetch(url, { signal: AbortSignal.timeout(90000) })
    const data = await readJson(res)
    if (!res.ok || !data.success) throw httpErr(res.status, data.error || `Savage Claude HTTP ${res.status}`)
    if (!data.answer) throw new Error('Empty Claude (Savage) response')
    return { text: data.answer, provider: 'claude', model: 'claude3opus (savage relay)' }
}

async function callOpenAI({ prompt, system, history, image }) {
    if (!config.openaiApiKey) throw new Error('No OpenAI key configured')
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.openaiApiKey}` },
        body: JSON.stringify({
            model: image ? config.openaiVisionModel : 'gpt-4o-mini',
            messages: toOpenAiMessages(system, history, prompt, image),
            max_tokens: 700,
        }),
        signal: AbortSignal.timeout(90000),
    })
    const data = await readJson(res)
    if (!res.ok || data.error) throw httpErr(res.status, data.error?.message || `OpenAI HTTP ${res.status}`)
    const text = data.choices?.[0]?.message?.content?.trim()
    if (!text) throw new Error('Empty OpenAI response')
    return { text, provider: 'openai', model: data.model || 'gpt-4o-mini' }
}

async function callGemini({ prompt, system, history, image }) {
    if (!config.geminiApiKey || config.geminiApiKey.startsWith('PASTE_')) throw new Error('No Gemini key configured')
    const model = image ? config.geminiVisionModel : 'gemini-3.5-flash'
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.geminiApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: toGeminiContents(history, prompt, image),
            generationConfig: { maxOutputTokens: 700, temperature: 0.7 },
        }),
        signal: AbortSignal.timeout(90000),
    })
    const data = await readJson(res)
    if (!res.ok || data.error) throw httpErr(res.status, data.error?.message || `Gemini HTTP ${res.status}`)
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
    if (!text) throw new Error('Empty Gemini response')
    return { text, provider: 'gemini', model }
}

async function callDeepSeekOfficial({ prompt, system, history }) {
    if (!config.deepseekApiKey) throw new Error('No DeepSeek key configured')
    const messages = [{ role: 'system', content: system }]
    for (const h of (history || [])) messages.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content })
    messages.push({ role: 'user', content: prompt })
    const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.deepseekApiKey}` },
        body: JSON.stringify({ model: 'deepseek-chat', messages, max_tokens: 700 }),
        signal: AbortSignal.timeout(90000),
    })
    const data = await readJson(res)
    if (!res.ok || data.error) throw httpErr(res.status, data.error?.message || `DeepSeek HTTP ${res.status}`)
    const text = data.choices?.[0]?.message?.content?.trim()
    if (!text) throw new Error('Empty DeepSeek response')
    return { text, provider: 'deepseek', model: 'deepseek-chat' }
}

async function callDeepSeekSavage({ prompt, image }) {
    if (image) throw new Error('Savage DeepSeek relay has no vision support')
    if (!config.savageApiKey) throw new Error('No Savage API key configured')
    const url = new URL('/ai/deepseekcoder', config.savageApiBase)
    url.searchParams.set('apikey', config.savageApiKey)
    url.searchParams.set('prompt', prompt)
    const res = await fetch(url, { signal: AbortSignal.timeout(90000) })
    const data = await readJson(res)
    if (!res.ok || !data.success) throw httpErr(res.status, data.error || `Savage DeepSeek HTTP ${res.status}`)
    if (!data.answer) throw new Error('Empty DeepSeek (Savage) response')
    return { text: data.answer, provider: 'deepseek', model: 'deepseekcoder (savage relay)' }
}

// ── Provider registry ─────────────────────────────────────────────────────

// GET-based Savage relay endpoints put the whole prompt in a URL query
// string. Large prompts (e.g. `.repair` sending an entire file as context)
// blow past typical proxy/header size limits and come back as HTTP 431 —
// predictably, every time. Rather than let the chain discover that the slow
// way (attempt → wait → 431 → move on), each provider declares a character
// limit that only applies when it's actually using its relay fallback; the
// official POST-based APIs (used the moment a real key is set) have none.
const SAVAGE_RELAY_PROMPT_LIMIT = 3000

const REGISTRY = {
    claude: {
        label: 'Claude',
        vision: true,
        usesOfficialKey: () => !!config.anthropicApiKey,
        available: () => !!config.anthropicApiKey || !!config.savageApiKey,
        maxPromptChars: () => (config.anthropicApiKey ? null : SAVAGE_RELAY_PROMPT_LIMIT),
        run: (args) => (config.anthropicApiKey ? callAnthropicOfficial(args) : callClaudeSavage(args)),
    },
    openai: {
        label: 'OpenAI',
        vision: true,
        usesOfficialKey: () => !!config.openaiApiKey,
        available: () => !!config.openaiApiKey,
        maxPromptChars: () => null,
        run: callOpenAI,
    },
    gemini: {
        label: 'Gemini',
        vision: true,
        usesOfficialKey: () => !!config.geminiApiKey,
        available: () => !!config.geminiApiKey && !config.geminiApiKey.startsWith('PASTE_'),
        maxPromptChars: () => null,
        run: callGemini,
    },
    deepseek: {
        label: 'DeepSeek',
        vision: false,
        usesOfficialKey: () => !!config.deepseekApiKey,
        available: () => !!config.deepseekApiKey || !!config.savageApiKey,
        maxPromptChars: () => (config.deepseekApiKey ? null : SAVAGE_RELAY_PROMPT_LIMIT),
        run: (args) => (config.deepseekApiKey ? callDeepSeekOfficial(args) : callDeepSeekSavage(args)),
    },
}

const DEFAULT_ORDER = ['claude', 'openai', 'gemini', 'deepseek']

function resolveOrder(forceProvider, only) {
    const base = (only && only.length) ? only : ((config.aiProviderOrder && config.aiProviderOrder.length) ? config.aiProviderOrder : DEFAULT_ORDER)
    let order = base.filter(id => REGISTRY[id])
    if (!only) {
        for (const id of Object.keys(REGISTRY)) if (!order.includes(id)) order.push(id) // never silently drop a provider
    }

    // Sticky: whichever provider answered last is worth trying first again.
    if (lastGoodProvider && order.includes(lastGoodProvider)) {
        order = [lastGoodProvider, ...order.filter(id => id !== lastGoodProvider)]
    }
    // An explicit request (e.g. `.gemini`) always goes first, cooldown or not.
    if (forceProvider && order.includes(forceProvider)) {
        order = [forceProvider, ...order.filter(id => id !== forceProvider)]
    }
    return order
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Run a chat/vision completion through the provider chain, handing off to
 * the next provider on any failure until one succeeds.
 *
 * @param {object} opts
 * @param {string} opts.prompt   - the user's message / question
 * @param {string} [opts.system] - system prompt
 * @param {Array}  [opts.history] - [{role:'user'|'assistant', content}]
 * @param {{base64:string, mimeType:string}} [opts.image] - attached image, if any
 * @param {string} [opts.forceProvider] - try this provider first regardless of order/cooldown
 * @param {string[]} [opts.only] - restrict the chain to just these provider ids, in this
 *   order (still falls through on failure same as normal) — e.g. ['gemini','openai'] for
 *   an analysis-only stage that should never fall through to Claude/DeepSeek.
 * @returns {Promise<{text, provider, model, attempts}>}
 */
async function chatCompletion({ prompt, system = '', history = [], image = null, forceProvider = null, only = null }) {
    const order = resolveOrder(forceProvider, only)
    const attempts = []
    let lastErr = null

    for (const id of order) {
        const provider = REGISTRY[id]
        if (!provider.available()) { attempts.push({ id, skipped: 'not configured' }); continue }
        if (image && !provider.vision) { attempts.push({ id, skipped: 'no vision support' }); continue }
        const promptLimit = provider.maxPromptChars ? provider.maxPromptChars() : null
        if (promptLimit && prompt.length > promptLimit) { attempts.push({ id, skipped: `prompt too long for relay (${prompt.length} > ${promptLimit} chars) — set an official key to lift this` }); continue }
        if (isCoolingDown(id) && id !== forceProvider) { attempts.push({ id, skipped: 'cooling down after rate-limit' }); continue }

        try {
            const result = await provider.run({ prompt, system, history, image })
            markOk(id)
            lastGoodProvider = id
            attempts.push({ id, ok: true })
            return { ...result, attempts }
        } catch (e) {
            markFail(id, e)
            attempts.push({ id, ok: false, error: e.message, status: e.status })
            if (e.status === 429) markCooldown(id, RATE_LIMIT_COOLDOWN_MS)
            lastErr = e
            // fall through — hand off to the next provider in the chain
        }
    }

    const err = new Error(lastErr ? `All AI providers failed — last error: ${lastErr.message}` : 'No AI providers are configured.')
    err.attempts = attempts
    throw err
}

function getStatus() {
    return Object.keys(REGISTRY).map(id => {
        const provider = REGISTRY[id]
        const s = getState(id)
        return {
            id,
            label: provider.label,
            configured: provider.available(),
            usesOfficialKey: provider.usesOfficialKey(),
            vision: provider.vision,
            coolingDown: isCoolingDown(id),
            cooldownSecondsLeft: isCoolingDown(id) ? Math.ceil((s.cooldownUntil - Date.now()) / 1000) : 0,
            lastError: s.lastError,
            lastOkAt: s.lastOkAt,
            calls: s.calls,
            fails: s.fails,
            sticky: lastGoodProvider === id,
        }
    })
}

module.exports = { chatCompletion, getStatus, REGISTRY }
