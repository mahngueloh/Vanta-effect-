'use strict'

// Self-heal on startup: install dependencies when node_modules is missing OR
// when the deployed @neoxr/baileys version does not match this project's pinned
// version. This matters after uploading a new ZIP to a panel that preserves
// the old node_modules directory.
try {
    const pkg = require('./package.json')
    const wantedWs = pkg.dependencies?.['@neoxr/baileys']
    require.resolve('dotenv')
    // Read the installed version straight from disk instead of
    // require('@neoxr/baileys/package.json') — that subpath require is
    // blocked if the package defines an "exports" map without it.
    const installedWs = JSON.parse(require('fs').readFileSync(
        require('path').join(__dirname, 'node_modules', '@neoxr', 'baileys', 'package.json'), 'utf8')).version
    if (wantedWs && installedWs !== wantedWs.replace(/^\^/, '')) {
        throw new Error(`@neoxr/baileys ${installedWs} installed, ${wantedWs} required`)
    }
} catch (e) {
    console.log(`[ SETUP ] ${e.message || 'Dependencies missing'} — running npm install (this can take a minute)...`)
    try {
        require('child_process').execSync('npm install', { stdio: 'inherit', cwd: __dirname })
        console.log('[ SETUP ] Install complete')
    } catch (installErr) {
        // Don't let a failed self-heal npm install crash the process with a
        // raw stack trace — print a clear message and exit cleanly instead.
        console.log('[ SETUP ] npm install failed — the bot cannot start without its dependencies.')
        console.log('[ SETUP ] Check package.json (dependencies/overrides) and the panel\'s npm log for the real error, then restart.')
        process.exit(1)
    }
}

require('dotenv').config({ path: require('path').join(__dirname, '.env') })

const fs   = require('fs')
const path = require('path')
const os   = require('os')

// Keep the process alive indefinitely even if every socket/timer is torn
// down (e.g. after giving up on a dead session below). Without this, an
// empty event loop lets Node exit on its own — and on hosts that auto-
// restart the process the instant it exits, that turns a clean "give up"
// into an invisible infinite restart loop.
setInterval(() => {}, 24 * 60 * 60 * 1000)

// ── Persisted quick-disconnect streak ───────────────────────────────────────
// An in-memory counter doesn't survive a process restart. Some hosts
// auto-restart the process the instant it exits (any exit code), which
// silently resets any in-memory "give up after N failures" counter back to
// zero — so what should be a clean stop instead looks like the bot
// reconnecting forever. Persisting the streak to disk closes that gap: the
// count survives restarts, so the give-up logic actually gives up.
const healthPath = path.join(__dirname, 'data', 'session-health.json')
function loadStreak() {
    try { return JSON.parse(fs.readFileSync(healthPath, 'utf8')).streak || 0 } catch { return 0 }
}
function saveStreak(n) {
    try {
        fs.mkdirSync(path.dirname(healthPath), { recursive: true })
        fs.writeFileSync(healthPath, JSON.stringify({ streak: n, updatedAt: Date.now() }))
    } catch {}
}

// Always ensure a real, editable .env exists — dotenv.config() only READS a
// file, it never creates one. This is ALSO run from package.json's
// postinstall (scripts/ensure-env.js) so the file exists right after a
// fresh install, before you ever press Start — this call here is just a
// safety net for the rare case postinstall didn't run.
require('./scripts/ensure-env').ensureEnvFile(__dirname)

