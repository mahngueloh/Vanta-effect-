'use strict'
// Tiny client for the Nexray API (https://api.nexray.eu.cc). Every endpoint is
// GET /<category>/<name>?<param>=…  (a few image-edit ones are POST). Replies
// are either JSON ({status, result}) or the raw media file itself.
const axios = require('axios')

const BASE = () => (process.env.NEXRAY_API_BASE || 'https://api.nexray.eu.cc').replace(/\/+$/, '')
const UA = { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36', 'Accept': 'application/json, */*' }

// → { type:'binary', buf, ct } | { type:'json', json, status } | { type:'text', raw, status }
async function call(path, { params = {}, method = 'GET', form = null, timeout = 45000 } = {}) {
    const p = { ...params }
    if (process.env.NEXRAY_API_KEY) p.apikey = process.env.NEXRAY_API_KEY
    const res = await axios({
        method, url: BASE() + path, params: p, data: form || undefined,
        headers: { ...UA, ...(form ? form.getHeaders() : {}) },
        timeout, responseType: 'arraybuffer', validateStatus: () => true,
        maxBodyLength: Infinity, maxContentLength: Infinity,
    })
    const ct = String(res.headers['content-type'] || '').toLowerCase()
    const buf = Buffer.from(res.data)
    if (res.status === 200 && /^(image|audio|video)\//.test(ct)) return { type: 'binary', buf, ct, status: 200 }
    let json = null
    try { json = JSON.parse(buf.toString('utf8')) } catch {}
    if (json) return { type: 'json', json, status: res.status }
    return { type: 'text', raw: buf.toString('utf8').slice(0, 300), status: res.status, ct }
}

const cleanErr = (j) => String(j?.error || j?.message || j?.msg || j?.result?.error || '').slice(0, 200)

// Pull the answer text out of whatever shape the endpoint returned.
function pickText(json) {
    const dig = (r, depth = 0) => {
        if (r == null || depth > 3) return null
        if (typeof r === 'string') return r.trim() || null
        if (Array.isArray(r)) return r.map(x => dig(x, depth + 1)).filter(Boolean).join('\n') || null
        if (typeof r === 'object') {
            for (const k of ['text', 'answer', 'response', 'reply', 'message', 'content', 'output', 'result', 'data', 'description', 'prompt'])
                if (r[k] != null) { const v = dig(r[k], depth + 1); if (v) return v }
        }
        return null
    }
    return dig(json?.result ?? json?.data ?? json?.answer ?? json?.response ?? json?.message)
}

// First http(s) URL in a JSON reply (preferring obvious media keys).
function pickUrl(json) {
    const isUrl = v => typeof v === 'string' && /^https?:\/\//i.test(v)
    const walk = (o, depth = 0) => {
        if (isUrl(o)) return o
        if (!o || typeof o !== 'object' || depth > 4) return null
        for (const k of ['url', 'image', 'image_url', 'video', 'video_url', 'audio', 'audio_url', 'download_url', 'result', 'output', 'link', 'data'])
            if (o[k] != null) { const v = walk(o[k], depth + 1); if (v) return v }
        for (const v of Object.values(o)) { const u = walk(v, depth + 1); if (u) return u }
        return null
    }
    return walk(json?.result ?? json?.data ?? json)
}

module.exports = { call, pickText, pickUrl, cleanErr, BASE }
