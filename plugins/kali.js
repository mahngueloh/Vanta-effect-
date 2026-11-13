'use strict'
/**
 * kali.js — Kali Linux tool runner for MAHNGUELOH VANTA
 *
 * .kali <tool> [args]   — Run any Kali tool (with auto-install if missing)
 * .tools                — Show all available/installed tools
 * .toolinstall <name>   — Force install a specific tool
 * .searchsploit <query> — Search ExploitDB
 * .msfuse <module>      — Run a Metasploit module (info only)
 */

const { exec }  = require('child_process')
const config    = require('../config')
const fmt       = require('../lib/format')
const os        = require('os')

const TIMEOUT_MS     = 60000
const TIMEOUT_LONG   = 180000
const MAX_OUT_CHARS  = 3500
const WORK_DIR       = os.tmpdir()

// ── Destructive blocklist ─────────────────────────────────────────────────────
const BLOCKED = [
    /\brm\s+-rf\s+\/\b/i,
    /\bshutdown\b/i,
    /\breboot\b/i,
    /\binit\s+0\b/i,
    /\bmkfs\b/i,
    /\bdd\s+if=.*of=\/dev\//i,
    /\bchmod\s+777\s+\/\b/i,
    /\bwipefs\b/i,
    /\bformat\b/i,
    /\bcat\s+\/etc\/shadow\b/i,
    /\bpasswd\b/i,
    /\bsudo\s+su\b/i,
    />\s*\/dev\/sd/i,
]

