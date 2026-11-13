'use strict'
/**
 * linux_cmds.js — Dedicated per-tool Ubuntu/Linux commands for MAHNGUELOH VANTA
 *
 * Every tool is its own bot command.
 * Ubuntu commands run in proot-distro Ubuntu. Host commands run in Termux.
 *
 * ── FILE MANAGEMENT ─────────────────────────────────────
 *  .ls    [path]              List files/directories
 *  .cat   <file>              Read file contents
 *  .head  <file> [n]          First N lines of file
 *  .tail  <file> [n]          Last N lines of file
 *  .mkdir <dir>               Create directory
 *  .rmfile <file>             Remove file or empty dir
 *  .cpfile <src> <dst>        Copy file
 *  .mvfile <src> <dst>        Move/rename file
 *  .touch <file>              Create empty file
 *  .chmod <perm> <file>       Change permissions
 *  .chown <user:group> <file> Change owner
 *  .find  <name>              Find files by name
 *  .grep  <pattern> <file>    Search text in file
 *  .du    [path]              Directory/file size
 *  .stat  <file>              File info & timestamps
 *  .wc    <file>              Word/line/char count
 *  .sort  <file>              Sort file lines
 *  .uniq  <file>              Remove duplicate lines
 *  .diff  <file1> <file2>     Compare two files
 *
 * ── ARCHIVE / COMPRESSION ───────────────────────────────
 *  .extract <file>            Extract tar/zip/gz/bz2
 *  .zipfile <dir>             Zip a directory
 *  .gzip  <file>              Compress with gzip
 *  .gunzip <file>             Decompress gzip
 *
 * ── DOWNLOAD ────────────────────────────────────────────
 *  .wget  <url>               Download file to /tmp
 *  .curlget <url>             Fetch URL content
 *
 * ── SYSTEM INFO ─────────────────────────────────────────
 *  .sysinfo                   Full system overview
 *  .uptime                    System uptime & load
 *  .free                      Memory usage
 *  .df                        Disk space usage
 *  .du    [path]              Dir/file disk usage
 *  .lscpu                     CPU info
 *  .lsblk                     Block devices
 *  .uname                     Kernel & OS info
 *  .hostname                  Device hostname
 *  .whoami                    Current user + groups
 *  .date                      Current date & time
 *  .env                       Environment variables
 *  .users                     System users list
 *
 * ── PROCESS MANAGEMENT ──────────────────────────────────
 *  .ps    [filter]            List processes
 *  .top                       Top processes by CPU
 *  .kill  <pid>               Kill process by PID
 *  .pkill <name>              Kill process by name
 *  .pgrep <name>              Find process PID
 *  .jobs                      Background jobs
 *
 * ── NETWORK ─────────────────────────────────────────────
 *  .ping  <host>              Ping a host
 *  .traceroute <host>         Trace network path
 *  .dig   <domain> [type]     DNS lookup
 *  .nslookup <domain>         DNS query
 *  .whois <domain>            WHOIS info
 *  .curl  <url>               HTTP request/fetch
 *  .netstat                   Network connections
 *  .ss                        Socket statistics
 *  .ifconfig                  Network interfaces
 *  .ip                        IP address/route info
 *  .arp                       ARP table
 *  .myip                      Public + local IP
 *
 * ── PACKAGE MANAGEMENT (APT — Ubuntu) ───────────────────
 *  .apt   install <pkg>       Install a package
 *  .apt   remove  <pkg>       Remove a package
 *  .apt   search  <query>     Search packages
 *  .apt   update              Refresh package list
 *  .apt   upgrade             Upgrade all packages
 *  .apt   list                List installed packages
 *  .apt   info    <pkg>       Package details
 *  .apt   autoremove          Clean unused deps
 *
 * ── PACKAGE MANAGEMENT (Termux host) ────────────────────
 *  .tpkg  install <pkg>       Install Termux package
 *  .tpkg  remove  <pkg>       Remove Termux package
 *  .tpkg  search  <query>     Search Termux packages
 *  .tpkg  update              Update Termux packages
 *  .tpkg  list                List installed
 */

const { exec } = require('child_process')
const config   = require('../config')
const fmt      = require('../lib/format')
const os       = require('os')

const T_QUICK = 15000
const T_MED   = 45000
const T_LONG  = 120000

// ── Runners ────────────────────────────────────────────────────────────────────
function run(cmd, ms = T_MED) {
    return new Promise(resolve => {
        const p = exec(cmd, { cwd: os.tmpdir(), timeout: ms, maxBuffer: 10 * 1024 * 1024 }, (err, out, err2) => {
            const raw = (out || '').trim() || (err2 || '').trim() || (err?.message || 'No output')
            resolve({ ok: !err || (out || '').trim().length > 0, out: raw })
        })
        setTimeout(() => { try { p.kill('SIGKILL') } catch {} }, ms + 500)
    })
}

