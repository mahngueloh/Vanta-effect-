'use strict'
// Keeps every view-once photo/video/voice note the bot receives (downloaded the moment it
// arrives) so `.vv` can still reveal it AFTER it has been opened — once opened, WhatsApp
// strips the media from the quoted message and it can no longer be downloaded.
const { extractViewOnce } = require('./utils')

const store = new Map()          // messageId -> { buf, mtype, mimetype, ptt, at }
const MAX_TOTAL = 80 * 1024 * 1024
const MAX_ONE = 30 * 1024 * 1024
const MAX_AGE = 12 * 3600 * 1000
let total = 0

function prune() {
    const now = Date.now()
    for (const [k, v] of store) {
        if (now - v.at > MAX_AGE || total > MAX_TOTAL) { total -= v.buf.length; store.delete(k) }
    }
}

async function cache(sock, msg) {
    try {
        if (!msg?.message || !msg.key?.id) return
        const vMsg = extractViewOnce(msg.message)
        if (!vMsg) return
        const mtype = Object.keys(vMsg)[0]
        const inner = vMsg[mtype]
        if (inner?.fileLength && Number(inner.fileLength) > MAX_ONE) return
        const { downloadMediaMessage } = require('@neoxr/baileys')
        const silent = { level: 'silent', child: () => silent, info() {}, debug() {}, error() {}, warn() {}, trace() {} }
        const buf = await downloadMediaMessage({ message: vMsg, key: msg.key }, 'buffer', {}, { logger: silent, reuploadRequest: sock.updateMediaMessage })
        if (!buf?.length) return
        store.set(msg.key.id, { buf, mtype, mimetype: inner.mimetype, ptt: !!inner.ptt, caption: inner.caption || '', at: Date.now() })
        total += buf.length
        prune()
        console.log(`[vv-cache] stored ${mtype} ${msg.key.id} (${(buf.length / 1024) | 0} KB)`)
    } catch (e) { console.error('[vv-cache] failed:', e.message) }
}

const get = id => store.get(id) || null

module.exports = { cache, get }
