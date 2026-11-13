const config = require('../config')
const os     = require('os')
const fs     = require('fs')
const path   = require('path')
const fmt    = require('../lib/format')
const { extractViewOnce, cleanJid } = require('../lib/utils')

const silentLogger = {
    level: 'silent', child: () => silentLogger,
    info: () => {}, debug: () => {}, error: () => {}, warn: () => {}, trace: () => {}
}

// Every .anticall/.antidelete/.autoread/etc toggle below used to ignore
// whatever the user actually typed and just flip the current state — so
// typing ".x on" when it was already on turned it OFF, and typing it twice
// in a row (e.g. two people, or a fat-fingered repeat) silently reversed
// itself. This makes an explicit on/off argument win; only a bare command
// with no argument still toggles.
function resolveToggle(current, arg) {
    const a = (arg || '').trim().toLowerCase()
    if (['on', 'true', 'enable', 'enabled', '1'].includes(a)) return true
    if (['off', 'false', 'disable', 'disabled', '0'].includes(a)) return false
    return !current
}

// Cycles/sets a 3-state scope: 'off' → 'public' → 'private' → 'off'.
// An explicit argument ("off"/"public"/"private") always wins; a bare
// command with no argument cycles to the next state.
function resolveScope(current, arg) {
    const a = (arg || '').trim().toLowerCase()
    if (['off', 'false', 'disable', 'disabled', '0'].includes(a)) return 'off'
    if (['public', 'all', 'everywhere', 'on'].includes(a)) return 'public'
    if (['private', 'dm', 'dms'].includes(a)) return 'private'
    const order = ['off', 'public', 'private']
    return order[(order.indexOf(current) + 1) % order.length]
}

// Whether a presence indicator (typing/recording) should fire for this
// chat, given its scope setting. 'off' never fires, 'public' always fires,
// 'private' only fires in a 1:1 chat (not a group).
function scopeAllows(scope, isGroupChat) {
    if (scope === 'public') return true
    if (scope === 'private') return !isGroupChat
    return false
}

// 2-state path for anti-delete's DESTINATION, independent of on/off.
// 'public' → reveal the recovered message back in the SAME chat it was
// deleted from (group or DM alike, no redirection at all).
// 'private' → always forward it to the owner's own chat instead, whether
// the deletion happened in a group or a DM. A bare command with no
// argument just flips between the two.
function resolvePath(current, arg) {
    const a = (arg || '').trim().toLowerCase()
    if (['public', 'all', 'everywhere', 'here', 'inplace', 'chat'].includes(a)) return 'public'
    if (['private', 'dm', 'dms', 'me', 'owner'].includes(a)) return 'private'
    return current === 'public' ? 'private' : 'public'
}

const runtimeSettings = {
    // ✅ SAFE DEFAULTS — keep dangerous features OFF to avoid bans
    alwaysonline:       false,   // ⚠️ BAN RISK if ON — WhatsApp flags always-online bots
    autoread:           false,   // ⚠️ moderate risk — reads msgs from unknown numbers
    // autotype/autorecord are 3-state now: 'off' (default) | 'public' (every
    // chat) | 'private' (DMs only) — a plain boolean couldn't express scope.
    autotype:           'off',   // ⚠️ BAN RISK if 'public' — showing typing everywhere looks spammy
    autorecord:         'off',
    // Plain on/off — unlike autotype/autorecord this isn't a scope choice
    // between group vs DM, because BOTH are always covered at once when on:
    // a deletion in a group gets reposted into that SAME group, and a
    // deletion in a DM gets forwarded to the owner's own chat instead (so
    // the deleter never sees it come back). The routing is automatic based
    // on where the deletion happened, not something you pick.
    antidelete:         false,
    // Where recovered messages GO when antidelete is on — independent of
    // the on/off toggle above. 'private' (default): always to the owner's
    // own chat, group or DM alike. 'public': always revealed back in the
    // exact chat it was deleted from, group or DM alike.
    antideletepath:     'private',
    anticall:           false,
    // autoreact removed entirely per owner request
    autoviewstatus:     false,   // ℹ️ low risk
    autoreactstatus:    false,   // ℹ️ low risk
    autosavestatus:     false,
    antibug:            false,
}

const STATUS_EMOJIS = ['❤️','🔥','😍','👏','😂','😮','😢','🙏','🎉','💯']

// Sudo list — merged from env SUDO_NUMBERS + data/sudo.json (persisted).
// Writing through to config.sudoNumbers matters: lib/utils.js isSudoOwner()
// reads config.sudoNumbers directly, so without this .addsudo replied "added"
// but the new sudo had NO actual rights until manual env edits + restart.
const SUDO_FILE = path.join(__dirname, '..', 'data', 'sudo.json')
function loadPersistedSudo() {
    try { return JSON.parse(fs.readFileSync(SUDO_FILE, 'utf8')) } catch { return [] }
}
function savePersistedSudo(list) {
    try {
        fs.mkdirSync(path.dirname(SUDO_FILE), { recursive: true })
        fs.writeFileSync(SUDO_FILE, JSON.stringify(list, null, 2))
    } catch (e) { console.error('[ownerCmds] save sudo failed:', e.message) }
}
const sudoList    = [...new Set([...(config.sudoNumbers || []), ...loadPersistedSudo()])]
config.sudoNumbers = sudoList  // keep the live reference so permission checks see additions instantly
const badWords    = []
const ignoredNumbers = []
const warnMap     = new Map()

