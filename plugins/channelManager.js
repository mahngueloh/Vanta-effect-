'use strict'

const config = require('../config')
const fmt    = require('../lib/format')
const store  = require('../lib/newsStore')
const { postToFacebook, isFacebookConfigured, isAutoPostEnabled, getFacebookStatus, setCredentials, setPageId, setToken, setAutoPost, getCurrentCredentials, setTokenExpiry, getTokenExpiry, validateToken } = require('../lib/facebook')
const { testTelegram, isTelegramConfigured, getTelegramStatus } = require('../lib/telegram')
const { testWhatsAppChannel, isWhatsAppChannelConfigured, getWhatsAppChannelStatus } = require('../lib/whatsappChannel')

function requireOwner(sock, from, msg, owner) {
    if (!owner) {
        sock.sendMessage(from, { text: fmt.permOwner() }, { quoted: msg })
        return false
    }
    return true
}

// ── Facebook ─────────────────────────────────────────────────────────────────

async function handleFacebookCmd(sock, from, args, msg, owner) {
    if (!requireOwner(sock, from, msg, owner)) return
    const sub = (args[0] || '').toLowerCase()
    const prefix = config.prefix

    switch (sub) {
        case 'on': {
            if (!isFacebookConfigured()) {
                return sock.sendMessage(from, {
                    text: fmt.box('FACEBOOK', [
                        '❌ Cannot enable — Facebook credentials are not set yet',
                        `${getCurrentCredentials().pageId ? '✅' : '❌'} Page ID  →  ${prefix}fbpageid <id>`,
                        `${getCurrentCredentials().token ? '✅' : '❌'} Access token  →  ${prefix}fbaccesstoken <token>`,
                    ])
                }, { quoted: msg })
            }
            setAutoPost(true)
            store.setChannelEnabled('facebook', true)
            store.addLog('info', 'Facebook publishing turned ON by owner')
            try { require('./newsMonitor').clearOwnerAlert('facebook-auth') } catch {}
            return sock.sendMessage(from, { text: fmt.toggle('Facebook Publishing', true) }, { quoted: msg })
        }

        case 'off': {
            store.setChannelEnabled('facebook', false)
            store.addLog('info', 'Facebook publishing turned OFF by owner')
            return sock.sendMessage(from, { text: fmt.toggle('Facebook Publishing', false) }, { quoted: msg })
        }

        case 'test': {
            await fmt.react(sock, msg, '⏳')
            if (!isFacebookConfigured() || !isAutoPostEnabled()) {
                await fmt.react(sock, msg, '❌')
                return sock.sendMessage(from, {
                    text: fmt.box('FACEBOOK TEST', [
                        !isFacebookConfigured()
                            ? `❌ Not configured — set ${prefix}fbpageid and ${prefix}fbaccesstoken first`
                            : `❌ Publishing is OFF — run ${prefix}fb on first`,
                    ])
                }, { quoted: msg })
            }
            const result = await postToFacebook(`✅ Test post from *${config.botName}* News Monitor — Facebook is connected correctly.`)
            await fmt.react(sock, msg, result.success ? '✅' : '❌')
            store.addLog(result.success ? 'success' : 'error', `Facebook test post ${result.success ? 'succeeded' : `failed: ${result.error}`}`)
            return sock.sendMessage(from, {
                text: fmt.box('FACEBOOK TEST', [
                    result.success ? `✅ Test post published (id: ${result.id || 'unknown'})` : `❌ Failed: ${result.error}`,
                ])
            }, { quoted: msg })
        }

        case 'status':
        default: {
            const s = getFacebookStatus()
            const toggle = store.isChannelEnabled('facebook')
            const expiryLine = s.tokenExpiresAt
                ? (s.tokenExpiresAt > Date.now()
                    ? `⏳ Token expires: ${new Date(s.tokenExpiresAt).toLocaleString()} (in ${Math.max(0, Math.round((s.tokenExpiresAt - Date.now()) / 60000))} min) — get a non-expiring one via Extend Access Token`
                    : `⚠️ Token has EXPIRED — reconnect with ${prefix}fbaccesstoken`)
                : (s.configured ? `✅ Token does not expire (or not checked yet — run ${prefix}fb test)` : null)
            return sock.sendMessage(from, {
                text: fmt.box('FACEBOOK STATUS', [
                    `${s.configured && s.autoPost && toggle ? '✅ ON — auto-posting' : '⏸️ OFF'}`,
                    `📄 Page ID: ${s.pageId}`,
                    `🔑 Access token: ${s.configured ? 'set ✅' : 'missing ❌'}`,
                    expiryLine,
                    `📰 Auto-post: ${s.autoPost ? 'enabled' : 'disabled'}`,
                    `🎛️ Owner toggle: ${toggle ? 'ON' : 'OFF'} (${prefix}fb on|off)`,
                    '',
                    `_Set up: ${prefix}fbpageid <id> then ${prefix}fbaccesstoken <token>_`,
                    `_Usage: ${prefix}fb <on|off|test|status>_`,
                ].filter(Boolean))
            }, { quoted: msg })
        }
    }
}