// Ubuntu container
function ubuntu(cmd, ms = T_MED) {
    const safe = cmd.replace(/'/g, `'\\''`)
    return run(`proot-distro login ubuntu -- bash -c '${safe}' 2>&1`, ms)
}

function clean(txt, max = 3500) {
    const s = txt.replace(/\x1B\[[0-9;]*[mGKHF]/g, '').trim()
    if (s.length <= max) return s
    const h = Math.floor(max / 2)
    return s.slice(0, h) + '\n\n...[trimmed]...\n\n' + s.slice(-h)
}

async function reply(sock, from, title, out, msg) {
    const text = clean(out)
    if (text.length <= 3200)
        return sock.sendMessage(from, { text: fmt.box(title, [text]) }, { quoted: msg })
    await sock.sendMessage(from, { text: fmt.box(title, ['_(long output — chunks below)_']) }, { quoted: msg })
    let buf = ''
    for (const line of text.split('\n')) {
        if ((buf + '\n' + line).length > 3000) {
            await sock.sendMessage(from, { text: '```\n' + buf.trim() + '\n```' })
            buf = line
        } else buf += (buf ? '\n' : '') + line
    }
    if (buf.trim()) await sock.sendMessage(from, { text: '```\n' + buf.trim() + '\n```' })
}

async function tip(sock, from, title, lines, msg) {
    return sock.sendMessage(from, { text: fmt.box(title, lines) }, { quoted: msg })
}

function elapsed(start) { return ((Date.now() - start) / 1000).toFixed(1) + 's' }

const p = () => config.prefix

// Safety blocklist
const BLOCKED = [
    /\brm\s+-rf\s+\/\b/i, /\bdd\s+if=.*of=\/dev\//i, /\bmkfs\b/i,
    /\bshutdown\b/, /\breboot\b/, /\binit\s+0\b/,
    /\bcat\s+\/etc\/shadow\b/i, /\bpasswd\b/, />\s*\/dev\/sd/i,
]
function blocked(cmd) { return BLOCKED.some(r => r.test(cmd)) }

// ════════════════════════════════════════════════════════════════════════════════
//  FILE MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════════

async function handleLs(sock, from, q, msg) {
    if (q && blocked(q)) return tip(sock, from, '🚫 BLOCKED', ['Access denied.'], msg)
    await fmt.react(sock, msg, '📁')
    const path = q || '~'
    const t = Date.now()
    const r = await ubuntu(`ls -lah --color=never ${path}`, T_QUICK)
    await reply(sock, from, `📁 LS: ${path} [${elapsed(t)}]`, r.out, msg)
}

async function handleCat(sock, from, q, msg) {
    if (!q) return tip(sock, from, '📄 CAT — Read File', [
        `*Usage:* ${p()}cat <file>`,
        `◈ ${p()}cat /etc/hosts`,
        `◈ ${p()}cat /etc/os-release`,
        `◈ ${p()}cat /proc/version`,
    ], msg)
    if (blocked(q)) return tip(sock, from, '🚫 BLOCKED', ['File access denied.'], msg)
    await fmt.react(sock, msg, '📄')
    const t = Date.now()
    const r = await ubuntu(`cat ${q} 2>&1 | head -300`, T_QUICK)
    await reply(sock, from, `📄 CAT: ${q} [${elapsed(t)}]`, r.out, msg)
}

async function handleHead(sock, from, q, msg) {
    if (!q) return tip(sock, from, '📄 HEAD — First Lines of File', [
        `*Usage:* ${p()}head <file> [lines]`,
        `◈ ${p()}head /var/log/syslog`,
        `◈ ${p()}head /var/log/syslog 50`,
    ], msg)
    const parts = q.trim().split(/\s+/)
    const file  = parts[0]
    const n     = parseInt(parts[1]) || 30
    if (blocked(file)) return tip(sock, from, '🚫 BLOCKED', ['File access denied.'], msg)
    await fmt.react(sock, msg, '📄')
    const t = Date.now()
    const r = await ubuntu(`head -${n} ${file}`, T_QUICK)
    await reply(sock, from, `📄 HEAD: ${file} [${elapsed(t)}]`, r.out, msg)
}

async function handleTail(sock, from, q, msg) {
    if (!q) return tip(sock, from, '📄 TAIL — Last Lines of File', [
        `*Usage:* ${p()}tail <file> [lines]`,
        `◈ ${p()}tail /var/log/syslog`,
        `◈ ${p()}tail /var/log/syslog 50`,
        `◈ ${p()}tail /tmp/output.txt 100`,
    ], msg)
    const parts = q.trim().split(/\s+/)
    const file  = parts[0]
    const n     = parseInt(parts[1]) || 30
    if (blocked(file)) return tip(sock, from, '🚫 BLOCKED', ['File access denied.'], msg)
    await fmt.react(sock, msg, '📄')
    const t = Date.now()
    const r = await ubuntu(`tail -${n} ${file}`, T_QUICK)
    await reply(sock, from, `📄 TAIL: ${file} [${elapsed(t)}]`, r.out, msg)
}

async function handleMkdir(sock, from, q, msg) {
    if (!q) return tip(sock, from, '📁 MKDIR — Create Directory', [
        `*Usage:* ${p()}mkdir <directory>`,
        `◈ ${p()}mkdir /tmp/myproject`,
        `◈ ${p()}mkdir -p /tmp/a/b/c    — create nested dirs`,
    ], msg)
    if (blocked(q)) return tip(sock, from, '🚫 BLOCKED', ['Access denied.'], msg)
    await fmt.react(sock, msg, '📁')
    const t = Date.now()
    const r = await ubuntu(`mkdir -p ${q} && echo "Created: ${q}" && ls -la "$(dirname "${q}")" | grep "$(basename "${q}")"`, T_QUICK)
    await reply(sock, from, `📁 MKDIR [${elapsed(t)}]`, r.out, msg)
}

async function handleRmfile(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🗑️ RMFILE — Remove File', [
        `*Usage:* ${p()}rmfile <file or empty-dir>`,
        `◈ ${p()}rmfile /tmp/oldfile.txt`,
        `◈ ${p()}rmfile /tmp/olddir        — removes empty directory`,
        ``,
        `_⚠️ No recursive delete for safety._`,
        `_To remove dir with contents, use ${p()}ub rm -rf /tmp/dir_`,
    ], msg)
    if (blocked(q)) return tip(sock, from, '🚫 BLOCKED', ['Destructive path blocked.'], msg)
    await fmt.react(sock, msg, '🗑️')
    const t = Date.now()
    const r = await ubuntu(`rm -v ${q} 2>&1 || rmdir ${q} 2>&1`, T_QUICK)
    await reply(sock, from, `🗑️ RMFILE [${elapsed(t)}]`, r.out, msg)
}

async function handleCpfile(sock, from, q, msg) {
    if (!q || !q.trim().includes(' ')) return tip(sock, from, '📋 CPFILE — Copy File', [
        `*Usage:* ${p()}cpfile <source> <destination>`,
        `◈ ${p()}cpfile /tmp/file.txt /tmp/backup.txt`,
        `◈ ${p()}cpfile /tmp/file.txt /home/user/`,
    ], msg)
    if (blocked(q)) return tip(sock, from, '🚫 BLOCKED', ['Access denied.'], msg)
    await fmt.react(sock, msg, '📋')
    const t = Date.now()
    const r = await ubuntu(`cp -v ${q}`, T_QUICK)
    await reply(sock, from, `📋 COPY [${elapsed(t)}]`, r.out, msg)
}

async function handleMvfile(sock, from, q, msg) {
    if (!q || !q.trim().includes(' ')) return tip(sock, from, '✂️ MVFILE — Move / Rename', [
        `*Usage:* ${p()}mvfile <source> <destination>`,
        `◈ ${p()}mvfile /tmp/old.txt /tmp/new.txt`,
        `◈ ${p()}mvfile /tmp/file.txt /home/user/docs/`,
    ], msg)
    if (blocked(q)) return tip(sock, from, '🚫 BLOCKED', ['Access denied.'], msg)
    await fmt.react(sock, msg, '✂️')
    const t = Date.now()
    const r = await ubuntu(`mv -v ${q}`, T_QUICK)
    await reply(sock, from, `✂️ MOVE [${elapsed(t)}]`, r.out, msg)
}

async function handleTouch(sock, from, q, msg) {
    if (!q) return tip(sock, from, '✏️ TOUCH — Create Empty File', [
        `*Usage:* ${p()}touch <filename>`,
        `◈ ${p()}touch /tmp/newfile.txt`,
        `◈ ${p()}touch /tmp/script.sh`,
    ], msg)
    await fmt.react(sock, msg, '✏️')
    const t = Date.now()
    const r = await ubuntu(`touch ${q} && echo "Created: ${q}" && ls -lah ${q}`, T_QUICK)
    await reply(sock, from, `✏️ TOUCH [${elapsed(t)}]`, r.out, msg)
}

async function handleChmod(sock, from, q, msg) {
    if (!q || !q.trim().includes(' ')) return tip(sock, from, '🔑 CHMOD — Change Permissions', [
        `*Usage:* ${p()}chmod <permissions> <file>`,
        `◈ ${p()}chmod 755 /tmp/script.sh`,
        `◈ ${p()}chmod +x /tmp/run.sh`,
        `◈ ${p()}chmod 644 /tmp/config.txt`,
        `◈ ${p()}chmod 777 /tmp/shared/`,
        ``,
        `_Tip: 755 = rwxr-xr-x, 644 = rw-r--r--_`,
    ], msg)
    await fmt.react(sock, msg, '🔑')
    const t = Date.now()
    const r = await ubuntu(`chmod ${q} && echo "Done" && ls -la ${q.split(' ').pop()}`, T_QUICK)
    await reply(sock, from, `🔑 CHMOD [${elapsed(t)}]`, r.out, msg)
}

async function handleChown(sock, from, q, msg) {
    if (!q || !q.trim().includes(' ')) return tip(sock, from, '👤 CHOWN — Change Owner', [
        `*Usage:* ${p()}chown <user:group> <file>`,
        `◈ ${p()}chown root:root /tmp/file.txt`,
        `◈ ${p()}chown user:user /tmp/dir`,
    ], msg)
    if (blocked(q)) return tip(sock, from, '🚫 BLOCKED', ['Access denied.'], msg)
    await fmt.react(sock, msg, '👤')
    const t = Date.now()
    const r = await ubuntu(`chown ${q} && echo "Done"`, T_QUICK)
    await reply(sock, from, `👤 CHOWN [${elapsed(t)}]`, r.out, msg)
}

async function handleFind(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🔍 FIND — Find Files', [
        `*Usage:* ${p()}find <filename/pattern>`,
        `◈ ${p()}find config.txt`,
        `◈ ${p()}find *.log`,
        `◈ ${p()}find passwd`,
        ``,
        `_Searches entire filesystem. Shows first 50 results._`,
    ], msg)
    await fmt.react(sock, msg, '🔍')
    const t = Date.now()
    const r = await ubuntu(`find / -name "*${q}*" 2>/dev/null | head -50`, T_MED)
    await reply(sock, from, `🔍 FIND: ${q} [${elapsed(t)}]`, r.out || '(no results)', msg)
}

async function handleGrep(sock, from, q, msg) {
    if (!q || !q.trim().includes(' ')) return tip(sock, from, '🔎 GREP — Search in File', [
        `*Usage:* ${p()}grep <pattern> <file>`,
        `◈ ${p()}grep root /etc/passwd`,
        `◈ ${p()}grep "error" /var/log/syslog`,
        `◈ ${p()}grep admin /etc/group`,
        `◈ ${p()}grep -i "warning" /var/log/syslog    — case-insensitive`,
    ], msg)
    if (blocked(q)) return tip(sock, from, '🚫 BLOCKED', ['Access denied.'], msg)
    const parts   = q.trim().split(/\s+/)
    const pattern = parts[0]
    const file    = parts.slice(1).join(' ')
    await fmt.react(sock, msg, '🔎')
    const t = Date.now()
    const r = await ubuntu(`grep -n -- "${pattern.replace(/"/g, '\\"')}" ${file} 2>&1 | head -100`, T_QUICK)
    await reply(sock, from, `🔎 GREP: "${pattern}" in ${file} [${elapsed(t)}]`, r.out || '(no matches)', msg)
}

