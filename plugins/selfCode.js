'use strict'
const config = require('../config')
const fmt = require('../lib/format')
const { chatCompletion } = require('../lib/aiProviders')
const { resolveFile, readProjectFile, searchCode, fileTree } = require('../lib/codeContext')
const { runtimeSettings, scopeAllows } = require('./ownerCmds')

const CODE_SYSTEM = (name, owner) =>
    `You are ${name}, the technical AI living inside your own source code, built by ${owner}. ` +
    `You know this WhatsApp bot's codebase — Node.js, the Baileys library, and its plugin/handler architecture. ` +
    `When shown real code, explain it precisely: what it does, why it's likely structured that way, and flag any risks or bugs you actually notice — don't invent issues that aren't there. ` +
    `Be direct and technical. Reference function/file names rather than repeating large blocks back verbatim.`

// Splits a long reply into WhatsApp-friendly chunks (same pattern as aiChat.js).
function chunk(reply, size = 1400) {
    const lines = reply.split('\n')
    const chunks = []
    let current = ''
    for (const line of lines) {
        if ((current + '\n' + line).length > size) {
            chunks.push(current.trim())
            current = line
        } else {
            current += (current ? '\n' : '') + line
        }
    }
    if (current) chunks.push(current.trim())
    return chunks
}

async function selfCodeReply(sock, from, q, msg) {
    if (!q) {
        return sock.sendMessage(from, {
            text: fmt.usage('mycode', '<filename or question>', 'e.g. ".mycode handler.js" or ".mycode how does the AI fallback chain work"')
        }, { quoted: msg })
    }

    await fmt.react(sock, msg, '🧠')
    try { if (scopeAllows(runtimeSettings.autotype, from.endsWith('@g.us'))) await sock.sendPresenceUpdate('composing', from) } catch {}

    let context
    const directFile = resolveFile(q)
    if (directFile) {
        const { content, truncated } = readProjectFile(directFile)
        context = `File: ${directFile}${truncated ? ' (truncated — file is longer)' : ''}\n\n${content}`
    } else {
        const hits = searchCode(q)
        context = hits.length
            ? hits.map(h => `File: ${h.file} (around line ${h.line})\n${h.snippet}`).join('\n\n---\n\n')
            : `No direct file/keyword match. Full project file list:\n${fileTree()}`
    }

    try {
        const result = await chatCompletion({
            prompt: `Question about this bot's own code: ${q}\n\nRelevant code context:\n\n${context}`,
            system: CODE_SYSTEM(config.botName, config.ownerName),
        })

        const chunks = chunk(result.text)
        await sock.sendMessage(from, {
            text: fmt.box('🧠 *MAHNGUELOH TECH*', [chunks[0]])
        }, { quoted: msg })
        for (let i = 1; i < chunks.length; i++) {
            await sock.sendMessage(from, { text: chunks[i] })
        }
    } catch (e) {
        console.error('selfCodeReply failed:', e.message)
        return sock.sendMessage(from, {
            text: fmt.box('CODE AI UNAVAILABLE', [`❌ Couldn't reach an AI provider right now. Try .aistatus to check.`])
        }, { quoted: msg })
    }
}

module.exports = { selfCodeReply }
