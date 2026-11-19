'use strict'
// ─────────────────────────────────────────────────────────────────────────────
//  .zip                → the whole bot as a .zip (tries your GitHub repo first)
//  .file list          → every code file
//  .file <name>        → code of ONE command (e.g. .file kick, .file racer) or one file
//                        (.file groups, .file plugins/arcade.js). Add "full" for the whole file.
//  .file all           → all command code (handler + plugins + lib) as a .zip
//  Owner only. Secrets (auth_info, .env, sessions, settings) are NEVER included.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const config = require('../config')
const fmt = require('../lib/format')

const ROOT = path.join(__dirname, '..')
const P = () => config.prefix || '.'
const codeCmds = new Set(['zip', 'getzip', 'file', 'getfile', 'sendfile'])

// ── never leave the bot: credentials, sessions, env files, logs, big junk ──
const SKIP_DIRS = new Set(['node_modules', '.git', 'auth_info', 'session_backup', 'tmp', '.npm', 'captures'])
const SECRET = /(^|\/)(\.env.*|settings\.json|creds.*|.*session.*\.json|app-state.*|pre-key.*|sender-key.*|chatbrain\.json|arcade-sessions\.json|.*\.(pem|key|log))$/i
const okFile = (rel) => !SECRET.test(rel)

function walk(dir, base = '', out = []) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name.startsWith('.git') && ent.name !== '.gitignore') continue
        const rel = base ? `${base}/${ent.name}` : ent.name
        if (ent.isDirectory()) { if (!SKIP_DIRS.has(ent.name)) walk(path.join(dir, ent.name), rel, out) }
        else if (okFile(rel)) out.push(rel)
    }
    return out
}

// ── tiny ZIP writer (no dependency) ──
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
const crc32 = (buf) => { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0 }
function makeZip(entries) {          // entries: [{ name, data:Buffer }]
    const files = [], central = []
    let offset = 0
    const d = new Date()
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    for (const { name, data } of entries) {
        const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8')
        const comp = zlib.deflateRawSync(data, { level: 9 })
        const useDeflate = comp.length < data.length
        const body = useDeflate ? comp : data
        const crc = crc32(data)
        const h = Buffer.alloc(30)
        h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6)
        h.writeUInt16LE(useDeflate ? 8 : 0, 8); h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12)
        h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(data.length, 22)
        h.writeUInt16LE(nameBuf.length, 26); h.writeUInt16LE(0, 28)
        files.push(h, nameBuf, body)
        const c = Buffer.alloc(46)
        c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8)
        c.writeUInt16LE(useDeflate ? 8 : 0, 10); c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14)
        c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24)
        c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42)
        central.push(c, nameBuf)
        offset += h.length + nameBuf.length + body.length
    }
    const cd = Buffer.concat(central)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
    return Buffer.concat([...files, cd, end])
}
const zipOf = (rels, prefix = '') => makeZip(rels.map(r => ({ name: prefix + r, data: fs.readFileSync(path.join(ROOT, r)) })))

// ── find the code of ONE command ─────────────────────────────────────────
// Walks forward from `start`, skipping strings/comments/template literals, to the matching `}`.
function matchBrace(src, open) {
    let depth = 0
    for (let i = open; i < src.length; i++) {
        const ch = src[i], nx = src[i + 1]
        if (ch === '/' && nx === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue }
        if (ch === '/' && nx === '*') { i = src.indexOf('*/', i + 2); if (i < 0) break; i++; continue }
        if (ch === '\'' || ch === '"') { for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === '\\') i++; continue }
        if (ch === '`') {
            for (i++; i < src.length && src[i] !== '`'; i++) {
                if (src[i] === '\\') { i++; continue }
                if (src[i] === '$' && src[i + 1] === '{') { const e = matchBrace(src, i + 1); if (e < 0) return -1; i = e }
            }
            continue
        }
        if (ch === '{') depth++
        else if (ch === '}') { depth--; if (depth === 0) return i }
    }
    return -1
}
const lineStart = (src, i) => src.lastIndexOf('\n', i - 1) + 1

