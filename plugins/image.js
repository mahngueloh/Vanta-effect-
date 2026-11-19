const fmt = require('../lib/format')

const silentLogger = {
    level: 'silent', child: () => silentLogger,
    info: () => {}, debug: () => {}, error: () => {}, warn: () => {}, trace: () => {}
}

async function getWallpaper(sock, from, query, msg) {
    try {
        const q   = encodeURIComponent(query || 'nature wallpaper 4k')
        // Unsplash source — free, no key
        const url = `https://source.unsplash.com/1080x1920/?${q}&sig=${Date.now()}`
        await sock.sendMessage(from, {
            image: { url },
            caption: fmt.box('WALLPAPER', [
                `🖼️ *Query:* ${query || 'Random'}`,
                `_Powered by Unsplash_`,
            ])
        }, { quoted: msg })
    } catch {
        try {
            // Fallback: Lorem Picsum
            await sock.sendMessage(from, {
                image: { url: `https://picsum.photos/1080/1920?random=${Date.now()}` },
                caption: fmt.box('WALLPAPER', [`🖼️ Random wallpaper`])
            }, { quoted: msg })
        } catch {
            await sock.sendMessage(from, {
                text: fmt.box('WALLPAPER FAILED', [`❌ Could not fetch wallpaper. Try again.`])
            }, { quoted: msg })
        }
    }
}

async function getRemini(sock, from, msg) {
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
    if (!quoted?.imageMessage) {
        return sock.sendMessage(from, {
            text: fmt.box('REMINI', [
                `❌ *Reply to an image* with *.remini* to enhance it`,
            ])
        }, { quoted: msg })
    }
    try {
        const { downloadMediaMessage } = require('@neoxr/baileys')
        const ctx = msg.message?.extendedTextMessage?.contextInfo || {}
        const quotedKey = {
            remoteJid: from,
            id: ctx.stanzaId || '',
            participant: ctx.participant || '',
        }
        const buf = await downloadMediaMessage(
            { message: quoted, key: quotedKey },
            'buffer', {},
            { logger: silentLogger, reuploadRequest: sock.updateMediaMessage }
        )

        // DeepAI free tier
        const formData = new FormData()
        formData.append('image', new Blob([buf], { type: 'image/jpeg' }), 'image.jpg')

        const res = await fetch('https://api.deepai.org/api/torch-srgan', {
            method: 'POST',
            headers: { 'api-key': 'quickstart-QUdJIGlzIGNvbWluZy4uLi4K' },
            body: formData,
            signal: AbortSignal.timeout(30000)
        })
        const data = await res.json()
        if (data.output_url) {
            await sock.sendMessage(from, {
                image: { url: data.output_url },
                caption: fmt.box('REMINI', [`✅ Image enhanced successfully!`])
            }, { quoted: msg })
        } else {
            throw new Error('No result from API')
        }
    } catch (e) {
        await sock.sendMessage(from, {
            text: fmt.box('REMINI FAILED', [
                `❌ Enhancement failed`,
                ``,
                `💡 Try these free alternatives:`,
                `• https://remini.ai`,
                `• https://letsenhance.io`,
                `• https://picwish.com`,
            ])
        }, { quoted: msg })
    }
}

// Uploads a buffer to catbox.moe (free, anonymous, no key) to get a public
// URL — needed because Savage's bgremover takes an `imageUrl` to fetch
// rather than accepting a direct file upload, and a WhatsApp media message
// has no public URL of its own (it's an encrypted blob on WA's own CDN).
// Temporary public hosts, tried in order. Nexray needs a URL it can fetch, so the
// image is uploaded to one of these first. Each returns a direct image URL.
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; VantaBot/3.4)' }
const UPLOAD_HOSTS = [
    ['catbox', async (buf, name, axios, FD) => {
        const f = new FD(); f.append('reqtype', 'fileupload'); f.append('fileToUpload', buf, name)
        const r = await axios.post('https://catbox.moe/user/api.php', f, { headers: { ...f.getHeaders(), ...UA }, timeout: 25000 })
        return String(r.data).trim()
    }],
    ['litterbox', async (buf, name, axios, FD) => {
        const f = new FD(); f.append('reqtype', 'fileupload'); f.append('time', '1h'); f.append('fileToUpload', buf, name)
        const r = await axios.post('https://litterbox.catbox.moe/resources/internals/api.php', f, { headers: { ...f.getHeaders(), ...UA }, timeout: 25000 })
        return String(r.data).trim()
    }],
    ['uguu', async (buf, name, axios, FD) => {
        const f = new FD(); f.append('files[]', buf, name)
        const r = await axios.post('https://uguu.se/upload', f, { headers: { ...f.getHeaders(), ...UA }, timeout: 25000 })
        return r.data?.files?.[0]?.url
    }],
    ['tmpfiles', async (buf, name, axios, FD) => {
        const f = new FD(); f.append('file', buf, name)
        const r = await axios.post('https://tmpfiles.org/api/v1/upload', f, { headers: { ...f.getHeaders(), ...UA }, timeout: 25000 })
        const u = r.data?.data?.url
        return u ? u.replace('tmpfiles.org/', 'tmpfiles.org/dl/').replace('http://', 'https://') : null
    }],
    ['0x0', async (buf, name, axios, FD) => {
        const f = new FD(); f.append('file', buf, name)
        const r = await axios.post('https://0x0.st', f, { headers: { ...f.getHeaders(), ...UA }, timeout: 25000 })
        return String(r.data).trim()
    }],
]

