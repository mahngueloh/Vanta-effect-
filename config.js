'use strict'

const AI_KEYS = {
    openai: process.env.OPENAI_API_KEY || '',
    gemini: process.env.GEMINI_API_KEY || '',
    savage: process.env.SAVAGE_API_KEY || '',
    anthropic: process.env.ANTHROPIC_API_KEY || '',
    deepseek: process.env.DEEPSEEK_API_KEY || '',
    removeBgApiKey: process.env.REMOVEBG_API_KEY || '', // free tier: https://www.remove.bg/api
}

const AI_MODELS = {
    openaiVision: process.env.OPENAI_VISION_MODEL || 'gpt-4o-mini',
    geminiVision: process.env.GEMINI_VISION_MODEL || 'gemini-3.5-flash',
    anthropic: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
}

module.exports = {
    botName:     process.env.BOT_NAME     || 'MAHNGUELOH VANTA',
    ownerName:   process.env.OWNER_NAME   || 'MAHNGUELOH',
    // No hardcoded fallback — a bot deployed for someone else must never
    // silently default to your own number. Leave OWNER_NUMBER unset and use
    // the interactive console login menu (Session ID or Phone Number) on
    // first boot instead.
    // Public contact number — shown on .owner/.contact and the menu's Owner
    // button. NEVER used to auto-request a pairing code (see phoneNumber
    // below for that) — this is purely a "how to reach the owner" display value.
    ownerNumber: process.env.OWNER_NUMBER || '',  // digits + country code, no + (override via OWNER_NUMBER in .env) — intentionally no hardcoded fallback
    // The bot SESSION's own login number — completely separate from
    // ownerNumber above. Only set via PHONE_NUMBER in .env, deliberately with
    // no fallback to any other field, so nothing can silently turn into a
    // pairing target without you explicitly setting this one yourself.
    phoneNumber: process.env.PHONE_NUMBER || '',
    // Optional — shown on the .contact card when set. Either a bare
    // @handle or a full https://t.me/... link both work.
    ownerTelegram: process.env.OWNER_TELEGRAM || '',
    // Paste your MAHNGUELOH~... Session ID here for deployments without .env.
    // Leave blank on a fresh install to use the interactive pairing/login flow.
    sessionId: process.env.SESSION_ID || '',
    // .repair edits the bot's own source code — powerful and risky enough that
    // it should only ever run for you specifically, not every customer who's
    // "owner" of their own deployed instance. Hardcoded, not tied to ownerNumber.
    repairAdminNumber: process.env.REPAIR_ADMIN_NUMBER || '',
    prefix:      '.',
    mode: process.env.MODE || 'public',
    aiEnabled:    process.env.AI_ENABLED !== 'false',   // master switch for the explicit AI commands (.ai, .ask, .gpt ...)
    funResponses: process.env.FUN_RESPONSES !== 'false',
    menuTagline: process.env.MENU_TAGLINE || 'We are Anonymous. We are Legion…',
    themeLine: process.env.THEME_LINE || 'We are Anonymous. We are Legion…',

    // ─────────────────────────────────────────────────────────────────────
    // CENTRAL AI CONFIGURATION
    // Put provider credentials HERE. Environment variables override these
    // values when supplied, so the same config works on local machines and
    // hosted panels. Every AI feature reads these shared values through
    // lib/aiProviders.js — no command needs its own key.
    // ─────────────────────────────────────────────────────────────────────
    aiKeys: AI_KEYS,
    aiModels: AI_MODELS,

    // Backward-compatible aliases: existing plugins can keep using
    // config.openaiApiKey/config.geminiApiKey/etc. without duplicating keys.
    openaiApiKey: AI_KEYS.openai,
    openaiVisionModel: AI_MODELS.openaiVision,
    geminiApiKey: AI_KEYS.gemini,
    geminiVisionModel: AI_MODELS.geminiVision,
    anthropicApiKey: AI_KEYS.anthropic,
    anthropicModel: AI_MODELS.anthropic,
    deepseekApiKey: AI_KEYS.deepseek,
    savageApiKey: AI_KEYS.savage,

    aiProviderOrder: (process.env.AI_PROVIDER_ORDER || 'claude,openai,gemini,deepseek')
        .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    // Savage APIs — hosted YouTube extraction service (KeepVid-style), tried
    // as a fast path before yt-dlp/ruhend-scraper for video/audio downloads.
    // Also used as a no-official-key-needed fallback for Claude/DeepSeek chat
    // (text only — it has no vision support). IMPORTANT: this is a third-party
    // relay, not Anthropic or DeepSeek directly — see the note in
    // lib/aiProviders.js. Set ANTHROPIC_API_KEY / DEEPSEEK_API_KEY above for
    // guaranteed-genuine, vision-capable access instead.
    savageApiBase: process.env.SAVAGE_API_BASE || 'https://savage-api-production.up.railway.app',
    // Standalone session-pairing site (ZACHARIAH project) — used by `.pair`
    // to request a pairing code / session ID for a phone number via chat.
    pairingSiteUrl: process.env.PAIRING_SITE_URL || 'https://mahngueloh-md-session.onrender.com',
    // GitHub repo shown by `.repo`/`.source` — "owner/repo" only, no URL.
    githubRepo: process.env.GITHUB_REPO || 'mahngueloh/Vanta-effect-',
    // WhatsApp Channel link — shown as a button on `.repo`/`.source`.
    whatsappChannelUrl: process.env.WHATSAPP_CHANNEL_URL || 'https://whatsapp.com/channel/0029Vb7B7pS6rsQksHVznm0j',
    // `.repo` button format. false (default) = templateButtons, which can
    // open links directly but is currently unreliable across the Baileys
    // ecosystem. true = older `buttons` format — every button becomes a
    // quick-reply that sends the link as text instead of opening it, but
    // this message type has historically rendered more consistently. Flip
    // this if templateButtons never shows up for you.
    repoButtonsLegacy: process.env.REPO_BUTTONS_LEGACY === 'true',
    maxDownloadSize: parseInt(process.env.MAX_DOWNLOAD_MB || '80'),   // MB
    commandCooldownMs: parseInt(process.env.COOLDOWN_MS  || '3000'),  // per user
    sudoNumbers: (process.env.SUDO_NUMBERS || '').split(',').map(n => n.trim()).filter(Boolean),
    timezone: process.env.TIMEZONE || 'Africa/Nairobi',
    facebook: {
        pageId:          process.env.FACEBOOK_PAGE_ID || '',
        pageAccessToken: process.env.FACEBOOK_PAGE_ACCESS_TOKEN || '',
        autoPost:        process.env.FACEBOOK_AUTO_POST === 'true',
        apiVersion:      process.env.FACEBOOK_API_VERSION || 'v19.0',
    },
    news: {
        // NOTE: on/off is controlled at runtime via `.news on` / `.news off`
        // (persisted in data/news-state.json), not this env var. This env var
        // only sets the *initial* default the very first time the bot runs.
        defaultEnabled: process.env.NEWS_MONITOR_ENABLED === 'true',
        checkIntervalMs: parseInt(process.env.NEWS_CHECK_INTERVAL_MS || '45000'),
        whatsappChannelJid: process.env.WHATSAPP_CHANNEL_JID || '',   // e.g. 123456789@newsletter
        // Bot auto-joins this WhatsApp group once on startup (updates/community group).
        // Paste a full invite link like https://chat.whatsapp.com/XXXXXXXXXXXXXXXXXXXXXX
        updatesGroupInviteLink: process.env.UPDATES_GROUP_INVITE_LINK || 'https://chat.whatsapp.com/GyKGFr0Aclb0koqLNzHOLn',
        telegramEnabled: process.env.TELEGRAM_ENABLED === 'true',
        telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
        telegramChannelId: process.env.TELEGRAM_CHANNEL_ID || '',
        // Produces a full branded Facebook news graphic:
        //   BREAKING NEWS badge · logo watermark · dark gradient photo overlay ·
        //   category tag · gold-accented headline · summary footer · slogan
        branding: {
            watermarkEnabled: process.env.NEWS_WATERMARK_ENABLED !== 'false',  // default ON
            // Legacy: headlineBannerEnabled is no longer used in the new design but kept
            // here so existing .env files don't break anything.
            headlineBannerEnabled: process.env.NEWS_HEADLINE_BANNER_ENABLED !== 'false',
            // Your page's social handle shown in the footer (e.g. @mahnguelohnews)
            socialHandle: process.env.NEWS_SOCIAL_HANDLE || '@mahnguelohnews',

            // Slogan shown at the very bottom of every post image
            slogan: process.env.NEWS_SLOGAN || 'FAST. ACCURATE. TRENDING.',

            // Short domain for the footer source row (e.g. "nairobigossipclub.co.ke")
            // — overridden per-source at runtime if the source has a `domain` field.
            sourceUrl: process.env.NEWS_SOURCE_URL || '',

            // Fallback source name shown in footer when no per-source name is available
            sourceName: process.env.NEWS_SOURCE_NAME || '',

            // Default category tag shown when the RSS source has no `category` field.
            // Leave blank to suppress the tag on untagged sources.
            defaultCategory: process.env.NEWS_DEFAULT_CATEGORY || '',
            // The new design uses the brand palette (black/white/gold/red) by
            // default. You can still override specific colours here if needed.
            bannerBg:           process.env.NEWS_BANNER_BG           || '#111111',
            bannerTextColor:    process.env.NEWS_BANNER_TEXT_COLOR    || '#ffffff',
            watermarkBg:        process.env.NEWS_WATERMARK_BG         || '#000000',
            watermarkTextColor: process.env.NEWS_WATERMARK_TEXT_COLOR || '#ffffff',
            watermarkText:      process.env.NEWS_WATERMARK_TEXT       || '',
        },
    },
    version: '3.4.1',
}
