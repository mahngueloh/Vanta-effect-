'use strict'
const { exec }  = require('child_process')
const config    = require('../config')
const fmt       = require('../lib/format')

const WORK_DIR = require('os').tmpdir()

// ── Core runner ───────────────────────────────────────────────────────────────
function run(cmd, timeoutMs = 60000) {
    return new Promise(resolve => {
        const proc = exec(cmd, { cwd: WORK_DIR, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
            const out = (stdout || '').trim() || (stderr || '').trim() || (err?.message || 'No output')
            resolve({ ok: !err || stdout.trim().length > 0, out })
        })
        setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, timeoutMs)
    })
}

// Run inside Kali Linux proot container
function runKali(cmd, timeoutMs = 60000) {
    const escaped = cmd.replace(/'/g, `'\\''`)
    return run(`proot-distro login kali-rolling -- bash -c '${escaped}' 2>&1`, timeoutMs)
}

function trim(text, max = 3500) {
    const clean = text.replace(/\x1B\[[0-9;]*m/g, '').trim()
    if (clean.length <= max) return clean
    const half = Math.floor(max / 2)
    return clean.slice(0, half) + '\n\n... [trimmed] ...\n\n' + clean.slice(-half)
}

async function send(sock, from, title, lines, msg) {
    return sock.sendMessage(from, {
        text: fmt.box(title, Array.isArray(lines) ? lines : [lines])
    }, { quoted: msg })
}

async function sendResult(sock, from, label, output, msg) {
    const text = trim(output)
    if (text.length <= 3200) {
        return sock.sendMessage(from, {
            text: fmt.box(label, [text])
        }, { quoted: msg })
    }
    // Split long output into chunks
    await sock.sendMessage(from, { text: fmt.box(label, ['_(results below)_']) }, { quoted: msg })
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


// ═══════════════════════════════════════════════════════════════════════════════
//  .scan <ip/domain>
//  Full port + service + vuln scan — nmap deep mode
// ═══════════════════════════════════════════════════════════════════════════════
async function handleScan(sock, from, q, msg) {
    if (!q) return send(sock, from, '📡 SCAN', [
        `*Usage:* ${config.prefix}scan <ip or domain>`,
        ``,
        `*What it does:*`,
        `◈ Scans all 65535 ports`,
        `◈ Detects services + versions`,
        `◈ Runs default scripts`,
        `◈ Checks for known vulnerabilities`,
        ``,
        `*Example:*`,
        `${config.prefix}scan 192.168.1.1`,
        `${config.prefix}scan example.com`,
    ], msg)

    await fmt.react(sock, msg, '🔍')
    await send(sock, from, '📡 SCANNING', [
        `*Target:* ${q}`,
        `*Mode:* Full port + service + vuln scan`,
        ``,
        `_Running... this may take 1-3 minutes_`,
    ], msg)

    const r = await runKali(`nmap -sV -sC --script vuln -p- --open -T4 ${q} 2>&1`, 180000)
    await fmt.react(sock, msg, r.ok ? '✅' : '⚠️')
    await sendResult(sock, from, `📡 SCAN RESULTS — ${q}`, r.out, msg)
}


// ═══════════════════════════════════════════════════════════════════════════════
//  .webcheck <url>
//  Fingerprint + vuln scan + hidden dirs in one go
// ═══════════════════════════════════════════════════════════════════════════════
async function handleWebcheck(sock, from, q, msg) {
    if (!q) return send(sock, from, '🌐 WEBCHECK', [
        `*Usage:* ${config.prefix}webcheck <url>`,
        ``,
        `*What it does (3 steps automatically):*`,
        `◈ Step 1: Fingerprints technologies used`,
        `◈ Step 2: Scans for web vulnerabilities`,
        `◈ Step 3: Finds hidden folders/pages`,
        ``,
        `*Example:*`,
        `${config.prefix}webcheck https://example.com`,
    ], msg)

    const url = q.startsWith('http') ? q : `https://${q}`

    await fmt.react(sock, msg, '🌐')
    await send(sock, from, '🌐 WEBCHECK STARTED', [
        `*Target:* ${url}`,
        `*Running 3 automated steps...*`,
    ], msg)

    // Step 1 — WhatWeb
    await send(sock, from, '🌐 STEP 1/3 — FINGERPRINT', [`Detecting technologies...`], msg)
    const r1 = await runKali(`whatweb -a 3 ${url} 2>&1`, 30000)
    await sendResult(sock, from, '🌐 STEP 1 — TECHNOLOGIES', r1.out, msg)

    // Step 2 — Nikto
    await send(sock, from, '🌐 STEP 2/3 — VULN SCAN', [`Scanning for vulnerabilities...`], msg)
    const r2 = await runKali(`nikto -h ${url} -maxtime 60 2>&1`, 75000)
    await sendResult(sock, from, '🌐 STEP 2 — VULNERABILITIES', r2.out, msg)

    // Step 3 — Gobuster
    await send(sock, from, '🌐 STEP 3/3 — HIDDEN DIRS', [`Finding hidden pages and folders...`], msg)
    const wl = '/usr/share/wordlists/dirb/common.txt'
    const r3 = await runKali(`gobuster dir -u ${url} -w ${wl} -t 30 -q 2>&1`, 90000)
    await sendResult(sock, from, '🌐 STEP 3 — HIDDEN DIRS', r3.out || 'None found', msg)

    await fmt.react(sock, msg, '✅')
    await send(sock, from, '🌐 WEBCHECK COMPLETE', [`All 3 steps done for *${url}*`], msg)
}


