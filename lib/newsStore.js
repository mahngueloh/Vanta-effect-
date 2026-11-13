'use strict'
const fs   = require('fs')
const path = require('path')
let config = { news: {}, facebook: {} }
try { config = require('../config') } catch { /* config always present in practice */ }

const DATA_DIR = path.join(__dirname, '..', 'data')
const FILE     = path.join(DATA_DIR, 'news-state.json')

const MAX_SEEN_IDS   = 8000   // cap so the file never grows unbounded — high enough
                                // that a busy day of sports articles doesn't evict
                                // same-day items from other categories and cause reposts

const MAX_LOG_LINES  = 300
const MAX_RETRY_ITEMS = 200
const MAX_RETRY_ATTEMPTS = 5

const DEFAULT_STATE = {
    // Seeded from NEWS_MONITOR_ENABLED env var on first run only.
    // After that, `.news on` / `.news off` is the source of truth.
    enabled: Boolean(config.news?.defaultEnabled),

    // null = fall back to NEWS_CHECK_INTERVAL_MS env / built-in default.
    // Set via `.news interval <seconds>`.
    checkIntervalMs: null,

    // Owner-controlled per-channel switches — independent from whether the
    // channel is *configured* (that's decided by .env credentials).
    // Seeded from the relevant .env master switches on first run.
    channels: {
        facebook: { enabled: Boolean(config.facebook?.autoPost) },
        whatsapp: { enabled: true },
        telegram: { enabled: Boolean(config.news?.telegramEnabled) },
    },

    seenIds: [],          // array used as an ordered "recently posted" cache

    // Posts that failed on every inline retry get queued here and are
    // retried automatically on the next scan cycles (exponential backoff),
    // without ever re-fetching the RSS feed (avoids duplicate detection).
    retryQueue: [],
    // [{ id, channel, text, imageUrl, headline, sourceName, attempts,
    //    nextAttemptAt, lastError, createdAt }]

    logs: [],              // rolling activity log: [{ at, level, message }]
    // When true (default), addLog() still records everything to `logs`
    // (visible via .news logs) but stops mirroring every line to the console —
    // on a memory-constrained host, hours of a busy news monitor printing to
    // stdout adds up, and some hosting panels keep that console history in
    // memory for their live log view, which was a real contributor to this
    // bot eventually running out of memory. Toggle with .news silent on|off.
    silentLogs: true,

    today: { date: null, count: 0, categories: {} },   // articles successfully posted today, broken down by category

    // Daily category mix caps, as a fraction of the day's total posts
    // (e.g. 0.10 = 10%). Category not listed here = uncapped.
    // Set via `.news setquota <CATEGORY> <percent>`, remove via `... off`.
    categoryQuotas: { SPORT: 0.10, ENTERTAINMENT: 0.35 },
    lastArticle: null,      // { title, source, link, at }

    stats: {
        totalPosted: 0,
        lastCheckAt: null,
        lastPostAt: null,
        lastError: null,
        channelTotals: { facebook: 0, whatsapp: 0, telegram: 0 },
    },
}

function todayStr() { return new Date().toISOString().slice(0, 10) }

function ensureDir() {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch {}
}

function deepMerge(base, override) {
    const out = { ...base }
    for (const k of Object.keys(override || {})) {
        if (override[k] && typeof override[k] === 'object' && !Array.isArray(override[k]) && base[k] && typeof base[k] === 'object') {
            out[k] = deepMerge(base[k], override[k])
        } else {
            out[k] = override[k]
        }
    }
    return out
}

function load() {
    try {
        const raw = fs.readFileSync(FILE, 'utf8')
        const parsed = JSON.parse(raw)
        return deepMerge(DEFAULT_STATE, parsed)
    } catch {
        return JSON.parse(JSON.stringify(DEFAULT_STATE))
    }
}

function save(state) {
    ensureDir()
    try { fs.writeFileSync(FILE, JSON.stringify(state, null, 2)) } catch (e) {
        console.error('[newsStore] Failed to save state:', e.message)
    }
}

// ── Enabled toggle (master on/off for the whole monitor) ───────────────────

function isEnabled() { return Boolean(load().enabled) }

function setEnabled(value) {
    const state = load()
    state.enabled = Boolean(value)
    save(state)
    return state.enabled
}

