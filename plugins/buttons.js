'use strict'
// Interactive button commands — savage-tech style, MAHNGUELOH VANTA flavored.
const config = require('../config')
const fmt    = require('../lib/format')
const { loadBtns, btnsReady, registerButtonAction, replyBtn } = require('../lib/buttons')
const { sendMenu } = require('./menu')

const FOOTER = `${config.botName} \u2022 ${config.ownerName}`

// Shared branded card: bot name + link buttons, like the savage-tech
// "Download ZIP / Open Repo / Fork / Support" row.
async function sendLinkCard(sock, from, msg, { title, text, urlLabel, url }) {
    const mod = await loadBtns()
    if (!btnsReady()) {
        return sock.sendMessage(from, { text: fmt.box(title, [text, url ? `\n\u{1F517} ${url}` : '']) }, { quoted: msg })
    }
    await mod.sendButtons(sock, from, {
        text: `*${title}*\n\n${text}`,
        footer: FOOTER,
        buttons: [mod.btn.url(urlLabel, url)],
        contextInfo: { mentionedJid: [msg.key.participant || msg.key.remoteJid] },
    }, { quoted: msg })
}

// Full demo: every button type spencer-btns offers.
async function sendButtonsDemo(sock, from, sender, msg, args) {
    const mod = await loadBtns()
    if (!btnsReady()) {
        return sock.sendMessage(from, {
            text: fmt.error('Interactive buttons unavailable \u2014 spencer-btns is not installed. Run: npm install spencer-btns, then restart.'),
        }, { quoted: msg })
    }

    const sub = (args[0] || '').toLowerCase()
    const who = msg.key.participant || msg.key.remoteJid

    if (sub === 'list') {
        return mod.sendButtons(sock, from, {
            text: `\u{1F4CB} *${config.botName} \u2014 pick a category*`,
            footer: FOOTER,
            buttons: [
                mod.btn.list('Open Menu', [
                    { title: 'General', rows: [
                        { title: 'Bot Menu',  description: 'See all commands',   id: 'btn_menu' },
                        { title: 'Ping',      description: 'Check latency',      id: 'btn_ping' },
                    ]},
                    { title: 'Owner', rows: [
                        { title: 'Owner Info', description: 'Who runs this bot', id: 'btn_owner' },
                        { title: 'Support',    description: 'Get help',          id: 'btn_support' },
                    ]},
                ])
            ],
            contextInfo: { mentionedJid: [who] },
        }, { quoted: msg })
    }

    return mod.sendButtons(sock, from, {
        text: `\u{1F39F}\uFE0F *${config.botName}* \u2014 interactive menu\n\nTap a button below:`,
        footer: FOOTER,
        buttons: [
            mod.btn.url('\u{1F4E6} Download ZIP', 'https://github.com/'),
            mod.btn.url('\u{1F310} Open Repo',    'https://github.com/'),
            replyBtn(mod, '\u{1F3D3} Ping',       'btn_ping', pingAction),
            replyBtn(mod, '\u{1F4CB} Menu',       'btn_menu', menuAction),
            mod.btn.copy('\u{1F4CB} Copy Prefix', config.prefix || '.'),
            mod.btn.call('\u{260E}\uFE0F Call Support', `+${config.ownerNumber}`),
        ],
        contextInfo: { mentionedJid: [who] },
    }, { quoted: msg })
}

// ── Reply-button actions (function declarations are hoisted, so these are
// usable inside sendButtonsDemo above via replyBtn(), regardless of order) ──
async function pingAction(sock, from) {
    return sock.sendMessage(from, { text: fmt.box('PONG', ['\u{1F3D3} Buttons are *alive*']) })
}
async function menuAction(sock, from, sender, msg) {
    return sendMenu(sock, from, sender, msg)
}

registerButtonAction('btn_owner', async (sock, from) => sock.sendMessage(from, {
    text: fmt.box('OWNER', [`\u{1F464} *${config.ownerName}*`, `\u{1F4F1} wa.me/${config.ownerNumber}`]),
}))
registerButtonAction('btn_support', async (sock, from) => sock.sendMessage(from, {
    text: fmt.box('SUPPORT', [`Contact *${config.ownerName}*: wa.me/${config.ownerNumber}`]),
}))

module.exports = { sendButtonsDemo, sendLinkCard }
