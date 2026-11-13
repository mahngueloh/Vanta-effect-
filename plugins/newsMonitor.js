'use strict'

const fs    = require('fs')
const path  = require('path')
const axios = require('axios')
const config = require('../config')
const fmt    = require('../lib/format')
const store  = require('../lib/newsStore')
const { postToFacebook, isFacebookConfigured, isAutoPostEnabled, getFacebookStatus, getTokenExpiry } = require('../lib/facebook')
const { publishToTelegram, isTelegramConfigured, getTelegramStatus } = require('../lib/telegram')
const { publishToWhatsAppChannel, isWhatsAppChannelConfigured, getWhatsAppChannelStatus } = require('../lib/whatsappChannel')
const { brandArticleImage } = require('../lib/imageBranding')
const { cleanJid } = require('../lib/utils')

const SOURCES_FILE = path.join(__dirname, 'newsSources.json')

const MIN_INTERVAL_MS = 30_000
const MAX_INTERVAL_MS = 300_000                 // widened to 5 min ceiling for owner flexibility
const DEFAULT_INTERVAL_MS = 45_000
const MAX_NEW_ITEMS_PER_SOURCE = 3   // cap per cycle so one feed can't flood every channel
const FETCH_TIMEOUT_MS = 15_000
const AI_TIMEOUT_MS = 20_000
const RETRY_BASE_BACKOFF_MS = 60_000            // 1 min, doubles per attempt

let intervalHandle = null
let isChecking = false
let currentSock = null   // kept so `.news interval` can hot-restart the scheduler

// One-shot owner alerts (e.g. "Facebook just disconnected itself") — sent at
// most once per `key` per process lifetime, so a condition that keeps being
// true on every future cycle doesn't turn into the exact spam this exists to
// prevent.
const notifiedOnce = new Set()
async function notifyOwnerOnce(sock, key, text) {
    if (notifiedOnce.has(key) || !sock) return
    notifiedOnce.add(key)
    try {
        const selfJid = cleanJid(sock.user?.id || '') || `${config.ownerNumber}@s.whatsapp.net`
        await sock.sendMessage(selfJid, { text })
    } catch (e) { store.addLog('error', `Owner alert failed to send: ${e.message}`) }
}

const CHANNEL_LABEL = { facebook: 'Facebook', whatsapp: 'WhatsApp Channel', telegram: 'Telegram' }

// Shared by both the main cycle and the retry queue. Feeds every post result
// into the consecutive-failure tracker; if a channel just tripped it (this
// one, or Facebook's own explicit authDisabled), turn it off and tell the
// owner exactly once — and report back whether THIS result should still be
// queued for retry (a channel that just got disabled should not be).
async function trackChannelResult(sock, channel, result) {
    if (result?.skipped) return { requeue: false }
    if (result?.success) { store.recordChannelResult(channel, true); return { requeue: false } }

    const { justDisabled } = result.authDisabled
        ? { justDisabled: true }   // lib/facebook.js already disabled it itself
        : store.recordChannelResult(channel, false)

    if (justDisabled) {
        store.addLog('error', `${CHANNEL_LABEL[channel]} auto-post disabled itself after repeated failures: ${result.error}`)
        await notifyOwnerOnce(sock, `${channel}-auth`, fmt.box(`⚠️ ${CHANNEL_LABEL[channel].toUpperCase()} DISCONNECTED`, [
            `Auto-post just turned itself OFF after repeated failures — this won't fix itself on retry:`,
            `${result.error}`,
            ``,
            channel === 'facebook'
                ? `Reconnect: ${config.prefix}fbpageid <id> then ${config.prefix}fbaccesstoken <token>`
                : `Check your .env credentials for this channel, then re-enable with ${config.prefix}news enable ${channel}`,
        ]))
        return { requeue: false }
    }
    return { requeue: true }
}

// ── Sources config (hot-reloadable — edit the JSON, or use .news addsource) ─

function loadSources() {
    try {
        const raw = fs.readFileSync(SOURCES_FILE, 'utf8')
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed.sources) ? parsed.sources : []
    } catch (e) {
        console.error('[newsMonitor] Failed to load newsSources.json:', e.message)
        return []
    }
}

function saveSources(sources) {
    try {
        fs.writeFileSync(SOURCES_FILE, JSON.stringify({ sources }, null, 2))
        return true
    } catch (e) {
        console.error('[newsMonitor] Failed to save newsSources.json:', e.message)
        return false
    }
}

function slugify(str) {
    return String(str).toLowerCase().replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40)
}

// ── Minimal RSS / Atom parser (no external dependency) ─────────────────────

function decodeEntities(str = '') {
    return str
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&apos;/g, "'")
        .trim()
}

function tag(block, name) {
    const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'))
    return m ? decodeEntities(m[1]) : ''
}

function attr(block, name, attrName) {
    const m = block.match(new RegExp(`<${name}[^>]*\\s${attrName}=["']([^"']+)["']`, 'i'))
    return m ? m[1] : ''
}

