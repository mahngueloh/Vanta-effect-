'use strict'

// Lightweight response personality layer. It only touches ordinary text
// replies; media, menus and very large payloads stay clean.
const DEFAULT_FUN_RESPONSES = process.env.FUN_RESPONSES !== 'false'
const CHANCE = Math.max(0, Math.min(1, Number(process.env.FUN_RESPONSE_CHANCE || 0.45)))

const generic = [
    '😂 Mahngueloh has entered the chat.',
    '😎 Clean work. Next command?',
    '🔥 Powered by Mahngueloh energy.',
    '😂 No cap, that one actually worked.',
    '🫡 Your friendly bot has done its duty.',
    '🤖 MAHNGUELOH VANTA: still cooking.',
]
const sports = [
    '⚽ VAR has checked it. Looks good. 😂',
    '🏟️ No red card for this response. 😎',
    '⚽ Football mode: ON. Drama: pending. 😂',
    '🏆 One step closer to the trophy.',
]
const download = [
    '📥 The download machine has spoken. 😂',
    '🚀 Sent at bot speed.',
    '🎧 Enjoy — bandwidth survived this round. 😂',
]

const commandReplies = {
    ping: [
        '😂 MAHNGUELOH is always replying faster than your babe.',
        '⚡ Ping received. Your network is still trying to catch up with VANTA. 😂',
        '🏓 Pong! Faster than a "seen" when they don\'t want to explain themselves. 😂',
    ],
    botping: [
        '😂 VANTA latency checked. Your babe\'s reply still pending.',
        '⚡ Bot speed: disrespectfully fast. 😂',
    ],
    pong: [
        '🏓 Pong delivered. Even physics had to wait. 😂',
    ],
    menu: [
        '🕶️ Welcome to the VANTA grid — too much technology, not enough sleep. 😂',
        '👽 The menu is loaded. Choose wisely; your phone already knows too much. 😂',
    ],
    help: [
        '🧠 Help is here. Unlike your friend who says "I know how" then breaks everything. 😂',
    ],
    uptime: [
        '⏱️ Still alive. More stable than your excuses for disappearing. 😂',
    ],
    runtime: [
        '⏱️ Runtime looking healthy. Unlike that one laptop you swear is "just slow." 😂',
    ],
    botstatus: [
        '📡 Status checked. VANTA is online; your notifications are the ones under investigation. 😂',
    ],
    owner: [
        '👑 Owner lookup complete. Please behave — screenshots have memory. 😂',
    ],
    whoami: [
        '🕵️ Identity check complete. Anonymous knows, but Anonymous isn\'t snitching. 😂',
    ],
    about: [
        '🕶️ About loaded. More mysterious than your browser history. 😂',
    ],
    device: [
        '📱 Device scanned. Congratulations, your phone survived another update. 😂',
    ],
    ai: [
        '🧠 AI is thinking... unlike that friend who replies "lol" to everything. 😂',
    ],
    ask: [
        '🧠 Question received. Let the silicon committee decide your fate. 😂',
    ],
    gpt: [
        '🤖 GPT engaged. Human supervision recommended — especially for your ideas. 😂',
    ],
    claude: [
        '🤖 Claude is online. The robots are having a meeting without you. 😂',
    ],
    gemini: [
        '✨ Gemini has entered the room. Two brains, one chaotic WhatsApp. 😂',
    ],
    deepseek: [
        '🌊 DeepSeek activated. Diving deeper than your group-chat gossip. 😂',
    ],
    joke: [
        '😂 Comedy engine started. Finally, a command with useful qualifications.',
    ],
    jokeS: [
        '🤣 Joke mode armed. Your dignity may not survive this operation.',
    ],
    meme: [
        '😂 Meme generator online. Deploying emotional damage in 3... 2... 1...',
    ],
    facts: [
        '🧠 Facts incoming. Please put your conspiracy theories back in the drawer. 😂',
    ],
    fact: [
        '🧠 Fact delivered. Your brain just received a software update. 😂',
    ],
    quote: [
        '💬 Quote deployed. Screenshot first, pretend you invented it later. 😂',
    ],
    play: [
        '🎵 Music request received. Your DJ has arrived, no aux cable required. 😂',
    ],
    song: [
        '🎶 Fetching vibes. Even your neighbour is about to know your taste. 😂',
    ],
    music: [
        '🎧 Audio systems warming up. Please keep your bad singing away from the mic. 😂',
    ],
    download: [
        '📥 Download duty activated. Bandwidth is sweating already. 😂',
    ],
    ytmp3: [
        '🎧 Converting pixels into vibes. Technology really does too much. 😂',
    ],
    ytmp4: [
        '🎬 Video extraction in progress. Your gallery is about to get busier. 😂',
    ],
    sticker: [
        '🖼️ Sticker lab online. Because apparently words are no longer enough. 😂',
    ],
    weather: [
        '🌦️ Weather checked. Even the clouds are subscribed to VANTA. 😂',
    ],
    qrcode: [
        '🔳 QR magic ready. One square, infinite suspicious links. 😂',
    ],
    calc: [
        '🧮 Calculator engaged. Finally, something your phone cannot argue about. 😂',
    ],
    math: [
        '🧮 Mathematics has entered the chat. No cheating — the bot is watching. 😂',
    ],
    search: [
        '🔎 Search engine engaged. Let me Google what you could have Googled. 😂',
    ],
    news: [
        '📰 News scanner active. Gossip department pretending to be journalism. 😂',
    ],
    pair: [
        '🔗 Pairing request received. Two devices, one questionable amount of power. 😂',
    ],
}

