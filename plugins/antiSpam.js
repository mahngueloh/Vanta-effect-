const { isAdmin, isBotAdmin } = require('../lib/utils')
const { getSettings } = require('./groupSettings')
const fmt = require('../lib/format')

const LINK_REGEX = /(?:https?:\/\/|www\.|chat\.whatsapp\.com|t\.me|bit\.ly|youtu\.be)\S+/i
const SPAM_LIMIT  = 5
const SPAM_WINDOW = 5000

// ── Known WhatsApp "crash bug" message signatures ──────────────────────────
// These are the recurring families of malformed/malicious messages used to
// freeze or crash a recipient's WhatsApp — zero-width character floods,
// bidirectional-override abuse, malformed vCard payloads, absurdly long
// single messages, runs of combining marks, and scripts from a few ranges
// that some WA client versions render pathologically slowly in bulk.
const BUG_PATTERNS = [
    /waiting for this msg/i,                          // known "waiting" bug placeholder text
    /vnd\.android\.cursor\.item\/vcard/i,              // malformed vCard/contact-card payload
    // Zero-width/invisible characters are only a bug signal in bulk — a
    // single ZWJ (\u200D) is completely normal, it's what composes family
    // emoji (👨‍👩‍👧‍👦), flag emoji (🏳️‍🌈), and gendered/profession emoji.
    // Only a flood of dozens+ in a row is an actual crash payload.
    /(\u200B|\u200C|\u200D|\u2060|\uFEFF){30,}/,        // zero-width character flood
    /.{3000,}/,                                          // absurdly long single message
    /([\uD800-\uDBFF][\uDC00-\uDFFF]){50,}/,            // surrogate-pair (emoji) flood
    /(\uFFFD){20,}/,                                     // replacement-character flood
    /(\u034F){10,}/,                                     // combining grapheme joiner flood
    /https?:\/\/\S{500,}/,                               // absurdly long URL
    /(\u202E|\u202D)/,                                   // right-to-left / left-to-right override
    /(\u00AD){10,}/,                                     // soft-hyphen flood
    /(\u25A0|\u25A1){30,}/,                              // box-glyph flood
    /(\u2800){10,}/,                                     // braille blank-pattern flood
    /(\uA9BE|\uA9BF|\uA9BD|\uA9C0){3,}/,                // Javanese combining-mark abuse
    /[\u0E00-\u0E7F]{30,}/,                              // Thai block flood (rendering-cost abuse)
    /[\u1000-\u109F]{30,}/,                              // Myanmar block flood
    /[\uA980-\uA9DF]{30,}/,                              // Javanese block flood
    /[\u1B00-\u1B7F]{30,}/,                              // Balinese block flood
    /[\uFE10-\uFE1F]{10,}/,                              // vertical-forms flood
]

const warnCounts = new Map()
const WARN_MAX   = 3

// ── Shared kick registry ────────────────────────────────────────────────────
// Every kick mechanism (antispam, antibug, antibot, warn-limit, manual
// .kick/.kickall/.ban) records here, so anti-rejoin below can catch someone
// coming back regardless of which defense removed them originally.
const recentKicks = new Map()   // `${groupId}:${num}` -> timestamp
const REJOIN_WINDOW_MS = 15 * 60_000

function recordKick(groupId, jid) {
    const num = jid.replace(/[^0-9]/g, '')
    recentKicks.set(`${groupId}:${num}`, Date.now())
}

// Returns the list of JIDs it actually re-removed, so the caller can skip
// sending them a "welcome" message right after kicking them back out.
// Takes an isBannedFn callback (from groups.js) so a banned user rejoining
// gets removed indefinitely, not just within the normal 15-minute window.
async function antiRejoinCheck(sock, groupId, participants, isBannedFn) {
    const removed = []
    for (const jid of participants) {
        const num = jid.replace(/[^0-9]/g, '')
        const kickedAt = recentKicks.get(`${groupId}:${num}`)
        const withinWindow = kickedAt && (Date.now() - kickedAt <= REJOIN_WINDOW_MS)
        const permanentlyBanned = isBannedFn && isBannedFn(jid)
        if (!withinWindow && !permanentlyBanned) continue
        try {
            await sock.groupParticipantsUpdate(groupId, [jid], 'remove')
            await sock.sendMessage(groupId, {
                text: fmt.box('ANTI-REJOIN', [
                    permanentlyBanned
                        ? `🚫 @${num} is banned from this group — removed`
                        : `🚫 @${num} was removed again — still within the cooldown of their last kick`
                ]),
                mentions: [jid]
            })
            removed.push(jid)
        } catch {}
    }
    return removed
}