// Silences noisy libsignal-node debug prints (not routed through the logger)
const NOISY_PATTERNS = [
    /Closing (stale open|open) session/i,
    /Closing session:/i,
    /SessionEntry\s*\{/,
]

// ── Self-healing session recovery ───────────────────────────────────────────
// Repeated "Bad MAC" errors are a known Baileys/libsignal failure mode.
// They can leave incoming-message decryption stuck while the WebSocket still
// looks connected. We recover conservatively rather than blindly deleting the
// whole auth database.
let badMacHits = 0
let badMacWindowStart = Date.now()
let recoveryInFlight = false
let lastRecoveryAt = 0
let badMacRecoveries = 0
let badMacRecoveryWindowStart = Date.now()
const badMacSessionIds = new Set()
let suppressBadMacBlock = false

// Bad-MAC is a known Baileys/libsignal failure mode. In particular, deleting
// every session file immediately is NOT a reliable universal fix: upstream
// reports show some problematic IDs (especially group/broadcast/LID sessions)
// can be recreated and continue failing. The safer strategy is:
//   1) reconnect once using the current persisted auth state;
//   2) only if the same problem returns, delete the specifically implicated
//      session file(s), not the whole Signal database;
//   3) never create a reconnect storm.
const BAD_MAC_THRESHOLD          = 3
const BAD_MAC_WINDOW_MS          = 60_000
const RECOVERY_COOLDOWN_MS       = 180_000
const MAX_TARGETED_CLEANUPS      = 2
const RECOVERY_WINDOW_MS         = 15 * 60_000
// Once a specific session id has crossed this many hits, further errors
// from THAT SAME id are treated as pure noise (almost always a remote
// party's own stale session, which no amount of local reconnecting fixes)
// and get silenced without triggering any recovery action. A brand-new id
// that starts erroring is a different, unproven symptom — it still gets
// the full conservative recovery treatment below. This is deliberately
// scoped per-id rather than a blanket "stop all recovery forever": a known
// noisy contact shouldn't keep triggering reconnects, but that's not a
// reason to give up on self-healing if a genuinely new problem shows up.
const KNOWN_NOISY_AFTER = 3
const sessionIdHitCounts = new Map()
const loggedBadMacSessions = new Set()

function noteBadMacSessionIds(text) {
    // Examples emitted by libsignal/Baileys include:
    //   "at async 25472577602.0 [as awaitable]"
    //   "at async 123456789012345_1.0 [as awaitable]"
    const patterns = [
        /\bat async ([A-Za-z0-9._:-]+) \[as awaitable\]/g,
        /\b(?:session|jid)[=: ]+['"]?([0-9]{7,24}(?:[_:.][A-Za-z0-9._:-]+)*)['"]?/gi,
    ]
    for (const re of patterns) {
        for (const m of String(text || '').matchAll(re)) {
            if (m[1] && m[1].length <= 80) badMacSessionIds.add(m[1])
        }
    }
}

function targetedSessionFiles() {
    const authDir = path.join(__dirname, 'auth_info')
    const files = []
    try {
        for (const f of fs.readdirSync(authDir)) {
            if (!/^session-.*\.json$/.test(f)) continue
            if (!badMacSessionIds.size) continue
            const base = f.replace(/^session-/, '').replace(/\.json$/, '')
            for (const id of badMacSessionIds) {
                if (base === id || base.startsWith(`${id}_`) || base.startsWith(`${id}.`)) {
                    files.push(f)
                    break
                }
            }
        }
    } catch (e) {
        console.log('[ RECOVER ] Could not inspect auth_info:', e.message)
    }
    return [...new Set(files)]
}

function wipeTargetedCorruptedSessions() {
    const authDir = path.join(__dirname, 'auth_info')
    const files = targetedSessionFiles()
    let cleared = 0
    for (const f of files) {
        try { fs.unlinkSync(path.join(authDir, f)); cleared++ } catch {}
    }
    return { cleared, files }
}

function maybeRecoverFromBadMac(text) {
    noteBadMacSessionIds(text)

    // Bump per-id hit counts; the moment an id crosses into "known noisy"
    // territory, log it once and stop treating its errors as a recovery
    // signal. If every id implicated in THIS message is already known
    // noisy, there's nothing new here — skip the reconnect machinery
    // entirely rather than churning over an already-diagnosed harmless case.
    let allKnownNoisy = badMacSessionIds.size > 0
    for (const id of badMacSessionIds) {
        const hits = (sessionIdHitCounts.get(id) || 0) + 1
        sessionIdHitCounts.set(id, hits)
        if (hits >= KNOWN_NOISY_AFTER) {
            if (!loggedBadMacSessions.has(id)) {
                loggedBadMacSessions.add(id)
                console.log(`[ SILENCE ] Bad MAC from session ${id} — suppressed after ${hits} repeats (looks like a stale session on the sender's side; bot is unaffected)`)
            }
        } else {
            allKnownNoisy = false
        }
    }
    if (allKnownNoisy) return

    const now = Date.now()

    if (now - badMacWindowStart > BAD_MAC_WINDOW_MS) {
        badMacWindowStart = now
        badMacHits = 0
    }
    badMacHits++

    if (now - badMacRecoveryWindowStart > RECOVERY_WINDOW_MS) {
        badMacRecoveryWindowStart = now
        badMacRecoveries = 0
    }

    if (badMacHits < BAD_MAC_THRESHOLD) return
    if (recoveryInFlight || now - lastRecoveryAt < RECOVERY_COOLDOWN_MS) return

    recoveryInFlight = true
    lastRecoveryAt = now
    badMacHits = 0
    badMacRecoveries++

    setTimeout(async () => {
        try {
            // First recovery is deliberately a clean socket restart with the
            // CURRENT auth_info. This is important because SESSION_ID in .env
            // may be stale; restoreSessionFromConfig() now refuses to overwrite a
            // healthy persisted auth state during reconnects.
            if (badMacRecoveries > 1 && badMacRecoveries <= MAX_TARGETED_CLEANUPS) {
                const result = wipeTargetedCorruptedSessions()
                if (result.cleared) {
                    console.log(`[ RECOVER ] Bad MAC persisted — cleared ${result.cleared} targeted Signal session file(s): ${result.files.join(', ')}`)
                } else {
                    console.log('[ RECOVER ] Bad MAC persisted, but no implicated session file could be mapped; reconnecting with current auth state.')
                }
            } else {
                console.log('[ RECOVER ] Reconnecting with current auth state after repeated Bad MAC errors...')
            }
            scheduleReconnect(1500, 'bad-mac')
        } catch (e) {
            console.log('[ RECOVER ] recovery failed:', e.message)
            scheduleReconnect(5000, 'bad-mac-recovery-failed')
        } finally {
            recoveryInFlight = false
        }
    }, 250)
}

function filterWrite(origWrite) {
    return function (chunk, ...rest) {
        const str = typeof chunk === 'string' ? chunk : chunk?.toString?.('utf8') || ''
        // Swallow the WHOLE Bad MAC error block (the triggering line plus
        // every "  at ..." stack-trace continuation line that follows it
        // across subsequent writes), not just the first line — otherwise
        // the stack trace still floods the console even with the summary
        // line suppressed.
        if (/Bad MAC|Failed to decrypt message/i.test(str)) {
            suppressBadMacBlock = true
            maybeRecoverFromBadMac(str)
            return true // pretend it was written
        }
        if (suppressBadMacBlock) {
            if (/^\s+at\s/.test(str) || /^\s*\.\.\.\s*$/.test(str) || /^\s*$/.test(str)) return true
            suppressBadMacBlock = false
        }
        if (NOISY_PATTERNS.some(p => p.test(str))) return true // pretend it was written
        return origWrite.call(this, chunk, ...rest)
    }
}
process.stdout.write = filterWrite(process.stdout.write.bind(process.stdout))
process.stderr.write = filterWrite(process.stderr.write.bind(process.stderr))

const { logEnvDiagnostics } = require('./lib/envCheck')
logEnvDiagnostics()

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    Browsers,
    proto,
    downloadMediaMessage,
    hkdf,
    aesDecryptGCM,
    generateWAMessageContent,
    generateWAMessageFromContent,
} = require('@neoxr/baileys')
const { Boom }  = require('@hapi/boom')
const pino      = require('pino')
const config    = require('./config')
const fmt       = require('./lib/format')
const { getBody, getSender, isOwner, cleanJid, jidToNum } = require('./lib/utils')
const msgStore  = require('./lib/messageStore')
const { printErrorBox } = require('./lib/errorBox')
const { runtimeSettings, STATUS_EMOJIS } = require('./plugins/ownerCmds')
const uncachedNoticeCooldown = new Map()
let lastMsgContext = {}
const { handleMessage }    = require('./handler')
const { handleGroupEvents } = require('./plugins/groups')
const { ensureYtdlp }      = require('./plugins/downloader')
const { initNewsMonitor }  = require('./plugins/newsMonitor')

const log     = pino({ level: 'silent' })
const seen    = new Set()
const rateMap = new Map()
let onlineSent = false, retries = 0, retryTimer = null, sock = null, bannerShown = false, statusReportShown = false, joinedUpdatesGroup = false, lastOpenAt = 0, quickDisconnectStreak = loadStreak()
let connectPromise = null
let socketGeneration = 0

function scheduleReconnect(delayMs, reason = 'connection') {
    if (retryTimer) return
    retryTimer = setTimeout(() => {
        retryTimer = null
        connect().catch(e => printErrorBox('Reconnect Error', e, lastMsgContext))
    }, Math.max(0, Number(delayMs) || 0))
    if (reason) console.log(`[ CONN ] Reconnect scheduled in ${Math.ceil(Math.max(0, Number(delayMs) || 0) / 1000)}s (${reason})`)
}

function cleanupSocket() {
    if (!sock) return
    try { sock.ev.removeAllListeners() } catch {}
    try { sock.end(new Error('reconnecting')) } catch {}
    sock = null
}

function dedup(id) {
    if (!id || seen.has(id)) return false
    seen.add(id)
    if (seen.size > 2000) {
        const a = [...seen]; seen.clear(); a.slice(-1000).forEach(i => seen.add(i))
    }
    return true
}

function rateOk(jid) {
    const now = Date.now(), last = rateMap.get(jid) || 0
    if (now - last < 2000) return false
    rateMap.set(jid, now)
    return true
}

function showCode(code, phone) {
    // Format as XXXX-XXXX
    const show = (code || '').replace(/\W/g, '').match(/.{1,4}/g)?.join('-') || code
    console.log('\n' + '━'.repeat(52))
    console.log('  🔑  PAIRING CODE  →  ' + show)
    console.log('━'.repeat(52))
    console.log('\n  Steps to link on WhatsApp:')
    console.log('  1. Open WhatsApp → tap ⋮ (3-dot menu)')
    console.log('  2. Linked Devices → Link a Device')
    console.log('  3. Tap "Link with phone number"')
    console.log('  4. Enter your number: ' + phone)
    console.log('  5. Enter the code above')
    console.log('\n  ⚠  Code expires in ~60 seconds.')
    console.log('     If it says invalid → delete the auth_info')
    console.log('     folder and restart the bot for a fresh code.\n')
}

const MSG_COLORS = ['\x1b[36m', '\x1b[35m', '\x1b[33m', '\x1b[32m', '\x1b[34m']
let msgColorIdx = 0
function printMessageLog(ctx, text) {
    const reset = '\x1b[0m'
    const c1 = MSG_COLORS[msgColorIdx % MSG_COLORS.length]
    const c2 = MSG_COLORS[(msgColorIdx + 1) % MSG_COLORS.length]
    msgColorIdx++
    const bar = '─'.repeat(18)
    const now = new Date()

    console.log(`${c1}${bar}${reset}⌐ ${c2}${config.botName}${reset} ⌐${c1}${bar}${reset}`)
    console.log(`» Sent Time: ${now.toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })}`)
    console.log(`» Date: ${now.toLocaleDateString('en-GB')}`)
    console.log(`» Message Type: ${ctx.messageType}`)
    console.log(`» Sender Name: ${ctx.senderName}`)
    console.log(`» Chat ID: ${ctx.chatId}`)
    console.log(`» Text: ${text}`)
    console.log(`${c2}${bar}${reset}⌐⌐${c1}${bar}${reset}`)
}

function printBootBanner(needsPairing, version) {
    const C = {
        reset:'\x1b[0m',
        bold:'\x1b[1m',
        cyan:'\x1b[36m',
        green:'\x1b[32m',
        yellow:'\x1b[33m',
        magenta:'\x1b[35m',
        gray:'\x1b[90m'
    }

    let pluginCount = 0
    try {
        pluginCount = fs.readdirSync(path.join(__dirname, 'plugins'))
            .filter(f => f.endsWith('.js')).length
    } catch {}

    const mode = config.mode === 'public' ? 'PUBLIC' : 'PRIVATE'
    const auth = needsPairing ? 'PAIRING REQUIRED' : 'SESSION READY'
    const uptimeSec = process.uptime()
    const hours = Math.floor(uptimeSec / 3600)
    const minutes = Math.floor((uptimeSec % 3600) / 60)

    const line = (label, value) =>
        console.log(`┃ ${C.gray}${label.padEnd(12)}${C.reset}: ${value}`)

    console.log('')
    console.log(`${C.cyan}╭──────────────────────────────────────────────────╮${C.reset}`)
    console.log(`${C.cyan}│${C.reset}     ${C.bold}${C.magenta}◆  M A H N G U E L O H   V A N T A  ◆${C.reset}     ${C.cyan}│${C.reset}`)
    console.log(`${C.cyan}│${C.reset}         ${C.bold}We are Anonymous. We are Legion…${C.reset}         ${C.cyan}│${C.reset}`)
    console.log(`${C.cyan}╰──────────────────────────────────────────────────╯${C.reset}`)

    console.log(`\n${C.magenta}${C.bold}╭─〔 VANTA BOOT SEQUENCE 〕────────────────────────╮${C.reset}`)
    line('Protocol', `${C.bold}ANONYMOUS${C.reset}`)
    line('Identity', `${C.bold}VANTA CORE${C.reset}`)
    line('Mode', mode === 'PUBLIC' ? `${C.green}${mode}${C.reset}` : `${C.yellow}${mode}${C.reset}`)
    line('Prefix', `[ ${config.prefix} ]`)
    line('Owner', config.ownerName)
    line('Plugins', `${C.green}${pluginCount} loaded${C.reset}`)
    line('Version', `v${config.version || '3.1.0'}`)
    line('Auth', needsPairing ? `${C.yellow}${auth}${C.reset}` : `${C.green}${auth}${C.reset}`)
    console.log(`${C.magenta}╰──────────────────────────────────────────────────╯${C.reset}`)

    console.log(`\n${C.cyan}${C.bold}╭─〔 CORE RUNTIME 〕────────────────────────────────╮${C.reset}`)
    line('Node.js', process.version)
    line('Platform', `${os.platform()} ${os.arch()}`)
    line('Baileys', version.join('.'))
    line('Uptime', `${hours}h ${minutes}m`)
    line('Status', `${C.green}INITIALIZING${C.reset}`)
    console.log(`${C.cyan}╰──────────────────────────────────────────────────╯${C.reset}`)

    console.log(`\n${C.magenta}${C.bold}✦ VANTA IS PREPARING THE CONNECTION LAYER...${C.reset}`)
    console.log(`${C.gray}  ${config.themeLine || 'We are Anonymous. We are Legion…'}${C.reset}`)
    console.log('')
}

function printStatusReport(phone, version) {
    const C = { reset:'\x1b[0m', bold:'\x1b[1m', cyan:'\x1b[36m', green:'\x1b[32m', yellow:'\x1b[33m', red:'\x1b[31m', gray:'\x1b[90m' }
    const on  = `${C.green}✓ ON${C.reset}`
    const off = `${C.red}✗ OFF${C.reset}`
    const ok  = (s) => `${C.green}✓ ${s}${C.reset}`

    let pluginCount = 0
    try { pluginCount = fs.readdirSync(path.join(__dirname, 'plugins')).filter(f => f.endsWith('.js')).length } catch {}

    const maskedPhone = phone ? phone.slice(0, 3) + '*'.repeat(Math.max(0, phone.length - 6)) + phone.slice(-3) : 'unknown'
    const memMb = Math.round(process.memoryUsage().rss / 1024 / 1024)

    const line = (label, value) => console.log(`  ${C.gray}${label.padEnd(10)}${C.reset}: ${value}`)

    console.log(`\n${C.cyan}${C.bold}◆ CONFIGURATION${C.reset}`)
    line('Prefix', config.prefix)
    line('Mode', config.mode === 'public' ? ok('PUBLIC') : `${C.yellow}PRIVATE${C.reset}`)
    line('Owner', config.ownerName)
    line('Plugins', ok(`${pluginCount} loaded`))

    console.log(`\n${C.cyan}${C.bold}◆ RUNTIME${C.reset}`)
    line('Node.js', process.version)
    line('Platform', `${os.platform()} ${os.arch()}`)
    line('Memory', `${memMb} MiB`)
    line('Baileys', version.join('.'))

    console.log(`\n${C.cyan}${C.bold}◆ TOGGLES${C.reset}`)
    const entries = Object.entries(runtimeSettings)
    for (let i = 0; i < entries.length; i += 2) {
        const [k1, v1] = entries[i]
        const [k2, v2] = entries[i + 1] || []
        const disp = v => (typeof v === 'string' ? (v === 'off' ? off : `${on} (${v})`) : (v ? on : off))
        const left  = `${k1.padEnd(18)}: ${disp(v1)}`
        const right = k2 ? `${k2.padEnd(18)}: ${disp(v2)}` : ''
        console.log(`  ${left}  ${right}`)
    }

    console.log(`\n${C.cyan}${C.bold}◆ CONNECTION${C.reset}`)
    line('WhatsApp', ok('connected'))
    line('Account', `+${maskedPhone}`)
    console.log('')
}

// ── Session ID restore (from the MAHNGUELOH MD SESSION pairing site) ───────
// Decodes a "MAHNGUELOH~<base64 gzip>" SESSION_ID from config.js (or optional .env override) into ./auth_info
// BEFORE useMultiFileAuthState reads it, so if it's valid, Baileys sees an
// already-registered session and skips pairing-code requests entirely.
// Get a session ID at https://mahngueloh-md-session.onrender.com/
const SESSION_PREFIX = 'MAHNGUELOH~'
// Pure decode check — no file writes — so both the real restore below and
// the console-paste listener further down can ask "is this actually a
// complete, decodable session yet?" without duplicating the zlib logic.
// Local, self-contained format: the ENTIRE auth bundle is packed into the
// string itself (gzip+base64), so decoding needs no network call and can
// never expire or depend on any server being up. Several thousand
// characters long — which is exactly why the shorter format below exists.
function tryDecodeSessionId(sessionId) {
    try {
        const zlib = require('zlib')
        const gz = Buffer.from(sessionId.slice(SESSION_PREFIX.length), 'base64')
        const bundle = JSON.parse(zlib.gunzipSync(gz).toString('utf8'))
        return { ok: true, bundle }
    } catch (e) {
        const truncated = /unexpected end of file|incorrect header check|invalid.*base64/i.test(e.message)
        return { ok: false, truncated, error: e.message }
    }
}

const SHORT_SESSION_PREFIX = 'MH~'
const SESSION_SERVER_URL = (process.env.SESSION_SERVER_URL || 'https://mahngueloh-md-session.onrender.com').replace(/\/$/, '')

// Short format: the pasted string is only a LOOKUP KEY — the actual bundle
// lives in the pairing site's memory and is fetched over the network. Much
// shorter and easier to paste, but with real tradeoffs the long format
// doesn't have: it only works once (redeeming it deletes it server-side),
// it expires ~30 minutes after it was generated, and it stops working
// entirely if the pairing site itself is down or unreachable. Prefer the
// MAHNGUELOH~ format for anything long-term; this one is fine for "pair
// right now, immediately."
async function fetchShortSessionBundle(sessionId) {
    try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 15000)
        let res
        try {
            res = await fetch(`${SESSION_SERVER_URL}/api/session/${encodeURIComponent(sessionId)}`, { signal: ctrl.signal })
        } finally { clearTimeout(timer) }
        const data = await res.json().catch(() => ({}))
        if (!res.ok) return { ok: false, error: data?.error || `HTTP ${res.status}` }
        if (!data?.bundle || typeof data.bundle !== 'object') return { ok: false, error: 'Server response had no session data' }
        return { ok: true, bundle: data.bundle }
    } catch (e) {
        return { ok: false, error: e.name === 'AbortError' ? 'Timed out reaching the pairing server' : e.message }
    }
}