// ── Check interval override ─────────────────────────────────────────────────

function getIntervalMs() {
    const v = load().checkIntervalMs
    return Number.isFinite(v) && v > 0 ? v : null
}

function setIntervalMs(ms) {
    const state = load()
    state.checkIntervalMs = Number.isFinite(ms) ? ms : null
    save(state)
    return state.checkIntervalMs
}

// ── Per-channel owner toggles ───────────────────────────────────────────────

function isChannelEnabled(channel) {
    const state = load()
    return Boolean(state.channels?.[channel]?.enabled)
}

function setChannelEnabled(channel, value) {
    const state = load()
    if (!state.channels[channel]) state.channels[channel] = {}
    state.channels[channel].enabled = Boolean(value)
    save(state)
    return state.channels[channel].enabled
}

function getChannels() {
    return load().channels
}

// ── Consecutive-failure auto-disable (in-memory, not persisted) ────────────
// A single bad Graph API error code (handled in lib/facebook.js) is easy to
// call "permanent". WhatsApp Channel and Telegram failures don't come with
// that kind of structured error code, so instead: track failures IN A ROW
// per channel, and once one channel has failed this many times back to back
// with no success in between, treat that as proof it's broken and turn it
// off — rather than letting it retry forever. This is what was silently
// starving new-article posting: a channel stuck failing every single
// article, forever requeued, forever retried, taking longer and longer each
// cycle until barely any time was left to even look for new articles.
const CONSECUTIVE_FAIL_THRESHOLD = 5
const consecutiveFailures = { facebook: 0, whatsapp: 0, telegram: 0 }

function recordChannelResult(channel, success) {
    if (success) { consecutiveFailures[channel] = 0; return { justDisabled: false } }
    consecutiveFailures[channel] = (consecutiveFailures[channel] || 0) + 1
    if (consecutiveFailures[channel] >= CONSECUTIVE_FAIL_THRESHOLD) {
        consecutiveFailures[channel] = 0
        if (isChannelEnabled(channel)) {
            setChannelEnabled(channel, false)
            return { justDisabled: true }
        }
    }
    return { justDisabled: false }
}

// ── Seen article IDs (dedup) — articles are marked seen the moment they're
//    processed, so the SAME article is never re-detected/re-posted even if
//    every channel attempt fails (failed sends go to the retry queue
//    instead of being re-fetched from the feed). ────────────────────────────

function hasSeen(id) {
    if (!id) return false
    return load().seenIds.includes(id)
}

function markSeen(id) {
    if (!id) return
    const state = load()
    if (state.seenIds.includes(id)) return
    state.seenIds.push(id)
    if (state.seenIds.length > MAX_SEEN_IDS) {
        state.seenIds = state.seenIds.slice(-MAX_SEEN_IDS)
    }
    save(state)
}

function filterNewIds(ids) {
    const state = load()
    const seenSet = new Set(state.seenIds)
    return ids.filter(id => id && !seenSet.has(id))
}

function markManySeen(ids) {
    if (!ids || !ids.length) return
    const state = load()
    const seenSet = new Set(state.seenIds)
    for (const id of ids) { if (id) seenSet.add(id) }
    state.seenIds = [...seenSet].slice(-MAX_SEEN_IDS)
    save(state)
}

// ── Retry queue (automatic retries for failed posts) ───────────────────────

function addRetry(item) {
    const state = load()
    const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        attempts: 0,
        createdAt: new Date().toISOString(),
        nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
        lastError: null,
        ...item,
    }
    state.retryQueue.push(entry)
    if (state.retryQueue.length > MAX_RETRY_ITEMS) {
        state.retryQueue = state.retryQueue.slice(-MAX_RETRY_ITEMS)
    }
    save(state)
    return entry
}

function getDueRetries() {
    const now = Date.now()
    return load().retryQueue.filter(r => new Date(r.nextAttemptAt).getTime() <= now)
}

function getRetryQueue() {
    return load().retryQueue
}

function updateRetry(id, patch) {
    const state = load()
    const idx = state.retryQueue.findIndex(r => r.id === id)
    if (idx === -1) return null
    state.retryQueue[idx] = { ...state.retryQueue[idx], ...patch }
    save(state)
    return state.retryQueue[idx]
}