// ── WhatsApp Channel ─────────────────────────────────────────────────────────

async function handleWhatsAppCmd(sock, from, args, msg, owner) {
    if (!requireOwner(sock, from, msg, owner)) return
    const sub = (args[0] || '').toLowerCase()
    const envReady = isWhatsAppChannelConfigured()

    switch (sub) {
        case 'on': {
            if (!envReady) {
                return sock.sendMessage(from, {
                    text: fmt.box('WHATSAPP CHANNEL', [
                        '❌ Cannot enable — WHATSAPP_CHANNEL_JID is not set in *.env*',
                        '_Set it (e.g. 123456789@newsletter) and restart the bot._',
                    ])
                }, { quoted: msg })
            }
            store.setChannelEnabled('whatsapp', true)
            store.addLog('info', 'WhatsApp Channel publishing turned ON by owner')
            return sock.sendMessage(from, { text: fmt.toggle('WhatsApp Channel Publishing', true) }, { quoted: msg })
        }

        case 'off': {
            store.setChannelEnabled('whatsapp', false)
            store.addLog('info', 'WhatsApp Channel publishing turned OFF by owner')
            return sock.sendMessage(from, { text: fmt.toggle('WhatsApp Channel Publishing', false) }, { quoted: msg })
        }

        case 'test': {
            await fmt.react(sock, msg, '⏳')
            const result = await testWhatsAppChannel(sock)
            await fmt.react(sock, msg, result.success ? '✅' : '❌')
            store.addLog(result.success ? 'success' : 'error', `WhatsApp Channel test ${result.success ? 'succeeded' : `failed: ${result.error}`}`)
            return sock.sendMessage(from, {
                text: fmt.box('WHATSAPP CHANNEL TEST', [
                    result.success ? '✅ Test message sent to the channel' : `❌ Failed: ${result.error}`,
                ])
            }, { quoted: msg })
        }

        case 'status':
        default: {
            const s = getWhatsAppChannelStatus()
            const toggle = store.isChannelEnabled('whatsapp')
            return sock.sendMessage(from, {
                text: fmt.box('WHATSAPP CHANNEL STATUS', [
                    `${s.configured && toggle ? '✅ ON — auto-posting' : '⏸️ OFF'}`,
                    `🆔 Channel JID: ${s.jid}`,
                    `🎛️ Owner toggle: ${toggle ? 'ON' : 'OFF'} (${config.prefix}wa on|off)`,
                    '',
                    `_Usage: ${config.prefix}wa <on|off|test>_`,
                ])
            }, { quoted: msg })
        }
    }
}

// ── Telegram ─────────────────────────────────────────────────────────────────

