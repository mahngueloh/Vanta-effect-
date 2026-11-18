'use strict'
// Native in-chat HTML ("rich response") sender — our own implementation.
//
// WhatsApp renders a Meta-AI-style "rich response" whose payload is an HTML
// page inside the chat bubble. The wire shape (observed behaviour, NOT an
// official API, so it can change or be ignored by some clients):
//
//   botForwardedMessage.message.richResponseMessage = {
//     messageType: 1,
//     submessages: [{ messageType: 2, messageText: <title> }],
//     unifiedResponse: { data: base64(JSON{ response_id, sections:[{ view_model:{
//         primitive:{ __typename:'GenAIaeacdsnwHtmlPrimitive', payload:<html> },
//         __typename:'GenAISingleLayoutViewModel' } }] }) },
//     contextInfo: <meta.contextInfo>
//   }
//   + top-level messageContextInfo: <meta.messageContextInfo>
//
// `meta` (the two context objects) has no documented values, so .htmltest tries
// several variants; the working one is picked via RICHHTML_META.
const crypto = require('crypto')

// Ids of rich messages WE sent, so the capture hook ignores their echoes.
const sentIds = new Set()

const HTML_PRIMITIVE = 'GenAIaeacdsnwHtmlPrimitive'
const MAX_BYTES = 60 * 1024

// Named meta variants (messageContextInfo / contextInfo / extra relay nodes)
const META = {
    minimal:  { messageContextInfo: {}, contextInfo: {} },
    devlist:  { messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 }, contextInfo: {} },
    forwarded:{ messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 }, contextInfo: { forwardingScore: 1, isForwarded: true } },
    botnode:  { messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 }, contextInfo: {}, botNode: true },
    persona:  { messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2, botMetadata: { personaId: '867051314767696$760019659443059' } }, contextInfo: {} },
}
const DEFAULT_META = process.env.RICHHTML_META && META[process.env.RICHHTML_META] ? process.env.RICHHTML_META : 'devlist'

function buildPayload(html, { title = 'HTML' } = {}) {
    if (Buffer.byteLength(html, 'utf8') > MAX_BYTES) throw new Error(`HTML is ${Buffer.byteLength(html)} bytes; native limit is ${MAX_BYTES}`)
    // Shape copied from a REAL working in-chat game message (captured 2026-11-18)
    const doc = {
        response_id: '3EB0' + crypto.randomBytes(4).toString('hex').toUpperCase(),
        sections: [{ view_model: { primitive: { __typename: HTML_PRIMITIVE, payload: html, trusted_sources: [] }, __typename: 'GenAISingleLayoutViewModel' } }],
    }
    const mci = () => ({
        threadId: [],
        deviceListMetadata: { senderKeyIndexes: [], recipientKeyIndexes: [] },
        deviceListMetadataVersion: 2,
        botMetadata: { messageDisclaimerText: String(title), richResponseSourcesMetadata: { sources: [] } },
    })
    return {
        messageContextInfo: mci(),
        botForwardedMessage: { message: { richResponseMessage: {
            submessages: [{ messageType: 2, messageText: String(title) }],
            messageType: 1,
            unifiedResponse: { data: Buffer.from(JSON.stringify(doc), 'utf8') },
            contextInfo: {
                mentionedJid: [], groupMentions: [], statusAttributions: [],
                forwardingScore: 1, isForwarded: true,
                forwardedAiBotMessageInfo: { botJid: '0@bot' },
                forwardOrigin: 4,
            },
        } } },
    }
}

async function sendRichHtml(sock, jid, html, opts = {}) {
    const payload = buildPayload(html, { title: opts.title })
    const messageId = '3EB0' + crypto.randomBytes(4).toString('hex').toUpperCase()
    const relayOpts = { messageId }
    sentIds.add(messageId)
    await sock.relayMessage(jid, payload, relayOpts)
    console.log(`[richhtml] relayed id=${messageId} to=${jid} bytes=${Buffer.byteLength(html)}`)
    return { key: { remoteJid: jid, id: messageId, fromMe: true } }
}

module.exports = { sendRichHtml, buildPayload, META, MAX_BYTES, HTML_PRIMITIVE, sentIds }