// ── Anti-raid ────────────────────────────────────────────────────────────────
const RAID_JOIN_THRESHOLD = 6
const RAID_WINDOW_MS      = 30_000
const RAID_LOCK_MS        = 5 * 60_000
const joinTimestamps = new Map()   // groupId -> number[]
const raidLockedUntil = new Map()  // groupId -> timestamp

async function antiRaidCheck(sock, groupId, joinCount = 1) {
    const settings = getSettings(groupId)
    if (!settings.antiraid) return
    if (raidLockedUntil.has(groupId)) return  // already locked, nothing more to do

    const now = Date.now()
    const times = (joinTimestamps.get(groupId) || []).filter(t => now - t < RAID_WINDOW_MS)
    // One 'add' event can carry several joiners at once (e.g. a burst via invite
    // link) — count every one of them, not just one per event.
    for (let i = 0; i < Math.max(1, joinCount); i++) times.push(now)
    joinTimestamps.set(groupId, times)

    if (times.length < RAID_JOIN_THRESHOLD) return

    // Locking the group needs the bot to be a group admin — without that,
    // groupSettingUpdate throws and used to be swallowed by an empty catch,
    // so the threshold could be crossed over and over with nothing visibly
    // happening at all ("antiraid isn't working"). Check first and say so.
    if (!(await isBotAdmin(sock, groupId))) {
        try {
            await sock.sendMessage(groupId, {
                text: fmt.box('ANTI-RAID', [
                    `🚨 ${times.length} joins in ${RAID_WINDOW_MS / 1000}s — this looks like a raid,`,
                    `but I'm not an admin here so I can't lock the group.`,
                    `Make me admin to let anti-raid actually enforce the lock.`,
                ])
            })
        } catch (e) { console.error('[antiraid] admin-warning failed to send:', e.message) }
        // Don't mark as "locked" — nothing was actually done, so keep
        // tracking further joins instead of going silent for 5 minutes.
        return
    }

    raidLockedUntil.set(groupId, now + RAID_LOCK_MS)
    try {
        await sock.groupSettingUpdate(groupId, 'announcement')
        await sock.sendMessage(groupId, {
            text: fmt.box('ANTI-RAID', [
                `🚨 ${times.length} joins in ${RAID_WINDOW_MS / 1000}s — group locked to admins`,
                `🔒 Auto-unlocks in ${RAID_LOCK_MS / 60_000} minutes`,
            ])
        })
    } catch (e) {
        console.error('[antiraid] failed to lock group:', e.message)
        raidLockedUntil.delete(groupId)
        return
    }

    setTimeout(async () => {
        raidLockedUntil.delete(groupId)
        joinTimestamps.delete(groupId)
        try {
            await sock.groupSettingUpdate(groupId, 'not_announcement')
            await sock.sendMessage(groupId, { text: fmt.box('ANTI-RAID', [`🔓 Lock lifted — group is open again`]) })
        } catch (e) { console.error('[antiraid] failed to unlock group:', e.message) }
    }, RAID_LOCK_MS)
}

// ── Copy-paste flood ─────────────────────────────────────────────────────────
// Catches the same message repeated slowly enough to dodge a pure
// rate-limiter (antiSpamCheck below only looks at MESSAGE COUNT per window,
// not content) — 3 identical messages from the same sender within 15s.
const COPYPASTE_REPEAT   = 3
const COPYPASTE_WINDOW_MS = 15_000
const recentMessages = new Map()   // `${groupId}:${sender}` -> { text, times: number[] }

async function copyPasteFloodCheck(sock, msg, from, sender, ownerIsUser) {
    const settings = getSettings(from)
    if (!settings.antispam) return false
    if (msg.key?.fromMe) return false   // never act on this bot's own connected account, antispare or not
    const body = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim()
    if (!body || body.length < 3) return false
    if (((await isAdmin(sock, from, sender)) || ownerIsUser) && !settings.antispare) return false

    const key = `${from}:${sender}`
    const now = Date.now()
    const entry = recentMessages.get(key)
    if (entry && entry.text === body) {
        entry.times = entry.times.filter(t => now - t < COPYPASTE_WINDOW_MS)
        entry.times.push(now)
    } else {
        recentMessages.set(key, { text: body, times: [now] })
    }
    const current = recentMessages.get(key)
    if (current.times.length < COPYPASTE_REPEAT) return false

    recentMessages.delete(key)
    await applyAction(sock, msg, from, sender, settings.antispamAction || 'kick', `Same message sent ${COPYPASTE_REPEAT}× within ${COPYPASTE_WINDOW_MS / 1000}s`)
    return true
}