function codeFiles() {
    return ['handler.js', 'index.js', 'config.js', ...walk(path.join(ROOT, 'plugins'), 'plugins'), ...walk(path.join(ROOT, 'lib'), 'lib')].filter(f => f.endsWith('.js') && fs.existsSync(path.join(ROOT, f)))
}

function findCommandBlocks(cmd) {
    const esc = cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const lit = new RegExp(`(['"])${esc}\\1`)
    const out = []
    for (const rel of codeFiles()) {
        const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
        const lines = src.split('\n')
        let pos = 0
        for (let li = 0; li < lines.length; li++) {
            const line = lines[li], start = pos
            pos += line.length + 1
            if (!lit.test(line)) continue
            const isCase = new RegExp(`case\\s+(['"])${esc}\\1\\s*:`).test(line)
            const isIf = /\b(if|else if)\s*\(/.test(line) && /(includes\(\s*cmd\s*\)|cmd\s*===|command\s*===|\.has\(\s*cmd\s*\))/.test(line)
            if (!isCase && !isIf) continue
            let from = start
            if (isCase) {            // include stacked "case 'a':" lines above
                let k = li
                while (k > 0 && /^\s*case\s/.test(lines[k - 1])) k--
                from = lines.slice(0, k).reduce((a, l) => a + l.length + 1, 0)
            }
            let open = src.indexOf('{', start + (isCase ? line.search(new RegExp(`case\\s+(['"])${esc}\\1\\s*:`)) : 0))
            // a case label without a brace → take lines until the next case/default
            const afterLabel = isCase ? line.slice(line.search(new RegExp(`case\\s+(['"])${esc}\\1\\s*:`))) : line
            let end
            if (isCase && !/\{\s*$/.test(afterLabel.trim()) && !/:\s*\{/.test(afterLabel)) {
                let k = li + 1
                while (k < lines.length && !/^\s*(case\s|default\s*:|\}\s*$)/.test(lines[k])) k++
                end = lines.slice(0, k).reduce((a, l) => a + l.length + 1, 0)
            } else {
                const close = open >= 0 ? matchBrace(src, open) : -1
                if (close < 0) continue
                end = close + 1
                const rest = src.indexOf('\n', end)
                end = rest < 0 ? src.length : rest + 1
            }
            const block = src.slice(from, end).replace(/\s+$/, '')
            if (block.length < 12 || block.length > 120_000) continue
            if (!out.some(o => o.rel === rel && o.block === block)) out.push({ rel, line: li + 1, block, src })
            break           // one block per file is enough
        }
    }
    return out
}

// Pull in the top-level helper functions a block calls (one level), so the snippet is usable.
function helpersFor(block, src) {
    const names = [...new Set([...block.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]))]
    const skip = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'require', 'await', 'async', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Math', 'Date', 'JSON', 'Promise', 'Buffer', 'Set', 'Map', 'RegExp', 'Error', 'console', 'setTimeout', 'clearTimeout', 'parseInt', 'parseFloat'])
    const parts = []
    for (const n of names) {
        if (skip.has(n) || parts.length >= 12) continue
        const m = new RegExp(`^(async\\s+)?function\\s+${n}\\s*\\(`, 'm').exec(src)
        if (!m) continue
        const open = src.indexOf('{', src.indexOf(')', m.index))
        const close = matchBrace(src, open)
        if (close > 0) parts.push(src.slice(m.index, close + 1))
    }
    return parts
}

function resolveFile(name) {
    const clean = name.replace(/^[./\\]+/, '').replace(/\\/g, '/')
    if (clean.includes('..')) return null
    for (const cand of [clean, clean + '.js', `plugins/${clean}`, `plugins/${clean}.js`, `lib/${clean}`, `lib/${clean}.js`]) {
        const abs = path.join(ROOT, cand)
        if (abs.startsWith(ROOT) && fs.existsSync(abs) && fs.statSync(abs).isFile() && okFile(cand)) return cand
    }
    return null
}

const kb = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.ceil(n / 1024) + ' KB'

async function sendDoc(sock, from, msg, buf, fileName, mimetype, caption) {
    return sock.sendMessage(from, { document: buf, fileName, mimetype, caption }, { quoted: msg })
}

// ── .zip ─────────────────────────────────────────────────────────────────
async function handleZip(sock, from, msg) {
    await sock.sendMessage(from, { text: '📦 Getting the bot zip…' }, { quoted: msg })
    const repo = config.githubRepo || 'mahngueloh/Vanta-effect-'
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_PAT
    // 1) the zip GitHub builds from your repo (main branch)
    try {
        const axios = require('axios')
        const res = await axios.get(`https://api.github.com/repos/${repo}/zipball`, {
            responseType: 'arraybuffer', timeout: 90_000, maxRedirects: 5, maxContentLength: 90 * 1024 * 1024,
            headers: { 'User-Agent': 'vanta-bot', Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        })
        const buf = Buffer.from(res.data)
        if (buf.length > 1024 && buf.readUInt32LE(0) === 0x04034b50) {
            await sendDoc(sock, from, msg, buf, `${repo.split('/')[1] || 'bot'}.zip`, 'application/zip', `📦 *${repo}* — straight from GitHub (${kb(buf.length)})`)
            return fmt.react(sock, msg, '✅')
        }
    } catch (e) { console.log('[zip] GitHub download failed:', e.response?.status || e.message) }
    // 2) fallback: zip the bot's own running files (secrets left out)
    const rels = walk(ROOT)
    const buf = zipOf(rels, 'Vanta-effect-/')
    if (buf.length > 95 * 1024 * 1024) return sock.sendMessage(from, { text: `❌ The zip is ${kb(buf.length)} — too big for WhatsApp. Use ${P()}file all instead.` }, { quoted: msg })
    await sendDoc(sock, from, msg, buf, 'Vanta-effect-.zip', 'application/zip', `📦 GitHub wasn't reachable (private repo? set GITHUB_TOKEN on Railway), so this is the bot's own running code — ${rels.length} files, ${kb(buf.length)}.\n_Sessions, .env and settings are not included._`)
    return fmt.react(sock, msg, '✅')
}

// ── .file ────────────────────────────────────────────────────────────────
async function handleFile(sock, from, args, msg) {
    const target = String(args[0] || '').replace(/^[.!#/]+/, '').trim()
    const full = /^(full|whole|file)$/i.test(args[1] || '')
    if (!target) {
        return sock.sendMessage(from, { text: [
            `🧩 *GET THE BOT'S CODE*`, ``,
            `*${P()}file <command>* — code of one command`,
            `   e.g. ${P()}file kick, ${P()}file racer, ${P()}file tiktok`,
            `*${P()}file <name>* — a whole file`,
            `   e.g. ${P()}file groups, ${P()}file plugins/arcade.js`,
            `*${P()}file <command> full* — the whole file that command lives in`,
            `*${P()}file list* — all code files`,
            `*${P()}file all* — every command's code (handler + plugins + lib) as a zip`,
            `*${P()}zip* — the whole bot as a zip`,
        ].join('\n') }, { quoted: msg })
    }
    if (target === 'list') {
        const rows = codeFiles().map(f => `• ${f} — ${kb(fs.statSync(path.join(ROOT, f)).size)}`)
        return sock.sendMessage(from, { text: `📚 *CODE FILES* (${rows.length})\n\n${rows.join('\n')}\n\n_${P()}file <name> sends one._` }, { quoted: msg })
    }
    if (/^(all|commands|everything)$/i.test(target)) {
        const rels = codeFiles()
        const buf = zipOf(rels, 'vanta-commands/')
        await sendDoc(sock, from, msg, buf, 'vanta-commands.zip', 'application/zip', `🧩 All command code — ${rels.length} files, ${kb(buf.length)}`)
        return fmt.react(sock, msg, '✅')
    }
    await fmt.react(sock, msg, '⏳')

    // a file by name/path
    const rel = !full ? resolveFile(target) : null
    const blocks = findCommandBlocks(target.toLowerCase())
    if (rel && !blocks.length) {
        const buf = fs.readFileSync(path.join(ROOT, rel))
        await sendDoc(sock, from, msg, buf, path.basename(rel), 'application/javascript', `📄 *${rel}* — ${kb(buf.length)}`)
        return fmt.react(sock, msg, '✅')
    }
    const arcadeGame = (() => { try { return (require('./arcade').GAMES || []).find(x => [x.id, ...(x.cmds || [])].includes(target.toLowerCase())) } catch { return null } })()
    if (!blocks.length && arcadeGame) {
        const g = arcadeGame
        await sendDoc(sock, from, msg, fs.readFileSync(path.join(ROOT, 'plugins/arcade.js')), 'arcade.js', 'application/javascript', `🕹️ *${g.title}* — the command code (all games share plugins/arcade.js)`)
        for (const f of [`assets/arcade/rich/${g.file}`, `assets/arcade/${g.file}`]) {
            const abs = path.join(ROOT, f)
            if (fs.existsSync(abs)) await sendDoc(sock, from, msg, fs.readFileSync(abs), `${g.id}-${f.includes('/rich/') ? 'in-chat' : 'standalone'}.html`, 'text/html', `🎮 ${g.title} — ${f.includes('/rich/') ? 'in-chat version (what the bot sends)' : 'standalone browser version'}`)
        }
        return fmt.react(sock, msg, '✅')
    }
    if (!blocks.length) {
        return sock.sendMessage(from, { text: `❌ Nothing called *${target}*.\nTry ${P()}file list, or a command name like ${P()}file kick.` }, { quoted: msg })
    }
    const b = blocks[0]
    if (full) {
        await sendDoc(sock, from, msg, Buffer.from(b.src), path.basename(b.rel), 'application/javascript', `📄 *${b.rel}* — the whole file that holds *${target}*`)
        return fmt.react(sock, msg, '✅')
    }
    const helpers = helpersFor(b.block, b.src)
    const out = [
        `// ─── ${P()}${target} ───  from ${b.rel} (line ${b.line})`,
        blocks.length > 1 ? `// also found in: ${blocks.slice(1).map(x => x.rel).join(', ')}` : null,
        ``, b.block, ``,
        helpers.length ? `// ─── helper functions this command uses (from the same file) ───` : null,
        ...helpers.flatMap(h => [h, ``]),
    ].filter(x => x !== null).join('\n')
    await sendDoc(sock, from, msg, Buffer.from(out, 'utf8'), `${target}.js`, 'application/javascript', `🧩 *${P()}${target}* — ${b.rel}:${b.line}${helpers.length ? ` (+${helpers.length} helper${helpers.length > 1 ? 's' : ''})` : ''}\n_Add *full* to get the whole file._`)
    return fmt.react(sock, msg, '✅')
}

async function handleCodeCmd(sock, from, cmd, args, msg, owner) {
    if (!owner) return sock.sendMessage(from, { text: '🔒 Owner only.' }, { quoted: msg })
    try {
        if (cmd === 'zip' || cmd === 'getzip') return await handleZip(sock, from, msg)
        return await handleFile(sock, from, args, msg)
    } catch (e) {
        console.error('[codeShare]', e.stack || e.message)
        return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ ${e.message}`]) }, { quoted: msg })
    }
}

module.exports = { codeCmds, handleCodeCmd, makeZip, findCommandBlocks }
