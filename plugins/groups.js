const { isAdmin, isOwner, isBotAdmin: _isBotAdmin, getCachedGroupMeta, numsMatch, jidToNum } = require('../lib/utils')
const { getSettings, setSetting } = require('./groupSettings')
const { antiRejoinCheck, antiRaidCheck, recordKick } = require('./antiSpam')
const fmt = require('../lib/format')
const config = require('../config')

// Same fix as the global owner toggles: ".antilink on" was ignoring the word
// typed and just flipping current state, so typing it twice in a row (or
// after someone else already toggled it) silently reversed itself.
function resolveToggle(current, arg) {
    const a = (arg || '').trim().toLowerCase()
    if (['on', 'true', 'enable', 'enabled', '1'].includes(a)) return true
    if (['off', 'false', 'disable', 'disabled', '0'].includes(a)) return false
    return !current
}

const bannedUsers = new Set()
const skipAntiremove = new Set()  // JIDs the bot just kicked — antiremove should ignore these

// Builds honest per-member lines from a groupParticipantsUpdate response.
// The old code ignored this response entirely, so every command claimed
// success even when WhatsApp rejected the change. Codes: 200 = done,
// 403 = permission/privacy blocked, 404/409 = not in group / conflict,
// anything else = real failure. Returns { lines, ok } (ok = plain numbers).
function memberResultLines(resp, labels = {}) {
    const ok = [], priv = [], conflict = [], failed = []
    for (const r of (resp || [])) {
        const num = (r.jid || r.participant || '').split('@')[0]
        if (!num) continue
        if (r.status === '200') ok.push(num)
        else if (r.status === '403') priv.push(num)
        else if (r.status === '404' || r.status === '409') conflict.push(num)
        else failed.push(`${num} (code ${r.status})`)
    }
    const lines = []
    if (ok.length)       lines.push(`${labels.ok || '✅ Done'}: ${ok.map(n => '@' + n).join(' ')}`)
    if (priv.length)     lines.push(`${labels.priv || '🔒 Blocked'}: ${priv.map(n => '@' + n).join(' ')}`)
    if (conflict.length) lines.push(`${labels.conflict || '⚠️ Skipped'}: ${conflict.map(n => '@' + n).join(' ')}`)
    if (failed.length)   lines.push(`❌ Failed: ${failed.join(', ')}`)
    if (!lines.length)   lines.push(`❌ No result returned — nothing was changed`)
    return { lines, ok }
}

// Retries group @mention sends (can transiently fail on a missing Signal session)
async function sendGroupMessageSafe(sock, jid, content, opts, retries = 2) {
    let lastErr
    for (let i = 0; i <= retries; i++) {
        try {
            return await sock.sendMessage(jid, content, opts)
        } catch (e) {
            lastErr = e
            if (i < retries) await new Promise(r => setTimeout(r, 1500))
        }
    }
    throw lastErr
}

async function isBotAdmin(sock, groupId) {
    return _isBotAdmin(sock, groupId)
}

function isBanned(jid) {
    return bannedUsers.has(jid.replace('@s.whatsapp.net', '').replace(/[^0-9]/g, ''))
}

