'use strict'

const config   = require('../config')
const fmt      = require('../lib/format')
const { exec } = require('child_process')
const fs       = require('fs')
const os       = require('os')
const path     = require('path')
const axios    = require('axios')
const { runtimeSettings, scopeAllows } = require('./ownerCmds')

const MAX_MUSIC_SECS  = 900   // 15 min  — anything longer is not a song
const MAX_VIDEO_SECS  = 1200  // 20 min  — for video downloads
const MAX_BYTES       = (config.maxDownloadSize || 80) * 1024 * 1024
const DL_TMP_DIR       = path.join(os.homedir(), "Mahngueloh", ".mahngueloh-tmp")
fs.mkdirSync(DL_TMP_DIR, { recursive: true, mode: 0o700 })
const MIN_BYTES       = 2000  // reject files smaller than 2 KB
const UA              = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36'

// Axios-backed request helper (keeps a fetch()-like res.ok/json()/text() shape)
async function httpRequest(url, opts = {}) {
    const { method = 'GET', headers = {}, body, signal } = opts
    const res = await axios.request({
        url,
        method,
        headers,
        data: body,
        signal,                       // axios accepts a native AbortSignal directly
        responseType: 'arraybuffer',  // read raw bytes; parse as text/json on demand below
        maxRedirects: 5,
        validateStatus: () => true,   // never throw on non-2xx — callers check res.ok themselves
    })
    const buf = Buffer.from(res.data)
    return {
        ok:      res.status >= 200 && res.status < 300,
        status:  res.status,
        headers: res.headers,
        text:        async () => buf.toString('utf8'),
        json:        async () => JSON.parse(buf.toString('utf8')),
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    }
}

async function resolveShortUrl(url) {
    try {
        const res = await axios.request({ url, method: 'HEAD', maxRedirects: 5, validateStatus: () => true })
        return res.request?.res?.responseUrl || res.request?.responseURL || url
    } catch (e) {
        console.error('[downloader] resolveShortUrl failed:', e.message)
        return url
    }
}

// ruhend-scraper — tried first on every command, falls back to providers below
let _ruhend = null
function getRuhend() {
    if (_ruhend !== null) return _ruhend
    try {
        _ruhend = require('ruhend-scraper')
    } catch (e) {
        console.error('[downloader] ruhend-scraper not installed — run `npm i ruhend-scraper`. Falling back to built-in providers.')
        _ruhend = false
    }
    return _ruhend
}

async function ruhendTikTok(url) {
    const lib = getRuhend()
    if (!lib?.ttdl) return null
    try {
        const d = await lib.ttdl(url)
        const videoUrl = d?.video || d?.data?.video || null
        if (!videoUrl) return null
        return {
            title:    d.title || 'TikTok Video',
            author:   d.author || d.username || '',
            duration: d.duration ? fmtDur(d.duration) : '',
            videoUrl,
            audioUrl: d.music || null,
            source:   'ruhend-scraper',
        }
    } catch (e) { console.error('[downloader] ruhend ttdl failed:', e.message); return null }
}

async function ruhendYtMp3(url) {
    const lib = getRuhend()
    if (!lib?.ytmp3) return null
    try {
        const d = await lib.ytmp3(url)
        return d?.audio ? d : null
    } catch (e) { console.error('[downloader] ruhend ytmp3 failed:', e.message); return null }
}

async function ruhendYtMp4(url) {
    const lib = getRuhend()
    if (!lib?.ytmp4) return null
    try {
        const d = await lib.ytmp4(url)
        return d?.video ? d : null
    } catch (e) { console.error('[downloader] ruhend ytmp4 failed:', e.message); return null }
}

// Savage APIs — hosted YouTube extraction (KeepVid-style endpoint). Runs
// server-side on their infra, not this host, so it isn't subject to the
// same datacenter-IP blocking yt-dlp hits. Silently skipped if no key set.
async function savageYtVideo(query) {
    if (!config.savageApiKey) return null
    try {
        const res = await axios.get(`${config.savageApiBase}/downloader/KeepVid`, {
            params: { apikey: config.savageApiKey, q: query },
            timeout: 25_000,
        })
        const d = res.data
        if (!d?.success) return null
        const formats = Array.isArray(d.video_formats) ? d.video_formats : []
        const best = formats.find(f => f?.url) || formats[0]
        if (!best?.url) {
            console.error('[downloader] Savage API returned no usable video URL:', JSON.stringify(formats[0] || {}))
            return null
        }
        return { title: d.title, uploader: d.uploader, videoUrl: best.url, source: 'Savage API' }
    } catch (e) { console.error('[downloader] Savage API video failed:', e.message); return null }
}

// Savage APIs — hosted YouTube audio extraction (/music/Audioverse).
async function savageYtAudio(query) {
    if (!config.savageApiKey) return null
    try {
        const res = await axios.get(`${config.savageApiBase}/music/Audioverse`, {
            params: { apikey: config.savageApiKey, q: query },
            timeout: 25_000,
        })
        const d = res.data
        if (!d?.success) return null
        const formats = Array.isArray(d.audio) ? d.audio : []
        const best = formats.find(f => f?.url) || formats[0]
        if (!best?.url) {
            console.error('[downloader] Savage API returned no usable audio URL:', JSON.stringify(formats[0] || {}))
            return null
        }
        return { title: d.title, artist: d.artist, audioUrl: best.url, source: 'Savage API' }
    } catch (e) { console.error('[downloader] Savage API audio failed:', e.message); return null }
}

// @vreden/youtube_scraper — a thin client for Vreden's own hosted API, same
// risk category as Savage (someone else's server can go down too). Kept as
// a LAST-resort tier, tried only after local yt-dlp and the direct-URL
// method both fail — never a replacement for the self-contained methods
// above, just one more free attempt before giving up entirely.
async function vredenYtAudio(url) {
    try {
        const { ytmp3 } = require('@vreden/youtube_scraper')
        const result = await ytmp3(url)
        if (!result?.status || !result?.download?.url) return null
        return { audioUrl: result.download.url, title: result.metadata?.title || null }
    } catch (e) { console.error('[downloader] Vreden audio failed:', e.message); return null }
}

// ── Own APK scraper — REMOVED ────────────────────────────────────────────
// Previously used the "apkmirror-client" npm package here. Removed: the
// version pinned in package.json didn't exist at all (npm install failure
// took the whole bot offline), and the package's real latest version is 8
// years old and abandoned — it likely doesn't work against today's
// APKMirror site regardless. See the comment on savageApk() below.

// APK search/download via Savage's API (/downloader/dlapk). This is
// currently the ONLY path — a previous attempt to scrape APKMirror directly
// via the "apkmirror-client" npm package was reverted: that package turned
// out to not actually exist at the version I'd guessed, which broke `npm
// install` for the ENTIRE bot (not just this one feature) and took it
// offline. Even the real published version of that package is 8 years old
// and abandoned, so it likely wouldn't have worked against today's
// APKMirror site anyway. A proper self-hosted APK search needs to be built
// and verified against the live site before it's added back — not guessed
// at again.
async function savageApk(query, index) {
    if (!config.savageApiKey) return { error: 'No Savage API key configured' }
    try {
        const res = await axios.get(`${config.savageApiBase}/downloader/dlapk`, {
            params: { apikey: config.savageApiKey, query, index: index || 1 },
            timeout: 30_000,
            validateStatus: () => true,
        })
        const d = res.data
        if (res.status !== 200) {
            return { error: `HTTP ${res.status}: ${JSON.stringify(d).slice(0, 200)}` }
        }
        if (!d?.success) {
            return { error: d?.message || d?.error || `unsuccessful — ${JSON.stringify(d).slice(0, 200)}` }
        }
        // Response shape isn't documented beyond `success` — check the
        // common field names defensively, same as savageYtVideo/Audio above.
        const result = d.result || d.data || d
        const dlUrl = result.url || result.download_url || result.link || result.dlUrl
        if (!dlUrl) {
            return { error: `no download URL in response — ${JSON.stringify(d).slice(0, 200)}` }
        }
        return {
            name: result.name || result.title || result.appName || query,
            version: result.version || null,
            size: result.size || result.filesize || null,
            downloadUrl: dlUrl,
        }
    } catch (e) { return { error: e.message } }
}

async function downloadApk(sock, from, query, index, msg) {
    if (!query) return sock.sendMessage(from, { text: fmt.usage('apk', '<app name> [result index]') }, { quoted: msg })
    if (!config.savageApiKey) {
        return sock.sendMessage(from, { text: fmt.box('APK DOWNLOAD', [`❌ No Savage API key configured, and no other provider is wired up right now`]) }, { quoted: msg })
    }
    await fmt.react(sock, msg, '⏳')
    const apk = await savageApk(query, index)
    if (apk.error) {
        console.error('[downloader] APK download failed:', apk.error)
        return sock.sendMessage(from, {
            text: fmt.box('APK DOWNLOAD FAILED', [`❌ ${apk.error}`])
        }, { quoted: msg })
    }
    try {
        const buf = Buffer.from((await axios.get(apk.downloadUrl, { responseType: 'arraybuffer', timeout: 120_000 })).data)
        const filename = `${sanitizeFilename(apk.name)}.apk`
        await sock.sendMessage(from, {
            document: buf,
            mimetype: 'application/vnd.android.package-archive',
            fileName: filename,
        }, { quoted: msg })
        await fmt.react(sock, msg, '✅')
    } catch (e) {
        await sock.sendMessage(from, { text: fmt.box('APK DOWNLOAD FAILED', [`❌ ${e.message}`]) }, { quoted: msg })
    }
}

async function ruhendInstagram(url) {
    const lib = getRuhend()
    if (!lib?.igdl) return null
    try {
        const res = await lib.igdl(url)
        const first = res?.data?.[0]
        return first?.url || null
    } catch (e) { console.error('[downloader] ruhend igdl failed:', e.message); return null }
}

async function ruhendFacebook(url) {
    const lib = getRuhend()
    if (!lib?.fbdl) return null
    try {
        const res = await lib.fbdl(url)
        const first = res?.data?.[0]
        return first?.url || res?.data?.url || null
    } catch (e) { console.error('[downloader] ruhend fbdl failed:', e.message); return null }
}

const COBALT_HOSTS = [
    'https://api.cobalt.tools',
    'https://cobalt.api.timelessnesses.me',
    'https://cobalt.ayo.tf',
    'https://cobalt.catvibers.me',
    'https://cobalt.lunar.icu',
    'https://co.wuk.sh',
]

// Nexray ytplay: one call that searches YouTube for the phrase AND returns an
// MP3 link for the top hit. Replaces the youtube-sr search (which crashes on
// some queries) and the separate converter step. NOTE: this endpoint can be
// slow (~100 s seen in testing), so the timeout is generous.
async function nexrayYtPlay(query) {
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const res = await axios.get('https://api.nexray.eu.cc/downloader/ytplay', {
                params: { q: query },
                timeout: 45_000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
                    'Accept': 'application/json, text/plain, */*',
                },
            })
            const r = res.data?.result
            const dl = r?.url || r?.download_url
            if (!res.data?.status || !dl) return null
            return { url: dl, title: r.title || query, secs: Number(r.seconds || r.duration) || 0, id: r.id || null }
        } catch (e) {
            const code = e.response?.status
            console.error(`[downloader] Nexray ytplay attempt ${attempt} failed:`, code ? `HTTP ${code}` : e.message)
            // 524/502/503/504 = their server timed out or hiccuped; a second try can
            // hit a result they already finished converting. Other errors: give up.
            const retryable = !code || code === 524 || code === 502 || code === 503 || code === 504
            if (!retryable || attempt === 2) return null
        }
    }
    return null
}

