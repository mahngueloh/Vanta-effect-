'use strict'

// WhatsApp side of the human-style chatbot. Logic lives in lib/humanChat.js.
//
// DMs:    replies to anyone who texts (except you) when scope is dm/all.
// Groups: replies only when it's called — @mentioned, someone replies to one
//         of its messages, or its name is used — when scope is group/all.
// Anyone can also use .chat <text> to talk to it directly.

const config = require('../config')
const fmt    = require('../lib/format')
const brain  = require('../lib/humanChat')
const { jidToNum, numsMatch } = require('../lib/utils')

const chatBrainCmds = new Set([
    'chat', 'chatbot', 'chatteach', 'chatunteach', 'chatfact', 'chatforget',
    'chatlist', 'chatpersona', 'chatname', 'chatreset', 'chatstatus', 'hftoken', 'hfmodel',
])

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }
function rand(a, b) { return a + Math.floor(Math.random() * (b - a + 1)) }

// ── Deciding whether to answer ───────────────────────────────────────────
// Baileys-made bots stamp their message ids with a fixed prefix. Skipping
// those stops two bots (e.g. another bot in the same group) chatting to each
// other forever.
function looksLikeBot(msg) {
    const id = msg.key?.id || ''
    return id.length === 16 && (id.startsWith('BAE5') || id.startsWith('NXR5'))
}

function isAddressed(sock, msg, body) {
    const ctx = msg.message?.extendedTextMessage?.contextInfo
    const botNums = [jidToNum(sock.user?.id || ''), jidToNum(sock.user?.lid || '')].filter(Boolean)
    const mentioned = (ctx?.mentionedJid || []).some(j => { const n = jidToNum(j); return botNums.some(b => numsMatch(n, b)) })
    if (mentioned) return true
    if (ctx?.stanzaId && brain.wasSentByBot(ctx.stanzaId)) return true
    return brain.isCalled(body)
}

// ── Sending like a person ────────────────────────────────────────────────
async function humanSend(sock, from, text, msg, inGroup) {
    await sleep(rand(600, 1400))                                   // "reads" it first
    try { await sock.sendPresenceUpdate('composing', from) } catch {}
    await sleep(Math.min(6000, Math.max(1200, text.length * 35 + rand(300, 900))))   // "types" it
    const sent = await sock.sendMessage(from, { text }, inGroup ? { quoted: msg } : undefined)
    try { await sock.sendPresenceUpdate('paused', from) } catch {}
    brain.rememberSent(sent?.key?.id)
}

// ── Core: take a message, answer it ──────────────────────────────────────
async function converse(sock, msg, from, sender, text, inGroup, { explicit = false } = {}) {
    const chat = brain.chatFor(from)
    const who  = msg.pushName || 'someone'
    brain.pushTurn(chat, 'user', inGroup ? `${who}: ${text}` : text)
    chat.lastText = text

    if (chat.busy) { chat.pending = true; return true }   // will be picked up after the current reply

    chat.busy = true
    try {
        let round = 0
        do {
            chat.pending = false
            if (!explicit && !brain.allow(from, sender, inGroup, { followUp: round > 0 })) break

            let reply = brain.matchCanned(chat.lastText)      // taught instant answers first
            if (!reply) {
                try { reply = await brain.generate(chat, inGroup) }
                catch (e) {
                    if (explicit) {
                        await sock.sendMessage(from, { text: fmt.box('CHAT', [
                            e.code === 'NO_TOKEN'
                                ? `❌ No Hugging Face token yet — use ${config.prefix}hftoken <token>`
                                : `❌ Couldn't reach the AI right now — try again in a bit`,
                        ]) }, { quoted: msg })
                    }
                    break                                       // auto-replies stay silent on errors
                }
            }
            if (!reply) break
            brain.pushTurn(chat, 'assistant', reply)
            await humanSend(sock, from, reply, msg, inGroup)
            round++
        } while (chat.pending && round < 2)
    } catch (e) {
        console.error('[chatbrain] reply failed:', e.message)
    } finally {
        chat.busy = false
    }
    return true
}

// Called from handler.js for every non-command text message.
async function maybeChatReply(sock, msg, from, sender, body, inGroup, owner) {
    const s = brain.getState()
    if (s.scope === 'off' || owner) return false
    if (inGroup ? !(s.scope === 'group' || s.scope === 'all') : !(s.scope === 'dm' || s.scope === 'all')) return false
    if (!body || !body.trim() || from === 'status@broadcast' || from.endsWith('@broadcast')) return false
    if (looksLikeBot(msg)) return false
    if (inGroup && !isAddressed(sock, msg, body)) return false
    return converse(sock, msg, from, sender, body.trim(), inGroup)
}

// ── Commands ─────────────────────────────────────────────────────────────
function needOwner(sock, from, msg, owner) {
    if (owner) return true
    sock.sendMessage(from, { text: fmt.permOwner() }, { quoted: msg })
    return false
}

function scopeLabel(s) {
    return { off: '🔴 OFF', dm: '🟢 DMs only', group: '🟢 Groups only (when called)', all: '🟢 DMs + Groups (groups when called)' }[s]
}