// ── Memory sweeper ───────────────────────────────────────────────────────────
// All the tracking structures above are unbounded by nature (keyed by
// group/sender pairs that come and go) — without this they'd grow slowly
// for as long as the process stays up. Runs every 10 minutes, drops
// anything past its own retention window.
setInterval(() => {
    const now = Date.now()
    for (const [k, t] of recentKicks) if (now - t > REJOIN_WINDOW_MS) recentKicks.delete(k)
    for (const [k, t] of raidLockedUntil) if (now > t) raidLockedUntil.delete(k)
    for (const [k, times] of joinTimestamps) {
        const fresh = times.filter(t => now - t < RAID_WINDOW_MS)
        if (fresh.length) joinTimestamps.set(k, fresh); else joinTimestamps.delete(k)
    }
    for (const [k, entry] of recentMessages) {
        const fresh = entry.times.filter(t => now - t < COPYPASTE_WINDOW_MS)
        if (fresh.length) entry.times = fresh; else recentMessages.delete(k)
    }
    for (const [k, e] of pendingTriggers) if (now - e.at > TRIGGER_WINDOW_MS) pendingTriggers.delete(k)
    for (const [k, e] of styleBursts) if (now - e.first > STYLE_BURST_WINDOW_MS) styleBursts.delete(k)
    // bugStrikes/warnCounts have no natural expiry (they're meant to persist
    // until a strike limit is hit) — just hard-cap so a long-lived process
    // with thousands of distinct senders can't grow these unbounded.
    if (bugStrikes.size > 5000) {
        for (const k of [...bugStrikes.keys()].slice(0, bugStrikes.size - 5000)) bugStrikes.delete(k)
    }
    if (warnCounts.size > 5000) {
        for (const k of [...warnCounts.keys()].slice(0, warnCounts.size - 5000)) warnCounts.delete(k)
    }
}, 10 * 60_000)   // deliberately NOT unref'd — see the note on the news scheduler's timer for why

// ── Generic action helper ─────────────────────────────────────────────────────
async function applyAction(sock, msg, from, sender, action, reason) {
    const key   = `${from}_${sender}`
    const warns = (warnCounts.get(key) || 0) + 1
    const userNum = sender.split('@')[0]

    // Always delete the offending message first
    try { await sock.sendMessage(from, { delete: msg.key }) } catch {}

    if (action === 'warn') {
        warnCounts.set(key, warns)
        const reachedMax = warns >= WARN_MAX
        if (reachedMax) {
            warnCounts.delete(key)
            try { await sock.groupParticipantsUpdate(from, [sender], 'remove'); recordKick(from, sender) } catch {}
        }
        await sock.sendMessage(from, {
            text: fmt.warnCard(userNum, warns, WARN_MAX, reason),
            mentions: [sender]
        })
    } else if (action === 'delete') {
        await sock.sendMessage(from, {
            text: fmt.box('MESSAGE DELETED', [
                `🗑️ @${userNum} — message removed`,
                `📌 *Reason:* ${reason}`,
            ]),
            mentions: [sender]
        })
    } else if (action === 'kick') {
        try { await sock.groupParticipantsUpdate(from, [sender], 'remove'); recordKick(from, sender) } catch {}
        await sock.sendMessage(from, {
            text: fmt.kickCard(userNum, reason),
            mentions: [sender]
        })
    }
}

// ── Anti-link ─────────────────────────────────────────────────────────────────
async function antiLinkCheck(sock, msg, from, sender, ownerIsUser) {
    const s = getSettings(from)
    if (!s.antilink) return false
    if (msg.key?.fromMe) return false   // never act on this bot's own connected account, antispare or not
    const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || ''
    if (!LINK_REGEX.test(body)) return false
    if (((await isAdmin(sock, from, sender)) || ownerIsUser) && !s.antispare) return false
    await applyAction(sock, msg, from, sender, s.antilinkAction || 'warn', 'Links are not allowed in this group')
    return true
}

