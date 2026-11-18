'use strict'
// The bot's banner media. If assets/banner.mp4 exists it is a short playable
// video (tap to play); otherwise the old assets/banner.png image is used.
// Spread the result into a sendMessage / sendButtons content object:
//   sock.sendMessage(jid, { ...bannerMedia(), caption })
//   sendButtons(sock, jid, { ...bannerMedia(), text, buttons })
// The video autoplays and loops silently like a GIF (set BANNER_GIF=0 for a tap-to-play video).
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
        // gifPlayback = WhatsApp's autoplay-and-loop mode (no tap, silent), like a GIF.
        const m = { video: v, mimetype: 'video/mp4' }
        if (!/^(0|false|no)$/i.test(process.env.BANNER_GIF || '')) m.gifPlayback = true
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

// ── Upload the video ONCE and reuse the same uploaded file in every message ──
// A fresh upload per message gets a new key/URL, so WhatsApp treats each one as
// a different file and asks to download it again. Re-sending the SAME uploaded
// media (what Forward does) lets the phone reuse the copy it already has.
// Re-uploaded after 20h (WhatsApp keeps media ~30 days) or after a failure.
const THUMB = path.join(DIR, 'banner-thumb.jpg')
let prepared = null, inflight = null
const TTL = 20 * 3600 * 1000

async function preparedVideo(sock) {
    const v = read(VIDEO)
    if (!v) return null
    if (prepared && prepared.buf === v && Date.now() - prepared.at < TTL) return prepared.vm
    if (inflight) return inflight
    inflight = (async () => {
        const { prepareWAMessageMedia } = require('@neoxr/baileys')
        const media = await prepareWAMessageMedia({ video: v, mimetype: 'video/mp4', gifPlayback: bannerMedia().gifPlayback === true }, { upload: sock.waUploadToServer })
        const vm = media.videoMessage
        const th = read(THUMB)
        if (th && !(vm.jpegThumbnail && vm.jpegThumbnail.length)) vm.jpegThumbnail = th
        prepared = { vm, at: Date.now(), buf: v }
        console.log(`[banner] video uploaded once, reused for all messages (${(v.length / 1024) | 0} KB)`)
        return vm
    })().finally(() => { inflight = null })
    return inflight
}
const forget = () => { prepared = null }

async function sendCachedVideo(sock, jid, { caption, mentions, ...rest } = {}, opts = {}) {
    const { generateWAMessageFromContent, proto } = require('@neoxr/baileys')
    const vm = await preparedVideo(sock)
    if (!vm) throw new Error('no video banner')
    const ctx = {}
    if (mentions && mentions.length) ctx.mentionedJid = mentions
    const content = { videoMessage: proto.Message.VideoMessage.create({ ...vm, caption: caption || '', contextInfo: ctx }) }
    const full = generateWAMessageFromContent(jid, content, { userJid: sock.user?.id, quoted: opts.quoted })
    await sock.relayMessage(jid, full.message, { messageId: full.key.id })
    return full
}

// Banner + buttons in ONE message: cached video, then still image; throws only
// if both fail (callers then fall back to text).
async function sendButtonsWithBanner(mod, sock, jid, content, opts) {
    let lastErr = new Error('no banner')
    if (bannerMedia()?.video) {
        try {
            const vm = await preparedVideo(sock)
            return await mod.sendButtons(sock, jid, { videoMessage: vm, ...content }, opts)
        } catch (e) { forget(); lastErr = e; console.log('[banner] video+buttons send failed:', e.message) }
    }
    const img = bannerImage()
    if (img) {
        try { return await mod.sendButtons(sock, jid, { ...img, ...content }, opts) }
        catch (e) { lastErr = e; console.log('[banner] image+buttons send failed:', e.message) }
    }
    throw lastErr
}

// Plain (non-button) banner message: cached video, still image, then text only.
async function sendBannerPlain(sock, jid, extra = {}, opts = {}) {
    const { caption, ...rest } = extra
    if (bannerMedia()?.video) {
        try { return await sendCachedVideo(sock, jid, { caption, ...rest }, opts) }
        catch (e) { forget(); console.log('[banner] video send failed:', e.message) }
    }
    const img = bannerImage()
    if (img) {
        try { return await sock.sendMessage(jid, { ...img, ...(caption != null ? { caption } : {}), ...rest }, opts) }
        catch (e) { console.log('[banner] image send failed:', e.message) }
    }
    return sock.sendMessage(jid, { text: caption || '', ...rest }, opts)
}

module.exports = { sendButtonsWithBanner, sendBannerPlain, bannerMedia, bannerImage, preparedVideo, BANNER_VIDEO: VIDEO, BANNER_IMAGE: IMAGE }
