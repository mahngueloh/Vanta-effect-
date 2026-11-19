'use strict'
// ─────────────────────────────────────────────────────────────────────────────
// Every Nexray AI, each with its own command and job.
//   .aimodels            → full list, grouped by what each AI is for
//   .nxai <model> <text> → run any chat model by name (e.g. .nxai kimi hello)
// Endpoints: https://api.nexray.eu.cc/category/ai
// ─────────────────────────────────────────────────────────────────────────────
const config = require('../config')
const fmt = require('../lib/format')
const nexray = require('../lib/nexray')

// kind: text | image (generate) | audio | video | vision (needs a picture) | edit (picture + prompt)
const A = (cmds, path, kind, title, how, extra = {}) => ({ cmds, path, kind, title, how, param: 'text', ...extra })
const GROUPS = [
    ['💬 Chat AIs', [
        A(['chatgpt', 'gpt4'], '/ai/chatgpt', 'text', 'ChatGPT', 'ask anything'),
        A(['copilot'], '/ai/copilot', 'text', 'Copilot', 'ask anything'),
        A(['kimi'], '/ai/kimi', 'text', 'Kimi', 'ask anything'),
        A(['glm'], '/ai/glm', 'text', 'GLM', 'ask anything'),
        A(['venice'], '/ai/venice', 'text', 'Venice', 'ask anything (uncensored style)'),
        A(['felo'], '/ai/felo', 'text', 'Felo', 'answers with web knowledge'),
        A(['monica'], '/ai/monica', 'text', 'Monica', 'ask anything'),
        A(['openaichat'], '/ai/openai', 'text', 'OpenAI', 'ask anything'),
        A(['nexrayai'], '/ai/nexray', 'text', 'NexRay AI', 'ask anything'),
        A(['dolphin'], '/ai/dolphin', 'text', 'Dolphin', 'ask anything', { opt: (a) => /^(logical|creative|summarize|code-beginner|code-advanced)$/i.test(a[0] || '') ? { template: a.shift().toLowerCase() } : {} }),
    ]],
    ['🔎 Research & search AIs', [
        A(['perplexity'], '/ai/perplexity', 'text', 'Perplexity', 'researched answers'),
        A(['deepsearch'], '/ai/deepsearch', 'text', 'DeepSearch', 'deep research on a topic'),
        A(['webpilot'], '/ai/webpilot', 'text', 'WebPilot', 'web answers with sources'),
        A(['turboseek'], '/ai/turboseek', 'text', 'TurboSeek', 'search-style answers'),
        A(['morphic'], '/ai/morphic', 'text', 'Morphic', 'search-style answers'),
        A(['andisearch'], '/ai/andisearch', 'text', 'Andi Search', 'search-style answers'),
        A(['epsilon', 'papers'], '/ai/epsilon', 'text', 'Epsilon', 'find academic papers'),
    ]],
    ['🧑‍💻 Code, math & writing', [
        A(['llamacoder', 'coder'], '/ai/llamacoder', 'text', 'LlamaCoder', 'write code'),
        A(['mathgpt', 'solve'], '/ai/mathgpt', 'text', 'MathGPT', 'solve math problems'),
        A(['grammar', 'grammarcheck'], '/ai/grammarcheck', 'text', 'Grammar Check', 'fix grammar in a text'),
        A(['humanize', 'bypass'], '/ai/bypass', 'text', 'Humanizer', 'rewrite AI text so it reads human'),
        A(['quillbot'], '/ai/quillbot', 'text', 'QuillBot', 'rewrite / paraphrase'),
        A(['dream', 'dreamanalyze'], '/ai/dreamanalyze', 'text', 'Dream Analyzer', 'explain a dream'),
        A(['homework', 'schoolhub'], '/ai/schoolhub', 'text', 'SchoolHub', 'help with homework'),
        A(['skole'], '/ai/skole', 'text', 'Skole', 'learning help'),
    ]],
    ['🕌 Faith & wisdom', [
        A(['islamai', 'muslim'], '/ai/muslim', 'text', 'Muslim AI', 'questions about Islam'),
        A(['islamcity'], '/ai/islamcity', 'text', 'IslamCity', 'questions about Islam'),
        A(['gitagpt', 'gita'], '/ai/gitagpt', 'text', 'GitaGPT', 'questions about the Gita'),
    ]],
    ['🎨 Image makers', [
        A(['imagine', 'text2img'], '/ai/v1/text2image', 'image', 'Text to Image', 'describe a picture', { param: 'prompt' }),
        A(['flux'], '/ai/v1/flux', 'image', 'Flux', 'describe a picture', { param: 'prompt' }),
        A(['ideogram'], '/ai/ideogram', 'image', 'Ideogram', 'pictures with good text in them', { param: 'prompt' }),
        A(['magicstudio'], '/ai/magicstudio', 'image', 'MagicStudio', 'describe a picture', { param: 'prompt' }),
        A(['vider'], '/ai/vider', 'image', 'Vider', 'describe a picture', { param: 'prompt' }),
        A(['deepimg'], '/ai/deepimg', 'image', 'DeepImg', 'describe a picture', { param: 'prompt' }),
        A(['wcimg', 'writecreamimg'], '/ai/writecreamimg', 'image', 'WriteCream Image', 'describe a picture', { param: 'prompt' }),
        A(['logo', 'sologo'], '/ai/sologo', 'image', 'Logo Maker', 'describe the logo', { param: 'prompt' }),
    ]],
    ['🖼️ Picture tools (reply to a picture)', [
        A(['vision', 'lookat'], '/ai/screnapp', 'vision', 'Vision', 'ask about the picture (default: describe it)', { param: 'text', imgParam: 'url_image' }),
        A(['img2prompt', 'toprompt'], '/ai/image2prompt', 'vision', 'Image to Prompt', 'get a prompt that recreates the picture', { param: null, imgParam: 'url' }),
        A(['nanobanana', 'editimg'], '/ai/nanobanana', 'edit', 'Nano Banana', 'edit the picture, e.g. make the sky purple', { param: 'param' }),
        A(['gptimage'], '/ai/gptimage', 'edit', 'GPT Image', 'edit the picture with a prompt', { param: 'param' }),
    ]],
    ['🎵 Voice, music & video', [
        A(['tts', 'speak'], '/ai/gemini-tts', 'audio', 'Gemini Voice', 'turn text into speech'),
        A(['dracintts'], '/ai/dracin-tts', 'audio', 'Dracin Voice', 'turn text into speech'),
        A(['suno', 'aimusic'], '/ai/suno', 'audio', 'Suno', 'describe a song to generate', { param: 'prompt', slow: true }),
        A(['veo2', 'aivideo'], '/ai/veo2', 'video', 'Veo2', 'describe a video to generate', { param: 'prompt', slow: true }),
        A(['veo3'], '/ai/veo3', 'video', 'Veo3', 'reply to a picture + describe the motion', { param: 'prompt', imgParam: 'image_url', needImage: true, slow: true }),
    ]],
]
// extra chat models reachable only through .nxai <name> <text>
const EXTRA_CHAT = ['alisia', 'dgaf', 'duck', 'heck', 'hammer', 'jadve', 'jeeves', 'lumin', 'natalie', 'nowtech', 'overchat', 'powerbrain', 'public', 'riple', 'simisimi', 'turbochat', 'zahanat', 'gemini', 'claude', 'deepseek', 'gpt-3.5-turbo']

