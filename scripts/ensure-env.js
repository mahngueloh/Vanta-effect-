'use strict'

// Creates a blank, editable .env if one doesn't exist yet — WITHOUT needing
// the bot process itself to run first. This is called from two places:
//   1. package.json's "postinstall" — runs automatically the moment `npm
//      install` finishes (i.e. right after a fresh upload/deploy, BEFORE
//      you ever press Start), so .env is sitting there in the Files tab
//      ready to edit immediately.
//   2. index.js at startup — kept as a safety net for the rare case
//      dependencies were already installed and postinstall never ran (e.g.
//      node_modules was uploaded directly instead of npm installing).
// Either way this is idempotent — if .env already exists, it does nothing,
// so running it twice (once at install, once at startup) never overwrites
// anything you've already filled in.
const fs = require('fs')
const path = require('path')

function ensureEnvFile(rootDir) {
    const envPath = path.join(rootDir, '.env')
    if (fs.existsSync(envPath)) return false

    fs.writeFileSync(envPath, [
        '# Fill in ONE of these two, then press Start (no need to start-then-stop first).',
        '# SESSION_ID: paste one from https://mahngueloh-md-session.onrender.com/',
        'SESSION_ID=',
        '',
        '# PHONE_NUMBER: your WhatsApp number, digits only, with country code, no +',
        '# e.g. 254712345678',
        'PHONE_NUMBER=',
        '',
    ].join('\n'))
    console.log('[ ENV ] Created a blank .env in the Files tab — fill in SESSION_ID or PHONE_NUMBER, then press Start')
    return true
}

module.exports = { ensureEnvFile }

// Allow `node scripts/ensure-env.js` directly (used by postinstall).
if (require.main === module) {
    ensureEnvFile(path.join(__dirname, '..'))
}