// Dispatches to whichever format this string actually is. Both formats end
// up producing the same { ok, bundle } / { ok:false, error } shape, so
// everything downstream of this doesn't need to care which kind it got.
async function resolveSessionBundle(sessionId) {
    if (sessionId.startsWith(SHORT_SESSION_PREFIX)) return fetchShortSessionBundle(sessionId)
    return tryDecodeSessionId(sessionId)
}

async function restoreSessionFromConfig() {
    // SESSION_ID is a bootstrap credential, not the live auth database. Never
    // overwrite a healthy auth_info on reconnect, otherwise every reconnect
    // would roll the Signal ratchet back to an old snapshot and can itself
    // manufacture the exact Bad MAC/desync cycle we're trying to recover.
    const credsPath = path.join(__dirname, 'auth_info', 'creds.json')
    try {
        const existing = JSON.parse(fs.readFileSync(credsPath, 'utf8'))
        if (existing?.registered === true) {
            return false
        }
    } catch {}

    let sessionId = (config.sessionId || process.env.SESSION_ID || '').trim()

    // Forgiving fallback: if SESSION_ID itself isn't valid (e.g. someone
    // pasted the whole pairing-site message — label text and all — instead
    // of just the ID), scan the raw .env file for a bare session-id-shaped
    // line anywhere and use that instead. Cheap safety net for an easy
    // copy-paste mistake.
    if (!sessionId.startsWith(SESSION_PREFIX) && !sessionId.startsWith(SHORT_SESSION_PREFIX)) {
        try {
            const raw = fs.readFileSync(path.join(__dirname, '.env'), 'utf8')
            const found = raw.split('\n').map(l => l.trim()).find(l => l.startsWith(SESSION_PREFIX) || l.startsWith(SHORT_SESSION_PREFIX))
            if (found) {
                sessionId = found
                console.log('[ SESSION ] Found a session ID elsewhere in .env (not on the SESSION_ID= line) — using it anyway')
            }
        } catch {}
    }

    if (!sessionId) return false
    if (!sessionId.startsWith(SESSION_PREFIX) && !sessionId.startsWith(SHORT_SESSION_PREFIX)) {
        console.log('[ SESSION ] SESSION_ID is set but not a valid session (unrecognised prefix) — ignoring')
        return false
    }

    const isShort = sessionId.startsWith(SHORT_SESSION_PREFIX)
    console.log(`[ SESSION ] Found a ${isShort ? 'short (MH~)' : 'MAHNGUELOH~'} session ID${isShort ? ' — fetching it from the pairing server...' : ''}`)

    const decoded = await resolveSessionBundle(sessionId)
    if (decoded.ok) {
        console.log('[ SESSION ] Creating env and saving your session...')
        const authDir = path.join(__dirname, 'auth_info')
        fs.mkdirSync(authDir, { recursive: true })
        for (const [file, content] of Object.entries(decoded.bundle)) {
            const full = path.join(authDir, file)
            fs.mkdirSync(path.dirname(full), { recursive: true })
            fs.writeFileSync(full, content, 'utf8')
        }
        console.log(`[ SESSION ] Done — restored ${Object.keys(decoded.bundle).length} file(s), skipping pairing code`)
        console.log('[ SESSION ] Starting...')
        return true
    }

    console.log(`[ SESSION ] Failed to restore session (${sessionId.length} chars received): ${decoded.error}`)
    if (isShort) {
        console.log('[ SESSION ] Short (MH~) session IDs only work ONCE and expire ~30 minutes after they')
        console.log('[ SESSION ] were generated. If this one was already used, or it\'s been a while,')
        console.log('[ SESSION ] generate a fresh one and paste it again — or use a MAHNGUELOH~ session')
        console.log('[ SESSION ] ID instead, which never expires and needs no network call to redeem.')
    } else if (decoded.truncated) {
        console.log('[ SESSION ] This looks like the paste got cut off partway through — a real Session ID')
        console.log('[ SESSION ] is usually several thousand characters, and long console pastes on some')
        console.log('[ SESSION ] hosts get truncated. Two more reliable options:')
        console.log('[ SESSION ]   1. Phone Number pairing instead — much shorter, far less likely to get cut off.')
        console.log('[ SESSION ]   2. Paste the FULL Session ID into config.js instead of the console.')
    }
    return false
}