function parseFeed(xml) {
    const items = []
    const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml)
    const blockRe = isAtom ? /<entry[\s\S]*?<\/entry>/gi : /<item[\s\S]*?<\/item>/gi
    const blocks = xml.match(blockRe) || []

    for (const block of blocks) {
        const title = tag(block, 'title')
        let link = tag(block, 'link')
        if (isAtom && !link) link = attr(block, 'link', 'href')
        if (!isAtom) {
            // RSS <link> is usually plain text; some feeds wrap it oddly
            const linkAttrHref = attr(block, 'link', 'href')
            if (!link && linkAttrHref) link = linkAttrHref
        }
        const guid = tag(block, 'guid') || tag(block, 'id')
        const description = tag(block, 'description') || tag(block, 'summary') || tag(block, 'content')
        const pubDate = tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated')

        // Base URL for resolving relative image paths ("/wp-content/…") —
        // WordPress-style feeds (common on Kenyan/tech sources) often emit
        // site-relative or protocol-relative src attributes that a plain
        // axios.get() can't fetch as-is.
        let baseOrigin = null
        try { baseOrigin = new URL(link).origin } catch { /* link missing/invalid — leave null */ }

        function resolveImageUrl(src) {
            if (!src) return null
            try { return new URL(src, baseOrigin || undefined).href }
            catch { return /^https?:\/\//i.test(src) ? src : null }
        }

        // ── Image resolution ────────────────────────────────────────────────
        // Many curated sources (Kenyan/tech WordPress feeds especially) don't
        // set <enclosure>/<media:content> — the image only exists as an <img>
        // tag inside <content:encoded> or <description>, and it's often not
        // the first one (avatars, share icons, ads come first), and it's
        // often lazy-loaded (real image in data-src, not src). So we collect
        // EVERY candidate and let the caller try them in order, skipping any
        // that turn out too small/low-res once downloaded.
        const candidates = []
        const enclosureUrl = resolveImageUrl(
            attr(block, 'enclosure', 'url')
            || attr(block, 'media:content', 'url')
            || attr(block, 'media:thumbnail', 'url')
        )
        if (enclosureUrl) candidates.push(enclosureUrl)

        const rawContent = tag(block, 'content:encoded') || description
        if (rawContent) {
            const imgRe = /<img\s+[^>]*>/gi
            let m
            while ((m = imgRe.exec(rawContent))) {
                const tagAttrs = m[0]
                // Real image may live in a lazy-load attribute rather than src.
                const srcMatch = tagAttrs.match(/\s(?:data-src|data-lazy-src|data-original|src)=["']([^"'\s]+)["']/i)
                if (!srcMatch) continue
                const src = srcMatch[1]
                if (/^data:/i.test(src)) continue   // inline base64 placeholder, never a real photo
                // Skip obvious non-article images: icons, avatars, tracking
                // pixels, ads, spacers, share/social buttons.
                if (/(icon|avatar|logo|sprite|pixel|spacer|blank|placeholder|gravatar|emoji|badge|share|social|1x1)/i.test(src)) continue
                // Skip images explicitly sized tiny via width/height attrs
                const wMatch = tagAttrs.match(/width=["']?(\d+)/i)
                const hMatch = tagAttrs.match(/height=["']?(\d+)/i)
                if (wMatch && parseInt(wMatch[1], 10) < 200) continue
                if (hMatch && parseInt(hMatch[1], 10) < 150) continue
                const resolved = resolveImageUrl(src)
                if (resolved && !candidates.includes(resolved)) candidates.push(resolved)
            }
        }

        // ── Stable id ──────────────────────────────────────────────────────
        // Prefer guid (usually stable). Falling back to the link, strip
        // tracking query params (utm_*, fbclid, ref, etc.) first — some
        // sources vary these per-fetch, which was making the SAME article
        // look "new" every cycle and get reposted on a loop.
        let idLink = link
        if (idLink) {
            try {
                const u = new URL(idLink)
                for (const p of [...u.searchParams.keys()]) {
                    if (/^(utm_|fbclid|gclid|ref$|ito$|cmp$|itm_)/i.test(p)) u.searchParams.delete(p)
                }
                idLink = u.origin + u.pathname + (u.search ? u.search : '')
            } catch { /* leave as-is if not a valid absolute URL */ }
        }
        const id = (guid || idLink || title || '').trim()
        if (!id || !title) continue

        items.push({
            id,
            title: title.slice(0, 300),
            link: link || '',
            description: description.replace(/<[^>]+>/g, '').slice(0, 500),
            pubDate: pubDate || '',
            image: candidates[0] || null,   // kept for backward-compat / quick truthy checks
            imageCandidates: candidates,
        })
    }
    return items
}

async function fetchFeed(url) {
    const res = await axios.get(url, {
        timeout: FETCH_TIMEOUT_MS,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MAHNGUELOH VANTA NewsBot/1.0)' },
        responseType: 'text',
        transformResponse: [data => data], // keep raw XML string
    })
    return parseFeed(res.data)
}

// ── Runtime keyword overrides (managed via .news addkeyword / .news delkeyword) ─
// These are added on top of the baked-in HIGH_KEYWORDS / MEDIUM_KEYWORDS arrays.
// They survive until the bot restarts. Use .env NEWS_MONITOR_ENABLED for permanence.

const runtimeHighKeywords   = []   // .news addkeyword high <word>
const runtimeMediumKeywords = []   // .news addkeyword <word>        (default tier)

// ── Breaking news detection ──────────────────────────────────────────────────

const BREAKING_KEYWORDS = [
    'breaking', 'just in', 'just-in', 'urgent', 'alert', 'developing',
    'breaking news', 'exclusive', 'flash:', 'update:', 'happening now',
]

function isBreakingNews(title, description) {
    const haystack = `${title} ${description}`.toLowerCase()
    return BREAKING_KEYWORDS.some(kw => haystack.includes(kw))
}

// ── Importance filter ────────────────────────────────────────────────────────

const HIGH_KEYWORDS = [
    // Politics / governance
    'president', 'prime minister', 'parliament', 'cabinet', 'minister',
    'election', 'vote', 'voted', 'protest', 'riot', 'coup', 'resign',
    'impeach', 'arrested', 'charged', 'verdict', 'sentenced', 'jailed',
    // Disaster / security
    'killed', 'dead', 'deaths', 'attack', 'explosion', 'bomb', 'shooting',
    'stabbed', 'kidnapped', 'missing', 'disaster', 'emergency', 'crisis',
    'flood', 'fire', 'crash', 'collapsed', 'war', 'military', 'troops',
    // Economy
    'budget', 'economy', 'inflation', 'fuel prices', 'tax', 'interest rate',
    'billion', 'fraud', 'corruption', 'scandal',
    // EPL / World Cup high-impact
    'champions league', 'world cup', 'cup final', 'title', 'trophy',
    'relegated', 'promotion', 'sacked', 'fired', 'transfer', 'record signing',
    'red card', 'penalty shootout', 'extra time', 'historic', 'record',
]

const MEDIUM_KEYWORDS = [
    // Kenya / Africa
    'kenya', 'nairobi', 'mombasa', 'kisumu', 'nakuru', 'ruto', 'raila',
    'africa', 'east africa', 'government', 'county',
    // General news
    'police', 'court', 'hospital', 'school', 'university', 'health',
    'disease', 'outbreak',
    // Sports general
    'goal', 'match', 'score', 'league', 'season', 'squad',
    'manager', 'coach', 'player', 'fixture', 'cup', 'win', 'defeat',
    'premier league', 'arsenal', 'chelsea', 'manchester', 'liverpool',
    'tottenham', 'city',
    // Tech / digital
    'launch', 'startup', 'funding', 'app', 'ai', 'digital', 'cyber',
    'hack', 'data breach', 'mobile money', 'mpesa', 'safaricom',
    // Entertainment / celebrity / Kenyan culture / digital creators
    'celebrity', 'celebrities', 'socialite', 'influencer', 'content creator',
    'artist', 'musician', 'singer', 'rapper', 'comedian', 'actor', 'actress',
    'gossip', 'drama', 'scandal', 'beef', 'relationship', 'wedding',
    'engaged', 'engagement', 'breakup', 'divorce', 'baby shower',
    'song', 'album', 'single', 'music video', 'mv', 'ep', 'mixtape',
    'concert', 'performance', 'tour', 'festival', 'awards', 'nominated',
    'viral', 'trending', 'tiktok', 'youtube', 'instagram', 'podcast',
    'skiza', 'genge', 'gengetone', 'bongo', 'afrobeat', 'amapiano',
]

const KENYAN_CULTURE_NAMES = [
    'sauti sol', 'bien', 'nyashinski', 'khaligraph jones', 'willy paul',
    'diamond platnumz', 'akothee', 'size 8', 'bahati', 'otile brown',
    'eric omondi', 'jalang\'o', 'mulamwah', 'obinna', 'azziad',
    'wahu', 'nameless', 'esther musila', 'risper faith', 'zari',
    'ringtone', 'ohangla', 'sailors gang', 'bensoul', 'rayvanny',
]
MEDIUM_KEYWORDS.push(...KENYAN_CULTURE_NAMES)

const CURATED_THRESHOLD = 1   // 1 medium-keyword hit from title = enough
const GENERAL_THRESHOLD = 3   // needs a high keyword or several mediums

function scoreArticle(title, description) {
    const titleLow = (title || '').toLowerCase()
    const descLow  = (description || '').toLowerCase()
    let score = 0

    const allHigh   = [...HIGH_KEYWORDS,   ...runtimeHighKeywords]
    const allMedium = [...MEDIUM_KEYWORDS, ...runtimeMediumKeywords]

    for (const kw of allHigh) {
        if (titleLow.includes(kw))     score += 6
        else if (descLow.includes(kw)) score += 3
    }
    for (const kw of allMedium) {
        if (titleLow.includes(kw))     score += 2
        else if (descLow.includes(kw)) score += 1
    }
    return score
}

function isImportantEnough(item, sourceCategorised) {
    if (isBreakingNews(item.title, item.description)) return true
    const threshold = sourceCategorised ? CURATED_THRESHOLD : GENERAL_THRESHOLD
    return scoreArticle(item.title, item.description) >= threshold
}

const QUOTA_GRACE_POSTS = 4   // don't start enforcing until a few posts are in,
                                // so the very first post(s) of the day aren't blocked

function categoryQuotaExceeded(category) {
    const quotas = store.getCategoryQuotas()
    const ratio = quotas[String(category).toUpperCase()]
    if (!ratio) return false   // no cap configured for this category

    const breakdown = store.getTodayCategoryBreakdown()
    const total = Object.values(breakdown).reduce((a, b) => a + b, 0)
    if (total < QUOTA_GRACE_POSTS) return false

    const catCount = breakdown[String(category).toUpperCase()] || 0
    // Would adding one more post of this category push its share above the target ratio?
    return (catCount + 1) / (total + 1) > ratio
}

const REWRITE_PROMPT = (title, description) =>
    `Rewrite this news headline to be punchy and clear for a social media post, ` +
    `then add a 1-2 sentence neutral summary. Respond ONLY as:\nHEADLINE: <headline>\nSUMMARY: <summary>\n\n` +
    `Original headline: ${title}\nContext: ${description || '(no extra context)'}`

function parseAIRewrite(text, fallbackTitle) {
    const hMatch = text.match(/HEADLINE:\s*(.+)/i)
    const sMatch = text.match(/SUMMARY:\s*([\s\S]+)/i)
    return {
        headline: hMatch ? hMatch[1].trim() : fallbackTitle,
        summary: sMatch ? sMatch[1].trim().split('\n')[0] : '',
    }
}

async function rewriteWithOpenAI(title, description) {
    const res = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: REWRITE_PROMPT(title, description) }],
        max_tokens: 200,
    }, {
        headers: { Authorization: `Bearer ${config.openaiApiKey}`, 'Content-Type': 'application/json' },
        timeout: AI_TIMEOUT_MS,
    })
    const text = res.data?.choices?.[0]?.message?.content
    if (!text) throw new Error('Empty OpenAI response')
    return parseAIRewrite(text, title)
}

