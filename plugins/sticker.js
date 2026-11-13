const { downloadMediaMessage } = require('@neoxr/baileys')
const { Sticker, StickerTypes } = require('wa-sticker-formatter')
const config = require('../config')
const fmt    = require('../lib/format')

const silentLogger = {
    level: 'silent', child: () => silentLogger,
    info: () => {}, debug: () => {}, error: () => {}, warn: () => {}, trace: () => {}
}

async function makeSticker(sock, msg, from, q) {
    const quoted    = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
    const targetMsg = quoted
        ? { message: quoted, key: { ...msg.key, id: msg.message.extendedTextMessage.contextInfo.stanzaId } }
        : msg

    const mtype = Object.keys(targetMsg.message || {})[0]
    if (!['imageMessage','videoMessage','stickerMessage'].includes(mtype)) {
        return sock.sendMessage(from, {
            text: fmt.box('STICKER', [`❌ Send or reply to an *image/video* with *${config.prefix}sticker*`])
        }, { quoted: msg })
    }

    try {
        await fmt.react(sock, msg, '⏳')

        const buffer = await downloadMediaMessage(
            { message: targetMsg.message, key: targetMsg.key },
            'buffer', {},
            { logger: silentLogger, reuploadRequest: sock.updateMediaMessage }
        )

        let packname = config.botName
        let author   = config.ownerName
        if (q) {
            const parts = q.split('|')
            packname = parts[0]?.trim() || packname
            author   = parts[1]?.trim() || author
        }

        const sticker = new Sticker(buffer, {
            pack: packname,
            author,
            type: mtype === 'videoMessage' ? StickerTypes.ANIMATED : StickerTypes.FULL,
            quality: 70,
        })

        const stickerBuffer = await sticker.toBuffer()
        await sock.sendMessage(from, { sticker: stickerBuffer }, { quoted: msg })
        await fmt.react(sock, msg, '✅')

    } catch (err) {
        console.error('Sticker error:', err.message)
        await sock.sendMessage(from, {
            text: fmt.box('STICKER FAILED', [
                `❌ ${err.message}`,
                ``,
                `💡 Make sure you reply to an image or video`,
            ])
        }, { quoted: msg })
    }
}

module.exports = { makeSticker }