function printLoginMenu(hasSessionId, hasPhone) {
    const C = { reset: '\x1b[0m', cyan: '\x1b[36m', yellow: '\x1b[33m', green: '\x1b[32m', magenta: '\x1b[35m', gray: '\x1b[90m', bold: '\x1b[1m' }
    console.log(`\n${C.bold}${C.cyan}No login configured yet — pick ONE of these${C.reset} :`)
    console.log(`${C.yellow}1.${C.reset} ${hasSessionId ? C.green + '✓' : C.gray + '✗'} Session ID${C.reset}  — get one from ${C.magenta}${SESSION_SERVER_URL}/${C.reset}`)
    console.log(`   ${C.gray}(MAHNGUELOH~... never expires · MH~... is shorter but one-time use, ~30 min)${C.reset}`)
    console.log(`${C.yellow}2.${C.reset} ${hasPhone ? C.green + '✓' : C.gray + '✗'} Phone Number${C.reset}  — your WhatsApp number, digits only, with country code`)
    console.log(`\n${C.bold}Just paste either one right here in this console and press Enter.${C.reset}`)
    console.log(`${C.gray}(If this host doesn't forward console input, set it in config.js (sessionId) or .env (PHONE_NUMBER=) and hit Restart instead — either way works.)${C.reset}\n`)
    console.log(`${C.cyan}⌛ Waiting for input...${C.reset}`)
}

