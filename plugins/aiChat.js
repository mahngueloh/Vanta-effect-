'use strict'

const config = require('../config')
const fmt    = require('../lib/format')
const { chatCompletion, getStatus } = require('../lib/aiProviders')
const { downloadMediaMessage } = require('@neoxr/baileys')
const { runtimeSettings, scopeAllows } = require('./ownerCmds')

const historyMap = new Map()
const MAX_HISTORY = 8
const MAX_IMAGE_BYTES = 5 * 1024 * 1024 // 5MB — keep base64 payloads reasonable

const silentLogger = {
    level: 'silent', child: () => silentLogger,
    info: () => {}, debug: () => {}, error: () => {}, warn: () => {}, trace: () => {}
}

const SYSTEM = (name, owner) =>
    `You are ${name}, the AI living inside this WhatsApp bot, built by ${owner}. ` +
    `You're direct and genuinely useful, not a generic customer-service bot — technical when the question calls for it, casual otherwise. ` +
    `Be helpful, concise and conversational. Keep replies under 200 words unless the user asks for more detail. ` +
    `If an image is attached, look at it carefully and describe or answer about it accurately. ` +
    `If asked about your own code, say you can look it up directly with the .mycode command instead of guessing.`

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s }

// ── Image extraction ──────────────────────────────────────────────────────
// Covers both ways a picture can reach `.ai`/auto-reply:
//   1. Sent directly, with the question as the image's own caption.
//   2. Sent earlier, then replied-to (quoted) with the question as a
//      separate text message — same pattern plugins/image.js's .remini uses.
async function extractImageInput(sock, msg) {
    try {
        const own = msg.message?.imageMessage
        if (own) {
            const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger: silentLogger, reuploadRequest: sock.updateMediaMessage })
            return { buffer: buf, mimeType: own.mimetype || 'image/jpeg' }
        }

        const ctx = msg.message?.extendedTextMessage?.contextInfo
        const quotedImg = ctx?.quotedMessage?.imageMessage
        if (quotedImg) {
            const quotedKey = { remoteJid: msg.key.remoteJid, id: ctx.stanzaId || '', participant: ctx.participant || '' }
            const buf = await downloadMediaMessage(
                { message: ctx.quotedMessage, key: quotedKey },
                'buffer', {},
                { logger: silentLogger, reuploadRequest: sock.updateMediaMessage }
            )
            return { buffer: buf, mimeType: quotedImg.mimetype || 'image/jpeg' }
        }
    } catch (e) {
        console.error('extractImageInput:', e.message)
    }
    return null
}

// ── Main entry point ────────────────────────────────────────────────────
// opts.forceProvider lets specific commands (.gemini, .deepseek, ...) pin
// the chain to start with that provider instead of the default order.
async function aiReply(sock, from, text, msg, opts = {}) {
    try { if (scopeAllows(runtimeSettings.autotype, from.endsWith('@g.us'))) await sock.sendPresenceUpdate('composing', from) } catch {}
    await fmt.react(sock, msg, '🤖')

    if (!config.aiEnabled) return noAiConfigured(sock, from, msg)

    const rawImage = await extractImageInput(sock, msg)
    let image = null
    if (rawImage) {
        if (rawImage.buffer.length > MAX_IMAGE_BYTES) {
            return sock.sendMessage(from, {
                text: fmt.box('IMAGE TOO LARGE', [`❌ Please send an image under ${MAX_IMAGE_BYTES / 1024 / 1024}MB.`])
            }, { quoted: msg })
        }
        image = { base64: rawImage.buffer.toString('base64'), mimeType: rawImage.mimeType }
    }

    const prompt = (text && text.trim()) || (image ? 'Describe what you see in this image in detail.' : '')
    if (!prompt) {
        return sock.sendMessage(from, { text: fmt.usage('ai', '<question, or send/reply to an image>') }, { quoted: msg })
    }

    const hist = getHistory(from)
    try {
        const result = await chatCompletion({
            prompt,
            system: SYSTEM(config.botName, config.ownerName),
            history: hist,
            image,
            forceProvider: opts.forceProvider || null,
        })
        addToHistory(from, prompt, result.text)
        return sendAIResponse(sock, from, result.text, msg)
    } catch (e) {
        console.error('AI chain failed:', e.message, JSON.stringify(e.attempts || []))
        return noAiConfigured(sock, from, msg, e)
    }
}

function formatAIResponse(reply) {
    // Split long replies into readable chunks (max 1500 chars per chunk)
    const lines = reply.split('\n')
    const chunks = []
    let current = ''
    for (const line of lines) {
        if ((current + '\n' + line).length > 1400) {
            chunks.push(current.trim())
            current = line
        } else {
            current += (current ? '\n' : '') + line
        }
    }
    if (current) chunks.push(current.trim())
    return chunks
}

async function sendAIResponse(sock, from, reply, msg) {
    const chunks = formatAIResponse(reply)
    const label  = '🤖 *MAHNGUELOH TECH*'

    // First chunk includes the header box
    await sock.sendMessage(from, {
        text: fmt.box(label, [chunks[0]])
    }, { quoted: msg })

    // Additional chunks (if reply was long) sent as plain continuations
    for (let i = 1; i < chunks.length; i++) {
        await sock.sendMessage(from, { text: chunks[i] })
    }
}

// Shown only when every configured provider failed (or none are configured
// at all) — kept generic for regular users; full per-provider detail is in
// the console log and in `.aistatus`/`.aitest` for the owner.
function noAiConfigured(sock, from, msg, err) {
    const lines = [`❌ AI replies aren't working right now.`]
    if (err && err.attempts && err.attempts.length) {
        lines.push(`_All ${err.attempts.length} configured AI provider(s) failed or are unavailable._`)
    } else {
        lines.push(`Contact ${config.ownerName} to get this enabled.`)
    }
    return sock.sendMessage(from, {
        text: fmt.box('AI TEMPORARILY UNAVAILABLE', lines)
    }, { quoted: msg })
}

function getHistory(from) { return historyMap.get(from) || [] }
function addToHistory(from, userMsg, botMsg) {
    const hist = getHistory(from)
    hist.push({ role: 'user', content: userMsg }, { role: 'assistant', content: botMsg })
    if (hist.length > MAX_HISTORY * 2) hist.splice(0, 2)
    historyMap.set(from, hist)
}

module.exports = { aiReply, getStatus }