async function handleDu(sock, from, q, msg) {
    await fmt.react(sock, msg, '📊')
    const path = q || '~'
    const t = Date.now()
    const r = await ubuntu(`du -sh ${path} 2>/dev/null && du -sh ${path}/* 2>/dev/null | sort -rh | head -20`, T_QUICK)
    await reply(sock, from, `📊 DU: ${path} [${elapsed(t)}]`, r.out, msg)
}

async function handleStat(sock, from, q, msg) {
    if (!q) return tip(sock, from, '📋 STAT — File Info', [
        `*Usage:* ${p()}stat <file>`,
        `◈ ${p()}stat /tmp/file.txt`,
        `◈ ${p()}stat /etc/passwd`,
    ], msg)
    await fmt.react(sock, msg, '📋')
    const t = Date.now()
    const r = await ubuntu(`stat ${q}`, T_QUICK)
    await reply(sock, from, `📋 STAT [${elapsed(t)}]`, r.out, msg)
}

async function handleWc(sock, from, q, msg) {
    if (!q) return tip(sock, from, '📊 WC — Word/Line/Char Count', [
        `*Usage:* ${p()}wc <file>`,
        `◈ ${p()}wc /tmp/file.txt`,
        `◈ ${p()}wc /etc/passwd`,
    ], msg)
    await fmt.react(sock, msg, '📊')
    const t = Date.now()
    const r = await ubuntu(`wc ${q}`, T_QUICK)
    await reply(sock, from, `📊 WC [${elapsed(t)}]`, r.out, msg)
}

async function handleSortfile(sock, from, q, msg) {
    if (!q) return tip(sock, from, '📋 SORT — Sort File Lines', [
        `*Usage:* ${p()}sortfile <file>`,
        `◈ ${p()}sortfile /tmp/list.txt`,
        `◈ ${p()}sortfile /etc/hosts`,
    ], msg)
    await fmt.react(sock, msg, '📋')
    const t = Date.now()
    const r = await ubuntu(`sort ${q} | head -100`, T_QUICK)
    await reply(sock, from, `📋 SORT [${elapsed(t)}]`, r.out, msg)
}

async function handleUniq(sock, from, q, msg) {
    if (!q) return tip(sock, from, '📋 UNIQ — Remove Duplicate Lines', [
        `*Usage:* ${p()}uniq <file>`,
        `◈ ${p()}uniq /tmp/list.txt`,
        `◈ ${p()}uniq -c /tmp/list.txt   — show count per line`,
    ], msg)
    await fmt.react(sock, msg, '📋')
    const t = Date.now()
    const r = await ubuntu(`sort ${q} | uniq | head -100`, T_QUICK)
    await reply(sock, from, `📋 UNIQ [${elapsed(t)}]`, r.out, msg)
}

async function handleDiff(sock, from, q, msg) {
    if (!q || !q.trim().includes(' ')) return tip(sock, from, '🔀 DIFF — Compare Files', [
        `*Usage:* ${p()}diff <file1> <file2>`,
        `◈ ${p()}diff /tmp/file1.txt /tmp/file2.txt`,
    ], msg)
    await fmt.react(sock, msg, '🔀')
    const t = Date.now()
    const r = await ubuntu(`diff ${q} 2>&1`, T_QUICK)
    await reply(sock, from, `🔀 DIFF [${elapsed(t)}]`, r.out || '(files are identical)', msg)
}

// ════════════════════════════════════════════════════════════════════════════════
//  ARCHIVE / COMPRESSION
// ════════════════════════════════════════════════════════════════════════════════