// ── Tool registry — name → { check, install, desc, category } ─────────────────
const TOOLS = {
    // ── RECONNAISSANCE ─────────────────────────────────────────────────────────
    nmap:         { check: 'nmap',         install: 'nmap',            desc: 'Network/port scanner',          cat: 'recon' },
    masscan:      { check: 'masscan',      install: 'masscan',         desc: 'Fast port scanner',             cat: 'recon' },
    unicornscan:  { check: 'unicornscan',  install: 'unicornscan',     desc: 'UDP/TCP scanner',               cat: 'recon' },
    traceroute:   { check: 'traceroute',   install: 'traceroute',      desc: 'Trace network route',           cat: 'recon' },
    netdiscover:  { check: 'netdiscover',  install: 'netdiscover',     desc: 'ARP network discovery',         cat: 'recon' },
    arp:          { check: 'arp',          install: 'net-tools',       desc: 'ARP table viewer',              cat: 'recon' },

    // ── WEB ATTACKS ────────────────────────────────────────────────────────────
    whatweb:      { check: 'whatweb',      install: 'whatweb',         desc: 'Web technology fingerprinter',  cat: 'web' },
    nikto:        { check: 'nikto',        install: 'nikto',           desc: 'Web vulnerability scanner',     cat: 'web' },
    sqlmap:       { check: 'sqlmap',       install: 'sqlmap',          desc: 'SQL injection tool',            cat: 'web' },
    gobuster:     { check: 'gobuster',     install: 'gobuster',        desc: 'Directory/file brute-forcer',   cat: 'web' },
    dirb:         { check: 'dirb',         install: 'dirb',            desc: 'Directory brute-forcer',        cat: 'web' },
    dirbuster:    { check: 'dirbuster',    install: 'dirbuster',       desc: 'Directory brute-forcer GUI',    cat: 'web' },
    wfuzz:        { check: 'wfuzz',        install: 'wfuzz',           desc: 'Web fuzzer',                    cat: 'web' },
    ffuf:         { check: 'ffuf',         install: 'ffuf',            desc: 'Fast web fuzzer',               cat: 'web' },
    wpscan:       { check: 'wpscan',       install: 'wpscan',          desc: 'WordPress vulnerability scanner',cat: 'web' },
    xsser:        { check: 'xsser',        install: 'xsser',           desc: 'XSS tool',                      cat: 'web' },
    commix:       { check: 'commix',       install: 'commix',          desc: 'Command injection tool',        cat: 'web' },

    // ── PASSWORD CRACKING ──────────────────────────────────────────────────────
    hydra:        { check: 'hydra',        install: 'hydra',           desc: 'Network login brute-forcer',    cat: 'passwords' },
    john:         { check: 'john',         install: 'john',            desc: 'John the Ripper password cracker', cat: 'passwords' },
    hashcat:      { check: 'hashcat',      install: 'hashcat',         desc: 'GPU password cracker',          cat: 'passwords' },
    medusa:       { check: 'medusa',       install: 'medusa',          desc: 'Parallel login brute-forcer',   cat: 'passwords' },
    crunch:       { check: 'crunch',       install: 'crunch',          desc: 'Wordlist generator',            cat: 'passwords' },
    hash:         { check: 'hash-identifier', install: 'hash-identifier', desc: 'Hash type identifier',      cat: 'passwords' },

    // ── DNS ────────────────────────────────────────────────────────────────────
    dig:          { check: 'dig',          install: 'dnsutils',        desc: 'DNS lookup tool',               cat: 'dns' },
    nslookup:     { check: 'nslookup',     install: 'dnsutils',        desc: 'DNS query tool',                cat: 'dns' },
    dnsrecon:     { check: 'dnsrecon',     install: 'dnsrecon',        desc: 'DNS enumeration tool',          cat: 'dns' },
    dnsenum:      { check: 'dnsenum',      install: 'dnsenum',         desc: 'DNS enumeration',               cat: 'dns' },
    fierce:       { check: 'fierce',       install: 'fierce',          desc: 'DNS brute-forcer',              cat: 'dns' },
    dnsmap:       { check: 'dnsmap',       install: 'dnsmap',          desc: 'DNS network mapper',            cat: 'dns' },
    subfinder:    { check: 'subfinder',    install: 'subfinder',       desc: 'Subdomain discovery',           cat: 'dns' },
    amass:        { check: 'amass',        install: 'amass',           desc: 'Subdomain enumeration',         cat: 'dns' },

    // ── OSINT ─────────────────────────────────────────────────────────────────
    theharvester: { check: 'theHarvester', install: 'theharvester',   desc: 'Email/domain OSINT tool',       cat: 'osint' },
    sherlock:     { check: 'sherlock',     install: 'sherlock',        desc: 'Username OSINT tracker',        cat: 'osint' },
    recon_ng:     { check: 'recon-ng',     install: 'recon-ng',        desc: 'Recon framework',               cat: 'osint' },
    maltego:      { check: 'maltego',      install: 'maltego',         desc: 'OSINT visual framework',        cat: 'osint' },
    phoneinfoga:  { check: 'phoneinfoga',  install: 'phoneinfoga',     desc: 'Phone number OSINT',            cat: 'osint' },
    whois:        { check: 'whois',        install: 'whois',           desc: 'Domain WHOIS lookup',           cat: 'osint' },

    // ── EXPLOITATION ──────────────────────────────────────────────────────────
    msfconsole:   { check: 'msfconsole',   install: 'metasploit-framework', desc: 'Metasploit framework',   cat: 'exploit' },
    searchsploit: { check: 'searchsploit', install: 'exploitdb',       desc: 'ExploitDB searcher',            cat: 'exploit' },
    msfvenom:     { check: 'msfvenom',     install: 'metasploit-framework', desc: 'Payload generator',       cat: 'exploit' },
    beef:         { check: 'beef-xss',     install: 'beef-xss',        desc: 'Browser exploitation framework',cat: 'exploit' },

    // ── NETWORK TOOLS ─────────────────────────────────────────────────────────
    netcat:       { check: 'nc',           install: 'netcat-openbsd',  desc: 'Network utility',               cat: 'network' },
    nc:           { check: 'nc',           install: 'netcat-openbsd',  desc: 'Network utility',               cat: 'network' },
    curl:         { check: 'curl',         install: 'curl',            desc: 'HTTP client',                   cat: 'network' },
    wget:         { check: 'wget',         install: 'wget',            desc: 'File downloader',               cat: 'network' },
    ping:         { check: 'ping',         install: 'iputils-ping',    desc: 'ICMP ping',                     cat: 'network' },
    tcpdump:      { check: 'tcpdump',      install: 'tcpdump',         desc: 'Packet capture',                cat: 'network' },
    wireshark:    { check: 'tshark',       install: 'tshark',          desc: 'Packet analyzer (CLI)',          cat: 'network' },
    tshark:       { check: 'tshark',       install: 'tshark',          desc: 'CLI Wireshark',                 cat: 'network' },
    ettercap:     { check: 'ettercap',     install: 'ettercap',        desc: 'MITM attack tool',              cat: 'network' },
    arpspoof:     { check: 'arpspoof',     install: 'dsniff',          desc: 'ARP spoofing',                  cat: 'network' },
    bettercap:    { check: 'bettercap',    install: 'bettercap',       desc: 'Network attack Swiss knife',    cat: 'network' },
    mitmproxy:    { check: 'mitmproxy',    install: 'mitmproxy',       desc: 'HTTP MITM proxy',               cat: 'network' },

    // ── WIRELESS ──────────────────────────────────────────────────────────────
    aircrack:     { check: 'aircrack-ng',  install: 'aircrack-ng',     desc: 'WiFi key cracker',              cat: 'wireless' },
    'aircrack-ng':{ check: 'aircrack-ng',  install: 'aircrack-ng',     desc: 'WiFi suite',                    cat: 'wireless' },
    airodump:     { check: 'airodump-ng',  install: 'aircrack-ng',     desc: 'WiFi packet capture',           cat: 'wireless' },
    aireplay:     { check: 'aireplay-ng',  install: 'aircrack-ng',     desc: 'WiFi packet injection',         cat: 'wireless' },
    wifite:       { check: 'wifite',       install: 'wifite',          desc: 'Automated WiFi auditor',        cat: 'wireless' },
    kismet:       { check: 'kismet',       install: 'kismet',          desc: 'WiFi detector/sniffer',         cat: 'wireless' },
    reaver:       { check: 'reaver',       install: 'reaver',          desc: 'WPS brute-forcer',              cat: 'wireless' },

    // ── FORENSICS ─────────────────────────────────────────────────────────────
    binwalk:      { check: 'binwalk',      install: 'binwalk',         desc: 'Firmware analysis',             cat: 'forensics' },
    foremost:     { check: 'foremost',     install: 'foremost',        desc: 'File recovery tool',            cat: 'forensics' },
    volatility:   { check: 'volatility3',  install: 'volatility3',     desc: 'Memory forensics framework',    cat: 'forensics' },
    autopsy:      { check: 'autopsy',      install: 'autopsy',         desc: 'Digital forensics platform',    cat: 'forensics' },
    exiftool:     { check: 'exiftool',     install: 'libimage-exiftool-perl', desc: 'Metadata extractor',    cat: 'forensics' },
    steghide:     { check: 'steghide',     install: 'steghide',        desc: 'Steganography tool',            cat: 'forensics' },
    strings:      { check: 'strings',      install: 'binutils',        desc: 'Extract strings from binary',   cat: 'forensics' },
    hexdump:      { check: 'hexdump',      install: 'bsdmainutils',    desc: 'Hex dump tool',                 cat: 'forensics' },
    xxd:          { check: 'xxd',          install: 'xxd',             desc: 'Hex dump / reverse',            cat: 'forensics' },

    // ── REVERSE ENGINEERING ────────────────────────────────────────────────────
    gdb:          { check: 'gdb',          install: 'gdb',             desc: 'GNU debugger',                  cat: 'reversing' },
    radare2:      { check: 'r2',           install: 'radare2',         desc: 'Reverse engineering framework', cat: 'reversing' },
    ghidra:       { check: 'ghidra',       install: 'ghidra',          desc: 'NSA reverse engineering tool',  cat: 'reversing' },
    ltrace:       { check: 'ltrace',       install: 'ltrace',          desc: 'Library call tracer',           cat: 'reversing' },
    strace:       { check: 'strace',       install: 'strace',          desc: 'System call tracer',            cat: 'reversing' },
    objdump:      { check: 'objdump',      install: 'binutils',        desc: 'Object file disassembler',      cat: 'reversing' },
    file:         { check: 'file',         install: 'file',            desc: 'File type identifier',          cat: 'reversing' },
    nm:           { check: 'nm',           install: 'binutils',        desc: 'Symbol table viewer',           cat: 'reversing' },

    // ── SOCIAL ENGINEERING ─────────────────────────────────────────────────────
    'set':        { check: 'setoolkit',    install: 'set',             desc: 'Social Engineering Toolkit',    cat: 'social' },
    gophish:      { check: 'gophish',      install: 'gophish',         desc: 'Phishing framework',            cat: 'social' },

    // ── NETWORK ANALYSIS ──────────────────────────────────────────────────────
    enum4linux:   { check: 'enum4linux',   install: 'enum4linux',      desc: 'SMB/Windows enumeration',       cat: 'network' },
    smbclient:    { check: 'smbclient',    install: 'smbclient',       desc: 'SMB client',                    cat: 'network' },
    snmp:         { check: 'snmpwalk',     install: 'snmp',            desc: 'SNMP network discovery',        cat: 'network' },
}

