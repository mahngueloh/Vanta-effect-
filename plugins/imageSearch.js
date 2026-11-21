'use strict'
// .images <what> [count]  → sends several real pictures of it (default 4, max 8).
// Sources: Nexray image search endpoints, tried in turn until enough pictures are found.
const axios = require('axios')
const nx = require('../lib/nexray')
const fmt = require('../lib/format')

const imageCmds = new Set(['images', 'imgs', 'img', 'pics', 'pic', 'imagesearch'])
const SOURCES = ['/search/pinterest', '/search/googleimage', '/search/bingimage', '/search/istock', '/search/wallcraft']
const IMG_RE = /\.(jpe?g|png|webp|gif)(\?|$)/i

// Collect every image-looking URL from whatever JSON shape the endpoint returned.
function collect(json) {
    const out = []
    const walk = (o, key = '', depth = 0) => {
        if (depth > 6 || o == null) return
        if (typeof o === 'string') {
            if (/^https?:\/\//i.test(o) && (IMG_RE.test(o) || /image|img|photo|pic|thumb|url|media|src|original/i.test(key))) out.push(o)
            return
        }
        if (Array.isArray(o)) return o.forEach(v => walk(v, key, depth + 1))
        if (typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, k, depth + 1)
    }
    walk(json?.result ?? json?.data ?? json)
    // Prefer direct image files, drop page links (pinterest.com/pin/…, google search pages…)
    const direct = out.filter(u => IMG_RE.test(u) || /(pinimg|gstatic|googleusercontent|bing\.net|istockphoto|cdn)/i.test(u))
    return [...new Set(direct.length ? direct : out)]
}

async function fetchImage(url) {
    const res = await axios.get(url, {
        responseType: 'arraybuffer', timeout: 25000, maxContentLength: 12 * 1024 * 1024,
        headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36', 'Accept': 'image/*,*/*' },
        validateStatus: s => s >= 200 && s < 300,
    })
    const b = Buffer.from(res.data)
    const ok = b.length > 3000 && ((b[0] === 0xFF && b[1] === 0xD8) || (b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0x47 && b[1] === 0x49) || (b[0] === 0x52 && b[8] === 0x57))
    if (!ok) throw new Error('not an image')
    return b
}

async function handleImages(sock, from, cmd, args, msg) {
    const list = [...args]
    let count = 4
    if (list.length > 1 && /^\d{1,2}$/.test(list[list.length - 1])) count = Math.min(8, Math.max(1, Number(list.pop())))
    const q = list.join(' ').trim()
    if (!q) return sock.sendMessage(from, { text: fmt.usage('images', '<what to search> [how many]') }, { quoted: msg })

    try { await sock.sendMessage(from, { react: { text: '🔎', key: msg.key } }) } catch {}
    const got = []
    const seen = new Set()
    for (const ep of SOURCES) {
        if (got.length >= count) break
        let urls = []
        try {
            const r = await nx.call(ep, { params: { q }, timeout: 40000 })
            if (r.type === 'json' && r.json?.status !== false) urls = collect(r.json)
            else console.log(`[images] ${ep}: ${r.type} ${nx.cleanErr(r.json) || r.status}`)
        } catch (e) { console.log(`[images] ${ep} failed: ${e.message}`); continue }
        console.log(`[images] ${ep}: ${urls.length} candidate(s)`)
        // download a few extra in parallel batches so dead links don't leave us short
        for (let i = 0; i < urls.length && got.length < count; i += 4) {
            const batch = urls.slice(i, i + 4).filter(u => !seen.has(u))
            batch.forEach(u => seen.add(u))
            const res = await Promise.allSettled(batch.map(fetchImage))
            for (const [j, r] of res.entries()) if (r.status === 'fulfilled' && got.length < count) got.push(r.value)
            else if (r.status === 'rejected') console.log('[images] skip', batch[j].slice(0, 80), r.reason?.message)
        }
    }
    if (!got.length) {
        try { await sock.sendMessage(from, { react: { text: '❌', key: msg.key } }) } catch {}
        return sock.sendMessage(from, { text: fmt.box('IMAGES', [`❌ Couldn't find pictures for *${q}*. Try different words.`]) }, { quoted: msg })
    }
    for (const [i, buf] of got.entries()) {
        try { await sock.sendMessage(from, { image: buf, caption: i === 0 ? `🖼️ *${q}* — ${got.length} picture${got.length > 1 ? 's' : ''}` : '' }, { quoted: i === 0 ? msg : undefined }) }
        catch (e) { console.log('[images] send failed:', e.message) }
    }
    try { await sock.sendMessage(from, { react: { text: '✅', key: msg.key } }) } catch {}
}

module.exports = { imageCmds, handleImages, collect }
