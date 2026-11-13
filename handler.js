'use strict'
const config = require('./config')
const fmt    = require('./lib/format')
const { getBody, getSender, getFrom, isGroup, isOwner, isPublicMode, getCachedGroupMeta, isBotAdmin, extractViewOnce, jidToNum, normNum, numsMatch, mentionName } = require('./lib/utils')

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── Fake presence simulation (typing/recording) ─────────────────────────────
// Fires on every genuine incoming message the bot actually processes,
// governed by the .autotype / .autorecord scope (off/public/private) — NOT
// only right before the bot replies to a command. That's the whole point of
// this feature: it makes the account look like it's actively typing or
// recording a voice note in response to whatever just came in, even though
// nothing is really being typed or recorded. It runs fire-and-forget (never
// awaited by the caller) so it never adds latency to the bot's real replies.
// autotype and autorecord are independent now — if both scopes allow it for
// this chat, both indicators pulse one after another (typing, then
// recording), each held for a full 7s so it's clearly visible before
// clearing, rather than the old ~1.8s flash that was easy to miss.
const PRESENCE_HOLD_MS = 7000
function firePresenceIndicator(sock, from, inGroup) {
    const wantType   = scopeAllows(runtimeSettings.autotype, inGroup)
    const wantRecord = scopeAllows(runtimeSettings.autorecord, inGroup)
    if (!wantType && !wantRecord) return

    ;(async () => {
        try {
            if (wantType) {
                await sock.sendPresenceUpdate('composing', from)
                await sleep(PRESENCE_HOLD_MS)
            }
            if (wantRecord) {
                await sock.sendPresenceUpdate('recording', from)
                await sleep(PRESENCE_HOLD_MS)
            }
            // Clear the indicator explicitly rather than leaving it to
            // WhatsApp's own ~25s timeout, so it doesn't linger oddly on
            // chats that go quiet right after this fires.
            await sock.sendPresenceUpdate('paused', from)
        } catch {}
    })()
}

const { sendMenu }              = require('./plugins/menu')
const { sendButtonsDemo }       = require('./plugins/buttons')
const { getButtonAction, loadBtns, btnsReady } = require('./lib/buttons')
const { sendContactCard }       = require('./plugins/contact')
const { makeSticker }           = require('./plugins/sticker')
const { handleGroupCmd, isBanned, handleGroupEvents } = require('./plugins/groups')
const { antiLinkCheck, antiSpamCheck, antiStickerCheck, antiVoiceNoteCheck, antiBugCheck, antiBugCheckDM, antiGroupMentionCheck, antiBotCheck, copyPasteFloodCheck } = require('./plugins/antiSpam')
const { codeAgentReply, rememberCommand, refreshCommand, getAgentStatus } = require('./plugins/codeAgent')
const { handleAdult }           = require('./plugins/adult')
const { downloadMedia, downloadApk } = require('./plugins/downloader')
const { gameCmds, handleGame }   = require('./plugins/games')
const { aiReply }               = require('./plugins/aiChat')
const { selfCodeReply }         = require('./plugins/selfCode')
const { getStatus: getAiStatus } = require('./lib/aiProviders')
const { wrapSocket } = require('./lib/funResponses')
const { handleOwnerCmd, badWords, ignoredNumbers, runtimeSettings, scopeAllows } = require('./plugins/ownerCmds')
const { handleSports, getSportsCommands } = require('./plugins/sports')
const { getBible, getQuran }    = require('./plugins/religion')
const { getLyrics, getIMDB, getYTS } = require('./plugins/search')
const { getWallpaper, getRemini, getRemoveBackground } = require('./plugins/image')
const { searchMovies, topRatedMovies, movieDetails } = require('./plugins/movies')
const { handleCustomCmdBuilder, checkCustomCmd } = require('./plugins/customCmds')
const { getSettings, setSetting } = require('./plugins/groupSettings')
const { handleNewsCmd }         = require('./plugins/newsMonitor')
const { handleKali, handleTools, handleToolInstall, handleSearchSploit, handleMsfuse, handleHashId, handleGeoip, handleBanner } = require('./plugins/kali')
const { handleScan, handleWebcheck, handleRecon, handleOsint, handleSqli, handleCrack, handleBrute, handleMyIp, handleSysinfo, handlePorts } = require('./plugins/kaliwrapper')
const {
    handleUbuntu, handleKaliShell, handleFiles, handleCat, handleFind, handleGrep,
    handleChmod, handleDownloadFile, handleTar, handleProc, handleKillProc, handleJobs,
    handleSysInfo, handleKaliSysInfo, handleMem, handleDisk, handleCpu, handleUptime,
    handleWhoami, handleUname, handleHostname, handleUsers, handleEnv, handleServices,
    handleLogs, handleCron, handleNetInfo, handleMyIp: handleMyIpLinux, handleListenPorts,
    handlePingCmd, handleTraceroute, handleDig, handleWhois, handleCurlCmd,
    handlePkg, handleKaliPkg, handleDistroStatus, handleTermuxInfo, handleTermuxPkg,
    handleShell,
} = require('./plugins/linux')
const {
    handleNmap, handleMasscan, handleNikto, handleWhatweb,
    handleGobuster, handleDirb, handleWfuzz, handleFfuf,
    handleWpscan, handleEnum4linux,
    handleHydra, handleJohn, handleHashcat, handleMedusa,
    handleCrunch, handleHashid,
    handleSqlmap,
    handleDnsrecon, handleDnsenum, handleFierce, handleSubfinder, handleAmass,
    handleSherlock, handleHarvester, handleGeoip: handleGeoipKali,
    handleAirmon, handleAirodump, handleAireplay, handleAircrack,
    handleWifite, handleReaver,
    handleSearchsploit, handleMsfvenom, handleMsf,
    handleBinwalk, handleStrings, handleExiftool, handleSteghide,
    handleForemost, handleHexdump, handleXxd, handleFile,
    handleMd5sum, handleSha256sum,
    handleNc, handleTcpdump,
    handleKaliInstall,
} = require('./plugins/kali_cmds')
const {
    handleLs, handleCat: handleCatLinux, handleHead, handleTail,
    handleMkdir, handleRmfile, handleCpfile, handleMvfile, handleTouch,
    handleChmod: handleChmodLinux, handleChown, handleFind: handleFindLinux,
    handleGrep: handleGrepLinux, handleDu, handleStat, handleWc,
    handleSortfile, handleUniq, handleDiff,
    handleExtract, handleZipfile, handleGzip, handleGunzip,
    handleWget: handleWgetLinux, handleCurlget,
    handleSysinfo: handleSysinfoLinux, handleUptime: handleUptimeLinux,
    handleFree, handleDf, handleLscpu, handleLsblk,
    handleUname: handleUnameLinux, handleHostname: handleHostnameLinux,
    handleWhoami: handleWhoamiLinux, handleDate, handleEnv: handleEnvLinux,
    handleUsers: handleUsersLinux,
    handlePs, handleTop, handleKill, handlePkill, handlePgrep,
    handleJobs: handleJobsLinux,
    handlePing, handleTraceroute: handleTracerouteLinux,
    handleDig: handleDigLinux, handleNslookup, handleWhois: handleWhoisLinux,
    handleCurl, handleNetstat, handleSs, handleIfconfig, handleIp,
    handleArp, handleMyip,
    handleApt, handleTpkg: handleTpkgNew,
    handleUbuntuInstall,
} = require('./plugins/linux_cmds')
const { handleFacebookCmd, handleWhatsAppCmd, handleTelegramCmd, handleSetFacebook, handleFbPageId, handleFbAccessToken } = require('./plugins/channelManager')
const { chatBrainCmds, handleChatBrainCmd, maybeChatReply } = require('./plugins/humanChat')
const chatBrain = require('./lib/humanChat')
const settings = require('./lib/settings')

// ── Load persisted mode at startup so it survives bot restarts ────────────────
{
    const saved = settings.get('mode', null)
    if (saved) config.mode = saved
}

const spamMap    = new Map()
const cooldownMap = new Map()

// Per-user command cooldown — prevents flooding
function checkCooldown(sender, cmd) {
    const cd  = config.commandCooldownMs || 3000
    const key = `${sender}:${cmd}`
    const last = cooldownMap.get(key) || 0
    const now  = Date.now()
    if (now - last < cd) return Math.ceil((cd - (now - last)) / 1000)
    cooldownMap.set(key, now)
    // Auto-clean every 500 entries to prevent memory leak
    if (cooldownMap.size > 500) {
        const cutoff = now - cd * 10
        for (const [k, v] of cooldownMap) { if (v < cutoff) cooldownMap.delete(k) }
    }
    return 0
}

// ── Fun data ──────────────────────────────────────────────────────────────────
const facts  = ["🌍 A day on Venus is longer than a year on Venus.","🐙 Octopuses have three hearts and blue blood.","🍯 Honey never expires — 3000-year-old honey was still edible.","🌙 The moon moves away from Earth at 3.8cm per year.","🐘 Elephants are the only animals that can't jump.","⚡ Lightning strikes Earth 100 times every second.","🧠 Your brain generates about 20 watts of electricity.","🦈 Sharks are older than trees.","🐝 Bees can recognise human faces.","🌊 The ocean covers 71% of Earth's surface."]
const jokes  = ["😂 Why don't scientists trust atoms?\nBecause they make up everything!","😂 Why did the scarecrow win an award?\nBecause he was outstanding in his field!","😂 What do you call fake spaghetti?\nAn impasta!","😂 What do you call cheese that isn't yours?\nNacho cheese!","😂 I told my wife she should embrace her mistakes.\nShe gave me a hug.","😂 Why don't eggs tell jokes?\nThey'd crack each other up!","😂 I'm reading a book about anti-gravity. It's impossible to put down!","😂 What do you call a fish without eyes? A fsh!"]
const quotes = ["💬 _\"The only way to do great work is to love what you do.\"_ — Steve Jobs","💬 _\"In the middle of every difficulty lies opportunity.\"_ — Albert Einstein","💬 _\"It does not matter how slowly you go as long as you do not stop.\"_ — Confucius","💬 _\"The future belongs to those who believe in the beauty of their dreams.\"_ — Eleanor Roosevelt","💬 _\"Success is not final, failure is not fatal.\"_ — Churchill","💬 _\"Be yourself; everyone else is already taken.\"_ — Oscar Wilde","💬 _\"Two things are infinite: the universe and human stupidity.\"_ — Einstein"]
const trivia = [{q:"What is the capital of Australia?",a:"Canberra"},{q:"How many bones in the human body?",a:"206"},{q:"Largest planet in our solar system?",a:"Jupiter"},{q:"WW2 ended in what year?",a:"1945"},{q:"Chemical symbol for gold?",a:"Au"},{q:"Fastest land animal?",a:"Cheetah"},{q:"Who painted the Mona Lisa?",a:"Leonardo da Vinci"},{q:"How many sides does a hexagon have?",a:"6"},{q:"What is the speed of light (approx)?",a:"299,792,458 m/s"},{q:"Which element has atomic number 1?",a:"Hydrogen"}]
const truthQs = ["🤔 What is the most embarrassing thing you've ever done?","🤔 Have you ever lied to get out of trouble?","🤔 What's your biggest fear?","🤔 Have you ever had a crush on someone in this group?","🤔 What is your biggest regret?","🤔 Have you ever cheated on a test?","🤔 What's the most childish thing you still do?","🤔 Have you ever stalked someone's social media?"]
const dares  = ["🎯 Send a voice note singing any song!","🎯 Change your profile picture to a funny face for 1 hour!","🎯 Tag 3 people and say something nice about each!","🎯 Send the last photo in your gallery!","🎯 Write a poem about the person above you!","🎯 Call someone in the group right now!","🎯 Send a selfie right now!","🎯 Share your most embarrassing autocorrect fail!"]
function rand(arr) { return arr[Math.floor(Math.random() * arr.length)] }

// ── Command sets ──────────────────────────────────────────────────────────────
const sportsCmds = getSportsCommands()

const downloadCmds = new Set([
    // Music
    'play','song','song2','music','mp3',
    // YouTube
    'ytmp3','ytmp4','yt','yta','ytv','tomp3','toaudio','tovideo','download',
    // Social
    'tiktok','tt','tkvid','tiktokaudio','tkaudio','ttaudio',
    'ig','instagram','insta',
    'twitter','x','tweet',
    'facebook','fb','fbvid',
    // Extra
    'spotify','sp','spdl',
    'mediafire','mf','mfdl',
    'video',
])

