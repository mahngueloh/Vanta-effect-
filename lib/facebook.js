'use strict'

const axios    = require('axios')
const FormData = require('form-data')
const settings = require('./settings')

// ── Runtime credentials (hot-swappable, no restart needed) ─────────────────
// On startup: settings.json wins over .env so .setfb persists across restarts.
const _rt = {
    pageId:      settings.get('fb_page_id',      '') || process.env.FACEBOOK_PAGE_ID              || '',
    token:       settings.get('fb_access_token', '') || process.env.FACEBOOK_PAGE_ACCESS_TOKEN    || '',
    autoPost:    settings.get('fb_auto_post',    null) !== null
                     ? settings.get('fb_auto_post', false)
                     : process.env.FACEBOOK_AUTO_POST === 'true',
    apiVersion:  process.env.FACEBOOK_API_VERSION || 'v19.0',
    tokenExpiresAt: settings.get('fb_token_expires_at', null),   // epoch ms, or null = doesn't expire / unknown
}

const MAX_RETRIES        = 3
const RETRY_DELAY_MS     = 2000
const REQUEST_TIMEOUT_MS = 20000

function graphBase() { return `https://graph.facebook.com/${_rt.apiVersion}` }

// ── Token-safety helpers ────────────────────────────────────────────────────
function safeStringify(obj) {
    try { return JSON.stringify(obj) } catch { return String(obj) }
}

function redact(input) {
    let str = typeof input === 'string' ? input : safeStringify(input)
    if (_rt.token) str = str.split(_rt.token).join('[REDACTED_TOKEN]')
    str = str.replace(/access_token=[^&\s"]+/g, 'access_token=[REDACTED_TOKEN]')
    return str
}

function log(level, ...parts) {
    const msg   = parts.map(p => (typeof p === 'string' ? p : safeStringify(p))).join(' ')
    const clean = redact(msg)
    const stamp = new Date().toISOString()
    if (level === 'error') console.error(`[facebook] ${stamp} ❌`, clean)
    else if (level === 'warn') console.warn(`[facebook] ${stamp} ⚠️`, clean)
    else console.log(`[facebook] ${stamp}`, clean)
}

// ── Config status helpers ───────────────────────────────────────────────────
function isFacebookConfigured() {
    return Boolean(_rt.pageId && _rt.token)
}

function isAutoPostEnabled() {
    return Boolean(_rt.autoPost)
}

function getFacebookStatus() {
    return {
        configured:  isFacebookConfigured(),
        autoPost:    _rt.autoPost,
        pageId:      _rt.pageId
                         ? `${_rt.pageId.slice(0, 4)}${'*'.repeat(Math.max(_rt.pageId.length - 4, 0))}`
                         : '(not set)',
        apiVersion:  _rt.apiVersion,
        tokenExpiresAt: _rt.tokenExpiresAt,
    }
}

// ── Hot-swap credentials (called by .setfb command) ────────────────────────
function setCredentials(pageId, token, enableAutoPost = true) {
    _rt.pageId   = pageId
    _rt.token    = token
    _rt.autoPost = enableAutoPost
    // Persist so they survive a bot restart
    settings.set('fb_page_id',      pageId)
    settings.set('fb_access_token', token)
    settings.set('fb_auto_post',    enableAutoPost)
    log('info', `✅ Credentials hot-swapped — page ${pageId.slice(0,4)}*** auto-post=${enableAutoPost}`)
}

// ── Set page ID / token independently (.fbpageid / .fbaccesstoken) ──────────
function setPageId(pageId) {
    _rt.pageId = pageId
    settings.set('fb_page_id', pageId)
    log('info', `Page ID saved — ${pageId.slice(0, 4)}***`)
}

function setToken(token) {
    _rt.token = token
    settings.set('fb_access_token', token)
    setTokenExpiry(null)   // fresh token — expiry unknown until the next validateToken() check
    log('info', 'Access token saved')
}

function setAutoPost(on) {
    _rt.autoPost = Boolean(on)
    settings.set('fb_auto_post', Boolean(on))
}

// Raw values, for validating the pair — never send these back to a chat.
function getCurrentCredentials() {
    return { pageId: _rt.pageId, token: _rt.token }
}

function setTokenExpiry(epochMs) {
    _rt.tokenExpiresAt = epochMs || null
    settings.set('fb_token_expires_at', _rt.tokenExpiresAt)
}
function getTokenExpiry() { return _rt.tokenExpiresAt }

// ── Validate token + page against Graph API ─────────────────────────────────
async function validateToken(pageId, token) {
    const base = `https://graph.facebook.com/${_rt.apiVersion}`
    try {
        // 1. Check the token is valid at all
        const meRes = await axios.get(`${base}/me`, {
            params: { access_token: token, fields: 'id,name' },
            timeout: 12000,
        })
        const meId   = String(meRes.data?.id   || '')
        const meName = String(meRes.data?.name || 'unknown')

        // 2. Check we can read the target page
        const pageRes = await axios.get(`${base}/${pageId}`, {
            params: { access_token: token, fields: 'id,name,fan_count' },
            timeout: 12000,
        })
        const pageName = String(pageRes.data?.name || pageId)
        const fans     = pageRes.data?.fan_count != null ? Number(pageRes.data.fan_count).toLocaleString() : '?'

        // 3. How long does this token actually last? A token copied straight out
        // of the Graph API Explorer without first extending it is SHORT-LIVED —
        // it works fine for the first post or two, then silently stops working
        // about an hour later with zero warning. debug_token (self-inspection —
        // works with just the token itself, no app secret needed) tells us the
        // real expiry so we can warn about this up front instead of the owner
        // discovering it the hard way.
        let expiresAt = null, shortLived = false
        try {
            const dbg = await axios.get(`${base}/debug_token`, { params: { input_token: token, access_token: token }, timeout: 12000 })
            const data = dbg.data?.data
            if (data?.expires_at) { expiresAt = data.expires_at * 1000; shortLived = true }
            // expires_at === 0 (or absent) means it does not expire.
        } catch { /* best-effort — don't fail validation just because this extra check didn't work */ }

        return { ok: true, meName, meId, pageName, fans, expiresAt, shortLived }
    } catch (err) {
        const fbErr   = err.response?.data?.error
        const code    = fbErr?.code
        const subcode = fbErr?.error_subcode
        const message = fbErr?.message || err.message

        // Friendly error classification
        let reason = message
        if (code === 190)                    reason = 'Token is invalid or has expired (code 190)'
        else if (code === 200 || code === 10) reason = 'Token lacks the required page permissions'
        else if (code === 803 || code === 100) reason = `Page ID "${pageId}" not found or token can't access it`
        else if (err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT') reason = 'Network error — check internet connection'

        return { ok: false, error: reason, code, subcode }
    }
}

// ── Core request with retry ─────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function postWithRetry(endpoint, params, fileBuffer = null) {
    const url = `${graphBase()}/${endpoint}`
    let lastError = null

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            let res
            if (fileBuffer) {
                const form = new FormData()
                for (const [k, v] of Object.entries(params)) form.append(k, v)
                form.append('access_token', _rt.token)
                form.append('source', fileBuffer, { filename: 'photo.jpg', contentType: 'image/jpeg' })
                res = await axios.post(url, form, {
                    headers: form.getHeaders(),
                    timeout: REQUEST_TIMEOUT_MS,
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity,
                })
            } else {
                res = await axios.post(url, null, {
                    params: { ...params, access_token: _rt.token },
                    timeout: REQUEST_TIMEOUT_MS,
                })
            }
            log('info', `Post succeeded on attempt ${attempt}/${MAX_RETRIES} → id=${res.data?.id || res.data?.post_id || 'unknown'}`)
            return { success: true, id: res.data?.id || res.data?.post_id || null, attempts: attempt, raw: res.data }
        } catch (err) {
            const fbError = err.response?.data?.error
            const status   = err.response?.status
            const code     = fbError?.code
            const subcode  = fbError?.error_subcode
            const message  = fbError?.message || err.message

            lastError = { status, code, subcode, message }
            log('warn', `Attempt ${attempt}/${MAX_RETRIES} failed → status=${status} code=${code} msg=${message}`)

            const isPermanent = code === 190 || code === 10 || code === 200
                || status === 401 || status === 403

            if (isPermanent) {
                log('error', 'Permanent Facebook API error — not retrying.', { code, message })
                lastError.permanent = true
                break
            }

            if (attempt < MAX_RETRIES) {
                const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1)
                log('info', `Retrying in ${delay}ms...`)
                await sleep(delay)
            }
        }
    }

    log('error', `All ${MAX_RETRIES} attempts failed for ${endpoint}`, lastError)
    return { success: false, error: lastError?.message || 'Unknown error', errorDetail: lastError, attempts: MAX_RETRIES }
}

