'use strict'
// Owner diagnostic: posts a TEXT status six different ways so we can see which
// way this WhatsApp account actually shows under "My status".
const cleanNum = j => String(j || '').split('@')[0].split(':')[0]

async function sendStatusTest(sock, from, msg) {
    const { generateWAMessageFromContent } = require('@neoxr/baileys')
    const pn  = cleanNum(sock.user?.id) + '@s.whatsapp.net'
    const lid = sock.user?.lid ? cleanNum(sock.user.lid) + '@lid' : null
    const both = [pn, ...(lid ? [lid] : [])]
    const bg = '#0B141A'
    const variants = [
        ['phone-number JID only', () => sock.sendMessage('status@broadcast', { text: '', backgroundColor: bg, font: 2 }, { statusJidList: [pn] })],
        ['LID only',              () => lid ? sock.sendMessage('status@broadcast', { text: '', backgroundColor: bg, font: 2 }, { statusJidList: [lid] }) : Promise.reject(new Error('no LID known'))],
        ['both JIDs',             () => sock.sendMessage('status@broadcast', { text: '', backgroundColor: bg, font: 2 }, { statusJidList: both })],
        ['both, no colour/font',  () => sock.sendMessage('status@broadcast', { text: '' }, { statusJidList: both })],
        ['both, fresh metadata',  () => sock.sendMessage('status@broadcast', { text: '', backgroundColor: bg, font: 2 }, { statusJidList: both, useCachedGroupMetadata: false })],
        ['raw relay',             async () => {
            const m = generateWAMessageFromContent('status@broadcast', { extendedTextMessage: { text: '', backgroundArgb: 0xFF0B141A, textArgb: 0xFFFFFFFF, font: 2 } }, { userJid: sock.user.id })
            await sock.relayMessage('status@broadcast', m.message, { messageId: m.key.id, statusJidList: both })
            return m
        }],
    ]
    await sock.sendMessage(from, { text: `Posting ${variants.length} test statuses to ${both.join(', ')}. Then open WhatsApp → Updates → My status and tell me which numbers you see.` }, { quoted: msg })
    for (let i = 0; i < variants.length; i++) {
        const [label, run] = variants[i]
        const text = `Status test ${i + 1}/${variants.length}: ${label}`
        try {
            // patch the text into whichever call shape this variant uses
            const orig = sock.sendMessage
            const res = await (async () => {
                sock.sendMessage = (jid, content, opts) => orig.call(sock, jid, content.text === '' ? { ...content, text } : content, opts)
                try {
                    if (label === 'raw relay') {
                        const m = generateWAMessageFromContent('status@broadcast', { extendedTextMessage: { text, backgroundArgb: 0xFF0B141A, textArgb: 0xFFFFFFFF, font: 2 } }, { userJid: sock.user.id })
                        await sock.relayMessage('status@broadcast', m.message, { messageId: m.key.id, statusJidList: both })
                        return m
                    }
                    return await run()
                } finally { sock.sendMessage = orig }
            })()
            console.log(`[statustest] ${i + 1} (${label}) sent id=${res?.key?.id}`)
        } catch (e) {
            console.log(`[statustest] ${i + 1} (${label}) FAILED:`, e.stack || e.message)
        }
        await new Promise(r => setTimeout(r, 3000))
    }
    await sock.sendMessage(from, { text: 'Done. Open My status and reply with the numbers you can see (or "none").' })
}

module.exports = { sendStatusTest }