const groupCmds = new Set(['kick','add','promote','demote','mute','unmute','kickall','ban','unban','antilink','antispam','antisticker','antivoicenote','antibot','antiremove','antigroupmention','welcome','goodbye','setgroupname','setdesc','resetlink','setppgroup','getgrouppp','invite','link','tagall','tagadmin','hidetag','admins','admin','totalmembers','members','poll','getsettings','debugadmin','announcements','open','close','approve','reject','gstatus',
    // These all have working handlers in plugins/groups.js but were never
    // listed here, so the command was silently dropped as "unknown" —
    // that's why .antiraid never replied or did anything.
    'antiraid','antibadword','everyone','stealthtag','count','antispare'])

// The ~160 Kali/Linux/pentest shortcut commands (each already routed
// individually in the switch below) — kept out of the main .menu since a
// customer-facing bot shouldn't lead with a wall of pentest tooling.
// .kalicmds lists them on request; .kali <tool> already runs anything by
// name via the TOOLS registry in plugins/kali.js.
const KALI_LINUX_CMDS = ['aircrack','aireplay','airmon','airodump','amass','apt','arp','banner','binwalk','brute','cat','chmod','chown','cpfile','cpu','crack','cron','crunch','curl','curlget','date','df','diff','dig','dig2','dirb','disk2','distros','dnsenum','dnsrecon','du','enum4linux','env2','exiftool','extract','fetch','ffuf','fierce','files','filetype','find','findfile','foremost','free','geoip','geoip2','gobuster','grep','grepfile','gunzip','gzip','harvester','hashcat','hashid','hashid2','head','hexdump','hostname','hostname2','hydra','ifconfig','ip','ipinfo','jobs','jobs2','john','kaliip','kalisysinfo','kalisysinfo2','kill','killit','kinstall','kl','kpkg','listenports','logs','ls','lsblk','lscpu','masscan','md5sum','medusa','mem','mkdir','msf','msfuse','msfvenom','mvfile','myip','myip2','nc','netinfo','netstat','nikto','nmap','nslookup','osint','pgrep','ping2','pinghost','pkg','pkill','ports','proc','ps','reaver','recon','rmfile','scan','searchsploit','searchsploit2','services','sh','sha256sum','shell','sherlock','sortfile','sqli','sqlmap','ss','stat','steghide','storage','strings','subfinder','sysinfo','sysinfo2','tail','tar','tcpdump','termuxinfo','toolinstall','tools','topcmd','touch','tpkg','tpkg2','trace','traceroute','ub','ubenv','ubsysinfo','ubuntu','ubuptime','ubwhoami','uinstall','uname','uname2','uniq','uptime','users','users2','wc','webcheck','wfuzz','wget','wgetfile','whatweb','whoami2','whois','whois2','wifite','wpscan','xxd','zipfile']
const KALI_LINUX_SET = new Set(KALI_LINUX_CMDS)

const adultCmds = new Set(['hentai','naughty','lewdwaifu','nsfw','lewdanime','rule34','danbooru','xbooru'])

const ownerOnlyCmds = new Set([
    'setbotname','setownername','setownernumber','setprefix','setbio','setprofilepic','funmode',
    'restart','resetsessions','block','unblock','unblockall','listblocked','join','leave','groupid',
    'hostip','disk','addsudo','delsudo','listsudo',
    'addbadword','deletebadword','listbadword',
    'addignorelist','delignorelist','listignorelist',
    'warn','resetwarn','listwarn',
    'delete','react','online','lastseen','alwaysonline','autoread','readreceipts',
    'autotype','tostatus','toviewonce','vv2','deljunk',
    'setgroupname','setdesc','resetlink','setppgroup','getgrouppp',
    'modestatus','runeval','repair','repairlog','aistatus','aitest','agent','remember','agentrefresh','agentstatus',
    'kali','kalicmds','sh','shell','kl','ub','ubuntu',
    'scan','webcheck','recon','osint','sqli','crack','brute','myip','sysinfo','ports',
    'tools','toolinstall','searchsploit','msfuse','hashid','geoip','banner',
    'files','cat','find','grep','chmod','wgetfile','tar','proc','killit','jobs',
    'sysinfo2','kalisysinfo','mem','disk2','storage','cpu','ubuptime','ubwhoami','uname','hostname',
    'users','ubenv','services','logs','cron','netinfo','myip2','ipinfo','listenports',
    'pinghost','ping2','trace','dig','whois','fetch','pkg','kpkg','distros','termuxinfo','tpkg',
    // ── kali_cmds.js dedicated tools ──────────────────────────────────────────
    'nmap','masscan','nikto','whatweb','gobuster','dirb','wfuzz','ffuf','wpscan','enum4linux',
    'hydra','john','hashcat','medusa','crunch','hashid2',
    'sqlmap',
    'dnsrecon','dnsenum','fierce','subfinder','amass',
    'sherlock','harvester','geoip2',
    'airmon','airodump','aireplay','aircrack','wifite','reaver',
    'searchsploit2','msfvenom','msf',
    'binwalk','strings','exiftool','steghide','foremost','hexdump','xxd','filetype','md5sum','sha256sum',
    'nc','tcpdump',
    // ── linux_cmds.js dedicated tools ─────────────────────────────────────────
    'ls','head','tail','mkdir','rmfile','cpfile','mvfile','touch','chown',
    'findfile','grepfile','du','stat','wc','sortfile','uniq','diff',
    'extract','zipfile','gzip','gunzip',
    'wget','curlget',
    'sysinfo','uptime','free','df','lscpu','lsblk',
    'uname2','hostname2','whoami2','date','env2','users2',
    'ps','topcmd','kill','pkill','pgrep','jobs2',
    'ping2','traceroute','dig2','nslookup','whois2','curl','netstat','ss','ifconfig','ip','arp','myip',
    'apt','tpkg2',
    'setfb','kinstall','uinstall',
    'addcmd','delcmd','editcmd','listcmd','listcmds','mycmds','cmdinfo',
    'autoviewstatus','autoreactstatus','autosavestatus','autoreact',
    'anticall','antidelete','antideletepath','antiedit','antiviewonce',
    'autobio','autoblock','autorecord','autorecordtyping','antibug',
    'statusdelay','statussettings','setwatermark','setfont',
    'setcontextlink','setstatusemoji','setstickerauthor','setstickerpackname',
    'settimezone','setmenu','setmenuimage','setwelcome','setgoodbye',
    'showwelcome','showgoodbye','testwelcome','testgoodbye','delwelcome','delgoodbye',
    'resetsetting','setanticallmsg','showanticallmsg','delanticallmsg','testanticallmsg',
    'addcountrycode','delcountrycode','listcountrycode',
    'aza','resetaza','setaza','ppprivacy','gcaddprivacy','dlvo','update',
    'allgroups','mode','chatbot','botstatus','status','runtime','bancheck',
    'fbpageid','fbpage','fbaccesstoken','fbtoken',
    'chatteach','chatunteach','chatfact','chatforget','chatlist','chatpersona','chatname','chatreset','chatstatus','hftoken','hfmodel',
    'broadcast',
    // NOTE: getpp, getabout, device are intentionally PUBLIC — handled in switch, not here
])

// In PRIVATE mode, absolutely nothing responds to a non-owner — not even
// ping/whoami/myid. Those used to bypass the guard via this set, which
// defeated the point of private mode (it silently leaked that the bot was
// alive/online to anyone who tried a command). Kept empty on purpose.
const alwaysPublic = new Set([])

const startTime = Date.now()

const _silentMediaLogger = {
    level: 'silent', child: () => _silentMediaLogger,
    info: () => {}, debug: () => {}, error: () => {}, warn: () => {}, trace: () => {}
}

// ── Auto-reveal view-once media ──────────────────────────────────────────
// This is what `.antiviewonce` (plugins/ownerCmds.js) actually turns on/off.
// The toggle command itself only flips `runtimeSettings.antiviewonce` — this
// is the piece that reacts to it. Runs on every incoming message (group AND
// DM, since a view-once photo can land in either), completely separate from
// the manual `.vv`/`.reveal` command which only fires when you explicitly
// reply to one.
async function maybeRevealViewOnce(sock, msg, from, sender) {
    if (!runtimeSettings.antiviewonce) return
    if (!msg.message) return

    const vMsg = extractViewOnce(msg.message)
    if (!vMsg) return

    try {
        const { downloadMediaMessage } = require('@neoxr/baileys')
        const buf = await downloadMediaMessage(
            { message: vMsg, key: msg.key }, 'buffer', {},
            { logger: _silentMediaLogger, reuploadRequest: sock.updateMediaMessage }
        )
        const mtype = Object.keys(vMsg)[0]
        const senderNum = (sender || '').split('@')[0]
        const caption = `👁️ *View-once auto-revealed*${senderNum ? ` — sent by @${senderNum}` : ''}`

        if (mtype === 'imageMessage') {
            await sock.sendMessage(from, { image: buf, caption, mentions: senderNum ? [sender] : [] })
        } else if (mtype === 'videoMessage') {
            await sock.sendMessage(from, { video: buf, caption, mentions: senderNum ? [sender] : [] })
        } else if (mtype === 'audioMessage') {
            await sock.sendMessage(from, {
                audio: buf,
                mimetype: vMsg.audioMessage?.mimetype || 'audio/ogg; codecs=opus',
                ptt: !!vMsg.audioMessage?.ptt,
            })
        }
    } catch (e) {
        console.error('antiviewonce auto-reveal failed:', e.message)
    }
}

