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

const DIR = path.join(__dirname, '..', 'assets', 'arcade')
const GAMES = [
    { id: 'flappy', file: 'flappy.html', title: 'Flappy Bird',   emoji: '🐦', cmds: ['flappy', 'flappybird'],        how: 'Tap to flap, dodge the pipes' },
    { id: 'racer',  file: 'racer.html',  title: 'Turbo Highway', emoji: '🏎️', cmds: ['racer', 'turbo', 'highway'],   how: 'Swipe or LEFT/RIGHT, hold BOOST' },
    { id: 'snake',  file: 'snake.html',  title: 'Snake',         emoji: '🐍', cmds: ['snake'],                       how: 'Swipe or tap the arrows' },
    { id: 'dino',   file: 'dino.html',   title: 'Dino Run',      emoji: '🦖', cmds: ['dino', 'dinorun'],             how: 'Tap to jump over cacti' },
]
const byCmd = new Map()
for (const g of GAMES) for (const c of g.cmds) byCmd.set(c, g)
const arcadeCmds = new Set(['arcade', 'arcadegames', ...byCmd.keys()])
const P = () => config.prefix || '.'

async function handleArcade(sock, from, cmd, args, msg, sender) {
    if (cmd === 'arcade' || cmd === 'arcadegames') {
        const lines = GAMES.map(g => `${g.emoji} *${P()}${g.cmds[0]}* — ${g.title}\n      _${g.how}_`)
        return sock.sendMessage(from, {
            text: `🕹️ *ARCADE*\n\n${lines.join('\n\n')}\n\n` +
                  `_The bot sends the game as a file. Tap it and open it in your browser (Chrome) to play._`
        }, { quoted: msg })
    }
    const g = byCmd.get(cmd)
    if (!g) return
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

module.exports = { arcadeCmds, handleArcade, GAMES }