async function rewriteWithGemini(title, description) {
    const res = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${config.geminiApiKey}`,
        { contents: [{ role: 'user', parts: [{ text: REWRITE_PROMPT(title, description) }] }], generationConfig: { maxOutputTokens: 200 } },
        { headers: { 'Content-Type': 'application/json' }, timeout: AI_TIMEOUT_MS }
    )
    const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) throw new Error('Empty Gemini response')
    return parseAIRewrite(text, title)
}

async function rewriteHeadline(title, description) {
    const attempts = []
    if (config.openaiApiKey) attempts.push(rewriteWithOpenAI)
    if (config.geminiApiKey) attempts.push(rewriteWithGemini)
    // No-key fallback used to call Pollinations' free tier — removed since
    // it now requires payment (402 on almost every call). Without a real
    // key configured, the original title/description is used as-is below.

    for (const fn of attempts) {
        try {
            return await fn(title, description)
        } catch (e) {
            console.error('[newsMonitor] AI rewrite failed, trying next tier:', e.message)
        }
    }
    return { headline: title, summary: '' }
}

// ── Channel gates — combine .env readiness with the owner's runtime toggle ──
// "configured" = credentials/master-switch present in .env (owner never
// needs to send these through chat). "toggle" = owner's `.fb/.wa/.tg on|off`
// runtime preference, persisted in data/news-state.json. Both must be true
// for auto-publishing to actually happen.

function facebookGate() {
    const configured = isFacebookConfigured() && isAutoPostEnabled()
    const toggle = store.isChannelEnabled('facebook')
    return { configured, toggle, effective: configured && toggle }
}
function whatsappGate() {
    const configured = isWhatsAppChannelConfigured()
    const toggle = store.isChannelEnabled('whatsapp')
    return { configured, toggle, effective: configured && toggle }
}
function telegramGate() {
    const configured = isTelegramConfigured()
    const toggle = store.isChannelEnabled('telegram')
    return { configured, toggle, effective: configured && toggle }
}

function statusLabel(gate, name) {
    if (!gate.configured) return `❌ not configured (${name} — see .env)`
    if (!gate.toggle) return `⏸️ configured, OFF (${config.prefix}${name.toLowerCase().includes('facebook') ? 'fb' : name.toLowerCase().includes('telegram') ? 'tg' : 'wa'} on)`
    return `✅ ON`
}

// ── Publish helpers ──────────────────────────────────────────────────────────

function buildPostText(headline, summary, category) {
    const prefix = category ? `${category.toUpperCase()}: ` : ''
    const parts  = [`📰 *${prefix}${headline}*`]
    if (summary) parts.push('', summary)
    parts.push('', `_MAHNGUELOH NEWS — FAST. ACCURATE. TRENDING._`)
    return parts.join('\n')
}

function formatPostDate(date) {
    return date.toLocaleDateString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
        timeZone: config.timezone || 'Africa/Nairobi',
    })
}

// ── Retry queue processing (automatic retries for failed posts) ────────────

async function processRetryQueue(sock) {
    const due = store.getDueRetries()
    for (const r of due) {
        const gate = r.channel === 'facebook' ? facebookGate() : r.channel === 'whatsapp' ? whatsappGate() : telegramGate()
        if (!gate.effective) {
            // Owner turned the channel off (or it's no longer configured) — drop it.
            store.addLog('warn', `Dropped queued retry for ${r.channel} — channel is now off/unconfigured ("${(r.headline || '').slice(0, 40)}")`)
            store.removeRetry(r.id)
            continue
        }

        let brandedImage = null
        if (r.imageUrl) {
            try {
                brandedImage = await brandArticleImage(r.imageUrl, r.headline, {
                    summary:     r.summary    || '',
                    category:    r.category   || '',
                    sourceName:  r.sourceName || '',
                    sourceUrl:   '',    // source URL never exposed in retries
                    dateStr:     r.dateStr    || '',
                    isBreaking:  r.isBreaking || false,
                })
            } catch { /* fall back to raw url below */ }
        }

        let result
        try {
            if (r.channel === 'facebook') {
                result = await postToFacebook(r.text, brandedImage || r.imageUrl || null)
            } else if (r.channel === 'whatsapp') {
                result = await publishToWhatsAppChannel(sock, r.text, brandedImage)
            } else {
                result = await publishToTelegram(r.text, brandedImage, r.imageUrl)
            }
        } catch (e) {
            result = { success: false, error: e.message }
        }

        if (result?.success) {
            store.addLog('success', `Retry succeeded → ${r.channel} — "${(r.headline || '').slice(0, 40)}"`)
            store.recordPost(r.channel)
            store.recordChannelResult(r.channel, true)
            store.removeRetry(r.id)
        } else {
            const { requeue } = await trackChannelResult(sock, r.channel, result)
            if (!requeue) {
                // Channel just got auto-disabled — every other queued item for it
                // is the exact same dead end, so drop them all right now instead
                // of burning through 5 backoff rounds each to find that out.
                store.addLog('warn', `Dropped queued ${r.channel} retry — channel just got disabled ("${(r.headline || '').slice(0, 40)}")`)
                store.removeRetry(r.id)
                continue
            }
            const attempts = (r.attempts || 0) + 1
            if (attempts >= store.MAX_RETRY_ATTEMPTS) {
                store.addLog('error', `Giving up on ${r.channel} post after ${attempts} attempts — "${(r.headline || '').slice(0, 40)}": ${result?.error}`)
                store.recordError(`${r.channel}: ${result?.error}`)
                store.removeRetry(r.id)
            } else {
                const backoffMs = RETRY_BASE_BACKOFF_MS * Math.pow(2, attempts)
                store.updateRetry(r.id, {
                    attempts,
                    lastError: result?.error || 'unknown error',
                    nextAttemptAt: new Date(Date.now() + backoffMs).toISOString(),
                })
                store.addLog('warn', `Retry ${attempts}/${store.MAX_RETRY_ATTEMPTS} failed for ${r.channel}: ${result?.error}`)
            }
        }
    }
}

// ── Core cycle ───────────────────────────────────────────────────────────────

async function runCycle(sock, { force = false, dryRun = false } = {}) {
    if (isChecking) return { skipped: true, reason: 'A check is already in progress' }
    if (!force && !store.isEnabled()) return { skipped: true, reason: 'News monitor is disabled (.news on to enable)' }

    isChecking = true
    const summary = { sourcesChecked: 0, newArticles: 0, posted: 0, duplicatesSkipped: 0, filteredOut: 0, noImageSkipped: 0, errors: [] }

    try {
        // Retry anything that previously failed, before looking for new articles.
        try { await processRetryQueue(sock) } catch (e) { store.addLog('error', `Retry queue processing crashed: ${e.message}`) }

        const sources = loadSources().filter(s => s.enabled)
        for (const source of sources) {
            summary.sourcesChecked++
            let items = []
            try {
                items = await fetchFeed(source.url)
            } catch (e) {
                const msg = `${source.name}: fetch failed — ${e.message}`
                summary.errors.push(msg)
                store.recordError(msg)
                store.addLog('error', msg)
                continue
            }

            const ids = items.map(i => i.id)
            const newIds = new Set(store.filterNewIds(ids))
            const rawNewItems = items.filter(i => newIds.has(i.id))
            const duplicateCount = items.length - rawNewItems.length
            if (duplicateCount > 0) {
                summary.duplicatesSkipped += duplicateCount
                store.addLog('info', `${source.name}: skipped ${duplicateCount} already-seen ${duplicateCount === 1 ? 'item' : 'items'} (duplicate)`)
            }
            const newItems = rawNewItems.slice(0, MAX_NEW_ITEMS_PER_SOURCE)

            if (!newItems.length) continue

            for (const item of newItems) {
                // ── Gate 1: Image required — no image, no post ───────────────
                if (!item.image) {
                    summary.noImageSkipped++
                    store.markSeen(item.id)   // mark seen so we never retry it
                    store.addLog('info', `Skipped (no image) — "${item.title.slice(0, 60)}" (${source.name})`)
                    continue
                }

                // ── Gate 2: Importance filter — skip low-value articles ──────
                // Curated sources (have a category) use a lenient threshold.
                // Breaking news bypasses this check entirely.
                const breaking = isBreakingNews(item.title, item.description)
                const isCurated = !!(source.category && source.category.trim())
                if (!breaking && !isImportantEnough(item, isCurated)) {
                    summary.filteredOut++
                    store.markSeen(item.id)
                    store.addLog('info', `Filtered out (low importance) — "${item.title.slice(0, 60)}" (${source.name})`)
                    continue
                }

                // ── Gate 3: Daily category mix cap ────────────────────────────
                // Breaking news always bypasses this, same as the importance filter.
                const articleCategory = (source.category || '').toUpperCase()
                if (!breaking && articleCategory && categoryQuotaExceeded(articleCategory)) {
                    summary.filteredOut++
                    store.markSeen(item.id)
                    store.addLog('info', `Skipped (${articleCategory} quota reached for today) — "${item.title.slice(0, 60)}" (${source.name})`)
                    continue
                }

                summary.newArticles++
                store.addLog('info', `News detected${breaking ? ' [BREAKING]' : ''} — "${item.title.slice(0, 60)}" (${source.name})`)

                if (dryRun) {
                    store.markSeen(item.id)
                    continue
                }

                try {
                    const { headline, summary: aiSummary } = await rewriteHeadline(item.title, item.description)

                    const category    = source.category || config.news?.branding?.defaultCategory || ''
                    const postDateStr = formatPostDate(new Date())

                    // Post text: category-prefixed, no source attribution
                    const text = buildPostText(headline, aiSummary, category)

                    const brandingOpts = {
                        summary:    aiSummary  || '',
                        category,
                        sourceName: source.name,
                        sourceUrl:  '',         // source URL never included in image
                        dateStr:    postDateStr,
                        isBreaking: breaking,
                    }

                    // Build one branded image and reuse it across every channel.
                    // Try every candidate image in order — the first one found
                    // in an article's HTML isn't always the best (or even a
                    // real photo), so we don't give up until we've tried them all.
                    const candidates = (item.imageCandidates && item.imageCandidates.length)
                        ? item.imageCandidates
                        : (item.image ? [item.image] : [])

                    let brandedImage = null
                    let usedImageUrl = null
                    for (const candidateUrl of candidates) {
                        const attemptOpts = { ...brandingOpts }
                        try {
                            brandedImage = await brandArticleImage(candidateUrl, headline, attemptOpts)
                            if (brandedImage) { usedImageUrl = candidateUrl; break }
                            store.addLog('warn', `Image candidate rejected (${attemptOpts._lastError || 'unknown reason'}) — ${candidateUrl.slice(0, 80)}`)
                        } catch (e) {
                            store.addLog('warn', `Image candidate rejected for "${headline.slice(0, 40)}": ${e.message}`)
                        }
                    }

                    // If branding failed, skip — we never post without a branded image.
                    if (!brandedImage) {
                        store.addLog('warn', `Skipped (branded image unavailable) — "${headline.slice(0, 40)}"`)
                        store.markSeen(item.id)
                        continue
                    }

                    // Shared retry payload — no source URL stored.
                    const retryBase = {
                        imageUrl:   usedImageUrl || item.image,
                        headline,
                        summary:    aiSummary  || '',
                        category,
                        sourceName: source.name,
                        sourceUrl:  '',
                        dateStr:    postDateStr,
                        isBreaking: breaking,
                    }

                    const results = {}
                    const fbGate = facebookGate()
                    const waGate = whatsappGate()
                    const tgGate = telegramGate()

                    if (fbGate.effective) {
                        // Warn well BEFORE a short-lived token dies, not only after — this
                        // is the other half of the "posts for an hour then goes silent" fix:
                        // even with the up-front warning at connect time, give a second nudge
                        // once it's actually close, in case that first message got missed.
                        const expiresAt = getTokenExpiry()
                        if (expiresAt && expiresAt - Date.now() < 20 * 60 * 1000) {
                            const mins = Math.max(0, Math.round((expiresAt - Date.now()) / 60000))
                            await notifyOwnerOnce(sock, 'facebook-expiring', fmt.box('⚠️ FACEBOOK TOKEN EXPIRING SOON', [
                                mins > 0 ? `Expires in about ${mins} min — posting will silently stop after that.` : `This token has now expired — posting will start failing.`,
                                `Get a non-expiring one: Graph API Explorer → "Extend Access Token" → re-copy the Page token → ${config.prefix}fbaccesstoken`,
                            ]))
                        }

                        store.addLog('info', `Posting to Facebook — "${headline.slice(0, 50)}"`)
                        const r = await postToFacebook(text, brandedImage)
                        results.facebook = r
                        if (r.success) {
                            store.addLog('success', `Facebook post succeeded (id=${r.id || '?'})`)
                            store.recordPost('facebook')
                        } else {
                            const { requeue } = await trackChannelResult(sock, 'facebook', r)
                            if (requeue) {
                                store.addLog('warn', `Facebook post failed: ${r.error} — queued for retry`)
                                store.addRetry({ channel: 'facebook', text, ...retryBase, lastError: r.error })
                            }
                        }
                    }

                    if (waGate.effective) {
                        store.addLog('info', `Posting to WhatsApp Channel — "${headline.slice(0, 50)}"`)
                        const r = await publishToWhatsAppChannel(sock, text, brandedImage)
                        results.whatsapp = r
                        if (r.success) {
                            store.addLog('success', `WhatsApp Channel post succeeded`)
                            store.recordPost('whatsapp')
                        } else {
                            const { requeue } = await trackChannelResult(sock, 'whatsapp', r)
                            if (requeue) {
                                store.addLog('warn', `WhatsApp Channel post failed: ${r.error} — queued for retry`)
                                store.addRetry({ channel: 'whatsapp', text, ...retryBase, lastError: r.error })
                            }
                        }
                    }

                    if (tgGate.effective) {
                        store.addLog('info', `Posting to Telegram — "${headline.slice(0, 50)}"`)
                        const r = await publishToTelegram(text, brandedImage, usedImageUrl || item.image)
                        results.telegram = r
                        if (r.success) {
                            store.addLog('success', `Telegram post succeeded`)
                            store.recordPost('telegram')
                        } else {
                            const { requeue } = await trackChannelResult(sock, 'telegram', r)
                            if (requeue) {
                                store.addLog('warn', `Telegram post failed: ${r.error} — queued for retry`)
                                store.addRetry({ channel: 'telegram', text, ...retryBase, lastError: r.error })
                            }
                        }
                    }

                    const anyPublished = Object.values(results).some(r => r?.success)
                    if (anyPublished) {
                        summary.posted++
                        store.bumpToday(category)
                        store.setLastArticle({ title: headline, source: source.name, link: item.link })
                    }

                    // Mark seen regardless of publish outcome — the article itself was
                    // successfully detected & processed; failed channel sends are handled
                    // by the retry queue, NOT by re-fetching the article again.
                    store.markSeen(item.id)
                } catch (e) {
                    const msg = `${source.name}: "${item.title.slice(0, 40)}" — ${e.message}`
                    summary.errors.push(msg)
                    store.recordError(msg)
                    store.addLog('error', msg)
                }
            }
        }

        store.recordCheck()
        return summary
    } finally {
        isChecking = false
    }
}

// ── Scheduler ────────────────────────────────────────────────────────────────

function clampInterval(ms) {
    return Math.min(Math.max(ms, MIN_INTERVAL_MS), MAX_INTERVAL_MS)
}

function resolveIntervalMs() {
    const stored = store.getIntervalMs()
    if (Number.isFinite(stored) && stored > 0) return clampInterval(stored)
    const envVal = parseInt(process.env.NEWS_CHECK_INTERVAL_MS || '', 10)
    if (Number.isFinite(envVal)) return clampInterval(envVal)
    return DEFAULT_INTERVAL_MS
}

function initNewsMonitor(sock) {
    currentSock = sock || currentSock
    if (intervalHandle) return   // already running

    const intervalMs = resolveIntervalMs()
    store.addLog('info', `Scheduler started — checking every ~${Math.round(intervalMs / 1000)}s (monitor is ${store.isEnabled() ? 'ENABLED' : 'DISABLED — .news on to activate'})`)

    intervalHandle = setInterval(() => {
        runCycle(currentSock).catch(e => store.addLog('error', `Cycle crashed: ${e.message}`))
    }, intervalMs)

    // NOT unref'd, deliberately: an unref'd timer doesn't count towards
    // keeping the process alive, so if it's ever the last active thing Node
    // sees (e.g. a brief gap between WhatsApp keepalive pings), the whole
    // process can exit quietly — no crash, no error, nothing printed, no
    // auto-restart, just gone. That matches "posts for an hour or two then
    // goes silent forever" far better than an actual crash would: an OOM
    // kill or thrown error gets logged and the host restarts the process,
    // so news would eventually resume; this wouldn't restart or log anything.
}

function stopNewsMonitor() {
    if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null }
}

function restartScheduler() {
    stopNewsMonitor()
    initNewsMonitor(currentSock)
}

// ── Custom / manual post helpers ─────────────────────────────────────────────

const ASK_PROMPT = (question) =>
    `You are a journalist. Given the question below, write a punchy news-style post.\n` +
    `Respond ONLY in this exact format:\n` +
    `HEADLINE: <clear 8-12 word headline>\n` +
    `SUMMARY: <1-2 sentence factual answer>\n` +
    `CATEGORY: <ONE word only from: TECH POLITICS SPORT HEALTH BUSINESS WORLD KENYA GENERAL>\n\n` +
    `QUESTION: ${question}`

function parseAskResponse(text, fallback) {
    const hMatch = text.match(/HEADLINE:\s*(.+)/i)
    const sMatch = text.match(/SUMMARY:\s*([\s\S]+?)(?=\nCATEGORY:|$)/i)
    const cMatch = text.match(/CATEGORY:\s*(\w+)/i)
    return {
        headline: hMatch ? hMatch[1].trim() : fallback,
        summary:  sMatch ? sMatch[1].trim().split('\n')[0] : '',
        category: cMatch ? cMatch[1].trim().toUpperCase() : 'GENERAL',
    }
}

async function askWithAI(question) {
    const prompt = ASK_PROMPT(question)
    const attempts = []
    if (config.openaiApiKey) attempts.push(async () => {
        const res = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 200,
        }, { headers: { Authorization: `Bearer ${config.openaiApiKey}`, 'Content-Type': 'application/json' }, timeout: AI_TIMEOUT_MS })
        const text = res.data?.choices?.[0]?.message?.content
        if (!text) throw new Error('Empty OpenAI response')
        return parseAskResponse(text, question)
    })
    if (config.geminiApiKey) attempts.push(async () => {
        const res = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${config.geminiApiKey}`,
            { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 200 } },
            { headers: { 'Content-Type': 'application/json' }, timeout: AI_TIMEOUT_MS }
        )
        const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text
        if (!text) throw new Error('Empty Gemini response')
        return parseAskResponse(text, question)
    })
    // No-key fallback used to call Pollinations' free tier here too — removed
    // for the same reason (payment now required). Falls through to the
    // plain-question default below if no real key is configured.
    for (const fn of attempts) {
        try { return await fn() } catch (e) { console.error('[newsMonitor] ask AI failed, trying next:', e.message) }
    }
    return { headline: question, summary: '', category: 'GENERAL' }
}