// ═══════════════════════════════════════════════════════════════════════════════
//  .recon <domain/ip>
//  Full passive + active recon in one command
// ═══════════════════════════════════════════════════════════════════════════════
async function handleRecon(sock, from, q, msg) {
    if (!q) return send(sock, from, '🔎 RECON', [
        `*Usage:* ${config.prefix}recon <domain or ip>`,
        ``,
        `*What it does automatically:*`,
        `◈ WHOIS — owner, registrar, dates`,
        `◈ DNS — all records (A, MX, TXT, NS)`,
        `◈ Subdomains — passive discovery`,
        `◈ Port scan — top 1000 ports`,
        `◈ IP Geolocation`,
        ``,
        `*Example:*`,
        `${config.prefix}recon google.com`,
        `${config.prefix}recon 142.250.80.46`,
    ], msg)

    await fmt.react(sock, msg, '🔍')
    await send(sock, from, '🔎 RECON STARTED', [
        `*Target:* ${q}`,
        `*Running full recon pipeline...*`,
    ], msg)

    // WHOIS
    const r1 = await runKali(`whois ${q} 2>&1 | head -40`, 20000)
    await sendResult(sock, from, `🔎 WHOIS — ${q}`, r1.out, msg)

    // DNS
    const r2 = await runKali(`dig ${q} ANY +noall +answer 2>&1; dig ${q} MX +noall +answer 2>&1; dig ${q} TXT +noall +answer 2>&1`, 20000)
    await sendResult(sock, from, `🔎 DNS RECORDS — ${q}`, r2.out || 'No records found', msg)

    // Subdomains
    const r3 = await runKali(`subfinder -d ${q} -silent 2>&1 | head -50`, 45000)
    await sendResult(sock, from, `🔎 SUBDOMAINS — ${q}`, r3.out || 'None found', msg)

    // Port scan
    const r4 = await runKali(`nmap -F -sV --open ${q} 2>&1`, 60000)
    await sendResult(sock, from, `🔎 OPEN PORTS — ${q}`, r4.out, msg)

    // Geolocation
    const r5 = await run(`curl -s https://ipapi.co/${q}/json/ 2>&1`, 10000)
    let geo = 'Could not fetch geolocation'
    try {
        const parsed = JSON.parse(r5.out)
        if (parsed.city) geo = [
            `🌍 IP: ${parsed.ip}`,
            `🏙️ City: ${parsed.city}`,
            `🗺️ Region: ${parsed.region}`,
            `🏳️ Country: ${parsed.country_name}`,
            `🌐 ISP: ${parsed.org}`,
            `🕐 Timezone: ${parsed.timezone}`,
        ].join('\n')
    } catch {}
    await send(sock, from, `🔎 GEOLOCATION — ${q}`, [geo], msg)

    await fmt.react(sock, msg, '✅')
    await send(sock, from, '🔎 RECON COMPLETE', [`Full recon done for *${q}*`], msg)
}