const BY_CMD = new Map()
for (const [, list] of GROUPS) for (const a of list) for (const c of a.cmds) BY_CMD.set(c, a)
const nexAiCmds = new Set([...BY_CMD.keys(), 'aimodels', 'nxai', 'nexray'])
const P = () => config.prefix || '.'

const chunk = (t, n = 3500) => { const out = []; for (let i = 0; i < t.length; i += n) out.push(t.slice(i, i + n)); return out }

async function sendText(sock, from, msg, title, text) {
    const parts = chunk(text)
    await sock.sendMessage(from, { text: `🤖 *${title}*\n\n${parts[0]}` }, { quoted: msg })
    for (let i = 1; i < parts.length; i++) await sock.sendMessage(from, { text: parts[i] })
}

async function getPicture(sock, msg) {
    const { extractImageInput } = require('./aiChat')
    const img = await extractImageInput(sock, msg)
    return img ? { buf: img.buffer, mime: img.mimeType } : null
}

async function runCommand(sock, from, a, args, msg) {
    const text = args.join(' ').trim()
    const params = {}
    let pic = null
    if (a.kind === 'vision' || a.kind === 'edit' || a.needImage) {
        pic = await getPicture(sock, msg)
        if (!pic) return sock.sendMessage(from, { text: `🖼️ Reply to a picture (or send one with the command as its caption).\n\nExample: *${P()}${a.cmds[0]}${a.param ? ' <what you want>' : ''}*` }, { quoted: msg })
    }
    if (a.kind !== 'vision' && !text) {
        return sock.sendMessage(from, { text: fmt.usage(a.cmds[0], `<${a.how}>`) }, { quoted: msg })
    }
    await fmt.react(sock, msg, '⏳')
    if (a.slow) await sock.sendMessage(from, { text: `⏳ ${a.title} is working… this can take a minute or two.` }, { quoted: msg })

    let res
    if (a.kind === 'edit') {
        // The docs only say "POST: image, param". Try the file upload first (prompt in both the
        // query and the form), then the same call with a public link to the picture.
        const FD = require('form-data')
        const form = new FD()
        form.append('image', pic.buf, { filename: 'image.jpg', contentType: pic.mime || 'image/jpeg' })
        form.append('param', text)
        res = await nexray.call(a.path, { method: 'POST', params: { param: text }, form, timeout: 120000 })
        const ok = r => r.type === 'binary' || (r.type === 'json' && r.json?.status !== false && nexray.pickUrl(r.json))
        if (!ok(res)) {
            const first = res
            try {
                const { uploadPublic } = require('./image')
                const up = await uploadPublic(pic.buf, 'image.jpg')
                const form2 = new FD(); form2.append('image', up.url); form2.append('param', text)
                const second = await nexray.call(a.path, { method: 'POST', params: { image: up.url, param: text }, form: form2, timeout: 120000 })
                res = ok(second) ? second : first
            } catch { res = first }
            console.log(`[nexrayAI] ${a.cmds[0]} edit attempts → ${first.status}${res !== first ? ' / ' + res.status : ''}`)
        }
    } else {
        const o = a.opt ? a.opt(args) : {}
        Object.assign(params, o)
        const t = a.opt ? args.join(' ').trim() : text
        if (a.param && (t || a.kind !== 'vision')) params[a.param] = t
        if (pic) {
            const { uploadPublic } = require('./image')
            const up = await uploadPublic(pic.buf, 'image.jpg')
            params[a.imgParam] = up.url
            if (a.kind === 'vision' && a.param && !params[a.param]) params[a.param] = 'Describe this picture in detail.'
        }
        res = await nexray.call(a.path, { params, timeout: a.slow ? 240000 : 60000 })
    }

    // Media comes back either as the file itself or as JSON holding its URL.
    const media = async () => {
        if (res.type === 'binary') return { buf: res.buf, ct: res.ct }
        const url = res.type === 'json' ? nexray.pickUrl(res.json) : null
        return url ? { url } : null
    }
    if (a.kind === 'image' || (a.kind === 'edit')) {
        const m = await media()
        if (m) {
            await sock.sendMessage(from, { image: m.buf || { url: m.url }, caption: `🎨 *${a.title}*${text ? `\n_${text.slice(0, 200)}_` : ''}` }, { quoted: msg })
            return fmt.react(sock, msg, '✅')
        }
    } else if (a.kind === 'audio') {
        const m = await media()
        if (m) {
            await sock.sendMessage(from, { audio: m.buf || { url: m.url }, mimetype: 'audio/mpeg', ptt: false }, { quoted: msg })
            return fmt.react(sock, msg, '✅')
        }
    } else if (a.kind === 'video') {
        const m = await media()
        if (m) {
            await sock.sendMessage(from, { video: m.buf || { url: m.url }, mimetype: 'video/mp4', caption: `🎬 *${a.title}*` }, { quoted: msg })
            return fmt.react(sock, msg, '✅')
        }
    } else {
        const out = res.type === 'json' && res.json?.status !== false ? nexray.pickText(res.json) : null
        if (out) { await sendText(sock, from, msg, a.title, out); return fmt.react(sock, msg, '✅') }
    }
    const why = res.type === 'json' ? nexray.cleanErr(res.json) || JSON.stringify(res.json).slice(0, 160) : `HTTP ${res.status}${res.raw ? ' — ' + res.raw.slice(0, 120) : ''}`
    console.log(`[nexrayAI] ${a.cmds[0]} failed: ${why}`)
    await fmt.react(sock, msg, '❌')
    return sock.sendMessage(from, { text: fmt.box(`${a.title.toUpperCase()} FAILED`, [`❌ ${why}`, ``, `💡 Try again in a moment, or use *${P()}aimodels* to pick another AI.`]) }, { quoted: msg })
}

