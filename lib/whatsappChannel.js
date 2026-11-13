'use strict'

const config = require('../config')

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 2000   // doubles each retry (2s, 4s, 8s)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function channelJid() { return config.news.whatsappChannelJid || '' }

function isWhatsAppChannelConfigured() {
    return Boolean(channelJid())
}

function getWhatsAppChannelStatus() {
    return {
        configured: isWhatsAppChannelConfigured(),
        jid: channelJid() || '(not set)',
    }
}

async function publishToWhatsAppChannel(sock, text, imageBuffer = null) {
    const jid = channelJid()
    if (!jid) return { skipped: true, error: 'WhatsApp Channel not configured (WHATSAPP_CHANNEL_JID missing in .env)' }
    if (!sock) return { success: false, error: 'WhatsApp socket is not connected yet' }

    let lastError = null
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            if (imageBuffer) {
                await sock.sendMessage(jid, { image: imageBuffer, caption: text })
            } else {
                await sock.sendMessage(jid, { text })
            }
            return { success: true, attempts: attempt }
        } catch (e) {
            lastError = e.message
            if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS * Math.pow(2, attempt - 1))
        }
    }
    return { success: false, error: lastError || 'Unknown WhatsApp Channel error', attempts: MAX_RETRIES }
}

async function testWhatsAppChannel(sock) {
    const jid = channelJid()
    if (!jid) return { success: false, error: 'WHATSAPP_CHANNEL_JID is not set in .env' }
    if (!sock) return { success: false, error: 'WhatsApp socket is not connected yet' }
    return publishToWhatsAppChannel(sock, `✅ Test message from *${config.botName}* — WhatsApp Channel is connected correctly.`)
}

module.exports = {
    isWhatsAppChannelConfigured,
    getWhatsAppChannelStatus,
    publishToWhatsAppChannel,
    testWhatsAppChannel,
}