// Nexray Spotify:
//   link  → GET /downloader/spotify?url=<spotify link>
//   words → GET /downloader/spotifyplay?q=<song name>
// result: { title, artist, duration, thumbnail, popularity, album, release_at, url, download_url }
async function nexraySpotify(input) {
    const isLink = /spotify\.(com|link)/i.test(input)
    let url = input
    if (isLink && !/open\.spotify\.com/.test(input)) { try { url = await resolveShortUrl(input) } catch {} }
    const ep = isLink ? '/downloader/spotify' : '/downloader/spotifyplay'
    const params = isLink ? { url } : { q: input }
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const res = await axios.get('https://api.nexray.eu.cc' + ep, {
                params, timeout: 60_000,
                headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36', 'Accept': 'application/json, text/plain, */*' },
            })
            const r = res.data?.result
            const dl = r?.download_url || (r?.url && !/open\.spotify\.com/.test(r.url) ? r.url : null)
            if (!res.data?.status || !dl) return null
            return { ...r, dl }
        } catch (e) {
            const code = e.response?.status
            console.error(`[downloader] Nexray spotify attempt ${attempt} failed:`, code ? `HTTP ${code}` : e.message)
            const retryable = !code || [524, 502, 503, 504].includes(code)
            if (!retryable || attempt === 2) return null
        }
    }
    return null
}


// ── Extra Nexray audio sources for .play (tried in order after the main path) ──
// Each tries one endpoint; returns an audio Buffer or null. All errors are logged.
async function nexrayExtraAudio(yt, q) {
    const nx = require('../lib/nexray')
    const tries = [
        ['v1/ytmp3',   () => nx.call('/downloader/v1/ytmp3', { params: { url: yt.url }, timeout: 60_000 })],
        ['savetube',   () => nx.call('/downloader/savetube', { params: { url: yt.url, quality: 'mp3' }, timeout: 60_000 })],
        ['spotifyplay',() => nx.call('/downloader/spotifyplay', { params: { q: (yt.title && !/^https?:/.test(yt.title) ? yt.title : q) }, timeout: 75_000 })],
        ['ytplay',     () => nx.call('/downloader/ytplay', { params: { q: (yt.title && !/^https?:/.test(yt.title) ? yt.title : q) }, timeout: 75_000 })],
        ['ytmp4-360',  () => nx.call('/downloader/ytmp4', { params: { url: yt.url, resolusi: '360' }, timeout: 60_000 }), true],
    ]
    for (const [name, run, isVideo] of tries) {
        try {
            const r = await run()
            let buf = null
            if (r.type === 'binary') buf = r.buf
            else if (r.type === 'json' && r.json?.status !== false) {
                const res = r.json?.result || {}
                const link = res.download_url || res.downloadUrl || res.url || res.link || res.audio || nx.pickUrl(r.json)
                if (link && !/open\.spotify\.com/.test(link)) buf = await withRetry(() => toBuffer(link, { label: 'Nexray ' + name, timeoutMs: 120_000 }), 2)
            }
            if (!buf) { console.error(`[downloader] play fallback ${name}: no link`); continue }
            if (isVideo || !looksLikeAudio(buf)) {
                if (validateMedia(buf, 'video') && !looksLikeAudio(buf)) buf = await convertVideoBufferToAudio(buf)
                else if (!looksLikeAudio(buf)) { console.error(`[downloader] play fallback ${name}: not audio`); continue }
            }
            console.log(`[downloader] play fallback ${name} OK`)
            return buf
        } catch (e) { console.error(`[downloader] play fallback ${name} failed:`, e.message) }
    }
    return null
}

// Strict audio check (real MP3 / M4A / OGG / WebM signatures only). Unlike
// validateMedia(), this has no "accept anything" fallback, so an HTML error
// page from a dead link can never be sent as a song.
function looksLikeAudio(buf) {
    if (!buf || buf.length < 2000) return false
    return (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33)           // ID3
        || (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0)                      // MPEG sync
        || (buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79)            // ftyp (m4a)
        || (buf[0] === 0x4F && buf[1] === 0x67 && buf[2] === 0x67)            // OGG
        || (buf[0] === 0x1A && buf[1] === 0x45)                               // WebM/EBML
}

// Downloads the MP3 link that ytplay returned. Retries on 404 (the file may
// not be ready yet) and logs what the server actually said, so a failure is
// diagnosable instead of just "HTTP 404".
async function fetchYtPlayFile(url) {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
        'Accept': '*/*',
    }
    let lastStatus = null
    for (let attempt = 1; attempt <= 3; attempt++) {
        const res = await axios.get(url, {
            headers,
            timeout: 120_000,
            responseType: 'arraybuffer',
            maxRedirects: 5,
            maxContentLength: MAX_BYTES,
            maxBodyLength: MAX_BYTES,
            validateStatus: () => true,
        })
        const buf = Buffer.from(res.data)
        if (res.status >= 200 && res.status < 300) return buf
        lastStatus = res.status
        const snippet = buf.slice(0, 200).toString('utf8').replace(/\s+/g, ' ')
        console.error(`[downloader] ytplay link attempt ${attempt}: HTTP ${res.status} type=${res.headers?.['content-type']} host=${new URL(url).host} body="${snippet}"`)
        if (res.status !== 404) break
        await new Promise(r => setTimeout(r, 4000))
    }
    throw new Error(`ytplay link returned HTTP ${lastStatus}`)
}

// Nexray ytmp3: takes a YouTube link, answers in about a second with a direct
// MP3 link. Retried once on timeouts / 5xx.
async function nexrayYtMp3(videoUrl) {
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const res = await axios.get('https://api.nexray.eu.cc/downloader/ytmp3', {
                params: { url: videoUrl },
                timeout: 60_000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
                    'Accept': 'application/json, text/plain, */*',
                },
            })
            const r = res.data?.result
            if (!res.data?.status || !r?.url) return null
            return { url: r.url, title: r.title || null, filesize: Number(r.filesize) || 0 }
        } catch (e) {
            const code = e.response?.status
            console.error(`[downloader] Nexray ytmp3 attempt ${attempt} failed:`, code ? `HTTP ${code}` : e.message)
            const retryable = !code || code === 502 || code === 503 || code === 504 || code === 524
            if (!retryable || attempt === 2) return null
        }
    }
    return null
}

// Nexray ytmp4 v1: takes a YouTube link + resolution, returns a direct MP4 link.
// Endpoint: https://api.nexray.eu.cc/downloader/v1/ytmp4?url=<url>&resolusi=1080
async function nexrayYtMp4(videoUrl, resolusi = '1080') {
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const res = await axios.get('https://api.nexray.eu.cc/downloader/v1/ytmp4', {
                params: { url: videoUrl, resolusi },
                timeout: 120_000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
                    'Accept': 'application/json, text/plain, */*',
                },
            })
            const r = res.data?.result
            if (!res.data?.status || !r?.url) return null
            return {
                url:      r.url,
                title:    r.title || null,
                quality:  r.quality || `${resolusi}p`,
                duration: Number(r.duration) || 0,
            }
        } catch (e) {
            const code = e.response?.status
            console.error(`[downloader] Nexray ytmp4 attempt ${attempt} failed:`, code ? `HTTP ${code}` : e.message)
            const retryable = !code || code === 502 || code === 503 || code === 504 || code === 524
            if (!retryable || attempt === 2) return null
        }
    }
    return null
}