// ── Core runner ───────────────────────────────────────────────────────────────
function run(cmd, timeoutMs = TIMEOUT_MS) {
    return new Promise(resolve => {
        const proc = exec(cmd, {
            cwd: WORK_DIR,
            timeout: timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env, TERM: 'xterm' }
        }, (err, stdout, stderr) => {
            const raw = (stdout || '').trim() || (stderr || '').trim() || (err?.message || 'No output')
            resolve({ ok: !err || stdout.trim().length > 0, out: raw })
        })
        setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, timeoutMs + 500)
    })
}

function runKali(cmd, timeoutMs = TIMEOUT_MS) {
    const escaped = cmd.replace(/'/g, `'\\''`)
    return run(`proot-distro login kali-rolling -- bash -c '${escaped}' 2>&1`, timeoutMs)
}

function trim(text, max = MAX_OUT_CHARS) {
    const clean = text.replace(/\x1B\[[0-9;]*[mGKHF]/g, '').trim()
    if (clean.length <= max) return clean
    const half = Math.floor(max / 2)
    return clean.slice(0, half) + '\n\n... [output trimmed] ...\n\n' + clean.slice(-half)
}

function isBlocked(cmd) {
    return BLOCKED.some(r => r.test(cmd))
}

async function send(sock, from, title, lines, msg) {
    return sock.sendMessage(from, { text: fmt.box(title, lines) }, { quoted: msg })
}

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

async function checkInstalled(tool) {
    const r = await runKali(`which ${tool} 2>/dev/null`, 5000)
    return r.ok && r.out.trim().length > 0 && !r.out.includes('not found')
}

async function autoInstall(sock, from, toolName, installName, msg) {
    await sock.sendMessage(from, {
        text: fmt.box('📦 AUTO-INSTALLING', [
            `*Tool:* ${toolName}`,
            `*Package:* ${installName}`,
            `_Installing from Kali repos... please wait_`,
        ])
    }, { quoted: msg })
    const r = await runKali(`DEBIAN_FRONTEND=noninteractive apt-get install -y ${installName} 2>&1`, TIMEOUT_LONG)
    return r
}

// ═════════════════════════════════════════════════════════════════════════════
//  .kali <tool> [args]
// ═════════════════════════════════════════════════════════════════════════════
async function handleKali(sock, from, q, msg) {
    if (!q) {
        const cats = {}
        for (const [name, t] of Object.entries(TOOLS)) {
            if (!cats[t.cat]) cats[t.cat] = []
            cats[t.cat].push(name)
        }

        const catEmojis = {
            recon: '🔭', web: '🌐', passwords: '🔑', dns: '🌍',
            osint: '🕵️', exploit: '💣', network: '📡', wireless: '📶',
            forensics: '🔬', reversing: '⚙️', social: '🎭'
        }

        const lines = [
            `*Usage:* ${config.prefix}kali <tool> [options]`,
            ``,
            `*Tools by category:*`,
        ]
        for (const [cat, tools] of Object.entries(cats)) {
            const emoji = catEmojis[cat] || '🛠️'
            lines.push(``, `${emoji} *${cat.toUpperCase()}*`)
            lines.push(...tools.map(t => `  ◈ ${t}`))
        }
        lines.push(``, `*Examples:*`)
        lines.push(`◈ ${config.prefix}kali nmap -sV 192.168.1.1`)
        lines.push(`◈ ${config.prefix}kali whatweb https://example.com`)
        lines.push(`◈ ${config.prefix}kali nikto -h target.com`)
        lines.push(`◈ ${config.prefix}kali hydra -l admin -P /wordlist.txt ssh://target`)
        lines.push(`◈ ${config.prefix}kali searchsploit apache 2.4`)
        lines.push(``, `_Tools auto-install if not present_`)
        return send(sock, from, '🐉 KALI TOOL RUNNER', lines, msg)
    }

    if (isBlocked(q)) return send(sock, from, '🚫 BLOCKED', ['Destructive command blocked.'], msg)

    const toolName = (q.trim().split(/\s+/)[0] || '').toLowerCase()
    const toolInfo = TOOLS[toolName]

    await fmt.react(sock, msg, '🐉')

    // Auto-install if tool is known and not installed
    if (toolInfo) {
        const installed = await checkInstalled(toolInfo.check)
        if (!installed) {
            await autoInstall(sock, from, toolName, toolInfo.install, msg)
        }
    }

    const start = Date.now()
    const r = await runKali(q, TIMEOUT_LONG)
    const elapsed = ((Date.now() - start) / 1000).toFixed(1)
    await fmt.react(sock, msg, r.ok ? '✅' : '⚠️')

    await sendResult(sock, from, `🐉 ${toolName.toUpperCase()} — ${elapsed}s`, r.out, msg)
}