async function handleExtract(sock, from, q, msg) {
    if (!q) return tip(sock, from, '📦 EXTRACT — Extract Archives', [
        `*Usage:* ${p()}extract <file>`,
        `◈ ${p()}extract /tmp/archive.tar.gz`,
        `◈ ${p()}extract /tmp/archive.zip`,
        `◈ ${p()}extract /tmp/file.tar.bz2`,
        `◈ ${p()}extract /tmp/file.tar.xz`,
        ``,
        `_Auto-detects format and extracts to /tmp/_`,
    ], msg)
    await fmt.react(sock, msg, '📦')
    let cmd
    if      (q.endsWith('.zip'))     cmd = `unzip -o "${q}" -d /tmp/extracted_${Date.now()}`
    else if (q.endsWith('.tar.gz') || q.endsWith('.tgz')) cmd = `tar -xzf "${q}" -C /tmp/`
    else if (q.endsWith('.tar.bz2')) cmd = `tar -xjf "${q}" -C /tmp/`
    else if (q.endsWith('.tar.xz'))  cmd = `tar -xJf "${q}" -C /tmp/`
    else if (q.endsWith('.tar'))     cmd = `tar -xf "${q}" -C /tmp/`
    else if (q.endsWith('.gz'))      cmd = `gunzip -k "${q}"`
    else                             cmd = `tar -xf "${q}" -C /tmp/`
    const t = Date.now()
    const r = await ubuntu(`${cmd} 2>&1 && echo "✅ Extracted successfully"`, T_MED)
    await fmt.react(sock, msg, r.ok ? '✅' : '❌')
    await reply(sock, from, `📦 EXTRACT [${elapsed(t)}]`, r.out, msg)
}

async function handleZipfile(sock, from, q, msg) {
    if (!q) return tip(sock, from, '📦 ZIPFILE — Create Zip Archive', [
        `*Usage:* ${p()}zipfile <dir or file>`,
        `◈ ${p()}zipfile /tmp/myproject`,
        `◈ ${p()}zipfile /tmp/files/`,
    ], msg)
    await fmt.react(sock, msg, '📦')
    const name = q.replace(/\/$/, '').split('/').pop()
    const out  = `/tmp/${name}_${Date.now()}.zip`
    const t = Date.now()
    const r = await ubuntu(`zip -r "${out}" "${q}" 2>&1 && echo "✅ Created: ${out}"`, T_MED)
    await fmt.react(sock, msg, r.ok ? '✅' : '❌')
    await reply(sock, from, `📦 ZIP [${elapsed(t)}]`, r.out, msg)
}

async function handleGzip(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🗜️ GZIP — Compress File', [
        `*Usage:* ${p()}gzip <file>`,
        `◈ ${p()}gzip /tmp/largefile.txt`,
    ], msg)
    await fmt.react(sock, msg, '🗜️')
    const t = Date.now()
    const r = await ubuntu(`gzip -v "${q}" 2>&1 && ls -lh "${q}.gz"`, T_QUICK)
    await reply(sock, from, `🗜️ GZIP [${elapsed(t)}]`, r.out, msg)
}

async function handleGunzip(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🗜️ GUNZIP — Decompress File', [
        `*Usage:* ${p()}gunzip <file.gz>`,
        `◈ ${p()}gunzip /tmp/file.txt.gz`,
    ], msg)
    await fmt.react(sock, msg, '🗜️')
    const t = Date.now()
    const r = await ubuntu(`gunzip -v "${q}" 2>&1`, T_QUICK)
    await reply(sock, from, `🗜️ GUNZIP [${elapsed(t)}]`, r.out, msg)
}

// ════════════════════════════════════════════════════════════════════════════════
//  DOWNLOAD
// ════════════════════════════════════════════════════════════════════════════════

async function handleWget(sock, from, q, msg) {
    if (!q) return tip(sock, from, '⬇️ WGET — Download File', [
        `*Usage:* ${p()}wget <url>`,
        `◈ ${p()}wget https://example.com/file.zip`,
        `◈ ${p()}wget https://example.com/script.sh`,
        ``,
        `_Downloads to /tmp/ inside Ubuntu_`,
    ], msg)
    if (blocked(q)) return tip(sock, from, '🚫 BLOCKED', ['URL blocked.'], msg)
    await fmt.react(sock, msg, '⬇️')
    const name = q.split('/').pop().split('?')[0] || 'downloaded'
    await tip(sock, from, '⬇️ DOWNLOADING', [`*URL:* ${q}`, `_Please wait..._`], msg)
    const t = Date.now()
    const r = await ubuntu(`wget -O /tmp/${name} "${q}" 2>&1 && echo "✅ Saved: /tmp/${name}" && ls -lh /tmp/${name}`, T_LONG)
    await fmt.react(sock, msg, r.ok ? '✅' : '❌')
    await reply(sock, from, `⬇️ WGET [${elapsed(t)}]`, r.out, msg)
}

async function handleCurlget(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🌐 CURLGET — Fetch URL Content', [
        `*Usage:* ${p()}curlget <url>`,
        `◈ ${p()}curlget https://api.ipify.org`,
        `◈ ${p()}curlget https://httpbin.org/ip`,
        `◈ ${p()}curlget https://example.com`,
        ``,
        `_Shows HTTP response body_`,
    ], msg)
    if (blocked(q)) return tip(sock, from, '🚫 BLOCKED', ['URL blocked.'], msg)
    await fmt.react(sock, msg, '🌐')
    const t = Date.now()
    const r = await ubuntu(`curl -sL --max-time 20 "${q}" 2>&1 | head -200`, T_MED)
    await reply(sock, from, `🌐 CURL [${elapsed(t)}]`, r.out, msg)
}

// ════════════════════════════════════════════════════════════════════════════════
//  SYSTEM INFO
// ════════════════════════════════════════════════════════════════════════════════

async function handleSysinfo(sock, from, q, msg) {
    await fmt.react(sock, msg, '💻')
    const t = Date.now()
    const r = await ubuntu([
        `echo "┌── OS ──────────────────────────────"`,
        `cat /etc/os-release 2>/dev/null | grep -E "^(PRETTY_NAME|VERSION)" | head -2`,
        `echo "├── KERNEL"`,
        `uname -srm`,
        `echo "├── CPU"`,
        `nproc && grep "model name" /proc/cpuinfo 2>/dev/null | head -1`,
        `echo "├── MEMORY"`,
        `free -h`,
        `echo "├── DISK"`,
        `df -h / 2>/dev/null`,
        `echo "├── UPTIME"`,
        `uptime`,
        `echo "├── NETWORK"`,
        `ip -4 addr show 2>/dev/null | grep "inet " | head -4`,
        `echo "└── USERS"`,
        `who 2>/dev/null || echo "(none)"`,
    ].join(' && '), T_QUICK)
    await reply(sock, from, `💻 SYSINFO — UBUNTU [${elapsed(t)}]`, r.out, msg)
}

async function handleUptime(sock, from, q, msg) {
    await fmt.react(sock, msg, '⏱️')
    const t = Date.now()
    const r = await ubuntu('uptime && echo "" && last reboot 2>/dev/null | head -5', T_QUICK)
    await reply(sock, from, `⏱️ UPTIME [${elapsed(t)}]`, r.out, msg)
}

