'use strict'

const config = require('../config')

const C = {
    reset:   '\x1b[0m',
    bold:    '\x1b[1m',
    magenta: '\x1b[35m',
    cyan:    '\x1b[36m',
    yellow:  '\x1b[33m',
    gray:    '\x1b[90m',
    red:     '\x1b[31m',
}

function fmtTime(d) {
    const weekday = d.toLocaleDateString('en-US', { weekday: 'long' })
    const time    = d.toLocaleTimeString('en-GB', { hour12: false })
    return `${weekday}, ${time} EAT`
}

function fmtDate(d) {
    const dd = String(d.getDate()).padStart(2, '0')
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    return `${dd}/${mm}/${d.getFullYear()}`
}

// Renders one boxed error log entry, mirroring the reference style:
//   [ BOT NAME ] Unhandled Rejection: <message>
//     ▸ BOT NAME ◂
//   » Sent Time: ...
//   » Date: ...
//   » Message Type: ...
//   » Sender Name: ...
//   » Chat ID: ...
//   ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬
function printErrorBox(title, err, ctx = {}) {
    const now      = new Date()
    const botLabel = (config.botName || 'BOT').toUpperCase()
    const message  = err instanceof Error ? err.message : String(err)

    const lines = [
        `${C.magenta}${C.bold}[ ${botLabel} ]${C.reset} ${C.red}${title}: ${message}${C.reset}`,
        `${C.cyan}  ▸ ${botLabel} ◂${C.reset}`,
        `${C.gray}»${C.reset} Sent Time: ${fmtTime(now)}`,
        `${C.gray}»${C.reset} Date: ${fmtDate(now)}`,
        `${C.gray}»${C.reset} Message Type: ${ctx.messageType || 'N/A'}`,
        `${C.gray}»${C.reset} Sender Name: ${ctx.senderName || 'N/A'}`,
        `${C.gray}»${C.reset} Chat ID: ${ctx.chatId || 'N/A'}`,
        `${C.magenta}${'▬'.repeat(45)}${C.reset}`,
    ]
    console.log(lines.join('\n'))
}

module.exports = { printErrorBox }