async function handleNexAI(sock, from, cmd, args, msg) {
    try {
        if (cmd === 'aimodels') {
            const lines = GROUPS.map(([title, list]) => `*${title}*\n` + list.map(a => `  • *${P()}${a.cmds[0]}* — ${a.how}`).join('\n'))
            return sock.sendMessage(from, { text: `🤖 *ALL AI MODELS*\n\n${lines.join('\n\n')}\n\n*More chat models:* ${P()}nxai <name> <question>\n_${EXTRA_CHAT.join(', ')}_\n\n_Plain ${P()}ai tries them automatically until one answers._` }, { quoted: msg })
        }
        if (cmd === 'nxai' || cmd === 'nexray') {
            const name = String(args.shift() || '').toLowerCase()
            const q = args.join(' ').trim()
            const known = BY_CMD.get(name)
            if (known && known.kind === 'text') return runCommand(sock, from, known, args, msg)
            if (!EXTRA_CHAT.includes(name) || !q) return sock.sendMessage(from, { text: `Usage: *${P()}nxai <model> <question>*\nModels: ${[...EXTRA_CHAT, ...[...BY_CMD.values()].filter(a => a.kind === 'text').map(a => a.cmds[0])].join(', ')}` }, { quoted: msg })
            return runCommand(sock, from, A([name], `/ai/${name}`, 'text', name[0].toUpperCase() + name.slice(1), 'ask anything'), args, msg)
        }
        const a = BY_CMD.get(cmd)
        if (a) return await runCommand(sock, from, a, args, msg)
    } catch (e) {
        console.error('[nexrayAI]', cmd, e.message)
        try { await fmt.react(sock, msg, '❌') } catch {}
        return sock.sendMessage(from, { text: fmt.box('AI ERROR', [`❌ ${e.message}`]) }, { quoted: msg })
    }
}

module.exports = { nexAiCmds, handleNexAI, GROUPS }