async function handleFree(sock, from, q, msg) {
    await fmt.react(sock, msg, '💾')
    const t = Date.now()
    const r = await ubuntu('free -h && echo "" && cat /proc/meminfo | grep -E "MemTotal|MemFree|MemAvailable|SwapTotal|SwapFree"', T_QUICK)
    await reply(sock, from, `💾 MEMORY [${elapsed(t)}]`, r.out, msg)
}

async function handleDf(sock, from, q, msg) {
    await fmt.react(sock, msg, '💿')
    const t = Date.now()
    const r = await ubuntu('df -h 2>&1', T_QUICK)
    await reply(sock, from, `💿 DISK SPACE [${elapsed(t)}]`, r.out, msg)
}

async function handleLscpu(sock, from, q, msg) {
    await fmt.react(sock, msg, '🖥️')
    const t = Date.now()
    const r = await ubuntu('lscpu 2>/dev/null | head -30', T_QUICK)
    await reply(sock, from, `🖥️ CPU INFO [${elapsed(t)}]`, r.out, msg)
}

async function handleLsblk(sock, from, q, msg) {
    await fmt.react(sock, msg, '💽')
    const t = Date.now()
    const r = await ubuntu('lsblk 2>&1', T_QUICK)
    await reply(sock, from, `💽 BLOCK DEVICES [${elapsed(t)}]`, r.out, msg)
}

async function handleUname(sock, from, q, msg) {
    await fmt.react(sock, msg, 'ℹ️')
    const t = Date.now()
    const r = await ubuntu('uname -a && echo "" && cat /etc/os-release 2>/dev/null', T_QUICK)
    await reply(sock, from, `ℹ️ UNAME / OS [${elapsed(t)}]`, r.out, msg)
}

async function handleHostname(sock, from, q, msg) {
    await fmt.react(sock, msg, '🏷️')
    const t = Date.now()
    const r = await ubuntu('hostname && hostname -I 2>/dev/null', T_QUICK)
    await reply(sock, from, `🏷️ HOSTNAME [${elapsed(t)}]`, r.out, msg)
}

async function handleWhoami(sock, from, q, msg) {
    await fmt.react(sock, msg, '👤')
    const t = Date.now()
    const r = await ubuntu('whoami && id && echo "" && groups', T_QUICK)
    await reply(sock, from, `👤 WHOAMI [${elapsed(t)}]`, r.out, msg)
}

async function handleDate(sock, from, q, msg) {
    await fmt.react(sock, msg, '📅')
    const t = Date.now()
    const r = await ubuntu('date && echo "" && cal 2>/dev/null', T_QUICK)
    await reply(sock, from, `📅 DATE [${elapsed(t)}]`, r.out, msg)
}

async function handleEnv(sock, from, q, msg) {
    await fmt.react(sock, msg, '🌐')
    const filter = q ? `| grep -i "${q}"` : '| grep -v "SECRET\\|TOKEN\\|KEY\\|PASS"'
    const t = Date.now()
    const r = await ubuntu(`env | sort ${filter} 2>/dev/null | head -60`, T_QUICK)
    await reply(sock, from, `🌐 ENVIRONMENT [${elapsed(t)}]`, r.out, msg)
}

async function handleUsers(sock, from, q, msg) {
    await fmt.react(sock, msg, '👥')
    const t = Date.now()
    const r = await ubuntu('echo "=== System Users ===" && cat /etc/passwd | cut -d: -f1,3,6,7 | sort && echo "" && echo "=== Logged In ===" && who 2>/dev/null || echo "(none)"', T_QUICK)
    await reply(sock, from, `👥 USERS [${elapsed(t)}]`, r.out, msg)
}

// ════════════════════════════════════════════════════════════════════════════════
//  PROCESS MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════════

async function handlePs(sock, from, q, msg) {
    await fmt.react(sock, msg, '⚙️')
    const filter = q ? `| grep -i "${q}"` : '| head -40'
    const t = Date.now()
    const r = await ubuntu(`ps aux --sort=-%cpu ${filter} 2>&1`, T_QUICK)
    await reply(sock, from, q ? `⚙️ PS: ${q} [${elapsed(t)}]` : `⚙️ PROCESSES [${elapsed(t)}]`, r.out, msg)
}

async function handleTop(sock, from, q, msg) {
    await fmt.react(sock, msg, '📊')
    const t = Date.now()
    const r = await ubuntu('ps aux --sort=-%cpu | head -20 2>&1', T_QUICK)
    await reply(sock, from, `📊 TOP PROCESSES [${elapsed(t)}]`, r.out, msg)
}

async function handleKill(sock, from, q, msg) {
    if (!q) return tip(sock, from, '💀 KILL — Kill Process by PID', [
        `*Usage:* ${p()}kill <pid>`,
        `◈ ${p()}kill 1234`,
        `◈ ${p()}kill 5678`,
        ``,
        `_Use ${p()}ps to find the PID first_`,
    ], msg)
    if (!/^\d+$/.test(q.trim())) return tip(sock, from, '💀 KILL', [`PID must be a number. Use ${p()}pkill for names.`], msg)
    await fmt.react(sock, msg, '💀')
    const t = Date.now()
    const r = await ubuntu(`kill -9 ${q} 2>&1 && echo "Sent SIGKILL to PID ${q}"`, T_QUICK)
    await reply(sock, from, `💀 KILL ${q} [${elapsed(t)}]`, r.out, msg)
}

async function handlePkill(sock, from, q, msg) {
    if (!q) return tip(sock, from, '💀 PKILL — Kill Process by Name', [
        `*Usage:* ${p()}pkill <name>`,
        `◈ ${p()}pkill nginx`,
        `◈ ${p()}pkill python3`,
        `◈ ${p()}pkill sleep`,
    ], msg)
    await fmt.react(sock, msg, '💀')
    const t = Date.now()
    const r = await ubuntu(`pkill -9 -f "${q}" 2>&1 && echo "Killed: ${q}" || echo "No process found: ${q}"`, T_QUICK)
    await reply(sock, from, `💀 PKILL: ${q} [${elapsed(t)}]`, r.out, msg)
}

async function handlePgrep(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🔍 PGREP — Find Process PID', [
        `*Usage:* ${p()}pgrep <name>`,
        `◈ ${p()}pgrep nginx`,
        `◈ ${p()}pgrep python`,
    ], msg)
    await fmt.react(sock, msg, '🔍')
    const t = Date.now()
    const r = await ubuntu(`pgrep -a "${q}" 2>&1 || echo "Not found"`, T_QUICK)
    await reply(sock, from, `🔍 PGREP: ${q} [${elapsed(t)}]`, r.out, msg)
}

