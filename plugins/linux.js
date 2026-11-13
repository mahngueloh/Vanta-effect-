'use strict'
/**
 * linux.js — Full Ubuntu & Linux system command plugin for MAHNGUELOH VANTA
 *
 * Commands run inside the proot-distro Ubuntu container on the device.
 * Usage: .ub <command>     — run any command in Ubuntu
 *        .kl <command>     — run any command in Kali Linux
 *        .files [path]     — list files/dirs
 *        .cat <file>       — read a file
 *        .find <name>      — find files by name
 *        .grep <pat> <file>— search in file
 *        .proc             — list running processes
 *        .kill <pid|name>  — kill a process
 *        .disk             — disk usage
 *        .mem              — memory usage
 *        .cpu              — CPU info
 *        .net              — network interfaces
 *        .ip               — public & local IP
 *        .ports            — listening ports
 *        .pkg search <q>   — search packages
 *        .pkg install <p>  — install a package
 *        .pkg remove <p>   — remove a package
 *        .pkg update       — update package list
 *        .pkg list         — list installed packages
 *        .pkg info <p>     — info about a package
 *        .sysinfo          — full system overview
 *        .env              — environment variables
 *        .users            — list users
 *        .logs             — system logs (tail)
 *        .cron             — cron jobs
 *        .services         — running services
 *        .uptime           — system uptime
 *        .whoami           — current user
 *        .uname            — kernel/OS info
 *        .path             — current PATH
 *        .arch             — CPU architecture
 *        .hostname         — device hostname
 *        .history          — command history
 *        .tar <file>       — extract tar archive
 *        .zip <file>       — unzip archive
 *        .download <url>   — download a file with wget
 *        .chmod <perm> <f> — change file permissions
 *        .sh <cmd>         — raw shell (host termux)
 */

const { exec }  = require('child_process')
const config    = require('../config')
const fmt       = require('../lib/format')
const os        = require('os')

const TIMEOUT_QUICK = 15000
const TIMEOUT_MED   = 45000
const TIMEOUT_LONG  = 120000
const MAX_CHARS     = 3500
const WORK_DIR      = os.homedir()

// ── Destructive command blocklist ─────────────────────────────────────────────
const BLOCKED = [
    /\brm\s+-rf\s+\/\b/i,
    /\bdd\s+if=.*of=\/dev\//i,
    /\bmkfs\b/i,
    /\bwipefs\b/i,
    /\bshutdown\b/,
    /\breboot\b/,
    /\binit\s+0\b/,
    /\bchmod\s+777\s+\/\b/i,
    /\bcat\s+\/etc\/shadow\b/i,
    /\bpasswd\b/,
    />\s*\/dev\/sd/i,
    /\bproot-distro\s+remove\b/i,
]

function isBlocked(cmd) {
    return BLOCKED.some(r => r.test(cmd))
}

// ── Core runner ───────────────────────────────────────────────────────────────
function run(cmd, timeoutMs = TIMEOUT_MED) {
    return new Promise(resolve => {
        const proc = exec(cmd, {
            cwd: WORK_DIR,
            timeout: timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env, TERM: 'xterm-256color' }
        }, (err, stdout, stderr) => {
            const raw = (stdout || '').trim() || (stderr || '').trim() || (err?.message || 'No output')
            resolve({ ok: !err || stdout.trim().length > 0, out: raw })
        })
        setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, timeoutMs + 500)
    })
}

