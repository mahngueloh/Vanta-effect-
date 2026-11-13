// Adult / NSFW commands
// Uses public APIs — add your own API key for extended access

async function handleAdult(sock, from, cmd, q, msg) {
    const WAIFU_BASE = 'https://api.waifu.pics/nsfw'
    const RULE34_BASE = 'https://api.rule34.xxx/index.php?page=dapi&s=post&q=index&json=1'

    const waifuMap = {
        hentai:    'hentai',
        naughty:   'naughty',
        lewdwaifu: 'waifu',
        nsfw:      'hentai',
        lewdanime: 'blowjob',
    }

    try {
        if (waifuMap[cmd]) {
            const res  = await fetch(`${WAIFU_BASE}/${waifuMap[cmd]}`, { signal: AbortSignal.timeout(10000) })
            const data = await res.json()
            if (!data.url) throw new Error('No image found')
            return sock.sendMessage(from, {
                image: { url: data.url },
                caption: `🔞 *${cmd.toUpperCase()}*\n_18+ content — for adults only_`
            }, { quoted: msg })
        }

        if (cmd === 'rule34' || cmd === 'danbooru' || cmd === 'xbooru') {
            if (!q) return sock.sendMessage(from, { text: `❌ Usage: .${cmd} <search term>` }, { quoted: msg })
            const res  = await fetch(`${RULE34_BASE}&limit=20&tags=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(10000) })
            const data = await res.json()
            if (!data?.length) return sock.sendMessage(from, { text: `❌ No results for: *${q}*` }, { quoted: msg })
            const item = data[Math.floor(Math.random() * Math.min(data.length, 20))]
            const url  = item.file_url || item.sample_url
            if (!url) throw new Error('No image URL')
            const ext = url.split('.').pop().toLowerCase()
            if (['mp4','webm'].includes(ext)) {
                return sock.sendMessage(from, { video: { url }, caption: `🔞 *${q}*` }, { quoted: msg })
            }
            return sock.sendMessage(from, { image: { url }, caption: `🔞 *${q}*\n_Source: rule34_` }, { quoted: msg })
        }

    } catch (err) {
        await sock.sendMessage(from, {
            text: `❌ Could not fetch content: ${err.message}\n\nTry again or use a different search term.`
        }, { quoted: msg })
    }
}

module.exports = { handleAdult }