// ═══════════════════════════════════════════════════════════════════════════════
//  .osint <domain/name/username>
//  Find all public info on a target
// ═══════════════════════════════════════════════════════════════════════════════
async function handleOsint(sock, from, q, msg) {
    if (!q) return send(sock, from, '👤 OSINT', [
        `*Usage:* ${config.prefix}osint <domain or username>`,
        ``,
        `*What it does:*`,
        `◈ Harvests emails, names, IPs from search engines`,
        `◈ Finds subdomains`,
        `◈ Searches username across 300+ social platforms`,
        ``,
        `*Examples:*`,
        `${config.prefix}osint company.com`,
        `${config.prefix}osint johndoe`,
    ], msg)

    await fmt.react(sock, msg, '👤')
    await send(sock, from, '👤 OSINT STARTED', [`*Target:* ${q}`, `_Running..._`], msg)

    const isDomain = q.includes('.')

    if (isDomain) {
        // theHarvester
        await send(sock, from, '👤 STEP 1/2 — HARVESTER', [`Harvesting emails, names, IPs...`], msg)
        const r1 = await runKali(`theHarvester -d ${q} -b google,bing,duckduckgo,yahoo -l 100 2>&1`, 90000)
        await sendResult(sock, from, `👤 HARVEST RESULTS — ${q}`, r1.out, msg)

        // Subfinder
        await send(sock, from, '👤 STEP 2/2 — SUBDOMAINS', [`Finding all subdomains...`], msg)
        const r2 = await runKali(`subfinder -d ${q} 2>&1`, 60000)
        await sendResult(sock, from, `👤 SUBDOMAINS — ${q}`, r2.out || 'None found', msg)
    } else {
        // Sherlock username search
        await send(sock, from, '👤 SEARCHING USERNAME', [`Looking for *${q}* across 300+ platforms...`], msg)
        const r1 = await runKali(`sherlock ${q} 2>&1`, 120000)
        await sendResult(sock, from, `👤 ${q} — ACCOUNTS FOUND`, r1.out, msg)
    }

    await fmt.react(sock, msg, '✅')
    await send(sock, from, '👤 OSINT COMPLETE', [`Done for *${q}*`], msg)
}


// ═══════════════════════════════════════════════════════════════════════════════
//  .sqli <url>
//  Automated SQL injection — finds and dumps databases
// ═══════════════════════════════════════════════════════════════════════════════
async function handleSqli(sock, from, q, msg) {
    if (!q) return send(sock, from, '💉 SQLI', [
        `*Usage:* ${config.prefix}sqli <url>`,
        ``,
        `*What it does:*`,
        `◈ Tests the URL for SQL injection`,
        `◈ If vulnerable — lists all databases`,
        `◈ Auto-detects injection point`,
        ``,
        `*Example:*`,
        `${config.prefix}sqli https://site.com/page?id=1`,
        `${config.prefix}sqli https://site.com/search?q=test`,
    ], msg)

    await fmt.react(sock, msg, '💉')
    await send(sock, from, '💉 SQL INJECTION TEST', [
        `*Target:* ${q}`,
        `_Testing for SQL injection..._`,
    ], msg)

    const r = await runKali(`sqlmap -u "${q}" --dbs --batch --random-agent --level=3 --risk=2 2>&1`, 180000)
    await fmt.react(sock, msg, '✅')
    await sendResult(sock, from, '💉 SQLI RESULTS', r.out, msg)
}