async function handleMessage(sock, msg) {
    try {
        const body      = getBody(msg)
        const botJid    = sock.user?.id || ''
        const sender    = getSender(msg, botJid)
        const from      = getFrom(msg)
        const inGroup   = isGroup(from)
        const owner     = isOwner(sender, botJid, msg.key?.fromMe)
        const publicMode = isPublicMode()
        const prefix    = config.prefix

        // Banned user — silently delete their message
        if (isBanned(sender)) {
            try { await sock.sendMessage(from, { delete: msg.key }) } catch {}
            return
        }

        // Ignored numbers
        if (!owner && ignoredNumbers.includes(sender.replace('@s.whatsapp.net','').replace(/[^0-9]/g,''))) return

        // Simulate typing/recording presence for this incoming message —
        // fires regardless of whether it's a command, so it works exactly
        // like the user described: any message landing in a DM or group can
        // trigger it, per the .autotype/.autorecord scope, not just replies.
        firePresenceIndicator(sock, from, inGroup)

        // ── Group protection ─────────────────────────────────────────────────
        if (inGroup) {
            if (await antiBugCheck(sock, msg, from, sender, owner)) return
            if (await antiLinkCheck(sock, msg, from, sender, owner)) return
            if (await antiStickerCheck(sock, msg, from, sender, owner)) return
            if (await antiVoiceNoteCheck(sock, msg, from, sender, owner)) return
            if (await antiGroupMentionCheck(sock, msg, from, sender, owner)) return
            if (await antiSpamCheck(sock, msg, from, sender, spamMap)) return
            if (await copyPasteFloodCheck(sock, msg, from, sender, owner)) return
            if (await antiBotCheck(sock, msg, from, sender, owner, prefix)) return
            if (body && badWords.length) {
                const lb = body.toLowerCase()
                if (badWords.some(w => lb.includes(w))) {
                    try { await sock.sendMessage(from, { delete: msg.key }) } catch {}
                    await sock.sendMessage(from, {
                        text: fmt.box('BAD LANGUAGE', [`⚠️ @${sender.split('@')[0]} — offensive language is *not allowed*`]),
                        mentions: [sender]
                    })
                    return
                }
            }
        }

        // ── DM anti-bug protection (owner's own inbox — .antibug toggle) ──────
        if (!inGroup) {
            if (await antiBugCheckDM(sock, msg, from, sender, owner, runtimeSettings.antibug)) return
        }

        // ── Auto-reveal view-once media (owner toggle: .antiviewonce) ─────────
        // Placed here — before the `if (!body) return` below — because
        // view-once photos/videos are very often sent with no caption at all,
        // and this needs to fire regardless of whether there's text.
        await maybeRevealViewOnce(sock, msg, from, sender)

        if (!body) return

        const isCmd = body.startsWith(prefix)
        const cmd   = isCmd ? body.slice(prefix.length).trim().split(/\s+/)[0].toLowerCase() : ''
        const args  = isCmd ? body.slice(prefix.length + cmd.length).trim().split(/\s+/).filter(Boolean) : []
        // Interactive reply-buttons (spencer-btns' Ping/Menu/etc.) arrive as
        // plain text carrying their id — route them before normal command
        // parsing, and before the AI-auto-reply branch below would otherwise
        // swallow them as ordinary chat.
        if (!isCmd) {
            const btnAction = getButtonAction(body.trim())
            if (btnAction) { await btnAction(sock, from, sender, msg); return }
        }
        const q     = args.join(' ').trim()

        // ── Non-command: human-style chatbot (Hugging Face) ──────────────────
        // Has its own on/off + DM/group scope (.chatbot), independent of the
        // command mode. DMs: answers everyone but the owner. Groups: only when
        // it is @mentioned, replied to, or called by name.
        if (!isCmd) {
            await maybeChatReply(sock, msg, from, sender, body, inGroup, owner)
            return
        }

        // ── Private mode guard ────────────────────────────────────────────────
        // Silent return — do NOT reveal the bot is in private mode to others.
        // This prevents the bot from responding to other people's bot commands.
        if (!publicMode && !owner && !alwaysPublic.has(cmd)) {
            return
        }

        // ── Per-user cooldown (skip for owner) ───────────────────────────────
        // Always a silent drop now — no "Slow down" text in groups or DMs.
        // Cooldown tracking itself stays (still throttles command spam), only
        // the visible message is gone.
        if (!owner && isCmd && cmd && !gameCmds.has(cmd)) {
            const wait = checkCooldown(sender, cmd)
            if (wait > 0) return
        }

        // Add a small rotating personality line to ordinary text replies.
        // Installed before command routing so custom/group/download/sports/
        // owner/switch responses all get the same response personality layer.
        const plainSock = sock   // un-decorated socket — .chat replies must not get the joke tagline
        sock = wrapSocket(sock, cmd)

        // ── Custom commands ───────────────────────────────────────────────────
        const customHandled = await checkCustomCmd(sock, from, cmd, msg, prefix)
        if (customHandled) return

        // ── Owner-only guard ──────────────────────────────────────────────────
        // In PRIVATE mode, non-owner commands are already silently dropped above.
        // Keep this guard silent too so an owner-only command never leaks the
        // bot's permission model to someone who should not see it.
        // `antibug` is special-cased out: in a group it's a group-admin-level
        // toggle (handleGroupCmd does its own admin check below), only the
        // DM usage is owner-only. Gating it here too would block group admins.
        if (ownerOnlyCmds.has(cmd) && !owner && !(cmd === 'antibug' && inGroup)) {
            if (!publicMode) return
            return sock.sendMessage(from, { text: fmt.permOwner() }, { quoted: msg })
        }

        // ── Sports ────────────────────────────────────────────────────────────
        if (sportsCmds.has(cmd)) {
            await fmt.react(sock, msg, '⚡')
            return handleSports(sock, from, cmd, msg, q)
        }

        // ── Facebook channel management vs. Facebook video downloader ──────────
        // `.fb` is shared: `.fb on|off|test|status` manages the News Monitor's
        // Facebook Page publisher, anything else (a URL) falls through to the
        // existing Facebook video downloader below.
        const fbManageSubs = new Set(['on', 'off', 'test', 'status'])
        if (cmd === 'fb' && fbManageSubs.has((args[0] || '').toLowerCase())) {
            return handleFacebookCmd(sock, from, args, msg, owner)
        }

        // ── WhatsApp Channel management ─────────────────────────────────────────
        if (cmd === 'wa') {
            return handleWhatsAppCmd(sock, from, args, msg, owner)
        }

        // ── Telegram management ─────────────────────────────────────────────────
        if (cmd === 'tg') {
            return handleTelegramCmd(sock, from, args, msg, owner)
        }

        // ── Facebook hot-swap credentials ───────────────────────────────────────
        if (cmd === 'setfb') {
            return handleSetFacebook(sock, from, args, msg, owner)
        }

        // ── Facebook credentials, one at a time ─────────────────────────────────
        if (cmd === 'fbpageid' || cmd === 'fbpage') {
            return handleFbPageId(sock, from, args, msg, owner)
        }
        if (cmd === 'fbaccesstoken' || cmd === 'fbtoken') {
            return handleFbAccessToken(sock, from, args, msg, owner)
        }

        // ── Human-style chatbot: .chat / .chatbot / .chatteach / .hftoken ... ───
        if (chatBrainCmds.has(cmd)) {
            return handleChatBrainCmd(cmd === 'chat' ? plainSock : sock, from, cmd, args, msg, owner, inGroup)
        }

        // ── Games: .games .ttt .c4 .hm .guess .memory .mines .2048 .slots .rps .quiz .lights .slide ──
        // Un-decorated socket so boards don't get the joke tagline; exempt from the 3 s cooldown above.
        if (gameCmds.has(cmd)) {
            return handleGame(plainSock, from, cmd, args, msg, sender)
        }

        // ── Downloads ─────────────────────────────────────────────────────────
        if (downloadCmds.has(cmd)) {
            if (!q) return sock.sendMessage(from, { text: fmt.usage(cmd, '<search / URL>') }, { quoted: msg })
            return downloadMedia(sock, from, cmd, q, msg)
        }

        // ── Anti-bug toggle — universal, works in both contexts ───────────────
        // Group chat: toggles this group's own antibug setting (handled by
        // handleGroupCmd, same as the other groupCmds below). DM: falls
        // through to handleOwnerCmd's case 'antibug', which toggles DM
        // protection for the bot's own inbox. Kept out of groupCmds on
        // purpose — that set hard-blocks non-group use with a permission
        // error, which used to make `.antibug` unusable outside a group.
        if (cmd === 'antibug' && inGroup) {
            return handleGroupCmd(sock, msg, from, sender, cmd, args, owner)
        }

        // ── Group commands ────────────────────────────────────────────────────
        if (groupCmds.has(cmd)) {
            if (!inGroup) return sock.sendMessage(from, { text: fmt.permGroup() }, { quoted: msg })
            return handleGroupCmd(sock, msg, from, sender, cmd, args, owner)
        }

        // ── Adult commands ────────────────────────────────────────────────────
        if (adultCmds.has(cmd)) {
            if (!inGroup && !owner) return  // only in groups or for owner in DM
            return handleAdult(sock, from, cmd, q, msg)
        }

        switch (cmd) {

            // ════ MENU ════════════════════════════════════════════════════════
            case 'menu': case 'help':
                await sendMenu(sock, from, sender, msg)
                break

            // ════ PING (bot latency) — .ping is normal; .ping2 is the Linux/Kali host ping ═
            case 'ping': case 'botping': case 'pong': {
                const start = Date.now()
                await sock.sendMessage(from, { text: fmt.box('PING', ['🏓 Testing response time...']) }, { quoted: msg })
                const ms = Date.now() - start
                await sock.sendMessage(from, {
                    text: fmt.box('PONG', [
                        `✅ Bot is *online* and responding`,
                        ``,
                        `⚡ *Response time:* ${ms}ms`,
                        `🌐 *Mode:* ${(config.mode || 'public').toUpperCase()}`,
                        `🤖 *Chatbot:* ${chatBrain.getState().scope.toUpperCase()}`,
                    ])
                })
                break
            }

            // ════ OWNER INFO ══════════════════════════════════════════════════
            case 'owner':
                await sock.sendMessage(from, {
                    text: fmt.box('OWNER INFO', [
                        `👤 *Name:*   ${config.ownerName}`,
                        `📱 *Number:* wa.me/${config.ownerNumber || jidToNum(sock.user?.id || '')}`,
                        `🤖 *Bot:*    ${config.botName}`,
                    ])
                }, { quoted: msg })
                break

            // ════ CONTACT OWNER ═══════════════════════════════════════════════
            case 'contact':
                await sendContactCard(sock, from, sender, msg)
                break

            case 'buttons': case 'btn':
                await sendButtonsDemo(sock, from, sender, msg, args)
                break

            // ════ RUNTIME (bot uptime) — use .runtime for bot uptime, .uptime for system ═
            case 'runtime': case 'botuptime': {
                const up  = Date.now() - startTime
                const d   = Math.floor(up / 86400000)
                const h   = Math.floor((up % 86400000) / 3600000)
                const m2  = Math.floor((up % 3600000) / 60000)
                const s2  = Math.floor((up % 60000) / 1000)
                await sock.sendMessage(from, {
                    text: fmt.box('RUNTIME', [
                        `⏱ *Uptime:* ${d}d ${h}h ${m2}m ${s2}s`,
                        `🚀 *Bot:* ${config.botName}`,
                        `🌐 *Mode:* ${(config.mode || 'public').toUpperCase()}`,
                    ])
                }, { quoted: msg })
                break
            }

            // ════ BOT STATUS ══════════════════════════════════════════════════
            case 'botstatus': case 'status': {
                const os = require('os')
                const t  = os.totalmem(), u = t - os.freemem()
                const pct = Math.round((u / t) * 100)
                const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10))
                await sock.sendMessage(from, {
                    text: fmt.box('BOT STATUS', [
                        `✅ *Status:* Online`,
                        `🌐 *Mode:* ${(config.mode || 'public').toUpperCase()}`,
                        `🤖 *Chatbot:* ${chatBrain.getState().scope.toUpperCase()}`,
                        `👁️ *Auto-view status:* ${runtimeSettings.autoviewstatus ? 'ON' : 'OFF'}`,
                        `📵 *Anti-call:* ${runtimeSettings.anticall ? 'ON' : 'OFF'}`,
                        `💾 *RAM:* ${Math.round(u / 1024 / 1024)}MB / ${(t / 1024 / 1024 / 1024).toFixed(1)}GB [${bar}] ${pct}%`,
                    ])
                }, { quoted: msg })
                break
            }

            // ════ MODE ════════════════════════════════════════════════════════
            case 'mode': {
                const newMode = q.toLowerCase()
                if (!['public', 'private'].includes(newMode)) {
                    return sock.sendMessage(from, {
                        text: fmt.box('MODE', [
                            `⚙️ *Current mode:* ${(config.mode || 'public').toUpperCase()}`,
                            ``,
                            `Usage: *${prefix}mode public* OR *${prefix}mode private*`,
                        ])
                    }, { quoted: msg })
                }
                config.mode = newMode
                settings.set('mode', newMode)   // ← persist across restarts
                await sock.sendMessage(from, {
                    text: fmt.box('MODE CHANGED', [
                        `✅ Mode → *${newMode.toUpperCase()}*`,
                        newMode === 'private' ? `🔒 Only you can use commands` : `🌐 Everyone can use commands`,
                    ])
                }, { quoted: msg })
                break
            }

            case 'modestatus':
                await sock.sendMessage(from, {
                    text: fmt.box('MODE STATUS', [`📊 Current mode: *${(config.mode || 'public').toUpperCase()}*`])
                }, { quoted: msg })
                break

            // ════ MY ID / WHO AM I ════════════════════════════════════════════
            case 'myid': case 'whoami': case 'userid': {
                const num = sender.split('@')[0]
                await sock.sendMessage(from, {
                    text: fmt.box('YOUR INFO', [
                        `📱 *Number:* ${num}`,
                        `🆔 *JID:* ${sender}`,
                        `👑 *Owner:* ${owner ? 'Yes ✅' : 'No'}`,
                        `🌐 *Source:* ${inGroup ? 'Group' : 'Private Chat'}`,
                    ])
                }, { quoted: msg })
                break
            }

            // ════ TIME (bot clock) — use .date for Ubuntu system date ══════════
            case 'time': case 'botdate': {
                const now = new Date()
                const nairobi = now.toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', dateStyle: 'full', timeStyle: 'medium' })
                await sock.sendMessage(from, {
                    text: fmt.box('DATE & TIME', [
                        `🗓️ *Nairobi:* ${nairobi}`,
                        `🌍 *UTC:* ${now.toISOString().replace('T', ' ').slice(0, 19)}`,
                    ])
                }, { quoted: msg })
                break
            }

            // ════ REPO ════════════════════════════════════════════════════════
            // Live GitHub stats card (stars/forks/watchers/size/issues) via
            // the public REST API — no token needed for a public repo, just
            // rate-limited to 60 req/hr per IP, which is plenty for a chat
            // command. Falls back to the old static text if the API call
            // fails (offline, rate-limited, repo renamed, etc).
            case 'repo': case 'source': {
                await fmt.react(sock, msg, '📦')
                const repoSlug = config.githubRepo
                const repoUrl  = `https://github.com/${repoSlug}`
                // Native Baileys button formats (templateButtons / legacy
                // buttons, toggled by config.repoButtonsLegacy) are kept only
                // as a last-resort fallback — the previous dev's own notes
                // (and testing on this exact account) confirm neither reliably
                // renders. spencer-btns is the mechanism actually proven to
                // render on this account (the .pair Copy Code button), so
                // that's the primary path below.
                const useLegacy = !!config.repoButtonsLegacy
                const templateButtons = useLegacy ? undefined : [
                    { index: 1, quickReplyButton: { displayText: '📋 Copy Link', id: `${config.prefix}repolink` } },
                    { index: 2, urlButton: { displayText: '🔗 Visit Repo', url: repoUrl } },
                    { index: 3, urlButton: { displayText: '📢 WaChannel', url: config.whatsappChannelUrl } },
                ]
                const buttons = useLegacy ? [
                    { buttonId: `${config.prefix}repolink`, buttonText: { displayText: '📋 Copy Link' }, type: 1 },
                    { buttonId: `${config.prefix}repolink`, buttonText: { displayText: '🔗 Repo Link' }, type: 1 },
                    { buttonId: `${config.prefix}repochannel`, buttonText: { displayText: '📢 WaChannel' }, type: 1 },
                ] : undefined
                const buttonOpts = useLegacy ? { buttons, headerType: 1 } : { templateButtons }
                const mod = await loadBtns()
                const spencerButtons = btnsReady() ? [
                    mod.btn.copy('📋 Copy Link', repoUrl),
                    mod.btn.url('🔗 Repository', repoUrl),
                    ...(config.whatsappChannelUrl ? [mod.btn.url('📢 WaChannel', config.whatsappChannelUrl)] : []),
                ] : null
                try {
                    const res = await fetch(`https://api.github.com/repos/${repoSlug}`, {
                        headers: { 'User-Agent': config.botName || 'vanta-bot' },
                        signal: AbortSignal.timeout(10000),
                    })
                    if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`)
                    const r = await res.json()

                    // The raw link line is only needed when there's no
                    // Repository button to tap instead — otherwise it's just
                    // a duplicate of what the button already opens.
                    const captionLines = [
                        `✦ Repository:  ${r.name}`,
                        `✦ Owner:       ${r.owner?.login || repoSlug.split('/')[0]}`,
                        `✦ Description: ${r.description || 'No description.'}`,
                        `✦ Language:    ${r.language || 'N/A'}`,
                        `✦ License:     ${r.license?.spdx_id || 'N/A'}`,
                        `✦ Branch:      ${r.default_branch}`,
                        `✦ Visibility:  ${r.private ? '🔒 Private' : '🔓 Public'}`,
                        ``,
                        `⬛ *STATISTICS*`,
                        `▫ Stars:    ${r.stargazers_count}`,
                        `▫ Forks:    ${r.forks_count}`,
                        `▫ Watchers: ${r.watchers_count}`,
                        `▫ Size:     ${(r.size / 1024).toFixed(2)} MB`,
                        `▫ Issues:   ${r.open_issues_count}`,
                        ``,
                        `_Powered by ${config.botName}_`,
                        ``,
                        `👋 Hey @${mentionName(msg, sender)}! Don't forget to ⭐ fork and star the repo!`,
                    ]
                    if (!spencerButtons) captionLines.push(`🔗 ${repoUrl}`)
                    const caption = fmt.box('REPOSITORY', captionLines)
                    const repoMentions = [sender]

                    const fs = require('fs'), path = require('path')
                    const bannerPath = path.join(__dirname, 'assets/banner.png')
                    const hasBanner = fs.existsSync(bannerPath)
                    if (spencerButtons) {
                        // Try ONE combined message (banner + caption + buttons)
                        // first — only split into two if spencer-btns rejects
                        // the image field, so it degrades instead of breaking.
                        let sent = false
                        if (hasBanner) {
                            try {
                                await mod.sendButtons(sock, from, {
                                    image: fs.readFileSync(bannerPath),
                                    text: caption,
                                    footer: config.botName,
                                    buttons: spencerButtons,
                                    mentions: repoMentions,
                                }, { quoted: msg })
                                sent = true
                            } catch (e2) {
                                console.log('[repo] combined image+buttons send failed, falling back:', e2.message)
                            }
                        }
                        if (!sent) {
                            if (hasBanner) {
                                await sock.sendMessage(from, { image: fs.readFileSync(bannerPath), caption, mentions: repoMentions }, { quoted: msg })
                            }
                            await mod.sendButtons(sock, from, {
                                text: hasBanner ? `Tap below —` : caption,
                                footer: config.botName,
                                buttons: spencerButtons,
                                mentions: repoMentions,
                            }, hasBanner ? undefined : { quoted: msg })
                        }
                    } else if (hasBanner) {
                        await sock.sendMessage(from, { image: fs.readFileSync(bannerPath), caption, footer: config.botName, mentions: repoMentions, ...buttonOpts }, { quoted: msg })
                    } else {
                        await sock.sendMessage(from, { text: caption, footer: config.botName, mentions: repoMentions, ...buttonOpts }, { quoted: msg })
                    }
                } catch (e) {
                    // Fallback: same static card the command used to show.
                    const fallbackText = fmt.box('REPO', [
                        `🤖 *${config.botName}*`,
                        `👤 Owner: ${config.ownerName}`,
                        ``,
                        `🔗 ${repoUrl}`,
                        `_Custom WhatsApp bot built with Baileys_`,
                        ``,
                        `_(live stats unavailable: ${e.message.slice(0, 80)})_`,
                    ])
                    if (spencerButtons) {
                        await mod.sendButtons(sock, from, { text: fallbackText, footer: config.botName, buttons: spencerButtons }, { quoted: msg })
                    } else {
                        await sock.sendMessage(from, { text: fallbackText, footer: config.botName, ...buttonOpts }, { quoted: msg })
                    }
                }
                break
            }

            // Fired when someone taps the "WaChannel" quick-reply button on
            // `.repo` in legacy-buttons mode (config.repoButtonsLegacy) —
            // sends the channel link as its own plain-text message, same
            // reasoning as `repolink` below.
            // Owner-only diagnostic: sends the absolute simplest possible
            // buttons message — plain text, no image, no caption, no fmt.box
            // wrapping — to isolate whether the problem is buttons+image
            // specifically, or buttons not rendering at all regardless of
            // what they're attached to. Not a real feature, just a probe.
            // Safe to remove once buttons are sorted out (or given up on).
            case 'btntest': {
                await sock.sendMessage(from, {
                    text: 'plain text buttons test',
                    footer: 'test',
                    templateButtons: [
                        { index: 1, quickReplyButton: { displayText: 'Test Button', id: `${config.prefix}btntestreply` } },
                    ],
                }, { quoted: msg })
                break
            }
            case 'btntestreply': {
                await sock.sendMessage(from, { text: 'button tap received ✅' }, { quoted: msg })
                break
            }

            case 'repochannel': {
                await sock.sendMessage(from, { text: config.whatsappChannelUrl }, { quoted: msg })
                break
            }

            // Fired when someone taps the "Copy Link" quick-reply button on
            // `.repo` — replies with just the bare URL, its own message, so
            // it's a single long-press away from being copied (unlike the
            // link buried inside the stats card above it).
            case 'repolink': {
                await sock.sendMessage(from, { text: `https://github.com/${config.githubRepo}` }, { quoted: msg })
                break
            }

            // ════ SESSION PAIRING ════════════════════════════════════════════
            // Talks to the standalone pairing microservice (server.js from the
            // ZACHARIAH project): POST a number → jobId, then poll status until
            // a pairing code appears, then until it's linked. Lets someone get
            // a fresh session ID entirely through chat instead of visiting the
            // site directly.
            case 'pair': {
                const number = (q || '').replace(/[^0-9]/g, '')
                if (!number || number.length < 8) {
                    return sock.sendMessage(from, {
                        text: fmt.usage('pair', '<phone number with country code, digits only>')
                    }, { quoted: msg })
                }

                await fmt.react(sock, msg, '🔗')
                try {
                    const startRes = await fetch(`${config.pairingSiteUrl}/api/pair`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ number }),
                        signal: AbortSignal.timeout(20000),
                    })
                    const startData = await startRes.json()
                    if (!startRes.ok || !startData.jobId) throw new Error(startData.error || `Pairing site HTTP ${startRes.status}`)

                    await sock.sendMessage(from, {
                        text: fmt.box('PAIRING STARTED', [
                            `📱 Number: *${number}*`,
                            `⏳ Requesting a pairing code — this can take up to 30 seconds...`,
                        ])
                    }, { quoted: msg })

                    // Poll for the code, then for the final linked session —
                    // same two-phase flow the site's own frontend uses.
                    // 3 minutes total: finding WhatsApp → Linked Devices →
                    // Link a Device → "Link with phone number instead" → typing
                    // an 8-character code takes real people longer than the
                    // 90s this used to allow, which is why it kept timing out
                    // right after successfully showing a valid code.
                    let sentCode = false
                    const deadline = Date.now() + 180_000
                    while (Date.now() < deadline) {
                        await new Promise(r => setTimeout(r, 3000))
                        const statusRes = await fetch(`${config.pairingSiteUrl}/api/status/${startData.jobId}`, { signal: AbortSignal.timeout(15000) })
                        const job = await statusRes.json()

                        if (job.status === 'code_ready' && job.code && !sentCode) {
                            sentCode = true
                            const codeLines = [
                                `🔑 Code: *${job.code}*`,
                                ``,
                                `On the phone for *${number}*:`,
                                `WhatsApp → Linked Devices → Link a Device → Link with phone number instead → enter this code.`,
                            ]
                            const mod = await loadBtns()
                            if (btnsReady()) {
                                await mod.sendButtons(sock, from, {
                                    text: `*PAIRING CODE READY*\n\n${codeLines.join('\n')}`,
                                    footer: `${config.botName} • ${config.ownerName}`,
                                    buttons: [
                                        mod.btn.copy('📋 Copy Code', job.code),
                                        ...(config.ownerNumber ? [mod.btn.url('💬 Contact Owner', `https://wa.me/${config.ownerNumber}`)] : []),
                                    ],
                                }, { quoted: msg })
                            } else {
                                await sock.sendMessage(from, { text: fmt.box('PAIRING CODE READY', codeLines) }, { quoted: msg })
                            }
                        } else if (job.status === 'linked' && job.sessionId) {
                            return sock.sendMessage(from, {
                                text: fmt.box('✅ PAIRED SUCCESSFULLY', [
                                    `A session ID has been sent directly to *${number}* on WhatsApp.`,
                                    `Use that as SESSION_ID in that deployment's .env.`,
                                ])
                            }, { quoted: msg })
                        } else if (job.status === 'error') {
                            throw new Error(job.error || 'Pairing failed')
                        }
                    }
                    throw new Error('Timed out waiting for pairing to complete — try again')
                } catch (e) {
                    await sock.sendMessage(from, {
                        text: fmt.box('PAIRING FAILED', [`❌ ${e.message}`, `💡 Or visit ${config.pairingSiteUrl} directly.`])
                    }, { quoted: msg })
                }
                break
            }

                        // ════ SMART KALI SHORTCUTS ══════════════════════════════════════════
            case 'scan': {
                await handleScan(sock, from, q, msg)
                break
            }
            case 'webcheck': {
                await handleWebcheck(sock, from, q, msg)
                break
            }
            case 'recon': {
                await handleRecon(sock, from, q, msg)
                break
            }
            case 'osint': {
                await handleOsint(sock, from, q, msg)
                break
            }
            case 'sqli': {
                await handleSqli(sock, from, q, msg)
                break
            }
            case 'crack': {
                await handleCrack(sock, from, q, msg)
                break
            }
            case 'brute': {
                await handleBrute(sock, from, q, msg)
                break
            }
            case 'kaliip': {
                await handleMyIp(sock, from, msg)
                break
            }
            case 'kalisysinfo': {
                await handleSysinfo(sock, from, msg)
                break
            }
            case 'ports': {
                await handlePorts(sock, from, q, msg)
                break
            }