function commandPick(cmd) {
    const key = String(cmd || '').toLowerCase()
    const arr = commandReplies[key]
    return arr ? pick(arr) : ''
}

const fun = [
    '😂 You asked for fun, Mahngueloh delivered.',
    '🤣 Certified nonsense department approved.',
    '😏 That was your daily dose of chaos.',
]

function enabled() { return global.__mahnguelohFunResponses ?? DEFAULT_FUN_RESPONSES }

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)] }
function category(cmd = '') {
    if (/^(epl|laliga|bundesliga|seriea|ligue1|cl|efl|el|wc|wrestling|wwe)/.test(cmd)) return sports
    if (/^(play|song|music|mp3|yt|tiktok|ig|instagram|twitter|x|facebook|fb|spotify|mediafire|video|download)/.test(cmd)) return download
    if (/^(joke|jokes|meme|memes|truth|dare|tod|trivia|fact|facts|quote|quotes|emojimix)/.test(cmd)) return fun
    return generic
}

function decorateText(text, cmd) {
    if (!enabled() || typeof text !== 'string' || !text.trim()) return text
    if (text.length > 2800) return text
    if (/^\s*(⏳|📥|🔄|⚠️|❌)\s*(Fetching|Downloading|Processing|Something went wrong)/i.test(text)) return text
    if (text.includes('┏━━❐') && text.length > 900) return text
    const specific = commandPick(cmd)
    if (specific) return `${text.trim()}\n\n_${specific}_`
    if (Math.random() > CHANCE) return text
    return `${text.trim()}\n\n_${pick(category(cmd))}_`
}

function wrapSocket(sock, cmd) {
    if (!enabled() || !sock || sock.__mahnguelohFunWrapped) return sock
    const wrapped = new Proxy(sock, {
        get(target, prop) {
            if (prop === '__mahnguelohFunWrapped') return true
            if (prop === 'sendMessage') {
                return async (jid, content, options) => {
                    if (content && typeof content === 'object' && typeof content.text === 'string' && !content.__noFun) {
                        content = { ...content, text: decorateText(content.text, cmd) }
                        delete content.__noFun
                    }
                    return target.sendMessage.call(target, jid, content, options)
                }
            }
            const value = Reflect.get(target, prop, target)
            return typeof value === 'function' ? value.bind(target) : value
        }
    })
    return wrapped
}

module.exports = { wrapSocket, decorateText }