async function handleChatBrainCmd(sock, from, cmd, args, msg, owner, inGroup) {
    const p = config.prefix
    const q = args.join(' ').trim()
    const reply = (text) => sock.sendMessage(from, { text }, { quoted: msg })
    const scrub = async () => { try { await sock.sendMessage(from, { delete: msg.key }) } catch {} }

    if (cmd === 'chat') {
        if (!q) return reply(fmt.usage('chat', '<message>'))
        return converse(sock, msg, from, msg.key?.participant || from, q, inGroup, { explicit: true })
    }

    if (!needOwner(sock, from, msg, owner)) return

    switch (cmd) {
        case 'chatbot': {
            const a = (args[0] || '').toLowerCase()
            const map = { on: 'all', all: 'all', both: 'all', dm: 'dm', dms: 'dm', private: 'dm', group: 'group', groups: 'group', public: 'group', off: 'off' }
            if (!a) {
                return reply(fmt.box('CHATBOT', [
                    `${scopeLabel(brain.getState().scope)}`,
                    `Usage: *${p}chatbot off|dm|group|all*`,
                    `_dm = answers everyone who texts you, group = answers only when @mentioned/replied to/called by name._`,
                ]))
            }
            if (!map[a]) return reply(fmt.usage('chatbot', 'off|dm|group|all'))
            if (map[a] !== 'off' && !brain.getToken()) {
                brain.setScope(map[a])
                return reply(fmt.box('CHATBOT', [
                    `${scopeLabel(map[a])}`,
                    `⚠️ No Hugging Face token yet, so it can only give taught replies (${p}chatteach) for now.`,
                    `Set it with *${p}hftoken <token>* (in your own chat).`,
                ]))
            }
            brain.setScope(map[a])
            return reply(fmt.box('CHATBOT', [scopeLabel(map[a]), map[a] === 'off' ? '_It will stay quiet._' : `_Model: ${brain.currentModel()}_`]))
        }

        case 'chatteach': {
            const m = q.split(/\s*(?:=>|->)\s*/)
            if (m.length < 2 || !m[0].trim() || !m.slice(1).join(' ').trim()) {
                return reply(fmt.box('CHATTEACH', [
                    `*Usage:* ${p}chatteach <word | word> => <reply>`,
                    `*Example:* ${p}chatteach repo | source code => here you go {repo}`,
                    ``,
                    `When a message contains any of those words, it sends that reply word for word (no AI, so links stay exact).`,
                    `Placeholders: {repo} {channel} {owner} {name}`,
                ]))
            }
            const triggers = m[0].split(/[|,]/).map(s => s.trim().toLowerCase()).filter(s => s.length >= 2)
            if (!triggers.length) return reply(fmt.error('Give at least one trigger word (2+ characters)'))
            const r = brain.addReply(triggers, m.slice(1).join(' => '))
            if (!r.ok) return reply(fmt.error(r.error))
            return reply(fmt.box('TAUGHT', [`✅ #${r.n}: when someone says *${triggers.join('* / *')}* → I reply with that.`]))
        }

        case 'chatunteach': {
            const gone = brain.removeReply(parseInt(args[0], 10))
            return reply(gone ? fmt.box('REMOVED', [`🗑️ Removed taught reply for *${gone.triggers.join(' / ')}*`]) : fmt.usage('chatunteach', '<number from ' + p + 'chatlist>'))
        }

        case 'chatfact': {
            if (!q) {
                return reply(fmt.box('CHATFACT', [
                    `*Usage:* ${p}chatfact <something it should know>`,
                    `*Example:* ${p}chatfact I sell phone cases, price starts at 500`,
                    `_It uses facts naturally in conversation. Don't add secrets — anyone chatting could get them out of it._`,
                ]))
            }
            const r = brain.addFact(q)
            return reply(r.ok ? fmt.box('LEARNED', [`✅ Fact #${r.n} saved`]) : fmt.error(r.error))
        }

        case 'chatforget': {
            const gone = brain.removeFact(parseInt(args[0], 10))
            return reply(gone ? fmt.box('FORGOT', [`🗑️ Removed: ${gone.text.slice(0, 80)}`]) : fmt.usage('chatforget', '<fact number from ' + p + 'chatlist>'))
        }

        case 'chatlist': {
            if (inGroup) return reply(fmt.error(`Run ${p}chatlist in your own chat — it shows what you've taught it.`))
            const s = brain.getState()
            const lines = []
            lines.push(`*Facts (${p}chatforget <n>)*`)
            lines.push(...(s.facts.length ? s.facts.map((f, i) => `${i + 1}. ${f.text}`) : ['(none)']))
            lines.push('', `*Instant replies (${p}chatunteach <n>)*`)
            lines.push(...(s.replies.length ? s.replies.map((r, i) => `${i + 1}. ${r.triggers.join(' | ')} → ${r.reply.slice(0, 60)}`) : ['(none)']))
            if (s.persona) lines.push('', `*Personality:* ${s.persona}`)
            return reply(fmt.box('CHATBOT KNOWLEDGE', lines))
        }

        case 'chatpersona': {
            if (!q) return reply(fmt.box('PERSONA', [`Current: ${brain.getState().persona || '(default)'}`, `*Usage:* ${p}chatpersona <how it should talk>   |   ${p}chatpersona reset`, `*Example:* ${p}chatpersona funny, uses light Sheng, never more than 10 words`]))
            brain.setPersona(q.toLowerCase() === 'reset' ? '' : q)
            return reply(fmt.box('PERSONA', [q.toLowerCase() === 'reset' ? '✅ Back to default' : '✅ Personality updated']))
        }

        case 'chatname': {
            if (!q) return reply(fmt.box('NAME', [`Current: ${brain.displayName()}`, `*Usage:* ${p}chatname <name>   |   ${p}chatname reset`]))
            brain.setName(q.toLowerCase() === 'reset' ? '' : q)
            return reply(fmt.box('NAME', [`✅ It now goes by *${brain.displayName()}* (and answers to that name in groups)`]))
        }

        case 'chatreset': {
            brain.resetChat(from)
            return reply(fmt.box('CHATBOT', ['✅ Forgot this conversation']))
        }

        case 'chatstatus': {
            const s = brain.getState(), st = brain.stats
            return reply(fmt.box('CHATBOT STATUS', [
                scopeLabel(s.scope),
                `🤗 Token: ${brain.getToken() ? 'set ✅' : 'missing ❌'}`,
                `🧠 Model: ${brain.currentModel()}`,
                `📚 Facts: ${s.facts.length}  •  ⚡ Instant replies: ${s.replies.length}`,
                `✅ ${st.ok} ok  •  ❌ ${st.fail} failed`,
                st.lastError ? `Last error: ${st.lastError.slice(0, 100)}` : null,
            ].filter(Boolean)))
        }

        case 'hftoken': {
            const token = args.join('').trim()
            if (inGroup) {
                await scrub()
                return sock.sendMessage(from, { text: fmt.box('🔒 NOT IN A GROUP', [
                    `Never paste a token in a group — I deleted that message.`,
                    `Send *${p}hftoken <token>* in your own chat. If anyone saw it, make a new token.`,
                ]) })
            }
            if (!token) {
                return reply(fmt.box('HF TOKEN', [
                    `*Usage:* ${p}hftoken <token>`,
                    ``,
                    `1. huggingface.co/settings/tokens → Create new token`,
                    `2. Type: Fine-grained → tick *Make calls to Inference Providers*`,
                    `3. Copy the token (starts with hf_) and send it here`,
                    ``,
                    `_Your message is deleted after saving and the token is never shown back._`,
                ]))
            }
            await scrub()
            if (!/^hf_[A-Za-z0-9]{20,}$/.test(token)) {
                return sock.sendMessage(from, { text: fmt.box('❌ NOT A HUGGING FACE TOKEN', ['It should start with hf_ and be about 37 characters. Copy it again and resend.']) })
            }
            const who = await brain.whoami(token)
            if (who.invalid) return sock.sendMessage(from, { text: fmt.box('❌ TOKEN REJECTED', ['Hugging Face says this token is invalid or revoked.']) })
            brain.setToken(token)
            return sock.sendMessage(from, { text: fmt.box('🤗 HUGGING FACE CONNECTED', [
                who.ok ? `Account: *${who.name}*` : `_Saved (couldn't reach Hugging Face to double-check it)._`,
                `Model: ${brain.currentModel()}`,
                ``,
                `Turn it on: *${p}chatbot dm|group|all*`,
                `Try it: *${p}chat hello*`,
            ]) })
        }

        case 'hfmodel': {
            if (!q) return reply(fmt.box('HF MODEL', [`Current: ${brain.currentModel()}`, `*Usage:* ${p}hfmodel <model id>   |   ${p}hfmodel reset`, `*Example:* ${p}hfmodel Qwen/Qwen2.5-7B-Instruct`, `_Pick a chat/instruct model (not a "thinking" one) — it's tested before saving._`]))
            if (q.toLowerCase() === 'reset') { brain.setModel(''); return reply(fmt.box('HF MODEL', [`✅ Back to ${brain.DEFAULT_MODEL}`])) }
            if (!/^[\w.\-]+\/[\w.\-:]+$/.test(q)) return reply(fmt.error('That doesn\'t look like a model id (expected owner/name)'))
            try {
                await brain.complete([{ role: 'user', content: 'Say hi in two words.' }], { model: q, maxTokens: 12 })
            } catch (e) {
                return reply(fmt.box('❌ MODEL TEST FAILED', [`${q}`, `${(e.message || '').slice(0, 120)}`, `_Not saved — keeping ${brain.currentModel()}._`]))
            }
            brain.setModel(q)
            return reply(fmt.box('HF MODEL', [`✅ Now using *${q}*`]))
        }
    }
}

module.exports = { chatBrainCmds, handleChatBrainCmd, maybeChatReply }
