'use strict'

// WhatsApp's "delete for everyone" event only tells the bot which message ID
// was revoked — it never re-sends the original content. So to forward a
// deleted message anywhere, the bot has to have already cached that message
// the moment it first arrived, before it got deleted.
//
// This is a small in-memory cache (no DB needed): every incoming message is
// saved here as it arrives, keyed by chat + message id, and pruned after an
// hour or once the cache grows past MAX_ENTRIES — WhatsApp only allows
// deleting fairly recent messages anyway, so there's no value in keeping
// entries around indefinitely.

const store = new Map()
const MAX_ENTRIES = 800
const MAX_AGE_MS  = 60 * 60 * 1000   // 1 hour

function key(jid, id) {
    return `${jid}::${id}`
}

function save(jid, id, entry) {
    if (!jid || !id) return
    store.set(key(jid, id), { ...entry, savedAt: Date.now() })
    if (store.size > MAX_ENTRIES) {
        const oldestKey = store.keys().next().value
        store.delete(oldestKey)
    }
}

function get(jid, id) {
    const k = store.get(key(jid, id))
    if (!k) return null
    if (Date.now() - k.savedAt > MAX_AGE_MS) {
        store.delete(key(jid, id))
        return null
    }
    return k
}

// Periodic sweep so long-idle entries don't linger until the next save().
const sweepTimer = setInterval(() => {
    const now = Date.now()
    for (const [k, v] of store) {
        if (now - v.savedAt > MAX_AGE_MS) store.delete(k)
    }
}, 5 * 60 * 1000)
sweepTimer.unref?.()

module.exports = { save, get }
