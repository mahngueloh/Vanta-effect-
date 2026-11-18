'use strict'
// ─────────────────────────────────────────────────────────────────────────────
// Arcade: real, playable HTML games (Flappy Bird, Turbo Highway, Snake, Dino).
// Each game is one self-contained .html file in assets/arcade/. The bot sends it
// as a document; the player taps it and it opens and plays in their browser
// (touch + keyboard, best score saved on their device). No packages, no server.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs')
const path = require('path')
const config = require('../config')
const { sendRichHtml } = require('../lib/richhtml')

const DIR = path.join(__dirname, '..', 'assets', 'arcade')
const RICH_DIR = path.join(DIR, 'rich')
const GAMES = [
    { id: 'flappy', file: 'flappy.html', title: 'Flappy Bird',   emoji: '🐦', cmds: ['flappy', 'flappybird'],        how: 'Tap to flap, dodge the pipes' },
    { id: 'racer',  file: 'racer.html',  title: 'Turbo Highway', emoji: '🏎️', cmds: ['racer', 'turbo', 'highway'],   how: 'Swipe or LEFT/RIGHT, hold BOOST' },
    { id: 'snake',  file: 'snake.html',  title: 'Snake',         emoji: '🐍', cmds: ['snake'],                       how: 'Swipe or tap the arrows' },
    { id: 'dino',   file: 'dino.html',   title: 'Dino Run',      emoji: '🦖', cmds: ['dino', 'dinorun'],             how: 'Tap to jump over cacti' },
]
const byCmd = new Map()
for (const g of GAMES) for (const c of g.cmds) byCmd.set(c, g)
const arcadeCmds = new Set(['arcade', 'arcadegames', 'stop', 'stopgame', 'closegame', ...byCmd.keys()])
const P = () => config.prefix || '.'

// ── Auto-close: an in-chat game message is deleted 2 hours after it was sent
// (ARCADE_CLOSE_MIN to change), or immediately with .stop. The bot can't see
// taps inside the game, so the 2 hours counts from when the game was sent.
const CLOSE_MS = (Number(process.env.ARCADE_CLOSE_MIN) || 120) * 60 * 1000
const SESSIONS_FILE = path.join(__dirname, '..', 'data', 'arcade-sessions.json')
const sessions = new Map()       // message id -> { jid, id, title, at, timer }
let liveSock = null

function persist() {
    try {
        fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true })
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify([...sessions.values()].map(({ jid, id, title, at }) => ({ jid, id, title, at }))))
    } catch {}
}

async function closeSession(id, why) {
    const s = sessions.get(id)
    if (!s) return false
    clearTimeout(s.timer)
    sessions.delete(id)
    persist()
    try {
        await liveSock.sendMessage(s.jid, { delete: { remoteJid: s.jid, fromMe: true, id: s.id } })
        console.log(`[arcade] closed ${s.title} (${why}) in ${s.jid}`)
        return true
    } catch (e) { console.log(`[arcade] could not close ${s.id}: ${e.message}`); return false }
}

function track(jid, id, title, at = Date.now()) {
    const left = Math.max(0, CLOSE_MS - (Date.now() - at))
    const timer = setTimeout(() => closeSession(id, 'idle timeout'), left)
    if (timer.unref) timer.unref()
    sessions.set(id, { jid, id, title, at, timer })
    persist()
}

// Call once the bot is connected: re-arms timers saved before a restart/redeploy.
function restoreArcade(sock) {
    liveSock = sock
    try {
        for (const r of JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'))) if (!sessions.has(r.id)) track(r.jid, r.id, r.title, r.at)
    } catch {}
}

async function handleArcade(sock, from, cmd, args, msg, sender) {
    liveSock = sock
    if (cmd === 'stop' || cmd === 'stopgame' || cmd === 'closegame') {
        const mine = [...sessions.values()].filter(x => x.jid === from)
        if (!mine.length) return sock.sendMessage(from, { text: '🕹️ No game is open in this chat.' }, { quoted: msg })
        for (const x of mine) await closeSession(x.id, 'stopped')
        return sock.sendMessage(from, { text: `🛑 Closed ${mine.length} game${mine.length > 1 ? 's' : ''}.` }, { quoted: msg })
    }
    if (cmd === 'arcade' || cmd === 'arcadegames') {
        const lines = GAMES.map(g => `${g.emoji} *${P()}${g.cmds[0]}* — ${g.title}\n      _${g.how}_`)
        return sock.sendMessage(from, {
            text: `🕹️ *ARCADE*\n\n${lines.join('\n\n')}\n\n` +
                  `_Games play right inside the chat and close themselves after ${Math.round(CLOSE_MS / 60000)} min. Use *${P()}stop* to close one now. Add *file* (e.g. ${P()}snake file) to get the game as a file instead._`
        }, { quoted: msg })
    }
    const g = byCmd.get(cmd)
    if (!g) return
    // Default: play live inside the chat bubble. "file" → send as an .html document instead.
    if (!/^(file|doc|html)$/i.test(String(args?.[0] || ''))) {
        try {
            const html = fs.readFileSync(path.join(RICH_DIR, g.file), 'utf8')
            const sent = await sendRichHtml(sock, from, html, { title: g.title })
            track(from, sent.key.id, g.title)
            return sent
        } catch (e) { console.log(`[arcade] in-chat send failed for ${g.id}: ${e.message} — falling back to file`) }
    }
    let buf
    try { buf = fs.readFileSync(path.join(DIR, g.file)) }
    catch { return sock.sendMessage(from, { text: `❌ ${g.title} is missing on this server.` }, { quoted: msg }) }
    return sock.sendMessage(from, {
        document: buf,
        mimetype: 'text/html',
        fileName: `${g.title.replace(/\s+/g, '-')}.html`,
        caption: `${g.emoji} *${g.title}*\n${g.how}\n\n_Tap the file → open in browser to play. Your best score is saved on your phone._`,
    }, { quoted: msg })
}

module.exports = { arcadeCmds, handleArcade, restoreArcade, GAMES }
