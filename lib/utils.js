'use strict'
const config = require('../config')
const _cache = new Map()

// ── JID helpers ───────────────────────────────────────────────────────────────

function cleanJid(j) {
    if (!j) return ''
    return j.replace(/:\d+@/, '@')
}

// Display name to use in an @mention's TEXT (the mentions: [] array is what
// actually pings the person — this only controls what the "@..." reads as).
// WhatsApp only renders the fancy tappable/highlighted mention chip when the
// text is "@" + the literal digits of the mentioned number, so using a name
// here trades that highlight for a message that reads like a person wrote
// it ("Hey @Sam") instead of a phone number. The ping still fires either way.
function mentionName(msg, jid) {
    const name = String(msg?.pushName || '').trim().replace(/\s+/g, ' ')
    return name ? name.slice(0, 40) : jidToNum(jid)
}

function jidToNum(j) {
    return cleanJid(j).replace(/@.+/, '').replace(/\D/g, '')
}

function normNum(n) {
    if (!n) return ''
    return String(n).replace(/\D/g, '')
}

function numsMatch(a, b) {
    if (!a || !b) return false
    if (a === b) return true
    // last-9-digits trick covers country-code vs local format differences
    if (a.length >= 7 && b.length >= 7 && a.slice(-9) === b.slice(-9)) return true
    return false
}

// ── Message helpers ───────────────────────────────────────────────────────────

function getBody(msg) {
    const m = msg && msg.message
    if (!m) return ''
    const i = m.ephemeralMessage?.message
           || m.viewOnceMessage?.message
           || m.viewOnceMessageV2?.message
           || m
    return i.conversation
        || i.extendedTextMessage?.text
        || i.imageMessage?.caption
        || i.videoMessage?.caption
        || i.documentMessage?.caption
        // Tapping a quickReplyButton (e.g. the "Copy Link" button on `.repo`)
        // comes back as one of these two shapes depending on WhatsApp client
        // version — treat the button's id exactly like typed command text.
        || i.templateButtonReplyMessage?.selectedId
        || i.buttonsResponseMessage?.selectedButtonId
        || i.listResponseMessage?.singleSelectReply?.selectedRowId
        || ''
}

// Extracts the underlying media message from a quoted view-once message.
// WhatsApp has sent view-once content two different ways over time:
//   1. Legacy: wrapped in a viewOnceMessage / viewOnceMessageV2 container
//   2. Modern: the media message itself (imageMessage/videoMessage/audioMessage)
//      just carries a `viewOnce: true` flag, with no wrapper at all
// Older code here only checked form 1, so `.vv` failed on most recent
// view-once photos/videos even though they're perfectly readable.
function extractViewOnce(quoted) {
    if (!quoted) return null

    const wrapped = quoted.viewOnceMessage?.message
        || quoted.viewOnceMessageV2?.message
        || quoted.viewOnceMessageV2Extension?.message
    if (wrapped) return wrapped

    for (const type of ['imageMessage', 'videoMessage', 'audioMessage']) {
        if (quoted[type]?.viewOnce) return { [type]: quoted[type] }
    }
    return null
}


function getSender(msg, botJid) {
    const key = msg.key || {}

    if (key.fromMe) {
        // Bot's own outgoing message.
        // In a group the participant field is the bot's own JID.
        if (key.participant) return cleanJid(key.participant)
        // In a DM, use the bot's connected JID (most accurate).
        if (botJid)          return cleanJid(botJid)
        // Absolute fallback — use owner number from config
        return normNum(config.ownerNumber) + '@s.whatsapp.net'
    }

    // Incoming message
    if (key.participant) return cleanJid(key.participant)
    return cleanJid(key.remoteJid || '')
}

function getFrom(msg) { return msg.key?.remoteJid || '' }
function isGroup(jid) { return jid ? jid.endsWith('@g.us') : false }

// ── Owner check ───────────────────────────────────────────────────────────────

function isOwner(sender, botJid, fromMe) {
    // fromMe=true is WhatsApp's own guarantee that this message came from the
    // connected account itself — no further check needed. This is what makes
    // self-chat commands work correctly even when OWNER_NUMBER was never set
    // in .env (e.g. logging in via SESSION_ID instead of phone pairing).
    if (fromMe) return true

    const sNum = jidToNum(sender)
    if (!sNum) return false

    const ownerNum = normNum(config.ownerNumber)

    // The connected WhatsApp account is always the bot's own identity.
    // Some WhatsApp/Baileys message echoes can arrive without fromMe=true,
    // especially in self-chat or multi-device scenarios, so match sender
    // against the live connected JID as a second owner signal.
    const botNum = normNum(jidToNum(botJid))
    if (botNum && numsMatch(sNum, botNum)) return true

    // Direct match against configured owner number (when it is set).
    if (ownerNum && numsMatch(sNum, ownerNum)) return true

    // Sudo list (extra owners via env var SUDO_NUMBERS)
    const sudo = Array.isArray(config.sudoNumbers) ? config.sudoNumbers : []
    return sudo.some(n => numsMatch(sNum, normNum(n)))
}

function isPublicMode() { return !config.mode || config.mode === 'public' }

// ── Group metadata cache ──────────────────────────────────────────────────────

async function getCachedGroupMeta(sock, gid) {
    const hit = _cache.get(gid)
    if (hit && Date.now() - hit.ts < 30_000) return hit.meta
    const meta = await sock.groupMetadata(gid)
    _cache.set(gid, { meta, ts: Date.now() })
    return meta
}

function invalidateGroupCache(gid) { _cache.delete(gid) }

// ── Group / bot admin checks ──────────────────────────────────────────────────

async function isAdmin(sock, gid, sender, botJid) {
    if (isOwner(sender, botJid)) return true
    try {
        const meta = await getCachedGroupMeta(sock, gid)
        const sNum = jidToNum(sender)
        return meta.participants.some(p => {
            const pNum = jidToNum(p.id)
            return numsMatch(sNum, pNum) &&
                (p.admin === 'admin' || p.admin === 'superadmin')
        })
    } catch { return false }
}

async function isBotAdmin(sock, gid) {
    try {
        const meta = await getCachedGroupMeta(sock, gid)
        // Check both the phone-number JID and the LID (Linked ID) — WhatsApp's
        // multi-device groups sometimes list the bot's own entry under one but
        // not the other, and checking only sock.user.id gives a false "not
        // admin" even when the bot genuinely is admin.
        const botId  = sock.user?.id || ''
        const botLid = sock.user?.lid || ''
        const botIdNum  = jidToNum(botId)
        const botLidNum = jidToNum(botLid)
        if (!botIdNum && !botLidNum) return false
        const found = meta.participants.find(p => {
            const pNum = jidToNum(p.id)
            return (botIdNum && numsMatch(pNum, botIdNum)) || (botLidNum && numsMatch(pNum, botLidNum))
        })
        return found?.admin === 'admin' || found?.admin === 'superadmin'
    } catch { return false }
}

module.exports = {
    cleanJid, jidToNum, normNum, numsMatch, extractViewOnce, mentionName,
    getBody, getSender, getFrom,
    isGroup, isOwner, isPublicMode,
    isAdmin, isBotAdmin,
    getCachedGroupMeta, invalidateGroupCache,
    // legacy alias
    getCachedMeta: getCachedGroupMeta,
}