// ═════════════════════════════════════════════════════════════════════════════
//  .tools — Show installed/missing tools
// ═════════════════════════════════════════════════════════════════════════════
async function handleTools(sock, from, q, msg) {
    await fmt.react(sock, msg, '🔧')
    await send(sock, from, '🔧 CHECKING TOOLS', ['_Checking which tools are installed..._'], msg)

    const checks = Object.entries(TOOLS).slice(0, 30) // check first 30 to avoid timeout
    const results = await Promise.all(
        checks.map(async ([name, t]) => {
            const ok = await checkInstalled(t.check)
            return { name, ok, desc: t.desc, cat: t.cat }
        })
    )

    const installed   = results.filter(r => r.ok)
    const missing     = results.filter(r => !r.ok)

    const lines = [
        `✅ *Installed (${installed.length}):*`,
        ...installed.map(r => `  ◈ ${r.name} — ${r.desc}`),
        ``,
        `❌ *Not installed (${missing.length}):*`,
        ...missing.map(r => `  ◈ ${r.name} — ${r.desc}`),
        ``,
        `_Install: ${config.prefix}toolinstall <name>_`,
        `_Or: ${config.prefix}kpkg install <package>_`,
    ]

    await sendResult(sock, from, '🔧 KALI TOOLS STATUS', lines.join('\n'), msg)
}