// ════ KALI TERMINAL ═════════════════════════════════════════════════
            case 'kali': {
                await handleKali(sock, from, q, msg)
                break
            }
            case 'tools': {
                await handleTools(sock, from, q, msg)
                break
            }
            case 'kalicmds': {
                const sorted = [...KALI_LINUX_CMDS].sort()
                const rows = []
                for (let i = 0; i < sorted.length; i += 4) rows.push(sorted.slice(i, i + 4).map(c => c.padEnd(14)).join(''))
                await sock.sendMessage(from, {
                    text: fmt.box(`🐉 KALI/LINUX SHORTCUTS (${sorted.length})`, [
                        `\`\`\`${rows.join('\n')}\`\`\``,
                        ``,
                        `Run any of these directly, e.g. ${config.prefix}nmap -sV target`,
                        `Or run any tool by name: ${config.prefix}kali <tool> [options]`,
                    ])
                }, { quoted: msg })
                break
            }
            case 'toolinstall': {
                await handleToolInstall(sock, from, q, msg)
                break
            }
            case 'searchsploit': {
                await handleSearchSploit(sock, from, q, msg)
                break
            }
            case 'msfuse': {
                await handleMsfuse(sock, from, q, msg)
                break
            }
            case 'hashid': {
                await handleHashId(sock, from, q, msg)
                break
            }
            case 'geoip': {
                await handleGeoip(sock, from, q, msg)
                break
            }
            case 'banner': {
                await handleBanner(sock, from, q, msg)
                break
            }

            // ════ UBUNTU LINUX ═══════════════════════════════════════════════
            case 'ub': case 'ubuntu': {
                await handleUbuntu(sock, from, q, msg)
                break
            }
            // ════ KALI DIRECT SHELL ══════════════════════════════════════════
            case 'kl': {
                await handleKaliShell(sock, from, q, msg)
                break
            }

            // ════ FILE SYSTEM ════════════════════════════════════════════════
            case 'files': {
                await handleFiles(sock, from, q, msg)
                break
            }
            case 'cat': {
                await handleCat(sock, from, q, msg)
                break
            }
            case 'find': {
                await handleFind(sock, from, q, msg)
                break
            }
            case 'grep': {
                await handleGrep(sock, from, q, msg)
                break
            }
            case 'chmod': {
                await handleChmod(sock, from, q, msg)
                break
            }
            case 'wgetfile': {
                await handleDownloadFile(sock, from, q, msg)
                break
            }
            case 'tar': {
                await handleTar(sock, from, q, msg)
                break
            }

            // ════ PROCESSES ══════════════════════════════════════════════════
            case 'proc': {
                await handleProc(sock, from, q, msg)
                break
            }
            case 'killit': {
                await handleKillProc(sock, from, q, msg)
                break
            }
            case 'jobs': {
                await handleJobs(sock, from, q, msg)
                break
            }

            // ════ SYSTEM INFO ════════════════════════════════════════════════
            case 'sysinfo2': case 'ubsysinfo': {
                await handleSysInfo(sock, from, q, msg)
                break
            }
            case 'kalisysinfo2': {
                await handleKaliSysInfo(sock, from, q, msg)
                break
            }
            case 'mem': {
                await handleMem(sock, from, q, msg)
                break
            }
            case 'disk2': case 'storage': {
                await handleDisk(sock, from, q, msg)
                break
            }
            case 'cpu': {
                await handleCpu(sock, from, q, msg)
                break
            }
            case 'ubuptime': {
                await handleUptime(sock, from, q, msg)
                break
            }
            case 'ubwhoami': {
                await handleWhoami(sock, from, q, msg)
                break
            }
            case 'uname': {
                await handleUname(sock, from, q, msg)
                break
            }
            case 'hostname': {
                await handleHostname(sock, from, q, msg)
                break
            }
            case 'users': {
                await handleUsers(sock, from, q, msg)
                break
            }
            case 'ubenv': {
                await handleEnv(sock, from, q, msg)
                break
            }
            case 'services': {
                await handleServices(sock, from, q, msg)
                break
            }
            case 'logs': {
                await handleLogs(sock, from, q, msg)
                break
            }
            case 'cron': {
                await handleCron(sock, from, q, msg)
                break
            }

            // ════ NETWORKING ═════════════════════════════════════════════════
            case 'netinfo': {
                await handleNetInfo(sock, from, q, msg)
                break
            }
            case 'myip2': case 'ipinfo': {
                await handleMyIpLinux(sock, from, q, msg)
                break
            }
            case 'listenports': {
                await handleListenPorts(sock, from, q, msg)
                break
            }
            case 'pinghost': {
                await handlePingCmd(sock, from, q, msg)
                break
            }
            case 'trace': {
                await handleTraceroute(sock, from, q, msg)
                break
            }
            case 'dig': {
                await handleDig(sock, from, q, msg)
                break
            }
            case 'whois': {
                await handleWhois(sock, from, q, msg)
                break
            }
            case 'fetch': {
                await handleCurlCmd(sock, from, q, msg)
                break
            }

            // ════ PACKAGE MANAGEMENT ═════════════════════════════════════════
            case 'pkg': {
                await handlePkg(sock, from, q, msg)
                break
            }
            case 'kpkg': {
                await handleKaliPkg(sock, from, q, msg)
                break
            }
            case 'tpkg': {
                await handleTermuxPkg(sock, from, q, msg)
                break
            }

            // ════ DISTRO MANAGEMENT ══════════════════════════════════════════
            case 'distros': {
                await handleDistroStatus(sock, from, q, msg)
                break
            }
            case 'termuxinfo': {
                await handleTermuxInfo(sock, from, q, msg)
                break
            }

            case 'sh': case 'shell': {
                await handleShell(sock, from, q, msg)
                break
            }

            // ════════════════════════════════════════════════════════════════════
            //  KALI SECURITY TOOLS — dedicated per-tool commands
            // ════════════════════════════════════════════════════════════════════

            // ── Port scanning ──────────────────────────────────────────────────
            case 'nmap':         { await handleNmap(sock, from, q, msg);        break }
            case 'masscan':      { await handleMasscan(sock, from, q, msg);     break }

            // ── Web scanning ───────────────────────────────────────────────────
            case 'nikto':        { await handleNikto(sock, from, q, msg);       break }
            case 'whatweb':      { await handleWhatweb(sock, from, q, msg);     break }
            case 'gobuster':     { await handleGobuster(sock, from, q, msg);    break }
            case 'dirb':         { await handleDirb(sock, from, q, msg);        break }
            case 'wfuzz':        { await handleWfuzz(sock, from, q, msg);       break }
            case 'ffuf':         { await handleFfuf(sock, from, q, msg);        break }
            case 'wpscan':       { await handleWpscan(sock, from, q, msg);      break }
            case 'enum4linux':   { await handleEnum4linux(sock, from, q, msg);  break }

            // ── Password attacks ───────────────────────────────────────────────
            case 'hydra':        { await handleHydra(sock, from, q, msg);       break }
            case 'john':         { await handleJohn(sock, from, q, msg);        break }
            case 'hashcat':      { await handleHashcat(sock, from, q, msg);     break }
            case 'medusa':       { await handleMedusa(sock, from, q, msg);      break }
            case 'crunch':       { await handleCrunch(sock, from, q, msg);      break }
            case 'hashid2':      { await handleHashid(sock, from, q, msg);      break }

            // ── SQL injection ──────────────────────────────────────────────────
            case 'sqlmap':       { await handleSqlmap(sock, from, q, msg);      break }

            // ── DNS & recon ────────────────────────────────────────────────────
            case 'dnsrecon':     { await handleDnsrecon(sock, from, q, msg);    break }
            case 'dnsenum':      { await handleDnsenum(sock, from, q, msg);     break }
            case 'fierce':       { await handleFierce(sock, from, q, msg);      break }
            case 'subfinder':    { await handleSubfinder(sock, from, q, msg);   break }
            case 'amass':        { await handleAmass(sock, from, q, msg);       break }

            // ── OSINT ──────────────────────────────────────────────────────────
            case 'sherlock':     { await handleSherlock(sock, from, q, msg);    break }
            case 'harvester':    { await handleHarvester(sock, from, q, msg);   break }
            case 'geoip2':       { await handleGeoipKali(sock, from, q, msg);   break }

            // ── Wireless ───────────────────────────────────────────────────────
            case 'airmon':       { await handleAirmon(sock, from, q, msg);      break }
            case 'airodump':     { await handleAirodump(sock, from, q, msg);    break }
            case 'aireplay':     { await handleAireplay(sock, from, q, msg);    break }
            case 'aircrack':     { await handleAircrack(sock, from, q, msg);    break }
            case 'wifite':       { await handleWifite(sock, from, q, msg);      break }
            case 'reaver':       { await handleReaver(sock, from, q, msg);      break }

            // ── Exploitation ───────────────────────────────────────────────────
            case 'searchsploit2': { await handleSearchsploit(sock, from, q, msg); break }
            case 'msfvenom':     { await handleMsfvenom(sock, from, q, msg);    break }
            case 'msf':          { await handleMsf(sock, from, q, msg);         break }

            // ── Forensics ──────────────────────────────────────────────────────
            case 'binwalk':      { await handleBinwalk(sock, from, q, msg);     break }
            case 'strings':      { await handleStrings(sock, from, q, msg);     break }
            case 'exiftool':     { await handleExiftool(sock, from, q, msg);    break }
            case 'steghide':     { await handleSteghide(sock, from, q, msg);    break }
            case 'foremost':     { await handleForemost(sock, from, q, msg);    break }
            case 'hexdump':      { await handleHexdump(sock, from, q, msg);     break }
            case 'xxd':          { await handleXxd(sock, from, q, msg);         break }
            case 'filetype':     { await handleFile(sock, from, q, msg);        break }
            case 'md5sum':       { await handleMd5sum(sock, from, q, msg);      break }
            case 'sha256sum':    { await handleSha256sum(sock, from, q, msg);   break }

            // ── Network (Kali) ─────────────────────────────────────────────────
            case 'nc':           { await handleNc(sock, from, q, msg);          break }
            case 'tcpdump':      { await handleTcpdump(sock, from, q, msg);     break }

            // ════════════════════════════════════════════════════════════════════
            //  UBUNTU/LINUX COMMANDS — dedicated per-tool commands
            // ════════════════════════════════════════════════════════════════════

            // ── File management ────────────────────────────────────────────────
            case 'ls':           { await handleLs(sock, from, q, msg);          break }
            case 'head':         { await handleHead(sock, from, q, msg);        break }
            case 'tail':         { await handleTail(sock, from, q, msg);        break }
            case 'mkdir':        { await handleMkdir(sock, from, q, msg);       break }
            case 'rmfile':       { await handleRmfile(sock, from, q, msg);      break }
            case 'cpfile':       { await handleCpfile(sock, from, q, msg);      break }
            case 'mvfile':       { await handleMvfile(sock, from, q, msg);      break }
            case 'touch':        { await handleTouch(sock, from, q, msg);       break }
            case 'chown':        { await handleChown(sock, from, q, msg);       break }
            case 'findfile':     { await handleFindLinux(sock, from, q, msg);   break }
            case 'grepfile':     { await handleGrepLinux(sock, from, q, msg);   break }
            case 'du':           { await handleDu(sock, from, q, msg);          break }
            case 'stat':         { await handleStat(sock, from, q, msg);        break }
            case 'wc':           { await handleWc(sock, from, q, msg);          break }
            case 'sortfile':     { await handleSortfile(sock, from, q, msg);    break }
            case 'uniq':         { await handleUniq(sock, from, q, msg);        break }
            case 'diff':         { await handleDiff(sock, from, q, msg);        break }

            // ── Archives ───────────────────────────────────────────────────────
            case 'extract':      { await handleExtract(sock, from, q, msg);     break }
            case 'zipfile':      { await handleZipfile(sock, from, q, msg);     break }
            case 'gzip':         { await handleGzip(sock, from, q, msg);        break }
            case 'gunzip':       { await handleGunzip(sock, from, q, msg);      break }

            // ── Download ───────────────────────────────────────────────────────
            case 'wget':         { await handleWgetLinux(sock, from, q, msg);   break }
            case 'curlget':      { await handleCurlget(sock, from, q, msg);     break }

            // ── System info ────────────────────────────────────────────────────
            case 'sysinfo':      { await handleSysinfoLinux(sock, from, q, msg); break }
            case 'uptime':       { await handleUptimeLinux(sock, from, q, msg); break }
            case 'free':         { await handleFree(sock, from, q, msg);        break }
            case 'df':           { await handleDf(sock, from, q, msg);          break }
            case 'lscpu':        { await handleLscpu(sock, from, q, msg);       break }
            case 'lsblk':        { await handleLsblk(sock, from, q, msg);       break }
            case 'uname2':       { await handleUnameLinux(sock, from, q, msg);  break }
            case 'hostname2':    { await handleHostnameLinux(sock, from, q, msg); break }
            case 'whoami2':      { await handleWhoamiLinux(sock, from, q, msg); break }
            case 'date':         { await handleDate(sock, from, q, msg);        break }
            case 'env2':         { await handleEnvLinux(sock, from, q, msg);    break }
            case 'users2':       { await handleUsersLinux(sock, from, q, msg);  break }

            // ── Processes ──────────────────────────────────────────────────────
            case 'ps':           { await handlePs(sock, from, q, msg);          break }
            case 'topcmd':       { await handleTop(sock, from, q, msg);         break }
            case 'kill':         { await handleKill(sock, from, q, msg);        break }
            case 'pkill':        { await handlePkill(sock, from, q, msg);       break }
            case 'pgrep':        { await handlePgrep(sock, from, q, msg);       break }
            case 'jobs2':        { await handleJobsLinux(sock, from, q, msg);   break }

            // ── Networking (Ubuntu) ────────────────────────────────────────────
            case 'ping2':        { await handlePing(sock, from, q, msg);        break }
            case 'traceroute':   { await handleTracerouteLinux(sock, from, q, msg); break }
            case 'dig2':         { await handleDigLinux(sock, from, q, msg);    break }
            case 'nslookup':     { await handleNslookup(sock, from, q, msg);    break }
            case 'whois2':       { await handleWhoisLinux(sock, from, q, msg);  break }
            case 'curl':         { await handleCurl(sock, from, q, msg);        break }
            case 'netstat':      { await handleNetstat(sock, from, q, msg);     break }
            case 'ss':           { await handleSs(sock, from, q, msg);          break }
            case 'ifconfig':     { await handleIfconfig(sock, from, q, msg);    break }
            case 'ip':           { await handleIp(sock, from, q, msg);          break }
            case 'arp':          { await handleArp(sock, from, q, msg);         break }
            case 'myip':         { await handleMyip(sock, from, q, msg);        break }

            // ── Package managers ───────────────────────────────────────────────
            case 'apt':          { await handleApt(sock, from, q, msg);         break }
            case 'tpkg2':        { await handleTpkgNew(sock, from, q, msg);     break }

            // ── Direct install shortcuts ───────────────────────────────────────
            case 'kinstall':     { await handleKaliInstall(sock, from, q, msg);   break }
            case 'uinstall':     { await handleUbuntuInstall(sock, from, q, msg); break }

            // ════ NEWS MONITOR ════════════════════════════════════════════════
            case 'news': {
                await handleNewsCmd(sock, from, args, msg, owner)
                break
            }

            // ════ FEEDBACK ════════════════════════════════════════════════════
            case 'feedback': case 'report': {
                if (!q) return sock.sendMessage(from, { text: fmt.usage('feedback', '<your message>') }, { quoted: msg })
                const ownerJid = config.ownerNumber.replace(/\D/g,'') + '@s.whatsapp.net'
                await sock.sendMessage(ownerJid, {
                    text: fmt.box('FEEDBACK', [
                        `📩 From: @${sender.split('@')[0]}`,
                        `📱 JID: ${sender}`,
                        ``,
                        `💬 *Message:*`,
                        q,
                    ])
                })
                await sock.sendMessage(from, { text: `✅ Feedback sent to owner! Thank you.` }, { quoted: msg })
                break
            }

            // ════ DEBUG OWNER ═════════════════════════════════════════════════
            case 'debugowner': {
                const { jidToNum, normNum } = require('./lib/utils')
                const sNum   = jidToNum(sender)
                const oNum   = normNum(config.ownerNumber)
                const bNum   = jidToNum(botJid)
                await sock.sendMessage(from, {
                    text: fmt.box('🔍 OWNER DEBUG', [
                        `*Your JID:*    ${sender}`,
                        `*Your number:* ${sNum}`,
                        fmt.divider(),
                        `*Bot JID:*     ${botJid}`,
                        `*Bot number:*  ${bNum}`,
                        fmt.divider(),
                        `*Config owner:*  ${config.ownerNumber}`,
                        `*Config number:* ${oNum}`,
                        fmt.divider(),
                        `*isOwner:*    ${owner ? '✅ YES' : '❌ NO'}`,
                        `*fromMe:*     ${msg.key?.fromMe ? 'true' : 'false'}`,
                        `*inGroup:*    ${inGroup ? 'true' : 'false'}`,
                        ``,
                        owner
                            ? `✅ _You are recognized as owner_`
                            : `❌ _Not recognized — set OWNER_NUMBER=${sNum} in env_`,
                    ])
                }, { quoted: msg })
                break
            }

            // ════ STICKER ═════════════════════════════════════════════════════
            case 'sticker': case 's':
                await makeSticker(sock, msg, from, q)
                break

            // ════ TO IMAGE ════════════════════════════════════════════════════
            case 'toimage': case 'toimg': {
                const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
                if (!quoted?.stickerMessage) {
                    return sock.sendMessage(from, { text: fmt.box('TO IMAGE', [`❌ Reply to a *sticker* with *${prefix}toimage*`]) }, { quoted: msg })
                }
                try {
                    await fmt.react(sock, msg, '⏳')
                    const { downloadMediaMessage } = require('@neoxr/baileys')
                    const silentLog = { level: 'silent', child: () => silentLog, info: () => {}, debug: () => {}, error: () => {}, warn: () => {}, trace: () => {} }
                    const buf = await downloadMediaMessage(
                        { message: quoted, key: msg.key }, 'buffer', {},
                        { logger: silentLog, reuploadRequest: sock.updateMediaMessage }
                    )
                    await sock.sendMessage(from, { image: buf, caption: `🖼️ Sticker converted to image` }, { quoted: msg })
                    await fmt.react(sock, msg, '✅')
                } catch (e) {
                    await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ ${e.message}`]) }, { quoted: msg })
                }
                break
            }

            // ════ VIEW ONCE REVEAL ════════════════════════════════════════════
            case 'vv': case 'reveal': {
                const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
                const vMsg   = extractViewOnce(quoted)
                if (!vMsg) return sock.sendMessage(from, { text: fmt.box('REVEAL', [`❌ Reply to a *view-once* message with *${prefix}vv*`]) }, { quoted: msg })
                try {
                    await fmt.react(sock, msg, '⏳')
                    const { downloadMediaMessage } = require('@neoxr/baileys')
                    const silentLog = { level: 'silent', child: () => silentLog, info: () => {}, debug: () => {}, error: () => {}, warn: () => {}, trace: () => {} }
                    const buf = await downloadMediaMessage(
                        { message: vMsg, key: msg.key }, 'buffer', {},
                        { logger: silentLog, reuploadRequest: sock.updateMediaMessage }
                    )
                    const mtype = Object.keys(vMsg)[0]
                    if (mtype === 'imageMessage') {
                        await sock.sendMessage(from, { image: buf, caption: `👁️ View-once revealed` }, { quoted: msg })
                    } else if (mtype === 'videoMessage') {
                        await sock.sendMessage(from, { video: buf, caption: `👁️ View-once revealed` }, { quoted: msg })
                    } else if (mtype === 'audioMessage') {
                        await sock.sendMessage(from, { audio: buf, mimetype: vMsg.audioMessage?.mimetype || 'audio/ogg; codecs=opus', ptt: !!vMsg.audioMessage?.ptt }, { quoted: msg })
                    }
                    await fmt.react(sock, msg, '✅')
                } catch (e) {
                    await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ ${e.message}`]) }, { quoted: msg })
                }
                break
            }

            // ════ SAVE (reply to a status/media with .save) ═════════════════════
            case 'save': {
                const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
                const mtype  = quoted ? Object.keys(quoted)[0] : null
                const isMedia = ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage'].includes(mtype)
                if (!quoted || !isMedia) {
                    return sock.sendMessage(from, { text: fmt.box('SAVE', [`❌ Reply to a *status* or media message with *${prefix}save*`]) }, { quoted: msg })
                }
                try {
                    await fmt.react(sock, msg, '⏳')
                    const { downloadMediaMessage } = require('@neoxr/baileys')
                    const silentLog = { level: 'silent', child: () => silentLog, info: () => {}, debug: () => {}, error: () => {}, warn: () => {}, trace: () => {} }
                    const buf = await downloadMediaMessage(
                        { message: quoted, key: msg.key }, 'buffer', {},
                        { logger: silentLog, reuploadRequest: sock.updateMediaMessage }
                    )
                    if (mtype === 'imageMessage') {
                        await sock.sendMessage(from, { image: buf, caption: `💾 Saved` }, { quoted: msg })
                    } else if (mtype === 'videoMessage') {
                        await sock.sendMessage(from, { video: buf, caption: `💾 Saved` }, { quoted: msg })
                    } else if (mtype === 'audioMessage') {
                        await sock.sendMessage(from, { audio: buf, mimetype: quoted.audioMessage?.mimetype || 'audio/ogg; codecs=opus', ptt: !!quoted.audioMessage?.ptt }, { quoted: msg })
                    } else if (mtype === 'stickerMessage') {
                        await sock.sendMessage(from, { sticker: buf }, { quoted: msg })
                    }
                    await fmt.react(sock, msg, '✅')
                } catch (e) {
                    await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ ${e.message}`]) }, { quoted: msg })
                }
                break
            }

            // ════ GET PROFILE PICTURE ═════════════════════════════════════════
            case 'getpp': case 'pfp': {
                const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
                const target    = mentioned[0] || sender
                try {
                    await fmt.react(sock, msg, '⏳')
                    const ppUrl = await sock.profilePictureUrl(target, 'image')
                    await sock.sendMessage(from, { image: { url: ppUrl }, caption: `🖼️ Profile picture of @${target.split('@')[0]}`, mentions: [target] }, { quoted: msg })
                    await fmt.react(sock, msg, '✅')
                } catch {
                    await sock.sendMessage(from, { text: fmt.box('NO PP', [`❌ No profile picture found for @${target.split('@')[0]}`]), mentions: [target] }, { quoted: msg })
                }
                break
            }

            // ════ GET ABOUT ═══════════════════════════════════════════════════
            case 'getabout': case 'about': {
                const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
                const target    = mentioned[0] || sender
                try {
                    const info = await sock.fetchStatus(target)
                    await sock.sendMessage(from, {
                        text: fmt.box('ABOUT', [
                            `👤 @${target.split('@')[0]}`,
                            ``,
                            `📝 _${info?.status || 'No status set'}_`,
                        ]),
                        mentions: [target]
                    }, { quoted: msg })
                } catch {
                    await sock.sendMessage(from, { text: fmt.box('ABOUT', [`❌ Could not fetch status`]) }, { quoted: msg })
                }
                break
            }

            // ════ DEVICE ══════════════════════════════════════════════════════
            case 'device': {
                const os = require('os')
                await sock.sendMessage(from, {
                    text: fmt.box('HOST INFO', [
                        `🖥️ *Platform:* ${os.platform()} (${os.arch()})`,
                        `💾 *RAM:* ${Math.round((os.totalmem() - os.freemem()) / 1024 / 1024)}MB / ${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)}GB`,
                        `⚙️ *CPUs:* ${os.cpus().length}x ${os.cpus()[0]?.model?.trim().substring(0, 30)}`,
                        `⏱ *Uptime:* ${Math.floor(os.uptime() / 3600)}h ${Math.floor((os.uptime() % 3600) / 60)}m`,
                    ])
                }, { quoted: msg })
                break
            }

            // ════ WEATHER ═════════════════════════════════════════════════════
            case 'weather': {
                if (!q) return sock.sendMessage(from, { text: fmt.usage('weather', '<city>') }, { quoted: msg })
                try {
                    await fmt.react(sock, msg, '⏳')
                    const res  = await fetch(`https://wttr.in/${encodeURIComponent(q)}?format=j1`, { signal: AbortSignal.timeout(10000) })
                    const data = await res.json()
                    const cur  = data.current_condition?.[0]
                    const area = data.nearest_area?.[0]
                    if (!cur) throw new Error('No data')
                    const city = area?.areaName?.[0]?.value + ', ' + area?.country?.[0]?.value
                    await sock.sendMessage(from, {
                        text: fmt.box('WEATHER', [
                            `🌍 *${city}*`,
                            `🌡️ *Temp:* ${cur.temp_C}°C / ${cur.temp_F}°F  (Feels ${cur.FeelsLikeC}°C)`,
                            `☁️ *Condition:* ${cur.weatherDesc?.[0]?.value}`,
                            `💧 *Humidity:* ${cur.humidity}%`,
                            `💨 *Wind:* ${cur.windspeedKmph} km/h ${cur.winddir16Point}`,
                            `👁️ *Visibility:* ${cur.visibility} km`,
                        ])
                    }, { quoted: msg })
                } catch (e) {
                    await sock.sendMessage(from, { text: fmt.box('WEATHER', [`❌ Could not fetch weather for *${q}*`]) }, { quoted: msg })
                }
                break
            }

            // ════ DEFINE (DICTIONARY) ═════════════════════════════════════════
            case 'define': case 'dict': case 'meaning': {
                if (!q) return sock.sendMessage(from, { text: fmt.usage('define', '<word>') }, { quoted: msg })
                try {
                    await fmt.react(sock, msg, '⏳')
                    const res  = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(10000) })
                    const data = await res.json()
                    if (!Array.isArray(data)) throw new Error('Not found')
                    const entry   = data[0]
                    const meaning = entry.meanings?.[0]
                    const def     = meaning?.definitions?.[0]
                    await sock.sendMessage(from, {
                        text: fmt.box('DICTIONARY', [
                            `📖 *${entry.word}*`,
                            entry.phonetic ? `🔤 *Phonetic:* ${entry.phonetic}` : null,
                            ``,
                            `📝 *${meaning?.partOfSpeech}:*`,
                            def?.definition,
                            def?.example ? `\n💡 _Example: "${def.example}"_` : null,
                            meaning?.synonyms?.length ? `\n🔁 *Synonyms:* ${meaning.synonyms.slice(0, 5).join(', ')}` : null,
                        ].filter(Boolean))
                    }, { quoted: msg })
                } catch {
                    await sock.sendMessage(from, { text: fmt.box('NOT FOUND', [`❌ No definition found for: *${q}*`]) }, { quoted: msg })
                }
                break
            }

            // ════ TRANSLATE ═══════════════════════════════════════════════════
            case 'translate': case 'tr': {
                if (!q) return sock.sendMessage(from, { text: fmt.usage('translate', '<lang> <text>\nExample: .translate fr Hello world') }, { quoted: msg })
                const [lang, ...rest] = args
                const text = rest.join(' ')
                if (!text) return sock.sendMessage(from, { text: fmt.usage('translate', '<lang> <text>') }, { quoted: msg })
                try {
                    await fmt.react(sock, msg, '⏳')
                    const res  = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${encodeURIComponent(lang)}`, { signal: AbortSignal.timeout(12000) })
                    const data = await res.json()
                    const translated = data.responseData?.translatedText
                    if (!translated || translated.toLowerCase() === text.toLowerCase()) throw new Error('Translation failed')
                    await sock.sendMessage(from, {
                        text: fmt.box('TRANSLATE', [
                            `🔤 *Original:* ${text}`,
                            `🌐 *Language:* ${lang.toUpperCase()}`,
                            `✅ *Translated:* ${translated}`,
                        ])
                    }, { quoted: msg })
                } catch {
                    await sock.sendMessage(from, { text: fmt.box('TRANSLATE', [`❌ Translation failed. Try language codes like: en, fr, es, ar, sw, de, zh`]) }, { quoted: msg })
                }
                break
            }

            // ════ CALCULATE ═══════════════════════════════════════════════════
            case 'calc': case 'calculate': case 'math': {
                if (!q) return sock.sendMessage(from, { text: fmt.usage('calc', '<expression>\nExample: .calc 2+2*10') }, { quoted: msg })
                try {
                    const safe = q.replace(/[^0-9+\-*/().%\s^]/g, '')
                    if (!safe) throw new Error('Invalid expression')
                    // eslint-disable-next-line no-eval
                    const result = Function('"use strict"; return (' + safe + ')')()
                    await sock.sendMessage(from, {
                        text: fmt.box('CALCULATOR', [`🧮 *${q}* = *${result}*`])
                    }, { quoted: msg })
                } catch {
                    await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Invalid expression: *${q}*`]) }, { quoted: msg })
                }
                break
            }

            // ════ QR CODE ═════════════════════════════════════════════════════
            case 'qr': case 'qrcode': {
                if (!q) return sock.sendMessage(from, { text: fmt.usage('qr', '<text or URL>') }, { quoted: msg })
                try {
                    await fmt.react(sock, msg, '⏳')
                    const url = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(q)}&format=png`
                    await sock.sendMessage(from, { image: { url }, caption: `📷 QR Code for:\n_${q}_` }, { quoted: msg })
                    await fmt.react(sock, msg, '✅')
                } catch {
                    await sock.sendMessage(from, { text: fmt.box('ERROR', ['❌ Could not generate QR code']) }, { quoted: msg })
                }
                break
            }

            // ════ TINY URL ════════════════════════════════════════════════════
            case 'tinyurl': case 'shorten': case 'shorturl': {
                if (!q) return sock.sendMessage(from, { text: fmt.usage('tinyurl', '<URL>') }, { quoted: msg })
                try {
                    await fmt.react(sock, msg, '⏳')
                    const res  = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(10000) })
                    const short = await res.text()
                    if (!short.startsWith('http')) throw new Error('Failed')
                    await sock.sendMessage(from, {
                        text: fmt.box('URL SHORTENER', [`🔗 *Original:* ${q}`, `✅ *Short:* ${short}`])
                    }, { quoted: msg })
                } catch {
                    await sock.sendMessage(from, { text: fmt.box('ERROR', ['❌ Could not shorten URL']) }, { quoted: msg })
                }
                break
            }

            // ════ GENERATE PASSWORD ═══════════════════════════════════════════
            case 'genpass': case 'password': {
                const len = Math.min(Math.max(parseInt(q) || 16, 8), 64)
                const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%^&*'
                let pass = ''
                for (let i = 0; i < len; i++) pass += chars[Math.floor(Math.random() * chars.length)]
                await sock.sendMessage(from, {
                    text: fmt.box('PASSWORD GENERATOR', [
                        `🔐 *Generated Password (${len} chars):*`,
                        `\`${pass}\``,
                        ``,
                        `⚠️ _Copy and save it — it won't be shown again_`,
                    ])
                }, { quoted: msg })
                break
            }

            // ════ FANCY TEXT ══════════════════════════════════════════════════
            case 'fancy': {
                if (!q) return sock.sendMessage(from, { text: fmt.usage('fancy', '<text>') }, { quoted: msg })
                const normal = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
                const bold   = '𝗮𝗯𝗰𝗱𝗲𝗳𝗴𝗵𝗶𝗷𝗸𝗹𝗺𝗻𝗼𝗽𝗾𝗿𝘀𝘁𝘂𝘃𝘄𝘅𝘆𝘇𝗔𝗕𝗖𝗗𝗘𝗙𝗚𝗛𝗜𝗝𝗞𝗟𝗠𝗡𝗢𝗣𝗤𝗥𝗦𝗧𝗨𝗩𝗪𝗫𝗬𝗭𝟬𝟭𝟮𝟯𝟰𝟱𝟲𝟳𝟴𝟵'
                const italic = '𝘢𝘣𝘤𝘥𝘦𝘧𝘨𝘩𝘪𝘫𝘬𝘭𝘮𝘯𝘰𝘱𝘲𝘳𝘴𝘵𝘶𝘷𝘸𝘹𝘺𝘻𝘈𝘉𝘊𝘋𝘌𝘍𝘎𝘏𝘐𝘑𝘒𝘓𝘔𝘕𝘖𝘗𝘘𝘙𝘚𝘛𝘜𝘝𝘞𝘟𝘠𝘡0123456789'
                const toBold = t => t.split('').map(c => { const i = normal.indexOf(c); return i >= 0 ? bold[i] : c }).join('')
                const toItalic = t => t.split('').map(c => { const i = normal.indexOf(c); return i >= 0 ? italic[i] : c }).join('')
                await sock.sendMessage(from, {
                    text: fmt.box('FANCY TEXT', [
                        `🅱️ *Bold:* ${toBold(q)}`,
                        `📝 *Italic:* ${toItalic(q)}`,
                        `✨ *Spaces:* ${q.split('').join(' ')}`,
                    ])
                }, { quoted: msg })
                break
            }

            // ════ FLIP TEXT ═══════════════════════════════════════════════════
            case 'fliptext': case 'reverse': {
                if (!q) return sock.sendMessage(from, { text: fmt.usage('fliptext', '<text>') }, { quoted: msg })
                const reversed = q.split('').reverse().join('')
                await sock.sendMessage(from, {
                    text: fmt.box('FLIP TEXT', [`🔄 *Original:* ${q}`, `↩️ *Reversed:* ${reversed}`])
                }, { quoted: msg })
                break
            }

            // ════ SAY (TTS alternative) ═══════════════════════════════════════
            case 'say': {
                if (!q) return sock.sendMessage(from, { text: fmt.usage('say', '<text>') }, { quoted: msg })
                await sock.sendMessage(from, { text: `🗣️ _${q}_` }, { quoted: msg })
                break
            }

            // ════ AI COMMANDS ═════════════════════════════════════════════════
            case 'ai': case 'gpt': case 'ask': case 'bot': {
                if (!q) return sock.sendMessage(from, { text: fmt.usage(cmd, '<your question or request>') }, { quoted: msg })
                await aiReply(sock, from, q, msg)
                break
            }

            // .claude / .gemini / .deepseek pin the chain to start with that
            // specific provider (it still falls back to the others if that
            // one is unconfigured or fails) instead of always going through
            // the default Claude-first order.
            case 'claude': {
                if (!q) return sock.sendMessage(from, { text: fmt.usage('claude', '<question, or reply to an image>') }, { quoted: msg })
                await aiReply(sock, from, q, msg, { forceProvider: 'claude' })
                break
            }

            case 'gemini': {
                if (!q) return sock.sendMessage(from, { text: fmt.usage('gemini', '<question>') }, { quoted: msg })
                await aiReply(sock, from, q, msg, { forceProvider: 'gemini' })
                break
            }

            case 'deepseek': {
                if (!q) return sock.sendMessage(from, { text: fmt.usage('deepseek', '<question>') }, { quoted: msg })
                await aiReply(sock, from, q, msg, { forceProvider: 'deepseek' })
                break
            }

            case 'analyze': {
                if (!q) return sock.sendMessage(from, { text: fmt.usage('analyze', '<topic to analyze>') }, { quoted: msg })
                await aiReply(sock, from, `Give a detailed analysis of: ${q}`, msg)
                break
            }

            case 'code': {
                if (!q) return sock.sendMessage(from, { text: fmt.usage('code', '<describe what to code>') }, { quoted: msg })
                await aiReply(sock, from, `Write code for: ${q}`, msg)
                break
            }

            // .mycode reads this bot's *own real source files* as context —
            // different from .code, which just asks the AI to write new code.
            case 'mycode': case 'explaincode': case 'readcode': {
                await selfCodeReply(sock, from, q, msg)
                break
            }

            case 'story': {
                if (!q) return sock.sendMessage(from, { text: fmt.usage('story', '<story topic>') }, { quoted: msg })
                await aiReply(sock, from, `Write a short creative story about: ${q}`, msg)
                break
            }

            case 'recipe': {
                if (!q) return sock.sendMessage(from, { text: fmt.usage('recipe', '<dish name>') }, { quoted: msg })
                await aiReply(sock, from, `Give me a detailed recipe for: ${q}`, msg)
                break
            }

            case 'summarize': case 'summary': {
                if (!q) return sock.sendMessage(from, { text: fmt.usage('summarize', '<text to summarize>') }, { quoted: msg })
                await aiReply(sock, from, `Summarize this in bullet points: ${q}`, msg)
                break
            }

            case 'teach': {
                if (!q) return sock.sendMessage(from, { text: fmt.usage('teach', '<topic to learn>') }, { quoted: msg })
                await aiReply(sock, from, `Explain clearly and simply: ${q}`, msg)
                break
            }

            case 'generate': {
                if (!q) return sock.sendMessage(from, { text: fmt.usage('generate', '<idea>') }, { quoted: msg })
                await aiReply(sock, from, `Generate creative ideas for: ${q}`, msg)
                break
            }

            // ════ SEARCH ══════════════════════════════════════════════════════
            case 'lyrics': {
                if (!q) return sock.sendMessage(from, { text: fmt.usage('lyrics', '<artist - song title>') }, { quoted: msg })
                await fmt.react(sock, msg, '⏳')
                const result = await getLyrics(q)
                await sock.sendMessage(from, { text: result }, { quoted: msg })
                break
            }

            case 'imdb': case 'movie': {
                if (!q) return sock.sendMessage(from, { text: fmt.usage('imdb', '<movie title>') }, { quoted: msg })
                await fmt.react(sock, msg, '⏳')
                const result = await getIMDB(q)
                await sock.sendMessage(from, { text: result }, { quoted: msg })
                break
            }

            // Savage API-backed streaming search/details — separate from
            // .movie/.imdb above (that's a different provider/command
            // already in use, left untouched to avoid breaking it).
            case 'moviesearch': case 'streamsearch': {
                await searchMovies(sock, from, q, msg)
                break
            }
            case 'toprated': case 'topratedmovies': {
                await topRatedMovies(sock, from, args[0], msg)
                break
            }
            case 'moviedetails': {
                await movieDetails(sock, from, q, msg)
                break
            }

            case 'apk': {
                // ".apk telegram" or ".apk telegram 2" (2nd search result)
                const parts = q ? q.split(/\s+/) : []
                const lastIsIndex = parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])
                const index = lastIsIndex ? parts.pop() : 1
                const query = parts.join(' ')
                await downloadApk(sock, from, query, index, msg)
                break
            }

            case 'yts': case 'torrent': {
                if (!q) return sock.sendMessage(from, { text: fmt.usage('yts', '<movie title>') }, { quoted: msg })
                await fmt.react(sock, msg, '⏳')
                const result = await getYTS(q)
                await sock.sendMessage(from, { text: result }, { quoted: msg })
                break
            }

            case 'wallpaper': case 'wp': {
                if (!q) return sock.sendMessage(from, { text: fmt.usage('wallpaper', '<keyword>') }, { quoted: msg })
                await fmt.react(sock, msg, '⏳')
                await getWallpaper(sock, from, q, msg)
                break
            }

            case 'gsmarena': {
                if (!q) return sock.sendMessage(from, { text: fmt.usage('gsmarena', '<phone model>') }, { quoted: msg })
                await fmt.react(sock, msg, '⏳')
                await aiReply(sock, from, `Give me the full specifications for the phone: ${q}. Format as a spec sheet with bullet points.`, msg)
                break
            }

            // ════ RELIGION ════════════════════════════════════════════════════
            case 'bible': {
                await fmt.react(sock, msg, '📖')
                const result = await getBible(q || 'John 3:16')
                await sock.sendMessage(from, { text: result }, { quoted: msg })
                break
            }

            case 'quran': {
                await fmt.react(sock, msg, '🕌')
                const result = await getQuran(q || '255')
                await sock.sendMessage(from, { text: result }, { quoted: msg })
                break
            }

            // ════ FUN ═════════════════════════════════════════════════════════
            case 'fact': case 'facts': {
                await fmt.react(sock, msg, '🌍')
                await sock.sendMessage(from, { text: fmt.box('RANDOM FACT', [rand(facts)]) }, { quoted: msg })
                break
            }

            case 'joke': case 'jokes': {
                await fmt.react(sock, msg, '😂')
                await sock.sendMessage(from, { text: rand(jokes) }, { quoted: msg })
                break
            }

            case 'quote': case 'quotes': {
                await fmt.react(sock, msg, '💬')
                await sock.sendMessage(from, { text: rand(quotes) }, { quoted: msg })
                break
            }

            case 'trivia': {
                await fmt.react(sock, msg, '🧠')
                const t = rand(trivia)
                await sock.sendMessage(from, {
                    text: fmt.box('TRIVIA', [`❓ *${t.q}*`, ``, `_Reply to guess! Answer in 30s..._`])
                }, { quoted: msg })
                setTimeout(async () => {
                    try { await sock.sendMessage(from, { text: fmt.box('ANSWER', [`✅ *${t.a}*`]) }) } catch {}
                }, 30000)
                break
            }

            case 'truth': {
                await fmt.react(sock, msg, '🤔')
                await sock.sendMessage(from, { text: fmt.box('TRUTH', [rand(truthQs)]) }, { quoted: msg })
                break
            }

            case 'dare': {
                await fmt.react(sock, msg, '🎯')
                await sock.sendMessage(from, { text: fmt.box('DARE', [rand(dares)]) }, { quoted: msg })
                break
            }

            case 'truthordare': case 'tod': {
                await fmt.react(sock, msg, '🎲')
                const isTruth = Math.random() < 0.5
                if (isTruth) {
                    await sock.sendMessage(from, { text: fmt.box('TRUTH', [rand(truthQs)]) }, { quoted: msg })
                } else {
                    await sock.sendMessage(from, { text: fmt.box('DARE', [rand(dares)]) }, { quoted: msg })
                }
                break
            }

            case 'truthdetector': {
                if (!q) return sock.sendMessage(from, { text: fmt.usage('truthdetector', '<statement>') }, { quoted: msg })
                const pct = Math.floor(Math.random() * 101)
                const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10))
                await sock.sendMessage(from, {
                    text: fmt.box('TRUTH DETECTOR 🔍', [
                        `📝 Statement: _${q}_`,
                        ``,
                        `[${bar}] ${pct}%`,
                        ``,
                        pct > 70 ? `✅ *Likely TRUE*` : pct > 40 ? `🟡 *Uncertain*` : `❌ *Likely FALSE*`,
                        ``,
                        `_This is for entertainment only 😄_`,
                    ])
                }, { quoted: msg })
                break
            }

            case 'memes': case 'meme': {
                try {
                    await fmt.react(sock, msg, '😂')
                    const cats  = ['programming', 'dank', 'funny', 'dark', 'wholesome']
                    const cat   = cats[Math.floor(Math.random() * cats.length)]
                    const res   = await fetch(`https://meme-api.com/gimme/${cat}`, { signal: AbortSignal.timeout(10000) })
                    const data  = await res.json()
                    if (!data?.url) throw new Error('No meme')
                    await sock.sendMessage(from, { image: { url: data.url }, caption: `😂 *${data.title}*\n👍 ${data.ups} upvotes` }, { quoted: msg })
                } catch {
                    await sock.sendMessage(from, { text: fmt.box('MEME', [`❌ Could not fetch meme. Try again!`]) }, { quoted: msg })
                }
                break
            }

            case 'emojimix': {
                if (args.length < 2) return sock.sendMessage(from, { text: fmt.usage('emojimix', '<emoji1> <emoji2>\nExample: .emojimix 😀 😂') }, { quoted: msg })
                const e1 = encodeURIComponent(args[0]), e2 = encodeURIComponent(args[1])
                const url = `https://emojicdn.elk.sh/${args[0]}?style=google`
                await sock.sendMessage(from, {
                    text: fmt.box('EMOJI MIX', [
                        `✨ Mixing: ${args[0]} + ${args[1]}`,
                        ``,
                        `🎨 *Result:* ${args[0]}${args[1]}`,
                        ``,
                        `_Google Emoji Mixer: emojikitchen.dev_`,
                    ])
                }, { quoted: msg })
                break
            }

            // ════ IMAGE ═══════════════════════════════════════════════════════
            case 'remini': case 'enhance': {
                await fmt.react(sock, msg, '⏳')
                await getRemini(sock, from, msg)
                break
            }

            case 'removebc': case 'removebg': {
                await getRemoveBackground(sock, from, msg)
                break
            }

            // ════ SELF-REPAIR (AI-assisted) ══════════════════════════════════
            case 'repair': {
                // .repair rewrites the bot's own source — locked to a specific
                // hardcoded number regardless of who's "owner" of this instance,
                // so customers running their own deployment can't trigger it.
                const repairSenderNum = jidToNum(sender)
                if (!numsMatch(repairSenderNum, normNum(config.repairAdminNumber))) {
                    await sock.sendMessage(from, { text: fmt.box('REPAIR', [`🔒 This command is restricted.`]) }, { quoted: msg })
                    break
                }
                const parts = q.trim().split(/\s+/)
                const targetCmd = (parts.shift() || '').replace(new RegExp(`^\\${prefix}`), '')
                const bugDescription = parts.join(' ')
                if (!targetCmd || !bugDescription) {
                    await sock.sendMessage(from, {
                        text: fmt.box('REPAIR', [
                            `Usage: ${prefix}repair <command> <what's wrong>`,
                            `Example: ${prefix}repair vv it's not detecting view-once photos`,
                        ]),
                    }, { quoted: msg })
                    break
                }
                await fmt.react(sock, msg, '🔧')
                await sock.sendMessage(from, { text: `🔧 Looking at *${targetCmd}* — diagnosing, then writing and testing a fix... this can take up to a minute or two.` }, { quoted: msg })
                try {
                    const { repairCommand } = require('./plugins/repair')
                    const result = await repairCommand(targetCmd, bugDescription)
                    if (result.notFound) {
                        await sock.sendMessage(from, { text: fmt.box('REPAIR', [`❌ Couldn't find a \`case '${targetCmd}':\` block anywhere in the bot's source.`]) }, { quoted: msg })
                    } else if (!result.success) {
                        await sock.sendMessage(from, {
                            text: fmt.box('REPAIR FAILED', [
                                `❌ AI's fix broke syntax in *${result.file}* — automatically rolled back, nothing changed.`,
                                `Error: ${result.error}`,
                            ]),
                        }, { quoted: msg })
                        await fmt.react(sock, msg, '❌')
                    } else {
                        await sock.sendMessage(from, {
                            text: fmt.box('REPAIR SUCCESS', [
                                `✅ Fixed *${targetCmd}* in \`${result.file}\``,
                                `📦 Backup saved: \`${result.backupPath}\``,
                                `✔️ Syntax verified.`,
                                ``,
                                `⚠️ Restart the bot from the panel to load the fix, then test *${prefix}${targetCmd}* again.`,
                            ]),
                        }, { quoted: msg })
                        await fmt.react(sock, msg, '✅')
                    }
                } catch (e) {
                    await sock.sendMessage(from, { text: fmt.box('REPAIR ERROR', [`❌ ${e.message}`]) }, { quoted: msg })
                    await fmt.react(sock, msg, '❌')
                }
                break
            }

            case 'repairlog': {
                if (!numsMatch(jidToNum(sender), normNum(config.repairAdminNumber))) {
                    await sock.sendMessage(from, { text: fmt.box('REPAIR LOG', [`🔒 This command is restricted.`]) }, { quoted: msg })
                    break
                }
                const { getRepairLog } = require('./plugins/repair')
                const log = getRepairLog(10)
                if (!log.length) {
                    await sock.sendMessage(from, { text: fmt.box('REPAIR LOG', [`No repairs recorded yet.`]) }, { quoted: msg })
                } else {
                    const lines = log.map(e => `• *${e.cmd}* in \`${e.file}\` — ${e.bug}\n  _${new Date(e.at).toLocaleString()}_`)
                    await sock.sendMessage(from, { text: fmt.box(`REPAIR LOG (last ${log.length})`, lines) }, { quoted: msg })
                }
                break
            }

            case 'agent': {
                await codeAgentReply(sock, from, q, msg)
                break
            }

            case 'remember': {
                await rememberCommand(sock, from, q, msg)
                break
            }

            case 'agentrefresh': {
                await refreshCommand(sock, from, msg)
                break
            }

            case 'agentstatus': {
                const s = getAgentStatus()
                await sock.sendMessage(from, {
                    text: fmt.box('🧠 CODE AGENT STATUS', [
                        `📁 Indexed files: ${s.files}`,
                        `🧠 Memories: ${s.memories}`,
                        `🕒 Index: ${s.indexedAt || 'not built yet'}`,
                    ])
                }, { quoted: msg })
                break
            }

            // ════ AI PROVIDER DIAGNOSTICS ═══════════════════════════════════════
            case 'aistatus': {
                const rows = getAiStatus()
                const lines = rows.map(r => {
                    const bits = []
                    bits.push(r.configured ? '🟢 configured' : '⚪ not configured')
                    if (r.configured) bits.push(r.usesOfficialKey ? 'official key' : 'savage relay (text-only)')
                    if (r.coolingDown) bits.push(`🧊 cooling down ${r.cooldownSecondsLeft}s`)
                    if (r.sticky) bits.push('⭐ last used')
                    bits.push(`${r.calls} ok / ${r.fails} fail`)
                    let line = `*${r.label}* — ${bits.join(', ')}`
                    if (r.lastError) line += `\n  _last error: ${r.lastError.slice(0, 120)}_`
                    return line
                })
                await sock.sendMessage(from, {
                    text: fmt.box('AI PROVIDER STATUS', [
                        `Chain order: ${config.aiProviderOrder.join(' → ')}`,
                        ``,
                        ...lines,
                    ])
                }, { quoted: msg })
                break
            }

            case 'aitest': {
                await fmt.react(sock, msg, '🧪')
                const { chatCompletion } = require('./lib/aiProviders')
                const testPrompt = q || 'Reply with just the word "pong".'
                const results = []
                for (const id of config.aiProviderOrder) {
                    try {
                        const r = await chatCompletion({ prompt: testPrompt, system: 'You are a diagnostic ping responder.', forceProvider: id })
                        results.push(`✅ *${id}* → ${r.provider === id ? 'answered' : `handed off to ${r.provider}`}: ${r.text.slice(0, 80)}`)
                    } catch (e) {
                        results.push(`❌ *${id}* → ${e.message.slice(0, 150)}`)
                    }
                }
                await sock.sendMessage(from, { text: fmt.box('AI PROVIDER TEST', results) }, { quoted: msg })
                break
            }

            // ════ OWNER COMMANDS (owner guard is above) ════════════════════════
            default: {
                // Custom command management (addcmd, delcmd, editcmd, listcmd, cmdinfo)
                const customBuilderCmds = new Set(['addcmd','delcmd','editcmd','listcmd','listcmds','mycmds','cmdinfo'])
                if (customBuilderCmds.has(cmd)) {
                    await handleCustomCmdBuilder(sock, from, cmd, q, msg, prefix)
                    break
                }

                // All other owner-only commands
                if (ownerOnlyCmds.has(cmd)) {
                    await handleOwnerCmd(sock, from, cmd, args, q, msg, sender)
                    break
                }

                // Truly unknown command — stay silent (no "UNKNOWN COMMAND" reply).
                // Especially important in groups: replying to every mistyped or
                // unrelated `.something` from anyone would be spammy and expose
                // the whole command surface to non-owners probing for things.
                break
            }
        }
    } catch (e) {
        const { printErrorBox } = require('./lib/errorBox')
        printErrorBox('Handler Error', e, {
            messageType: Object.keys(msg.message || {})[0] || 'N/A',
            senderName:  msg.pushName || 'N/A',
            chatId:      (msg.key?.remoteJid || 'N/A').replace('@s.whatsapp.net', '').replace('@g.us', ''),
        })
        // Previously this failed completely silently from the user's side —
        // a command could throw and nobody would ever know it didn't work.
        try {
            await sock.sendMessage(msg.key.remoteJid, {
                text: fmt.box('COMMAND ERROR', [`❌ Something went wrong running that command.`, `_${e.message}_`]),
            }, { quoted: msg })
        } catch { /* if even the error notice fails to send, give up quietly */ }
    }
}

module.exports = { handleMessage }
