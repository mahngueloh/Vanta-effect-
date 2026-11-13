'use strict'

// key -> { secret: boolean }  (secret values are shown as "set (N chars)", never the value itself)
const CHECKS = {
    'Facebook': {
        FACEBOOK_PAGE_ID:           { secret: false },
        FACEBOOK_PAGE_ACCESS_TOKEN: { secret: true },
        FACEBOOK_AUTO_POST:         { secret: false },
    },
    'Telegram': {
        TELEGRAM_ENABLED:    { secret: false },
        TELEGRAM_BOT_TOKEN:  { secret: true },
        TELEGRAM_CHANNEL_ID: { secret: false },
    },
    'WhatsApp Channel': {
        WHATSAPP_CHANNEL_JID: { secret: false },
    },
    'AI': {
        ANTHROPIC_API_KEY: { secret: true },
        OPENAI_API_KEY:    { secret: true },
        GEMINI_API_KEY:    { secret: true },
        DEEPSEEK_API_KEY:  { secret: true },
        AI_PROVIDER_ORDER: { secret: false },
    },
}

function describe(key, secret) {
    const val = process.env[key]
    if (val === undefined || val === '') return '❌ missing'
    if (secret) return `✅ set (${val.length} chars)`
    return `✅ set → "${val}"`
}

function logEnvDiagnostics() {
    const setCount = (vars) => Object.keys(vars).filter(k => process.env[k] !== undefined && process.env[k] !== '').length

    // Nothing optional configured at all — the common case for someone who
    // only wants core WhatsApp features. Say nothing instead of dumping 15+
    // lines of "missing" for integrations that were never going to be used.
    const anyConfigured = Object.values(CHECKS).some(vars => setCount(vars) > 0)
    if (!anyConfigured) return

    console.log('')
    console.log('─────────────────────────────────────────────')
    console.log(' 🔎 Optional integrations')
    console.log('─────────────────────────────────────────────')

    const partial = []
    for (const [group, vars] of Object.entries(CHECKS)) {
        const total = Object.keys(vars).length
        const set = setCount(vars)
        if (set === 0) continue // not using this one — don't mention it at all
        console.log(` ${group}: ${set}/${total} configured${set < total ? ' ⚠️ incomplete' : ' ✅'}`)
        if (set < total) partial.push(group)
    }

    // Full per-key breakdown only for groups someone actually started
    // configuring but didn't finish — that's the case worth troubleshooting.
    for (const group of partial) {
        console.log(``)
        console.log(` ⚠️  ${group} — missing:`)
        for (const [key, { secret }] of Object.entries(CHECKS[group])) {
            const line = describe(key, secret)
            if (line.startsWith('❌')) console.log(`   ${key.padEnd(28)} ${line}`)
        }
    }
    if (partial.length) {
        console.log('')
        console.log(' If you DID set these in .env, check:')
        console.log('   1. The .env file is in the same folder as index.js')
        console.log('   2. There are no quotes/spaces around the values')
        console.log('   3. You restarted the process after editing .env')
    }
    console.log('')
}

module.exports = { logEnvDiagnostics }
