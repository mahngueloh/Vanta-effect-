'use strict'

const config = require('../config')
const fmt = require('../lib/format')
const { chatCompletion } = require('../lib/aiProviders')
const agent = require('../lib/projectAgent')
const { runtimeSettings, scopeAllows } = require('./ownerCmds')

function chunks(text, size = 1400) {
    const out = []
    let cur = ''
    for (const line of String(text || '').split('\n')) {
        if (cur && cur.length + line.length + 1 > size) { out.push(cur.trim()); cur = '' }
        cur += (cur ? '\n' : '') + line
    }
    if (cur) out.push(cur.trim())
    return out
}

function systemPrompt() {
    return [
        `You are the private coding agent living inside ${config.botName}.`,
        `The authenticated requester is the bot owner (${config.ownerName}).`,
        `You have repository context supplied by a local persistent code index.`,
        `Use concrete file names, functions, command cases and dependencies from that context.`,
        `Do not invent files or pretend to execute changes you did not actually execute.`,
        `Your job is to understand the existing architecture first, then propose the smallest safe change.`,
        `This command currently has read/search/memory powers; writing code is handled separately by the bot's guarded repair/update features.`,
    ].join(' ')
}

async function codeAgentReply(sock, from, q, msg) {
    if (!q) return sock.sendMessage(from, { text: fmt.usage('agent', '<what do you want the code agent to inspect?>') }, { quoted: msg })
    await fmt.react(sock, msg, '🧠')
    try { if (scopeAllows(runtimeSettings.autotype, from.endsWith('@g.us'))) await sock.sendPresenceUpdate('composing', from) } catch {}

    const retrieval = agent.buildContext(q, { maxChars: 50000, maxFiles: 14 })
    const memory = agent.recall(q, 12)
    const memoryBlock = memory.length ? `\nPERSISTENT MEMORY:\n${memory.map(m => `- ${m.text}`).join('\n')}` : ''
    const prompt = [
        `OWNER REQUEST: ${q}`,
        `REPOSITORY CONTEXT:`, retrieval.context,
        memoryBlock,
        `Answer as a senior engineer. Explain what you found, the relevant files/functions, dependencies between them, and what you recommend doing next. If the owner asks to change code, describe the exact patch plan but do not pretend it has already been applied.`,
    ].join('\n\n')

    const result = await chatCompletion({
        prompt,
        system: systemPrompt(),
        // Note: no local/Ollama provider actually exists in lib/aiProviders.js
        // (an earlier doc claimed one did — it didn't). This always goes
        // through the normal Claude/OpenAI/Gemini/DeepSeek chain.
    })
    const status = `\n\n☁️ Model: ${result.model || result.provider}`
    const out = chunks(result.text + status)
    await sock.sendMessage(from, { text: fmt.box('🧠 *MAHNGUELOH CODE AGENT*', [out[0]]) }, { quoted: msg })
    for (let i = 1; i < out.length; i++) await sock.sendMessage(from, { text: out[i] })
}

async function rememberCommand(sock, from, q, msg) {
    if (!q) return sock.sendMessage(from, { text: fmt.usage('remember', '<fact about the project to remember>') }, { quoted: msg })
    const saved = agent.remember(q)
    await sock.sendMessage(from, { text: fmt.box('🧠 MEMORY SAVED', [`✅ ${saved.text}`]) }, { quoted: msg })
}

async function refreshCommand(sock, from, msg) {
    const idx = agent.buildIndex(true)
    await sock.sendMessage(from, { text: fmt.box('CODE INDEX', [`✅ Refreshed repository index.`, `📁 ${idx.fileCount} files indexed.`, `🕒 ${idx.updatedAt}`]) }, { quoted: msg })
}

function getAgentStatus() {
    return agent.status()
}

module.exports = { codeAgentReply, rememberCommand, refreshCommand, getAgentStatus }