// ── Anti-spam ─────────────────────────────────────────────────────────────────
async function antiSpamCheck(sock, msg, from, sender, spamMap) {
    const s = getSettings(from)
    if (!s.antispam) return false
    if (msg.key?.fromMe) return false   // never act on this bot's own connected account, antispare or not
    if ((await isAdmin(sock, from, sender)) && !s.antispare) return false
    const key   = `${from}_${sender}`
    const now   = Date.now()
    const entry = spamMap.get(key) || { count: 0, first: now }
    if (now - entry.first > SPAM_WINDOW) { spamMap.set(key, { count: 1, first: now }); return false }
    entry.count++
    spamMap.set(key, entry)
    if (entry.count >= SPAM_LIMIT) {
        spamMap.delete(key)
        try { await sock.groupParticipantsUpdate(from, [sender], 'remove') } catch {}
        await sock.sendMessage(from, {
            text: fmt.kickCard(sender.split('@')[0], 'Spamming too many messages'),
            mentions: [sender]
        })
        return true
    }
    return false
}

// ── Anti-sticker ──────────────────────────────────────────────────────────────
async function antiStickerCheck(sock, msg, from, sender, ownerIsUser) {
    const s = getSettings(from)
    if (!s.antisticker || !msg.message?.stickerMessage) return false
    if (msg.key?.fromMe) return false   // never act on this bot's own connected account, antispare or not
    if (((await isAdmin(sock, from, sender)) || ownerIsUser) && !s.antispare) return false
    await applyAction(sock, msg, from, sender, s.antistickerAction || 'delete', 'Stickers are not allowed here')
    return true
}

// ── Anti-voice note ───────────────────────────────────────────────────────────
async function antiVoiceNoteCheck(sock, msg, from, sender, ownerIsUser) {
    const s = getSettings(from)
    if (!s.antivoicenote || msg.message?.audioMessage?.ptt !== true) return false
    if (msg.key?.fromMe) return false   // never act on this bot's own connected account, antispare or not
    if (((await isAdmin(sock, from, sender)) || ownerIsUser) && !s.antispare) return false
    await applyAction(sock, msg, from, sender, s.antivoicenoteAction || 'delete', 'Voice notes are not allowed here')
    return true
}

const bugStrikes = new Map()
const DM_STRIKE_LIMIT    = 3   // DM: blocked after this many bug messages
const GROUP_STRIKE_LIMIT = 4   // Group: kicked after this many bug messages
const EMOJI_SPAM_LIMIT   = 100
const MENTION_SPAM_LIMIT = 20
const LENGTH_SPAM_LIMIT  = 5000
const EMOJI_REGEX = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu

// Extra bug signatures beyond the base BUG_PATTERNS set above — patterns
// specifically known to get smuggled through fields other than plain body
// text (captions, filenames, contact cards), so these get checked against
// every field extractScannableText() below pulls out, not just body text.
const EXTRA_BUG_PATTERNS = [
    /(\uD83C[\uDDE6-\uDDFF]){20,}/,                       // regional-indicator (flag emoji) flood
    /(\uA9BE|\uA9BF){10,}/,                               // Javanese ornament/punctuation spam
    /@broadcast\b.{0,50}@broadcast\b.{0,50}@broadcast\b/i, // repeated @broadcast injection attempts
]

// "Any short chunk repeated 60+ times" — deliberately NOT a backreference
// regex like /(.{1,20})\1{60,}/: that shape is a classic ReDoS risk on
// adversarial input (a crafted near-repeat can force catastrophic
// backtracking), which is exactly the kind of input a bug payload is. This
// does the same detection with a bounded, non-backtracking loop instead.
function hasRepeatedChunkFlood(str) {
    if (str.length < 120) return false
    for (let chunkLen = 1; chunkLen <= 20; chunkLen++) {
        const chunk = str.slice(0, chunkLen)
        let repeats = 0
        for (let i = 0; i + chunkLen <= str.length; i += chunkLen) {
            if (str.slice(i, i + chunkLen) !== chunk) break
            repeats++
        }
        if (repeats >= 60) return true
    }
    return false
}

// Pulls every field a bug payload could realistically hide in: plain text,
// image/video captions, document filenames, and contact-card (vCard)
// content — not just the message body. A payload that only shows up in one
// of these used to sail through entirely.
function extractScannableText(msg) {
    const m = msg.message || {}
    return [
        m.conversation,
        m.extendedTextMessage?.text,
        m.imageMessage?.caption,
        m.videoMessage?.caption,
        m.documentMessage?.caption,
        m.documentMessage?.fileName,
        m.contactMessage?.displayName,
        m.contactMessage?.vcard,
        ...(m.contactsArrayMessage?.contacts || []).flatMap(c => [c.displayName, c.vcard]),
    ].filter(Boolean).join('\n')
}

