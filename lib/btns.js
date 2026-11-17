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

    // Experiment switches (used by .btntest); defaults = the normal format.
    const f = { wrap: 'viewOnce', biz: true, bot: true, version: true, quote: true, ...(opts.flags || {}) }
    const IM = proto.Message.InteractiveMessage
    let header = { title: '', subtitle: '', hasMediaAttachment: false }
    if (image) {
        const media = await prepareWAMessageMedia({ image }, { upload: sock.waUploadToServer })
        header = { title: '', subtitle: '', hasMediaAttachment: true, imageMessage: media.imageMessage }
    }

    const ctx = { ...contextInfo }
    if (mentions && mentions.length) ctx.mentionedJid = mentions
    const q = opts.quoted
    if (f.quote && q && q.key && q.message) {
        ctx.stanzaId = q.key.id
        ctx.participant = q.key.participant || q.key.remoteJid
        ctx.quotedMessage = q.message
    }

    const interactiveMessage = IM.create({
        header: IM.Header.create(header),
        body: IM.Body.create({ text }),
        footer: IM.Footer.create({ text: footer }),
        nativeFlowMessage: IM.NativeFlowMessage.create(f.version ? { buttons, messageParamsJson: '', messageVersion: 1 } : { buttons, messageParamsJson: '' }),
        contextInfo: ctx,
    })

    const mci = { deviceListMetadata: {}, deviceListMetadataVersion: 2 }
    const wrapped = {
        viewOnce:   { viewOnceMessage:   { message: { messageContextInfo: mci, interactiveMessage } } },
        viewOnceV2: { viewOnceMessageV2: { message: { messageContextInfo: mci, interactiveMessage } } },
        document:   { documentWithCaptionMessage: { message: { messageContextInfo: mci, interactiveMessage } } },
        none:       { messageContextInfo: mci, interactiveMessage },
    }[f.wrap]
    const msg = generateWAMessageFromContent(jid, wrapped, { userJid: sock.user && sock.user.id })

    const additionalNodes = []
    if (f.biz) additionalNodes.push({ tag: 'biz', attrs: {}, content: [{
        tag: 'interactive', attrs: { type: 'native_flow', v: '1' },
        content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }],
    }] })
    // Private chats also get the bot marker.
    if (f.bot && !(isJidGroup ? isJidGroup(jid) : jid.endsWith('@g.us'))) {
        additionalNodes.push({ tag: 'bot', attrs: { biz_bot: '1' } })
    }

    const relay = sock.relayMessage(jid, msg.message, { messageId: msg.key.id, additionalNodes })
    await Promise.race([
        relay,
        new Promise((_, rej) => setTimeout(() => rej(new Error('relayMessage timed out after 20s')), 20000)),
    ])
    console.log(`[btns] relayed id=${msg.key.id} to=${jid} buttons=${buttons.length} image=${!!image}`)
    return msg
}

// Wrapper the bot calls: never leaves a command silent. If the interactive
// send fails and there's no image (the callers already retry image sends as
// text-only themselves), log the real reason and deliver the same text with
// the link buttons written out, so .menu/.repo/etc. always answer.
async function sendButtonsSafe(sock, jid, content = {}, opts = {}) {
    try {
        return await sendButtons(sock, jid, content, opts)
    } catch (e) {
        console.error('[btns] interactive send failed:', e && e.stack ? e.stack : e)
        if (content.image) throw e   // caller falls back to text-only
        const lines = (content.buttons || []).map(b => {
            try {
                const p = JSON.parse(b.buttonParamsJson)
                if (b.name === 'cta_url') return `\u{1F517} ${p.display_text}: ${p.url}`
                if (b.name === 'cta_copy') return `\u{1F4CB} ${p.display_text}: ${p.copy_code}`
                if (b.name === 'cta_call') return `\u260E\uFE0F ${p.display_text}: ${p.phone_number}`
                if (b.name === 'quick_reply') return `\u25B6 ${p.display_text}`
            } catch {}
            return null
        }).filter(Boolean)
        const body = [content.text, lines.length ? '\n' + lines.join('\n') : '', content.footer ? `\n_${content.footer}_` : '']
            .filter(Boolean).join('\n')
        return sock.sendMessage(jid, { text: body, mentions: content.mentions || content.contextInfo?.mentionedJid }, opts.quoted ? { quoted: opts.quoted } : undefined)
    }
}

module.exports = { btn, sendButtons: sendButtonsSafe }
