'use strict'
// Our own interactive-button helper (replaces the removed `spencer-btns`).
// Same API the bot already uses:
//   btn.reply(label, id) | btn.url(label, url) | btn.copy(label, text)
//   btn.call(label, phone) | btn.list(title, sections)
//   sendButtons(sock, jid, { text, footer, image, buttons, mentions, contextInfo }, { quoted })
// Built on WhatsApp "native flow" interactive messages, relayed through the
// Baileys socket the bot already runs. No third-party package involved.

const mk = (name, params) => ({ name, buttonParamsJson: JSON.stringify(params) })

const btn = {
    reply: (label, id) => mk('quick_reply', { display_text: label, id: String(id) }),
    url:   (label, url) => mk('cta_url', { display_text: label, url, merchant_url: url }),
    copy:  (label, text) => mk('cta_copy', { display_text: label, copy_code: String(text) }),
    call:  (label, phone) => mk('cta_call', { display_text: label, phone_number: String(phone) }),
    list:  (title, sections) => mk('single_select', {
        title,
        sections: sections.map(s => ({
            title: s.title,
            rows: s.rows.map(r => ({ title: r.title, description: r.description || '', id: String(r.id) })),
        })),
    }),
}

async function sendButtons(sock, jid, content = {}, opts = {}) {
    const { generateWAMessageFromContent, prepareWAMessageMedia, proto, isJidGroup } = require('@neoxr/baileys')
    const { text = '', footer = '', image, buttons = [], mentions, contextInfo = {} } = content
    if (!buttons.length) throw new Error('sendButtons: no buttons given')

    const IM = proto.Message.InteractiveMessage
    let header = { title: '', subtitle: '', hasMediaAttachment: false }
    if (image) {
        const media = await prepareWAMessageMedia({ image }, { upload: sock.waUploadToServer })
        header = { title: '', subtitle: '', hasMediaAttachment: true, imageMessage: media.imageMessage }
    }

    const ctx = { ...contextInfo }
    if (mentions && mentions.length) ctx.mentionedJid = mentions
    const q = opts.quoted
    if (q && q.key && q.message) {
        ctx.stanzaId = q.key.id
        ctx.participant = q.key.participant || q.key.remoteJid
        ctx.quotedMessage = q.message
    }

    const interactiveMessage = IM.create({
        header: IM.Header.create(header),
        body: IM.Body.create({ text }),
        footer: IM.Footer.create({ text: footer }),
        nativeFlowMessage: IM.NativeFlowMessage.create({ buttons, messageParamsJson: '' }),
        contextInfo: ctx,
    })

    const msg = generateWAMessageFromContent(jid, {
        viewOnceMessage: { message: {
            messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 },
            interactiveMessage,
        } },
    }, { userJid: sock.user && sock.user.id })

    const additionalNodes = [{ tag: 'biz', attrs: {}, content: [{
        tag: 'interactive', attrs: { type: 'native_flow', v: '1' },
        content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }],
    }] }]
    // Private chats need the bot marker or the buttons render as "update WhatsApp".
    if (!(isJidGroup ? isJidGroup(jid) : jid.endsWith('@g.us'))) {
        additionalNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } })
    }

    await sock.relayMessage(jid, msg.message, { messageId: msg.key.id, additionalNodes })
    return msg
}

module.exports = { btn, sendButtons }