// Runs every detection vector over one message and reports what tripped.
function detectBugMessage(msg, body) {
    if (body.length > LENGTH_SPAM_LIMIT) return 'Long text spam'
    const emojiCount = (body.match(EMOJI_REGEX) || []).length
    if (emojiCount > EMOJI_SPAM_LIMIT) return 'Emoji spam'
    const mentionCount = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length || 0
    if (mentionCount > MENTION_SPAM_LIMIT) return 'Mention spam'
    if (BUG_PATTERNS.some(p => p.test(body))) return 'Malformed/crash payload'
    if (EXTRA_BUG_PATTERNS.some(p => p.test(body))) return 'Malformed/crash payload (caption/filename/contact)'
    if (hasRepeatedChunkFlood(body)) return 'Repeated-chunk flood'
    return null
}

// Shared strike bookkeeping for both the group and DM checks below —
// delete the message, bump the sender's strike count, and report back
// whether the limit was reached so the caller can kick/block.
async function recordBugStrike(sock, msg, from, sender) {
    try { await sock.sendMessage(from, { delete: msg.key }) } catch {}
    const strikes = (bugStrikes.get(sender) || 0) + 1
    bugStrikes.set(sender, strikes)
    return strikes
}

// ── Anti-bug (groups) ───────────────────────────────────────────────────────
async function antiBugCheck(sock, msg, from, sender, ownerIsUser) {
    const s = getSettings(from)
    if (!s.antibug) return false
    if (msg.key?.fromMe) return false   // never act on this bot's own connected account, antispare or not
    const body = extractScannableText(msg)
    const bugType = detectBugMessage(msg, body)
    if (!bugType) return false
    if (((await isAdmin(sock, from, sender)) || ownerIsUser) && !s.antispare) return false

    const num = sender.split('@')[0]
    const strikes = await recordBugStrike(sock, msg, from, sender)

    if (strikes >= GROUP_STRIKE_LIMIT) {
        bugStrikes.delete(sender)
        try { await sock.groupParticipantsUpdate(from, [sender], 'remove') } catch {}
        await sock.sendMessage(from, {
            text: fmt.box('MAHNGUELOH VANTA — ANTIBUG', [
                `🚫 @${num} removed — bug message (${bugType})`,
                `Strike ${strikes}/${GROUP_STRIKE_LIMIT}`,
            ]),
            mentions: [sender]
        })
    } else {
        await sock.sendMessage(from, {
            text: fmt.box('MAHNGUELOH VANTA — ANTIBUG', [
                `⚠️ @${num} — message deleted (${bugType})`,
                `Strike ${strikes}/${GROUP_STRIKE_LIMIT} — removed at ${GROUP_STRIKE_LIMIT}`,
            ]),
            mentions: [sender]
        })
    }
    return true
}

// ── Anti-bug (DMs — protects the owner's own inbox) ─────────────────────────
// Gated by the owner-level runtimeSettings.antibug toggle (`.antibug`), not
// group settings — this runs on the bot's private chats. A lower strike
// limit than groups: there's no "community" to weigh here, just the
// owner's own number, so it blocks sooner.
async function antiBugCheckDM(sock, msg, from, sender, ownerIsUser, enabled) {
    if (!enabled || ownerIsUser) return false
    const body = extractScannableText(msg)
    const bugType = detectBugMessage(msg, body)
    if (!bugType) return false

    const strikes = await recordBugStrike(sock, msg, from, sender)

    if (strikes >= DM_STRIKE_LIMIT) {
        bugStrikes.delete(sender)
        try { await sock.updateBlockStatus(sender, 'block') } catch {}
        console.log(`[ANTIBUG] Blocked ${sender} — bug message (${bugType}), strike ${strikes}/${DM_STRIKE_LIMIT}`)
    } else {
        await sock.sendMessage(from, {
            text: fmt.box('MAHNGUELOH VANTA — ANTIBUG', [
                `⚠️ Message deleted (${bugType})`,
                `Strike ${strikes}/${DM_STRIKE_LIMIT} — blocked at ${DM_STRIKE_LIMIT}`,
            ])
        })
    }
    return true
}

// ── Anti-group-mention ────────────────────────────────────────────────────────
async function antiGroupMentionCheck(sock, msg, from, sender, ownerIsUser) {
    const s = getSettings(from)
    if (!s.antigroupmention) return false
    if (msg.key?.fromMe) return false   // never act on this bot's own connected account, antispare or not
    const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
    const hasGroupMention =
        /@(everyone|all|here|group)/i.test(body) ||
        (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length || 0) > 5
    if (!hasGroupMention) return false
    if (((await isAdmin(sock, from, sender)) || ownerIsUser) && !s.antispare) return false
    await applyAction(sock, msg, from, sender, s.antigroupmentionAction || 'delete', 'Mass group mentions are not allowed')
    return true
}