// ── Public API ───────────────────────────────────────────────────────────────
async function postToFacebook(message, image = null) {
    if (!message || !String(message).trim()) {
        return { success: false, error: 'message is required and cannot be empty', skipped: false }
    }

    if (!_rt.autoPost) {
        log('info', 'auto-post is disabled — skipping post.')
        return { success: false, skipped: true, error: 'Facebook auto-post is disabled' }
    }

    if (!isFacebookConfigured()) {
        log('error', 'Missing page ID or access token — cannot post.')
        return { success: false, error: 'Facebook is not configured. Use .fbpageid <id> and .fbaccesstoken <token> to set credentials.' }
    }

    const isBuffer = Buffer.isBuffer(image)
    const kind = isBuffer ? 'photo post (buffer)' : image ? 'photo post (url)' : 'text post'
    log('info', `Posting to Page ${_rt.pageId} — ${kind} — "${String(message).slice(0, 60)}${message.length > 60 ? '...' : ''}"`)

    let result
    if (isBuffer) {
        result = await postWithRetry(`${_rt.pageId}/photos`, { caption: message }, image)
    } else if (image) {
        result = await postWithRetry(`${_rt.pageId}/photos`, { caption: message, url: image })
    } else {
        result = await postWithRetry(`${_rt.pageId}/feed`, { message })
    }

    if (result.success) {
        log('info', `✅ Published successfully — post id: ${result.id}`)
    } else {
        log('error', `❌ Failed to publish after ${result.attempts || MAX_RETRIES} attempt(s): ${result.error}`)

        // A PERMANENT failure (expired/invalid token, revoked permission) will
        // fail the exact same way for every single article forever — without
        // this, every new article the news monitor finds keeps retrying and
        // re-logging the identical error indefinitely. On a memory-constrained
        // host, hours of that log/retry volume is a real, observed cause of
        // the whole bot eventually crashing. So: turn auto-post off the moment
        // this happens, once, and let the caller tell the owner why.
        if (result.errorDetail?.permanent && _rt.autoPost) {
            setAutoPost(false)
            result.authDisabled = true
            log('error', 'Auto-post turned OFF — this error will not fix itself on retry. Reconnect with .fbpageid / .fbaccesstoken.')
        }
    }

    return result
}

module.exports = {
    postToFacebook,
    isFacebookConfigured,
    isAutoPostEnabled,
    getFacebookStatus,
    setCredentials,
    setPageId,
    setToken,
    setAutoPost,
    getCurrentCredentials,
    setTokenExpiry,
    getTokenExpiry,
    validateToken,
}