function saveSessionIdToConfig(sessionId) {
    try {
        const cfgPath = path.join(__dirname, 'config.js')
        let src = fs.readFileSync(cfgPath, 'utf8')
        const escaped = String(sessionId).replace(/\\/g, '\\\\').replace(/'/g, "\\'")
        const line = `    sessionId: process.env.SESSION_ID || '${escaped}',`
        if (/^    sessionId: process.env\.SESSION_ID \|\| .*,$/m.test(src)) {
            src = src.replace(/^    sessionId: process.env\.SESSION_ID \|\| .*,$/m, line)
        } else {
            throw new Error('sessionId entry not found in config.js')
        }
        fs.writeFileSync(cfgPath, src, 'utf8')
    } catch (e) {
        console.log('[ SESSION ] Could not save Session ID to config.js:', e.message)
    }
}

function appendEnv(key, value) {
    const envPath = path.join(__dirname, '.env')
    let content = ''
    try { content = fs.readFileSync(envPath, 'utf8') } catch {}
    const lines = content.split('\n').filter(l => l.trim() && !l.startsWith(`${key}=`))
    lines.push(`${key}=${value}`)
    fs.writeFileSync(envPath, lines.join('\n') + '\n')
}

async function connect() {
    if (connectPromise) return connectPromise
    const generation = ++socketGeneration
    connectPromise = (async () => {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
    cleanupSocket()  // tear down any previous socket before making a new one

    const sessionRestored = await restoreSessionFromConfig()
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info')

    // A pure hardcoded pin (what this used to be) is actually the WRONG fix:
    // WhatsApp actively deprecates old protocol version numbers and starts
    // rejecting them with exactly this "405 Connection Failure" once they
    // age out — confirmed by multiple recent Baileys issues (e.g. #2376,
    // #2679) where a stale hardcoded/cached version caused 405 loops.
    // So: fetch live, but never trust a fetch result OLDER than a known
    // baseline — fetchLatestBaileysVersion() has also been observed
    // returning a stale cached value while claiming isLatest:true. Taking
    // the max of (fetched, baseline) protects against both failure modes:
    // a stale fetch, and a fetch that fails outright.
    // Bump BASELINE_VERSION every so often (check https://wppconnect.io/whatsapp-versions/
    // if 405 loops start again) — even this safety net goes stale eventually.
    const BASELINE_VERSION = [2, 3000, 1042466098]
    const cmpVersion = (a, b) => (a[0]-b[0]) || (a[1]-b[1]) || (a[2]-b[2])

    let version = BASELINE_VERSION
    try {
        const r = await Promise.race([
            fetchLatestBaileysVersion(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
        ])
        if (cmpVersion(r.version, BASELINE_VERSION) >= 0) {
            version = r.version
            console.log(`[ VER ] Baileys protocol ${version.join('.')} (fetched)`)
        } else {
            console.log(`[ VER ] fetchLatestBaileysVersion returned stale ${r.version.join('.')} — using baseline ${version.join('.')} instead`)
        }
    } catch {
        console.log(`[ VER ] Fetch failed/timed out — using baseline Baileys protocol ${version.join('.')}`)
    }

    // Sanitise phone number — digits only, with country code, no +
    // IMPORTANT: this must come from PHONE_NUMBER (config.phoneNumber) only,
    // never from config.ownerNumber — ownerNumber is the public contact
    // number shown on .owner/.contact/menu buttons, and must never be
    // reused to auto-request a pairing code for someone else's account.
    let phone = (config.phoneNumber || '').replace(/\D/g, '')
    let needsPairing = !state.creds.registered

    if (!bannerShown) {
        bannerShown = true
        printBootBanner(needsPairing, version)
    }

    // Update, 2026-09-05: confirmed with a real test (a different bot on this
    // same host DID receive a long pasted Session ID via the console box) —
    // console input CAN reach process.stdin here after all. The stdin
    // listener further down in this file handles it; this menu just prints
    // the options regardless, since .env editing still works too either way.
    if (needsPairing && !sessionRestored) {
        printLoginMenu(!!process.env.SESSION_ID, !!(phone && phone.length >= 7))
    }

    if (needsPairing) {
        if (!phone || phone.length < 7) {
            // Previously exited here immediately — which meant the process
            // was already dead before there was ever a real chance to type
            // or paste anything into the console, regardless of whether this
            // host forwards console input to stdin. Now it stays alive and
            // actually waits, like a real login prompt should.
            console.log('❌  No SESSION_ID or PHONE_NUMBER configured yet.')
            console.log('⌛  Waiting — paste a Session ID or phone number right here in the console,')
            console.log('    OR edit .env in the Files tab and hit Restart. Either works.\n')
            return
        }
        console.log('⏳  Waiting for WhatsApp handshake before requesting code...')
        console.log('    (This usually takes 5-10 seconds)\n')
    }

    // ── Socket ────────────────────────────────────────────────────────────────
    // IMPORTANT for pairing code validity:
    //   • browser MUST use Baileys' built-in Browsers helper, not a custom string.
    //   • mobile MUST be false (tells Baileys to use the multi-device Web protocol).
    const sockInstance = makeWASocket({
        version,
        logger: log,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, log),
        },
        browser: Browsers.ubuntu('Chrome'),  // ← must be standard, not custom
        mobile: false,                        // ← must be false for pairing code
        printQRInTerminal: false,             // ← no QR; we use pairing code
        syncFullHistory: false,
        connectTimeoutMs: 60_000,
        keepAliveIntervalMs: 30_000,
        retryRequestDelayMs: 3_000,
        markOnlineOnConnect: false,
        getMessage: async () => undefined,
    })
    sock = sockInstance

    // Real groupStatusMessageV2 implementation, ported from JunexBaileys's
    // sendGroupStatus() but built on this fork's own generateWAMessageContent
    // / generateWAMessageFromContent (which already support backgroundColor,
    // font, and every normal AnyMessageContent shape — text, image, video,
    // audio, sticker). No second WhatsApp connection or dependency needed;
    // this just uses the existing live socket's relayMessage/waUploadToServer.
    sockInstance.sendGroupStatusV2 = async (jid, content, options = {}) => {
        const crypto = require('crypto')
        const inner = await generateWAMessageContent(content, {
            upload: sockInstance.waUploadToServer,
            ...options,
        })
        const messageSecret = crypto.randomBytes(32)
        const wrapped = generateWAMessageFromContent(jid, {
            messageContextInfo: { messageSecret },
            groupStatusMessageV2: {
                message: {
                    ...inner,
                    messageContextInfo: { messageSecret },
                },
            },
        }, { userJid: sockInstance.user?.id })
        await sockInstance.relayMessage(jid, wrapped.message, { messageId: wrapped.key.id })
        return wrapped
    }

    // Who owner-only notifications (anti-call, anti-edit, anti-delete, etc.)
    // go to. If OWNER_NUMBER was explicitly configured, honor that — but by
    // default, for a self-hosted deploy where only the person who scanned/
    // paired this exact number is using it, the simplest and safest target
    // is the bot's own connected account, not a number that has to be set
    // up separately and can easily be left pointing at someone else's.
    function getOwnerJid() {
        if (config.ownerNumber) return `${config.ownerNumber}@s.whatsapp.net`
        return cleanJid(sockInstance.user?.id || '')
    }

    sock.ev.on('creds.update', saveCreds)

    let pairingRequested = false

    sockInstance.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update
        if (generation !== socketGeneration || sockInstance !== sock) return

        // ── Pairing code ──────────────────────────────────────────────────────
        // The 'qr' field in connection.update signals that WhatsApp has
        // completed the WebSocket/Noise handshake and is waiting for auth.
        // This is the ONLY correct moment to call requestPairingCode().
        if (qr && needsPairing && !pairingRequested) {
            pairingRequested = true
            for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                    console.log(`[ PAIR ] Requesting code (attempt ${attempt}/3)...`)
                    const code = await sockInstance.requestPairingCode(phone)
                    showCode(code, phone)
                    break
                } catch (e) {
                    console.log(`[ PAIR ] Attempt ${attempt} failed: ${e.message}`)
                    if (attempt < 3) {
                        await new Promise(r => setTimeout(r, 5000))
                    } else {
                        console.log('\n💡 Could not get code. Delete auth_info folder and restart.\n')
                    }
                }
            }
        }

        if (connection === 'connecting') {
            console.log('[ CONN ] Connecting to WhatsApp servers...')
        }

        if (connection === 'open') {
            retries = 0
            lastOpenAt = Date.now()
            pairingRequested = false
            saveStreak(0) // this connection is holding — clear the disk-persisted failure streak
            console.log('[ CONN ] ✅ Connected')

            if (!statusReportShown) {
                statusReportShown = true
                // Use the actually-connected account (from Baileys itself) rather
                // than the pre-connection `phone` var, which stays blank on the
                // session-ID restore path — this is what really tells us which
                // WhatsApp account the bot is connected as.
                const connectedNum = (sockInstance.user?.id || '').split(':')[0].split('@')[0] || phone
                printStatusReport(connectedNum, version)
            }

            // Auto-join the updates/community group once per boot — best-effort,
            // never blocks startup if the invite is stale/expired/already joined.
            if (!joinedUpdatesGroup && config.updatesGroupInviteLink) {
                joinedUpdatesGroup = true
                setTimeout(async () => {
                    try {
                        const code = config.updatesGroupInviteLink.split('/').pop().split('?')[0]
                        await sockInstance.groupAcceptInvite(code)
                        console.log('[ GROUP ] Joined updates group')
                    } catch (e) {
                        console.log('[ GROUP ] Could not join updates group:', e.message)
                    }
                }, 6000)
            }

            if (runtimeSettings.alwaysonline) {
                try { await sockInstance.sendPresenceUpdate('available') } catch {}
            }

            // Start the news monitor scheduler (idempotent — safe on reconnects)
            try { initNewsMonitor(sockInstance) } catch (e) { console.error('[ NEWS ] Init failed:', e.message) }

            if (!onlineSent) {
                onlineSent = true
                setTimeout(async () => {
                    try {
                        const selfJid = sockInstance.user?.id || (phone ? phone + '@s.whatsapp.net' : null)
                        const selfNum = (selfJid || '').split(':')[0].split('@')[0]

                        const timezone = config.timezone || 'Africa/Nairobi'
                        const nowParts = new Intl.DateTimeFormat('en-GB', {
                            timeZone: timezone,
                            weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
                        }).formatToParts(new Date())
                        const get = (type) => nowParts.find((p) => p.type === type)?.value || ''
                        const timeStr = `${get('weekday')} ${get('hour')}:${get('minute')} ${get('dayPeriod')}`.toLowerCase()

                        const uptimeSec = Math.floor(process.uptime())
                        const upH = Math.floor(uptimeSec / 3600)
                        const upM = Math.floor((uptimeSec % 3600) / 60)

                        const totalMem = os.totalmem()
                        const usedMem = totalMem - os.freemem()
                        const ramPct = Math.round((usedMem / totalMem) * 100)
                        const ramFilled = Math.max(0, Math.min(10, Math.round(ramPct / 10)))
                        const ramBar = '█'.repeat(ramFilled) + '░'.repeat(10 - ramFilled)
                        const usedMB = Math.round(usedMem / 1024 / 1024)
                        const totalGB = (totalMem / 1024 / 1024 / 1024).toFixed(1)

                        const motto = config.themeLine || 'We are Anonymous. We are Legion…'

                        const frame = [
                            `┏━━❐✧ ${config.botName.toUpperCase()} ✧━━━━━━━`,
                            `┃✧ ${motto}`,
                            `┃✧ User: @${selfNum}`,
                            `┃✧ Owner: ${config.ownerName}`,
                            `┃✧ Mode: ${(config.mode || 'public').toUpperCase()}`,
                            `┃✧ Prefix: [ ${config.prefix} ]`,
                            `┃✧ Version: v${config.version || '3.1.0'}`,
                            `┃✧ Time: ${timeStr}`,
                            `┃✧ Uptime: ${upH}h ${upM}m`,
                            `┃✧ RAM: ${usedMB}MB / ${totalGB}GB [${ramBar}] ${ramPct}%`,
                            `┗━━━━━━━━━━━━━━━━━━━━━━━━━━`,
                            ``,
                            `_${motto}_`,
                            ``,
                            `> *${config.botName}* is online.`,
                            `> Type *${config.prefix}menu* to enter the VANTA grid.`,
                            ``,
                            config.whatsappChannelUrl ? `📢 Join our updates channel:\n${config.whatsappChannelUrl}` : null,
                            `🤝 Support: https://wa.me/${config.ownerNumber}`,
                        ].filter(Boolean).join('\n')
                        // sockInstance.user.id is the bot's real, actually-connected JID —
                        // always correct, unlike `phone` which is blank whenever
                        // the bot connected via a restored SESSION_ID.
                        if (selfJid) {
                            const bannerPath = path.join(__dirname, 'assets/banner.png')
                            if (fs.existsSync(bannerPath)) {
                                await sockInstance.sendMessage(selfJid, { image: fs.readFileSync(bannerPath), caption: frame })
                            } else {
                                await sockInstance.sendMessage(selfJid, { text: frame })
                            }
                        }
                    } catch {}
                }, 4000)
            }
        }

        if (connection === 'close') {
            const boom = new Boom(lastDisconnect?.error)
            const statusCode = boom?.output?.statusCode
            const reason = boom?.message || 'unknown'
            console.log(`[ CONN ] Disconnected — code ${statusCode} — ${reason}`)

            if (statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403) {
                console.log('[ AUTH ] Logged out — delete auth_info and restart')
                process.exit(1)
            }

            // Code 440 = WhatsApp telling us THIS EXACT session just got taken
            // over by another active connection somewhere else — not a network
            // blip, and reconnecting immediately just starts a tug-of-war with
            // whatever else is holding this session (each side repeatedly
            // kicks the other). That fight is also a very plausible cause of
            // Bad MAC errors: two processes advancing the same per-contact
            // Signal ratchets independently will desync them. Common cause:
            // this same session (or a copy of it) still running elsewhere —
            // e.g. still active on Termux while also running on this panel.
            if (statusCode === DisconnectReason.connectionReplaced) {
                console.log('[ AUTH ] Connection replaced — this exact WhatsApp session is active somewhere else RIGHT NOW.')
                console.log('[ AUTH ] This is not a bug here — stop the bot everywhere else it might still be running')
                console.log('[ AUTH ] (check Termux!), then Restart just ONE instance.')
                return // do not fight for the connection — stay idle instead of reconnect-looping
            }

            // A restored SESSION_ID that connects then gets immediately kicked,
            // over and over, means WhatsApp's servers are actively rejecting
            // this session — not a transient network blip. Looping forever on
            // a dead session forever is not resilience, it's just wasted CPU
            // with the same result every time. Detect the pattern and stop.
            const openDuration = lastOpenAt ? Date.now() - lastOpenAt : Infinity
            quickDisconnectStreak = openDuration < 10_000 ? quickDisconnectStreak + 1 : 0
            saveStreak(quickDisconnectStreak)

            if (quickDisconnectStreak >= 3) {
                console.log('[ AUTH ] This session keeps getting rejected within seconds of connecting, repeatedly.')
                console.log('[ AUTH ] WhatsApp is not accepting it — this is not a network issue, the session itself is invalid/stale.')
                saveStreak(0) // next session you provide starts with a clean slate, not an already-tripped counter
                if (sessionRestored) {
                    try {
                        fs.rmSync(path.join(__dirname, 'auth_info'), { recursive: true, force: true })
                        console.log('[ AUTH ] Cleared the dead session files.')
                    } catch {}
                    console.log('[ AUTH ] Get a FRESH Session ID from https://mahngueloh-md-session.onrender.com/ (do not reuse an old one),')
                    console.log('[ AUTH ] or switch to PHONE_NUMBER pairing in .env instead.')
                    console.log('[ AUTH ] Then either paste the new Session ID right here in the console, or edit .env and hit Restart.\n')
                } else {
                    console.log('[ AUTH ] Delete the auth_info folder via the Files tab and Restart for a fresh pairing code.')
                }
                // Deliberately not exiting: some hosts auto-restart the process
                // the instant it exits, regardless of exit code — which would
                // just replay this exact loop forever, invisibly, at the host
                // level instead of stopping. Staying alive but idle keeps this
                // message on screen instead of it scrolling away into a restart.
                return
            }

            if (statusCode === DisconnectReason.restartRequired) {
                scheduleReconnect(1000, 'restart-required')
                return
            }

            retries = Math.min(retries + 1, 10)
            const delay = retries * 5
            console.log(`[ CONN ] Reconnecting in ${delay}s...`)
            scheduleReconnect(delay * 1000, `retry-${retries}`)
        }
    })

    // ── Anti-delete cache (shared by regular chats and statuses) ────────────────
    async function cacheForAntiDelete(jid, msg, senderJid) {
        if (!runtimeSettings.antidelete && !runtimeSettings.antiedit) return
        try {
            const inner = msg.message?.ephemeralMessage?.message || msg.message
            const mediaType = ['imageMessage', 'videoMessage', 'stickerMessage', 'audioMessage']
                .find(t => inner?.[t])
            const text = getBody(msg)
            console.log('[cache-debug] keyId=' + msg.key.id + ' messageContextInfo=' + JSON.stringify(msg.message?.messageContextInfo) + ' innerMCI=' + JSON.stringify(inner?.messageContextInfo))
            let mediaBuffer = null, mimetype = null
            if (mediaType) {
                const mediaMsg = inner[mediaType]
                mimetype = mediaMsg.mimetype
                const sizeOk = !mediaMsg.fileLength || Number(mediaMsg.fileLength) < 3 * 1024 * 1024
                if (sizeOk) {
                    try {
                        mediaBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: log, reuploadRequest: sockInstance.updateMediaMessage })
                    } catch { /* couldn't fetch media — still cache the text/caption below */ }
                }
            }
            msgStore.save(jid, msg.key.id, {
                text,
                senderJid,
                senderNum: jidToNum(senderJid || ''),
                mediaType: mediaType === 'stickerMessage' ? 'sticker' : mediaType?.replace('Message', ''),
                mediaBuffer,
                mimetype,
                messageSecret: msg.message?.messageContextInfo?.messageSecret || inner?.messageContextInfo?.messageSecret || null,
                origRemoteJid: msg.key.remoteJid || jid,
                origRemoteJidAlt: msg.key.remoteJidAlt || null,
                origParticipant: msg.key.participant || null,
                origParticipantAlt: msg.key.participantAlt || null,
            })
        } catch (e) { /* never let caching break normal message handling */ }
    }

    // ── Messages ──────────────────────────────────────────────────────────────
    sockInstance.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const msg of messages) {
            try {
                if (!msg?.message) continue
                if (type !== 'append' && !dedup(msg.key.id)) continue

                const jid = msg.key.remoteJid || ''

                // ── Anti-edit, path 1: plain re-sent content ────────────
                if (type === 'append' && !msg.message?.protocolMessage) {
                    const existing = msgStore.get(jid, msg.key.id)
                    const newBody = getBody(msg)
                    console.log('[antiedit-debug] type=append fired. keyId=' + msg.key.id + ' hasExisting=' + !!existing + ' existingText=' + JSON.stringify(existing && existing.text) + ' newBody=' + JSON.stringify(newBody))
                    if (existing && newBody && existing.text && newBody !== existing.text) {
                        if (runtimeSettings.antiedit) {
                            try {
                                const ownerJid = getOwnerJid()
                                const chatLabel = jid.endsWith('@g.us') ? `group ${jid}` : jid.replace('@s.whatsapp.net', '')
                                const senderJid = existing.senderJid || msg.key.participant || (msg.key.fromMe ? (sockInstance.user?.id || '') : jid)
                                const senderNum = jidToNum(senderJid || '')
                                await sockInstance.sendMessage(ownerJid, {
                                    text: `✏️ *Anti-Edit*\nChat: ${chatLabel}\nBy: @${senderNum}\n\nBefore:\n${existing.text}\n\nAfter:\n${newBody}`,
                                    mentions: senderJid ? [senderJid] : [],
                                })
                            } catch (e) { console.error('Anti-edit forward error:', e.message) }
                        }
                        await cacheForAntiDelete(jid, msg, existing.senderJid || sender)
                        continue
                    }
                }

                // ── Anti-edit, path 2: encrypted edit (secretEncryptedMessage) ─
                if (msg.message?.secretEncryptedMessage) {
                    if (runtimeSettings.antiedit) {
                        try {
                            const targetKey = msg.message.secretEncryptedMessage.targetMessageKey
                            const existing = targetKey ? msgStore.get(targetKey.remoteJid || jid, targetKey.id) : null
                            const ownerJid = getOwnerJid()
                            const chatLabel = jid.endsWith('@g.us') ? `group ${jid}` : jid.replace('@s.whatsapp.net', '')
                            const senderJid = existing?.senderJid || msg.key.participant || (msg.key.fromMe ? (sockInstance.user?.id || '') : jid)
                            const senderNum = jidToNum(senderJid || '')

                            const toBuf = (v) => {
                                if (!v) return Buffer.alloc(0)
                                if (Buffer.isBuffer(v)) return v
                                if (v instanceof Uint8Array) return Buffer.from(v)
                                if (typeof v === 'string') return Buffer.from(v, 'base64')
                                if (Array.isArray(v)) return Buffer.from(v)
                                return Buffer.from(v)
                            }

                            const extractTextFromDecoded = (m) => {
                                if (!m) return ''
                                const i = m.ephemeralMessage?.message
                                       || m.viewOnceMessage?.message
                                       || m.viewOnceMessageV2?.message
                                       || m
                                return i.conversation
                                    || i.extendedTextMessage?.text
                                    || i.imageMessage?.caption
                                    || i.videoMessage?.caption
                                    || i.documentMessage?.caption
                                    || ''
                            }

                            let afterText = null
                            const sem = msg.message.secretEncryptedMessage
                            const messageSecret = existing?.messageSecret
                            console.log('[antiedit-decrypt] hasExisting=' + !!existing + ' hasSecret=' + !!messageSecret + ' hasTargetId=' + !!targetKey?.id + ' hasEncPayload=' + !!sem.encPayload + ' hasEncIv=' + !!sem.encIv)

                            if (messageSecret && targetKey?.id) {
                                const candidates = [
                                    existing?.origParticipant,
                                    existing?.origParticipantAlt,
                                    msg.key.participant,
                                    targetKey.remoteJid,
                                    existing?.origRemoteJid,
                                    existing?.origRemoteJidAlt,
                                    jid,
                                    senderJid,
                                ].filter(Boolean)
                                const uniqueCandidates = [...new Set(candidates)]

                                const encPayloadBuf = toBuf(sem.encPayload)
                                const encIvBuf = toBuf(sem.encIv)
                                const secretBuf = toBuf(messageSecret)

                                for (const cand of uniqueCandidates) {
                                    try {
                                        const info = targetKey.id + cand + cand + 'Message Edit'
                                        const key = await hkdf(secretBuf, 32, { info })
                                        const plaintext = aesDecryptGCM(encPayloadBuf, key, encIvBuf, Buffer.alloc(0))
                                        const decoded = proto.Message.decode(plaintext)
                                        const editedMsg = decoded.protocolMessage?.editedMessage || decoded.editedMessage || decoded
                                        const text = extractTextFromDecoded(editedMsg)
                                        if (text) {
                                            afterText = text
                                            break
                                        }
                                    } catch (decErr) {
                                        // wrong JID candidate for this derivation — GCM auth failure, try next
                                        console.log('[antiedit-decrypt] candidate failed: ' + cand + ' — ' + decErr.message)
                                    }
                                }
                            }

                            await sockInstance.sendMessage(ownerJid, {
                                text: `✏️ *Anti-Edit*\nChat: ${chatLabel}\nBy: @${senderNum}\n\nBefore:\n${existing?.text || '_(original not cached)_'}\n\nAfter:\n${afterText || '_(encrypted edit — content unavailable)_'}`,
                                mentions: senderJid ? [senderJid] : [],
                            })
                        } catch (e) { console.error('Anti-edit forward error:', e.message) }
                    }
                    continue
                }

                // ── Anti-delete: catch "delete for everyone" events ──────────
                // A deletion arrives as a normal message.upsert whose payload
                // is a protocolMessage of type REVOKE, pointing at the id of
                // the message that got deleted. The original content is never
                // resent by WhatsApp, so we look it up in our own cache.
                const revokeKey = (type === 'notify' && msg.message?.protocolMessage?.type === proto.Message.ProtocolMessage.Type.REVOKE)
                    ? msg.message.protocolMessage.key
                    : null
                if (revokeKey) {
                    const isGroupChat = jid.endsWith('@g.us')
                    if (runtimeSettings.antidelete) {
                        const cached = msgStore.get(jid, revokeKey.id)
                        try {
                            // Destination is governed by .antideletepath, and applies
                            // the SAME way regardless of group or DM:
                            //   • 'public'  → reveal it back in the exact chat it was
                            //     deleted from (no redirection at all).
                            //   • 'private' → always forward it to the OWNER'S OWN
                            //     chat instead, built from the LIVE connected account
                            //     JID (sockInstance.user.id), NOT config.ownerNumber —
                            //     that config value defaults to a placeholder demo
                            //     number and is very often never overridden via
                            //     OWNER_NUMBER in .env.
                            const selfJid  = cleanJid(sockInstance.user?.id || '')
                            const destJid  = runtimeSettings.antideletepath === 'public'
                                ? jid
                                : (selfJid || getOwnerJid())
                            const inPlace  = destJid === jid
                            const fromNote = inPlace
                                ? ''
                                : `\nChat: ${(cached && cached.senderNum) ? `+${cached.senderNum}` : jid.replace('@s.whatsapp.net', '')}`
                            const header = `🗑️ *Anti-Delete*\nBy: @${(cached && cached.senderNum) || ''}${fromNote}\nDeleted at: ${new Date().toLocaleString()}`
                            // @mentions only resolve for participants of destJid, so
                            // only pass them through when we're revealing it back
                            // in-place inside the same group — not when forwarding a
                            // deletion over to the owner's own separate chat.
                            const mentions = (inPlace && isGroupChat && cached && cached.senderJid) ? [cached.senderJid] : []
                            if (cached) {
                                if (cached.mediaBuffer) {
                                    const isAudio = cached.mediaType === 'audio'
                                    await sockInstance.sendMessage(destJid, {
                                        [cached.mediaType]: cached.mediaBuffer,
                                        mimetype: cached.mimetype,
                                        ...(isAudio ? {} : { caption: `${header}${cached.text ? `\n\nCaption: ${cached.text}` : ''}` }),
                                        mentions,
                                    })
                                    if (isAudio) {
                                        await sockInstance.sendMessage(destJid, { text: header, mentions })
                                    }
                                } else {
                                    await sockInstance.sendMessage(destJid, {
                                        text: `${header}\n\nMessage:\n${cached.text || '_(no text — unsupported or uncached media type)_'}`,
                                        mentions,
                                    })
                                }
                            } else {
                                // Don't spam the chat: an active/busy group can generate many
                                // deletions with nothing cached (e.g. right after a restart), and
                                // a contentless "something was deleted" notice adds little value
                                // repeated dozens of times. Cap it to one per chat per 15 minutes.
                                const now = Date.now()
                                const lastNotified = uncachedNoticeCooldown.get(jid) || 0
                                if (now - lastNotified > 15 * 60 * 1000) {
                                    uncachedNoticeCooldown.set(jid, now)
                                    await sockInstance.sendMessage(destJid, {
                                        text: `🗑️ *Anti-Delete*${fromNote}\nA message was deleted, but it wasn't cached yet (bot may have just restarted) so the original content couldn't be recovered.\n_(further uncached deletions in this chat are suppressed for 15 min to avoid spam)_`,
                                    })
                                }
                            }
                        } catch (e) { console.error('Anti-delete forward error:', e.message) }
                    }
                    continue
                }


                if (jid === 'status@broadcast') {
                    const poster = msg.key.participant || ''
                    await cacheForAntiDelete(jid, msg, poster)
                    if (runtimeSettings.autoviewstatus && poster) {
                        try { await sockInstance.sendReceipt('status@broadcast', poster, [msg.key.id], 'read') } catch {}
                    }
                    if (runtimeSettings.autoreactstatus && poster) {
                        try {
                            const e = STATUS_EMOJIS[Math.floor(Math.random() * STATUS_EMOJIS.length)]
                            await sockInstance.sendMessage(poster, {
                                react: {
                                    text: e,
                                    key: { remoteJid: 'status@broadcast', id: msg.key.id, participant: poster, fromMe: false }
                                }
                            })
                        } catch {}
                    }
                    continue
                }

                // Only 'notify' is a genuinely live, real-time message. 'append'
                // is how Baileys delivers backlog/history-catch-up messages
                // after a reconnect — potentially hundreds of them after the
                // bot has been offline or cycling through reconnect retries.
                // Processing those as live commands (which this used to do)
                // means the bot sits there re-running every stale command
                // from the backlog before it ever gets to a live one — this
                // is very likely why commands appeared to take ~40 minutes
                // to start responding after a deploy: it wasn't stuck, it
                // was working through old messages first, in order, one at
                // a time, INCLUDING triggering downloads/AI calls again for
                // anything that looked like a command.
                if (type !== 'notify') continue
                const ks = Object.keys(msg.message || {})
                if (ks.length === 1 && ks[0] === 'reactionMessage') continue

                const botJid = sockInstance.user?.id || ''
                const sender = getSender(msg, botJid)

                lastMsgContext = {
                    messageType: Object.keys(msg.message?.ephemeralMessage?.message || msg.message || {})[0] || 'N/A',
                    senderName:  msg.pushName || 'N/A',
                    chatId:      (sender || jid || '').replace('@s.whatsapp.net', '').replace('@g.us', ''),
                }

                // Real-time visibility into what the bot is actually receiving —
                // a decorative bordered block per message, so a silent/stuck
                // command is obvious in the console instead of a guessing game.
                const preview = (getBody(msg) || `[${lastMsgContext.messageType}]`).slice(0, 100).replace(/\n/g, ' ')
                printMessageLog(lastMsgContext, preview)

                // ── Anti-delete cache ─────────────────────────────────────────
                console.log('[jid-debug] SAVING jid=' + jid + ' key.id=' + msg.key.id + ' fullKey=' + JSON.stringify(msg.key))
                await cacheForAntiDelete(jid, msg, sender)

                if (msg.key.fromMe) {
                    const b = getBody(msg)
                    if (!b || !b.startsWith(config.prefix)) continue
                }

                const isGroupMsg = jid.endsWith('@g.us')
                if (!isOwner(sender, botJid, msg.key?.fromMe) && !rateOk(sender)) {
                    // Silent drop entirely — no reaction, no text. This used to
                    // react with ⏱️ to ANY message from a rate-limited sender
                    // (not just bot commands), which showed up as the bot
                    // reacting to completely unrelated conversation in groups.
                    continue
                }

                if (runtimeSettings.autoread) {
                    try { await sockInstance.readMessages([msg.key]) } catch {}
                }
                // Auto-react to messages removed entirely — the feature was
                // suspected of causing visible reactions in groups, though it
                // may actually have been WhatsApp's own disappearing-message
                // timer icon. Either way, gone now, no toggle left to re-enable.

                const bodyForLog = getBody(msg) || ''
                if (bodyForLog.startsWith(config.prefix)) {
                    const cmdName = bodyForLog.slice(config.prefix.length).trim().split(/\s+/)[0] || ''
                    const senderNum = (sender || '').replace('@s.whatsapp.net', '').replace('@lid', '')
                    const isOwnerFlag = isOwner(sender, botJid, msg.key?.fromMe)
                    console.log(`[ CMD ] ${cmdName} ← ${senderNum}${isOwnerFlag ? ' [OWNER]' : ''}`)
                }
                await handleMessage(sockInstance, msg)
            } catch (e) {
                printErrorBox('Message Handler Error', e, lastMsgContext)
            }
        }
    })

    // ── Group events ──────────────────────────────────────────────────────────
    sockInstance.ev.on('group-participants.update', async ({ id, participants, action }) => {
        try { await handleGroupEvents(sockInstance, id, participants, action) } catch {}
    })

    // ── Calls ─────────────────────────────────────────────────────────────────
    sockInstance.ev.on('call', async calls => {
        for (const call of calls) {
            if (runtimeSettings.anticall && call.status === 'offer') {
                try { await sockInstance.rejectCall(call.id, call.from) } catch {}
                try {
                    const num = (call.from || '').replace('@s.whatsapp.net', '')
                    await sockInstance.sendMessage(getOwnerJid(), {
                        text: `📵 *Anti-Call*\nRejected an incoming ${call.isVideo ? 'video' : 'voice'} call from +${num}`,
                    })
                } catch {}
            }
        }
    })
    })().finally(() => { connectPromise = null })
    return connectPromise
}