async function handleTelegramCmd(sock, from, args, msg, owner) {
    if (!requireOwner(sock, from, msg, owner)) return
    const sub = (args[0] || '').toLowerCase()
    const envReady = isTelegramConfigured()

    switch (sub) {
        case 'on': {
            if (!envReady) {
                return sock.sendMessage(from, {
                    text: fmt.box('TELEGRAM', [
                        '❌ Cannot enable — Telegram is not fully configured in *.env*',
                        `${config.news.telegramEnabled ? '✅' : '❌'} TELEGRAM_ENABLED=true`,
                        `${config.news.telegramBotToken ? '✅' : '❌'} TELEGRAM_BOT_TOKEN set`,
                        `${config.news.telegramChannelId ? '✅' : '❌'} TELEGRAM_CHANNEL_ID set`,
                        '',
                        '_Set these in your .env file and restart the bot first._',
                    ])
                }, { quoted: msg })
            }
            store.setChannelEnabled('telegram', true)
            store.addLog('info', 'Telegram publishing turned ON by owner')
            return sock.sendMessage(from, { text: fmt.toggle('Telegram Publishing', true) }, { quoted: msg })
        }

        case 'off': {
            store.setChannelEnabled('telegram', false)
            store.addLog('info', 'Telegram publishing turned OFF by owner')
            return sock.sendMessage(from, { text: fmt.toggle('Telegram Publishing', false) }, { quoted: msg })
        }

        case 'test': {
            await fmt.react(sock, msg, '⏳')
            const result = await testTelegram()
            await fmt.react(sock, msg, result.success ? '✅' : '❌')
            store.addLog(result.success ? 'success' : 'error', `Telegram test ${result.success ? 'succeeded' : `failed: ${result.error}`}`)
            return sock.sendMessage(from, {
                text: fmt.box('TELEGRAM TEST', [
                    result.success ? '✅ Test message sent to the channel' : `❌ Failed: ${result.error}`,
                ])
            }, { quoted: msg })
        }

        case 'status':
        default: {
            const s = getTelegramStatus()
            const toggle = store.isChannelEnabled('telegram')
            return sock.sendMessage(from, {
                text: fmt.box('TELEGRAM STATUS', [
                    `${s.configured && toggle ? '✅ ON — auto-posting' : '⏸️ OFF'}`,
                    `🆔 Chat ID: ${s.chatId}`,
                    `🔑 Bot token: ${s.tokenSet ? 'set ✅' : 'missing ❌'}`,
                    `🌐 .env TELEGRAM_ENABLED: ${s.masterEnabled ? 'true' : 'false'}`,
                    `🎛️ Owner toggle: ${toggle ? 'ON' : 'OFF'} (${config.prefix}tg on|off)`,
                    '',
                    `_Usage: ${config.prefix}tg <on|off|test>_`,
                ])
            }, { quoted: msg })
        }
    }
}

// ── .setfb — validate + hot-swap Facebook credentials ─────────────────────
//
//  Usage:  .setfb <pageId> <accessToken>
//
//  • Calls Graph API to validate token AND page access before saving anything
//  • If valid, credentials are hot-loaded immediately — NO restart required
//  • Credentials are persisted to settings.json so they survive bot restarts

async function handleSetFacebook(sock, from, args, msg, owner) {
    if (!requireOwner(sock, from, msg, owner)) return

    const prefix = config.prefix

    // Show usage if called with no args
    if (!args[0]) {
        return sock.sendMessage(from, {
            text: fmt.box('🔑 SETFB — Facebook Credentials', [
                `*Usage:* ${prefix}setfb <pageId> <accessToken>`,
                ``,
                `*How to get your Page Access Token:*`,
                `1. Go to → https://developers.facebook.com/tools/explorer`,
                `2. Select your app → select your page → generate token`,
                `3. Grant permissions: pages_manage_posts, pages_read_engagement`,
                `4. Copy the Page Access Token (not the User token)`,
                ``,
                `*Example:*`,
                `${prefix}setfb 123456789012345 EAABwzLix...`,
                ``,
                `_Token is validated live against Facebook before saving._`,
                `_No restart needed — it works immediately after setting._`,
            ])
        }, { quoted: msg })
    }

    const pageId = args[0].trim()
    const token  = args[1] ? args[1].trim() : ''

    if (!token) {
        return sock.sendMessage(from, {
            text: fmt.box('❌ SETFB ERROR', [
                'You must provide both *Page ID* and *Access Token*.',
                ``,
                `*Usage:* ${prefix}setfb <pageId> <accessToken>`,
                `*Example:* ${prefix}setfb 123456789012345 EAABwzLix...`,
            ])
        }, { quoted: msg })
    }

    // Basic sanity checks before hitting the API
    if (!/^\d{10,20}$/.test(pageId)) {
        return sock.sendMessage(from, {
            text: fmt.box('❌ INVALID PAGE ID', [
                `Page ID must be a numeric ID (10–20 digits).`,
                `You entered: *${pageId}*`,
                ``,
                `Find your Page ID at: https://www.facebook.com/<your-page>/about`,
            ])
        }, { quoted: msg })
    }

    if (token.length < 50) {
        return sock.sendMessage(from, {
            text: fmt.box('❌ TOKEN TOO SHORT', [
                `Facebook access tokens are usually 100–300 characters.`,
                `The token you pasted looks too short (${token.length} chars).`,
                `Double-check you copied the full token.`,
            ])
        }, { quoted: msg })
    }

    // Validate against Graph API
    await fmt.react(sock, msg, '⏳')
    await sock.sendMessage(from, {
        text: fmt.box('🔍 VALIDATING...', [
            `Checking token and page access with Facebook...`,
            `_This takes a few seconds._`,
        ])
    }, { quoted: msg })

    const result = await validateToken(pageId, token)

    if (!result.ok) {
        await fmt.react(sock, msg, '❌')
        return sock.sendMessage(from, {
            text: fmt.box('❌ VALIDATION FAILED', [
                `Facebook rejected the credentials.`,
                ``,
                `*Reason:* ${result.error}`,
                result.code ? `*Code:* ${result.code}` : null,
                ``,
                `*Common fixes:*`,
                `◈ Make sure you copied the *Page* Access Token (not User token)`,
                `◈ Go to Graph Explorer → regenerate with pages_manage_posts`,
                `◈ The Page ID must match the page the token belongs to`,
            ].filter(Boolean))
        }, { quoted: msg })
    }

    // ✅ Valid — hot-swap and enable
    setCredentials(pageId, token, true)
    store.setChannelEnabled('facebook', true)
    store.addLog('info', `Facebook credentials updated via .setfb — page: ${result.pageName}`)

    await fmt.react(sock, msg, '✅')
    return sock.sendMessage(from, {
        text: fmt.box('✅ FACEBOOK CONNECTED', [
            `Credentials validated and loaded successfully!`,
            ``,
            `📄 *Page:* ${result.pageName}`,
            `👤 *Token owner:* ${result.meName}`,
            `❤️  *Page fans:* ${result.fans}`,
            ``,
            `✅ Auto-posting is now *ON*`,
            ``,
            `*Test it:* ${prefix}fb test`,
            `*Turn off:* ${prefix}fb off`,
            `*Check status:* ${prefix}fb status`,
            ``,
            `_Credentials saved — they will survive a bot restart._`,
        ])
    }, { quoted: msg })
}