async function handleJobs(sock, from, q, msg) {
    await fmt.react(sock, msg, '🔄')
    const t = Date.now()
    const r = await ubuntu('jobs -l 2>&1; pgrep -a . 2>/dev/null | head -20', T_QUICK)
    await reply(sock, from, `🔄 JOBS [${elapsed(t)}]`, r.out || '(no background jobs)', msg)
}

// ════════════════════════════════════════════════════════════════════════════════
//  NETWORKING
// ════════════════════════════════════════════════════════════════════════════════

async function handlePing(sock, from, q, msg) {
    if (!q) return tip(sock, from, '📶 PING — Ping a Host', [
        `*Usage:* ${p()}ping <host>`,
        `◈ ${p()}ping google.com`,
        `◈ ${p()}ping 8.8.8.8`,
        `◈ ${p()}ping 192.168.1.1`,
    ], msg)
    await fmt.react(sock, msg, '📶')
    const t = Date.now()
    const r = await ubuntu(`ping -c 5 -W 3 ${q} 2>&1`, T_QUICK)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `📶 PING: ${q} [${elapsed(t)}]`, r.out, msg)
}

async function handleTraceroute(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🗺️ TRACEROUTE — Trace Network Path', [
        `*Usage:* ${p()}traceroute <host>`,
        `◈ ${p()}traceroute google.com`,
        `◈ ${p()}traceroute 8.8.8.8`,
    ], msg)
    await fmt.react(sock, msg, '🗺️')
    await tip(sock, from, '🗺️ TRACING', [`*Target:* ${q}`, `_This may take 30-60s..._`], msg)
    const t = Date.now()
    const r = await ubuntu(`traceroute -m 20 ${q} 2>&1`, T_MED)
    await reply(sock, from, `🗺️ TRACEROUTE: ${q} [${elapsed(t)}]`, r.out, msg)
}

async function handleDig(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🔍 DIG — DNS Lookup', [
        `*Usage:* ${p()}dig <domain> [record type]`,
        `◈ ${p()}dig google.com`,
        `◈ ${p()}dig google.com MX`,
        `◈ ${p()}dig google.com NS`,
        `◈ ${p()}dig google.com TXT`,
        `◈ ${p()}dig @8.8.8.8 example.com A`,
    ], msg)
    await fmt.react(sock, msg, '🔍')
    const parts  = q.trim().split(/\s+/)
    const domain = parts[0], type = parts[1] || 'A'
    const t = Date.now()
    const r = await ubuntu(`dig ${domain} ${type} +noall +answer 2>&1 || nslookup ${domain} 2>&1`, T_QUICK)
    await reply(sock, from, `🔍 DIG: ${domain} [${type}] [${elapsed(t)}]`, r.out, msg)
}

async function handleNslookup(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🔍 NSLOOKUP — DNS Query', [
        `*Usage:* ${p()}nslookup <domain>`,
        `◈ ${p()}nslookup google.com`,
        `◈ ${p()}nslookup 8.8.8.8`,
    ], msg)
    await fmt.react(sock, msg, '🔍')
    const t = Date.now()
    const r = await ubuntu(`nslookup ${q} 2>&1`, T_QUICK)
    await reply(sock, from, `🔍 NSLOOKUP: ${q} [${elapsed(t)}]`, r.out, msg)
}

async function handleWhois(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🌐 WHOIS — Domain Lookup', [
        `*Usage:* ${p()}whois <domain or IP>`,
        `◈ ${p()}whois google.com`,
        `◈ ${p()}whois 8.8.8.8`,
    ], msg)
    await fmt.react(sock, msg, '🌐')
    const t = Date.now()
    const r = await ubuntu(`whois ${q} 2>&1 | head -60`, T_QUICK)
    await reply(sock, from, `🌐 WHOIS: ${q} [${elapsed(t)}]`, r.out, msg)
}

async function handleCurl(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🌐 CURL — HTTP Request', [
        `*Usage:* ${p()}curl <url>`,
        `◈ ${p()}curl https://api.ipify.org`,
        `◈ ${p()}curl https://httpbin.org/ip`,
        `◈ ${p()}curl -I https://google.com           — headers only`,
        `◈ ${p()}curl -X POST https://api.com/endpoint`,
    ], msg)
    if (blocked(q)) return tip(sock, from, '🚫 BLOCKED', ['URL blocked.'], msg)
    await fmt.react(sock, msg, '🌐')
    const t = Date.now()
    const r = await ubuntu(`curl -sL --max-time 20 ${q} 2>&1 | head -200`, T_MED)
    await reply(sock, from, `🌐 CURL [${elapsed(t)}]`, r.out, msg)
}

async function handleNetstat(sock, from, q, msg) {
    await fmt.react(sock, msg, '🌐')
    const t = Date.now()
    const r = await ubuntu('ss -tulnp 2>/dev/null || netstat -tulnp 2>/dev/null', T_QUICK)
    await reply(sock, from, `🌐 NETSTAT [${elapsed(t)}]`, r.out, msg)
}

async function handleSs(sock, from, q, msg) {
    await fmt.react(sock, msg, '🔌')
    const args = q || '-tulnp'
    const t = Date.now()
    const r = await ubuntu(`ss ${args} 2>&1`, T_QUICK)
    await reply(sock, from, `🔌 SS [${elapsed(t)}]`, r.out, msg)
}

async function handleIfconfig(sock, from, q, msg) {
    await fmt.react(sock, msg, '📡')
    const t = Date.now()
    const r = await ubuntu('ifconfig 2>/dev/null || ip addr show 2>/dev/null', T_QUICK)
    await reply(sock, from, `📡 IFCONFIG [${elapsed(t)}]`, r.out, msg)
}

async function handleIp(sock, from, q, msg) {
    await fmt.react(sock, msg, '📡')
    const args = q || 'addr show'
    const t = Date.now()
    const r = await ubuntu(`ip ${args} 2>&1`, T_QUICK)
    await reply(sock, from, `📡 IP [${elapsed(t)}]`, r.out, msg)
}

async function handleArp(sock, from, q, msg) {
    await fmt.react(sock, msg, '📡')
    const t = Date.now()
    const r = await ubuntu('arp -n 2>/dev/null || ip neigh show 2>/dev/null', T_QUICK)
    await reply(sock, from, `📡 ARP TABLE [${elapsed(t)}]`, r.out, msg)
}

async function handleMyip(sock, from, q, msg) {
    await fmt.react(sock, msg, '📡')
    const t = Date.now()
    const [pub, local] = await Promise.all([
        ubuntu('curl -s --max-time 10 https://api.ipify.org 2>/dev/null || curl -s --max-time 10 https://icanhazip.com 2>/dev/null', T_QUICK),
        ubuntu('hostname -I 2>/dev/null || ip -4 addr show | grep "inet " | awk "{print $2}" | head -5', T_QUICK),
    ])
    await reply(sock, from, `📡 MY IP [${elapsed(t)}]`, [
        `*Public IP:*  ${pub.out.trim()}`,
        `*Local IPs:*  ${local.out.trim()}`,
    ].join('\n'), msg)
}