// Pre-install yt-dlp in background so social media downloads work on first use.
// Delayed slightly so its output doesn't interleave with the startup banner.
setTimeout(() => ensureYtdlp(), 5000)

connect().catch(e => { printErrorBox('Fatal Error', e, lastMsgContext); process.exit(1) })
process.on('unhandledRejection', e => printErrorBox('Unhandled Rejection', e instanceof Error ? e : new Error(String(e)), lastMsgContext))
process.on('uncaughtException',  e => printErrorBox('Uncaught Exception',  e, lastMsgContext))

// ── Optional: paste a Session ID or phone number straight into the hosting
// panel's console, as an alternative to editing .env in the Files tab.
// Whether a given host actually forwards typed console input to
// process.stdin varies by host — if it doesn't, this listener just never
// fires and .env editing still works normally as the fallback path.
//
// A real Session ID is thousands of characters — long enough that the
// console very likely delivers it as several separate chunks (e.g. wrapped
// at the terminal's column width) rather than one single line event. The
// bug this fixes: treating the FIRST chunk as complete the instant it
// starts with "MAHNGUELOH~", instead of waiting to see if more is still
// arriving. Now every line is accumulated and only processed once input
// has gone quiet for a moment, so a multi-chunk paste gets reassembled
// before decoding is attempted instead of being read one fragment at a time.
try {
    const readline = require('readline')
    const rl = readline.createInterface({ input: process.stdin })
    let buffer = ''
    let settleTimer = null

    rl.on('line', (line) => {
        buffer += line.trim()
        if (settleTimer) clearTimeout(settleTimer)
        settleTimer = setTimeout(() => {
            const trimmed = buffer
            buffer = ''
            if (!trimmed) return

            const isShortSession = trimmed.startsWith(SHORT_SESSION_PREFIX)
            const looksLikeSessionId = isShortSession || /^MAHNGUELOH~/.test(trimmed) || (trimmed.length > 100 && /^[A-Za-z0-9+/=_-]+$/.test(trimmed))
            const looksLikePhone = /^\d{7,15}$/.test(trimmed)

            if (isShortSession) {
                // Short-format IDs are only ~50 characters total — always
                // arrive in a single paste, nothing to reassemble. The real
                // check (the network fetch) happens inside
                // restoreSessionFromConfig() right after reconnecting.
                saveSessionIdToConfig(trimmed)
                process.env.SESSION_ID = trimmed
                config.sessionId = trimmed
                console.log('[ CONSOLE ] Creating env and saving your session id...')
                console.log(`[ CONSOLE ] Done — session ID received (${trimmed.length} chars) — starting...`)
            } else if (looksLikeSessionId) {
                // Don't commit to .env yet — check whether we actually have
                // the WHOLE thing. If this console caps each paste around
                // ~4KB, one paste alone will always be incomplete; keep the
                // buffer and wait for the next paste to arrive and extend it,
                // instead of writing a truncated value and giving up.
                const check = tryDecodeSessionId(trimmed)
                if (!check.ok && check.truncated) {
                    buffer = trimmed // keep accumulating — do NOT reset to ''
                    console.log(`[ CONSOLE ] Got ${trimmed.length} chars so far — looks incomplete (this console may cap each paste around 4KB).`)
                    console.log('[ CONSOLE ] Paste the rest now — it will be appended to what\'s already received.')
                    return
                }
                if (!check.ok) {
                    console.log(`[ CONSOLE ] That didn't decode as a valid session (${check.error}) — starting over. Paste the full Session ID again.`)
                    return
                }
                saveSessionIdToConfig(trimmed)
                process.env.SESSION_ID = trimmed
                config.sessionId = trimmed
                console.log('[ CONSOLE ] Creating env and saving your session id...')
                console.log(`[ CONSOLE ] Done — session ID received (${trimmed.length} chars, reassembled) — starting...`)
            } else if (looksLikePhone) {
                appendEnv('PHONE_NUMBER', trimmed)
                process.env.PHONE_NUMBER = trimmed
                console.log('[ CONSOLE ] Phone number received — saved to .env, reconnecting...')
            } else {
                return // not something we recognise — ignore rather than misfire
            }

            saveStreak(0)
            if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
            scheduleReconnect(0, 'console-login')
        }, 400) // wait 400ms of silence before treating the buffer as complete
    })
} catch {}