async function publishCustomPost(sock, { headline, summary, category, imageUrl, isBreaking }) {
    const postDateStr = formatPostDate(new Date())
    const text        = buildPostText(headline, summary, category)

    const brandingOpts = {
        summary,
        category,
        sourceName: '',
        sourceUrl:  '',
        dateStr:    postDateStr,
        isBreaking: !!isBreaking,
    }

    // Brand the image — falls back to dark background if no imageUrl
    const brandedImage = await brandArticleImage(imageUrl || null, headline, brandingOpts)
    if (!brandedImage) return { ok: false, reason: 'Image branding failed' }

    const fbGate = facebookGate()
    const waGate = whatsappGate()
    const tgGate = telegramGate()
    const posted  = []
    const failed  = []

    const retryBase = { imageUrl: imageUrl || null, headline, summary, category, sourceName: '', sourceUrl: '', dateStr: postDateStr, isBreaking: !!isBreaking }

    if (fbGate.effective) {
        const r = await postToFacebook(text, brandedImage)
        if (r.success) { posted.push('Facebook'); store.recordPost('facebook') }
        else if (!r.skipped) { failed.push('Facebook'); store.addRetry({ channel: 'facebook', text, ...retryBase, lastError: r.error }) }
    }
    if (waGate.effective) {
        const r = await publishToWhatsAppChannel(sock, text, brandedImage)
        if (r.success) { posted.push('WhatsApp'); store.recordPost('whatsapp') }
        else if (!r.skipped) { failed.push('WhatsApp'); store.addRetry({ channel: 'whatsapp', text, ...retryBase, lastError: r.error }) }
    }
    if (tgGate.effective) {
        const r = await publishToTelegram(text, brandedImage, imageUrl || null)
        if (r.success) { posted.push('Telegram'); store.recordPost('telegram') }
        else if (!r.skipped) { failed.push('Telegram'); store.addRetry({ channel: 'telegram', text, ...retryBase, lastError: r.error }) }
    }

    if (posted.length) { store.bumpToday(category); store.setLastArticle({ title: headline, source: 'manual', link: '' }) }
    return { ok: true, brandedImage, posted, failed }
}