// ════════════════════════════════════════════════════════════════════════════════
//  PACKAGE MANAGEMENT — APT (Ubuntu)
// ════════════════════════════════════════════════════════════════════════════════

async function handleApt(sock, from, q, msg) {
    const args   = (q || '').trim().split(/\s+/)
    const sub    = (args[0] || '').toLowerCase()
    const target = args.slice(1).join(' ')

    if (!sub) return tip(sock, from, '📦 APT — Ubuntu Package Manager', [
        `◈ ${p()}apt update              — refresh package list`,
        `◈ ${p()}apt upgrade             — upgrade all packages`,
        `◈ ${p()}apt install <name>      — install a package`,
        `◈ ${p()}apt remove <name>       — remove a package`,
        `◈ ${p()}apt search <query>      — search packages`,
        `◈ ${p()}apt list               — list installed`,
        `◈ ${p()}apt info <name>         — package details`,
        `◈ ${p()}apt autoremove          — clean unused deps`,
    ], msg)

    switch (sub) {
        case 'update': {
            await fmt.react(sock, msg, '🔄')
            await tip(sock, from, '📦 APT UPDATE', [`_Refreshing package list..._`], msg)
            const r = await ubuntu('apt-get update 2>&1', T_LONG)
            await fmt.react(sock, msg, '✅')
            return reply(sock, from, '📦 APT UPDATE', r.out, msg)
        }
        case 'upgrade': {
            await fmt.react(sock, msg, '⬆️')
            await tip(sock, from, '📦 APT UPGRADE', [`_Upgrading packages..._`], msg)
            const r = await ubuntu('DEBIAN_FRONTEND=noninteractive apt-get upgrade -y 2>&1', T_LONG)
            await fmt.react(sock, msg, r.ok ? '✅' : '⚠️')
            return reply(sock, from, '📦 APT UPGRADE', r.out, msg)
        }
        case 'install': {
            if (!target) return tip(sock, from, '📦 APT INSTALL', [`*Usage:* ${p()}apt install <package>`, `*Example:* ${p()}apt install python3`], msg)
            await fmt.react(sock, msg, '⬇️')
            await tip(sock, from, '📦 INSTALLING', [`*Package:* ${target}`, `_Please wait..._`], msg)
            const r = await ubuntu(`DEBIAN_FRONTEND=noninteractive apt-get install -y ${target} 2>&1`, T_LONG)
            await fmt.react(sock, msg, r.ok ? '✅' : '❌')
            return reply(sock, from, `📦 INSTALL: ${target}`, r.out, msg)
        }
        case 'remove': {
            if (!target) return tip(sock, from, '📦 APT REMOVE', [`*Usage:* ${p()}apt remove <package>`], msg)
            await fmt.react(sock, msg, '🗑️')
            const r = await ubuntu(`DEBIAN_FRONTEND=noninteractive apt-get remove -y ${target} 2>&1`, T_LONG)
            await fmt.react(sock, msg, r.ok ? '✅' : '❌')
            return reply(sock, from, `📦 REMOVE: ${target}`, r.out, msg)
        }
        case 'search': {
            if (!target) return tip(sock, from, '📦 APT SEARCH', [`*Usage:* ${p()}apt search <query>`], msg)
            await fmt.react(sock, msg, '🔍')
            const r = await ubuntu(`apt-cache search ${target} 2>&1 | head -50`, T_QUICK)
            return reply(sock, from, `🔍 APT SEARCH: ${target}`, r.out || '(no results)', msg)
        }
        case 'list': {
            await fmt.react(sock, msg, '📋')
            const r = await ubuntu('apt list --installed 2>/dev/null | head -80', T_QUICK)
            return reply(sock, from, '📋 APT INSTALLED', r.out, msg)
        }
        case 'info': {
            if (!target) return tip(sock, from, '📦 APT INFO', [`*Usage:* ${p()}apt info <package>`], msg)
            await fmt.react(sock, msg, 'ℹ️')
            const r = await ubuntu(`apt-cache show ${target} 2>&1 | head -40`, T_QUICK)
            return reply(sock, from, `ℹ️ APT INFO: ${target}`, r.out, msg)
        }
        case 'autoremove': {
            await fmt.react(sock, msg, '🧹')
            const r = await ubuntu('DEBIAN_FRONTEND=noninteractive apt-get autoremove -y 2>&1', T_LONG)
            await fmt.react(sock, msg, '✅')
            return reply(sock, from, '🧹 APT AUTOREMOVE', r.out, msg)
        }
        default:
            return tip(sock, from, '📦 APT', [`Unknown command: *${sub}*`, ``, `Use *${p()}apt* to see all options`], msg)
    }
}

// ════════════════════════════════════════════════════════════════════════════════
//  PACKAGE MANAGEMENT — Termux host
// ════════════════════════════════════════════════════════════════════════════════

async function handleTpkg(sock, from, q, msg) {
    const args   = (q || '').trim().split(/\s+/)
    const sub    = (args[0] || '').toLowerCase()
    const target = args.slice(1).join(' ')

    if (!sub) return tip(sock, from, '📱 TPKG — Termux Package Manager', [
        `◈ ${p()}tpkg update             — update packages`,
        `◈ ${p()}tpkg install <name>     — install package`,
        `◈ ${p()}tpkg remove <name>      — remove package`,
        `◈ ${p()}tpkg search <query>     — search packages`,
        `◈ ${p()}tpkg list              — list installed`,
    ], msg)

    switch (sub) {
        case 'update': {
            await fmt.react(sock, msg, '🔄')
            const r = await run('pkg update -y 2>&1', T_LONG)
            return reply(sock, from, '📱 TERMUX UPDATE', r.out, msg)
        }
        case 'install': {
            if (!target) return tip(sock, from, '📱 TPKG INSTALL', [`*Usage:* ${p()}tpkg install <name>`], msg)
            await fmt.react(sock, msg, '⬇️')
            const r = await run(`pkg install -y ${target} 2>&1`, T_LONG)
            await fmt.react(sock, msg, r.ok ? '✅' : '❌')
            return reply(sock, from, `📱 TPKG INSTALL: ${target}`, r.out, msg)
        }
        case 'remove': {
            if (!target) return tip(sock, from, '📱 TPKG REMOVE', [`*Usage:* ${p()}tpkg remove <name>`], msg)
            const r = await run(`pkg remove -y ${target} 2>&1`, T_LONG)
            await fmt.react(sock, msg, r.ok ? '✅' : '❌')
            return reply(sock, from, `📱 TPKG REMOVE: ${target}`, r.out, msg)
        }
        case 'search': {
            if (!target) return tip(sock, from, '📱 TPKG SEARCH', [`*Usage:* ${p()}tpkg search <name>`], msg)
            const r = await run(`pkg search ${target} 2>&1 | head -40`, T_QUICK)
            return reply(sock, from, `🔍 TPKG SEARCH: ${target}`, r.out || '(no results)', msg)
        }
        case 'list': {
            const r = await run('pkg list-installed 2>&1 | head -60', T_QUICK)
            return reply(sock, from, '📱 TERMUX PACKAGES', r.out, msg)
        }
        default:
            return tip(sock, from, '📱 TPKG', [`Unknown sub-command: *${sub}*`], msg)
    }
}