// Uploads to the first host that works. `skip` lets callers move on to the next host.
async function uploadPublic(buf, filename, skip = []) {
    const FD = require('form-data'), axios = require('axios')
    const errs = []
    for (const [name, fn] of UPLOAD_HOSTS) {
        if (skip.includes(name)) continue
        try {
            const url = await fn(buf, filename, axios, FD)
            if (typeof url === 'string' && /^https?:\/\//.test(url)) return { url, host: name }
            errs.push(`${name}: bad reply`)
        } catch (e) { errs.push(`${name}: ${e.message}`) }
    }
    throw new Error(`upload failed (${errs.join('; ')})`)
}

// Nexray's removebg — tried first:
//   GET https://api.nexray.eu.cc/tools/removebg?url=<public image url>
// It fetches the image from a URL, so the WhatsApp image is uploaded to a
// temporary public host first. Returns { buf } or { error } (never throws).
async function nexrayRemoveBackground(buf) {
    const axios = require('axios')
    const base = (process.env.NEXRAY_API_BASE || 'https://api.nexray.eu.cc').replace(/\/+$/, '')
    const tried = [], errors = []
    // Different upload hosts: if Nexray can't fetch from one (or the host is down), try the next.
    for (let i = 0; i < UPLOAD_HOSTS.length; i++) {
        let up
        try { up = await uploadPublic(buf, 'image.jpg', tried) } catch (e) { errors.push(e.message); break }
        tried.push(up.host)
        try {
            const params = { url: up.url }
            if (process.env.NEXRAY_API_KEY) params.apikey = process.env.NEXRAY_API_KEY
            const res = await axios.get(`${base}/tools/removebg`, { params, timeout: 60000, responseType: 'arraybuffer', headers: UA, validateStatus: () => true })
            const ct = res.headers['content-type'] || ''
            if (res.status === 200 && ct.startsWith('image/')) { console.log(`[removebg] Nexray OK via ${up.host}`); return { buf: Buffer.from(res.data) } }
            let data = null
            try { data = JSON.parse(Buffer.from(res.data).toString('utf8')) } catch {}
            const out = data && (data.result || data.url || data.output || data.data?.url || data.data?.result || data.image)
            if (typeof out === 'string' && /^https?:/.test(out)) {
                const img = await axios.get(out, { responseType: 'arraybuffer', timeout: 30000, headers: UA })
                console.log(`[removebg] Nexray OK via ${up.host} (result url)`)
                return { buf: Buffer.from(img.data) }
            }
            const why = data ? String(data.error || data.message || JSON.stringify(data)).slice(0, 120) : `HTTP ${res.status} ${ct || 'no content-type'}`
            errors.push(`${up.host}: ${why}`)
            console.log(`[removebg] Nexray failed via ${up.host}: ${why}`)
        } catch (e) { errors.push(`${up.host}: ${e.message}`); console.log(`[removebg] Nexray error via ${up.host}: ${e.message}`) }
    }
    return { error: errors.join(' | ').slice(0, 300) }
}

// Savage API's bgremover — second choice since that's the preferred provider.
// Returns { buf } on success or { error } on failure (never throws) so the
// caller can fall through to remove.bg/DeepAI while still keeping the real
// reason to show the user if every provider fails.
async function savageRemoveBackground(buf) {
    const config = require('../config')
    if (!config.savageApiKey) return { error: 'no Savage API key configured' }
    const axios = require('axios')
    try {
        const imageUrl = (await uploadPublic(buf, 'image.jpg')).url
        const res = await axios.get(`${config.savageApiBase}/tools/bgremover`, {
            params: { apikey: config.savageApiKey, imageUrl },
            timeout: 30000,
            responseType: 'arraybuffer',
            validateStatus: () => true,
        })
        const contentType = res.headers['content-type'] || ''
        if (res.status === 200 && contentType.startsWith('image/')) {
            // API returned the processed image directly.
            return { buf: Buffer.from(res.data) }
        }
        // Otherwise it's JSON — either an error, or a result URL to fetch.
        let data
        try { data = JSON.parse(Buffer.from(res.data).toString('utf8')) } catch { data = null }
        if (!data) {
            return { error: `non-JSON, non-image response (HTTP ${res.status}, ${contentType || 'no content-type'})` }
        }
        if (data.error || data.message) {
            return { error: `${data.error || data.message}` }
        }
        const resultUrl = data.result || data.url || data.output || data.data?.url || data.image
        if (!resultUrl) {
            return { error: `no usable result field — ${JSON.stringify(data).slice(0, 200)}` }
        }
        const imgRes = await axios.get(resultUrl, { responseType: 'arraybuffer', timeout: 20000 })
        return { buf: Buffer.from(imgRes.data) }
    } catch (e) {
        return { error: e.message }
    }
}

async function getRemoveBackground(sock, from, msg) {
    // Works on a replied-to image, or on an image sent with the command as its caption.
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage || (msg.message?.imageMessage ? msg.message : null)
    const direct = !msg.message?.extendedTextMessage?.contextInfo?.quotedMessage && !!msg.message?.imageMessage
    if (!quoted?.imageMessage) {
        return sock.sendMessage(from, {
            text: fmt.box('REMOVE BACKGROUND', [
                `❌ *Reply to an image* with *.removebc* to cut out the background`,
            ])
        }, { quoted: msg })
    }
    try {
        await fmt.react(sock, msg, '⏳')
        const { downloadMediaMessage } = require('@neoxr/baileys')
        const ctx = msg.message?.extendedTextMessage?.contextInfo || {}
        const quotedKey = direct ? msg.key : {
            remoteJid: from,
            id: ctx.stanzaId || '',
            participant: ctx.participant || '',
        }
        const buf = await downloadMediaMessage(
            { message: quoted, key: quotedKey },
            'buffer', {},
            { logger: silentLogger, reuploadRequest: sock.updateMediaMessage }
        )

        const config = require('../config')
        const nexResult = await nexrayRemoveBackground(buf)
        let pngBuf = nexResult.buf
        let provider = 'Nexray'
        let savageError = `Nexray: ${nexResult.error}`
        if (!pngBuf) {
            const savageResult = await savageRemoveBackground(buf)
            pngBuf = savageResult.buf
            provider = 'Savage API'
            savageError += `; Savage: ${savageResult.error}`
        }

        if (!pngBuf) {
            const apiKey = process.env.REMOVEBG_API_KEY || config.removeBgApiKey
            if (apiKey) {
                // remove.bg — a real signup (still free-tier, 50 images/month).
                const FormDataNode = require('form-data')
                const axios = require('axios')
                const form = new FormDataNode()
                form.append('image_file', buf, 'image.jpg')
                form.append('size', 'auto')
                const res = await axios.post('https://api.remove.bg/v1.0/removebg', form, {
                    headers: { ...form.getHeaders(), 'X-Api-Key': apiKey },
                    responseType: 'arraybuffer', timeout: 30000, validateStatus: () => true,
                })
                if (res.status !== 200) {
                    const errBody = Buffer.isBuffer(res.data) ? res.data.toString('utf8') : JSON.stringify(res.data)
                    throw new Error(`Savage: ${savageError}. remove.bg (${res.status}): ${errBody.slice(0, 200)}`)
                }
                pngBuf = Buffer.from(res.data)
                provider = 'remove.bg'
            } else {
                // Last resort — DeepAI's shared demo key. background-remover
                // isn't on its free-tier whitelist as of writing, so this is
                // likely to fail too; error message below surfaces why.
                const formData = new FormData()
                formData.append('image', new Blob([buf], { type: 'image/jpeg' }), 'image.jpg')
                const res = await fetch('https://api.deepai.org/api/background-remover', {
                    method: 'POST',
                    headers: { 'api-key': 'quickstart-QUdJIGlzIGNvbWluZy4uLi4K' },
                    body: formData,
                    signal: AbortSignal.timeout(30000)
                })
                const data = await res.json()
                if (!data.output_url) {
                    throw new Error(`Savage: ${savageError}. DeepAI: ${data.err || data.error || data.status || JSON.stringify(data).slice(0, 200)}`)
                }
                const axios = require('axios')
                pngBuf = Buffer.from((await axios.get(data.output_url, { responseType: 'arraybuffer' })).data)
                provider = 'DeepAI'
            }
        }

        // Send two ways: as a sticker (transparency actually visible
        // in-chat) and as a raw document (full-resolution PNG to save).
        try {
            const { Sticker, StickerTypes } = require('wa-sticker-formatter')
            const sticker = new Sticker(pngBuf, {
                pack: config.botName, author: config.ownerName,
                type: StickerTypes.FULL, quality: 90,
            })
            await sock.sendMessage(from, { sticker: await sticker.toBuffer() }, { quoted: msg })
        } catch {}

        await sock.sendMessage(from, {
            document: pngBuf, mimetype: 'image/png', fileName: 'no-background.png',
            caption: fmt.box('REMOVE BACKGROUND', [`✅ Background removed (${provider})`])
        }, { quoted: msg })
        await fmt.react(sock, msg, '✅')
    } catch (e) {
        console.error('[removebc] failed:', e.message)
        await sock.sendMessage(from, {
            text: fmt.box('REMOVE BACKGROUND FAILED', [
                `❌ ${e.message}`,
                ``,
                apiKeyHint,
                `💡 Or use manually: https://remove.bg or https://picwish.com`,
            ])
        }, { quoted: msg })
    }
}

const apiKeyHint = `💡 For a reliable fallback, get a free remove.bg API key at https://www.remove.bg/api (50 free/month) and set REMOVEBG_API_KEY in your .env`

module.exports = { getWallpaper, getRemini, getRemoveBackground }