// ── Dashboard ────────────────────────────────────────────────────────────────

function buildDashboard() {
    const stats = store.getStats()
    const sources = loadSources()
    const enabledSources = sources.filter(s => s.enabled)
    const fbGate = facebookGate()
    const waGate = whatsappGate()
    const tgGate = telegramGate()
    const lastArticle = store.getLastArticle()
    const retryCount = store.getRetryQueue().length

    return fmt.box('📊 NEWS MONITOR — DASHBOARD', [
        `${store.isEnabled() ? '🟢 *STATUS: ON*' : '🔴 *STATUS: OFF*'}`,
        fmt.divider('Channels'),
        `📘 Facebook: ${statusLabel(fbGate, 'Facebook')}`,
        `💬 WhatsApp Channel: ${statusLabel(waGate, 'WhatsApp')}`,
        `✈️ Telegram: ${statusLabel(tgGate, 'Telegram')}`,
        fmt.divider('Sources'),
        `📡 Enabled RSS sources: ${enabledSources.length}/${sources.length}`,
        ...enabledSources.slice(0, 8).map(s => `   • ${s.name}`),
        enabledSources.length > 8 ? `   _+${enabledSources.length - 8} more — .news listsources_` : null,
        fmt.divider('Filters'),
        `🔍 Importance filter: ON (breaking news bypasses)`,
        `🖼️ Image required: ON (no-image articles skipped)`,
        fmt.divider('Activity'),
        `⏱ Check interval: ~${Math.round(resolveIntervalMs() / 1000)}s`,
        `📨 Articles posted today: ${store.getToday()}`,
        `📰 Last article: ${lastArticle ? `"${lastArticle.title.slice(0, 50)}" (${lastArticle.source})` : 'none yet'}`,
        `🕐 Last scan: ${stats.lastCheckAt || 'never'}`,
        retryCount ? `🔁 Pending retries: ${retryCount}` : null,
        `⚠️ Last error: ${stats.lastError ? `${stats.lastError.message} _(${stats.lastError.at})_` : 'none'}`,
    ].filter(Boolean))
}

// ── Chat command handler ────────────────────────────────────────────────────
// `.news on|off|status|stats|logs|addsource|removesource|listsources|interval|test|preview`
// Every subcommand under `.news` is owner-only.