// ── Anti-bot v2: weighted multi-signal scoring ──────────────────────────────
// v1 used flat yes/no rules (5+ bulleted lines, or 2+ bulleted lines right
// after a trigger) — bots could slip under that bar with short replies, and
// it only ever looked at structure. v2 scores every independent signal and
// flags at a threshold, so evidence accumulates: one weak signal alone
// never kicks anyone, several together reliably nail a bot regardless of
// its specific decoration style.
//
// Signals (decoration-independent where possible):
//   SELF-IDENTIFICATION — bots often say what they are outright. Split into
//      a strong tier (unambiguous — "this is a whatsapp bot", "xlicon") and
//      a weak tier (engine/topic names like "baileys", "wolfsocket",
//      "pairing code") that are NOT enough alone — this bot's own group is
//      about bot development, where those words show up in completely
//      normal human conversation ("anyone know how to fix a baileys bug"),
//      so a bare mention must combine with another signal to flag.
//   SMALL-CAPS SIGNATURE — stylized bot menus are overwhelmingly written in
//      Unicode small caps (ʜᴇʟᴘ, ᴍᴇɴᴜ, ɢʀᴏᴜᴘ). Humans essentially never type
//      these. A pure Unicode-class match — no glyph list to maintain, and
//      catches short bot replies that don't have enough lines to trip a
//      bullet-count check.
//   STATUS WORDING — menu/commands/prefix/owner/uptime/runtime/version...
//   STRUCTURE — bullet lines and box-drawing border characters, scored by
//      degree rather than a hard yes/no cutoff.
//   BEHAVIOR — foreign-prefix commands, structured output right after a
//      trigger (only counts alongside a real bot signal, so a human's
//      grocery list right after someone's .menu isn't enough on its own),
//      and repeated bot-style output from the same sender in a short window.
const BOT_WORDING_PATTERN = /\b(menu|commands?|prefix|owner|uptime|runtime|version|platform|speed|ping|alive|usage|powered\s*by|repo)\b/i
const SELF_ID_STRONG = /(whatsapp\s*bot|multi[\s-]?device\s*bot|xlicon)/i
const SELF_ID_WEAK   = /(session\s*id|md\s*bot|bot\s*by|baileys|whiskeysockets|wolfsocket|pairing\s*code|pair\s*code)/i
const SMALLCAPS_CHARS = /[\u1D00-\u1D25\u1D2C-\u1D6A\uA730-\uA77F]/g
const BOX_BORDER_CHARS = /[╭╮╰╯┏┓┗┛╔╗╚╝═║─━│┃┆┊├┤┬┴┼]/g
const BULLET_LINE_PATTERN = /^\s*[^a-zA-Z0-9\s]/u   // line's first visible char isn't alphanumeric
const NUMBERED_CMD_LINE = /^\s*\d{1,3}\s*[.)\]]\s*[\p{L}\p{N}]/u

// A "PONG" reply carrying latency + uptime together is a fingerprint nobody
// ever produces by hand — it's what .ping handlers across EVERY bot
// codebase print, brand-name styling aside. Treated as strong as openly
// saying "I'm a bot", because functionally it's the same admission.
const PING_REPLY_FINGERPRINT = /\bpong\b/i
const LATENCY_WORD = /\b(latency|response\s*time)\b.{0,15}?\d+\s*m?s\b/i
const UPTIME_WORD   = /\buptime\b.{0,20}?\d/i

// Bot status/menu cards are almost always a stack of "Label: value" lines
// (Dev:, Cmds:, Server:, Speed:, RAM:, Mode:, Prefix:, Owner:, Version:,
// Host:, Platform:) — a shape that basically never occurs in normal human
// chat. Counting these catches a bot's menu/status output even when its
// wording, branding and layout are completely different from ours.
const STATUS_LABEL_LINE = /^\s*[\p{L}][\p{L}\s/_-]{1,24}\s*[:：]\s*\S/u
function countStatusLabelLines(body) {
    return body.split('\n').filter(l => STATUS_LABEL_LINE.test(l)).length
}

function countBulletLines(body) {
    return body.split('\n').filter(l => l.trim() && BULLET_LINE_PATTERN.test(l)).length
}