async function handleOwnerCmd(sock, from, cmd, args, q, msg, sender) {
    switch (cmd) {

        case 'funmode': {
            const a = (q || '').trim().toLowerCase()
            if (!['on','off'].includes(a)) {
                return sock.sendMessage(from, { text: '😂 Usage: .funmode on|off\n_Controls the little personality lines added to normal bot replies._' }, { quoted: msg })
            }
            // Runtime override consumed by handler/lib/funResponses through config.
            config.funResponses = a === 'on'
            global.__mahnguelohFunResponses = config.funResponses
            await sock.sendMessage(from, { text: `${config.funResponses ? '😂' : '🧊'} Fun responses: *${config.funResponses ? 'ON' : 'OFF'}*` }, { quoted: msg })
            break
        }

        case 'setbotname': {
            if (!q) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Usage: .setbotname <name>`]) }, { quoted: msg })
            config.botName = q
            await sock.sendMessage(from, { text: `✅ Bot name → *${q}*` }, { quoted: msg }); break
        }
        case 'setownername': {
            if (!q) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Usage: .setownername <name>`]) }, { quoted: msg })
            config.ownerName = q
            await sock.sendMessage(from, { text: `✅ Owner name → *${q}*` }, { quoted: msg }); break
        }
        case 'setownernumber': {
            if (!q) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Usage: .setownernumber <number>`]) }, { quoted: msg })
            config.ownerNumber = q.replace(/[^0-9]/g,'')
            await sock.sendMessage(from, { text: `✅ Owner number → *${config.ownerNumber}*` }, { quoted: msg }); break
        }
        case 'setprefix': {
            if (!q) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Usage: .setprefix <char>`]) }, { quoted: msg })
            config.prefix = q[0]
            await sock.sendMessage(from, { text: `✅ Prefix → *${config.prefix}*` }, { quoted: msg }); break
        }

        case 'setbio': {
            if (!q) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Usage: .setbio <text>`]) }, { quoted: msg })
            try { await sock.updateProfileStatus(q); await sock.sendMessage(from, { text: fmt.box('SUCCESS', [`✅ Bio updated.`]) }, { quoted: msg }) }
            catch { await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Could not update bio.`]) }, { quoted: msg }) }
            break
        }
        case 'setprofilepic': {
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
            if (!quoted?.imageMessage) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Reply to an image.`]) }, { quoted: msg })
            try {
                const { downloadMediaMessage } = require('@neoxr/baileys')
                const buf = await downloadMediaMessage({ message: quoted, key: msg.key }, 'buffer', {}, { logger: silentLogger, reuploadRequest: sock.updateMediaMessage })
                await sock.updateProfilePicture(sock.user.id, buf)
                await sock.sendMessage(from, { text: fmt.box('SUCCESS', [`✅ Profile picture updated.`]) }, { quoted: msg })
            } catch { await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Could not update picture.`]) }, { quoted: msg }) }
            break
        }

        // ── Auto-status features ──────────────────────────────────────────
        case 'autoreactstatus': {
            runtimeSettings.autoreactstatus = resolveToggle(runtimeSettings.autoreactstatus, q)
            await sock.sendMessage(from, {
                text: `${runtimeSettings.autoreactstatus ? '✅' : '❌'} Auto-react to status: *${runtimeSettings.autoreactstatus ? 'ON' : 'OFF'}*\n_Bot will ${runtimeSettings.autoreactstatus ? 'now' : 'no longer'} react to status updates with random emojis._`
            }, { quoted: msg }); break
        }
        case 'autoviewstatus': {
            runtimeSettings.autoviewstatus = resolveToggle(runtimeSettings.autoviewstatus, q)
            await sock.sendMessage(from, {
                text: `${runtimeSettings.autoviewstatus ? '✅' : '❌'} Auto-view status: *${runtimeSettings.autoviewstatus ? 'ON' : 'OFF'}*\n_Bot will ${runtimeSettings.autoviewstatus ? 'now' : 'no longer'} automatically view all status updates._`
            }, { quoted: msg }); break
        }
        case 'autosavestatus': {
            runtimeSettings.autosavestatus = resolveToggle(runtimeSettings.autosavestatus, q)
            await sock.sendMessage(from, {
                text: `${runtimeSettings.autosavestatus ? '✅' : '❌'} Auto-save status: *${runtimeSettings.autosavestatus ? 'ON' : 'OFF'}*\n_Bot will ${runtimeSettings.autosavestatus ? 'now' : 'no longer'} forward status media to your DM._`
            }, { quoted: msg }); break
        }

        case 'modestatus': {
            await sock.sendMessage(from, {
                text: fmt.box('BOT STATUS', [
                    `Mode: ${(config.mode||'public').toUpperCase()}`,
                    `Chatbot: ${require('../lib/humanChat').getState().scope.toUpperCase()}`,
                    `Auto-view status: ${runtimeSettings.autoviewstatus ? 'ON' : 'OFF'}`,
                    `Auto-react status: ${runtimeSettings.autoreactstatus ? 'ON' : 'OFF'}`,
                    `Auto-save status: ${runtimeSettings.autosavestatus ? 'ON' : 'OFF'}`,
                    `Always online: ${runtimeSettings.alwaysonline ? 'ON' : 'OFF'}`,
                    `Auto-read: ${runtimeSettings.autoread ? 'ON' : 'OFF'}`,
                ])
            }, { quoted: msg }); break
        }

        case 'alwaysonline': {
            runtimeSettings.alwaysonline = resolveToggle(runtimeSettings.alwaysonline, q)
            await sock.sendMessage(from, {
                text: fmt.box('ALWAYS ONLINE', [
                    `${runtimeSettings.alwaysonline ? '🟢' : '🔴'} Always Online: *${runtimeSettings.alwaysonline ? 'ON' : 'OFF'}*`,
                    runtimeSettings.alwaysonline
                        ? `⚠️ _Keep this OFF — staying always online can trigger restrictions_`
                        : `✅ _Safely disabled_`,
                ])
            }, { quoted: msg }); break
        }
        case 'autoread': {
            runtimeSettings.autoread = resolveToggle(runtimeSettings.autoread, q)
            config.readReceipts = runtimeSettings.autoread
            await sock.sendMessage(from, {
                text: fmt.box('AUTO-READ', [
                    `${runtimeSettings.autoread ? '🟢' : '🔴'} Auto-read: *${runtimeSettings.autoread ? 'ON' : 'OFF'}*`,
                    runtimeSettings.autoread
                        ? `⚠️ _Reading all messages including unknown senders can flag your account_`
                        : `✅ _Safely disabled_`,
                ])
            }, { quoted: msg }); break
        }
        case 'autotype': {
            runtimeSettings.autotype = resolveScope(runtimeSettings.autotype, q)
            const scope = runtimeSettings.autotype
            await sock.sendMessage(from, {
                text: fmt.box('AUTO-TYPE', [
                    `${scope === 'off' ? '🔴' : '🟢'} Typing indicator: *${scope.toUpperCase()}*`,
                    scope === 'public'
                        ? `✅ _Shows in groups and DMs_`
                        : scope === 'private'
                            ? `✅ _Only shows in private (DM) chats_`
                            : `_Disabled_`,
                    `Usage: *${config.prefix}autotype off|public|private*`,
                ])
            }, { quoted: msg }); break
        }
        case 'block': {
            const targets = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
            const quotedParticipant = msg.message?.extendedTextMessage?.contextInfo?.participant
            const num = q.replace(/[^0-9]/g,'')
            const isDM = !from.endsWith('@g.us')
            // No @mention, no number, no quoted reply given → if this is a
            // private chat (not a group), block whoever the bot is
            // currently texting with, i.e. `from` itself.
            const list = targets.length
                ? targets
                : num
                    ? [num+'@s.whatsapp.net']
                    : quotedParticipant
                        ? [quotedParticipant]
                        : (isDM ? [from] : [])
            if (!list.length) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Usage: .block @user, .block 254712345678, or just .block in a DM to block whoever you're texting`]) }, { quoted: msg })
            // Confirm first, then block — once `from` is blocked, WhatsApp
            // may not deliver anything sent to it afterward.
            await sock.sendMessage(from, { text: `✅ Blocked ${list.length} user(s).` }, { quoted: msg })
            for (const t of list) await sock.updateBlockStatus(t, 'block')
            break
        }
        case 'unblock': {
            const targets = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
            const num = q.replace(/[^0-9]/g,'')
            const list = targets.length ? targets : (num ? [num+'@s.whatsapp.net'] : [])
            if (!list.length) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Usage: .unblock @user`]) }, { quoted: msg })
            for (const t of list) await sock.updateBlockStatus(t, 'unblock')
            await sock.sendMessage(from, { text: `✅ Unblocked ${list.length} user(s).` }, { quoted: msg }); break
        }
        case 'unblockall': {
            try {
                const list = await sock.fetchBlocklist()
                for (const t of list) await sock.updateBlockStatus(t, 'unblock')
                await sock.sendMessage(from, { text: `✅ Unblocked ${list.length} users.` }, { quoted: msg })
            } catch { await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Failed.`]) }, { quoted: msg }) }
            break
        }
        case 'listblocked': {
            try {
                const list = await sock.fetchBlocklist()
                await sock.sendMessage(from, { text: `🚫 *Blocked (${list.length}):*\n${list.map(j=>`• ${j.split('@')[0]}`).join('\n') || 'None'}` }, { quoted: msg })
            } catch { await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Failed.`]) }, { quoted: msg }) }
            break
        }

        case 'delete': {
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
            const quotedKey = msg.message?.extendedTextMessage?.contextInfo
            if (!quoted) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Reply to the message to delete.`]) }, { quoted: msg })
            try {
                await sock.sendMessage(from, { delete: { remoteJid: from, fromMe: quotedKey.participant === sock.user.id, id: quotedKey.stanzaId, participant: quotedKey.participant } })
                await sock.sendMessage(from, { text: fmt.box('SUCCESS', [`✅ Deleted.`]) }, { quoted: msg })
            } catch { await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Could not delete.`]) }, { quoted: msg }) }
            break
        }
        case 'react': {
            const emoji = q || '❤️'
            const quotedKey = msg.message?.extendedTextMessage?.contextInfo
            if (!quotedKey) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Reply to a message with .react <emoji>`]) }, { quoted: msg })
            await sock.sendMessage(from, { react: { text: emoji, key: { remoteJid: from, id: quotedKey.stanzaId, participant: quotedKey.participant } } }); break
        }

        case 'join': {
            if (!q) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Usage: .join <invite link>`]) }, { quoted: msg })
            const code = q.split('chat.whatsapp.com/').pop().split('/').pop().trim()
            try { await sock.groupAcceptInvite(code); await sock.sendMessage(from, { text: fmt.box('SUCCESS', [`✅ Joined group.`]) }, { quoted: msg }) }
            catch { await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Could not join. Invalid/expired link?`]) }, { quoted: msg }) }
            break
        }
        case 'leave': {
            if (!from.endsWith('@g.us')) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Must be in a group.`]) }, { quoted: msg })
            await sock.groupLeave(from); break
        }
        case 'groupid': {
            if (!from.endsWith('@g.us')) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Must be in a group.`]) }, { quoted: msg })
            await sock.sendMessage(from, { text: `🆔 *Group ID:*\n${from}` }, { quoted: msg }); break
        }

        case 'disk': {
            const { execSync } = require('child_process')
            try { await sock.sendMessage(from, { text: `💽 *Disk:*\n${execSync('df -h /').toString()}` }, { quoted: msg }) }
            catch { await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Failed.`]) }, { quoted: msg }) }
            break
        }
        case 'hostip': {
            const { execSync } = require('child_process')
            try { await sock.sendMessage(from, { text: `🌐 *Host IP:*\n${execSync('curl -s ifconfig.me').toString()}` }, { quoted: msg }) }
            catch { await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Failed.`]) }, { quoted: msg }) }
            break
        }
        case 'device': {
            await sock.sendMessage(from, {
                text: `📱 *Device Info*\n• Platform: ${os.platform()}\n• Arch: ${os.arch()}\n• Node: ${process.version}\n• Uptime: ${Math.floor(process.uptime()/3600)}h ${Math.floor((process.uptime()%3600)/60)}m`
            }, { quoted: msg }); break
        }
        case 'restart': {
            await sock.sendMessage(from, { text: fmt.box('BOT', [`🔄 Restarting...`]) }, { quoted: msg })
            setTimeout(() => process.exit(0), 1000); break
        }
        case 'resetsessions': {
            try {
                const fs = require('fs'), path = require('path')
                const authDir = path.join(__dirname, '../auth_info')
                let cleared = 0
                for (const f of fs.readdirSync(authDir)) {
                    if (/^session-.*\.json$/.test(f)) {
                        try { fs.unlinkSync(path.join(authDir, f)); cleared++ } catch {}
                    }
                }
                await sock.sendMessage(from, {
                    text: fmt.box('SESSIONS RESET', [
                        `🧹 Cleared *${cleared}* stored session file(s)`,
                        `Fresh sessions will renegotiate automatically as people message the bot`,
                        `_creds.json untouched — you stay paired_`,
                    ])
                }, { quoted: msg })
            } catch (e) {
                await sock.sendMessage(from, { text: fmt.error(`Reset failed: ${e.message}`) }, { quoted: msg })
            }
            break
        }
        case 'deljunk': {
            try {
                const fs = require('fs'), path = require('path')
                const tmp = path.join(__dirname, '../tmp')
                if (fs.existsSync(tmp)) {
                    const files = fs.readdirSync(tmp)
                    files.forEach(f => { try { fs.unlinkSync(path.join(tmp,f)) } catch {} })
                    await sock.sendMessage(from, { text: `✅ Cleared ${files.length} temp file(s).` }, { quoted: msg })
                } else { await sock.sendMessage(from, { text: fmt.box('SUCCESS', [`✅ No junk found.`]) }, { quoted: msg }) }
            } catch { await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Failed.`]) }, { quoted: msg }) }
            break
        }

        case 'lastseen': {
            runtimeSettings.lastseen = resolveToggle(runtimeSettings.lastseen, q)
            try {
                await sock.updateLastSeenPrivacy(runtimeSettings.lastseen ? 'all' : 'none')
                await sock.sendMessage(from, { text: `✅ Last seen: *${runtimeSettings.lastseen ? 'Visible' : 'Hidden'}*` }, { quoted: msg })
            } catch { await sock.sendMessage(from, { text: fmt.box('SUCCESS', [`✅ Last seen toggled.`]) }, { quoted: msg }) }
            break
        }
        case 'online': {
            runtimeSettings.online = resolveToggle(runtimeSettings.online, q)
            await sock.sendMessage(from, { text: `✅ Online status: *${runtimeSettings.online ? 'Visible' : 'Hidden'}*` }, { quoted: msg }); break
        }

        case 'getpp': {
            const target = q ? q.replace(/[^0-9]/g,'')+'@s.whatsapp.net' : sender
            try {
                const url = await sock.profilePictureUrl(target, 'image')
                await sock.sendMessage(from, { image: { url }, caption: `📸 Profile picture of ${target.split('@')[0]}` }, { quoted: msg })
            } catch { await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ No profile picture.`]) }, { quoted: msg }) }
            break
        }
        case 'getgrouppp': {
            try {
                const url = await sock.profilePictureUrl(from, 'image')
                await sock.sendMessage(from, { image: { url }, caption: `📸 Group picture` }, { quoted: msg })
            } catch { await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ No group picture.`]) }, { quoted: msg }) }
            break
        }
        case 'getabout': {
            const target = q ? q.replace(/[^0-9]/g,'')+'@s.whatsapp.net' : sender
            try {
                const s = await sock.fetchStatus(target)
                await sock.sendMessage(from, { text: `📝 *About:*\n${s?.status || 'No status set.'}` }, { quoted: msg })
            } catch { await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Could not fetch.`]) }, { quoted: msg }) }
            break
        }

        // ── Status posting ──────────────────────────────────────────────────
        // `broadcast: true` is required alongside the send — without it,
        // WhatsApp/Baileys accepts the sendMessage call with no error at all,
        // but never actually routes the update to anyone's phone: it looked
        // "posted" (no error, no crash) while nobody's status feed ever
        // received it. statusJidList additionally *guarantees* delivery to
        // the owner's own number even if the account's default Status
        // Privacy would otherwise exclude it (e.g. privacy set tighter than
        // "My contacts") — so it now actually reaches the user's number.
        case 'tostatus': {
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
            if (!quoted) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Reply to a message.`]) }, { quoted: msg })
            try {
                const { downloadMediaMessage, extractMessageContent } = require('@neoxr/baileys')
                // Unwrap view-once / ephemeral wrappers so replied view-once media can be posted
                const q = extractMessageContent?.(quoted) || quoted

                // Recipient list — status@broadcast REQUIRES a non-empty statusJidList
                // (empty list = status silently never posts). Guarantee delivery to the
                // live connected account's own number (not config.ownerNumber — that's a
                // placeholder default unless OWNER_NUMBER was set in .env).
                const selfNum = (cleanJid(sock.user?.id || '') || '').split('@')[0]
                const selfLid = (sock.user?.lid || '').split(':')[0]
                const statusJidList = [...new Set([
                    ...(selfNum ? [`${selfNum}@s.whatsapp.net`] : []),
                    ...(selfLid ? [`${selfLid}@lid`] : []),
                    ...[config.ownerNumber, ...(sudoList || [])].filter(Boolean).map(n => `${n}@s.whatsapp.net`),
                ])]
                if (!statusJidList.length) {
                    return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ No recipient JIDs — set OWNER_NUMBER in your .env file.`]) }, { quoted: msg })
                }
                console.log('[tostatus] recipients=' + JSON.stringify(statusJidList))

                const dl = () => downloadMediaMessage({ message: q, key: msg.key }, 'buffer', {}, { logger: silentLogger, reuploadRequest: sock.updateMediaMessage })
                const sendOpts = { statusJidList, broadcast: true }

                if (q.imageMessage) {
                    await sock.sendMessage('status@broadcast', { image: await dl(), caption: q.imageMessage.caption || '' }, sendOpts)
                } else if (q.videoMessage) {
                    await sock.sendMessage('status@broadcast', { video: await dl(), caption: q.videoMessage.caption || '' }, sendOpts)
                } else if (q.audioMessage) {
                    await sock.sendMessage('status@broadcast', { audio: await dl(), mimetype: q.audioMessage?.mimetype || 'audio/ogg; codecs=opus', ptt: !!q.audioMessage?.ptt }, sendOpts)
                } else {
                    const text = q.conversation || q.extendedTextMessage?.text || ''
                    if (!text) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ That message has no text/image/video/audio to post.`]) }, { quoted: msg })
                    // Text statuses REQUIRE backgroundColor + font or WhatsApp silently drops them
                    const bg = '#0B141A'
                    await sock.sendMessage('status@broadcast', { text, backgroundColor: bg, font: 2 }, { ...sendOpts, backgroundColor: bg, font: 2 })
                }
                await sock.sendMessage(from, { text: fmt.box('SUCCESS', [`✅ Posted to status — now live on your number.`]) }, { quoted: msg })
            } catch (e) {
                console.error('[tostatus] failed:', e)
                await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Could not post: ${e.message}`]) }, { quoted: msg })
            }
            break
        }
        case 'toviewonce': {
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
            if (!quoted?.imageMessage && !quoted?.videoMessage) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Reply to an image or video.`]) }, { quoted: msg })
            try {
                const { downloadMediaMessage } = require('@neoxr/baileys')
                const buf = await downloadMediaMessage({ message: quoted, key: msg.key }, 'buffer', {}, { logger: silentLogger, reuploadRequest: sock.updateMediaMessage })
                if (quoted.imageMessage) {
                    await sock.sendMessage(from, { image: buf, viewOnce: true, caption: '' }, { quoted: msg })
                } else {
                    await sock.sendMessage(from, { video: buf, viewOnce: true, caption: '' }, { quoted: msg })
                }
            } catch { await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Failed.`]) }, { quoted: msg }) }
            break
        }
        case 'vv2': {
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
            const voMsg = extractViewOnce(quoted)
            if (!voMsg) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Reply to a view-once.`]) }, { quoted: msg })
            try {
                const { downloadMediaMessage } = require('@neoxr/baileys')
                const buf = await downloadMediaMessage({ message: voMsg, key: msg.key }, 'buffer', {}, { logger: silentLogger, reuploadRequest: sock.updateMediaMessage })
                if (voMsg.imageMessage) await sock.sendMessage(from, { image: buf, caption: '👁️ View-once revealed!' }, { quoted: msg })
                else if (voMsg.videoMessage) await sock.sendMessage(from, { video: buf, caption: '👁️ View-once revealed!' }, { quoted: msg })
                else if (voMsg.audioMessage) await sock.sendMessage(from, { audio: buf, mimetype: voMsg.audioMessage?.mimetype || 'audio/ogg; codecs=opus', ptt: !!voMsg.audioMessage?.ptt }, { quoted: msg })
            } catch { await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Failed to reveal.`]) }, { quoted: msg }) }
            break
        }

        // ── Sudo / badwords / ignore ────────────────────────────────────────
        case 'addsudo': {
            const num = q.replace(/[^0-9]/g,'')
            if (!num) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Usage: .addsudo <number>`]) }, { quoted: msg })
            if (!sudoList.includes(num)) {
                sudoList.push(num)
                savePersistedSudo(sudoList)          // survives restarts
                config.sudoNumbers = sudoList        // instant real rights (utils.js reads this)
            }
            await sock.sendMessage(from, { text: fmt.box('SUCCESS', [`✅ ${num} added to sudo.`]) }, { quoted: msg }); break
        }
        case 'delsudo': {
            const num = q.replace(/[^0-9]/g,'')
            const idx = sudoList.indexOf(num)
            if (idx === -1) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Not in sudo list.`]) }, { quoted: msg })
            sudoList.splice(idx, 1)
            savePersistedSudo(sudoList)
            config.sudoNumbers = sudoList
            await sock.sendMessage(from, { text: fmt.box('SUCCESS', [`✅ ${num} removed from sudo.`]) }, { quoted: msg }); break
        }
        case 'listsudo': {
            await sock.sendMessage(from, { text: `👑 *Sudo List (${sudoList.length}):*\n${sudoList.map(n=>`• ${n}`).join('\n') || 'None'}` }, { quoted: msg }); break
        }
        case 'addbadword': {
            if (!q) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Usage: .addbadword <word>`]) }, { quoted: msg })
            if (!badWords.includes(q.toLowerCase())) badWords.push(q.toLowerCase())
            await sock.sendMessage(from, { text: `✅ Added bad word: *${q}*` }, { quoted: msg }); break
        }
        case 'deletebadword': {
            const idx = badWords.indexOf(q.toLowerCase())
            if (idx === -1) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Word not found.`]) }, { quoted: msg })
            badWords.splice(idx, 1)
            await sock.sendMessage(from, { text: `✅ Removed: *${q}*` }, { quoted: msg }); break
        }
        case 'listbadword': {
            await sock.sendMessage(from, { text: `🚫 *Bad Words (${badWords.length}):*\n${badWords.join(', ') || 'None'}` }, { quoted: msg }); break
        }
        case 'addignorelist': {
            const num = q.replace(/[^0-9]/g,'')
            if (!ignoredNumbers.includes(num)) ignoredNumbers.push(num)
            await sock.sendMessage(from, { text: fmt.box('SUCCESS', [`✅ ${num} ignored.`]) }, { quoted: msg }); break
        }
        case 'delignorelist': {
            const num = q.replace(/[^0-9]/g,'')
            const idx = ignoredNumbers.indexOf(num)
            if (idx !== -1) ignoredNumbers.splice(idx, 1)
            await sock.sendMessage(from, { text: fmt.box('SUCCESS', [`✅ ${num} removed from ignore.`]) }, { quoted: msg }); break
        }
        case 'listignorelist': {
            await sock.sendMessage(from, { text: `🙈 *Ignored (${ignoredNumbers.length}):*\n${ignoredNumbers.join('\n') || 'None'}` }, { quoted: msg }); break
        }

        // ── Warn system ─────────────────────────────────────────────────────
        case 'warn': {
            const targets = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
            if (!targets.length) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Mention a user.`]) }, { quoted: msg })
            const t = targets[0], key = t
            const warns = (warnMap.get(key)||0) + 1
            warnMap.set(key, warns)
            await sock.sendMessage(from, {
                text: `⚠️ @${t.split('@')[0]} warned (*${warns}/3*)${warns >= 3 ? '\n🚫 Max warnings reached!' : ''}`,
                mentions: [t]
            }, { quoted: msg }); break
        }
        case 'resetwarn': {
            const targets = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
            if (!targets.length) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Mention a user.`]) }, { quoted: msg })
            warnMap.delete(targets[0])
            await sock.sendMessage(from, { text: `✅ Warnings reset for @${targets[0].split('@')[0]}`, mentions: [targets[0]] }, { quoted: msg }); break
        }
        case 'listwarn': {
            const list = [...warnMap.entries()].map(([j,c]) => `• ${j.split('@')[0]}: ${c}/3`)
            await sock.sendMessage(from, { text: `⚠️ *Warnings:*\n${list.join('\n') || 'None'}` }, { quoted: msg }); break
        }

        case 'setgroupname': {
            if (!from.endsWith('@g.us')) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Groups only.`]) }, { quoted: msg })
            if (!q) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Usage: .setgroupname <name>`]) }, { quoted: msg })
            await sock.groupUpdateSubject(from, q)
            await sock.sendMessage(from, { text: `✅ Group name → *${q}*` }, { quoted: msg }); break
        }
        case 'setdesc': {
            if (!from.endsWith('@g.us')) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Groups only.`]) }, { quoted: msg })
            await sock.groupUpdateDescription(from, q || '')
            await sock.sendMessage(from, { text: fmt.box('SUCCESS', [`✅ Group description updated.`]) }, { quoted: msg }); break
        }
        case 'resetlink': {
            if (!from.endsWith('@g.us')) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Groups only.`]) }, { quoted: msg })
            await sock.groupRevokeInvite(from)
            await sock.sendMessage(from, { text: fmt.box('SUCCESS', [`✅ Group link reset.`]) }, { quoted: msg }); break
        }
        case 'setppgroup': {
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
            if (!quoted?.imageMessage) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Reply to an image.`]) }, { quoted: msg })
            try {
                const { downloadMediaMessage } = require('@neoxr/baileys')
                const buf = await downloadMediaMessage({ message: quoted, key: msg.key }, 'buffer', {}, { logger: silentLogger, reuploadRequest: sock.updateMediaMessage })
                await sock.updateProfilePicture(from, buf)
                await sock.sendMessage(from, { text: fmt.box('SUCCESS', [`✅ Group picture updated.`]) }, { quoted: msg })
            } catch { await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Failed.`]) }, { quoted: msg }) }
            break
        }
        case 'poll': {
            if (!q || !q.includes('|')) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Usage: .poll Question | Option1 | Option2 | Option3`]) }, { quoted: msg })
            const parts = q.split('|').map(s=>s.trim())
            if (parts.length < 3) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Need at least 2 options.`]) }, { quoted: msg })
            await sock.sendMessage(from, { poll: { name: parts[0], values: parts.slice(1), selectableCount: 1 } }); break
        }
        case 'dlvo': {
            const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
            const voMsg = extractViewOnce(quoted)
            if (!voMsg) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Reply to a view-once.`]) }, { quoted: msg })
            try {
                const { downloadMediaMessage } = require('@neoxr/baileys')
                const buf = await downloadMediaMessage({ message: voMsg, key: msg.key }, 'buffer', {}, { logger: silentLogger, reuploadRequest: sock.updateMediaMessage })
                if (voMsg.imageMessage) await sock.sendMessage(from, { image: buf, caption: '✅ Saved!' }, { quoted: msg })
                else if (voMsg.videoMessage) await sock.sendMessage(from, { video: buf, caption: '✅ Saved!' }, { quoted: msg })
                else if (voMsg.audioMessage) await sock.sendMessage(from, { audio: buf, mimetype: voMsg.audioMessage?.mimetype || 'audio/ogg; codecs=opus', ptt: !!voMsg.audioMessage?.ptt }, { quoted: msg })
            } catch { await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Failed.`]) }, { quoted: msg }) }
            break
        }

        case 'fliptext': {
            if (!q) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Usage: .fliptext <text>`]) }, { quoted: msg })
            await sock.sendMessage(from, { text: fmt.box('BOT', [`🔄 ${q.split('').reverse().join('')}`]) }, { quoted: msg }); break
        }
        case 'obfuscate': {
            if (!q) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Usage: .obfuscate <text>`]) }, { quoted: msg })
            await sock.sendMessage(from, { text: `🔤 ${q.split('').map(c=>Math.random()>.5?c.toUpperCase():c.toLowerCase()).join('')}` }, { quoted: msg }); break
        }
        case 'ssweb': case 'sswebpc': case 'sswebtab': {
            if (!q) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Usage: .ssweb <url>`]) }, { quoted: msg })
            const url = q.startsWith('http') ? q : 'https://'+q
            await sock.sendMessage(from, { image: { url: `https://api.screenshotmachine.com?key=demo&url=${encodeURIComponent(url)}&dimension=1366x768` }, caption: `📸 ${url}` }, { quoted: msg }); break
        }

        case 'anticall': {
            runtimeSettings.anticall = resolveToggle(runtimeSettings.anticall, q)
            await sock.sendMessage(from, { text: `${runtimeSettings.anticall ? '✅' : '❌'} Anti-call: *${runtimeSettings.anticall ? 'ON' : 'OFF'}*\n_Bot will ${runtimeSettings.anticall ? 'now reject' : 'no longer reject'} incoming calls._` }, { quoted: msg }); break
        }
        case 'antibug': {
            runtimeSettings.antibug = resolveToggle(runtimeSettings.antibug, q)
            await sock.sendMessage(from, {
                text: fmt.box('ANTI-BUG', [
                    `${runtimeSettings.antibug ? '🟢' : '🔴'} DM protection: *${runtimeSettings.antibug ? 'ON' : 'OFF'}*`,
                    runtimeSettings.antibug
                        ? `✅ _Crash/bug messages sent to this number are deleted; sender is blocked after ${3} strikes_`
                        : `✅ _Safely disabled_`,
                ])
            }, { quoted: msg }); break
        }
        case 'antidelete': {
            runtimeSettings.antidelete = resolveToggle(runtimeSettings.antidelete, q)
            const on = runtimeSettings.antidelete
            await sock.sendMessage(from, {
                text: fmt.box('ANTI-DELETE', [
                    `${on ? '🟢' : '🔴'} Anti-delete: *${on ? 'ON' : 'OFF'}*`,
                    on
                        ? `✅ _Deleted messages are recovered — use ${config.prefix}antideletepath to choose where they go._`
                        : `_Disabled_`,
                    `Usage: *${config.prefix}antidelete on|off*`,
                ])
            }, { quoted: msg }); break
        }
        case 'antideletepath': {
            runtimeSettings.antideletepath = resolvePath(runtimeSettings.antideletepath, q)
            const path = runtimeSettings.antideletepath
            await sock.sendMessage(from, {
                text: fmt.box('ANTI-DELETE PATH', [
                    `📍 Path: *${path.toUpperCase()}*`,
                    path === 'public'
                        ? `✅ _All recovered messages (group AND private) go back into the exact chat they were deleted from._`
                        : `✅ _All recovered messages (group AND private) are forwarded to your own chat._`,
                    `Usage: *${config.prefix}antideletepath public|private* (or *dm* for private)`,
                ])
            }, { quoted: msg }); break
        }
        case 'antiedit': {
            runtimeSettings.antiedit = resolveToggle(runtimeSettings.antiedit, q)
            await sock.sendMessage(from, { text: `${runtimeSettings.antiedit ? '✅' : '❌'} Anti-edit: *${runtimeSettings.antiedit ? 'ON' : 'OFF'}*` }, { quoted: msg }); break
        }
        case 'antiviewonce': {
            runtimeSettings.antiviewonce = resolveToggle(runtimeSettings.antiviewonce, q)
            await sock.sendMessage(from, { text: `${runtimeSettings.antiviewonce ? '✅' : '❌'} Anti-viewonce: *${runtimeSettings.antiviewonce ? 'ON' : 'OFF'}*\n_Bot will ${runtimeSettings.antiviewonce ? 'now auto-reveal' : 'no longer reveal'} view-once messages._` }, { quoted: msg }); break
        }
        case 'autobio': {
            if (!q) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Usage: .autobio <bio text>\nUse {time} for dynamic time`]) }, { quoted: msg })
            runtimeSettings.autobio = q
            await sock.sendMessage(from, { text: `✅ Auto-bio set to: _${q}_` }, { quoted: msg }); break
        }
        case 'autoblock': {
            runtimeSettings.autoblock = resolveToggle(runtimeSettings.autoblock, q)
            await sock.sendMessage(from, { text: `${runtimeSettings.autoblock ? '✅' : '❌'} Auto-block unknown: *${runtimeSettings.autoblock ? 'ON' : 'OFF'}*` }, { quoted: msg }); break
        }
        case 'autoreact': {
            await sock.sendMessage(from, { text: `❌ Auto-react has been removed entirely — there's nothing to toggle` }, { quoted: msg }); break
        }
        case 'autorecord': {
            runtimeSettings.autorecord = resolveScope(runtimeSettings.autorecord, q)
            const scope = runtimeSettings.autorecord
            await sock.sendMessage(from, {
                text: fmt.box('AUTO-RECORD', [
                    `${scope === 'off' ? '🔴' : '🟢'} Recording indicator: *${scope.toUpperCase()}*`,
                    scope === 'public'
                        ? `✅ _Shows in groups and DMs_`
                        : scope === 'private'
                            ? `✅ _Only shows in private (DM) chats_`
                            : `_Disabled_`,
                    `Usage: *${config.prefix}autorecord off|public|private*`,
                ])
            }, { quoted: msg }); break
        }
        case 'autorecordtyping': {
            await sock.sendMessage(from, { text: `❌ .autorecordtyping has been removed — .autotype and .autorecord each fire independently now, no combo toggle needed.` }, { quoted: msg }); break
        }
        case 'statusdelay': {
            const delay = parseInt(q) || 3
            runtimeSettings.statusdelay = delay
            await sock.sendMessage(from, { text: `✅ Status view delay: *${delay}s*` }, { quoted: msg }); break
        }
        case 'statussettings': {
            await sock.sendMessage(from, {
                text: fmt.box('STATUS SETTINGS', [
                    `Auto-view: ${runtimeSettings.autoviewstatus ? 'ON' : 'OFF'}`,
                    `Auto-react: ${runtimeSettings.autoreactstatus ? 'ON' : 'OFF'}`,
                    `Auto-save: ${runtimeSettings.autosavestatus ? 'ON' : 'OFF'}`,
                    `Delay: ${runtimeSettings.statusdelay || 3}s`,
                ])
            }, { quoted: msg }); break
        }
        case 'setwatermark': {
            if (!q) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Usage: .setwatermark <text>`]) }, { quoted: msg })
            config.watermark = q
            await sock.sendMessage(from, { text: `✅ Watermark set: *${q}*` }, { quoted: msg }); break
        }
        case 'setfont': {
            const fontLib = require('../lib/fontStyles')
            if (!q) {
                return sock.sendMessage(from, {
                    text: fmt.box('FONT STYLES', [
                        fontLib.styleList(),
                        ``,
                        `.setfont <number>          — set as default`,
                        `.setfont <number> <text>   — preview only`,
                    ])
                }, { quoted: msg })
            }
            const parts = q.trim().split(/\s+/)
            const styleNum = parseInt(parts[0])
            if (!fontLib.STYLES[styleNum]) {
                return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Unknown style. Run .setfont with no text to see the list.`]) }, { quoted: msg })
            }
            const rest = parts.slice(1).join(' ')
            if (!rest) {
                config.fontStyle = styleNum
                await sock.sendMessage(from, { text: fmt.box('SUCCESS', [`✅ Default font set: *${fontLib.STYLES[styleNum].name}*`]) }, { quoted: msg })
            } else {
                await sock.sendMessage(from, { text: fmt.box('FONT PREVIEW', [fontLib.applyStyle(rest, styleNum)]) }, { quoted: msg })
            }
            break
        }
        case 'setcontextlink': {
            if (!q) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Usage: .setcontextlink <url>`]) }, { quoted: msg })
            config.contextLink = q
            await sock.sendMessage(from, { text: fmt.box('SUCCESS', [`✅ Context link set.`]) }, { quoted: msg }); break
        }
        case 'setstatusemoji': {
            if (!q) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Usage: .setstatusemoji <emoji>`]) }, { quoted: msg })
            STATUS_EMOJIS.length = 0; STATUS_EMOJIS.push(q)
            await sock.sendMessage(from, { text: `✅ Status emoji: ${q}` }, { quoted: msg }); break
        }
        case 'setstickerauthor': {
            if (!q) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Usage: .setstickerauthor <name>`]) }, { quoted: msg })
            config.stickerAuthor = q
            await sock.sendMessage(from, { text: `✅ Sticker author: *${q}*` }, { quoted: msg }); break
        }
        case 'setstickerpackname': {
            if (!q) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Usage: .setstickerpackname <name>`]) }, { quoted: msg })
            config.stickerPack = q
            await sock.sendMessage(from, { text: `✅ Sticker pack name: *${q}*` }, { quoted: msg }); break
        }
        case 'settimezone': {
            if (!q) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Usage: .settimezone <timezone>\nExample: .settimezone Africa/Nairobi`]) }, { quoted: msg })
            config.timezone = q
            await sock.sendMessage(from, { text: `✅ Timezone: *${q}*` }, { quoted: msg }); break
        }
        case 'setwelcome': {
            if (!q) return sock.sendMessage(from, { text: `❌ Usage: .setwelcome <message>\nUse {name} for member name, {group} for group name` }, { quoted: msg })
            config.welcomeText = q
            await sock.sendMessage(from, { text: `✅ Welcome message set:\n_${q}_` }, { quoted: msg }); break
        }
        case 'setgoodbye': {
            if (!q) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Usage: .setgoodbye <message>`]) }, { quoted: msg })
            config.goodbyeText = q
            await sock.sendMessage(from, { text: `✅ Goodbye message set:\n_${q}_` }, { quoted: msg }); break
        }
        case 'showwelcome': {
            await sock.sendMessage(from, { text: `👋 *Welcome message:*\n${config.welcomeText || 'Welcome to {group}, @{name}!'}` }, { quoted: msg }); break
        }
        case 'showgoodbye': {
            await sock.sendMessage(from, { text: `👋 *Goodbye message:*\n${config.goodbyeText || 'Goodbye @{name}!'}` }, { quoted: msg }); break
        }
        case 'testwelcome': {
            const name = sender.split('@')[0]
            const group = from.endsWith('@g.us') ? (await sock.groupMetadata(from).catch(()=>({subject:'Test Group'}))).subject : 'Test Group'
            const wtext = (config.welcomeText || 'Welcome to *{group}*, @{name}! 🎉').replace('{name}', name).replace('{group}', group)
            await sock.sendMessage(from, { text: wtext, mentions: [sender] }, { quoted: msg }); break
        }
        case 'testgoodbye': {
            const name2 = sender.split('@')[0]
            const btext = (config.goodbyeText || 'Goodbye @{name}! 👋').replace('{name}', name2)
            await sock.sendMessage(from, { text: btext, mentions: [sender] }, { quoted: msg }); break
        }
        case 'delwelcome': {
            config.welcomeText = null
            await sock.sendMessage(from, { text: fmt.box('SUCCESS', [`✅ Welcome message reset to default.`]) }, { quoted: msg }); break
        }
        case 'delgoodbye': {
            config.goodbyeText = null
            await sock.sendMessage(from, { text: fmt.box('SUCCESS', [`✅ Goodbye message reset to default.`]) }, { quoted: msg }); break
        }
        case 'resetsetting': {
            config.mode = 'public'; require('../lib/humanChat').setScope('off'); config.welcomeText = null; config.goodbyeText = null
            await sock.sendMessage(from, { text: fmt.box('SUCCESS', [`✅ Settings reset to defaults.`]) }, { quoted: msg }); break
        }
        case 'setanticallmsg': {
            if (!q) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Usage: .setanticallmsg <message>`]) }, { quoted: msg })
            config.anticallMsg = q
            await sock.sendMessage(from, { text: fmt.box('SUCCESS', [`✅ Anti-call message set.`]) }, { quoted: msg }); break
        }
        case 'showanticallmsg': {
            await sock.sendMessage(from, { text: `📞 Anti-call message:\n${config.anticallMsg || 'Sorry, I don\'t accept calls.'}` }, { quoted: msg }); break
        }
        case 'delanticallmsg': {
            config.anticallMsg = null
            await sock.sendMessage(from, { text: fmt.box('SUCCESS', [`✅ Anti-call message reset.`]) }, { quoted: msg }); break
        }
        case 'testanticallmsg': {
            await sock.sendMessage(from, { text: config.anticallMsg || `❌ Sorry, I don't accept calls.\nContact: wa.me/${config.ownerNumber}` }, { quoted: msg }); break
        }
        case 'addcountrycode': {
            if (!q) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Usage: .addcountrycode <code>\nExample: .addcountrycode 254`]) }, { quoted: msg })
            if (!config.countryCodes) config.countryCodes = []
            if (!config.countryCodes.includes(q)) config.countryCodes.push(q)
            await sock.sendMessage(from, { text: `✅ Country code +${q} allowed.` }, { quoted: msg }); break
        }
        case 'delcountrycode': {
            if (!config.countryCodes) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ No country codes set.`]) }, { quoted: msg })
            const idx = config.countryCodes.indexOf(q)
            if (idx !== -1) config.countryCodes.splice(idx, 1)
            await sock.sendMessage(from, { text: `✅ Country code +${q} removed.` }, { quoted: msg }); break
        }
        case 'listcountrycode': {
            await sock.sendMessage(from, { text: `🌍 *Allowed country codes:*\n${(config.countryCodes||[]).map(c=>'+'+c).join(', ') || 'All allowed'}` }, { quoted: msg }); break
        }
        case 'setmenu': {
            if (!q) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Usage: .setmenu <tagline text>\nShown under the bot header in .menu.\n.setmenu reset clears it.`]) }, { quoted: msg })
            config.menuTagline = q.toLowerCase() === 'reset' ? null : q
            await sock.sendMessage(from, {
                text: fmt.box('SUCCESS', [config.menuTagline ? `✅ Menu tagline set:\n_${config.menuTagline}_` : `✅ Menu tagline reset.`])
            }, { quoted: msg })
            break
        }
        case 'setmenuimage': {
            const fs = require('fs'), path = require('path')
            const quotedImg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
            const imgMsg = quotedImg?.imageMessage || msg.message?.imageMessage
            if (!imgMsg) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Send an image with .setmenuimage as the caption, or reply to one with the command.`]) }, { quoted: msg })
            try {
                const { downloadMediaMessage } = require('@neoxr/baileys')
                const buf = await downloadMediaMessage({ message: quotedImg || msg.message, key: msg.key }, 'buffer', {}, { logger: silentLogger, reuploadRequest: sock.updateMediaMessage })
                const bannerPath = path.join(__dirname, '../assets/banner.png')
                fs.mkdirSync(path.dirname(bannerPath), { recursive: true })
                fs.writeFileSync(bannerPath, buf)
                await sock.sendMessage(from, { text: fmt.box('SUCCESS', [`✅ Menu banner updated — .menu will use it from now on.`]) }, { quoted: msg })
            } catch (e) {
                await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Failed: ${e.message}`]) }, { quoted: msg })
            }
            break
        }

        case 'broadcast': {
            if (!q) return sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Usage: .broadcast <message>`]) }, { quoted: msg })
            try {
                const groups = await sock.groupFetchAllParticipating()
                const groupIds = Object.keys(groups)
                if (!groupIds.length) return sock.sendMessage(from, { text: fmt.box('BROADCAST', [`❌ Bot is not in any groups.`]) }, { quoted: msg })
                await sock.sendMessage(from, { text: fmt.box('BROADCAST', [`📡 Sending to *${groupIds.length}* groups...`]) }, { quoted: msg })
                let sent = 0, failed = 0
                for (const gid of groupIds) {
                    try {
                        await sock.sendMessage(gid, { text: fmt.box('📢 BROADCAST', [q, ``, `_From: ${config.botName}_`]) })
                        sent++
                    } catch { failed++ }
                    // 2s delay between each group — prevents spam ban
                    await new Promise(r => setTimeout(r, 2000))
                }
                await sock.sendMessage(from, {
                    text: fmt.box('BROADCAST DONE', [
                        `✅ Sent: *${sent}*`,
                        `❌ Failed: *${failed}*`,
                    ])
                }, { quoted: msg })
            } catch (e) {
                await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Broadcast failed: ${e.message}`]) }, { quoted: msg })
            }
            break
        }

        case 'allgroups': {
            const sub = args[0]?.toLowerCase()
            const val = args[1]?.toLowerCase()
            const VALID_SETTINGS = ['antilink','antispam','antisticker','antivoicenote','antibug','antibot','antiremove','welcome','goodbye']
            if (!sub || !VALID_SETTINGS.includes(sub) || !['on','off'].includes(val)) {
                return sock.sendMessage(from, {
                    text: fmt.box('ALL GROUPS', [
                        `⚙️ Apply a setting to ALL groups at once`,
                        ``,
                        `Usage: *.allgroups <setting> on/off*`,
                        ``,
                        `Settings: ${VALID_SETTINGS.join(', ')}`,
                        ``,
                        `Example: *.allgroups antilink on*`,
                    ])
                }, { quoted: msg })
            }
            const { setSetting } = require('./groupSettings')
            try {
                const groups = await sock.groupFetchAllParticipating()
                const groupIds = Object.keys(groups)
                for (const gid of groupIds) setSetting(gid, sub, val === 'on')
                await sock.sendMessage(from, {
                    text: fmt.box('ALL GROUPS', [
                        `✅ *${sub}* → *${val.toUpperCase()}* in *${groupIds.length}* groups`,
                    ])
                }, { quoted: msg })
            } catch (e) {
                await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ ${e.message}`]) }, { quoted: msg })
            }
            break
        }

        case 'gcaddprivacy': {
            const val = (q || '').toLowerCase()
            const VALID = { all: 'all', contacts: 'contacts', none: 'contact_blacklist' }
            if (!VALID[val]) {
                return sock.sendMessage(from, {
                    text: fmt.box('GROUP ADD PRIVACY', [
                        `⚙️ Controls who can add this bot to groups.`,
                        ``,
                        `Usage: .gcaddprivacy <all|contacts|none>`,
                        `all      — anyone can add the bot`,
                        `contacts — only your saved contacts can`,
                        `none     — nobody can add it without you inviting it`,
                    ])
                }, { quoted: msg })
            }
            try {
                await sock.updateGroupsAddPrivacy(VALID[val])
                await sock.sendMessage(from, { text: fmt.box('SUCCESS', [`✅ Group-add privacy: *${val}*`]) }, { quoted: msg })
            } catch (e) {
                await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Failed: ${e.message}\nThis needs a recent Baileys version — check yours if it keeps failing.`]) }, { quoted: msg })
            }
            break
        }
        case 'ppprivacy': {
            const val = (q || '').toLowerCase()
            const VALID = { all: 'all', contacts: 'contacts', none: 'contact_blacklist' }
            if (!VALID[val]) {
                return sock.sendMessage(from, {
                    text: fmt.box('PROFILE PIC PRIVACY', [
                        `⚙️ Controls who can see the bot's profile picture.`,
                        ``,
                        `Usage: .ppprivacy <all|contacts|none>`,
                    ])
                }, { quoted: msg })
            }
            try {
                await sock.updateProfilePicturePrivacy(VALID[val])
                await sock.sendMessage(from, { text: fmt.box('SUCCESS', [`✅ Profile picture privacy: *${val}*`]) }, { quoted: msg })
            } catch (e) {
                await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Failed: ${e.message}`]) }, { quoted: msg })
            }
            break
        }
        case 'update': {
            const path = require('path')
            const fs   = require('fs')
            const cwd  = path.join(__dirname, '..')
            try {
                const { execSync } = require('child_process')
                await sock.sendMessage(from, { text: fmt.box('UPDATE', [`🔄 Checking for updates...`]) }, { quoted: msg })

                // `dist/` (what actually gets pushed to GitHub) is fully
                // rebuilt and force-pushed on every release — a fresh
                // unrelated history each time, not just "ahead" commits. A
                // plain `git pull` chokes on that with a "divergent
                // branches" error. `fetch` + hard reset always works
                // instead, since it doesn't try to merge/rebase anything —
                // it just makes the panel match GitHub exactly. `.env` is
                // backed up and restored around the reset so a real
                // SESSION_ID on the panel is never touched by this, even
                // though `.env` isn't tracked by git at all.
                execSync('git fetch origin', { cwd, encoding: 'utf8' })
                const localHead  = execSync('git rev-parse HEAD', { cwd, encoding: 'utf8' }).trim()
                const remoteHead = execSync('git rev-parse origin/HEAD', { cwd, encoding: 'utf8' }).trim()

                if (localHead === remoteHead) {
                    await sock.sendMessage(from, { text: fmt.box('UPDATE', [`✅ Already up to date.`]) }, { quoted: msg })
                } else {
                    const envPath     = path.join(cwd, '.env')
                    const envKeepPath = path.join(cwd, '.env.keep')
                    if (fs.existsSync(envPath)) fs.copyFileSync(envPath, envKeepPath)

                    execSync('git reset --hard origin/HEAD', { cwd, encoding: 'utf8' })

                    if (fs.existsSync(envKeepPath)) {
                        fs.copyFileSync(envKeepPath, envPath)
                        fs.unlinkSync(envKeepPath)
                    }

                    await sock.sendMessage(from, { text: fmt.box('UPDATE', [`✅ Synced with GitHub.`, `Restarting...`]) }, { quoted: msg })
                    setTimeout(() => process.exit(0), 1500)
                }
            } catch (e) {
                await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Update failed: ${e.message}`, `This only works if the bot is running from a git checkout — not a plain zip deploy.`]) }, { quoted: msg })
            }
            break
        }

        // Reverse of .update: pushes whatever is currently on the panel (e.g.
        // after uploading a new zip I've handed you) up to GitHub, so you
        // don't have to touch git manually. Needs: this folder already a git
        // repo with a remote configured, and push credentials already set up
        // on this host (a Personal Access Token baked into the remote URL,
        // or a saved credential helper) — it can't prompt for a password.
        case 'updatecode': case 'pushcode': {
            const path = require('path')
            const { execSync } = require('child_process')
            const cwd = path.join(__dirname, '..')
            try {
                await sock.sendMessage(from, { text: fmt.box('PUSH', [`🔄 Pushing local changes to GitHub...`]) }, { quoted: msg })
                execSync('git add -A', { cwd, encoding: 'utf8' })
                const status = execSync('git status --porcelain', { cwd, encoding: 'utf8' })
                if (!status.trim()) {
                    return sock.sendMessage(from, { text: fmt.box('PUSH', [`ℹ️ Nothing to commit — GitHub already matches what's on the panel.`]) }, { quoted: msg })
                }
                const message = q || `Update from panel — ${new Date().toISOString()}`
                execSync(`git commit -m ${JSON.stringify(message)}`, { cwd, encoding: 'utf8' })
                execSync('git push', { cwd, encoding: 'utf8' })
                await sock.sendMessage(from, { text: fmt.box('PUSH', [`✅ Pushed to GitHub.`, `_${message}_`]) }, { quoted: msg })
            } catch (e) {
                await sock.sendMessage(from, {
                    text: fmt.box('ERROR', [
                        `❌ Push failed: ${(e.message || '').slice(0, 400)}`,
                        `Needs this folder to already be a git repo with a remote + push credentials configured on this host — it can't prompt for a password interactively.`,
                    ])
                }, { quoted: msg })
            }
            break
        }

        case 'aza': case 'resetaza': case 'setaza': case 'autosavestatus2': {
            await sock.sendMessage(from, { text: fmt.box('BOT', [`⚙️ This feature is coming soon.`]) }, { quoted: msg }); break
        }

        case 'bancheck': {
            const on  = '🔴 ON  ← BAN RISK'
            const off = '🟢 OFF ← Safe'
            await sock.sendMessage(from, {
                text: fmt.box('BAN RISK CHECK', [
                    `🔍 Checking your current settings...`,
                    ``,
                    `${runtimeSettings.alwaysonline  ? on : off} — alwaysonline`,
                    `${runtimeSettings.autotype       ? on : off} — autotype`,
                    `${runtimeSettings.autoread       ? on : off} — autoread`,
                    `${runtimeSettings.autoreactstatus? on : off} — autoreactstatus`,
                    `${runtimeSettings.autoviewstatus ? '🟡 ON  ← Low risk' : off} — autoviewstatus`,
                    ``,
                    `💡 *Recommended:* Keep all these OFF`,
                    `💡 Only enable what you actually need`,
                ])
            }, { quoted: msg }); break
        }

        default:
            await sock.sendMessage(from, { text: `❓ Unknown owner command: .${cmd}` }, { quoted: msg })
    }
}

module.exports = { handleOwnerCmd, badWords, ignoredNumbers, runtimeSettings, STATUS_EMOJIS, scopeAllows }