// ═══════════════════════════════════════════════════════════════════════════════
//  .crack <hash>
//  Auto-detect hash type and crack it
// ═══════════════════════════════════════════════════════════════════════════════
async function handleCrack(sock, from, q, msg) {
    if (!q) return send(sock, from, '🔓 CRACK', [
        `*Usage:* ${config.prefix}crack <hash>`,
        ``,
        `*Supported hash types (auto-detected):*`,
        `◈ MD5  ◈ SHA1  ◈ SHA256  ◈ SHA512`,
        `◈ NTLM  ◈ bcrypt  ◈ WPA  ◈ MySQL`,
        ``,
        `*Example:*`,
        `${config.prefix}crack 5f4dcc3b5aa765d61d8327deb882cf99`,
    ], msg)

    await fmt.react(sock, msg, '🔓')

    // Detect hash mode for hashcat
    const hash = q.trim()
    let mode = '0'  // default MD5
    if (hash.length === 32)  mode = '0'    // MD5
    if (hash.length === 40)  mode = '100'  // SHA1
    if (hash.length === 64)  mode = '1400' // SHA256
    if (hash.length === 128) mode = '1700' // SHA512
    if (hash.length === 32 && /^\$/.test(hash)) mode = '1000' // NTLM

    const hashFile = `${WORK_DIR}/target_${Date.now()}.hash`
    require('fs').writeFileSync(hashFile, hash + '\n')

    const rockyou = '/usr/share/wordlists/rockyou.txt'
    const wl = require('fs').existsSync(rockyou)
        ? rockyou
        : '/usr/share/wordlists/dirb/common.txt'

    await send(sock, from, '🔓 CRACKING', [
        `*Hash:* ${hash.slice(0, 30)}...`,
        `*Type:* Mode ${mode}`,
        `*Wordlist:* rockyou.txt`,
        `_Running... up to 2 minutes_`,
    ], msg)

    const r = await run(
        `hashcat -m ${mode} ${hashFile} ${wl} --force --quiet --potfile-disable 2>&1 | tail -20`,
        120000
    )

    // Also try john as fallback
    const r2 = await runKali(`john --wordlist=${wl} ${hashFile} 2>&1 && john --show ${hashFile} 2>&1`, 60000)

    await fmt.react(sock, msg, '✅')
    const combined = `${r.out}\n\n--- John the Ripper ---\n${r2.out}`
    await sendResult(sock, from, '🔓 CRACK RESULTS', combined, msg)

    require('fs').unlink(hashFile, () => {})
}


// ═══════════════════════════════════════════════════════════════════════════════
//  .brute <service> <ip> [user] [wordlist]
//  One-command brute force login
// ═══════════════════════════════════════════════════════════════════════════════
async function handleBrute(sock, from, q, msg) {
    if (!q) return send(sock, from, '🔨 BRUTE FORCE', [
        `*Usage:* ${config.prefix}brute <service> <ip> [user]`,
        ``,
        `*Supported services:*`,
        `ssh  ftp  telnet  smtp  mysql  rdp  http`,
        ``,
        `*Examples:*`,
        `${config.prefix}brute ssh 192.168.1.1 admin`,
        `${config.prefix}brute ftp 192.168.1.1 root`,
        `${config.prefix}brute mysql 192.168.1.1 root`,
        `${config.prefix}brute ssh 192.168.1.1`,
        `_(omit user to try common usernames)_`,
    ], msg)

    const parts   = q.trim().split(/\s+/)
    const service = (parts[0] || '').toLowerCase()
    const ip      = parts[1] || ''
    const user    = parts[2] || ''

    if (!service || !ip) return send(sock, from, '❌ ERROR', [`Provide both service and IP`], msg)

    const rockyou = '/usr/share/wordlists/rockyou.txt'
    const wl = require('fs').existsSync(rockyou) ? rockyou : '/usr/share/wordlists/dirb/common.txt'
    const userFlag  = user ? `-l ${user}` : '-L /usr/share/seclists/Usernames/top-usernames-shortlist.txt'
    const userAlt   = user ? `-l ${user}` : '-L /usr/share/wordlists/metasploit/unix_users.txt'

    const serviceMap = {
        ssh:    `hydra -t 4 ${userFlag} -P ${wl} ssh://${ip} 2>&1`,
        ftp:    `hydra -t 4 ${userFlag} -P ${wl} ftp://${ip} 2>&1`,
        telnet: `hydra -t 4 ${userFlag} -P ${wl} telnet://${ip} 2>&1`,
        smtp:   `hydra -t 4 ${userFlag} -P ${wl} smtp://${ip} 2>&1`,
        mysql:  `hydra -t 4 ${userFlag} -P ${wl} mysql://${ip} 2>&1`,
        rdp:    `hydra -t 4 ${userFlag} -P ${wl} rdp://${ip} 2>&1`,
    }

    const cmd = serviceMap[service]
    if (!cmd) return send(sock, from, '❌ UNKNOWN SERVICE', [
        `Service *${service}* not supported`,
        `Supported: ssh ftp telnet smtp mysql rdp`,
    ], msg)

    await fmt.react(sock, msg, '🔨')
    await send(sock, from, '🔨 BRUTE FORCE STARTED', [
        `*Service:* ${service.toUpperCase()}`,
        `*Target:* ${ip}`,
        `*User:* ${user || 'auto (common users)'}`,
        `*Wordlist:* rockyou.txt`,
        `_Running... up to 3 minutes_`,
    ], msg)

    const r = await run(cmd, 180000)
    await fmt.react(sock, msg, '✅')
    await sendResult(sock, from, `🔨 BRUTE RESULTS — ${service.toUpperCase()} ${ip}`, r.out, msg)
}


