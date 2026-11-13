'use strict'
const config = require('../config')

// Short, plain, WhatsApp-native replies — no box-drawing borders.
// Bold title (when given) + brief line(s). Keep every message to 1-2 lines.
function box(title, lines = []) {
    const body = (lines || []).filter(l => l != null && l !== '')
    if (!body.length) return title ? `*${title}*` : ''
    return title ? `*${title}*\n${body.join('\n')}` : body.join('\n')
}

function bar(label, value) {
    return `*${label}:* ${value}`
}

function divider(label) {
    return label ? `*${label}*` : ''
}

// ── Shortcuts ────────────────────────────────────────────────────────────────
function success(t) { return `✅ ${t}` }
function error(t)   { return `❌ ${t}` }
function warn(t)    { return `⚠️ ${t}` }
function info(t)    { return `ℹ️ ${t}` }

// ── Usage card ────────────────────────────────────────────────────────────────
function usage(cmd, example, desc) {
    let msg = `⚡ *${config.prefix}${cmd}* ${example || ''}`.trim()
    if (desc) msg += `\n${desc}`
    return msg
}

// ── Permission cards ─────────────────────────────────────────────────────────
function permOwner()    { return `🔒 Owner only` }
function permAdmin()    { return `🚫 Admins only` }
function permBot()      { return `⚠️ Promote me to admin first` }
function permBotAdmin() { return `⚠️ I need admin — promote me first` }
function permGroup()    { return `🏠 Groups only` }

// ── Toggle card ───────────────────────────────────────────────────────────────
function toggle(name, on) {
    return `${on ? '🟢' : '🔴'} *${name}* ${on ? 'enabled' : 'disabled'}`
}

// ── Warn / kick cards ─────────────────────────────────────────────────────────
function warnCard(num, count, max, reason) {
    let msg = `⚠️ @${num} warned *(${count}/${max})*`
    if (reason) msg += ` — ${reason}`
    if (count >= max) msg += `\n🚫 Limit reached, removing...`
    return msg
}

function kickCard(num, reason) {
    return `🚫 @${num} removed${reason ? ` — ${reason}` : ''}`
}

// ── Confirm / processing / done ───────────────────────────────────────────────
function confirm(text) {
    return `⏳ ${text}`
}

// ── Reactions (async) ─────────────────────────────────────────────────────────
async function react(sock, msg, emoji) {
    try {
        await sock.sendMessage(msg.key.remoteJid, {
            react: { text: emoji || '⚡', key: msg.key }
        })
    } catch {}
}

async function processing(sock, msg) { await react(sock, msg, '⏳') }
async function done(sock, msg)       { await react(sock, msg, '✅') }

module.exports = {
    box, bar, divider, success, error, warn, info, usage,
    permOwner, permAdmin, permBot, permBotAdmin, permGroup,
    toggle, warnCard, kickCard, confirm,
    react, processing, done,
}