function removeRetry(id) {
    const state = load()
    state.retryQueue = state.retryQueue.filter(r => r.id !== id)
    save(state)
}

// ── Rolling activity log ────────────────────────────────────────────────────

function addLog(level, message) {
    const state = load()
    state.logs.push({ at: new Date().toISOString(), level, message: String(message).slice(0, 500) })
    if (state.logs.length > MAX_LOG_LINES) {
        state.logs = state.logs.slice(-MAX_LOG_LINES)
    }
    save(state)
    // Always recorded above (readable via .news logs) — only the console
    // mirror is skipped in silent mode, since that's the part that piles up
    // on a hosting panel's live console view over hours of continuous running.
    if (state.silentLogs) return
    const tag = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : level === 'success' ? '✅' : 'ℹ️'
    console.log(`[newsMonitor] ${tag} ${message}`)
}

function isSilent() { return Boolean(load().silentLogs) }
function setSilent(value) {
    const state = load()
    state.silentLogs = Boolean(value)
    save(state)
    return state.silentLogs
}

function getLogs(limit = 20) {
    const logs = load().logs
    return logs.slice(-limit).reverse()   // most recent first
}

// ── Today's post counter (resets automatically on day change) ──────────────

function bumpToday(category) {
    const state = load()
    const today = todayStr()
    if (state.today.date !== today) {
        state.today = { date: today, count: 0, categories: {} }
    }
    state.today.count++
    if (category) {
        if (!state.today.categories) state.today.categories = {}
        const key = String(category).toUpperCase()
        state.today.categories[key] = (state.today.categories[key] || 0) + 1
    }
    save(state)
    return state.today.count
}

function getToday() {
    const state = load()
    const today = todayStr()
    if (state.today.date !== today) return 0
    return state.today.count
}

function getTodayCategoryBreakdown() {
    const state = load()
    const today = todayStr()
    if (state.today.date !== today) return {}
    return state.today.categories || {}
}

// ── Daily category quotas (e.g. cap SPORT/ENTERTAINMENT at X% of the day) ──

function getCategoryQuotas() {
    return load().categoryQuotas || {}
}

function setCategoryQuota(category, ratio) {
    const state = load()
    if (!state.categoryQuotas) state.categoryQuotas = {}
    const key = String(category).toUpperCase()
    if (!ratio) delete state.categoryQuotas[key]
    else state.categoryQuotas[key] = ratio
    save(state)
    return state.categoryQuotas
}

// ── Last article posted ─────────────────────────────────────────────────────

function setLastArticle(article) {
    const state = load()
    state.lastArticle = { ...article, at: new Date().toISOString() }
    save(state)
}

function getLastArticle() {
    return load().lastArticle
}

// ── Stats ────────────────────────────────────────────────────────────────────

function recordCheck() {
    const state = load()
    state.stats.lastCheckAt = new Date().toISOString()
    save(state)
}

function recordPost(channel, count = 1) {
    const state = load()
    state.stats.totalPosted = (state.stats.totalPosted || 0) + count
    state.stats.lastPostAt = new Date().toISOString()
    if (channel) {
        if (!state.stats.channelTotals) state.stats.channelTotals = { facebook: 0, whatsapp: 0, telegram: 0 }
        state.stats.channelTotals[channel] = (state.stats.channelTotals[channel] || 0) + count
    }
    save(state)
}

function recordError(message) {
    const state = load()
    state.stats.lastError = { message: String(message).slice(0, 300), at: new Date().toISOString() }
    save(state)
}

function clearLastError() {
    const state = load()
    state.stats.lastError = null
    save(state)
}

function getStats() {
    return load().stats
}

module.exports = {
    isEnabled, setEnabled,
    getIntervalMs, setIntervalMs,
    isChannelEnabled, setChannelEnabled, getChannels, recordChannelResult,
    hasSeen, markSeen, filterNewIds, markManySeen,
    addRetry, getDueRetries, getRetryQueue, updateRetry, removeRetry,
    addLog, getLogs, isSilent, setSilent,
    bumpToday, getToday, getTodayCategoryBreakdown,
    getCategoryQuotas, setCategoryQuota,
    setLastArticle, getLastArticle,
    recordCheck, recordPost, recordError, clearLastError, getStats,
    MAX_RETRY_ATTEMPTS,
}
