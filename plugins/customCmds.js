const fs = require('fs')
const path = require('path')
const fmt = require('../lib/format')

const DB_PATH = path.join(__dirname, '../custom_commands.json')

function loadCmds() {
    try {
        if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'))
    } catch {}
    return {}
}

function saveCmds(cmds) {
    fs.writeFileSync(DB_PATH, JSON.stringify(cmds, null, 2))
}

// Export so handler can use it
let customCmds = loadCmds()

async function handleCustomCmdBuilder(sock, from, cmd, q, msg, prefix) {
    switch (cmd) {

        // .addcmd <command> | <response>
        case 'addcmd': {
            if (!q || !q.includes('|')) {
                return sock.sendMessage(from, {
                    text: fmt.box('ADD CUSTOM COMMAND', [
                        `Usage: ${prefix}addcmd <command> | <response>`,
                        ``,
                        `Example:`,
                        `${prefix}addcmd hello | Hello there! 👋`,
                        `${prefix}addcmd rules | 1. Be respectful\\n2. No spam`,
                    ])
                }, { quoted: msg })
            }
            const [name, ...rest] = q.split('|')
            const cmdName = name.trim().toLowerCase().replace(/\s+/g, '')
            const response = rest.join('|').trim()
            if (!cmdName || !response) {
                return sock.sendMessage(from, { text: `❌ Invalid format.\nUsage: *${prefix}addcmd <command> | <response>*` }, { quoted: msg })
            }
            customCmds[cmdName] = { response, createdAt: new Date().toISOString(), by: from }
            saveCmds(customCmds)
            await sock.sendMessage(from, {
                text: `✅ *Custom command added!*\n\n📌 Command: *${prefix}${cmdName}*\n💬 Response: ${response}`
            }, { quoted: msg })
            break
        }

        // .delcmd <command>
        case 'delcmd': {
            if (!q) return sock.sendMessage(from, { text: `❌ Usage: *${prefix}delcmd <command>*` }, { quoted: msg })
            const cmdName = q.trim().toLowerCase()
            if (!customCmds[cmdName]) {
                return sock.sendMessage(from, { text: `❌ Command *${prefix}${cmdName}* not found.` }, { quoted: msg })
            }
            delete customCmds[cmdName]
            saveCmds(customCmds)
            await sock.sendMessage(from, { text: `✅ Deleted command: *${prefix}${cmdName}*` }, { quoted: msg })
            break
        }

        // .listcmd
        case 'listcmd': case 'listcmds': case 'mycmds': {
            const keys = Object.keys(customCmds)
            if (!keys.length) {
                return sock.sendMessage(from, {
                    text: `📋 *No custom commands yet.*\n\nAdd one with:\n*${prefix}addcmd hello | Hello there!*`
                }, { quoted: msg })
            }
            let text = `┏▣ ◈ *CUSTOM COMMANDS (${keys.length})* ◈\n`
            keys.forEach(k => { text += `│➽ ${prefix}${k}\n` })
            text += `┗▣\n\n_Use ${prefix}delcmd <name> to remove_`
            await sock.sendMessage(from, { text }, { quoted: msg })
            break
        }

        // .editcmd <command> | <new response>
        case 'editcmd': {
            if (!q || !q.includes('|')) {
                return sock.sendMessage(from, { text: `❌ Usage: *${prefix}editcmd <command> | <new response>*` }, { quoted: msg })
            }
            const [name, ...rest] = q.split('|')
            const cmdName = name.trim().toLowerCase()
            const response = rest.join('|').trim()
            if (!customCmds[cmdName]) {
                return sock.sendMessage(from, { text: `❌ Command *${prefix}${cmdName}* not found.\nUse *${prefix}addcmd* to create it.` }, { quoted: msg })
            }
            customCmds[cmdName].response = response
            customCmds[cmdName].updatedAt = new Date().toISOString()
            saveCmds(customCmds)
            await sock.sendMessage(from, { text: `✅ Updated *${prefix}${cmdName}*\n💬 New response: ${response}` }, { quoted: msg })
            break
        }

        // .cmdinfo <command>
        case 'cmdinfo': {
            if (!q) return sock.sendMessage(from, { text: `❌ Usage: *${prefix}cmdinfo <command>*` }, { quoted: msg })
            const cmdName = q.trim().toLowerCase()
            const c = customCmds[cmdName]
            if (!c) return sock.sendMessage(from, { text: `❌ Command *${prefix}${cmdName}* not found.` }, { quoted: msg })
            await sock.sendMessage(from, {
                text: fmt.box(`${prefix}${cmdName}`, [
                    `Response: ${c.response}`,
                    `Created: ${c.createdAt?.split('T')[0] || 'N/A'}`,
                ])
            }, { quoted: msg })
            break
        }
    }
}

// Check and respond to custom commands
async function checkCustomCmd(sock, from, cmd, msg, prefix) {
    const c = customCmds[cmd]
    if (!c) return false
    // Replace variables in response
    let response = c.response
        .replace(/{user}/gi, `@${msg.key?.participant?.split('@')[0] || from.split('@')[0]}`)
        .replace(/{prefix}/gi, prefix)
        .replace(/{botname}/gi, require('../config').botName)
        .replace(/\\n/g, '\n')
    await sock.sendMessage(from, { text: response }, { quoted: msg })
    return true
}

// Reload commands (useful after edits)
function reloadCmds() {
    customCmds = loadCmds()
}

module.exports = { handleCustomCmdBuilder, checkCustomCmd, reloadCmds }
