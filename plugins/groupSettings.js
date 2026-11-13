// Per-group settings
// antiAction options: 'warn' | 'delete' | 'kick'
const groupSettings = {}

function getSettings(groupId) {
    if (!groupSettings[groupId]) {
        groupSettings[groupId] = {
            antilink: false,
            antilinkAction: 'warn',      // warn | delete | kick
            antispam: false,
            antispamAction: 'kick',
            antisticker: false,
            antistickerAction: 'delete',
            antivoicenote: false,
            antivoicenoteAction: 'delete',
            antibug: false,
            antibugAction: 'kick',
            antiremove: false,
            antibadword: false,
            antibadwordAction: 'warn',
            antibot: false,
            antidemote: false,
            antiforeign: false,
            antiraid: false,
            // When true, group admins (and the owner, when chatting as a
            // regular member of this group rather than issuing an owner
            // command) are no longer exempt from the anti-link/spam/sticker/
            // voicenote/bug/mention/bot checks above — they get warned/
            // deleted/kicked exactly like anyone else would. Off by default,
            // since losing that exemption by accident is the kind of thing
            // that locks an admin out of their own group.
            antispare: false,
            welcome: false,
            goodbye: false,
        }
    }
    return groupSettings[groupId]
}

function setSetting(groupId, key, value) {
    getSettings(groupId)[key] = value
}

module.exports = { getSettings, setSetting }
