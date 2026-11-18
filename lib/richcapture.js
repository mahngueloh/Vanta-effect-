'use strict'
// Capture tool: when a message that carries a WhatsApp "rich response"
// (richResponseMessage / botForwardedMessage) arrives — for example a Meta AI
// answer, or a game sent by another bot — save its full structure as JSON and
// send that file to your own chat. We then copy the exact working structure
// instead of guessing the undocumented parts.
const fs = require('fs')
const path = require('path')
const { sentIds } = require('./richhtml')

const KEYS = ['richResponseMessage', 'botForwardedMessage', 'unifiedResponse']
const MAX_CAPTURES = 6
const MAX_BYTES = 450 * 1024
let count = 0

const has = (o, d = 0) => {
    if (!o || typeof o !== 'object' || d > 8) return false
    for (const k of Object.keys(o)) { if (KEYS.includes(k) && o[k]) return true; if (has(o[k], d + 1)) return true }
    return false
}
const isBytes = v => v instanceof Uint8Array || (v && v.type === 'Buffer' && Array.isArray(v.data))
function clean(v, d = 0) {
    if (v == null || d > 25) return v
    if (isBytes(v)) { const b = Buffer.from(v.data || v); return 'base64:' + b.toString('base64') }
    if (typeof v === 'object' && typeof v.low === 'number' && typeof v.high === 'number') return String(v.toString ? v.toString() : v.low)
    if (Array.isArray(v)) return v.map(x => clean(x, d + 1))
    if (typeof v === 'object') {
        const out = {}
        for (const k of Object.keys(v)) {
            out[k] = clean(v[k], d + 1)
            // Make the opaque unifiedResponse.data readable next to the raw value
            if (k === 'unifiedResponse' && v[k] && v[k].data) {
                try {
                    const raw = isBytes(v[k].data) ? Buffer.from(v[k].data.data || v[k].data) : Buffer.from(String(v[k].data), 'base64')
                    out._decodedUnifiedResponse = JSON.parse(raw.toString('utf8'))
                } catch { /* not JSON, raw copy is still included */ }
            }
        }
        return out
    }
    return v
}

async function captureRich(sock, msg) {
    try {
        if (count >= MAX_CAPTURES || !msg?.message || sentIds.has(msg.key?.id)) return
        if (!has(msg.message)) return
        count++
        let json = JSON.stringify({ capturedAt: new Date().toISOString(), key: clean(msg.key), pushName: msg.pushName, message: clean(msg.message), messageContextInfo: clean(msg.message?.messageContextInfo) }, null, 2)
        if (json.length > MAX_BYTES) json = json.slice(0, MAX_BYTES)
        const dir = path.join(__dirname, '..', 'data', 'captures')
        fs.mkdirSync(dir, { recursive: true })
        const file = path.join(dir, `rich-${Date.now()}.json`)
        fs.writeFileSync(file, json)
        console.log(`[richcapture] captured ${msg.key.id} (${json.length} chars) → ${file}`)
        const me = String(sock.user?.id || '').split(':')[0].split('@')[0] + '@s.whatsapp.net'
        await sock.sendMessage(me, {
            document: Buffer.from(json), mimetype: 'application/json', fileName: path.basename(file),
            caption: '📥 Captured a rich-response message. Send this file to Claude.',
        })
    } catch (e) { console.error('[richcapture] failed:', e.message) }
}
module.exports = { captureRich }