// Scores one message body. `context` carries behavior signals gathered by
// the caller: { recentTrigger, senderBurst }.
function scoreBotLikeness(body, context = {}) {
    if (!body) return { score: 0, reasons: [] }
    const reasons = []
    let score = 0

    if (SELF_ID_STRONG.test(body)) { score += 4; reasons.push('openly identifies as a bot') }
    else if (SELF_ID_WEAK.test(body)) { score += 2; reasons.push('bot-related wording') }

    if (PING_REPLY_FINGERPRINT.test(body) && LATENCY_WORD.test(body) && UPTIME_WORD.test(body)) {
        score += 4; reasons.push('ping-reply fingerprint (pong+latency+uptime)')
    }

    const statusLines = countStatusLabelLines(body)
    if (statusLines >= 4) { score += 4; reasons.push(`${statusLines}-field status card`) }
    else if (statusLines >= 2) { score += 2; reasons.push(`${statusLines}-field status card`) }

    // A bare "pairing code" mention is casual dev-talk (see above), but an
    // actual code-shaped value alongside it is a different thing entirely —
    // nobody casually pastes what looks like a real pairing code in chat.
    if (/pairing?\s*code/i.test(body) && /\b[A-Z0-9]{4}[- ][A-Z0-9]{4}\b/.test(body)) {
        score += 2; reasons.push('actual pairing code value present')
    }

    const smallCaps = (body.match(SMALLCAPS_CHARS) || []).length
    if (smallCaps >= 5) { score += 2; reasons.push('small-caps signature') }

    const wording = BOT_WORDING_PATTERN.test(body)
    if (wording) { score += 1; reasons.push('status wording') }

    const bulletLines = countBulletLines(body)
    if (bulletLines >= 5) { score += 3; reasons.push(`${bulletLines} structured lines`) }
    else if (bulletLines >= 3) { score += 1; reasons.push(`${bulletLines} structured lines`) }

    const boxChars = (body.match(BOX_BORDER_CHARS) || []).length
    if (boxChars >= 6) { score += 2; reasons.push('box-drawing frame') }

    const numberedLines = body.split('\n').filter(l => NUMBERED_CMD_LINE.test(l)).length
    if (numberedLines >= 3) { score += 1; reasons.push('numbered command list') }

    // Trigger bonus only counts when the message ALSO has a non-structural
    // bot signal — a plain human list right after a command (groceries
    // after someone typed .menu) must NOT be enough on its own.
    if (context.recentTrigger && (wording || smallCaps >= 3 || boxChars >= 6)) {
        score += 2; reasons.push('automated reply after trigger')
    }
    if (context.senderBurst) { score += 2; reasons.push('repeated bot-style output') }

    return { score, reasons }
}

const BOT_SCORE_THRESHOLD = 4
const FOREIGN_PREFIX_PATTERN = /^[^\w\s][a-zA-Z]/u   // any short symbol/emoji + a letter — not just a fixed set

function looksLikeForeignBotCommand(body, ownPrefix) {
    const trimmed = (body || '').trim()
    if (!trimmed || !FOREIGN_PREFIX_PATTERN.test(trimmed)) return false
    // Starts with this bot's own prefix → it's a normal command for us,
    // never flag it (this is what makes it safe to run for every message,
    // not just non-commands).
    if (ownPrefix && trimmed.startsWith(ownPrefix)) return false
    return true
}

// Per-group memory of "someone just sent something command-shaped" so a
// suspicious reply that follows shortly after can be attributed to it.
// Bounded and self-cleaning: one entry per group, overwritten on the next
// trigger, expired by TRIGGER_WINDOW_MS on read.
const pendingTriggers = new Map()   // groupJid -> { at }
const TRIGGER_WINDOW_MS = 20_000

function markPossibleTrigger(groupJid, body, ownPrefix) {
    const trimmed = (body || '').trim()
    const isCommandShaped = FOREIGN_PREFIX_PATTERN.test(trimmed) || (ownPrefix && trimmed.startsWith(ownPrefix))
    const isBareTriggerWord = /^(menu|help|start|hi|hello)$/i.test(trimmed)
    if (isCommandShaped || isBareTriggerWord) {
        pendingTriggers.set(groupJid, { at: Date.now() })
    }
}

function hasRecentTrigger(groupJid) {
    const t = pendingTriggers.get(groupJid)
    if (!t) return false
    if (Date.now() - t.at > TRIGGER_WINDOW_MS) { pendingTriggers.delete(groupJid); return false }
    return true
}

// Per-sender counter of bot-STYLE outputs: even if each individual message
// scores under threshold, a non-admin producing structured bot-looking
// output repeatedly within a short window is itself strong evidence.
const styleBursts = new Map()   // `${groupJid}_${sender}` -> { count, first }
const STYLE_BURST_WINDOW_MS = 45_000
const STYLE_BURST_MIN_SCORE = 3   // a message must clear a weak-signal-alone level to count toward a burst — e.g. a bare "baileys" mention (self-id-weak = 2) shouldn't itself feed the burst counter

