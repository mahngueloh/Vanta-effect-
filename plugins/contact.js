'use strict'
// Contact-the-owner card. Plain text by default; upgraded to a button card
// automatically whenever spencer-btns is available (see lib/buttons.js) —
// same defensive pattern as plugins/buttons.js, so a missing/broken button
// package can never crash the command, it just degrades gracefully.
const config = require('../config')
const fmt    = require('../lib/format')
const { loadBtns, btnsReady } = require('../lib/buttons')

async function sendContactCard(sock, from, sender, msg) {
    const lines = [
        `👤 *Owner:* ${config.ownerName}`,
        config.ownerNumber       ? `📱 *WhatsApp:* wa.me/${config.ownerNumber}` : null,
        config.ownerTelegram     ? `📢 *Telegram:* ${config.ownerTelegram}`     : null,
        config.whatsappChannelUrl ? `📣 *Channel:* ${config.whatsappChannelUrl}` : null,
        ``,
        `_Available for support, custom builds, and bug reports._`,
    ].filter(l => l != null)

    const mod = await loadBtns()
    if (!btnsReady() || !config.ownerNumber) {
        return sock.sendMessage(from, { text: fmt.box('CONTACT OWNER', lines) }, { quoted: msg })
    }

    const buttons = [
        mod.btn.url('💬 Chat on WhatsApp', `https://wa.me/${config.ownerNumber}`),
    ]
    if (config.ownerTelegram) {
        const tgUrl = config.ownerTelegram.startsWith('http') ? config.ownerTelegram : `https://t.me/${config.ownerTelegram.replace(/^@/, '')}`
        buttons.push(mod.btn.url('📢 Telegram', tgUrl))
    } else if (config.whatsappChannelUrl) {
        buttons.push(mod.btn.url('📣 WaChannel', config.whatsappChannelUrl))
    }
    buttons.push(mod.btn.call('☎️ Call Owner', `+${config.ownerNumber}`))

    await mod.sendButtons(sock, from, {
        text: `*📞 CONTACT OWNER*\n\n${lines.join('\n')}`,
        footer: `${config.botName} • ${config.ownerName}`,
        title: 'Contact',
        buttons,
    }, { quoted: msg })
}

module.exports = { sendContactCard }