// ── .fbpageid / .fbaccesstoken — set the two credentials one at a time ───────
//  Usage:  .fbpageid <pageId>
//          .fbaccesstoken <token>
//  Send them in either order. As soon as BOTH are present they are checked
//  live against Facebook; if valid, publishing turns ON automatically.
//  Both persist to settings.json and load instantly — no restart needed.
//  The token is a secret: it is never echoed back, the message you pasted it
//  in is deleted, and it can't be set from inside a group chat.

async function connectIfReady(sock, from, msg, justSet) {
    const prefix = config.prefix
    const { pageId, token } = getCurrentCredentials()

    if (justSet === 'pageid' && !token) {
        return sock.sendMessage(from, {
            text: fmt.box('FACEBOOK', [
                '✅ Page ID saved',
                `Next: send *${prefix}fbaccesstoken <token>*`,
            ])
        }, { quoted: msg })
    }
    if (justSet === 'token' && !pageId) {
        return sock.sendMessage(from, {
            text: fmt.box('FACEBOOK', [
                `✅ Access token saved (${token.slice(0, 4)}…, ${token.length} chars)`,
                `Next: send *${prefix}fbpageid <id>*`,
            ])
        })
    }

    await fmt.react(sock, msg, '⏳')
    const result = await validateToken(pageId, token)

    if (!result.ok) {
        setAutoPost(false)
        store.setChannelEnabled('facebook', false)
        await fmt.react(sock, msg, '❌')
        return sock.sendMessage(from, {
            text: fmt.box('❌ FACEBOOK CHECK FAILED', [
                `Facebook rejected the Page ID / token pair.`,
                `*Reason:* ${result.error}`,
                result.code ? `*Code:* ${result.code}` : null,
                '',
                `Both are saved, but publishing stays OFF until they check out.`,
                `Fix whichever is wrong: *${prefix}fbpageid <id>* or *${prefix}fbaccesstoken <token>*`,
                `_It must be the Page access token (not a User token), with pages_manage_posts._`,
            ].filter(Boolean))
        }, justSet === 'token' ? undefined : { quoted: msg })
    }

    setAutoPost(true)
    setTokenExpiry(result.expiresAt || null)
    store.setChannelEnabled('facebook', true)
    store.addLog('info', `Facebook connected via ${prefix}fbpageid/${prefix}fbaccesstoken — page: ${result.pageName}`)
    try { require('./newsMonitor').clearOwnerAlert('facebook-auth') } catch {}   // credentials fixed — a future real disconnect should alert again
    try { require('./newsMonitor').clearOwnerAlert('facebook-expiring') } catch {}
    await fmt.react(sock, msg, '✅')

    // This is the actual fix for "posts fine for an hour then goes silent":
    // a token copied straight from the Graph API Explorer, without first
    // extending it, expires in about an hour — it works, then dies with zero
    // warning. Telling the owner clearly, right now, beats them finding out
    // via silence later.
    const expiryLines = result.shortLived
        ? [
            `⚠️ *This token is SHORT-LIVED* — expires ${new Date(result.expiresAt).toLocaleString()} (in about ${Math.max(1, Math.round((result.expiresAt - Date.now()) / 60000))} min).`,
            `It'll post fine until then, then silently stop — I'll warn you again as it gets close.`,
            `*To get one that never expires:* Graph API Explorer → your token → *"Extend Access Token"* → then re-copy the *Page* token → ${prefix}fbaccesstoken again.`,
          ]
        : [`✅ This token does not expire — no need to redo this.`]

    return sock.sendMessage(from, {
        text: fmt.box('✅ FACEBOOK CONNECTED', [
            `📄 *Page:* ${result.pageName}`,
            `❤️  *Page fans:* ${result.fans}`,
            '',
            ...expiryLines,
            '',
            `✅ Publishing is now *ON* — news will be posted to this page`,
            `*Test it:* ${prefix}fb test`,
            `*Turn off:* ${prefix}fb off`,
        ])
    }, justSet === 'token' ? undefined : { quoted: msg })
}

