'use strict'
// Interactive-buttons support, Spencer/savage-tech style.
//
// The button message builders come from the `spencer-btns` package (paired
// with a Baileys-family socket fork that still relays button payloads).
// Loading is defensive: the package is an ESM module imported dynamically
// from our CommonJS code, and ANY failure falls back to a plain-text
// rendering so a missing/broken package can never crash the bot — commands
// just degrade gracefully.

let _mod = null
let _loadError = null

async function loadBtns() {
    if (_mod || _loadError) return _mod
    try {
        _mod = await import('spencer-btns')
    } catch (e) {
        _loadError = e
        console.log('[buttons] spencer-btns unavailable:', e.message)
    }
    return _mod
}

// Fire-and-forget warm-up at boot so the first .buttons isn't slow.
loadBtns()

function btnsReady() { return !!_mod && typeof _mod.sendButtons === 'function' && !!_mod.btn }

// ── Reply-button actions ────────────────────────────────────────────────────
// Reply buttons arrive back as plain-text messages carrying their id, so we
// keep a small registry: id -> async (sock, from, sender, msg). The handler
// checks incoming text against this before normal command parsing.
const buttonActions = new Map()

function registerButtonAction(id, fn) { buttonActions.set(id, fn) }
function getButtonAction(id) { return buttonActions.get(id) }

// spencer-btns' "reply" buttons come back as a plain-text message whose body
// is the button's visible LABEL (e.g. "🏓 Ping"), not the id passed to
// mod.btn.reply(label, id) — confirmed by the fact that getBody() already
// correctly extracts native templateButtonReplyMessage/buttonsResponseMessage
// ids when those types are actually used, yet a tapped reply button's text
// still doesn't match its id. So: build the button AND register its handler
// under both the id and the exact label in one call, so whichever string
// actually comes back, it matches.
function replyBtn(mod, label, id, fn) {
    registerButtonAction(id, fn)
    registerButtonAction(label, fn)
    return mod.btn.reply(label, id)
}

module.exports = { loadBtns, btnsReady, registerButtonAction, getButtonAction, replyBtn }
