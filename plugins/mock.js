'use strict'
// .mock (alias .insult / .roast) — fires a savage but playful roast at someone and mentions them.
// Target: the person whose message you reply to, or an @mention, or the other person in a DM.
const config = require('../config')

const mockCmds = new Set(['mock', 'insult', 'roast'])

const ROASTS = [
    "You're not useless — you can always serve as a bad example.",
    "If laziness was an Olympic sport, you'd send someone to compete for you.",
    "You have the confidence of a man with a dozen followers and a ring light.",
    "I'd call you a tool, but tools are actually useful.",
    "Your WiFi has better connection with the router than you have with reality.",
    "You're proof that even autocorrect gives up eventually.",
    "Somewhere out there a tree is working hard to produce oxygen for you. Go apologize to it.",
    "You bring everyone so much joy… when you leave the group.",
    "If your brain was dynamite, there wouldn't be enough to blow your hat off.",
    "You're like a cloud — when you disappear, it's a beautiful day.",
    "I'd agree with you, but then we'd both be wrong.",
    "Your secrets are safe with me. I wasn't listening anyway.",
    "You're the human version of a 'Terms & Conditions' page — nobody reads you and everybody just scrolls past.",
    "Some people light up a room. You? You just turn it into a group chat nobody replies in.",
    "Your phone has a 'low battery' mode. Does your personality have one too? Because it never loads.",
    "You're built like a loading screen: lots of waiting, nothing ever happens.",
    "I've seen better plans in a Monday morning alarm snooze.",
    "You type '..' and call it a conversation.",
    "You're the reason shampoo bottles have instructions.",
    "If I wanted to hear from someone this irrelevant, I'd check my spam folder.",
    "You're not stupid — you just have bad luck when thinking.",
    "Even your reflection avoids eye contact.",
    "You're the type to get lost in a one-way street.",
    "Your jokes are like your data bundle — they expire before anyone gets to enjoy them.",
    "You have two brain cells and they're both on read.",
    "You're the 'seen at 3 AM, replied next week' of humans.",
    "If silence is golden, you're a billionaire and I still wouldn't loan you airtime.",
    "You're like a software update: nobody asked for you and you always show up at the worst time.",
    "Your vibe is a 2G network in a 5G world.",
    "I'd roast you harder, but my mum said not to burn trash — it pollutes.",
    "You're the background character who thinks they're the plot twist.",
    "Your common sense went on vacation and forgot to take you with it.",
    "Calling you average would be an insult to the average.",
    "You're a 'Hello' in the Sunday group that nobody greets back.",
    "You're about as useful as a screen door on a submarine.",
    "Your opinions have the same energy as an expired coupon — loud, hopeful and totally worthless.",
    "I'd tell you to act your age, but I don't think you've loaded that update yet.",
    "You're so forgettable that your own shadow keeps leaving you for someone better.",
    "You're not the sharpest tool in the shed — you're the one the others make fun of.",
    "You're the reason the 'mute' button was invented.",
]

const digits = j => String(j || '').split('@')[0].split(':')[0].replace(/\D/g, '')

async function handleMock(sock, from, cmd, args, msg, sender) {
    const ctx = msg.message?.extendedTextMessage?.contextInfo || {}
    let target = ctx.participant || (ctx.mentionedJid && ctx.mentionedJid[0]) || ''
    if (!target && !from.endsWith('@g.us')) target = from       // DM: the other person
    if (!target) {
        return sock.sendMessage(from, { text: `😈 Reply to someone's message or @mention them, then send *${config.prefix || '.'}${cmd}*` }, { quoted: msg })
    }
    const botNum = digits(sock.user?.id), botLid = digits(sock.user?.lid)
    const ownerNum = digits(config.ownerNumber)
    const t = digits(target)
    const protectedTarget = t && (t === botNum || t === botLid || t === ownerNum)
    // Can't roast the bot or its owner — the roast bounces back to whoever sent it.
    const who = protectedTarget ? sender : target
    const pre = protectedTarget ? '🔄 Nice try. Reflected back: ' : ''
    const line = ROASTS[Math.floor(Math.random() * ROASTS.length)]
    const quoted = !protectedTarget && ctx.quotedMessage
        ? { key: { remoteJid: from, fromMe: false, id: ctx.stanzaId, participant: ctx.participant }, message: ctx.quotedMessage }
        : msg
    return sock.sendMessage(from, {
        text: `😈 ${pre}@${digits(who)}, ${line}`,
        mentions: [who],
    }, { quoted })
}

module.exports = { mockCmds, handleMock }