async function handleFbPageId(sock, from, args, msg, owner) {
    if (!requireOwner(sock, from, msg, owner)) return
    const prefix = config.prefix
    const pageId = (args[0] || '').trim()

    if (!pageId) {
        return sock.sendMessage(from, {
            text: fmt.box('FB PAGE ID', [
                `*Usage:* ${prefix}fbpageid <pageId>`,
                `*Example:* ${prefix}fbpageid 123456789012345`,
                '',
                `_Find it on your Page → About → Page transparency → Page ID._`,
            ])
        }, { quoted: msg })
    }
    if (!/^\d{10,20}$/.test(pageId)) {
        return sock.sendMessage(from, {
            text: fmt.box('❌ INVALID PAGE ID', [
                `A Page ID is a number, 10–20 digits.`,
                `You entered: *${pageId}*`,
            ])
        }, { quoted: msg })
    }

    setPageId(pageId)
    return connectIfReady(sock, from, msg, 'pageid')
}

async function handleFbAccessToken(sock, from, args, msg, owner) {
    if (!requireOwner(sock, from, msg, owner)) return
    const prefix = config.prefix
    const token  = args.join('').trim()   // tokens never contain spaces — tolerate pasted line breaks

    // Whatever was pasted is a secret: remove the message right away, wherever it was sent.
    const scrub = async () => { try { await sock.sendMessage(from, { delete: msg.key }) } catch {} }

    if (String(from).endsWith('@g.us')) {
        await scrub()
        return sock.sendMessage(from, {
            text: fmt.box('🔒 NOT IN A GROUP', [
                `Never paste an access token in a group — everyone there could read it.`,
                `I deleted that message. Send *${prefix}fbaccesstoken <token>* in your own chat instead.`,
                `_If anyone might have seen it, regenerate the token on Facebook._`,
            ])
        })
    }

    if (!token) {
        return sock.sendMessage(from, {
            text: fmt.box('FB ACCESS TOKEN', [
                `*Usage:* ${prefix}fbaccesstoken <token>`,
                '',
                `*Get a Page Access Token:*`,
                `1. developers.facebook.com/tools/explorer`,
                `2. Pick your app, then your Page`,
                `3. Grant pages_manage_posts + pages_read_engagement`,
                `4. Copy the *Page* token (not the User token)`,
                '',
                `_Your message is deleted after saving, and the token is never shown back._`,
            ])
        }, { quoted: msg })
    }

    await scrub()

    if (token.length < 50) {
        return sock.sendMessage(from, {
            text: fmt.box('❌ TOKEN TOO SHORT', [
                `Facebook tokens are usually 100–300 characters — that was ${token.length}.`,
                `Copy the full token and send it again.`,
            ])
        })
    }

    setToken(token)
    return connectIfReady(sock, from, msg, 'token')
}

module.exports = {
    handleFacebookCmd,
    handleWhatsAppCmd,
    handleTelegramCmd,
    handleSetFacebook,
    handleFbPageId,
    handleFbAccessToken,
}