async function handleNewsCmd(sock, from, args, msg, owner) {
    const sub = (args[0] || '').toLowerCase()

    if (!owner) {
        return sock.sendMessage(from, { text: fmt.permOwner() }, { quoted: msg })
    }

    switch (sub) {
        case 'on': {
            store.setEnabled(true)
            restartScheduler()
            return sock.sendMessage(from, {
                text: fmt.box('NEWS MONITOR', [
                    '🟢 Auto-publishing *ENABLED*',
                    `_Checking sources every ~${Math.round(resolveIntervalMs() / 1000)}s_`,
                    `_Importance filter: ON — only significant news posts_`,
                    `_Breaking news: bypasses filter, posts immediately_`,
                ])
            }, { quoted: msg })
        }

        case 'off': {
            store.setEnabled(false)
            return sock.sendMessage(from, {
                text: fmt.box('NEWS MONITOR', ['🔴 Auto-publishing *DISABLED*'])
            }, { quoted: msg })
        }

        case 'status': {
            return sock.sendMessage(from, { text: buildDashboard() }, { quoted: msg })
        }

        case 'stats': {
            const stats = store.getStats()
            const ct = stats.channelTotals || {}
            return sock.sendMessage(from, {
                text: fmt.box('NEWS MONITOR — STATS', [
                    `📨 Total posted (all time): ${stats.totalPosted || 0}`,
                    `📅 Posted today: ${store.getToday()}`,
                    fmt.divider('By channel'),
                    `📘 Facebook: ${ct.facebook || 0}`,
                    `💬 WhatsApp: ${ct.whatsapp || 0}`,
                    `✈️ Telegram: ${ct.telegram || 0}`,
                    fmt.divider(),
                    `🕐 Last scan: ${stats.lastCheckAt || 'never'}`,
                    `📤 Last post: ${stats.lastPostAt || 'never'}`,
                    `🔁 Pending retries: ${store.getRetryQueue().length}`,
                    stats.lastError ? `⚠️ Last error: ${stats.lastError.message}` : '✅ No errors recorded',
                ])
            }, { quoted: msg })
        }

        case 'logs': {
            const n = parseInt(args[1], 10)
            const limit = Number.isFinite(n) && n > 0 ? Math.min(n, 40) : 15
            const logs = store.getLogs(limit)
            if (!logs.length) {
                return sock.sendMessage(from, { text: fmt.box('NEWS LOGS', ['No activity logged yet.']) }, { quoted: msg })
            }
            const icon = { info: 'ℹ️', warn: '⚠️', error: '❌', success: '✅' }
            const lines = logs.map(l => `${icon[l.level] || 'ℹ️'} _${l.at.slice(11, 19)}_ ${l.message}`)
            return sock.sendMessage(from, {
                text: fmt.box(`NEWS LOGS (last ${logs.length})`, lines)
            }, { quoted: msg })
        }

        case 'silent': {
            const a = (args[1] || '').toLowerCase()
            if (!a) {
                return sock.sendMessage(from, {
                    text: fmt.box('NEWS SILENT LOGGING', [
                        `${store.isSilent() ? '🟢 ON' : '🔴 OFF'}`,
                        `Usage: *${config.prefix}news silent on|off*`,
                        `_On (default): every check/post still gets recorded — see it with ${config.prefix}news logs — but stops also printing to the console, which is what fills up a small host's memory over hours of continuous running._`,
                    ])
                }, { quoted: msg })
            }
            if (a !== 'on' && a !== 'off') return sock.sendMessage(from, { text: fmt.usage('news silent', 'on|off') }, { quoted: msg })
            store.setSilent(a === 'on')
            return sock.sendMessage(from, { text: fmt.box('NEWS SILENT LOGGING', [`${a === 'on' ? '🟢 ON' : '🔴 OFF'} — .news logs still shows everything either way.`]) }, { quoted: msg })
        }

        case 'listsources':
        case 'sources': {
            const sources = loadSources()
            if (!sources.length) {
                return sock.sendMessage(from, { text: fmt.box('NEWS SOURCES', ['No sources configured.']) }, { quoted: msg })
            }
            const lines = sources.map(s => `${s.enabled ? '🟢' : '⚪'} *${s.name}* [${s.category || '—'}] — \`${s.id}\``)
            return sock.sendMessage(from, {
                text: fmt.box('NEWS SOURCES', [
                    ...lines,
                    '',
                    `_Add: ${config.prefix}news addsource <RSS_URL> [name]_`,
                    `_Remove: ${config.prefix}news removesource <id>_`,
                ])
            }, { quoted: msg })
        }

        case 'addsource': {
            const url = args[1]
            if (!url || !/^https?:\/\//.test(url)) {
                return sock.sendMessage(from, { text: fmt.err('Provide a valid RSS URL: .news addsource <URL> [name]') }, { quoted: msg })
            }
            const name = args.slice(2).join(' ') || slugify(url)
            const sources = loadSources()
            const id = slugify(url)
            if (sources.some(s => s.id === id || s.url === url)) {
                return sock.sendMessage(from, { text: fmt.warn(`Source already exists: ${id}`) }, { quoted: msg })
            }
            sources.push({ id, name, type: 'rss', url, category: '', domain: '', enabled: true })
            saveSources(sources)
            return sock.sendMessage(from, {
                text: fmt.box('SOURCE ADDED', [`✅ *${name}*`, `ID: \`${id}\``, `URL: ${url}`])
            }, { quoted: msg })
        }

        case 'removesource': {
            const target = args[1]
            if (!target) {
                return sock.sendMessage(from, { text: fmt.err('Provide a source ID: .news removesource <id>') }, { quoted: msg })
            }
            const sources = loadSources()
            const idx = sources.findIndex(s => s.id === target || s.name.toLowerCase() === target.toLowerCase())
            if (idx === -1) {
                return sock.sendMessage(from, { text: fmt.warn(`Source not found: ${target}`) }, { quoted: msg })
            }
            const removed = sources.splice(idx, 1)[0]
            saveSources(sources)
            return sock.sendMessage(from, {
                text: fmt.box('SOURCE REMOVED', [`🗑️ *${removed.name}* (${removed.id})`])
            }, { quoted: msg })
        }

        case 'interval': {
            const secs = parseInt(args[1], 10)
            if (!Number.isFinite(secs) || secs < 30) {
                return sock.sendMessage(from, { text: fmt.err('Provide seconds ≥ 30: .news interval <seconds>') }, { quoted: msg })
            }
            const ms = clampInterval(secs * 1000)
            store.setIntervalMs(ms)
            restartScheduler()
            return sock.sendMessage(from, {
                text: fmt.box('INTERVAL UPDATED', [`⏱ New check interval: ~${Math.round(ms / 1000)}s`])
            }, { quoted: msg })
        }

        case 'setquota': {
            const cat = (args[1] || '').toUpperCase()
            const raw = (args[2] || '').toLowerCase()
            if (!cat || !raw) {
                return sock.sendMessage(from, {
                    text: fmt.err('Usage: .news setquota <CATEGORY> <percent|off>\ne.g. .news setquota ENTERTAINMENT 20\n     .news setquota SPORT off')
                }, { quoted: msg })
            }
            if (raw === 'off' || raw === '0') {
                store.setCategoryQuota(cat, null)
                return sock.sendMessage(from, {
                    text: fmt.box('QUOTA REMOVED', [`*${cat}* is now uncapped.`])
                }, { quoted: msg })
            }
            const pct = parseFloat(raw.replace('%', ''))
            if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
                return sock.sendMessage(from, { text: fmt.err('Percent must be between 1 and 100.') }, { quoted: msg })
            }
            store.setCategoryQuota(cat, pct / 100)
            return sock.sendMessage(from, {
                text: fmt.box('QUOTA UPDATED', [
                    `*${cat}* capped at ~${pct}% of the day's posts.`,
                    ``,
                    `_Breaking news in this category still always posts._`,
                    `_Takes effect once ${4} posts have gone out today._`,
                ])
            }, { quoted: msg })
        }

        case 'quotas': {
            const quotas = store.getCategoryQuotas()
            const breakdown = store.getTodayCategoryBreakdown()
            const total = Object.values(breakdown).reduce((a, b) => a + b, 0) || 0
            const keys = new Set([...Object.keys(quotas), ...Object.keys(breakdown)])
            const lines = keys.size
                ? [...keys].sort().map(cat => {
                    const capPct  = quotas[cat] ? `${Math.round(quotas[cat] * 100)}% cap` : 'uncapped'
                    const count   = breakdown[cat] || 0
                    const sharePct = total ? Math.round((count / total) * 100) : 0
                    return `*${cat}*: ${count} posted today (${sharePct}%) — ${capPct}`
                })
                : ['No posts yet today.']
            return sock.sendMessage(from, {
                text: fmt.box('DAILY CATEGORY MIX', [
                    ...lines,
                    ``,
                    `_Change with: .news setquota <CATEGORY> <percent|off>_`,
                ])
            }, { quoted: msg })
        }

        case 'test':
        case 'preview': {
            await sock.sendMessage(from, { text: '🔄 Running a test cycle (dry-run)...' }, { quoted: msg })
            const result = await runCycle(sock, { force: true, dryRun: true })
            if (result.skipped) {
                return sock.sendMessage(from, { text: fmt.warn(`Cycle skipped: ${result.reason}`) }, { quoted: msg })
            }
            return sock.sendMessage(from, {
                text: fmt.box('TEST CYCLE COMPLETE', [
                    `📡 Sources checked: ${result.sourcesChecked}`,
                    `📰 New articles found: ${result.newArticles}`,
                    `🖼️ Skipped (no image): ${result.noImageSkipped}`,
                    `🔍 Filtered (low importance): ${result.filteredOut}`,
                    `🔁 Duplicates skipped: ${result.duplicatesSkipped}`,
                    result.errors.length ? `⚠️ Errors: ${result.errors.length}` : '✅ No errors',
                    '',
                    '_Dry-run: no posts were published_',
                ])
            }, { quoted: msg })
        }

        case 'run': {
            if (isChecking) {
                return sock.sendMessage(from, { text: fmt.warn('A cycle is already running.') }, { quoted: msg })
            }
            await sock.sendMessage(from, { text: '🔄 Running a live cycle now...' }, { quoted: msg })
            const result = await runCycle(sock, { force: true })
            if (result.skipped) {
                return sock.sendMessage(from, { text: fmt.warn(`Cycle skipped: ${result.reason}`) }, { quoted: msg })
            }
            return sock.sendMessage(from, {
                text: fmt.box('CYCLE COMPLETE', [
                    `📡 Sources checked: ${result.sourcesChecked}`,
                    `📰 Articles qualified: ${result.newArticles}`,
                    `📤 Posts published: ${result.posted}`,
                    `🖼️ Skipped (no image): ${result.noImageSkipped}`,
                    `🔍 Filtered (low importance): ${result.filteredOut}`,
                    result.errors.length ? `⚠️ Errors: ${result.errors.join('; ')}` : '✅ No errors',
                ])
            }, { quoted: msg })
        }

        // ── .news ask <question> ─────────────────────────────────────────────
        // AI generates a branded news post from a question you type.
        // No photo needed — uses the branded dark fallback background.
        case 'ask': {
            const question = args.slice(1).join(' ').trim()
            if (!question) {
                return sock.sendMessage(from, {
                    text: fmt.box('ASK — USAGE', [
                        `Ask any question and it will be turned into a branded news post`,
                        ``,
                        `Usage: *${config.prefix}news ask <your question>*`,
                        ``,
                        `Example:`,
                        `  ${config.prefix}news ask What is happening with Ruto and parliament today?`,
                        ``,
                        `_The answer is styled as a headline + summary, branded with`,
                        `the Mahngueloh News card, and posted to all enabled channels._`,
                    ])
                }, { quoted: msg })
            }

            await sock.sendMessage(from, { text: `🤔 Thinking about your question...\n_${question}_` }, { quoted: msg })

            try {
                const { headline, summary, category } = await askWithAI(question)

                await sock.sendMessage(from, {
                    text: `✍️ AI answer ready:\n*${headline}*\n_${summary}_\nCategory: ${category}\n\nBranding image and posting...`
                }, { quoted: msg })

                const result = await publishCustomPost(sock, { headline, summary, category, imageUrl: null })

                if (!result.ok) {
                    return sock.sendMessage(from, { text: fmt.err(`Could not brand the image: ${result.reason}`) }, { quoted: msg })
                }

                // Send the branded card back to the owner as preview
                await sock.sendMessage(from, {
                    image: result.brandedImage,
                    caption: `✅ *ASK POST DONE*\n\n📰 ${headline}\n\n📤 Posted to: ${result.posted.join(', ') || 'none (no channels configured)'}\n${result.failed.length ? `⚠️ Failed: ${result.failed.join(', ')}` : ''}`,
                }, { quoted: msg })

                store.addLog('success', `ask post: "${headline.slice(0, 50)}" → ${result.posted.join('+')}`)
            } catch (e) {
                store.addLog('error', `ask cmd failed: ${e.message}`)
                return sock.sendMessage(from, { text: fmt.err(`Ask failed: ${e.message}`) }, { quoted: msg })
            }
            break
        }

        // ── .news post <headline> | <summary> [| <imageUrl>] ────────────────
        // Post a fully custom branded card — you write the headline & summary.
        // Optionally attach a photo URL as a third pipe-separated segment.
        case 'post': {
            const raw = args.slice(1).join(' ').trim()
            if (!raw || !raw.includes('|')) {
                return sock.sendMessage(from, {
                    text: fmt.box('POST — USAGE', [
                        `Manually publish a branded post with your own headline & summary`,
                        ``,
                        `Usage: *${config.prefix}news post <headline> | <summary> [| <imageUrl>]*`,
                        ``,
                        `Examples:`,
                        `  ${config.prefix}news post Ruto meets Raila | Both leaders agreed on a new deal`,
                        `  ${config.prefix}news post Arsenal wins EPL title | Gunners clinch league with 2-0 victory | https://example.com/pic.jpg`,
                        ``,
                        `_Without an image URL the post uses the branded dark background._`,
                    ])
                }, { quoted: msg })
            }

            const parts    = raw.split('|').map(s => s.trim())
            const headline = parts[0]
            const summary  = parts[1] || ''
            const imageUrl = parts[2] || null

            // Detect category from headline or use default
            let category = config.news?.branding?.defaultCategory || 'KENYA'
            for (const [cat, kws] of [
                ['SPORT',    ['epl','league','goal','match','world cup','arsenal','chelsea','liverpool','manchester','tottenham','city','premier league','bundesliga','football','basketball','cricket']],
                ['TECH',     ['tech','digital','ai','cyber','hack','startup','app','software','mobile','mpesa','safaricom']],
                ['POLITICS', ['president','parliament','minister','election','vote','ruto','raila','mps','cabinet','senate']],
                ['HEALTH',   ['health','hospital','disease','outbreak','covid','vaccine','medicine','doctor']],
                ['BUSINESS', ['economy','budget','billion','tax','inflation','market','stock','fund','bank','invest']],
                ['WORLD',    ['war','military','attack','nato','europe','usa','china','russia','global','international']],
            ]) {
                if (kws.some(k => headline.toLowerCase().includes(k) || summary.toLowerCase().includes(k))) {
                    category = cat
                    break
                }
            }

            await sock.sendMessage(from, {
                text: `📝 Building branded post...\n*${headline}*${imageUrl ? `\n🖼️ Using: ${imageUrl}` : '\n🎨 Using branded dark background'}`
            }, { quoted: msg })

            try {
                const result = await publishCustomPost(sock, { headline, summary, category, imageUrl })

                if (!result.ok) {
                    return sock.sendMessage(from, { text: fmt.err(`Could not brand the image: ${result.reason}`) }, { quoted: msg })
                }

                await sock.sendMessage(from, {
                    image: result.brandedImage,
                    caption: `✅ *POST DONE*\n\n📰 ${headline}\n📂 ${category}\n\n📤 Posted to: ${result.posted.join(', ') || 'none'}\n${result.failed.length ? `⚠️ Failed: ${result.failed.join(', ')}` : ''}`,
                }, { quoted: msg })

                store.addLog('success', `manual post: "${headline.slice(0, 50)}" → ${result.posted.join('+')}`)
            } catch (e) {
                store.addLog('error', `post cmd failed: ${e.message}`)
                return sock.sendMessage(from, { text: fmt.err(`Post failed: ${e.message}`) }, { quoted: msg })
            }
            break
        }

        // ── .news enable <id>  /  .news disable <id> ────────────────────────
        // Toggle a specific RSS source on or off without editing the JSON file.
        case 'enable':
        case 'disable': {
            const target = args[1]
            if (!target) {
                return sock.sendMessage(from, {
                    text: fmt.err(`Usage: ${config.prefix}news ${sub} <source-id>\nSee IDs with: ${config.prefix}news listsources`)
                }, { quoted: msg })
            }
            const sources = loadSources()
            const found = sources.find(s => s.id === target || s.name.toLowerCase() === target.toLowerCase())
            if (!found) return sock.sendMessage(from, { text: fmt.warn(`Source not found: ${target}`) }, { quoted: msg })
            found.enabled = (sub === 'enable')
            saveSources(sources)
            return sock.sendMessage(from, {
                text: fmt.box('SOURCE UPDATED', [
                    `${found.enabled ? '🟢 Enabled' : '⚪ Disabled'}: *${found.name}*`,
                    `ID: \`${found.id}\``,
                ])
            }, { quoted: msg })
        }

        // ── .news setcategory <id> <category> ───────────────────────────────
        // Change the category label of a source without editing the JSON file.
        case 'setcategory': {
            const target   = args[1]
            const newCat   = args.slice(2).join(' ').trim().toUpperCase()
            if (!target || !newCat) {
                return sock.sendMessage(from, {
                    text: fmt.err(`Usage: ${config.prefix}news setcategory <source-id> <CATEGORY>\nExample: ${config.prefix}news setcategory bbc-sport SPORT`)
                }, { quoted: msg })
            }
            const sources = loadSources()
            const found = sources.find(s => s.id === target || s.name.toLowerCase() === target.toLowerCase())
            if (!found) return sock.sendMessage(from, { text: fmt.warn(`Source not found: ${target}`) }, { quoted: msg })
            const oldCat = found.category || '—'
            found.category = newCat
            saveSources(sources)
            return sock.sendMessage(from, {
                text: fmt.box('CATEGORY UPDATED', [
                    `*${found.name}*`,
                    `Category: ${oldCat} → *${newCat}*`,
                ])
            }, { quoted: msg })
        }

        // ── .news addkeyword [high] <word> ──────────────────────────────────
        // Add a runtime importance keyword (affects article filtering this session).
        case 'addkeyword': {
            const isHigh = (args[1] || '').toLowerCase() === 'high'
            const word   = args.slice(isHigh ? 2 : 1).join(' ').trim().toLowerCase()
            if (!word) {
                return sock.sendMessage(from, {
                    text: fmt.box('ADDKEYWORD — USAGE', [
                        `Add a word to the importance filter (this session only):`,
                        `  ${config.prefix}news addkeyword <word>           — medium priority (+1 pt)`,
                        `  ${config.prefix}news addkeyword high <word>      — high priority (+3 pts)`,
                        ``,
                        `Example: ${config.prefix}news addkeyword high earthquake`,
                        ``,
                        `_To make permanent, add to HIGH_KEYWORDS or MEDIUM_KEYWORDS in newsMonitor.js_`,
                    ])
                }, { quoted: msg })
            }
            const list = isHigh ? runtimeHighKeywords : runtimeMediumKeywords
            const label = isHigh ? 'HIGH' : 'MEDIUM'
            if (list.includes(word)) {
                return sock.sendMessage(from, { text: fmt.warn(`"${word}" is already in the ${label} list`) }, { quoted: msg })
            }
            list.push(word)
            return sock.sendMessage(from, {
                text: fmt.box('KEYWORD ADDED', [
                    `✅ *"${word}"* added to ${label} importance list`,
                    `_Articles matching this keyword score ${isHigh ? '+6 pts (title) / +3 pts (desc)' : '+2 pts (title) / +1 pt (desc)'}_`,
                    `_Resets on bot restart — ${list.length} runtime ${label.toLowerCase()} keyword${list.length !== 1 ? 's' : ''} active_`,
                ])
            }, { quoted: msg })
        }

        // ── .news delkeyword <word> ──────────────────────────────────────────
        // Remove a runtime keyword added this session.
        case 'delkeyword': {
            const word = args.slice(1).join(' ').trim().toLowerCase()
            if (!word) {
                return sock.sendMessage(from, {
                    text: fmt.err(`Usage: ${config.prefix}news delkeyword <word>`)
                }, { quoted: msg })
            }
            const hiIdx = runtimeHighKeywords.indexOf(word)
            const midIdx = runtimeMediumKeywords.indexOf(word)
            if (hiIdx !== -1) {
                runtimeHighKeywords.splice(hiIdx, 1)
                return sock.sendMessage(from, { text: `✅ Removed *"${word}"* from HIGH keyword list` }, { quoted: msg })
            } else if (midIdx !== -1) {
                runtimeMediumKeywords.splice(midIdx, 1)
                return sock.sendMessage(from, { text: `✅ Removed *"${word}"* from MEDIUM keyword list` }, { quoted: msg })
            } else {
                return sock.sendMessage(from, { text: fmt.warn(`"${word}" not found in any runtime keyword list`) }, { quoted: msg })
            }
        }

        // ── .news keywords ───────────────────────────────────────────────────
        // List all runtime keywords added this session.
        case 'keywords': {
            const lines = [
                `🔴 *HIGH runtime keywords* (${runtimeHighKeywords.length}):`,
                runtimeHighKeywords.length ? runtimeHighKeywords.map(k => `  • ${k}`).join('\n') : '  _none added_',
                ``,
                `🟡 *MEDIUM runtime keywords* (${runtimeMediumKeywords.length}):`,
                runtimeMediumKeywords.length ? runtimeMediumKeywords.map(k => `  • ${k}`).join('\n') : '  _none added_',
                ``,
                `_Plus ${HIGH_KEYWORDS.length} built-in HIGH + ${MEDIUM_KEYWORDS.length} built-in MEDIUM keywords_`,
                `_Runtime keywords reset on bot restart_`,
            ]
            return sock.sendMessage(from, { text: fmt.box('IMPORTANCE KEYWORDS', lines) }, { quoted: msg })
        }

        // ── .news setslogan <text> ───────────────────────────────────────────
        // Change the footer slogan shown on every branded image (this session).
        case 'setslogan': {
            const slogan = args.slice(1).join(' ').trim().toUpperCase()
            if (!slogan) {
                return sock.sendMessage(from, {
                    text: fmt.err(`Usage: ${config.prefix}news setslogan <NEW SLOGAN TEXT>\nCurrent: ${config.news?.branding?.slogan || 'FAST. ACCURATE. TRENDING.'}`)
                }, { quoted: msg })
            }
            if (!config.news) config.news = {}
            if (!config.news.branding) config.news.branding = {}
            const old = config.news.branding.slogan || 'FAST. ACCURATE. TRENDING.'
            config.news.branding.slogan = slogan
            return sock.sendMessage(from, {
                text: fmt.box('SLOGAN UPDATED', [
                    `Old: _${old}_`,
                    `New: *${slogan}*`,
                    ``,
                    `_Takes effect on next post. Resets on restart._`,
                    `_For permanent change: set NEWS_SLOGAN in .env_`,
                ])
            }, { quoted: msg })
        }

        // ── .news sethandle <@handle> ────────────────────────────────────────
        // Change the social handle shown in the image footer (this session).
        case 'sethandle': {
            const handle = args.slice(1).join(' ').trim()
            if (!handle) {
                return sock.sendMessage(from, {
                    text: fmt.err(`Usage: ${config.prefix}news sethandle <@yourhandle>\nCurrent: ${config.news?.branding?.socialHandle || '@mahnguelohnews'}`)
                }, { quoted: msg })
            }
            if (!config.news) config.news = {}
            if (!config.news.branding) config.news.branding = {}
            const old = config.news.branding.socialHandle || '@mahnguelohnews'
            config.news.branding.socialHandle = handle.startsWith('@') ? handle : `@${handle}`
            return sock.sendMessage(from, {
                text: fmt.box('HANDLE UPDATED', [
                    `Old: _${old}_`,
                    `New: *${config.news.branding.socialHandle}*`,
                    ``,
                    `_Takes effect on next post. Resets on restart._`,
                    `_For permanent change: set NEWS_SOCIAL_HANDLE in .env_`,
                ])
            }, { quoted: msg })
        }

        default: {
            return sock.sendMessage(from, {
                text: fmt.box('NEWS MONITOR — HELP', [
                    `*─── AUTO-POSTING ───*`,
                    `${config.prefix}news on/off        — Enable/disable auto-posting`,
                    `${config.prefix}news status        — Full dashboard`,
                    `${config.prefix}news stats         — Posting statistics`,
                    `${config.prefix}news logs [N]      — Last N log lines`,
                    `${config.prefix}news run           — Force a live cycle now`,
                    `${config.prefix}news test          — Dry-run (no posts sent)`,
                    ``,
                    `*─── MANUAL POSTING ───*`,
                    `${config.prefix}news ask <question>            — AI post from any question`,
                    `${config.prefix}news post <headline> | <summary> [| <imageUrl>]`,
                    ``,
                    `*─── SOURCES ───*`,
                    `${config.prefix}news listsources              — Show all RSS sources`,
                    `${config.prefix}news addsource <URL> [name]   — Add a new source`,
                    `${config.prefix}news removesource <id>        — Remove a source`,
                    `${config.prefix}news enable <id>              — Enable a source`,
                    `${config.prefix}news disable <id>             — Disable a source`,
                    `${config.prefix}news setcategory <id> <CAT>   — Change source category`,
                    ``,
                    `*─── FILTERS ───*`,
                    `${config.prefix}news addkeyword [high] <word> — Add importance keyword`,
                    `${config.prefix}news delkeyword <word>        — Remove runtime keyword`,
                    `${config.prefix}news keywords                 — List runtime keywords`,
                    `${config.prefix}news quotas                   — Show today's category mix`,
                    `${config.prefix}news setquota <CAT> <%|off>   — Cap a category's daily share`,
                    ``,
                    `*─── BRANDING ───*`,
                    `${config.prefix}news setslogan <TEXT>         — Change footer slogan`,
                    `${config.prefix}news sethandle <@handle>      — Change social handle`,
                    `${config.prefix}news interval <secs>          — Change check frequency`,
                ])
            }, { quoted: msg })
        }
    }
}

function clearOwnerAlert(key) { notifiedOnce.delete(key) }

module.exports = { initNewsMonitor, stopNewsMonitor, handleNewsCmd, runCycle, clearOwnerAlert }