function noteStyleBurst(groupJid, sender, score) {
    if (score < STYLE_BURST_MIN_SCORE) return false
    const key = `${groupJid}_${sender}`
    const now = Date.now()
    const e = styleBursts.get(key)
    if (!e || now - e.first > STYLE_BURST_WINDOW_MS) {
        styleBursts.set(key, { count: 1, first: now })
        return false
    }
    e.count++
    if (e.count >= 2) { styleBursts.delete(key); return true }
    styleBursts.set(key, e)
    return false
}

// A message ID generated by ANY Baileys-based client — official or a
// rebranded fork — is always a 4-character prefix followed by 12 uppercase
// hex characters (crypto.randomBytes(6).toString('hex').toUpperCase()).
// Real WhatsApp apps (Android/iOS/Web) never produce that exact shape, so
// this alone is a near-zero-false-positive signal, and it catches a foreign
// bot's very FIRST message — even a blank one — instead of waiting for its
// text to look bot-like. This is what makes antibot "strong": it's proof of
// how the message was generated, not a guess based on its content.
function hasBaileysMessageId(msg) {
    const id = msg.key?.id || ''
    return /^[A-Z0-9]{4}[0-9A-F]{12}$/.test(id)
}

async function antiBotCheck(sock, msg, from, sender, ownerIsUser, ownPrefix) {
    const s = getSettings(from)
    if (!s.antibot) return false
    if (msg.key?.fromMe) return false   // never flag this bot's own messages
    // Commands are typed as plain text — check that narrowly. But bot
    // OUTPUT (the thing that actually needs catching) very often rides on
    // an image/document caption instead of plain text — exactly what
    // happened here: an "AUDIO DOWNLOADER" card is cover art with the
    // title/duration/status info as the image's CAPTION, not the message
    // body. Scanning only conversation/extendedTextMessage missed it
    // entirely regardless of how good the scoring itself was.
    const commandBody = msg.message?.conversation || msg.message?.extendedTextMessage?.text || ''
    const body = extractScannableText(msg)

    const looksCommanded = looksLikeForeignBotCommand(commandBody, ownPrefix)
    const isAdminSender = (await isAdmin(sock, from, sender)) || ownerIsUser

    // Any command-shaped message (or bare "menu"/"help") primes the trigger
    // window, regardless of sender — even the owner's own .menu can prompt
    // a coincidentally-listening foreign bot to answer, and it's that
    // answer we actually care about catching.
    markPossibleTrigger(from, commandBody, ownPrefix)

    const recentTrigger = hasRecentTrigger(from)
    const burst = noteStyleBurst(from, sender, scoreBotLikeness(body, { recentTrigger }).score)
    const { score, reasons } = scoreBotLikeness(body, { recentTrigger, senderBurst: burst })
    const idIsBaileys = hasBaileysMessageId(msg)

    const flagged = looksCommanded || idIsBaileys || score >= BOT_SCORE_THRESHOLD
    if (!flagged) return false
    if (isAdminSender && !s.antispare) return false

    const why = looksCommanded
        ? 'Commanding another bot is not allowed here'
        : idIsBaileys
            ? 'Message was generated by automation software, not sent from a real WhatsApp app'
            : `Bot-like output detected (${reasons.slice(0, 3).join(', ')})`

    // Two or more INDEPENDENT strong signals agreeing (e.g. a Baileys-shaped
    // ID on a message that's also a textbook ping/status card) isn't a
    // borderline call — nothing produces that combination except another
    // bot. For evidence this one-sided, don't make the group sit through
    // three warnings while the foreign bot keeps right on answering
    // commands in the meantime: remove it immediately, regardless of
    // whatever action is configured for the merely-probable cases below.
    const overwhelming = (idIsBaileys && score >= 4) || score >= 8
    const action = overwhelming ? 'kick' : (s.antibotAction || 'warn')

    await applyAction(sock, msg, from, sender, action, overwhelming ? `${why} — high-confidence match, removed immediately` : why)
    pendingTriggers.delete(from)
    return true
}

module.exports = { antiLinkCheck, antiSpamCheck, antiStickerCheck, antiVoiceNoteCheck, antiBugCheck, antiBugCheckDM, antiGroupMentionCheck, antiBotCheck, antiRejoinCheck, antiRaidCheck, copyPasteFloodCheck, recordKick }