// ═════════════════════════════════════════════════════════════════════════════
//  .toolinstall <name>
// ═════════════════════════════════════════════════════════════════════════════
async function handleToolInstall(sock, from, q, msg) {
    if (!q) return send(sock, from, '📦 TOOL INSTALL', [
        `*Usage:* ${config.prefix}toolinstall <toolname>`,
        `*Example:* ${config.prefix}toolinstall sqlmap`,
        `*Example:* ${config.prefix}toolinstall metasploit-framework`,
    ], msg)

    const toolInfo = TOOLS[q.toLowerCase().trim()]
    const pkg = toolInfo ? toolInfo.install : q.trim()

    await fmt.react(sock, msg, '⬇️')
    await send(sock, from, '📦 INSTALLING TOOL', [
        `*Tool:* ${q}`,
        `*Package:* ${pkg}`,
        `_This may take a few minutes..._`,
    ], msg)

    const r = await runKali(`DEBIAN_FRONTEND=noninteractive apt-get install -y ${pkg} 2>&1`, TIMEOUT_LONG)
    await fmt.react(sock, msg, r.ok ? '✅' : '❌')
    await sendResult(sock, from, `📦 INSTALL: ${q}`, r.out, msg)
}

// ═════════════════════════════════════════════════════════════════════════════
//  .searchsploit <query>
// ═════════════════════════════════════════════════════════════════════════════
async function handleSearchSploit(sock, from, q, msg) {
    if (!q) return send(sock, from, '💣 SEARCHSPLOIT', [
        `*Usage:* ${config.prefix}searchsploit <query>`,
        ``,
        `Search the ExploitDB for known exploits.`,
        ``,
        `*Examples:*`,
        `◈ ${config.prefix}searchsploit apache 2.4`,
        `◈ ${config.prefix}searchsploit wordpress 5.0`,
        `◈ ${config.prefix}searchsploit openssh 7`,
        `◈ ${config.prefix}searchsploit windows smb`,
    ], msg)

    await fmt.react(sock, msg, '💣')
    const installed = await checkInstalled('searchsploit')
    if (!installed) {
        await send(sock, from, '📦 INSTALLING', [`_Installing exploitdb..._`], msg)
        await runKali('DEBIAN_FRONTEND=noninteractive apt-get install -y exploitdb 2>&1', TIMEOUT_LONG)
    }

    const r = await runKali(`searchsploit --color=false ${q} 2>&1`, TIMEOUT_MS)
    await fmt.react(sock, msg, '✅')
    await sendResult(sock, from, `💣 EXPLOITS: ${q}`, r.out || '(no results found)', msg)
}