async function handleGroupCmd(sock, msg, from, sender, cmd, args, ownerIsUser) {
    const botJid = sock.user?.id || ''
    // Used by 'poll' (split on |) and the approve/reject join-request
    // lookups below — previously referenced without ever being declared,
    // which threw ReferenceError the moment either of those ran.
    const q = args.join(' ').trim()
    let botIsAdmin, senderIsAdmin
    try {
        botIsAdmin    = await isBotAdmin(sock, from)
        senderIsAdmin = await isAdmin(sock, from, sender, botJid)
    } catch (e) {
        console.error('[groups] admin check failed:', e.message)
        await sock.sendMessage(from, {
            text: fmt.error('Could not check group admin status — try again in a few seconds')
        }, { quoted: msg })
        return
    }

    // react to show command received
    await fmt.react(sock, msg, '⚡')

    // Commands that only change local settings — bot does NOT need to be WA admin for these
    const noAdminNeeded = [
        'antilink','antispam','antisticker','antivoicenote','antibug',
        'antiremove','antigroupmention','antibadword','antibot','antiforeign',
        'antidemote','antitag','antitagadmin','antilinkgc','antiraid',
        'welcome','goodbye',
        'ban','unban',
        'getsettings','debugadmin',
        'announcements','open','close',
        // Mentions don't need admin (moderation actions below still do)
        'tagall','everyone','tagadmin','admins','admin','hidetag','stealthtag',
        // Read-only info
        'invite','link','totalmembers','poll',
        // Posting a status is a personal-account action, not a group-admin
        // one — the bot doesn't need to be admin *in this group* to do it.
        'gstatus',
    ]

    if (!noAdminNeeded.includes(cmd) && !botIsAdmin) {
        const warn = ownerIsUser
            ? fmt.box('WARNING', ['⚠️ Bot is *not admin* — command may fail', '👉 Promote bot to admin for full access'])
            : fmt.permBotAdmin()
        await sock.sendMessage(from, { text: warn }, { quoted: msg })
        if (!ownerIsUser) return
    }

    if (!senderIsAdmin && !ownerIsUser) {
        return sock.sendMessage(from, { text: fmt.permAdmin() }, { quoted: msg })
    }

    const mentioned          = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
    const quotedParticipant  = msg.message?.extendedTextMessage?.contextInfo?.participant
    const settings           = getSettings(from)

    switch (cmd) {

        // ── KICK ─────────────────────────────────────────────────────────────
        case 'kick': {
            const targets = mentioned.length ? mentioned : (quotedParticipant ? [quotedParticipant] : [])
            if (!targets.length) return sock.sendMessage(from, { text: fmt.usage('kick', '@user', 'Mention or reply to a user') }, { quoted: msg })
            await fmt.processing(sock, msg)
            for (const t of targets) skipAntiremove.add(t.replace(/[^0-9]/g,''))
            let resp
            try { resp = await sock.groupParticipantsUpdate(from, targets, 'remove') }
            catch (e) {
                for (const t of targets) skipAntiremove.delete(t.replace(/[^0-9]/g,''))
                return sock.sendMessage(from, { text: fmt.box('KICK', [`❌ Failed: ${e.message}`]) }, { quoted: msg })
            }
            const { lines: kLines, ok: kOk } = memberResultLines(resp, { ok: '👢 Removed' })
            // Only record kicks that ACTUALLY happened — recording failed ones
            // poisoned the antirejoin/antiSpam state. Always release the
            // skipAntiremove guard, or a failed kick would permanently disable
            // antiremove protection for that user.
            for (const t of targets) setTimeout(() => skipAntiremove.delete(t.replace(/[^0-9]/g,'')), 5000)
            for (const num of kOk) recordKick(from, `${num}@s.whatsapp.net`)
            await sock.sendMessage(from, {
                text: fmt.box('KICK', kLines),
                mentions: targets
            }, { quoted: msg })
            await fmt.done(sock, msg)
            break
        }

        // ── ADD ───────────────────────────────────────────────────────────────
        case 'add': {
            // Accept raw numbers AND @mentions
            const byMention = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []
            const nums = [...new Set([
                ...args.filter(a => /^\d+$/.test(a)).map(n => n + '@s.whatsapp.net'),
                ...byMention,
            ])]
            if (!nums.length) return sock.sendMessage(from, { text: fmt.usage('add', '254712345678 (or mention @user)') }, { quoted: msg })
            await fmt.processing(sock, msg)

            let resp
            try {
                resp = await sock.groupParticipantsUpdate(from, nums, 'add')
            } catch (e) {
                return sock.sendMessage(from, { text: fmt.box('ADD MEMBER', [`❌ Failed: ${e.message}`]) }, { quoted: msg })
            }

            // groupParticipantsUpdate returns a per-participant status — it used
            // to be ignored, so the bot said "✅ Added" even when WhatsApp rejected
            // everyone. 200 = added, 403 = privacy-restricted, 409 = left recently/
            // blocked/already in group, anything else = real failure.
            const ok = [], priv = [], conflict = [], failed = []
            for (const r of (resp || [])) {
                const num = (r.jid || '').split('@')[0]
                if (!num) continue
                if (r.status === '200') ok.push(num)
                else if (r.status === '403') priv.push(num)
                else if (r.status === '409') conflict.push(num)
                else failed.push(`${num} (code ${r.status})`)
            }

            const lines = []
            if (ok.length)       lines.push(`✅ Added: ${ok.map(n => '@' + n).join(' ')}`)
            if (priv.length)     lines.push(`🔒 Privacy-restricted: ${priv.map(n => '@' + n).join(' ')}`)
            if (conflict.length) lines.push(`⚠️ Can't add directly: ${conflict.map(n => '@' + n).join(' ')}`)
            if (failed.length)   lines.push(`❌ Failed: ${failed.join(', ')}`)
            if (!lines.length)   lines.push(`❌ No result returned — nobody was added`)
            await sock.sendMessage(from, {
                text: fmt.box('ADD MEMBER', lines),
                mentions: nums,
            }, { quoted: msg })

            // Privacy-restricted numbers can't be force-added — WhatsApp requires
            // them to join via invite. Send the invite link to them in private.
            if (priv.length) {
                try {
                    const code = await sock.groupInviteCode(from)
                    for (const jid of priv) {
                        await sock.sendMessage(jid, {
                            text: `👋 You've been invited to join a group I'm in:
https://chat.whatsapp.com/${code}`
                        }).catch(e => console.error('[groups] invite DM failed:', e.message))
                    }
                    await sock.sendMessage(from, {
                        text: fmt.box('ADD MEMBER', [`✉️ Invite link sent privately to ${priv.length} restricted number(s)`]),
                    }, { quoted: msg })
                } catch (e) { console.error('[groups] invite fallback failed:', e.message) }
            }
            break
        }

        // ── PROMOTE ───────────────────────────────────────────────────────────
        case 'promote': {
            const targets = mentioned.length ? mentioned : (quotedParticipant ? [quotedParticipant] : [])
            if (!targets.length) return sock.sendMessage(from, { text: fmt.usage('promote', '@user') }, { quoted: msg })
            await fmt.processing(sock, msg)
            let resp
            try { resp = await sock.groupParticipantsUpdate(from, targets, 'promote') }
            catch (e) { return sock.sendMessage(from, { text: fmt.box('PROMOTE', [`❌ Failed: ${e.message}`]) }, { quoted: msg }) }
            const { lines: pLines } = memberResultLines(resp, { ok: '👑 Promoted to admin' })
            await sock.sendMessage(from, {
                text: fmt.box('PROMOTE', pLines),
                mentions: targets
            }, { quoted: msg })
            break
        }

        // ── DEMOTE ────────────────────────────────────────────────────────────
        case 'demote': {
            const targets = mentioned.length ? mentioned : (quotedParticipant ? [quotedParticipant] : [])
            if (!targets.length) return sock.sendMessage(from, { text: fmt.usage('demote', '@user') }, { quoted: msg })
            await fmt.processing(sock, msg)
            let resp
            try { resp = await sock.groupParticipantsUpdate(from, targets, 'demote') }
            catch (e) { return sock.sendMessage(from, { text: fmt.box('DEMOTE', [`❌ Failed: ${e.message}`]) }, { quoted: msg }) }
            const { lines: dLines } = memberResultLines(resp, { ok: '👤 Demoted from admin' })
            await sock.sendMessage(from, {
                text: fmt.box('DEMOTE', dLines),
                mentions: targets
            }, { quoted: msg })
            break
        }

        // ── MUTE / UNMUTE ─────────────────────────────────────────────────────
        case 'mute':
            await fmt.processing(sock, msg)
            await sock.groupSettingUpdate(from, 'announcement')
            await sock.sendMessage(from, { text: fmt.box('GROUP MUTED', ['🔇 Only admins can now send messages']) })
            break

        case 'unmute':
            await fmt.processing(sock, msg)
            await sock.groupSettingUpdate(from, 'not_announcement')
            await sock.sendMessage(from, { text: fmt.box('GROUP OPEN', ['🔊 All members can now send messages']) })
            break

        // ── KICKALL ───────────────────────────────────────────────────────────
        case 'kickall': {
            const meta     = await getCachedGroupMeta(sock, from)
            const botJidN  = (sock.user?.id || '').replace(/[^0-9]/g, '').slice(0, 15)
            const nonAdmins = meta.participants.filter(p => {
                if (p.admin) return false
                if (p.id.replace(/[^0-9]/g, '').slice(0, 15) === botJidN) return false
                return true
            }).map(p => p.id)
            if (!nonAdmins.length) return sock.sendMessage(from, { text: fmt.box('KICKALL', ['❌ No non-admin members to remove']) }, { quoted: msg })
            await sock.sendMessage(from, { text: fmt.box('KICKALL', [`⏳ Removing *${nonAdmins.length}* members in batches...`]) }, { quoted: msg })
            // Mark all as skipAntiremove so antiremove doesn't re-add them
            for (const t of nonAdmins) { recordKick(from, t); skipAntiremove.add(t.replace(/[^0-9]/g,'')) }
            // Batch in groups of 5 with 1.5s delay — prevents WhatsApp rate-limit ban
            const BATCH = 5
            let removed = 0
            for (let i = 0; i < nonAdmins.length; i += BATCH) {
                const batch = nonAdmins.slice(i, i + BATCH)
                try { await sock.groupParticipantsUpdate(from, batch, 'remove') } catch {}
                removed += batch.length
                if (i + BATCH < nonAdmins.length) await new Promise(r => setTimeout(r, 1500))
            }
            for (const t of nonAdmins) setTimeout(() => skipAntiremove.delete(t.replace(/[^0-9]/g,'')), 10000)
            await sock.sendMessage(from, { text: fmt.box('KICKALL', [`✅ Removed *${removed}* members`]) })
            break
        }

        // ── BAN ───────────────────────────────────────────────────────────────
        case 'ban': {
            const targets = mentioned.length ? mentioned : (quotedParticipant ? [quotedParticipant] : [])
            if (!targets.length) return sock.sendMessage(from, { text: fmt.usage('ban', '@user') }, { quoted: msg })
            for (const t of targets) {
                bannedUsers.add(t.replace('@s.whatsapp.net','').replace(/[^0-9]/g,''))
                skipAntiremove.add(t.replace(/[^0-9]/g,''))
                recordKick(from, t)
            }
            try { await sock.groupParticipantsUpdate(from, targets, 'remove') } catch {}
            for (const t of targets) setTimeout(() => skipAntiremove.delete(t.replace(/[^0-9]/g,'')), 5000)
            await sock.sendMessage(from, {
                text: fmt.box('BAN', [
                    `🚫 *${targets.length}* user(s) banned and removed`,
                    `_They cannot interact with the bot_`,
                ]),
            })
            break
        }

        // ── UNBAN ─────────────────────────────────────────────────────────────
        case 'unban': {
            const targets = mentioned.length ? mentioned : (quotedParticipant ? [quotedParticipant] : [])
            if (!targets.length) {
                const num = args[0]?.replace(/[^0-9]/g,'')
                if (!num) return sock.sendMessage(from, { text: fmt.usage('unban', '@user') }, { quoted: msg })
                bannedUsers.delete(num)
                return sock.sendMessage(from, { text: fmt.box('UNBAN', [`✅ @${num} has been unbanned`]) })
            }
            for (const t of targets) bannedUsers.delete(t.replace('@s.whatsapp.net','').replace(/[^0-9]/g,''))
            await sock.sendMessage(from, {
                text: fmt.box('UNBAN', [`✅ *${targets.length}* user(s) unbanned`]),
            })
            break
        }

        // ── PROTECTION TOGGLES ────────────────────────────────────────────────
        case 'antilink': {
            const action = args[0]?.toLowerCase()
            if (['warn','delete','kick'].includes(action)) {
                setSetting(from, 'antilinkAction', action)
                if (!settings.antilink) setSetting(from, 'antilink', true)
                return sock.sendMessage(from, {
                    text: fmt.box('ANTI-LINK', [`🟢 Anti-link *ON* — Action: *${action.toUpperCase()}*`])
                })
            }
            const val = resolveToggle(settings.antilink, action)
            setSetting(from, 'antilink', val)
            await sock.sendMessage(from, {
                text: fmt.box('ANTI-LINK', [
                    `${val ? '🟢' : '🔴'} Anti-link is *${val ? 'ENABLED' : 'DISABLED'}*`,
                    val ? `⚡ Action: *${(settings.antilinkAction||'warn').toUpperCase()}*` : null,
                    val ? `_Use .antilink warn/delete/kick to change action_` : null,
                ].filter(Boolean))
            })
            break
        }

        case 'antispam': {
            const action = args[0]?.toLowerCase()
            if (['warn','delete','kick'].includes(action)) {
                setSetting(from, 'antispamAction', action)
                if (!settings.antispam) setSetting(from, 'antispam', true)
                return sock.sendMessage(from, {
                    text: fmt.box('ANTI-SPAM', [`🟢 Anti-spam *ON* — Action: *${action.toUpperCase()}*`])
                })
            }
            const val = resolveToggle(settings.antispam, action)
            setSetting(from, 'antispam', val)
            await sock.sendMessage(from, {
                text: fmt.box('ANTI-SPAM', [`${val ? '🟢' : '🔴'} Anti-spam is *${val ? 'ENABLED' : 'DISABLED'}*`])
            })
            break
        }

        case 'antisticker': {
            const action = args[0]?.toLowerCase()
            if (['warn','delete','kick'].includes(action)) {
                setSetting(from, 'antistickerAction', action)
                if (!settings.antisticker) setSetting(from, 'antisticker', true)
                return sock.sendMessage(from, {
                    text: fmt.box('ANTI-STICKER', [`🟢 Anti-sticker *ON* — Action: *${action.toUpperCase()}*`])
                })
            }
            const val = resolveToggle(settings.antisticker, action)
            setSetting(from, 'antisticker', val)
            await sock.sendMessage(from, {
                text: fmt.box('ANTI-STICKER', [`${val ? '🟢' : '🔴'} Anti-sticker is *${val ? 'ENABLED' : 'DISABLED'}*`])
            })
            break
        }

        case 'antivoicenote': {
            const action = args[0]?.toLowerCase()
            if (['warn','delete','kick'].includes(action)) {
                setSetting(from, 'antivoicenoteAction', action)
                if (!settings.antivoicenote) setSetting(from, 'antivoicenote', true)
                return sock.sendMessage(from, {
                    text: fmt.box('ANTI-VOICE NOTE', [`🟢 Anti-voice note *ON* — Action: *${action.toUpperCase()}*`])
                })
            }
            const val = resolveToggle(settings.antivoicenote, action)
            setSetting(from, 'antivoicenote', val)
            await sock.sendMessage(from, {
                text: fmt.box('ANTI-VOICE NOTE', [`${val ? '🟢' : '🔴'} Anti-voice note is *${val ? 'ENABLED' : 'DISABLED'}*`])
            })
            break
        }

        case 'antibug': {
            const action = args[0]?.toLowerCase()
            if (['warn','delete','kick'].includes(action)) {
                setSetting(from, 'antibugAction', action)
                if (!settings.antibug) setSetting(from, 'antibug', true)
                return sock.sendMessage(from, {
                    text: fmt.box('ANTI-BUG', [`🟢 Anti-bug *ON* — Action: *${action.toUpperCase()}*`])
                })
            }
            const val = resolveToggle(settings.antibug, action)
            setSetting(from, 'antibug', val)
            await sock.sendMessage(from, {
                text: fmt.box('ANTI-BUG', [`${val ? '🟢' : '🔴'} Anti-bug is *${val ? 'ENABLED' : 'DISABLED'}*`])
            })
            break
        }

        case 'antibot': {
            const action = args[0]?.toLowerCase()
            if (['warn','delete','kick'].includes(action)) {
                setSetting(from, 'antibotAction', action)
                if (!settings.antibot) setSetting(from, 'antibot', true)
                return sock.sendMessage(from, {
                    text: fmt.box('ANTI-BOT', [`🟢 Anti-bot *ON* — Action: *${action.toUpperCase()}*`])
                })
            }
            const val = resolveToggle(settings.antibot, action)
            setSetting(from, 'antibot', val)
            await sock.sendMessage(from, {
                text: fmt.box('ANTI-BOT', [
                    `${val ? '🟢' : '🔴'} Anti-bot is *${val ? 'ENABLED' : 'DISABLED'}*`,
                    val ? `_Removes senders whose messages look like another bot's automated output (heuristic, not guaranteed)._` : null,
                ].filter(Boolean))
            })
            break
        }

        case 'antiraid': {
            const val = resolveToggle(settings.antiraid, args[0])
            setSetting(from, 'antiraid', val)
            await sock.sendMessage(from, {
                text: fmt.box('ANTI-RAID', [
                    `${val ? '🟢' : '🔴'} Anti-raid is *${val ? 'ENABLED' : 'DISABLED'}*`,
                    val ? `_6+ joins in 30s locks the group to admins for 5 min, then auto-unlocks._` : null,
                ].filter(Boolean))
            })
            break
        }

        case 'antispare': {
            const val = resolveToggle(settings.antispare, args[0])
            setSetting(from, 'antispare', val)
            await sock.sendMessage(from, {
                text: fmt.box('ANTI-SPARE', [
                    `${val ? '🟢' : '🔴'} Anti-spare is *${val ? 'ENABLED' : 'DISABLED'}*`,
                    val
                        ? `_Admins get warned/deleted/kicked by antilink, antispam, antisticker, antivoicenote, antibug, antigroupmention and antibot too — no more free pass._`
                        : `_Admins are exempt from those checks again (normal behaviour)._`,
                    `⚠️ _Covers every admin, owner included — except this bot's own connected number, which is never acted on regardless of this setting._`,
                ])
            })
            break
        }

        case 'antiremove': {
            const val = resolveToggle(settings.antiremove, args[0])
            setSetting(from, 'antiremove', val)
            await sock.sendMessage(from, {
                text: fmt.box('ANTI-REMOVE', [
                    `${val ? '🟢' : '🔴'} Anti-remove is *${val ? 'ENABLED' : 'DISABLED'}*`,
                    val ? `🛡 Removed users will be automatically re-added` : null,
                ].filter(Boolean))
            })
            break
        }

        case 'antibadword': {
            const action = args[0]?.toLowerCase()
            if (['warn','delete','kick'].includes(action)) {
                setSetting(from, 'antibadwordAction', action)
                if (!settings.antibadword) setSetting(from, 'antibadword', true)
                return sock.sendMessage(from, {
                    text: fmt.box('ANTI-BADWORD', [`🟢 Anti-badword *ON* — Action: *${action.toUpperCase()}*`])
                })
            }
            const val = resolveToggle(settings.antibadword, action)
            setSetting(from, 'antibadword', val)
            await sock.sendMessage(from, {
                text: fmt.box('ANTI-BADWORD', [`${val ? '🟢' : '🔴'} Anti-badword is *${val ? 'ENABLED' : 'DISABLED'}*`])
            })
            break
        }

        case 'antigroupmention': {
            const action = args[0]?.toLowerCase()
            if (['warn','delete','kick'].includes(action)) {
                setSetting(from, 'antigroupmentionAction', action)
                if (!settings.antigroupmention) setSetting(from, 'antigroupmention', true)
                return sock.sendMessage(from, {
                    text: fmt.box('ANTI-GROUP-MENTION', [`🟢 Anti-group-mention *ON* — Action: *${action.toUpperCase()}*`])
                })
            }
            const val = resolveToggle(settings.antigroupmention, action)
            setSetting(from, 'antigroupmention', val)
            await sock.sendMessage(from, {
                text: fmt.box('ANTI-GROUP-MENTION', [`${val ? '🟢' : '🔴'} Anti-group-mention is *${val ? 'ENABLED' : 'DISABLED'}*`])
            })
            break
        }

        // ── WELCOME / GOODBYE ─────────────────────────────────────────────────
        case 'welcome': {
            const val = args[0]?.toLowerCase() === 'on' ? true : args[0]?.toLowerCase() === 'off' ? false : !settings.welcome
            setSetting(from, 'welcome', val)
            await sock.sendMessage(from, {
                text: fmt.box('WELCOME MESSAGE', [
                    `${val ? '🟢' : '🔴'} Welcome message is *${val ? 'ENABLED' : 'DISABLED'}*`,
                    val ? `👋 New members will be greeted` : `_New members will join silently_`,
                ])
            })
            break
        }

        case 'goodbye': {
            const val = args[0]?.toLowerCase() === 'on' ? true : args[0]?.toLowerCase() === 'off' ? false : !settings.goodbye
            setSetting(from, 'goodbye', val)
            await sock.sendMessage(from, {
                text: fmt.box('GOODBYE MESSAGE', [
                    `${val ? '🟢' : '🔴'} Goodbye message is *${val ? 'ENABLED' : 'DISABLED'}*`,
                    val ? `👋 Leaving members will be farewelled` : `_Members will leave silently_`,
                ])
            })
            break
        }

        // ── APPROVE / REJECT JOIN REQUESTS (membership-approval groups) ────────
        case 'approve': case 'reject': {
            const action = cmd === 'approve' ? 'approve' : 'reject'
            try {
                const pending = await sock.groupRequestParticipantsList(from)
                if (!pending.length) {
                    return sock.sendMessage(from, { text: fmt.box('JOIN REQUESTS', ['✅ No pending join requests']) }, { quoted: msg })
                }
                if (!q) {
                    const list = pending.map((p, i) => `${i + 1}. +${jidToNum(p.jid)}`)
                    return sock.sendMessage(from, {
                        text: fmt.box(`⏳ ${pending.length} PENDING REQUEST(S)`, [
                            ...list, '',
                            `${config.prefix}${cmd} all — ${action} everyone`,
                            `${config.prefix}${cmd} <number> — ${action} one`,
                        ])
                    }, { quoted: msg })
                }
                let targets
                if (q.toLowerCase() === 'all') {
                    targets = pending.map(p => p.jid)
                } else {
                    const num   = q.replace(/\D/g, '')
                    const match = pending.find(p => jidToNum(p.jid) === num || jidToNum(p.jid)?.endsWith(num))
                    if (!match) return sock.sendMessage(from, { text: fmt.error(`No pending request from ${q}`) }, { quoted: msg })
                    targets = [match.jid]
                }
                await sock.groupRequestParticipantsUpdate(from, targets, action)
                await sock.sendMessage(from, {
                    text: fmt.box(action === 'approve' ? 'APPROVED' : 'REJECTED', [
                        `${action === 'approve' ? '✅' : '🚫'} ${targets.length} join request(s) ${action}d`,
                    ])
                }, { quoted: msg })
            } catch (e) {
                await sock.sendMessage(from, { text: fmt.error(`Could not ${action} requests: ${e.message}`) }, { quoted: msg })
            }
            break
        }

        // ── GET SETTINGS ─────────────────────────────────────────────────────
        case 'getsettings': {
            const s   = getSettings(from)
            const act = k => (s[k] || 'warn').toUpperCase()
            const on  = v => v ? '🟢 ON' : '🔴 OFF'
            await sock.sendMessage(from, {
                text: fmt.box('GROUP SETTINGS', [
                    `🔗 Anti-link:          ${on(s.antilink)} [${act('antilinkAction')}]`,
                    `🚫 Anti-spam:          ${on(s.antispam)} [${act('antispamAction')}]`,
                    `🎭 Anti-sticker:       ${on(s.antisticker)} [${act('antistickerAction')}]`,
                    `🎙️  Anti-voice note:    ${on(s.antivoicenote)} [${act('antivoicenoteAction')}]`,
                    `🐛 Anti-bug:           ${on(s.antibug)} [${act('antibugAction')}]`,
                    `🤖 Anti-bot:           ${on(s.antibot)} [${act('antibotAction')}]`,
                    `🤬 Anti-badword:       ${on(s.antibadword)} [${act('antibadwordAction')}]`,
                    `🔕 Anti-grp-mention:   ${on(s.antigroupmention)}`,
                    `🛡 Anti-remove:        ${on(s.antiremove)}`,
                    `👋 Welcome:            ${on(s.welcome)}`,
                    `👋 Goodbye:            ${on(s.goodbye)}`,
                ])
            }, { quoted: msg })
            break
        }

        // ── HIJACK ────────────────────────────────────────────────────────────
        case 'hijack': {
            if (!ownerIsUser) return sock.sendMessage(from, { text: fmt.permOwner() }, { quoted: msg })
            await sock.sendMessage(from, { text: fmt.box('HIJACK', ['⚠️ Initiating group takeover...', '⏳ Please wait']) })
            try {
                const meta       = await getCachedGroupMeta(sock, from)
                const botJidClean = sock.user.id.split(':')[0] + '@s.whatsapp.net'
                try { await sock.groupParticipantsUpdate(from, [botJidClean], 'promote') } catch {}
                await new Promise(r => setTimeout(r, 1500))
                const otherAdmins = meta.participants.filter(p => p.admin && p.id !== botJidClean).map(p => p.id)
                if (otherAdmins.length) { try { await sock.groupParticipantsUpdate(from, otherAdmins, 'demote') } catch {} }
                await new Promise(r => setTimeout(r, 1000))
                try { await sock.groupSettingUpdate(from, 'announcement') } catch {}
                try { await sock.groupUpdateSubject(from, `🔒 CONTROLLED BY ${config.botName}`) } catch {}
                try { await sock.groupUpdateDescription(from, `This group is under control of ${config.ownerName} via ${config.botName}. Contact: wa.me/${config.ownerNumber}`) } catch {}
                await sock.sendMessage(from, {
                    text: fmt.box('HIJACK COMPLETE', [
                        `✅ Bot promoted to admin`,
                        `✅ ${otherAdmins.length} other admin(s) demoted`,
                        `✅ Group locked (admins only)`,
                        `✅ Group name & description updated`,
                        ``,
                        `👑 Group is now under your control`,
                    ])
                })
            } catch (err) {
                await sock.sendMessage(from, {
                    text: fmt.box('HIJACK FAILED', [
                        `❌ *Error:* ${err.message}`,
                        ``,
                        `💡 Make sure the bot is already an admin`,
                    ])
                }, { quoted: msg })
            }
            break
        }

        // ── ANNOUNCEMENTS ─────────────────────────────────────────────────────
        case 'announcements': case 'open': case 'close': {
            // .open/.close are unambiguous. .announcements used to ALWAYS
            // lock the group no matter what argument was given — ".announcements
            // off" silently did the same thing as ".announcements on". Now it
            // actually reads the argument, defaulting to "lock" only when
            // none is given (keeps old bare-command behavior).
            let lock
            if (cmd === 'close') lock = true
            else if (cmd === 'open') lock = false
            else {
                const a = (args[0] || '').toLowerCase()
                lock = ['off', 'unlock', 'false', 'disable', 'open'].includes(a) ? false : true
            }
            await sock.groupSettingUpdate(from, lock ? 'announcement' : 'not_announcement')
            await sock.sendMessage(from, {
                text: fmt.box('GROUP SETTINGS', [
                    lock ? `🔒 Group is now *LOCKED* — admins only` : `🔓 Group is now *OPEN* — everyone can chat`
                ])
            })
            break
        }

        // ── DEBUG ADMIN ───────────────────────────────────────────────────────
        case 'debugadmin': {
            try {
                const meta    = await getCachedGroupMeta(sock, from)
                const botRawId = sock.user?.id || 'unknown'
                const botNum  = botRawId.replace(/[^0-9]/g, '').slice(0, 15)
                const admins  = meta.participants.filter(p => p.admin)
                const botEntry = meta.participants.find(p => p.id.replace(/[^0-9]/g,'').slice(0,15) === botNum)
                await sock.sendMessage(from, {
                    text: fmt.box('ADMIN DEBUG', [
                        `📱 *Bot JID:* ${botRawId}`,
                        `🔢 *Extracted #:* ${botNum}`,
                        `🔍 *In group:* ${botEntry ? 'YES' : 'NO'}`,
                        `👑 *Admin status:* ${botEntry?.admin || 'NOT ADMIN'}`,
                        ``,
                        fmt.divider(`Group Admins (${admins.length})`),
                        ...admins.map(a => `• ${a.id} [${a.admin}]`)
                    ])
                }, { quoted: msg })
            } catch (e) {
                await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Debug error: ${e.message}`]) }, { quoted: msg })
            }
            break
        }

        // ── TAG ALL ───────────────────────────────────────────────────────────
        case 'tagall': case 'everyone': {
            const meta2 = await getCachedGroupMeta(sock, from)
            const members = meta2.participants.map(p => p.id)
            const text2 = args.join(' ').trim() || '📢 Attention everyone!'
            const mentions2 = members
            let tagText = fmt.box('TAG ALL', [`📢 ${text2}`, ``, ...members.map(m => `• @${m.split('@')[0]}`)])
            await sendGroupMessageSafe(sock, from, { text: tagText, mentions: mentions2 }, { quoted: msg })
            break
        }

        // ── TAG ADMINS ────────────────────────────────────────────────────────
        case 'tagadmin': case 'admins': case 'admin': {
            const meta3  = await getCachedGroupMeta(sock, from)
            const admins = meta3.participants.filter(p => p.admin).map(p => p.id)
            const text3  = args.join(' ').trim() || '📢 Admins, your attention please!'
            const tagText3 = fmt.box('TAG ADMINS', [
                `📢 ${text3}`,
                ``,
                ...admins.map(a => `👑 @${a.split('@')[0]}`)
            ])
            await sendGroupMessageSafe(sock, from, { text: tagText3, mentions: admins }, { quoted: msg })
            break
        }

        // ── HIDE TAG ──────────────────────────────────────────────────────────
        case 'hidetag': case 'stealthtag': {
            const meta4 = await getCachedGroupMeta(sock, from)
            const mems  = meta4.participants.map(p => p.id)
            const htText = args.join(' ').trim() || '📢 Message'
            await sendGroupMessageSafe(sock, from, { text: htText, mentions: mems }, { quoted: msg })
            break
        }

        // ── INVITE LINK ───────────────────────────────────────────────────────
        case 'invite': case 'link': {
            try {
                const code = await sock.groupInviteCode(from)
                await sock.sendMessage(from, {
                    text: fmt.box('INVITE LINK', [
                        `🔗 *Group link:*`,
                        `https://chat.whatsapp.com/${code}`,
                        ``,
                        `⚠️ _Share responsibly_`,
                    ])
                }, { quoted: msg })
            } catch {
                await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Could not get invite link. Bot must be admin.`]) }, { quoted: msg })
            }
            break
        }

        // ── TOTAL MEMBERS ─────────────────────────────────────────────────────
        case 'totalmembers': case 'members': case 'count': {
            const meta5  = await getCachedGroupMeta(sock, from)
            const total  = meta5.participants.length
            const admins5 = meta5.participants.filter(p => p.admin).length
            await sock.sendMessage(from, {
                text: fmt.box('GROUP MEMBERS', [
                    `👥 *Total:* ${total} members`,
                    `👑 *Admins:* ${admins5}`,
                    `👤 *Regular:* ${total - admins5}`,
                    `📌 *Group:* ${meta5.subject}`,
                ])
            }, { quoted: msg })
            break
        }

        // ── POLL ──────────────────────────────────────────────────────────────
        case 'poll': {
            const parts = q.split('|').map(p => p.trim()).filter(Boolean)
            if (parts.length < 3) {
                return sock.sendMessage(from, {
                    text: fmt.usage('poll', 'Question | Option1 | Option2 | ...\nExample: .poll Favorite color? | Red | Blue | Green')
                }, { quoted: msg })
            }
            const [question, ...options] = parts
            try {
                await sock.sendMessage(from, {
                    poll: { name: question, values: options, selectableCount: 1 }
                }, { quoted: msg })
            } catch {
                // Fallback: text poll
                await sock.sendMessage(from, {
                    text: fmt.box('POLL', [
                        `❓ *${question}*`,
                        ``,
                        ...options.map((o, i) => `${['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣'][i] || `${i+1}.`} ${o}`)
                    ])
                }, { quoted: msg })
            }
            break
        }

        // ── GROUP STATUS (native WhatsApp Group Status) ─────────────────────
        // Posts a real Group Status — the story-style update visible only to
        // this group's members — using the `groupStatus: true` message flag
        // provided by @neoxr/baileys. (The official Baileys ignores this flag
        // and would just send a normal message; that's why the project now
        // runs on @neoxr/baileys.) .tostatus is unchanged: it still posts to
        // your own personal Status.
        case 'gstatus': {
            const ctxInfo   = msg.message?.extendedTextMessage?.contextInfo
            const quotedMsg = ctxInfo?.quotedMessage
            const rawArg    = q || ''

            // Named palette for quick use, plus raw #RRGGBB hex always works
            // too — both are handed to the fork's own assertColor(), which
            // accepts either form.
            const GSTATUS_COLORS = {
                red: '#FF1744', orange: '#FF9100', yellow: '#FFC400', green: '#00C853',
                teal: '#128C7E', blue: '#2979FF', purple: '#AA00FF', pink: '#FF4081',
                black: '#000000', white: '#FFFFFF', gray: '#607D8B', grey: '#607D8B',
            }
            let bgColor = null
            let textArg = rawArg
            const firstWord = rawArg.split(/\s+/)[0] || ''
            const firstWordLc = firstWord.toLowerCase()
            if (GSTATUS_COLORS[firstWordLc]) {
                bgColor = GSTATUS_COLORS[firstWordLc]
                textArg = rawArg.slice(firstWord.length).trim()
            } else if (/^#?[0-9A-Fa-f]{6}$/.test(firstWord)) {
                bgColor = firstWord.startsWith('#') ? firstWord : `#${firstWord}`
                textArg = rawArg.slice(firstWord.length).trim()
            }

            if (!quotedMsg && !textArg) {
                const colorList = Object.keys(GSTATUS_COLORS).filter(c => c !== 'grey').join(', ')
                return sock.sendMessage(from, {
                    text: fmt.usage('gstatus', '[color] <text>', `Colors: ${colorList}, or any #RRGGBB hex\nOr reply to an image/video/audio/sticker with ${config.prefix}gstatus [caption]`)
                }, { quoted: msg })
            }

            try {
                await fmt.react(sock, msg, '⏳')

                let type = null
                if (quotedMsg?.imageMessage) type = 'image'
                else if (quotedMsg?.videoMessage) type = 'video'
                else if (quotedMsg?.audioMessage) type = 'audio'
                else if (quotedMsg?.stickerMessage) type = 'sticker'

                if (type) {
                    const { downloadMediaMessage } = require('@neoxr/baileys')
                    const silentLogger = { level: 'silent', child: () => silentLogger, info: () => {}, debug: () => {}, error: () => {}, warn: () => {}, trace: () => {} }
                    const buf = await downloadMediaMessage(
                        { message: quotedMsg, key: { ...msg.key, id: ctxInfo.stanzaId, participant: ctxInfo.participant } },
                        'buffer', {},
                        { logger: silentLogger, reuploadRequest: sock.updateMediaMessage }
                    )
                    const content = type === 'audio'
                        ? { audio: buf, mimetype: quotedMsg.audioMessage?.mimetype || 'audio/ogg; codecs=opus', ptt: true }
                        : type === 'sticker'
                            ? { sticker: buf }
                            : { [type]: buf, caption: textArg || quotedMsg[type + 'Message']?.caption || '' }
                    await sock.sendGroupStatusV2(from, content, bgColor ? { backgroundColor: bgColor } : {})
                } else {
                    // Replying to a plain TEXT message with no caption used to send an
                    // EMPTY status (rendered as a pure black card). Fall back to the
                    // quoted message's own text instead.
                    const quotedText = quotedMsg?.conversation || quotedMsg?.extendedTextMessage?.text || ''
                    const finalText = textArg || quotedText
                    if (!finalText) {
                        await fmt.react(sock, msg, '❌')
                        return sock.sendMessage(from, {
                            text: fmt.box('ERROR', [`❌ Nothing to post — that message has no text, and you didn't type a caption.`])
                        }, { quoted: msg })
                    }
                    await sock.sendGroupStatusV2(from, { text: finalText }, bgColor ? { backgroundColor: bgColor, font: 0 } : {})
                }

                await fmt.react(sock, msg, '✅')
            } catch (e) {
                await sock.sendMessage(from, { text: fmt.box('ERROR', [`❌ Couldn't post the group status: ${e.message}`]) }, { quoted: msg })
            }
            break
        }

        // NOTE: 'antiforeign', 'antidemote', 'antitag', 'antitagadmin', and
        // 'antilinkgc' below are settings-only — the toggle persists but no
        // detection logic in antiSpam.js checks them yet, so turning them
        // on doesn't actually do anything. Flagging honestly rather than
        // leaving them silently inert. ('antibot' used to be duplicated
        // here too — removed; the real implementation is the case above.)
        case 'antiforeign': case 'antidemote': case 'antitag':
        case 'antitagadmin': case 'antilinkgc': {
            // These are placeholder protections — toggle the setting
            const settingKey = cmd  // e.g. 'antiforeign', 'antidemote'
            const s = getSettings(from)
            const val = args[0]?.toLowerCase() === 'on' ? true
                       : args[0]?.toLowerCase() === 'off' ? false
                       : !s[settingKey]
            setSetting(from, settingKey, val)
            const label = settingKey.replace('anti', 'Anti-').toUpperCase()
            await sock.sendMessage(from, {
                text: fmt.box(label, [
                    `${val ? '🟢' : '🔴'} *${label}* is now *${val ? 'ENABLED' : 'DISABLED'}*`,
                    `⚠️ _Not yet enforced — setting saved but no detection logic runs on it yet_`,
                ])
            })
            break
        }

        default:
            await sock.sendMessage(from, {
                text: fmt.box('UNKNOWN COMMAND', [
                    `❓ *${config.prefix}${cmd}* is not a recognized group command`,
                    ``,
                    `Type *${config.prefix}menu* to see all available commands`,
                ])
            }, { quoted: msg })
    }
}