// Run inside Ubuntu proot container
function runUbuntu(cmd, timeoutMs = TIMEOUT_MED) {
    const escaped = cmd.replace(/'/g, `'\\''`)
    return run(`proot-distro login ubuntu -- bash -c '${escaped}' 2>&1`, timeoutMs)
}

// Run inside Kali Linux proot container
function runKali(cmd, timeoutMs = TIMEOUT_MED) {
    const escaped = cmd.replace(/'/g, `'\\''`)
    return run(`proot-distro login kali-rolling -- bash -c '${escaped}' 2>&1`, timeoutMs)
}

// Trim and clean ANSI escape codes from output
function trim(text, max = MAX_CHARS) {
    const clean = text.replace(/\x1B\[[0-9;]*[mGKHF]/g, '').trim()
    if (clean.length <= max) return clean
    const half = Math.floor(max / 2)
    return clean.slice(0, half) + '\n\n... [output trimmed] ...\n\n' + clean.slice(-half)
}

// Send a formatted box reply
async function send(sock, from, title, lines, msg) {
    return sock.sendMessage(from, {
        text: fmt.box(title, Array.isArray(lines) ? lines : [String(lines)])
    }, { quoted: msg })
}

// Send result, split if long
async function sendResult(sock, from, label, output, msg) {
    const text = trim(output)
    if (text.length <= 3200) {
        return sock.sendMessage(from, { text: fmt.box(label, [text]) }, { quoted: msg })
    }
    await sock.sendMessage(from, { text: fmt.box(label, ['_(long output — sending in chunks)_']) }, { quoted: msg })
    let buf = ''
    for (const line of text.split('\n')) {
        if ((buf + '\n' + line).length > 3000) {
            await sock.sendMessage(from, { text: '```\n' + buf.trim() + '\n```' })
            buf = line
        } else {
            buf += (buf ? '\n' : '') + line
        }
    }
    if (buf.trim()) await sock.sendMessage(from, { text: '```\n' + buf.trim() + '\n```' })
}

// ═════════════════════════════════════════════════════════════════════════════
//  .ub <command>  — Execute any command in Ubuntu
// ═════════════════════════════════════════════════════════════════════════════
async function handleUbuntu(sock, from, q, msg) {
    if (!q) return send(sock, from, '🐧 UBUNTU TERMINAL', [
        `*Usage:* ${config.prefix}ub <command>`,
        ``,
        `Run any command inside your Ubuntu container.`,
        ``,
        `*Examples:*`,
        `◈ ${config.prefix}ub ls -la /home`,
        `◈ ${config.prefix}ub cat /etc/os-release`,
        `◈ ${config.prefix}ub df -h`,
        `◈ ${config.prefix}ub free -h`,
        `◈ ${config.prefix}ub apt list --installed 2>/dev/null | head -20`,
        `◈ ${config.prefix}ub ps aux | head -20`,
        `◈ ${config.prefix}ub curl -s ifconfig.me`,
        ``,
        `_All commands run inside Ubuntu 26.04 LTS_`,
    ], msg)

    if (isBlocked(q)) return send(sock, from, '🚫 BLOCKED', [
        `⚠️ Destructive command blocked for safety.`,
    ], msg)

    await fmt.react(sock, msg, '🐧')
    const start = Date.now()
    const r = await runUbuntu(q, TIMEOUT_MED)
    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    await fmt.react(sock, msg, r.ok ? '✅' : '⚠️')

    await sendResult(sock, from, `🐧 UBUNTU — ${elapsed}s\n$ ${q}`, r.out || '(no output)', msg)
}

// ═════════════════════════════════════════════════════════════════════════════
//  .kl <command>  — Execute any command in Kali Linux
// ═════════════════════════════════════════════════════════════════════════════
async function handleKaliShell(sock, from, q, msg) {
    if (!q) return send(sock, from, '🐉 KALI TERMINAL', [
        `*Usage:* ${config.prefix}kl <command>`,
        ``,
        `Run any command inside your Kali Linux container.`,
        ``,
        `*Examples:*`,
        `◈ ${config.prefix}kl nmap -sV 192.168.1.1`,
        `◈ ${config.prefix}kl whatweb https://example.com`,
        `◈ ${config.prefix}kl nikto -h example.com`,
        `◈ ${config.prefix}kl apt list --installed 2>/dev/null | head -20`,
        `◈ ${config.prefix}kl msfconsole -q -x "version; exit"`,
        `◈ ${config.prefix}kl searchsploit apache`,
        ``,
        `_All commands run inside Kali Linux_`,
    ], msg)

    if (isBlocked(q)) return send(sock, from, '🚫 BLOCKED', [
        `⚠️ Destructive command blocked for safety.`,
    ], msg)

    await fmt.react(sock, msg, '🐉')
    const start = Date.now()
    const r = await runKali(q, TIMEOUT_MED)
    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    await fmt.react(sock, msg, r.ok ? '✅' : '⚠️')

    await sendResult(sock, from, `🐉 KALI — ${elapsed}s\n$ ${q}`, r.out || '(no output)', msg)
}

// ═════════════════════════════════════════════════════════════════════════════
//  FILE SYSTEM COMMANDS
// ═════════════════════════════════════════════════════════════════════════════

async function handleFiles(sock, from, q, msg) {
    const path = q || '~'
    await fmt.react(sock, msg, '📁')
    const r = await runUbuntu(`ls -lah --color=never ${path} 2>&1`, TIMEOUT_QUICK)
    await sendResult(sock, from, `📁 FILES — ${path}`, r.out, msg)
}

async function handleCat(sock, from, q, msg) {
    if (!q) return send(sock, from, '📄 CAT', [
        `*Usage:* ${config.prefix}cat <file>`,
        `*Example:* ${config.prefix}cat /etc/hosts`,
    ], msg)
    if (isBlocked(`cat ${q}`)) return send(sock, from, '🚫 BLOCKED', ['File access denied.'], msg)
    await fmt.react(sock, msg, '📄')
    const r = await runUbuntu(`cat ${q} 2>&1 | head -200`, TIMEOUT_QUICK)
    await sendResult(sock, from, `📄 FILE: ${q}`, r.out, msg)
}

async function handleFind(sock, from, q, msg) {
    if (!q) return send(sock, from, '🔍 FIND', [
        `*Usage:* ${config.prefix}find <filename>`,
        `*Example:* ${config.prefix}find *.conf`,
        `*Example:* ${config.prefix}find passwd`,
    ], msg)
    await fmt.react(sock, msg, '🔍')
    const r = await runUbuntu(`find / -name "*${q}*" 2>/dev/null | head -50`, TIMEOUT_MED)
    await sendResult(sock, from, `🔍 FIND: ${q}`, r.out || '(no results)', msg)
}

async function handleGrep(sock, from, q, msg) {
    if (!q || !q.includes(' ')) return send(sock, from, '🔎 GREP', [
        `*Usage:* ${config.prefix}grep <pattern> <file>`,
        `*Example:* ${config.prefix}grep root /etc/passwd`,
        `*Example:* ${config.prefix}grep "error" /var/log/syslog`,
        `*Example:* ${config.prefix}grep admin /etc/group`,
    ], msg)
    if (isBlocked(q)) return send(sock, from, '🚫 BLOCKED', ['Access denied.'], msg)

    // Parse pattern and file separately — first word is pattern, rest is file
    const parts   = q.trim().split(/\s+/)
    const pattern = parts[0]
    const file    = parts.slice(1).join(' ')

    if (!file) return send(sock, from, '🔎 GREP', [
        `*Usage:* ${config.prefix}grep <pattern> <file>`,
        `*Example:* ${config.prefix}grep root /etc/passwd`,
    ], msg)

    await fmt.react(sock, msg, '🔎')
    const r = await runUbuntu(`grep -n -- "${pattern.replace(/"/g, '\\"')}" ${file} 2>&1 | head -100`, TIMEOUT_QUICK)
    await sendResult(sock, from, `🔎 GREP: ${pattern} in ${file}`, r.out || '(no matches)', msg)
}

async function handleChmod(sock, from, q, msg) {
    if (!q || q.trim().split(/\s+/).length < 2) return send(sock, from, '🔑 CHMOD', [
        `*Usage:* ${config.prefix}chmod <permissions> <file>`,
        `*Example:* ${config.prefix}chmod 755 script.sh`,
        `*Example:* ${config.prefix}chmod +x run.sh`,
    ], msg)
    await fmt.react(sock, msg, '🔑')
    const r = await runUbuntu(`chmod ${q} && echo "Done: chmod ${q}"`, TIMEOUT_QUICK)
    await sendResult(sock, from, `🔑 CHMOD`, r.out, msg)
}

async function handleDownloadFile(sock, from, q, msg) {
    if (!q) return send(sock, from, '⬇️ DOWNLOAD', [
        `*Usage:* ${config.prefix}wgetfile <url>`,
        `*Example:* ${config.prefix}wgetfile https://example.com/file.zip`,
        ``,
        `_Downloads file to /tmp/ in Ubuntu_`,
    ], msg)
    await fmt.react(sock, msg, '⬇️')
    const filename = q.split('/').pop().split('?')[0] || 'downloaded_file'
    await send(sock, from, '⬇️ DOWNLOADING', [
        `*URL:* ${q}`,
        `*Saving as:* /tmp/${filename}`,
        `_Please wait..._`,
    ], msg)
    const r = await runUbuntu(`wget -O /tmp/${filename} "${q}" 2>&1 && echo "✅ Saved: /tmp/${filename}" && ls -lh /tmp/${filename}`, TIMEOUT_LONG)
    await fmt.react(sock, msg, r.ok ? '✅' : '❌')
    await sendResult(sock, from, `⬇️ DOWNLOAD`, r.out, msg)
}

async function handleTar(sock, from, q, msg) {
    if (!q) return send(sock, from, '📦 ARCHIVE', [
        `*Usage:* ${config.prefix}tar <file>`,
        `*Example:* ${config.prefix}tar /tmp/archive.tar.gz`,
        ``,
        `Extracts tar, tar.gz, tar.bz2, zip`,
    ], msg)
    await fmt.react(sock, msg, '📦')
    let cmd
    if (q.endsWith('.zip'))           cmd = `unzip -o "${q}" -d /tmp/extracted_${Date.now()}`
    else if (q.endsWith('.tar.gz') || q.endsWith('.tgz')) cmd = `tar -xzf "${q}" -C /tmp/`
    else if (q.endsWith('.tar.bz2'))  cmd = `tar -xjf "${q}" -C /tmp/`
    else if (q.endsWith('.tar'))      cmd = `tar -xf  "${q}" -C /tmp/`
    else                              cmd = `tar -xf  "${q}" -C /tmp/`
    const r = await runUbuntu(`${cmd} 2>&1 && echo "✅ Extracted successfully"`, TIMEOUT_MED)
    await fmt.react(sock, msg, r.ok ? '✅' : '❌')
    await sendResult(sock, from, `📦 EXTRACT`, r.out, msg)
}

// ═════════════════════════════════════════════════════════════════════════════
//  PROCESS COMMANDS
// ═════════════════════════════════════════════════════════════════════════════

async function handleProc(sock, from, q, msg) {
    await fmt.react(sock, msg, '⚙️')
    const filter = q ? `| grep -i "${q}"` : '| head -40'
    const r = await runUbuntu(
        `ps aux --sort=-%cpu ${filter} 2>&1`,
        TIMEOUT_QUICK
    )
    await sendResult(sock, from, q ? `⚙️ PROCESSES: ${q}` : '⚙️ PROCESSES (top 40)', r.out, msg)
}

async function handleKillProc(sock, from, q, msg) {
    if (!q) return send(sock, from, '💀 KILL PROCESS', [
        `*Usage:* ${config.prefix}killit <pid or name>`,
        `*Example:* ${config.prefix}killit 1234`,
        `*Example:* ${config.prefix}killit nginx`,
    ], msg)
    await fmt.react(sock, msg, '💀')
    const isPid = /^\d+$/.test(q.trim())
    const cmd = isPid
        ? `kill -9 ${q} && echo "Killed PID ${q}"`
        : `pkill -9 -f "${q}" && echo "Killed: ${q}" || echo "No process found: ${q}"`
    const r = await runUbuntu(cmd, TIMEOUT_QUICK)
    await sendResult(sock, from, `💀 KILL: ${q}`, r.out, msg)
}

async function handleJobs(sock, from, q, msg) {
    await fmt.react(sock, msg, '🔄')
    const r = await runUbuntu(`jobs -l 2>&1; echo "---"; pgrep -a . 2>&1 | head -30`, TIMEOUT_QUICK)
    await sendResult(sock, from, '🔄 BACKGROUND JOBS', r.out || '(no jobs running)', msg)
}

// ═════════════════════════════════════════════════════════════════════════════
//  SYSTEM INFO COMMANDS
// ═════════════════════════════════════════════════════════════════════════════

async function handleSysInfo(sock, from, q, msg) {
    await fmt.react(sock, msg, '💻')
    const cmds = [
        `echo "┌── OS"`,
        `cat /etc/os-release 2>/dev/null | grep -E "^(PRETTY_NAME|VERSION)" | head -2`,
        `echo "├── KERNEL"`,
        `uname -srm`,
        `echo "├── CPU"`,
        `nproc && cat /proc/cpuinfo 2>/dev/null | grep "model name" | head -1`,
        `echo "├── MEMORY"`,
        `free -h 2>/dev/null`,
        `echo "├── DISK"`,
        `df -h / 2>/dev/null`,
        `echo "├── UPTIME"`,
        `uptime -p 2>/dev/null || uptime`,
        `echo "├── NETWORK"`,
        `ip -4 addr show 2>/dev/null | grep "inet " | head -4 || ifconfig 2>/dev/null | grep "inet " | head -4`,
        `echo "└── USERS"`,
        `who 2>/dev/null || echo "(no active sessions)"`,
    ].join(' && ')
    const r = await runUbuntu(cmds, TIMEOUT_QUICK)
    await sendResult(sock, from, '💻 SYSTEM INFO — UBUNTU', r.out, msg)
}

async function handleKaliSysInfo(sock, from, q, msg) {
    await fmt.react(sock, msg, '🐉')
    const cmds = [
        `echo "┌── OS"`,
        `cat /etc/os-release 2>/dev/null | grep -E "^(PRETTY_NAME|VERSION)" | head -2`,
        `echo "├── KERNEL"`,
        `uname -srm`,
        `echo "├── MEMORY"`,
        `free -h 2>/dev/null`,
        `echo "├── DISK"`,
        `df -h / 2>/dev/null`,
        `echo "├── TOOLS CHECK"`,
        `which nmap sqlmap nikto hydra john hashcat 2>/dev/null | head -10`,
        `echo "└── IP"`,
        `hostname -I 2>/dev/null`,
    ].join(' && ')
    const r = await runKali(cmds, TIMEOUT_QUICK)
    await sendResult(sock, from, '🐉 SYSTEM INFO — KALI', r.out, msg)
}

async function handleMem(sock, from, q, msg) {
    await fmt.react(sock, msg, '💾')
    const r = await runUbuntu('free -h && echo "" && cat /proc/meminfo | grep -E "MemTotal|MemFree|MemAvailable|SwapTotal|SwapFree" 2>/dev/null', TIMEOUT_QUICK)
    await sendResult(sock, from, '💾 MEMORY INFO', r.out, msg)
}

async function handleDisk(sock, from, q, msg) {
    await fmt.react(sock, msg, '💿')
    const r = await runUbuntu('df -h 2>&1 && echo "---" && du -sh /* 2>/dev/null | sort -rh | head -20', TIMEOUT_QUICK)
    await sendResult(sock, from, '💿 DISK USAGE', r.out, msg)
}

async function handleCpu(sock, from, q, msg) {
    await fmt.react(sock, msg, '🖥️')
    const r = await runUbuntu(
        'echo "=== CPU INFO ===" && lscpu 2>/dev/null | head -20 && echo "" && echo "=== LOAD AVERAGE ===" && uptime && echo "" && echo "=== TOP CPU PROCESSES ===" && ps aux --sort=-%cpu | head -10 2>/dev/null',
        TIMEOUT_QUICK
    )
    await sendResult(sock, from, '🖥️ CPU INFO', r.out, msg)
}

async function handleUptime(sock, from, q, msg) {
    await fmt.react(sock, msg, '⏱️')
    const r = await runUbuntu('uptime && echo "" && who -b 2>/dev/null', TIMEOUT_QUICK)
    await sendResult(sock, from, '⏱️ UPTIME', r.out, msg)
}

async function handleWhoami(sock, from, q, msg) {
    await fmt.react(sock, msg, '👤')
    const r = await runUbuntu('whoami && id && echo "" && echo "=== Groups ===" && groups', TIMEOUT_QUICK)
    await sendResult(sock, from, '👤 CURRENT USER', r.out, msg)
}

async function handleUname(sock, from, q, msg) {
    await fmt.react(sock, msg, 'ℹ️')
    const r = await runUbuntu('uname -a && echo "" && cat /etc/os-release 2>/dev/null', TIMEOUT_QUICK)
    await sendResult(sock, from, 'ℹ️ KERNEL & OS INFO', r.out, msg)
}

async function handleHostname(sock, from, q, msg) {
    await fmt.react(sock, msg, '🏷️')
    const r = await runUbuntu('hostname && hostname -I 2>/dev/null', TIMEOUT_QUICK)
    await sendResult(sock, from, '🏷️ HOSTNAME', r.out, msg)
}

async function handleUsers(sock, from, q, msg) {
    await fmt.react(sock, msg, '👥')
    const r = await runUbuntu(
        'echo "=== All Users ===" && cat /etc/passwd | cut -d: -f1,3,7 | sort && echo "" && echo "=== Logged In ===" && who 2>/dev/null || echo "(none)"',
        TIMEOUT_QUICK
    )
    await sendResult(sock, from, '👥 SYSTEM USERS', r.out, msg)
}

async function handleEnv(sock, from, q, msg) {
    await fmt.react(sock, msg, '🌐')
    const r = await runUbuntu('env | sort | grep -v "SECRET\\|TOKEN\\|KEY\\|PASS\\|PWD" 2>/dev/null', TIMEOUT_QUICK)
    await sendResult(sock, from, '🌐 ENVIRONMENT VARS', r.out, msg)
}

async function handleServices(sock, from, q, msg) {
    await fmt.react(sock, msg, '🔧')
    const r = await runUbuntu(
        'service --status-all 2>&1 | head -40 || systemctl list-units --type=service --state=running 2>&1 | head -40',
        TIMEOUT_QUICK
    )
    await sendResult(sock, from, '🔧 SERVICES', r.out || '(none running)', msg)
}

async function handleLogs(sock, from, q, msg) {
    await fmt.react(sock, msg, '📋')
    const logfile = q || '/var/log/syslog'
    const r = await runUbuntu(`tail -50 ${logfile} 2>&1`, TIMEOUT_QUICK)
    await sendResult(sock, from, `📋 LOGS: ${logfile}`, r.out, msg)
}

async function handleCron(sock, from, q, msg) {
    await fmt.react(sock, msg, '⏰')
    const r = await runUbuntu(
        'echo "=== User cron ===" && crontab -l 2>/dev/null || echo "(no cron jobs)" && echo "" && echo "=== System cron ===" && ls /etc/cron* 2>/dev/null | head -20 && cat /etc/crontab 2>/dev/null | head -20',
        TIMEOUT_QUICK
    )
    await sendResult(sock, from, '⏰ CRON JOBS', r.out, msg)
}

// ═════════════════════════════════════════════════════════════════════════════
//  NETWORK COMMANDS
// ═════════════════════════════════════════════════════════════════════════════

async function handleNetInfo(sock, from, q, msg) {
    await fmt.react(sock, msg, '🌐')
    const r = await runUbuntu(
        'echo "=== Interfaces ===" && ip -4 addr show 2>/dev/null || ifconfig 2>/dev/null && echo "" && echo "=== Routes ===" && ip route 2>/dev/null || route -n 2>/dev/null && echo "" && echo "=== DNS ===" && cat /etc/resolv.conf 2>/dev/null | grep nameserver',
        TIMEOUT_QUICK
    )
    await sendResult(sock, from, '🌐 NETWORK INFO', r.out, msg)
}

async function handleMyIp(sock, from, q, msg) {
    await fmt.react(sock, msg, '📡')
    const r = await runUbuntu(
        'echo "=== Public IP ===" && curl -s --max-time 10 https://api.ipify.org 2>/dev/null && echo "" && echo "=== Local IPs ===" && hostname -I 2>/dev/null || ip -4 addr show | grep inet | awk "{print $2}" 2>/dev/null',
        TIMEOUT_QUICK
    )
    await sendResult(sock, from, '📡 IP ADDRESS', r.out, msg)
}

async function handleListenPorts(sock, from, q, msg) {
    await fmt.react(sock, msg, '🔌')
    const r = await runUbuntu(
        'ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null || echo "ss/netstat not available"',
        TIMEOUT_QUICK
    )
    await sendResult(sock, from, '🔌 LISTENING PORTS', r.out, msg)
}

async function handlePingCmd(sock, from, q, msg) {
    if (!q) return send(sock, from, '📶 PING', [
        `*Usage:* ${config.prefix}pinghost <host>`,
        `*Example:* ${config.prefix}pinghost google.com`,
        `*Example:* ${config.prefix}pinghost 8.8.8.8`,
    ], msg)
    await fmt.react(sock, msg, '📶')
    const r = await runUbuntu(`ping -c 5 -W 3 ${q} 2>&1`, TIMEOUT_QUICK)
    await sendResult(sock, from, `📶 PING: ${q}`, r.out, msg)
}

async function handleTraceroute(sock, from, q, msg) {
    if (!q) return send(sock, from, '🗺️ TRACEROUTE', [
        `*Usage:* ${config.prefix}trace <host>`,
        `*Example:* ${config.prefix}trace google.com`,
    ], msg)
    await fmt.react(sock, msg, '🗺️')
    await send(sock, from, '🗺️ TRACING', [`*Target:* ${q}`, `_This may take 30-60s..._`], msg)
    const r = await runUbuntu(`traceroute -m 20 ${q} 2>&1`, TIMEOUT_MED)
    await sendResult(sock, from, `🗺️ TRACEROUTE: ${q}`, r.out, msg)
}

async function handleDig(sock, from, q, msg) {
    if (!q) return send(sock, from, '🔍 DNS LOOKUP', [
        `*Usage:* ${config.prefix}dig <domain> [type]`,
        `*Example:* ${config.prefix}dig google.com`,
        `*Example:* ${config.prefix}dig google.com MX`,
        `*Example:* ${config.prefix}dig google.com NS`,
    ], msg)
    await fmt.react(sock, msg, '🔍')
    const parts = q.trim().split(/\s+/)
    const domain = parts[0], type = parts[1] || 'A'
    const r = await runUbuntu(`dig ${domain} ${type} +noall +answer 2>&1 || nslookup ${domain} 2>&1`, TIMEOUT_QUICK)
    await sendResult(sock, from, `🔍 DNS: ${domain} [${type}]`, r.out, msg)
}

async function handleWhois(sock, from, q, msg) {
    if (!q) return send(sock, from, '🌐 WHOIS', [
        `*Usage:* ${config.prefix}whois <domain or IP>`,
        `*Example:* ${config.prefix}whois google.com`,
        `*Example:* ${config.prefix}whois 8.8.8.8`,
    ], msg)
    await fmt.react(sock, msg, '🌐')
    const r = await runUbuntu(`whois ${q} 2>&1 | head -60 || curl -s "https://www.whois.com/whois/${q}" 2>&1 | head -40`, TIMEOUT_QUICK)
    await sendResult(sock, from, `🌐 WHOIS: ${q}`, r.out, msg)
}

async function handleCurlCmd(sock, from, q, msg) {
    if (!q) return send(sock, from, '🌐 CURL', [
        `*Usage:* ${config.prefix}fetch <url>`,
        `*Example:* ${config.prefix}fetch https://api.ipify.org`,
        `*Example:* ${config.prefix}fetch https://httpbin.org/headers`,
    ], msg)
    if (isBlocked(q)) return send(sock, from, '🚫 BLOCKED', ['Request blocked.'], msg)
    await fmt.react(sock, msg, '🌐')
    const r = await runUbuntu(`curl -s --max-time 20 -L "${q}" 2>&1 | head -100`, TIMEOUT_MED)
    await sendResult(sock, from, `🌐 FETCH: ${q}`, r.out, msg)
}

// ═════════════════════════════════════════════════════════════════════════════
//  PACKAGE MANAGEMENT (Ubuntu APT)
// ═════════════════════════════════════════════════════════════════════════════

async function handlePkg(sock, from, q, msg) {
    const args   = (q || '').trim().split(/\s+/)
    const sub    = (args[0] || '').toLowerCase()
    const target = args.slice(1).join(' ')

    if (!sub) return send(sock, from, '📦 PACKAGE MANAGER', [
        `*Ubuntu APT commands:*`,
        ``,
        `◈ ${config.prefix}pkg update          — refresh package list`,
        `◈ ${config.prefix}pkg upgrade          — upgrade all packages`,
        `◈ ${config.prefix}pkg install <name>   — install a package`,
        `◈ ${config.prefix}pkg remove <name>    — remove a package`,
        `◈ ${config.prefix}pkg search <query>   — search packages`,
        `◈ ${config.prefix}pkg list             — list installed`,
        `◈ ${config.prefix}pkg info <name>      — show package info`,
        `◈ ${config.prefix}pkg autoremove       — clean unused deps`,
    ], msg)

    switch (sub) {
        case 'update': {
            await fmt.react(sock, msg, '🔄')
            await send(sock, from, '📦 PKG UPDATE', [`_Refreshing package list..._`], msg)
            const r = await runUbuntu('apt-get update 2>&1', TIMEOUT_LONG)
            await fmt.react(sock, msg, '✅')
            await sendResult(sock, from, '📦 APT UPDATE', r.out, msg)
            break
        }
        case 'upgrade': {
            await fmt.react(sock, msg, '⬆️')
            await send(sock, from, '📦 PKG UPGRADE', [`_Upgrading packages... this may take a while_`], msg)
            const r = await runUbuntu('DEBIAN_FRONTEND=noninteractive apt-get upgrade -y 2>&1', TIMEOUT_LONG)
            await fmt.react(sock, msg, r.ok ? '✅' : '⚠️')
            await sendResult(sock, from, '📦 APT UPGRADE', r.out, msg)
            break
        }
        case 'install': {
            if (!target) return send(sock, from, '📦 PKG INSTALL', [`*Usage:* ${config.prefix}pkg install <name>`, `*Example:* ${config.prefix}pkg install python3`], msg)
            await fmt.react(sock, msg, '⬇️')
            await send(sock, from, '📦 INSTALLING', [`*Package:* ${target}`, `_Please wait..._`], msg)
            const r = await runUbuntu(`DEBIAN_FRONTEND=noninteractive apt-get install -y ${target} 2>&1`, TIMEOUT_LONG)
            await fmt.react(sock, msg, r.ok ? '✅' : '❌')
            await sendResult(sock, from, `📦 INSTALL: ${target}`, r.out, msg)
            break
        }
        case 'remove': {
            if (!target) return send(sock, from, '📦 PKG REMOVE', [`*Usage:* ${config.prefix}pkg remove <name>`], msg)
            await fmt.react(sock, msg, '🗑️')
            const r = await runUbuntu(`DEBIAN_FRONTEND=noninteractive apt-get remove -y ${target} 2>&1`, TIMEOUT_LONG)
            await fmt.react(sock, msg, r.ok ? '✅' : '❌')
            await sendResult(sock, from, `📦 REMOVE: ${target}`, r.out, msg)
            break
        }
        case 'search': {
            if (!target) return send(sock, from, '📦 PKG SEARCH', [`*Usage:* ${config.prefix}pkg search <name>`], msg)
            await fmt.react(sock, msg, '🔍')
            const r = await runUbuntu(`apt-cache search ${target} 2>&1 | head -40`, TIMEOUT_QUICK)
            await sendResult(sock, from, `🔍 SEARCH: ${target}`, r.out || '(no results)', msg)
            break
        }
        case 'list': {
            await fmt.react(sock, msg, '📋')
            const r = await runUbuntu('apt list --installed 2>/dev/null | head -80', TIMEOUT_QUICK)
            await sendResult(sock, from, '📋 INSTALLED PACKAGES', r.out, msg)
            break
        }
        case 'info': {
            if (!target) return send(sock, from, '📦 PKG INFO', [`*Usage:* ${config.prefix}pkg info <name>`], msg)
            await fmt.react(sock, msg, 'ℹ️')
            const r = await runUbuntu(`apt-cache show ${target} 2>&1 | head -40`, TIMEOUT_QUICK)
            await sendResult(sock, from, `ℹ️ PKG INFO: ${target}`, r.out, msg)
            break
        }
        case 'autoremove': {
            await fmt.react(sock, msg, '🧹')
            const r = await runUbuntu('DEBIAN_FRONTEND=noninteractive apt-get autoremove -y 2>&1', TIMEOUT_LONG)
            await fmt.react(sock, msg, '✅')
            await sendResult(sock, from, '🧹 AUTOREMOVE', r.out, msg)
            break
        }
        default:
            await send(sock, from, '📦 UNKNOWN PKG COMMAND', [
                `Unknown sub-command: *${sub}*`,
                ``,
                `Use: *${config.prefix}pkg* to see all options`,
            ], msg)
    }
}

// ═════════════════════════════════════════════════════════════════════════════
//  KALI PACKAGE MANAGEMENT
// ═════════════════════════════════════════════════════════════════════════════

async function handleKaliPkg(sock, from, q, msg) {
    const args   = (q || '').trim().split(/\s+/)
    const sub    = (args[0] || '').toLowerCase()
    const target = args.slice(1).join(' ')

    if (!sub) return send(sock, from, '🐉 KALI PACKAGES', [
        `*Kali APT commands:*`,
        ``,
        `◈ ${config.prefix}kpkg update          — refresh package list`,
        `◈ ${config.prefix}kpkg install <name>   — install a tool`,
        `◈ ${config.prefix}kpkg remove <name>    — remove a tool`,
        `◈ ${config.prefix}kpkg search <query>   — search tools`,
        `◈ ${config.prefix}kpkg list             — list installed`,
        `◈ ${config.prefix}kpkg tools            — show Kali toolsets`,
        `◈ ${config.prefix}kpkg metapack <set>   — install meta-package`,
    ], msg)

    switch (sub) {
        case 'update': {
            await fmt.react(sock, msg, '🔄')
            const r = await runKali('apt-get update 2>&1', TIMEOUT_LONG)
            await sendResult(sock, from, '🐉 KALI UPDATE', r.out, msg)
            break
        }
        case 'install': {
            if (!target) return send(sock, from, '🐉 KALI INSTALL', [`*Usage:* ${config.prefix}kpkg install <tool>`, `*Example:* ${config.prefix}kpkg install metasploit-framework`], msg)
            await fmt.react(sock, msg, '⬇️')
            await send(sock, from, '🐉 INSTALLING', [`*Tool:* ${target}`, `_Please wait... this may take a while_`], msg)
            const r = await runKali(`DEBIAN_FRONTEND=noninteractive apt-get install -y ${target} 2>&1`, TIMEOUT_LONG)
            await fmt.react(sock, msg, r.ok ? '✅' : '❌')
            await sendResult(sock, from, `🐉 INSTALL: ${target}`, r.out, msg)
            break
        }
        case 'search': {
            if (!target) return send(sock, from, '🐉 KALI SEARCH', [`*Usage:* ${config.prefix}kpkg search <tool>`], msg)
            await fmt.react(sock, msg, '🔍')
            const r = await runKali(`apt-cache search ${target} 2>&1 | head -40`, TIMEOUT_QUICK)
            await sendResult(sock, from, `🔍 KALI SEARCH: ${target}`, r.out || '(no results)', msg)
            break
        }
        case 'list': {
            await fmt.react(sock, msg, '📋')
            const r = await runKali('apt list --installed 2>/dev/null | head -80', TIMEOUT_QUICK)
            await sendResult(sock, from, '📋 KALI INSTALLED', r.out, msg)
            break
        }
        case 'tools': {
            await fmt.react(sock, msg, '🛠️')
            await send(sock, from, '🛠️ KALI META-PACKAGES', [
                `*Available toolsets:*`,
                ``,
                `◈ kali-linux-top10     — Top 10 tools`,
                `◈ kali-linux-web       — Web hacking tools`,
                `◈ kali-linux-wireless  — WiFi tools`,
                `◈ kali-linux-forensics — Forensics tools`,
                `◈ kali-linux-exploit   — Exploitation tools`,
                `◈ kali-linux-passwords — Password tools`,
                `◈ kali-linux-sniffing  — Sniffing tools`,
                `◈ kali-linux-voip      — VoIP tools`,
                `◈ kali-linux-fuzzing   — Fuzzing tools`,
                ``,
                `Install: ${config.prefix}kpkg metapack kali-linux-top10`,
            ], msg)
            break
        }
        case 'metapack': {
            if (!target) return send(sock, from, '🛠️ META-PACKAGE', [`*Usage:* ${config.prefix}kpkg metapack <set>`], msg)
            await fmt.react(sock, msg, '⬇️')
            await send(sock, from, '🛠️ INSTALLING META-PACKAGE', [`*Set:* ${target}`, `_This may take several minutes..._`], msg)
            const r = await runKali(`DEBIAN_FRONTEND=noninteractive apt-get install -y ${target} 2>&1`, TIMEOUT_LONG)
            await fmt.react(sock, msg, r.ok ? '✅' : '❌')
            await sendResult(sock, from, `🛠️ META-PACKAGE: ${target}`, r.out, msg)
            break
        }
        default:
            await send(sock, from, '🐉 UNKNOWN KALI COMMAND', [`Use: *${config.prefix}kpkg* to see all options`], msg)
    }
}

// ═════════════════════════════════════════════════════════════════════════════
//  DISTRO STATUS
// ═════════════════════════════════════════════════════════════════════════════

async function handleDistroStatus(sock, from, q, msg) {
    await fmt.react(sock, msg, '🖥️')
    await send(sock, from, '🖥️ CHECKING DISTROS', [`_Checking installed proot containers..._`], msg)

    const r = await run('proot-distro list 2>&1', TIMEOUT_QUICK)
    const ubuntuCheck = await runUbuntu('cat /etc/os-release | head -3 2>&1', TIMEOUT_QUICK)
    const kaliCheck   = await runKali('cat /etc/os-release | head -3 2>&1', TIMEOUT_QUICK)

    await sendResult(sock, from, '🖥️ PROOT DISTROS', [
        `*proot-distro list:*`,
        r.out,
        ``,
        `*Ubuntu status:* ${ubuntuCheck.ok ? '✅ RUNNING' : '❌ ERROR'}`,
        ubuntuCheck.out,
        ``,
        `*Kali status:* ${kaliCheck.ok ? '✅ RUNNING' : '❌ ERROR'}`,
        kaliCheck.out,
    ].join('\n'), msg)
}

// ═════════════════════════════════════════════════════════════════════════════
//  TERMUX HOST COMMANDS
// ═════════════════════════════════════════════════════════════════════════════

async function handleTermuxInfo(sock, from, q, msg) {
    await fmt.react(sock, msg, '📱')
    const r = await run(
        'echo "=== TERMUX ===" && pkg list-installed 2>/dev/null | wc -l && echo " packages installed" && echo "" && echo "=== STORAGE ===" && df -h /data 2>/dev/null && echo "" && echo "=== ANDROID ===" && uname -a 2>/dev/null',
        TIMEOUT_QUICK
    )
    await sendResult(sock, from, '📱 TERMUX INFO', r.out, msg)
}

async function handleTermuxPkg(sock, from, q, msg) {
    const args   = (q || '').trim().split(/\s+/)
    const sub    = (args[0] || '').toLowerCase()
    const target = args.slice(1).join(' ')

    if (!sub) return send(sock, from, '📱 TERMUX PACKAGES', [
        `◈ ${config.prefix}tpkg list             — list installed`,
        `◈ ${config.prefix}tpkg install <name>   — install package`,
        `◈ ${config.prefix}tpkg remove <name>    — remove package`,
        `◈ ${config.prefix}tpkg search <query>   — search packages`,
        `◈ ${config.prefix}tpkg update           — update packages`,
    ], msg)

    switch (sub) {
        case 'list': {
            const r = await run('pkg list-installed 2>&1 | head -60', TIMEOUT_QUICK)
            await sendResult(sock, from, '📱 TERMUX PACKAGES', r.out, msg)
            break
        }
        case 'install': {
            if (!target) return send(sock, from, '📱 TPKG INSTALL', [`*Usage:* ${config.prefix}tpkg install <name>`], msg)
            await fmt.react(sock, msg, '⬇️')
            const r = await run(`pkg install -y ${target} 2>&1`, TIMEOUT_LONG)
            await sendResult(sock, from, `📱 TPKG INSTALL: ${target}`, r.out, msg)
            break
        }
        case 'remove': {
            if (!target) return send(sock, from, '📱 TPKG REMOVE', [`*Usage:* ${config.prefix}tpkg remove <name>`], msg)
            const r = await run(`pkg remove -y ${target} 2>&1`, TIMEOUT_LONG)
            await sendResult(sock, from, `📱 TPKG REMOVE: ${target}`, r.out, msg)
            break
        }
        case 'search': {
            if (!target) return send(sock, from, '📱 TPKG SEARCH', [`*Usage:* ${config.prefix}tpkg search <name>`], msg)
            const r = await run(`pkg search ${target} 2>&1 | head -40`, TIMEOUT_QUICK)
            await sendResult(sock, from, `🔍 TPKG SEARCH: ${target}`, r.out || '(no results)', msg)
            break
        }
        case 'update': {
            await fmt.react(sock, msg, '🔄')
            const r = await run('pkg update -y 2>&1', TIMEOUT_LONG)
            await sendResult(sock, from, '📱 TERMUX UPDATE', r.out, msg)
            break
        }
        default:
            await send(sock, from, '📱 UNKNOWN', [`Use: *${config.prefix}tpkg* to see options`], msg)
    }
}

// ═════════════════════════════════════════════════════════════════════════════
//  RAW SHELL — executes on host (Termux)
// ═════════════════════════════════════════════════════════════════════════════

async function handleShell(sock, from, q, msg) {
    if (!q) return send(sock, from, '💻 SHELL (TERMUX HOST)', [
        `*Usage:* ${config.prefix}sh <command>`,
        ``,
        `Runs directly on Termux host (Android).`,
        ``,
        `*Examples:*`,
        `◈ ${config.prefix}sh ls -la`,
        `◈ ${config.prefix}sh proot-distro list`,
        `◈ ${config.prefix}sh uname -a`,
        `◈ ${config.prefix}sh df -h`,
        `◈ ${config.prefix}sh free -h`,
        `◈ ${config.prefix}sh ps aux | head -20`,
        `◈ ${config.prefix}sh ip a`,
        ``,
        `_For Ubuntu: use ${config.prefix}ub_`,
        `_For Kali:   use ${config.prefix}kl_`,
    ], msg)

    if (isBlocked(q)) return send(sock, from, '🚫 BLOCKED', [`Destructive command blocked.`], msg)

    await fmt.react(sock, msg, '⚙️')
    const start = Date.now()
    const r = await run(q, TIMEOUT_MED)
    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    await fmt.react(sock, msg, '✅')

    await sendResult(sock, from, `💻 SHELL — ${elapsed}s\n$ ${q}`, r.out || '(no output)', msg)
}

module.exports = {
    handleUbuntu,
    handleKaliShell,
    handleFiles,
    handleCat,
    handleFind,
    handleGrep,
    handleChmod,
    handleDownloadFile,
    handleTar,
    handleProc,
    handleKillProc,
    handleJobs,
    handleSysInfo,
    handleKaliSysInfo,
    handleMem,
    handleDisk,
    handleCpu,
    handleUptime,
    handleWhoami,
    handleUname,
    handleHostname,
    handleUsers,
    handleEnv,
    handleServices,
    handleLogs,
    handleCron,
    handleNetInfo,
    handleMyIp,
    handleListenPorts,
    handlePingCmd,
    handleTraceroute,
    handleDig,
    handleWhois,
    handleCurlCmd,
    handlePkg,
    handleKaliPkg,
    handleDistroStatus,
    handleTermuxInfo,
    handleTermuxPkg,
    handleShell,
}
