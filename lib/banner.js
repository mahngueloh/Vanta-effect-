'use strict'
// The bot's banner media. If assets/banner.mp4 exists it is a short playable
// video (tap to play); otherwise the old assets/banner.png image is used.
// Spread the result into a sendMessage / sendButtons content object:
//   sock.sendMessage(jid, { ...bannerMedia(), caption })
//   sendButtons(sock, jid, { ...bannerMedia(), text, buttons })
// Set BANNER_GIF=1 to make the video loop silently like a GIF instead.
const fs = require('fs')
const path = require('path')

const DIR = path.join(__dirname, '..', 'assets')
const VIDEO = path.join(DIR, 'banner.mp4')
const IMAGE = path.join(DIR, 'banner.png')
const cache = {}

function read(file) {
    try {
        const st = fs.statSync(file)
        if (cache[file] && cache[file].m === st.mtimeMs) return cache[file].b
        const b = fs.readFileSync(file)
        cache[file] = { m: st.mtimeMs, b }
        return b
    } catch { return null }
}

function bannerMedia() {
    const v = read(VIDEO)
    if (v) {
        const m = { video: v, mimetype: 'video/mp4' }
        if (/^(1|true|yes)$/i.test(process.env.BANNER_GIF || '')) m.gifPlayback = true
        return m
    }
    const i = read(IMAGE)
    return i ? { image: i } : null
}

// Same banner but forced to the still image (fallback if a video send fails).
function bannerImage() {
    const i = read(IMAGE)
    return i ? { image: i } : null
}

// Banner + buttons in ONE message. Tries the video banner, then the still
// image, and throws only if both fail (callers then fall back to text).
async function sendButtonsWithBanner(mod, sock, jid, content, opts) {
    const tries = [bannerMedia(), bannerImage()].filter(Boolean)
    const seen = new Set()
    let lastErr = new Error('no banner')
    for (const m of tries) {
        const key = m.video ? 'v' : 'i'
        if (seen.has(key)) continue
        seen.add(key)
        try { return await mod.sendButtons(sock, jid, { ...m, ...content }, opts) }
        catch (e) { lastErr = e; console.log(`[banner] ${key === 'v' ? 'video' : 'image'}+buttons send failed:`, e.message) }
    }
    throw lastErr
}

// Plain (non-button) banner message: video first, still image if the video
// send fails, text-only as a last resort so the command never goes silent.
async function sendBannerPlain(sock, jid, extra = {}, opts = {}) {
    const { caption, ...rest } = extra
    for (const m of [bannerMedia(), bannerImage()].filter(Boolean)) {
        try { return await sock.sendMessage(jid, { ...m, ...(caption != null ? { caption } : {}), ...rest }, opts) }
        catch (e) { console.log('[banner] plain send failed:', e.message) }
    }
    return sock.sendMessage(jid, { text: caption || '', ...rest }, opts)
}

module.exports = { sendBannerPlain, sendButtonsWithBanner, bannerMedia, bannerImage, BANNER_VIDEO: VIDEO, BANNER_IMAGE: IMAGE }