async function handleGroupEvents(sock, groupId, participants, action) {
    const settings = getSettings(groupId)
    let meta
    try { meta = await getCachedGroupMeta(sock, groupId) } catch { return }

    let rejoinedAndRemoved = []
    if (action === 'add') {
        rejoinedAndRemoved = await antiRejoinCheck(sock, groupId, participants, isBanned)
        await antiRaidCheck(sock, groupId, participants.length)
    }

    for (const jid of participants) {
        if (rejoinedAndRemoved.includes(jid)) continue
        if (action === 'remove' && settings.antiremove) {
            // Don't re-add users the bot itself just kicked/banned
            const num = jid.replace(/[^0-9]/g, '')
            if (skipAntiremove.has(num)) continue
            try {
                await sock.groupParticipantsUpdate(groupId, [jid], 'add')
                await sock.sendMessage(groupId, {
                    text: fmt.box('ANTI-REMOVE', [
                        `🛡 @${jid.split('@')[0]} was *re-added*`,
                        `_Anti-remove protection is active_`
                    ]),
                    mentions: [jid]
                })
            } catch {}
            continue
        }

        if (action === 'add' && settings.welcome) {
            await sock.sendMessage(groupId, {
                text: fmt.box('WELCOME', [
                    `👋 Welcome to *${meta.subject}*!`,
                    ``,
                    `🎉 @${jid.split('@')[0]}`,
                    ``,
                    `Type *${config.prefix}menu* to see what I can do`,
                ]),
                mentions: [jid]
            })
        } else if (action === 'remove' && settings.goodbye) {
            await sock.sendMessage(groupId, {
                text: fmt.box('GOODBYE', [
                    `😢 @${jid.split('@')[0]} has left *${meta.subject}*`,
                    `_Farewell! You will be missed 👋_`,
                ]),
                mentions: [jid]
            })
        }
    }
}

module.exports = { handleGroupCmd, handleGroupEvents, isBanned }