// ═════════════════════════════════════════════════════════════════════════════
//  .msfuse <module>   — quick Metasploit info
// ═════════════════════════════════════════════════════════════════════════════
async function handleMsfuse(sock, from, q, msg) {
    if (!q) return send(sock, from, '💣 METASPLOIT', [
        `*Usage:* ${config.prefix}msfuse <module>`,
        ``,
        `Shows module info from Metasploit.`,
        ``,
        `*Examples:*`,
        `◈ ${config.prefix}msfuse auxiliary/scanner/portscan/tcp`,
        `◈ ${config.prefix}msfuse exploit/windows/smb/ms17_010_eternalblue`,
        `◈ ${config.prefix}msfuse auxiliary/scanner/http/http_version`,
        ``,
        `_For interactive use: ${config.prefix}kl msfconsole_`,
    ], msg)

    await fmt.react(sock, msg, '💣')
    const installed = await checkInstalled('msfconsole')
    if (!installed) {
        await send(sock, from, '📦 INSTALLING', [`_Installing Metasploit... this takes several minutes_`], msg)
        await runKali('DEBIAN_FRONTEND=noninteractive apt-get install -y metasploit-framework 2>&1', TIMEOUT_LONG)
    }

    const r = await runKali(
        `msfconsole -q -x "info ${q}; exit" 2>&1`,
        TIMEOUT_LONG
    )
    await fmt.react(sock, msg, '✅')
    await sendResult(sock, from, `💣 MSF INFO: ${q}`, r.out, msg)
}

// ═════════════════════════════════════════════════════════════════════════════
//  .hash <hash>   — identify hash type
// ═════════════════════════════════════════════════════════════════════════════
async function handleHashId(sock, from, q, msg) {
    if (!q) return send(sock, from, '🔑 HASH IDENTIFIER', [
        `*Usage:* ${config.prefix}hashid <hash>`,
        `*Example:* ${config.prefix}hashid 5f4dcc3b5aa765d61d8327deb882cf99`,
    ], msg)

    await fmt.react(sock, msg, '🔑')

    // Try hash-identifier first, fall back to manual detection
    const r = await runKali(`hash-identifier "${q}" 2>/dev/null || python3 -c "import hashlib; print('MD5 length:', len('${q}') == 32)"`, 10000)
    const out = r.out || '(could not identify)'

    // Also do manual check based on length
    const len = q.replace(/\s/g, '').length
    const manual = len === 32 ? 'MD5' : len === 40 ? 'SHA1' : len === 56 ? 'SHA224' : len === 64 ? 'SHA256' : len === 96 ? 'SHA384' : len === 128 ? 'SHA512' : `Unknown (length: ${len})`

    await sendResult(sock, from, `🔑 HASH: ${q.slice(0, 20)}...`, [
        `*Manual guess:* ${manual}`,
        ``,
        out,
    ].join('\n'), msg)
}

// ═════════════════════════════════════════════════════════════════════════════
//  .geoip <ip>   — geolocate an IP address
// ═════════════════════════════════════════════════════════════════════════════
async function handleGeoip(sock, from, q, msg) {
    if (!q) return send(sock, from, '🌍 GEO-IP', [
        `*Usage:* ${config.prefix}geoip <ip>`,
        `*Example:* ${config.prefix}geoip 8.8.8.8`,
    ], msg)

    await fmt.react(sock, msg, '🌍')
    const r = await runKali(`curl -s "https://ipinfo.io/${q}/json" 2>&1`, 15000)
    await fmt.react(sock, msg, '✅')
    await sendResult(sock, from, `🌍 GEOIP: ${q}`, r.out, msg)
}

// ═════════════════════════════════════════════════════════════════════════════
//  .banner <ip> <port>  — grab service banner
// ═════════════════════════════════════════════════════════════════════════════
async function handleBanner(sock, from, q, msg) {
    if (!q || !q.includes(' ')) return send(sock, from, '🏷️ BANNER GRAB', [
        `*Usage:* ${config.prefix}banner <ip/host> <port>`,
        `*Example:* ${config.prefix}banner example.com 80`,
        `*Example:* ${config.prefix}banner 192.168.1.1 22`,
    ], msg)

    const [host, port = '80'] = q.trim().split(/\s+/)
    await fmt.react(sock, msg, '🏷️')
    const r = await runKali(
        `timeout 10 nc -v -w 5 ${host} ${port} 2>&1 < /dev/null || curl -sI --max-time 10 ${host}:${port} 2>&1 | head -20`,
        15000
    )
    await sendResult(sock, from, `🏷️ BANNER: ${host}:${port}`, r.out || '(no banner / closed)', msg)
}

module.exports = {
    handleKali,
    handleTools,
    handleToolInstall,
    handleSearchSploit,
    handleMsfuse,
    handleHashId,
    handleGeoip,
    handleBanner,
}