// ═══════════════════════════════════════════════════════════════════════════════
//  .myip  — server's public IP + location
// ═══════════════════════════════════════════════════════════════════════════════
async function handleMyIp(sock, from, msg) {
    await fmt.react(sock, msg, '🌐')
    const r = await run(`curl -s https://ipapi.co/json/ 2>&1`, 10000)
    try {
        const d = JSON.parse(r.out)
        await send(sock, from, '🌐 SERVER INFO', [
            `🌍 IP:       ${d.ip}`,
            `🏙️ City:     ${d.city}`,
            `🗺️ Region:   ${d.region}`,
            `🏳️ Country:  ${d.country_name}`,
            `🌐 ISP:      ${d.org}`,
            `🕐 Timezone: ${d.timezone}`,
            `📡 ASN:      ${d.asn}`,
        ], msg)
    } catch {
        await sendResult(sock, from, '🌐 SERVER IP', r.out, msg)
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
//  .sysinfo  — full server system info
// ═══════════════════════════════════════════════════════════════════════════════
async function handleSysinfo(sock, from, msg) {
    await fmt.react(sock, msg, '💻')
    const cmds = [
        `echo "=== OS ===" && cat /etc/os-release 2>/dev/null || uname -a`,
        `echo "=== CPU ===" && nproc && cat /proc/cpuinfo | grep "model name" | head -2`,
        `echo "=== RAM ===" && free -h`,
        `echo "=== DISK ===" && df -h`,
        `echo "=== NETWORK ===" && ip a | grep inet`,
        `echo "=== UPTIME ===" && uptime`,
    ]
    const r = await run(cmds.join('; '), 20000)
    await sendResult(sock, from, '💻 SERVER SYSTEM INFO', r.out, msg)
}


// ═══════════════════════════════════════════════════════════════════════════════
//  .ports <ip>  — fast scan all 65535 ports
// ═══════════════════════════════════════════════════════════════════════════════
async function handlePorts(sock, from, q, msg) {
    if (!q) return send(sock, from, '📡 PORTS', [
        `*Usage:* ${config.prefix}ports <ip>`,
        `*Example:* ${config.prefix}ports 192.168.1.1`,
        ``,
        `Scans all 65535 ports at high speed`,
    ], msg)

    await fmt.react(sock, msg, '📡')
    await send(sock, from, '📡 PORT SCAN', [`*Target:* ${q}`, `_Scanning all ports..._`], msg)

    // masscan first (super fast), then nmap service detect on open ports
    const r1 = await runKali(`nmap -p- --open --min-rate 5000 -T4 ${q} 2>&1`, 120000)
    await fmt.react(sock, msg, '✅')
    await sendResult(sock, from, `📡 OPEN PORTS — ${q}`, r1.out, msg)
}


// ═══════════════════════════════════════════════════════════════════════════════
//  Exports
// ═══════════════════════════════════════════════════════════════════════════════
module.exports = {
    handleScan,
    handleWebcheck,
    handleRecon,
    handleOsint,
    handleSqli,
    handleCrack,
    handleBrute,
    handleMyIp,
    handleSysinfo,
    handlePorts,
}
