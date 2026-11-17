'use strict'
// Owner diagnostic for status posting on LID-migrated accounts.
// Known upstream bug (WhiskeySockets/Baileys #2794): status@broadcast sends
// with PN recipients are rejected by WhatsApp (ack error 479) while sendMessage
// still "succeeds". This logs the real ack for every attempt and tries
// LID-only recipient lists.
//   .statustest                 → to yourself only
//   .statustest 2547XXXXXXXX    → also to that contact
const cleanNum = j => String(j || '').split('@')[0].split(':')[0]

async function sendStatusTest(sock, from, msg, args = []) {
    const { generateWAMessageFromContent } = require('@neoxr/baileys')
    const bg = '#0B141A'
    const pn  = cleanNum(sock.user?.id) + '@s.whatsapp.net'
    const lid = sock.user?.lid ? cleanNum(sock.user.lid) + '@lid' : null
    const extraNum = String(args[0] || '').replace(/\D/g, '')
    const extraPn = extraNum ? extraNum + '@s.whatsapp.net' : null

    // PN → LID for the extra contact via the library's own mapping store
    let extraLid = null
    if (extraPn) {
        try {
            const r = await sock.signalRepository.lidMapping.getLIDForPN(extraPn)
            if (r) extraLid = cleanNum(r) + '@lid'
        } catch (e) { console.log('[statustest] lid lookup failed:', e.message) }
        if (!extraLid) {
            try {
                const [hit] = (await sock.onWhatsApp(extraNum)) || []
                if (hit?.lid) extraLid = cleanNum(hit.lid) + '@lid'
            } catch {}
        }
    }
    const pnList  = [pn, ...(lid ? [lid] : []), ...(extraPn ? [extraPn] : [])]
    const lidList = [...(lid ? [lid] : []), ...(extraLid ? [extraLid] : [])]
    console.log('[statustest] pnList=' + JSON.stringify(pnList) + ' lidList=' + JSON.stringify(lidList))

    // Log WhatsApp's real accept/reject reply for status sends
    const onAck = n => { if (n?.attrs?.from === 'status@broadcast') console.log('[status-ack]', JSON.stringify(n.attrs)) }
    try { sock.ws.on('CB:ack,class:message', onAck) } catch (e) { console.log('[statustest] ack listener failed:', e.message) }

    const post = (text, statusJidList) => sock.sendMessage('status@broadcast', { text, backgroundColor: bg, font: 2, __noFun: true }, { statusJidList })
    const raw = async (text, statusJidList, additionalAttributes) => {
        const m = generateWAMessageFromContent('status@broadcast', { extendedTextMessage: { text, backgroundArgb: 0xFF0B141A, textArgb: 0xFFFFFFFF, font: 2 } }, { userJid: sock.user.id })
        await sock.relayMessage('status@broadcast', m.message, { messageId: m.key.id, statusJidList, ...(additionalAttributes ? { additionalAttributes } : {}) })
        return m
    }
    const variants = [
        ['PN + LID (what .tostatus does now)', t => post(t, pnList)],
        ['LID only',                           t => post(t, lidList)],
        ['LID only + addressing_mode=lid',     t => raw(t, lidList, { addressing_mode: 'lid' })],
        ['LID only, raw relay',                t => raw(t, lidList)],
    ]
    await sock.sendMessage(from, { text: `Posting ${variants.length} test statuses. Recipients tried: ${pnList.join(', ')}${extraPn && !extraLid ? ' (could not find a LID for the contact)' : ''}.` }, { quoted: msg })
    for (let i = 0; i < variants.length; i++) {
        const [label, run] = variants[i]
        const text = `Status test ${i + 1}/${variants.length}: ${label}`
        try {
            const res = await run(text)
            console.log(`[statustest] ${i + 1} (${label}) sent id=${res?.key?.id}`)
        } catch (e) {
            console.log(`[statustest] ${i + 1} (${label}) FAILED:`, e.stack || e.message)
        }
        await new Promise(r => setTimeout(r, 3000))
    }
    try { sock.ws.off('CB:ack,class:message', onAck) } catch {}
    await sock.sendMessage(from, { text: 'Done. Check Updates on your phone (and the contact\'s phone). Then send me the [status-ack] lines from the logs.' })
}

module.exports = { sendStatusTest }