// ════════════════════════════════════════════════════════════════════════════════
//  .uinstall — Install any Ubuntu/Termux package directly from WhatsApp
// ════════════════════════════════════════════════════════════════════════════════
//
//  Usage:  .uinstall <package>           — apt install in Ubuntu
//          .uinstall update              — apt-get update
//          .uinstall upgrade             — apt-get upgrade
//          .uinstall search <query>      — search Ubuntu repos
//          .uinstall tpkg <pkg>          — install via Termux pkg instead

// Allowlist: only valid Debian package name characters — prevents all shell injection
function sanitizePkg(name) {
    return name.replace(/[^a-zA-Z0-9.\-+_]/g, '').slice(0, 80)
}

async function handleUbuntuInstall(sock, from, q, msg) {
    if (!q) return tip(sock, from, '📦 UINSTALL — Install Ubuntu Packages', [
        `*Usage:* ${p()}uinstall <package>`,
        ``,
        `*Examples:*`,
        `◈ ${p()}uinstall curl             — install curl`,
        `◈ ${p()}uinstall python3-pip      — install pip`,
        `◈ ${p()}uinstall nodejs npm       — install Node.js`,
        `◈ ${p()}uinstall ffmpeg           — media processor`,
        `◈ ${p()}uinstall update           — update package lists`,
        `◈ ${p()}uinstall upgrade          — upgrade all packages`,
        `◈ ${p()}uinstall search <query>   — search Ubuntu repos`,
        `◈ ${p()}uinstall tpkg <pkg>       — install via Termux pkg`,
        ``,
        `_Installs run in your Ubuntu proot container._`,
    ], msg)

    const parts = q.trim().split(/\s+/)
    const sub   = parts[0].toLowerCase()

    if (sub === 'update') {
        await fmt.react(sock, msg, '⏳')
        await sock.sendMessage(from, { text: fmt.box('🔄 UBUNTU UPDATE', ['_Updating package lists..._']) }, { quoted: msg })
        const t = Date.now()
        const r = await ubuntu('apt-get update 2>&1', T_MED)
        await fmt.react(sock, msg, '✅')
        return reply(sock, from, `🔄 UBUNTU UPDATE [${elapsed(t)}]`, r.out, msg)
    }

    if (sub === 'upgrade') {
        await fmt.react(sock, msg, '⏳')
        await sock.sendMessage(from, { text: fmt.box('⬆️ UBUNTU UPGRADE', ['_Upgrading all packages..._', '_This may take a few minutes._']) }, { quoted: msg })
        const t = Date.now()
        const r = await ubuntu('DEBIAN_FRONTEND=noninteractive apt-get upgrade -y 2>&1', T_LONG)
        await fmt.react(sock, msg, '✅')
        return reply(sock, from, `⬆️ UBUNTU UPGRADE [${elapsed(t)}]`, r.out, msg)
    }

    if (sub === 'search') {
        const rawQuery = parts.slice(1).join(' ')
        if (!rawQuery) return tip(sock, from, '🔍 UINSTALL SEARCH', [`*Usage:* ${p()}uinstall search <package-name>`], msg)
        const query = sanitizePkg(rawQuery)
        if (!query) return tip(sock, from, '❌ INVALID', ['Package name contains invalid characters.'], msg)
        await fmt.react(sock, msg, '⏳')
        const r = await ubuntu(`apt-cache search ${query} 2>&1 | head -40`, T_QUICK)
        await fmt.react(sock, msg, '✅')
        return reply(sock, from, `🔍 UBUNTU SEARCH: ${query}`, r.out || '(no results)', msg)
    }

    if (sub === 'tpkg') {
        const rawPkgs = parts.slice(1).map(sanitizePkg).filter(Boolean)
        if (!rawPkgs.length) return tip(sock, from, '📱 UINSTALL TPKG', [`*Usage:* ${p()}uinstall tpkg <package>`], msg)
        const pkg = rawPkgs.join(' ')
        await fmt.react(sock, msg, '⏳')
        await sock.sendMessage(from, { text: fmt.box('📱 TERMUX INSTALL', [`Installing *${pkg}* via pkg...`]) }, { quoted: msg })
        const t = Date.now()
        const r = await run(`pkg install -y ${pkg} 2>&1`, T_LONG)
        await fmt.react(sock, msg, '✅')
        return reply(sock, from, `📱 TPKG INSTALL: ${pkg} [${elapsed(t)}]`, r.out, msg)
    }

    // Normal Ubuntu apt install — sanitize ALL package tokens
    const cleanPkgs = parts.map(sanitizePkg).filter(Boolean)
    if (!cleanPkgs.length) {
        return tip(sock, from, '❌ INVALID PACKAGE NAME', [
            'Package names can only contain letters, digits, hyphens, dots, and plus signs.',
            `Example: ${p()}uinstall curl`,
        ], msg)
    }
    const pkgs = cleanPkgs.join(' ')
    await fmt.react(sock, msg, '⏳')
    await sock.sendMessage(from, {
        text: fmt.box('📦 UBUNTU INSTALL', [
            `Installing *${pkgs}* in Ubuntu container...`,
            `_Large packages may take 1–3 minutes._`,
        ])
    }, { quoted: msg })
    const t = Date.now()
    const r = await ubuntu(`DEBIAN_FRONTEND=noninteractive apt-get install -y ${pkgs} 2>&1`, T_LONG)
    const success = r.out.includes('newly installed') || r.out.includes('already the newest') || r.out.includes('is already installed')
    await fmt.react(sock, msg, success ? '✅' : '⚠️')
    return reply(sock, from, `📦 UBUNTU INSTALL: ${pkgs} [${elapsed(t)}]`, r.out, msg)
}

module.exports = {
    // Files
    handleLs, handleCat, handleHead, handleTail, handleMkdir,
    handleRmfile, handleCpfile, handleMvfile, handleTouch,
    handleChmod, handleChown, handleFind, handleGrep,
    handleDu, handleStat, handleWc, handleSortfile, handleUniq, handleDiff,
    // Archives
    handleExtract, handleZipfile, handleGzip, handleGunzip,
    // Download
    handleWget, handleCurlget,
    // System info
    handleSysinfo, handleUptime, handleFree, handleDf,
    handleLscpu, handleLsblk, handleUname, handleHostname,
    handleWhoami, handleDate, handleEnv, handleUsers,
    // Processes
    handlePs, handleTop, handleKill, handlePkill, handlePgrep, handleJobs,
    // Network
    handlePing, handleTraceroute, handleDig, handleNslookup,
    handleWhois, handleCurl, handleNetstat, handleSs,
    handleIfconfig, handleIp, handleArp, handleMyip,
    // Packages
    handleApt, handleTpkg,
    // Install helpers
    handleUbuntuInstall,
}