// ── Nexray video ladder: several endpoints × lower resolutions. 1080p often times
// out or gets 403 on the file link; 720/360 are far more reliable and plenty for WhatsApp.
async function nexrayVideoLadder(videoUrl, title, reasons = []) {
    const nx = require('../lib/nexray')
    const one = async (name, path, params) => {
        try {
            const r = await nx.call(path, { params, timeout: 70_000 })
            let buf = null
            if (r.type === 'binary') buf = r.buf
            else if (r.type === 'json') {
                if (r.json?.status === false || r.status >= 400) throw new Error(`API ${r.status}: ${nx.cleanErr(r.json) || 'error'}`)
                const res = r.json?.result || {}
                const link = res.url || res.download_url || res.downloadUrl || res.link || res.video || nx.pickUrl(r.json)
                if (!link) throw new Error('no link in reply')
                // Some links 403 for the default client — retry with plain headers, then browser-like ones.
                const hdrs = [{}, { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.youtube.com/' }, { 'User-Agent': 'curl/8.4.0', Accept: '*/*' }]
                let lastErr
                for (const h of hdrs) {
                    try { buf = await toBuffer(link, { headers: h, label: 'Nexray ' + name, timeoutMs: 120_000 }); break } catch (e) { lastErr = e }
                }
                if (!buf) throw lastErr || new Error('file download failed')
            } else throw new Error(`HTTP ${r.status} ${r.raw || ''}`.slice(0, 80))
            if (!buf || !validateMedia(buf, 'video')) throw new Error('not a valid video file')
            console.log(`[downloader] video ladder ${name} OK (${(buf.length / 1048576).toFixed(1)} MB)`)
            return { buf, quality: (name.match(/(\d+)/) || [])[1] ? name.match(/(\d+)/)[1] + 'p' : '' }
        } catch (e) {
            const why = String(e.message || e).replace(/\s+/g, ' ').slice(0, 90)
            console.error(`[downloader] video ladder ${name} failed:`, why)
            reasons.push(`${name}: ${why}`)
            throw e
        }
    }
    // Round 1: three endpoints at 720p IN PARALLEL — first good file wins.
    // Round 2: same at 360p (smaller, faster). Round 3: search by title.
    const rounds = [
        [['savetube 720', '/downloader/savetube', { url: videoUrl, quality: '720' }], ['v1/ytmp4 720', '/downloader/v1/ytmp4', { url: videoUrl, resolusi: '720' }], ['ytmp4 720', '/downloader/ytmp4', { url: videoUrl, resolusi: '720' }]],
        [['savetube 360', '/downloader/savetube', { url: videoUrl, quality: '360' }], ['v1/ytmp4 360', '/downloader/v1/ytmp4', { url: videoUrl, resolusi: '360' }], ['ytmp4 360', '/downloader/ytmp4', { url: videoUrl, resolusi: '360' }]],
    ]
    if (title && !/^https?:/.test(title)) rounds.push([['ytplayvid', '/downloader/ytplayvid', { q: title }]])
    for (const round of rounds) {
        try { return await Promise.any(round.map(([n, pth, prm]) => one(n, pth, prm))) } catch {}
    }
    return null
}

// ── Video → audio conversion ────────────────────────────────────────────────
// The .play pipeline deliberately reuses the WORKING Nexray v1/ytmp4 video
// endpoint, then converts the downloaded MP4 to a real MP3 locally with
// ffmpeg. ffmpeg comes from the `ffmpeg-static` npm package (auto-installed,
// per-OS binary); a system ffmpeg on PATH is used as fallback.
let _ffmpegPath = null
function getFfmpegPath() {
    if (_ffmpegPath !== null) return _ffmpegPath
    _ffmpegPath = false
    try {
        const p = require('ffmpeg-static')
        if (p && fs.existsSync(p)) _ffmpegPath = p
    } catch {}
    if (!_ffmpegPath) {
        try {
            const sys = require('child_process').execSync('command -v ffmpeg', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
            if (sys) _ffmpegPath = sys
        } catch {}
    }
    if (!_ffmpegPath) console.error('[downloader] ffmpeg not found — run: npm i ffmpeg-static')
    return _ffmpegPath
}

function runFfmpeg(args, timeoutMs = 300_000) {
    const ff = getFfmpegPath()
    if (!ff) return Promise.reject(new Error('ffmpeg is not installed — run: npm i ffmpeg-static'))
    return new Promise((resolve, reject) => {
        require('child_process').execFile(ff, args, { timeout: timeoutMs }, (err, _stdout, stderr) => {
            if (err) reject(new Error(`ffmpeg failed: ${(stderr || err.message).slice(-300)}`))
            else resolve()
        })
    })
}

// Converts a downloaded MP4 buffer to an audio buffer. MP3 (libmp3lame) is
// preferred; if that encoder is missing, M4A/AAC is used instead — ffmpeg's
// built-in aac encoder is always present. Temp files live in DL_TMP_DIR and
// are always cleaned up.
async function convertVideoBufferToAudio(videoBuf) {
    const stamp  = `play-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const tmpIn  = path.join(DL_TMP_DIR, `${stamp}.mp4`)
    const tmpMp3 = path.join(DL_TMP_DIR, `${stamp}.mp3`)
    const tmpM4a = path.join(DL_TMP_DIR, `${stamp}.m4a`)
    try {
        fs.writeFileSync(tmpIn, videoBuf)
        try {
            await runFfmpeg(['-y', '-i', tmpIn, '-vn', '-c:a', 'libmp3lame', '-q:a', '4', tmpMp3])
            const buf = fs.readFileSync(tmpMp3)
            if (looksLikeAudio(buf)) return buf
            console.error('[downloader] ffmpeg MP3 output failed audio check, trying M4A')
        } catch (e) { console.error('[downloader] MP3 encode failed, falling back to M4A:', e.message) }
        await runFfmpeg(['-y', '-i', tmpIn, '-vn', '-c:a', 'aac', '-b:a', '128k', tmpM4a])
        const buf = fs.readFileSync(tmpM4a)
        if (!looksLikeAudio(buf)) throw new Error('conversion produced no valid audio')
        return buf
    } finally {
        for (const f of [tmpIn, tmpMp3, tmpM4a]) { try { fs.unlinkSync(f) } catch {} }
    }
}

async function withRetry(fn, attempts = 3, baseDelayMs = 1500) {
    let lastErr
    for (let i = 0; i < attempts; i++) {
        try { return await fn() }
        catch (e) {
            lastErr = e
            if (i < attempts - 1) await sleep(baseDelayMs * (i + 1))
        }
    }
    throw lastErr
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function makeId() { return `dl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}` }

function fmtDur(secs) {
    if (!secs) return '?:??'
    const s = Math.round(Number(secs))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    return h > 0
        ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`
        : `${m}:${String(sec).padStart(2,'0')}`
}

function fmtSize(bytes) {
    if (!bytes) return ''
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

async function toBuffer(url, opts = {}) {
    const { headers = {}, timeoutMs = 90_000, label = '' } = opts
    if (!url || typeof url !== 'string') throw new Error('Invalid URL')

    let res
    try {
        res = await axios.get(url, {
            headers:         { 'User-Agent': UA, ...headers },
            timeout:         timeoutMs,
            responseType:    'arraybuffer',
            maxRedirects:    5,
            maxContentLength: MAX_BYTES,
            maxBodyLength:    MAX_BYTES,
            validateStatus:  () => true,
        })
    } catch (e) {
        // e.g. DNS failure, timeout, or size limit exceeded
        throw new Error(`${label || safeHost(url)} request failed — ${e.message}`)
    }

    if (res.status < 200 || res.status >= 300) {
        throw new Error(`${label || safeHost(url)} returned HTTP ${res.status}`)
    }

    const buf = Buffer.from(res.data)
    if (buf.length < MIN_BYTES)  throw new Error(`File too small (${buf.length} bytes) — likely an error page`)
    if (buf.length > MAX_BYTES)  throw new Error(`File too large: ${fmtSize(buf.length)} (limit ${fmtSize(MAX_BYTES)})`)
    return buf
}

function safeHost(url) {
    try { return new URL(url).hostname } catch { return 'download' }
}

function validateMedia(buf, type = 'audio') {
    if (!buf || buf.length < MIN_BYTES) return false
    // MP3: ID3 tag or MPEG sync
    if (type === 'audio') {
        return buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33  // ID3
            || buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0              // MPEG sync
            || buf[0] === 0x66 && buf[1] === 0x74 && buf[2] === 0x79    // ftyp (m4a)
            || buf[0] === 0x4F && buf[1] === 0x67 && buf[2] === 0x67    // OGG
            || true // accept if large enough (covers webm wrapped MP3)
    }
    // MP4: ftyp box
    if (type === 'video') {
        const magic = buf.slice(4, 8).toString('ascii')
        return magic === 'ftyp' || magic === 'mdat' || magic === 'moov'
            || buf[0] === 0x1A && buf[1] === 0x45  // WebM/MKV
            || buf.length > 100_000  // accept large buffer as likely valid video
    }
    return true
}

function cleanTmp(prefix) {
    try {
        fs.readdirSync(os.tmpdir())
            .filter(f => f.startsWith(prefix))
            .forEach(f => { try { fs.unlinkSync(path.join(os.tmpdir(), f)) } catch (e) { console.error("[downloader]", e.message) } })
    } catch (e) { console.error("[downloader]", e.message) }
}

let _ytdlpOk = null  // cache availability check
let _ytdlpUpgradeAttempted = false  // only self-upgrade once per process

// Installs to ~/.local/bin instead of /usr/local/bin (writable without root)
const YTDLP_DIR = path.join(os.homedir(), '.local', 'bin')
const YTDLP_BIN = path.join(YTDLP_DIR, 'yt-dlp')
try { fs.mkdirSync(YTDLP_DIR, { recursive: true }) } catch (e) { console.error('[downloader]', e.message) }

// Puts YTDLP_DIR on PATH so a bare `yt-dlp` resolves
function ytdlpExecOpts(extra = {}) {
    return { ...extra, env: { ...process.env, PATH: `${YTDLP_DIR}:${process.env.PATH || ''}` } }
}

async function installYtdlp() {
    const methods = [
        // Method 1: pip3 --user (installs to ~/.local/bin, no root needed)
        `pip3 install -q --user yt-dlp --break-system-packages 2>/dev/null || pip3 install -q --user yt-dlp`,
        // Method 2: pip --user fallback
        `pip install -q --user yt-dlp --break-system-packages 2>/dev/null || pip install -q --user yt-dlp`,
        // Method 3: download binary directly from GitHub into ~/.local/bin
        [
            `curl -sL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp`,
            `-o "${YTDLP_BIN}"`,
            `&& chmod a+rx "${YTDLP_BIN}"`,
        ].join(' '),
        // Method 4: wget fallback into ~/.local/bin
        [
            `wget -qO "${YTDLP_BIN}"`,
            `https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp`,
            `&& chmod a+rx "${YTDLP_BIN}"`,
        ].join(' '),
    ]

    for (const cmd of methods) {
        const ok = await new Promise(r =>
            exec(cmd, ytdlpExecOpts({ timeout: 90_000 }), e => r(!e))
        )
        if (ok) {
            // Verify it actually runs now (with the same PATH override)
            const works = await new Promise(r => exec('yt-dlp --version', ytdlpExecOpts(), e => r(!e)))
            if (works) {
                console.log('✅  yt-dlp installed successfully to ' + YTDLP_DIR)
                return true
            }
        }
    }
    return false
}

async function hasYtdlp() {
    if (_ytdlpOk !== null) return _ytdlpOk
    // Check if already installed (either globally on PATH, or in ~/.local/bin)
    const found = await new Promise(r => exec('yt-dlp --version', ytdlpExecOpts(), e => r(!e)))
    if (found) { _ytdlpOk = true; return true }
    // Try auto-install (runs once, result is cached)
    console.log('⚙️   yt-dlp not found — attempting auto-install...')
    _ytdlpOk = await installYtdlp()
    if (!_ytdlpOk) console.log('⚠️   yt-dlp auto-install failed — social media downloads may be limited')
    return _ytdlpOk
}

async function ensureYtdlp() {
    hasYtdlp().catch(() => {})
}

async function upgradeYtdlp() {
    if (_ytdlpUpgradeAttempted) return false
    _ytdlpUpgradeAttempted = true
    console.log('⚙️   yt-dlp got a 403 from YouTube — this almost always means the installed build is stale (YouTube changes its extraction scheme often). Attempting a one-time upgrade...')
    const methods = [
        `pip3 install -q --user --upgrade yt-dlp --break-system-packages 2>/dev/null || pip3 install -q --user --upgrade yt-dlp`,
        `pip install -q --user --upgrade yt-dlp --break-system-packages 2>/dev/null || pip install -q --user --upgrade yt-dlp`,
        [
            `curl -sL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp`,
            `-o "${YTDLP_BIN}"`,
            `&& chmod a+rx "${YTDLP_BIN}"`,
        ].join(' '),
        [
            `wget -qO "${YTDLP_BIN}"`,
            `https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp`,
            `&& chmod a+rx "${YTDLP_BIN}"`,
        ].join(' '),
    ]
    for (const cmd of methods) {
        const ok = await new Promise(r => exec(cmd, ytdlpExecOpts({ timeout: 90_000 }), e => r(!e)))
        if (ok) {
            const works = await new Promise(r => exec('yt-dlp --version', ytdlpExecOpts(), e => r(!e)))
            if (works) { console.log('✅  yt-dlp upgraded successfully — retrying the download'); return true }
        }
    }
    console.log('⚠️   yt-dlp upgrade attempt failed — the 403 is likely something else (region/age-restricted video, IP block, etc.)')
    return false
}

// Optional: point YTDLP_COOKIES_FILE at a cookies.txt (Netscape format,
// exported from a real signed-in YouTube session — see yt-dlp's FAQ on
// exporting cookies) to raise trust with YouTube's bot-detection. Entirely
// optional; everything below works without it, just less reliably on
// datacenter/hosting IPs.
const YTDLP_COOKIES_FILE = process.env.YTDLP_COOKIES_FILE || ''
const cookiesArg = (YTDLP_COOKIES_FILE && fs.existsSync(YTDLP_COOKIES_FILE)) ? `--cookies "${YTDLP_COOKIES_FILE}"` : ''

// YouTube's bot-detection is an active arms race — which player client
// spoof works (if any) shifts over time and isn't the same for every
// video/IP. Trying a couple of options in sequence costs nothing when the
// first one fails and meaningfully improves the odds one of them works.
const YT_CLIENT_ATTEMPTS = ['default', 'tv,web_safari', 'web']

async function ytdlpDownload(url, audioOnly, _retrying = false, clientIdx = 0) {
    const id  = makeId()
    const tmp = path.join(DL_TMP_DIR, id)

    const fmtArg = audioOnly
        ? `-x --audio-format mp3 --audio-quality 0`
        : `-f "bestvideo[height<=720]+bestaudio/best[height<=720]/best" --merge-output-format mp4`

    const client = YT_CLIENT_ATTEMPTS[clientIdx]
  const _t0 = Date.now()

    try {
        await new Promise((resolve, reject) => {
            exec(
                `yt-dlp ${fmtArg} --js-runtimes node --no-playlist --retries 3 --extractor-args "youtube:player_client=${client}" ${cookiesArg} --sleep-requests 1 --limit-rate 3M -o "${tmp}.%(ext)s" --no-warnings "${url}"`,
                ytdlpExecOpts({ maxBuffer: 200 * 1024 * 1024, timeout: 150_000 }),
                (err, _, stderr) => { console.log('[ytdlp]', client, ((Date.now()-_t0)/1000).toFixed(1)+'s', err ? 'FAIL' : 'ok', String(stderr||'').split('\n').filter(l=>/WARNING|ERROR/.test(l)).slice(0,4).join(' | ').slice(0,400)); return err ? reject(new Error((stderr || err.message).split('\n')[0])) : resolve() }
            )
        })
    } catch (e) {
        // "Sign in to confirm you're not a bot" — try the next player
        // client spoof before giving up, since which one YouTube accepts
        // varies by video/IP and changes over time.
        if (/sign in to confirm|page needs to be reloaded/i.test(e.message) && clientIdx < YT_CLIENT_ATTEMPTS.length - 1) {
            return ytdlpDownload(url, audioOnly, _retrying, clientIdx + 1)
        }
        // A 403 from yt-dlp specifically (vs. a network/timeout error) is
        // almost always a stale build — YouTube changes its extraction
        // scheme often enough that yt-dlp needs frequent updates. Try
        // upgrading once per process lifetime and retry the exact same
        // download before surfacing an error to the user.
        if (!_retrying && /403|forbidden/i.test(e.message)) {
            const upgraded = await upgradeYtdlp()
            if (upgraded) return ytdlpDownload(url, audioOnly, true)
        }
        if (/sign in to confirm/i.test(e.message)) {
            throw new Error(
                `${e.message} — YouTube is bot-checking this hosting IP. This is a YouTube-side, IP-reputation thing, not a bug: ` +
                (cookiesArg ? 'even the configured cookies file didn\'t clear it this time.' : 'set YTDLP_COOKIES_FILE to a real signed-in YouTube cookies.txt to improve odds — see yt-dlp\'s cookie-export FAQ.')
            )
        }
        throw e
    }

    const ext   = audioOnly ? 'mp3' : 'mp4'
    const exact = `${tmp}.${ext}`
    const found = fs.existsSync(exact) ? exact
        : fs.readdirSync(DL_TMP_DIR).map(f => path.join(DL_TMP_DIR, f)).find(f => f.startsWith(tmp))

    if (!found) throw new Error('yt-dlp did not produce an output file')

    const buf = fs.readFileSync(found)
    cleanTmp(id)
    return buf
}

async function cobaltFetch(mediaUrl, audioOnly = false) {
    const body = JSON.stringify({
        url:           mediaUrl.trim(),
        downloadMode:  audioOnly ? 'audio' : 'auto',
        audioFormat:   'mp3',
        filenameStyle: 'basic',
    })

    const errors = []

    for (const host of COBALT_HOSTS) {
        try {
            const res = await httpRequest(host, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
                body,
                signal:  AbortSignal.timeout(22_000),
            })
            if (!res.ok) { errors.push(`${host} HTTP ${res.status}`); continue }

            const data = await res.json()
            if (data.status === 'error') { errors.push(`${host}: ${data.error?.code || 'API error'}`); continue }

            // New format: tunnel / redirect / stream
            const dlUrl = data.url || data.tunnel
            if (dlUrl) return dlUrl

            // Picker (Instagram/Twitter carousel)
            if (data.status === 'picker' && data.picker?.[0]?.url) return data.picker[0].url

        } catch (e) { errors.push(`${host}: ${e.message}`) }
    }

    throw new Error(`Cobalt unavailable — ${errors.slice(-2).join(' | ')}`)
}

const SAAVN_HOSTS = [
    'https://saavn.dev',
    'https://jiosaavn.dev',
    'https://jiosaavn-api.vercel.app',
]

async function saavnSearch(query) {
    // Build multiple query variants to try — widens the search net
    const ql = query.toLowerCase().trim()
    const variants = [
        query,
        // strip common words that confuse JioSaavn
        ql.replace(/\b(official|audio|video|lyrics|hd|hq|ft\.?|feat\.?|remix)\b/gi, '').trim(),
        // try just the first 3 words
        ql.split(/\s+/).slice(0, 3).join(' '),
    ].filter((v, i, a) => v && a.indexOf(v) === i)  // unique, non-empty

    for (const q of variants) {
        for (const host of SAAVN_HOSTS) {
            try {
                const url = `${host}/api/search/songs?query=${encodeURIComponent(q)}&limit=10`
                const res  = await httpRequest(url, { signal: AbortSignal.timeout(12_000) })
                if (!res.ok) continue
                const data  = await res.json()
                const songs = data?.data?.results
                if (!songs?.length) continue

                // Smart scoring — prefer exact title matches and shorter durations
                const words = ql.split(/\s+/).filter(w => w.length > 2)
                const scored = songs
                    .filter(s => s.downloadUrl?.length)
                    .map(s => {
                        const title  = (s.name || '').toLowerCase()
                        const artist = (s.artists?.primary?.map(a => a.name).join(' ') || '').toLowerCase()
                        const full   = `${title} ${artist}`
                        let score = 0
                        if (title === ql)             score += 30   // perfect title match
                        if (full.includes(ql))        score += 15
                        if (title.includes(ql))       score += 10
                        if (artist.includes(ql))      score += 5
                        words.forEach(w => {
                            if (title.includes(w))  score += 3
                            if (artist.includes(w)) score += 1
                        })
                        // Slightly prefer shorter songs (more likely to be the right track)
                        const dur = Number(s.duration) || 999
                        if (dur < 300) score += 1
                        return { song: s, score }
                    })
                    .filter(x => x.score > 0)
                    .sort((a, b) => b.score - a.score)

                if (!scored.length) continue
                const { song } = scored[0]

                // Pick highest quality download URL
                const dlUrls = song.downloadUrl || []
                const best   = dlUrls.reduce((a, b) => parseInt(b.quality) > parseInt(a.quality) ? b : a, dlUrls[0])
                if (!best?.url) continue

                return {
                    title:    song.name || query,
                    author:   song.artists?.primary?.map(a => a.name).join(', ') || '',
                    album:    song.album?.name || '',
                    duration: fmtDur(song.duration),
                    secs:     Number(song.duration) || 0,
                    quality:  best.quality ? best.quality + 'kbps' : '',
                    dlUrl:    best.url,
                    image:    song.image?.[2]?.url || song.image?.[1]?.url || null,
                    source:   'JioSaavn',
                }
            } catch (e) { console.error("[downloader]", e.message) }
        }
    }
    return null
}

// YouTube Innertube search — YouTube's OWN internal search API, same client/key
// pair this file already uses for the player endpoint. youtube-sr scrapes the
// HTML search page, which YouTube breaks every few months — that scraper is
// why .play/.video answered "Couldn't find <query>" even for real songs. This
// endpoint is what the YouTube app itself calls, so it keeps working.
async function innertubeSearch(query, opts = {}) {
    const { maxSecs = MAX_MUSIC_SECS, limit = 5 } = opts
    const res = await httpRequest(
        'https://www.youtube.com/youtubei/v1/search?key=AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w',
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'com.google.android.youtube/17.31.35 (Linux; U; Android 11) gzip',
                'X-Youtube-Client-Name': '3',
                'X-Youtube-Client-Version': '17.31.35',
            },
            body: JSON.stringify({
                context: { client: { clientName: 'ANDROID', clientVersion: '17.31.35', androidSdkVersion: 30, hl: 'en', gl: 'US' } },
                query,
            }),
            signal: AbortSignal.timeout(15_000),
        }
    )
    if (!res.ok) throw new Error(`Innertube search HTTP ${res.status}`)
    const data = await res.json()

    // Collect videoRenderer entries anywhere in the response tree
    const found = []
    const walk = (node, depth) => {
        if (!node || typeof node !== 'object' || found.length >= limit || depth > 14) return
        const vr = node.videoRenderer
        if (vr?.videoId) {
            const parts = (vr.lengthText?.simpleText || '').split(':').map(Number)
            const secs = (parts.length >= 2 && parts.every(n => !isNaN(n))) ? parts.reduce((a, n) => a * 60 + n, 0) : 0
            found.push({
                id:     vr.videoId,
                title:  vr.title?.runs?.[0]?.text || query,
                author: vr.ownerText?.runs?.[0]?.text || '',
                secs,
                views:  vr.viewCountText?.simpleText || '',
            })
            return
        }
        for (const k of Object.keys(node)) walk(node[k], depth + 1)
    }
    walk(data, 0)
    if (!found.length) return null

    const valid = found.filter(v => v.secs > 0 && v.secs <= maxSecs)
    const pool  = valid.length ? valid : found.slice(0, 1)
    const v = pool[0]
    return {
        id:       v.id,
        title:    v.title,
        author:   v.author,
        duration: fmtDur(v.secs),
        secs:     v.secs,
        views:    v.views,
        url:      `https://www.youtube.com/watch?v=${v.id}`,
        thumb:    `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
    }
}

// YouTube search by reading the normal results page (over axios, which reaches
// YouTube from this host). Used because the Innertube call above is rejected
// (HTTP 400) and youtube-sr's fetch() cannot connect here. No API key or app
// version involved, so nothing to go out of date.
async function youtubePageSearch(query, opts = {}) {
    const { maxSecs = MAX_MUSIC_SECS, limit = 8 } = opts
    const url = 'https://www.youtube.com/results?' + new URLSearchParams({ search_query: query, sp: 'EgIQAQ==' }).toString()
    const res = await httpRequest(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cookie': 'CONSENT=YES+1; SOCS=CAI',
        },
        signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`results page HTTP ${res.status}`)
    const html = await res.text()
    const marker = 'var ytInitialData = '
    const at = html.indexOf(marker)
    if (at === -1) throw new Error('results page had no ytInitialData (consent or bot-check page?)')
    const from = at + marker.length
    const to = html.indexOf(';</script>', from)
    if (to === -1) throw new Error('results page ytInitialData not terminated')
    const data = JSON.parse(html.slice(from, to))

    const found = []
    const walk = (node, depth) => {
        if (!node || typeof node !== 'object' || found.length >= limit || depth > 16) return
        const vr = node.videoRenderer
        if (vr?.videoId) {
            const parts = (vr.lengthText?.simpleText || '').split(':').map(Number)
            const secs = (parts.length >= 2 && parts.every(n => !isNaN(n))) ? parts.reduce((x, n) => x * 60 + n, 0) : 0
            found.push({
                id:     vr.videoId,
                title:  vr.title?.runs?.[0]?.text || query,
                author: vr.ownerText?.runs?.[0]?.text || '',
                secs,
                views:  vr.viewCountText?.simpleText || '',
            })
            return
        }
        for (const k of Object.keys(node)) walk(node[k], depth + 1)
    }
    walk(data, 0)
    if (!found.length) throw new Error('results page had no videos')

    const valid = found.filter(v => v.secs > 0 && v.secs <= maxSecs)
    const v = (valid.length ? valid : found.slice(0, 1))[0]
    console.log('[downloader] page search found', v.id, `"${v.title}"`)
    return {
        id:       v.id,
        title:    v.title,
        author:   v.author,
        duration: fmtDur(v.secs),
        secs:     v.secs,
        views:    v.views,
        url:      `https://www.youtube.com/watch?v=${v.id}`,
        thumb:    `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`,
    }
}

async function ytSearch(query, opts = {}) {
    const { maxSecs = MAX_MUSIC_SECS, limit = 5 } = opts
    // 1. Innertube — YouTube's own internal API (primary)
    try {
        const hit = await innertubeSearch(query, { maxSecs, limit })
        if (hit) return hit
    } catch (e) { console.error('[downloader] Innertube search failed:', e.message) }

    // 1b. YouTube results page over axios (works where Innertube / youtube-sr do not)
    try {
        const hit = await youtubePageSearch(query, { maxSecs, limit })
        if (hit) return hit
    } catch (e) { console.error('[downloader] YouTube page search failed:', e.message) }

    // 2. youtube-sr — HTML scraper, breaks whenever YouTube redesigns (fallback)
    try {
        const YT      = require('youtube-sr').default
        const results = await YT.search(query, { limit, type: 'video', safeSearch: false })
        if (!results?.length) return null

        // NOTE: youtube-sr returns `duration` in milliseconds, not seconds
        const valid = results.filter(v => {
            const secs = Math.round((v.duration || 0) / 1000)
            return secs > 0 && secs <= maxSecs
        })

        const pool = valid.length ? valid : results.slice(0, 1)
        const v = pool[0]
        const d = Math.round((v.duration || 0) / 1000)
        return {
            id:       v.id,
            title:    v.title || query,
            author:   v.channel?.name || '',
            duration: fmtDur(d),
            secs:     d,
            views:    v.views ? `${(v.views / 1_000_000).toFixed(1)}M views` : '',
            url:      `https://www.youtube.com/watch?v=${v.id}`,
            thumb:    v.thumbnail?.url || null,
        }
    } catch (e) { console.error('[downloader] ytSearch failed:', e.message); return null }
}

async function ytAudioUrl(videoId) {
    const ytUrl = `https://www.youtube.com/watch?v=${videoId}`

    // ── 1. Cobalt (best — native YT audio extraction) ────────────────────────
    try { return await cobaltFetch(ytUrl, true) } catch (e) { console.error("[downloader]", e.message) }

    // ── 2. YouTube Innertube API (YouTube's own internal player API) ──────────
    //    Returns direct audio stream URLs — no third-party service needed.
    try {
        const body = JSON.stringify({
            context: {
                client: {
                    clientName: 'ANDROID',
                    clientVersion: '17.31.35',
                    androidSdkVersion: 30,
                    hl: 'en', gl: 'US',
                }
            },
            videoId,
        })
        const res = await httpRequest(
            'https://www.youtube.com/youtubei/v1/player?key=AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'com.google.android.youtube/17.31.35 (Linux; U; Android 11) gzip',
                    'X-Youtube-Client-Name': '3',
                    'X-Youtube-Client-Version': '17.31.35',
                },
                body,
                signal: AbortSignal.timeout(15_000),
            }
        )
        if (res.ok) {
            const data = await res.json()
            const adaptive = (data?.streamingData?.adaptiveFormats || [])
                .filter(f => f.mimeType?.startsWith('audio/') && f.url && !f.signatureCipher)
                .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))
            if (adaptive[0]?.url) return adaptive[0].url

            const regular = (data?.streamingData?.formats || [])
                .filter(f => f.url && !f.signatureCipher)
                .sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0))
            if (regular[0]?.url) return regular[0].url
        }
    } catch (e) { console.error("[downloader]", e.message) }

    // ── 3. Free converter APIs (rotated for redundancy) ───────────────────────
    const apis = [
        async () => {
            const r = await httpRequest(
                `https://p.oceansaver.in/ajax/download.php?format=mp3&url=${encodeURIComponent(ytUrl)}&api=`,
                { signal: AbortSignal.timeout(18_000) }
            )
            const d = await r.json()
            return (d?.success && d?.download_url) ? d.download_url : null
        },
        async () => {
            const r = await httpRequest(
                `https://api.fabdl.com/youtube/mp3?url=${encodeURIComponent(ytUrl)}`,
                { signal: AbortSignal.timeout(18_000) }
            )
            const d = await r.json()
            return d?.download_url || null
        },
        async () => {
            const r = await httpRequest(
                `https://yt5s.io/api/ajaxSearch/index`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body:   `q=${encodeURIComponent(ytUrl)}&vt=mp3`,
                    signal: AbortSignal.timeout(18_000),
                }
            )
            const d = await r.json()
            // yt5s returns conversion keys; grab the 128kbps link if available
            const key = Object.keys(d?.links?.mp3 || {})[0]
            return key ? d.links.mp3[key]?.url : null
        },
        async () => {
            // yt1s.io — post-conversion link
            const r = await httpRequest('https://yt1s.io/mates/en/convert', {
                method:  'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body:    `url=${encodeURIComponent(ytUrl)}&q=mp3&vt=mp4`,
                signal:  AbortSignal.timeout(18_000),
            })
            const d = await r.json()
            return d?.kv?.mp3 || null
        },
    ]

    for (const api of apis) {
        try { const u = await api(); if (u) return u } catch (e) { console.error("[downloader]", e.message) }
    }

    return null
}

async function tikwmFetch(tiktokUrl, audioOnly = false) {
    const body = new URLSearchParams({
        url: tiktokUrl.trim(), count: '12', cursor: '0', web: '1', hd: '1'
    })

    const hosts = ['https://www.tikwm.com/api/', 'https://tikwm.com/api/']

    for (const host of hosts) {
        try {
            const res  = await httpRequest(host, {
                method:  'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
                body:    body.toString(),
                signal:  AbortSignal.timeout(20_000),
            })
            if (!res.ok) continue
            const data = await res.json()
            if (data.code !== 0 || !data.data) continue

            const d = data.data
            return {
                title:     d.title || 'TikTok Video',
                author:    d.author?.nickname || '',
                duration:  fmtDur(d.duration),
                secs:      d.duration || 0,
                size:      fmtSize(audioOnly ? d.music_info?.size : (d.size || d.hd_size)),
                videoUrl:  d.play || d.hdplay || d.wmplay,   // play = no watermark on TikWM
                audioUrl:  d.music,
                coverUrl:  d.cover || null,
                source:    'TikWM',
            }
        } catch (e) { console.error("[downloader]", e.message) }
    }
    return null
}

async function tiklyFetch(url) {
    const res = await httpRequest(
        `https://api.tiklydown.eu/api/download?url=${encodeURIComponent(url)}`,
        { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(18_000) }
    )
    if (!res.ok) throw new Error(`tiklydown HTTP ${res.status}`)
    const d = await res.json()
    const videoUrl = d?.video?.noWatermark || d?.video?.watermark
    if (!videoUrl) throw new Error('No video URL from tiklydown')
    return {
        title:    d.title   || 'TikTok Video',
        author:   d.author?.name || '',
        duration: fmtDur(d.duration),
        secs:     d.duration || 0,
        videoUrl,
        audioUrl: d.music?.url || null,
        source:   'TiklyDown',
    }
}

async function igDownload(url) {
    const errors = []

    // ── Provider 1: fastdl.app ────────────────────────────────────────────────
    try {
        const res = await httpRequest('https://fastdl.app/api/convert', {
            method:  'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent':   UA,
                'Origin':       'https://fastdl.app',
                'Referer':      'https://fastdl.app/',
            },
            body:   JSON.stringify({ url }),
            signal: AbortSignal.timeout(22_000),
        })
        if (res.ok) {
            const d = await res.json()
            if (d?.url) return d.url
            if (Array.isArray(d?.urls) && d.urls[0]) return d.urls[0]
        }
        errors.push(`fastdl HTTP ${res.status}`)
    } catch (e) { errors.push(`fastdl: ${e.message}`) }

    // ── Provider 2: snapinsta scrape ──────────────────────────────────────────
    try {
        const form = new URLSearchParams({ q: url, t: '1', lang: 'en' })
        const res  = await httpRequest('https://snapinsta.app/api/ajaxSearch', {
            method:  'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent':   UA,
                'Origin':       'https://snapinsta.app',
                'Referer':      'https://snapinsta.app/',
            },
            body:   form.toString(),
            signal: AbortSignal.timeout(22_000),
        })
        if (res.ok) {
            const d = await res.json()
            if (d?.status === 'ok' && d.data) {
                const mp4 = d.data.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/)
                if (mp4?.[1]) return decodeURIComponent(mp4[1])
            }
        }
        errors.push(`snapinsta HTTP ${res.status}`)
    } catch (e) { errors.push(`snapinsta: ${e.message}`) }

    // ── Provider 3: saveig.app ────────────────────────────────────────────────
    try {
        const res = await httpRequest(
            `https://v3.saveig.app/api/ajaxSearch?q=${encodeURIComponent(url)}&t=1&lang=en`,
            {
                headers: { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest' },
                signal:  AbortSignal.timeout(20_000),
            }
        )
        if (res.ok) {
            const d = await res.json()
            if (d?.status === 'ok' && d.data) {
                const mp4 = d.data.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/)
                if (mp4?.[1]) return decodeURIComponent(mp4[1])
            }
        }
        errors.push(`saveig HTTP ${res.status}`)
    } catch (e) { errors.push(`saveig: ${e.message}`) }

    throw new Error(`All Instagram providers failed: ${errors.join(' | ')}`)
}

async function fbDownload(url) {
    const errors = []

    // ── Provider 1: getfvid.com scrape ────────────────────────────────────────
    try {
        const form = new URLSearchParams({ url })
        const res  = await httpRequest('https://www.getfvid.com/downloader', {
            method:  'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent':   UA,
                'Origin':       'https://www.getfvid.com',
                'Referer':      'https://www.getfvid.com/',
            },
            body:   form.toString(),
            signal: AbortSignal.timeout(25_000),
        })
        if (res.ok) {
            const html = await res.text()
            const hdMatch = html.match(/href="(https:\/\/[^"]+)"[^>]*>\s*(?:HD|High)/i)
            const sdMatch = html.match(/href="(https:\/\/video[^"]+\.mp4[^"]*)"/i)
            const dlUrl   = hdMatch?.[1] || sdMatch?.[1]
            if (dlUrl) return decodeURIComponent(dlUrl)
        }
        errors.push(`getfvid HTTP ${res.status}`)
    } catch (e) { errors.push(`getfvid: ${e.message}`) }

    // ── Provider 2: fdown.net scrape ──────────────────────────────────────────
    try {
        const form = new URLSearchParams({ URLz: url })
        const res  = await httpRequest('https://fdown.net/downloader.php', {
            method:  'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent':   UA,
                'Origin':       'https://fdown.net',
                'Referer':      'https://fdown.net/',
            },
            body:   form.toString(),
            signal: AbortSignal.timeout(25_000),
        })
        if (res.ok) {
            const html    = await res.text()
            const hdMatch = html.match(/href="(https:\/\/[^"]+)"[^>]*>\s*HD\s*</i)
            const sdMatch = html.match(/href="(https:\/\/[^"]+)"[^>]*>\s*SD\s*</i)
            const dlUrl   = hdMatch?.[1] || sdMatch?.[1]
            if (dlUrl) return decodeURIComponent(dlUrl)
        }
        errors.push(`fdown HTTP ${res.status}`)
    } catch (e) { errors.push(`fdown: ${e.message}`) }

    // ── Provider 3: savefrom scrape ───────────────────────────────────────────
    try {
        const form = new URLSearchParams({ sf_url: url, country: 'us' })
        const res  = await httpRequest('https://worker.sf-tools.com/savefrom.php', {
            method:  'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent':   UA,
                'Origin':       'https://en.savefrom.net',
                'Referer':      'https://en.savefrom.net/',
            },
            body:   form.toString(),
            signal: AbortSignal.timeout(25_000),
        })
        if (res.ok) {
            const d = await res.json()
            const links = d?.url || []
            const mp4   = links.find(l => l?.type === 'mp4' || l?.ext === 'mp4')
            if (mp4?.url) return mp4.url
        }
        errors.push(`savefrom HTTP ${res.status}`)
    } catch (e) { errors.push(`savefrom: ${e.message}`) }

    throw new Error(`All Facebook providers failed: ${errors.join(' | ')}`)
}

async function twitterDownload(url) {
    const errors = []

    // ── Provider 1: twitsave.com scrape ───────────────────────────────────────
    try {
        const res = await httpRequest(
            `https://twitsave.com/info?url=${encodeURIComponent(url)}`,
            { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(22_000) }
        )
        if (res.ok) {
            const html   = await res.text()
            // Highest quality first
            const hd     = html.match(/data-url="([^"]+\.mp4[^"]*)"[^>]*>[\s\S]*?Highest Quality/i)
            const any    = html.match(/data-url="([^"]+\.mp4[^"]*)"/i)
            const dlUrl  = hd?.[1] || any?.[1]
            if (dlUrl) return decodeURIComponent(dlUrl)
        }
        errors.push(`twitsave HTTP ${res.status}`)
    } catch (e) { errors.push(`twitsave: ${e.message}`) }

    // ── Provider 2: twittervideodownloader.com ────────────────────────────────
    try {
        const res = await httpRequest('https://twittervideodownloader.com/download', {
            method:  'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent':   UA,
                'Origin':       'https://twittervideodownloader.com',
                'Referer':      'https://twittervideodownloader.com/',
            },
            body:   new URLSearchParams({ tweet: url }).toString(),
            signal: AbortSignal.timeout(22_000),
        })
        if (res.ok) {
            const html  = await res.text()
            const match = html.match(/href="(https:\/\/video\.twimg\.com\/[^"]+\.mp4[^"]*)"/i)
            if (match?.[1]) return decodeURIComponent(match[1])
        }
        errors.push(`twittervd HTTP ${res.status}`)
    } catch (e) { errors.push(`twittervd: ${e.message}`) }

    // ── Provider 3: ssstwitter.com ────────────────────────────────────────────
    try {
        const form = new URLSearchParams({ id: url })
        const res  = await httpRequest('https://ssstwitter.com/', {
            method:  'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent':   UA,
                'Origin':       'https://ssstwitter.com',
                'Referer':      'https://ssstwitter.com/',
            },
            body:   form.toString(),
            signal: AbortSignal.timeout(22_000),
        })
        if (res.ok) {
            const html  = await res.text()
            const match = html.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"[^>]*download/i)
            if (match?.[1]) return decodeURIComponent(match[1])
        }
        errors.push(`ssstwitter HTTP ${res.status}`)
    } catch (e) { errors.push(`ssstwitter: ${e.message}`) }

    throw new Error(`All Twitter providers failed: ${errors.join(' | ')}`)
}

async function spotifyInfo(spotifyUrl) {
    try {
        // oEmbed gives us title + description without any API key
        const res = await httpRequest(
            `https://open.spotify.com/oembed?url=${encodeURIComponent(spotifyUrl)}`,
            { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12_000) }
        )
        if (!res.ok) throw new Error(`Spotify oEmbed HTTP ${res.status}`)
        const data = await res.json()

        // Title is usually "Song Name" and description contains "Artist · Album"
        const title = data.title || ''
        const desc  = (data.description || data.provider_url || '').replace(/·/g, '-')

        return { searchQuery: `${title} ${desc.split('-')[0]}`.trim(), title, image: data.thumbnail_url }
    } catch {
        // Fallback: parse the track ID and build a search query from the URL
        const match = spotifyUrl.match(/track\/([A-Za-z0-9]+)/)
        return match ? { searchQuery: `spotify track ${match[1]}` } : null
    }
}

async function mediaFireLink(mfUrl) {
    const res = await httpRequest(mfUrl, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(15_000),
        redirect: 'follow',
    })
    if (!res.ok) throw new Error(`MediaFire returned HTTP ${res.status}`)
    const html = await res.text()

    // Multiple extraction strategies
    const patterns = [
        /id="downloadButton"[^>]*href="([^"]+)"/i,
        /aria-label="Download file"[^>]*href="([^"]+)"/i,
        /<a[^>]+class="[^"]*btn[^"]*"[^>]*href="(https:\/\/download[^"]+)"/i,
        /href="(https:\/\/download\d*\.mediafire\.com\/[^"]+)"/i,
        /window\.location\.href\s*=\s*["'](https:\/\/[^"']+)["']/i,
    ]

    for (const re of patterns) {
        const m = html.match(re)
        if (m?.[1]) return decodeURIComponent(m[1])
    }

    throw new Error('Could not find MediaFire download link — file may be private or removed')
}

// ── Nexray downloaders (tried FIRST for Facebook / Instagram / TikTok / Twitter) ──
// GET /downloader/<site>?url=<link>. Replies differ per site, so the media is picked out of
// whatever shape comes back: videos (HD first), photo posts / carousels (all pictures).
const nexrayLib = require('../lib/nexray')
const NX_DL = {
    fb:      ['/downloader/facebook', '/downloader/aio'],
    ig:      ['/downloader/instagram', '/downloader/v1/instagram', '/downloader/v2/instagram', '/downloader/aio'],
    tiktok:  ['/downloader/tiktok', '/downloader/aio'],
    twitter: ['/downloader/twitter', '/downloader/aio'],
}
const SKIP_KEYS = /thumb|cover|avatar|profile|icon|poster|preview|logo|favicon|music|audio|sound|wm_|watermark(?!.*no)/i
function collectMedia(json) {
    const found = []
    const isUrl = v => typeof v === 'string' && /^https?:\/\//i.test(v)
    const typeOf = (url, key, hint) => {
        const h = String(hint || '').toLowerCase()
        if (/video|mp4/.test(h)) return 'video'
        if (/image|photo|jpg|jpeg|png|webp/.test(h)) return 'image'
        const clean = url.split('?')[0]
        if (/\.(mp4|mov|webm|m4v|mkv)$/i.test(clean)) return 'video'
        if (/\.(jpe?g|png|webp|heic)$/i.test(clean)) return 'image'
        if (/video|mp4|hd|sd|play|nowm|download/i.test(key)) return 'video'
        if (/image|photo|pic/i.test(key)) return 'image'
        return /(video|mp4|\/v\/|fbcdn.*\.mp4|googlevideo|tiktokcdn|akamaized)/i.test(url) ? 'video' : null
    }
    const walk = (o, key, group, depth) => {
        if (depth > 6 || o == null) return
        if (isUrl(o)) {
            if (SKIP_KEYS.test(key) && !/nowm|no_?watermark/i.test(key)) return
            const t = typeOf(o, key, '')
            if (t) found.push({ url: o, type: t, key, group })
            return
        }
        if (Array.isArray(o)) { o.forEach((x, i) => walk(x, key, group || `${key}#${depth}`, depth + 1)); return }
        if (typeof o === 'object') {
            // item objects like { url, type: 'video'|'image', quality }
            const u = o.url || o.download_url || o.src || o.link
            if (isUrl(u) && (o.type || o.mime || o.extension || o.quality) && !SKIP_KEYS.test(key)) {
                const t = typeOf(u, key, `${o.type || ''} ${o.mime || ''} ${o.extension || ''}`)
                if (t) { found.push({ url: u, type: t, key: key + ':' + (o.quality || o.type || ''), group }); return }
            }
            for (const [k, v] of Object.entries(o)) walk(v, k, group, depth + 1)
        }
    }
    walk(json?.result ?? json?.data ?? json, 'result', null, 0)
    const seen = new Set()
    return found.filter(m => !seen.has(m.url) && seen.add(m.url))
}
function chooseMedia(items) {
    if (!items.length) return []
    // a carousel / photo post: several entries from one array → send them all
    const groups = {}
    for (const m of items) if (m.group) (groups[m.group] ||= []).push(m)
    const big = Object.values(groups).sort((a, b) => b.length - a.length)[0]
    // (a list of the SAME video in different qualities is not a carousel)
    const qualityList = big && big.every(m => m.type === 'video' && /:(hd|sd|low|high|medium|\d{3,4}p?)\b/i.test(m.key))
    if (big && big.length > 1 && !qualityList) return big.slice(0, 10)
    const videos = items.filter(m => m.type === 'video')
    if (videos.length) {
        const rank = m => (/nowm|no_?watermark|hd|high|1080|720/i.test(m.key) ? 0 : /sd|low|360|240/i.test(m.key) ? 2 : 1)
        return [videos.sort((a, b) => rank(a) - rank(b))[0]]
    }
    return items.filter(m => m.type === 'image').slice(0, 10)
}
function nexrayMeta(json) {
    const r = json?.result || json?.data || {}
    const title = typeof r.title === 'string' ? r.title : (typeof r.caption === 'string' ? r.caption : (typeof r.desc === 'string' ? r.desc : ''))
    const a = r.author || r.user || r.owner
    const author = typeof a === 'string' ? a : (a?.nickname || a?.name || a?.username || a?.unique_id || '')
    return { title: title.slice(0, 140), author: String(author || '').slice(0, 60) }
}
async function nexrayDownload(kind, url) {
    const errs = []
    for (const path of NX_DL[kind] || []) {
        try {
            const r = await nexrayLib.call(path, { params: { url }, timeout: 60_000 })
            if (r.type === 'binary') return { items: [{ buf: r.buf, type: /^image/.test(r.ct) ? 'image' : 'video' }], meta: {}, path }
            if (r.type !== 'json' || r.json?.status === false) { errs.push(`${path}: ${nexrayLib.cleanErr(r.json) || 'HTTP ' + r.status}`); continue }
            const items = chooseMedia(collectMedia(r.json))
            if (items.length) return { items, meta: nexrayMeta(r.json), path }
            errs.push(`${path}: no media in reply`)
        } catch (e) { errs.push(`${path}: ${e.message}`) }
    }
    console.error(`[downloader] Nexray ${kind} failed → ${errs.join(' | ')}`)
    return null
}
// Downloads the chosen items and sends them; true if at least one went out.
async function sendNexrayItems(sock, from, msg, nx, caption) {
    let sent = 0
    for (const it of nx.items) {
        try {
            const buf = it.buf || await withRetry(() => toBuffer(it.url, { timeoutMs: 120_000 }), 2)
            const cap = sent === 0 ? caption : undefined
            if (it.type === 'image') await sock.sendMessage(from, { image: buf, caption: cap }, { quoted: msg })
            else await sock.sendMessage(from, { video: buf, mimetype: 'video/mp4', caption: cap }, { quoted: msg })
            sent++
        } catch (e) { console.error('[downloader] Nexray media send failed:', e.message) }
    }
    return sent > 0
}
const firstUrl = (q) => (String(q).match(/https?:\/\/[^\s]+/i) || [q])[0]

function cardSearching(query) {
    return `🔍 Searching *${query}*, wait please...`
}

function cardDownloading(label = 'media') {
    return `⏳ Downloading ${label}, wait please...`
}

function cardDone(title, source = '') {
    return `✅ *${title}*`
}

function cardNotFound(query, suggestions = []) {
    let msg = `❌ Couldn't find *${query}*`
    if (suggestions.length) msg += `\n💡 Try: ${suggestions.join(', ')}`
    return msg
}

function cardError(msg, tip = '') {
    return tip ? `❌ ${msg}\n💡 ${tip}` : `❌ ${msg}`
}

// Sends a track as a downloadable .mp3 file (file-card with a download icon
// and filename, like a document) instead of the inline voice-note-style
// playable audio bubble. This is what every music-download command below
// uses now — requested explicitly over the old `audio:` bubble.
function sanitizeFilename(name) {
    return (name || 'audio').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'audio'
}

async function sendAudioFile(sock, from, buf, title, msg) {
    if (scopeAllows(runtimeSettings.autorecord, from.endsWith('@g.us'))) {
        try { await sock.sendPresenceUpdate('recording', from) } catch {}
        await sleep(1200) // give the "recording…" indicator time to actually render
    }
    // If ffmpeg's lame encoder was unavailable we fell back to M4A/AAC —
    // sniff the ftyp box so the file is labelled correctly and still plays.
    const isM4a = buf?.length > 12 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79
    const filename = `${sanitizeFilename(title)}.${isM4a ? 'm4a' : 'mp3'}`
    await sock.sendMessage(from, {
        document: buf,
        mimetype: isM4a ? 'audio/mp4' : 'audio/mpeg',
        fileName: filename,
    }, { quoted: msg })
}

async function downloadMedia(sock, from, cmd, q, msg) {
    const p = config.prefix

    // ── PLAY / SONG / MUSIC ───────────────────────────────────────────────────
    if (['play', 'song', 'song2', 'music', 'mp3'].includes(cmd)) {
        if (!q) return sock.sendMessage(from, { text: fmt.usage('play', '<song name or YouTube URL>') }, { quoted: msg })
        await sock.sendMessage(from, { text: cardSearching(q) }, { quoted: msg })

        // Resolve the query to a YouTube video — direct URL if given, else search
        let yt = null
        const ytIdMatch = q.match(/(?:youtu\.be\/|[?&]v=|shorts\/)([\w-]{11})/)
        if (q.startsWith('http') && ytIdMatch) {
            yt = { id: ytIdMatch[1], url: `https://youtu.be/${ytIdMatch[1]}`, title: q }
        } else {
            yt = await ytSearch(q, { maxSecs: MAX_MUSIC_SECS })
            if (!yt) {
                // Last-resort search — the ytplay endpoint is slow, so it now
                // has a short timeout; failing here just means "not found".
                try {
                    const yp = await nexrayYtPlay(q)
                    if (yp?.id) yt = { id: yp.id, url: `https://youtu.be/${yp.id}`, title: yp.title }
                } catch (e) { console.error('[downloader] play ytplay fallback failed:', e.message) }
            }
        }
        if (!yt) {
            await sock.sendMessage(from, { text: cardNotFound(q, [`${p}ytmp3`, `${p}spotify`]) }, { quoted: msg })
            return
        }

        // ── PRIMARY: the WORKING video system ─────────────────────────────
        // Nexray v1/ytmp4 downloads the MP4 (360p — plenty for audio, keeps the
        // download fast and small), then ffmpeg strips the audio track into a
        // real MP3. This is the same hosted extraction .video relies on, so
        // play no longer depends on the flaky /downloader/ytmp3 & ytplay audio
        // endpoints hitting YouTube from this host.
        try {
            const nx = await nexrayYtMp4(yt.url, '360')
            if (nx?.url) {
                const videoBuf = await withRetry(() => toBuffer(nx.url, { label: 'Nexray MP4', timeoutMs: 120_000 }), 2)
                if (validateMedia(videoBuf, 'video')) {
                    const audioBuf = await convertVideoBufferToAudio(videoBuf)
                    await sendAudioFile(sock, from, audioBuf, yt.title || nx.title || q, msg)
                    await fmt.done(sock, msg)
                    return
                }
                console.error('[downloader] Nexray MP4 failed video validation, trying next source')
            }
        } catch (e) { console.error('[downloader] video→audio step failed:', e.message) }

        // ── FALLBACK 1: Nexray ytmp3 direct (~1s, hosted MP3 link) ────────
        try {
            const mp3 = await nexrayYtMp3(yt.url)
            if (mp3) {
                const buf = await withRetry(() => toBuffer(mp3.url, { label: 'Nexray MP3', timeoutMs: 120_000 }), 2)
                if (looksLikeAudio(buf)) {
                    await sendAudioFile(sock, from, buf, yt.title || mp3.title || q, msg)
                    await fmt.done(sock, msg)
                    return
                }
            }
        } catch (e) { console.error('[downloader] Nexray ytmp3 fallback failed:', e.message) }

        // ── FALLBACK 1b: other Nexray sources (v1 ytmp3, savetube, Spotify, ytplay, mp4) ──
        try {
            const xb = await nexrayExtraAudio(yt, q)
            if (xb) {
                await sendAudioFile(sock, from, xb, yt.title && !/^https?:/.test(yt.title) ? yt.title : q, msg)
                await fmt.done(sock, msg)
                return
            }
        } catch (e) { console.error('[downloader] nexray extra audio failed:', e.message) }

        // ── FALLBACK 2: JioSaavn (best for music — real HQ MP3 links) ─────
        const saavn = await saavnSearch(q)
        if (saavn && saavn.secs <= MAX_MUSIC_SECS) {
            try {
                const buf = await withRetry(() => toBuffer(saavn.dlUrl, { label: 'JioSaavn', timeoutMs: 60_000 }), 2)
                await sendAudioFile(sock, from, buf, saavn.title, msg)
                await fmt.done(sock, msg)
                return
            } catch (e) { console.error('[downloader]', e.message) }
        }

        // ── FALLBACK 3: ruhend → yt-dlp → direct URL → Vreden ─────────────
        try {
            let buf = null
            const rd = await ruhendYtMp3(yt.url)
            if (rd?.audio) buf = await withRetry(() => toBuffer(rd.audio, { timeoutMs: 90_000 }), 2)
            if (!buf) {
                try {
                    if (await hasYtdlp()) buf = await ytdlpDownload(yt.url, true)
                } catch (e) { console.error('[downloader] yt-dlp audio failed, trying next source:', e.message) }
            }
            if (!buf) {
                const dlUrl = await ytAudioUrl(yt.id)
                if (dlUrl) buf = await withRetry(() => toBuffer(dlUrl, { timeoutMs: 90_000 }), 2)
            }
            if (!buf) {
                const vd = await vredenYtAudio(yt.url)
                if (vd?.audioUrl) buf = await withRetry(() => toBuffer(vd.audioUrl, { timeoutMs: 90_000 }), 2)
            }
            if (!buf || !validateMedia(buf, 'audio')) throw new Error('all sources failed')
            await sendAudioFile(sock, from, buf, yt.title, msg)
            await fmt.done(sock, msg)
        } catch (e) {
            console.error('[downloader]', e.message)
            await sock.sendMessage(from, {
                text: cardError(`Found it but couldn't download (${e.message})`, `Try: ${p}ytmp3 ${yt.url}`)
            }, { quoted: msg })
        }
        return
    }

    // ── YTMP3  (YouTube → MP3 audio) ──────────────────────────────────────────
    if (['ytmp3', 'tomp3', 'toaudio', 'yta'].includes(cmd)) {
        if (!q) return sock.sendMessage(from, { text: fmt.usage('ytmp3', '<YouTube URL or search>') }, { quoted: msg })

        // If not a URL, try JioSaavn first
        if (!q.startsWith('http')) {
            const saavn = await saavnSearch(q)
            if (saavn) {
                try {
                    const buf = await toBuffer(saavn.dlUrl, { timeoutMs: 60_000 })
                    await sendAudioFile(sock, from, buf, saavn.title, msg)
                    await fmt.done(sock, msg)
                    return
                } catch (e) { console.error("[downloader]", e.message) }
            }
        }

        await sock.sendMessage(from, { text: cardDownloading('YouTube audio') }, { quoted: msg })
        try {
            // 0️⃣ Savage API (fast path — works with URL or plain search query)
            const sd = await savageYtAudio(q)
            if (sd?.audioUrl) {
                const buf = await withRetry(() => toBuffer(sd.audioUrl, { timeoutMs: 90_000 }), 2)
                await sendAudioFile(sock, from, buf, q, msg)
                await fmt.done(sock, msg)
                return
            }

            // 1️⃣ ruhend-scraper (direct URLs only, needs a real YouTube link)
            if (q.startsWith('http')) {
                const rd = await ruhendYtMp3(q)
                if (rd?.audio) {
                    const buf = await withRetry(() => toBuffer(rd.audio, { timeoutMs: 90_000 }), 2)
                    await sendAudioFile(sock, from, buf, q, msg)
                    await fmt.done(sock, msg)
                    return
                }
            }

            const ytdlp = await hasYtdlp()
            let buf = null
            if (ytdlp) {
                const url = q.startsWith('http') ? q : (await ytSearch(q, { maxSecs: 3600 }))?.url
                if (!url) throw new Error('Song not found on YouTube')
                try {
                    buf = await ytdlpDownload(url, true)
                } catch (e) {
                    // Same fallthrough fix as the .play path — don't let a
                    // yt-dlp failure (e.g. YouTube's bot-check) skip the
                    // direct-URL fallback below.
                    console.error('[downloader] yt-dlp failed, trying direct URL:', e.message)
                    const id = url.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/)?.[1]
                    const dlUrl = id ? await ytAudioUrl(id) : null
                    if (!dlUrl) throw e
                    buf = await toBuffer(dlUrl, { timeoutMs: 90_000 })
                }
            } else {
                const id = q.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/)?.[1]
                    || (await ytSearch(q, { maxSecs: 3600 }))?.id
                if (!id) throw new Error('Cannot find video')
                const dlUrl = await ytAudioUrl(id)
                if (!dlUrl) throw new Error('No audio download source available')
                buf = await toBuffer(dlUrl, { timeoutMs: 90_000 })
            }
            if (!buf) {
                // Last resort — see comment on vredenYtAudio above.
                const vd = await vredenYtAudio(q.startsWith('http') ? q : `https://www.youtube.com/watch?v=${
                    q.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/)?.[1] || ''
                }`)
                if (vd?.audioUrl) buf = await toBuffer(vd.audioUrl, { timeoutMs: 90_000 })
            }
            if (!buf) throw new Error('Download produced empty file')
            await sendAudioFile(sock, from, buf, q, msg)
            await fmt.done(sock, msg)
        } catch (e) {
            await sock.sendMessage(from, { text: cardError(e.message, `Try: ${p}ytmp3 <YouTube URL>`) }, { quoted: msg })
        }
        return
    }

    // ── YTMP4 / VIDEO  (YouTube → MP4 video) ──────────────────────────────────
    if (['ytmp4', 'yt', 'tovideo', 'video', 'ytv', 'download'].includes(cmd)) {
        if (!q) return sock.sendMessage(from, { text: fmt.usage(cmd, '<YouTube URL or search>') }, { quoted: msg })

        let url = q.trim(), title = q, duration = ''
        // youtu.be/ID?si=…, shorts, m.youtube… → canonical watch URL (extra params break some sources)
        { const mId = url.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/); if (/^https?:/i.test(url) && mId) url = `https://www.youtube.com/watch?v=${mId[1]}` }

        if (!url.startsWith('http')) {
            await sock.sendMessage(from, { text: cardSearching(q) }, { quoted: msg })
            let r = await ytSearch(q, { maxSecs: MAX_VIDEO_SECS })
            if (!r) {
                // Last-resort search: Nexray ytplay resolves a plain phrase to a
                // video — so "Couldn't find" only appears when every search died.
                try {
                    const yp = await nexrayYtPlay(q)
                    if (yp?.id) r = { url: `https://youtu.be/${yp.id}`, title: yp.title, duration: fmtDur(yp.secs) }
                } catch (e) { console.error('[downloader] video search ytplay fallback failed:', e.message) }
            }
            if (!r) return sock.sendMessage(from, { text: cardNotFound(q, [`_${p}ytmp4_`]) }, { quoted: msg })
            url = r.url; title = r.title; duration = r.duration
        } else {
            await sock.sendMessage(from, { text: cardDownloading('YouTube video') }, { quoted: msg })
        }

        try {
            let buf = null
            let vidQuality = ''

            // 0️⃣ Nexray ladder (several endpoints, 720p → 360p)
            const why = []
            global.__ytWhy = why
            const lad = await nexrayVideoLadder(url, title, why)
            if (lad) { buf = lad.buf; vidQuality = lad.quality }

            // 1️⃣ Savage API (fast path — hosted extraction, not this host's IP)
            const sd = buf ? null : await savageYtVideo(url)
            if (sd?.videoUrl) {
                buf = await withRetry(() => toBuffer(sd.videoUrl, { timeoutMs: 120_000 }), 2)
            }

            // 1️⃣ ruhend-scraper
            if (!buf) {
                const rd = await ruhendYtMp4(url)
                if (rd?.video) {
                    buf = await withRetry(() => toBuffer(rd.video, { timeoutMs: 120_000 }), 2)
                }
            }

            if (!buf) {
                try {
                    const ytdlp = await hasYtdlp()
                    if (ytdlp) {
                        buf = await ytdlpDownload(url, false)
                    } else {
                        const dlUrl = await cobaltFetch(url, false)
                        buf = await withRetry(() => toBuffer(dlUrl, { timeoutMs: 120_000 }), 2)
                    }
                } catch (e) { (global.__ytWhy = global.__ytWhy || []).push('yt-dlp/cobalt: ' + (e.message || 'failed')) }
            }
            if (!buf) throw new Error('Could not download this video right now' + ((global.__ytWhy || []).length ? '\n_' + [...new Set(global.__ytWhy.map(x => x.slice(0, 70)))].slice(0, 4).join('\n') + '_' : ''))
            await sock.sendMessage(from, {
                video:   buf,
                mimetype: 'video/mp4',
                caption:  fmt.box('🎬 VIDEO', [`✦ *${title}*`, duration ? `⏱ ${duration}` : null, vidQuality ? `📺 ${vidQuality}` : null].filter(Boolean)),
            }, { quoted: msg })
            await fmt.done(sock, msg)
        } catch (e) {
            // Link form: when the bot itself can't fetch the file, give direct browser download pages
            // that work from the user's own phone (the video path above is unchanged).
            const vid = (url.match(/[?&]v=([\w-]{11})/) || [])[1]
            const links = vid ? [
                `🔗 *Download in your browser:*`,
                `• https://ssyoutube.com/watch?v=${vid}`,
                `• https://cobalt.tools/?u=${encodeURIComponent('https://www.youtube.com/watch?v=' + vid)}`,
                `• https://y2mate.nu/en/youtube/${vid}`,
            ].join('\n') : ''
            await sock.sendMessage(from, { text: cardError(e.message || 'Download failed', `Try again in a moment: ${p}ytmp4 <URL>`) + (links ? `\n\n${links}` : '') }, { quoted: msg })
        }
        return
    }

    // ── TIKTOK  (video — TikWM → TiklyDown → Cobalt → yt-dlp) ───────────────
    if (['tiktok', 'tt', 'tkvid'].includes(cmd)) {
        if (!q || !q.match(/tiktok\.com|vt\.tiktok\.com/i))
            return sock.sendMessage(from, { text: fmt.usage('tiktok', '<TikTok URL>') }, { quoted: msg })

        // Extract only the URL from TikTok share text.
        const tiktokUrl = q.match(/https?:\/\/(?:www\.|vm\.|vt\.)?tiktok\.com\/[^\s]+/i)?.[0]
        if (!tiktokUrl)
            return sock.sendMessage(from, { text: cardError('Invalid TikTok URL', 'Send the full TikTok share link') }, { quoted: msg })

        const resolvedUrl = await resolveShortUrl(tiktokUrl)
        await sock.sendMessage(from, { text: cardDownloading('TikTok') }, { quoted: msg })

        const sendTkVideo = async (buf, info) => {
            await sock.sendMessage(from, {
                video:    buf,
                mimetype: 'video/mp4',
                caption:  fmt.box('🎵 TIKTOK', [
                    info?.title    ? `✦ *${info.title}*`    : null,
                    info?.author   ? `👤 ${info.author}`    : null,
                    info?.duration ? `⏱ ${info.duration}`   : null,
                    `_No watermark ✅_`,
                ].filter(Boolean)),
            }, { quoted: msg })
            await fmt.done(sock, msg)
        }

        // ⭐ Nexray first (videos and photo slideshows)
        try {
            const nx = await nexrayDownload('tiktok', tiktokUrl) || await nexrayDownload('tiktok', resolvedUrl)
            if (nx) {
                const cap = fmt.box('🎵 TIKTOK', [nx.meta.title ? `✦ *${nx.meta.title}*` : null, nx.meta.author ? `👤 ${nx.meta.author}` : null, `_No watermark ✅_`].filter(Boolean))
                if (await sendNexrayItems(sock, from, msg, nx, cap)) return await fmt.done(sock, msg)
            }
        } catch (e) { console.error('[downloader] Nexray tiktok:', e.message) }

        // 0️⃣ ruhend-scraper (fast path — maintained npm package)
        try {
            const info = await ruhendTikTok(resolvedUrl)
            if (info?.videoUrl) {
                const buf = await withRetry(() => toBuffer(info.videoUrl, { timeoutMs: 60_000 }), 2)
                return await sendTkVideo(buf, info)
            }
        } catch (e) { console.error("[downloader]", e.message) }

        // 1️⃣ TikWM (primary — no watermark)
        try {
            const info = await tikwmFetch(resolvedUrl, false)
            if (info?.videoUrl) {
                const buf = await withRetry(() => toBuffer(info.videoUrl, { timeoutMs: 60_000 }), 2)
                return await sendTkVideo(buf, info)
            }
        } catch (e) { console.error("[downloader]", e.message) }

        // 2️⃣ TiklyDown (secondary — free, no watermark)
        try {
            const info = await tiklyFetch(resolvedUrl)
            if (info?.videoUrl) {
                const buf = await withRetry(() => toBuffer(info.videoUrl, { timeoutMs: 60_000 }), 2)
                return await sendTkVideo(buf, info)
            }
        } catch (e) { console.error("[downloader]", e.message) }

        // 3️⃣ Cobalt
        try {
            const dlUrl = await cobaltFetch(resolvedUrl, false)
            const buf   = await withRetry(() => toBuffer(dlUrl, { timeoutMs: 60_000 }), 2)
            await sock.sendMessage(from, { video: buf, mimetype: 'video/mp4', caption: '🎵 TikTok' }, { quoted: msg })
            return await fmt.done(sock, msg)
        } catch (e) { console.error("[downloader]", e.message) }

        // 4️⃣ yt-dlp last resort
        try {
            const buf = await ytdlpDownload(resolvedUrl, false)
            await sock.sendMessage(from, { video: buf, mimetype: 'video/mp4', caption: '🎵 TikTok' }, { quoted: msg })
            return await fmt.done(sock, msg)
        } catch (e) { console.error("[downloader]", e.message) }

        await sock.sendMessage(from, { text: cardError('Could not download TikTok video', 'Paste the full TikTok share link') }, { quoted: msg })
        return
    }

    // ── TIKTOK AUDIO  (music only) ────────────────────────────────────────────
    if (['tiktokaudio', 'tkaudio', 'ttaudio'].includes(cmd)) {
        if (!q || !q.includes('tiktok'))
            return sock.sendMessage(from, { text: fmt.usage('tiktokaudio', '<TikTok URL>') }, { quoted: msg })

        await sock.sendMessage(from, { text: cardDownloading('TikTok audio') }, { quoted: msg })

        const sendAudio = async (buf) => {
            await sendAudioFile(sock, from, buf, 'TikTok Audio', msg)
            await fmt.done(sock, msg)
        }

        // 0️⃣ ruhend-scraper (fast path)
        try {
            const info = await ruhendTikTok(q)
            if (info?.audioUrl) {
                const buf = await toBuffer(info.audioUrl, { timeoutMs: 45_000 })
                return await sendAudio(buf)
            }
        } catch (e) { console.error("[downloader]", e.message) }

        // 1️⃣ TikWM
        try {
            const info = await tikwmFetch(q, true)
            if (info?.audioUrl) {
                const buf = await toBuffer(info.audioUrl, { timeoutMs: 45_000 })
                return await sendAudio(buf)
            }
        } catch (e) { console.error("[downloader]", e.message) }

        // 2️⃣ TiklyDown
        try {
            const info = await tiklyFetch(q)
            if (info?.audioUrl) {
                const buf = await toBuffer(info.audioUrl, { timeoutMs: 45_000 })
                return await sendAudio(buf)
            }
        } catch (e) { console.error("[downloader]", e.message) }

        // 3️⃣ Cobalt audio
        try {
            const dlUrl = await cobaltFetch(q, true)
            const buf   = await toBuffer(dlUrl, { timeoutMs: 60_000 })
            return await sendAudio(buf)
        } catch (e) { console.error("[downloader]", e.message) }

        await sock.sendMessage(from, { text: cardError('Could not extract TikTok audio') }, { quoted: msg })
        return
    }

    // ── INSTAGRAM  (fastdl → snapinsta → saveig → Cobalt → yt-dlp) ──────────
    if (['ig', 'instagram', 'insta'].includes(cmd)) {
        if (!q || !q.match(/instagram\.com/i))
            return sock.sendMessage(from, { text: fmt.usage('ig', '<Instagram URL>') }, { quoted: msg })

        await sock.sendMessage(from, { text: cardDownloading('Instagram') }, { quoted: msg })

        const sendIg = async (buf) => {
            try {
                await sock.sendMessage(from, { video: buf, mimetype: 'video/mp4', caption: '📸 *Instagram*\n_Downloaded by MAHNGUELOH VANTA_' }, { quoted: msg })
            } catch {
                await sock.sendMessage(from, { image: buf, caption: '📸 *Instagram*' }, { quoted: msg })
            }
            await fmt.done(sock, msg)
        }

        // ⭐ Nexray first — posts, reels, carousels and stories
        try {
            const igUrl = firstUrl(q)
            const nx = await nexrayDownload('ig', igUrl)
            if (nx && await sendNexrayItems(sock, from, msg, nx, '📸 *Instagram*')) return await fmt.done(sock, msg)
        } catch (e) { console.error('[downloader] Nexray instagram:', e.message) }

        // 0️⃣ ruhend-scraper (fast path)
        try {
            const dlUrl = await ruhendInstagram(q)
            if (dlUrl) {
                const buf = await withRetry(() => toBuffer(dlUrl, { timeoutMs: 90_000 }), 2)
                return await sendIg(buf)
            }
        } catch (e) { console.error("[downloader]", e.message) }

        // 1️⃣ Dedicated Instagram providers (fastdl → snapinsta → saveig)
        try {
            const dlUrl = await igDownload(q)
            const buf   = await withRetry(() => toBuffer(dlUrl, { timeoutMs: 90_000 }), 2)
            return await sendIg(buf)
        } catch (e) { console.error("[downloader]", e.message) }

        // 2️⃣ Cobalt
        try {
            const dlUrl = await cobaltFetch(q, false)
            const buf   = await withRetry(() => toBuffer(dlUrl, { timeoutMs: 90_000 }), 2)
            return await sendIg(buf)
        } catch (e) { console.error("[downloader]", e.message) }

        // 3️⃣ yt-dlp last resort
        try {
            const buf = await ytdlpDownload(q, false)
            return await sendIg(buf)
        } catch (e) { console.error("[downloader]", e.message) }

        await sock.sendMessage(from, { text: cardError('Could not download Instagram post', 'Only public posts/reels can be downloaded') }, { quoted: msg })
        return
    }

    // ── TWITTER / X  (twitsave → twittervd → ssstwitter → Cobalt → yt-dlp) ──
    if (['twitter', 'x', 'tweet'].includes(cmd)) {
        if (!q || !q.match(/twitter\.com|x\.com/i))
            return sock.sendMessage(from, { text: fmt.usage('twitter', '<Twitter/X URL>') }, { quoted: msg })

        await sock.sendMessage(from, { text: cardDownloading('Twitter/X') }, { quoted: msg })

        const sendTw = async (buf) => {
            try {
                await sock.sendMessage(from, { video: buf, mimetype: 'video/mp4', caption: '🐦 *Twitter / X*\n_Downloaded by MAHNGUELOH VANTA_' }, { quoted: msg })
            } catch {
                await sock.sendMessage(from, { image: buf, caption: '🐦 Twitter/X' }, { quoted: msg })
            }
            await fmt.done(sock, msg)
        }

        // ⭐ Nexray first
        try {
            const nx = await nexrayDownload('twitter', firstUrl(q))
            if (nx && await sendNexrayItems(sock, from, msg, nx, '🐦 *Twitter / X*')) return await fmt.done(sock, msg)
        } catch (e) { console.error('[downloader] Nexray twitter:', e.message) }

        // 1️⃣ Dedicated Twitter providers (twitsave → twittervd → ssstwitter)
        try {
            const dlUrl = await twitterDownload(q)
            const buf   = await withRetry(() => toBuffer(dlUrl, { timeoutMs: 90_000 }), 2)
            return await sendTw(buf)
        } catch (e) { console.error("[downloader]", e.message) }

        // 2️⃣ Cobalt
        try {
            const dlUrl = await cobaltFetch(q, false)
            const buf   = await withRetry(() => toBuffer(dlUrl, { timeoutMs: 90_000 }), 2)
            return await sendTw(buf)
        } catch (e) { console.error("[downloader]", e.message) }

        // 3️⃣ yt-dlp last resort
        try {
            const buf = await ytdlpDownload(q, false)
            return await sendTw(buf)
        } catch (e) { console.error("[downloader]", e.message) }

        await sock.sendMessage(from, { text: cardError('Could not download Twitter/X video', 'Only public tweets with video can be downloaded') }, { quoted: msg })
        return
    }

    // ── FACEBOOK  (getfvid → fdown → savefrom → Cobalt → yt-dlp) ────────────
    if (['facebook', 'fb', 'fbvid'].includes(cmd)) {
        if (!q || !q.match(/facebook\.com|fb\.watch/i))
            return sock.sendMessage(from, { text: fmt.usage('facebook', '<Facebook URL>') }, { quoted: msg })

        await sock.sendMessage(from, { text: cardDownloading('Facebook') }, { quoted: msg })

        // ⭐ Nexray first — also tries the link after following facebook.com/share/... redirects
        try {
            const fbUrl = firstUrl(q)
            let nx = await nexrayDownload('fb', fbUrl)
            if (!nx) { let real = null; try { real = await resolveShortUrl(fbUrl) } catch {} if (real && real !== fbUrl) nx = await nexrayDownload('fb', real) }
            if (nx && await sendNexrayItems(sock, from, msg, nx, '📘 *Facebook*')) return await fmt.done(sock, msg)
        } catch (e) { console.error('[downloader] Nexray facebook:', e.message) }

        // 0️⃣ ruhend-scraper (fast path)
        try {
            const dlUrl = await ruhendFacebook(q)
            if (dlUrl) {
                const buf = await withRetry(() => toBuffer(dlUrl, { timeoutMs: 90_000 }), 2)
                await sock.sendMessage(from, { video: buf, mimetype: 'video/mp4', caption: '📘 *Facebook*\n_Downloaded by MAHNGUELOH VANTA_' }, { quoted: msg })
                return await fmt.done(sock, msg)
            }
        } catch (e) { console.error("[downloader]", e.message) }

        // 1️⃣ Dedicated Facebook providers (getfvid → fdown → savefrom)
        try {
            const dlUrl = await fbDownload(q)
            const buf   = await withRetry(() => toBuffer(dlUrl, { timeoutMs: 90_000 }), 2)
            await sock.sendMessage(from, { video: buf, mimetype: 'video/mp4', caption: '📘 *Facebook*\n_Downloaded by MAHNGUELOH VANTA_' }, { quoted: msg })
            return await fmt.done(sock, msg)
        } catch (e) { console.error("[downloader]", e.message) }

        // 2️⃣ Cobalt
        try {
            const dlUrl = await cobaltFetch(q, false)
            const buf   = await withRetry(() => toBuffer(dlUrl, { timeoutMs: 90_000 }), 2)
            await sock.sendMessage(from, { video: buf, mimetype: 'video/mp4', caption: '📘 Facebook' }, { quoted: msg })
            return await fmt.done(sock, msg)
        } catch (e) { console.error("[downloader]", e.message) }

        // 3️⃣ yt-dlp last resort
        try {
            const buf = await ytdlpDownload(q, false)
            await sock.sendMessage(from, { video: buf, mimetype: 'video/mp4', caption: '📘 Facebook' }, { quoted: msg })
            return await fmt.done(sock, msg)
        } catch (e) { console.error("[downloader]", e.message) }

        await sock.sendMessage(from, { text: cardError('Could not download Facebook video', 'Only public videos can be downloaded') }, { quoted: msg })
        return
    }

    // ── SPOTIFY ───────────────────────────────────────────────────────────────
    if (['spotify', 'sp', 'spdl'].includes(cmd)) {
        if (!q)
            return sock.sendMessage(from, { text: fmt.usage('spotify', '<song name or Spotify link>') }, { quoted: msg })

        await sock.sendMessage(from, {
            text: fmt.box('🟢 SPOTIFY', [`🔍 Fetching track info...`])
        }, { quoted: msg })

        try {
            // ── Nexray first: song name OR Spotify link → card + MP3 ──────────
            const nx = await nexraySpotify(q)
            if (nx) {
                try {
                    const lines = [
                        `🟢 *${nx.title || q}*`,
                        nx.artist ? `🎤 ${nx.artist}` : null,
                        nx.album ? `💿 ${nx.album}` : null,
                        nx.duration ? `⏱️ ${nx.duration}` : null,
                        nx.release_at ? `📅 ${nx.release_at}` : null,
                        nx.popularity != null ? `🔥 Popularity ${nx.popularity}` : null,
                        /open\.spotify\.com/.test(nx.url || '') ? `🔗 ${nx.url}` : null,
                    ].filter(Boolean).join('\n')
                    if (nx.thumbnail && /^https?:/.test(nx.thumbnail)) {
                        try { await sock.sendMessage(from, { image: { url: nx.thumbnail }, caption: lines }, { quoted: msg }) }
                        catch { await sock.sendMessage(from, { text: lines }, { quoted: msg }) }
                    } else await sock.sendMessage(from, { text: lines }, { quoted: msg })
                    const buf = await withRetry(() => toBuffer(nx.dl, { timeoutMs: 90_000 }), 2)
                    await sendAudioFile(sock, from, buf, `${nx.title || q}${nx.artist ? ' - ' + nx.artist : ''}`, msg)
                    await fmt.done(sock, msg)
                    return
                } catch (e) { console.error('[downloader] Nexray spotify send failed:', e.message) }
            }

            // Spotify's mobile Share button gives a short "spotify.link/..."
            // URL, not the full open.spotify.com/track/... link — and
            // Spotify's oEmbed endpoint doesn't resolve that redirect
            // itself, so it was silently failing on exactly the kind of
            // link most people actually paste in. Resolve it first, the
            // same way TikTok short links already get resolved above.
            const isSpLink = /spotify\.(com|link)/i.test(q)
            const resolvedUrl = !isSpLink || q.includes('open.spotify.com') ? q : await resolveShortUrl(q)
            const info = isSpLink ? await spotifyInfo(resolvedUrl) : { searchQuery: q, title: q }
            if (!info?.searchQuery) throw new Error('Could not read Spotify track info')

            await sock.sendMessage(from, {
                text: fmt.box('🔍 SEARCHING', [`Finding: *${info.title || info.searchQuery}*`])
            }, { quoted: msg })

            // ── Try JioSaavn match first ──────────────────────────────────────
            const saavn = await saavnSearch(info.searchQuery)
            if (saavn) {
                try {
                    const buf = await withRetry(() => toBuffer(saavn.dlUrl, { timeoutMs: 60_000 }), 2)
                    await sendAudioFile(sock, from, buf, saavn.title, msg)
                    await fmt.done(sock, msg)
                    return
                } catch (e) { console.error("[downloader]", e.message) }
            }

            // ── YouTube fallback ──────────────────────────────────────────────
            const yt = await ytSearch(info.searchQuery, { maxSecs: MAX_MUSIC_SECS })
            if (!yt) throw new Error(`Could not find: *${info.searchQuery}*`)


            const ytdlp = await hasYtdlp()
            let buf = null
            if (ytdlp) {
                buf = await ytdlpDownload(yt.url, true)
            } else {
                const dlUrl = await ytAudioUrl(yt.id)
                if (!dlUrl) throw new Error('No audio download source found')
                buf = await withRetry(() => toBuffer(dlUrl, { timeoutMs: 90_000 }), 2)
            }

            await sendAudioFile(sock, from, buf, yt.title || info.title, msg)
            await fmt.done(sock, msg)

        } catch (e) {
            await sock.sendMessage(from, {
                text: cardError(e.message, `Try: ${p}play <song name and artist>`)
            }, { quoted: msg })
        }
        return
    }

    // ── MEDIAFIRE ─────────────────────────────────────────────────────────────
    if (['mediafire', 'mf', 'mfdl'].includes(cmd)) {
        if (!q || !q.includes('mediafire'))
            return sock.sendMessage(from, { text: fmt.usage('mediafire', '<MediaFire URL>') }, { quoted: msg })

        await sock.sendMessage(from, {
            text: fmt.box('📁 MEDIAFIRE', [`🔗 Extracting download link...`])
        }, { quoted: msg })

        try {
            const dlUrl = await withRetry(() => mediaFireLink(q), 2, 2000)
            const filename = dlUrl.split('/').pop()?.split('?')[0] || 'file'

            await sock.sendMessage(from, {
                text: fmt.box('📁 MEDIAFIRE', [
                    `📄 *${decodeURIComponent(filename)}*`,
                    `⏳ Downloading...`,
                ])
            }, { quoted: msg })

            const buf = await withRetry(() => toBuffer(dlUrl, { timeoutMs: 120_000 }), 2)

            // Determine MIME type from extension
            const ext  = filename.split('.').pop()?.toLowerCase() || ''
            const mime = {
                mp3: 'audio/mpeg', mp4: 'video/mp4', pdf: 'application/pdf',
                zip: 'application/zip', rar: 'application/x-rar-compressed',
                apk: 'application/vnd.android.package-archive',
            }[ext] || 'application/octet-stream'

            if (mime.startsWith('audio/')) {
                await sock.sendMessage(from, {
                    document: buf, mimetype: mime, fileName: filename,
                }, { quoted: msg })
            } else if (mime.startsWith('video/')) {
                await sock.sendMessage(from, { video: buf, mimetype: mime, caption: `📁 ${filename}` }, { quoted: msg })
            } else {
                await sock.sendMessage(from, {
                    document: buf, mimetype: mime, fileName: filename,
                    caption: fmt.box('📁 DOWNLOAD', [`✅ *${filename}*`, `📦 ${fmtSize(buf.length)}`]),
                }, { quoted: msg })
            }
            await fmt.done(sock, msg)
        } catch (e) {
            await sock.sendMessage(from, {
                text: cardError(e.message, 'Ensure the file is public and the URL is complete')
            }, { quoted: msg })
        }
        return
    }
}

module.exports = { downloadMedia, ensureYtdlp, downloadApk }
