const fmt = require('../lib/format')

// Nexray: GET /search/lyrics?q=<song>  →  { result: { title, artist, thumbnail, url, lyrics } }
// (lyrics is "-" when it found nothing). Returns text, and sends the cover picture first when it has one.
async function nexrayLyrics(query, ctx) {
    try {
        const axios = require('axios')
        const res = await axios.get('https://api.nexray.eu.cc/search/lyrics', {
            params: { q: query }, timeout: 30000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36' },
        })
        const r = res.data?.result
        const lyr = r && typeof r.lyrics === 'string' ? r.lyrics.trim() : ''
        if (!res.data?.status || !lyr || lyr === '-' || r.error) return null
        const head = `🎵 *${r.title || query}*${r.artist ? ` — ${r.artist}` : ''}`
        if (ctx?.sock && r.thumbnail && /^https?:/.test(r.thumbnail)) {
            try { await ctx.sock.sendMessage(ctx.from, { image: { url: r.thumbnail }, caption: head }, { quoted: ctx.msg }) } catch {}
        }
        const body = lyr.length > 6000 ? lyr.slice(0, 6000) + '\n\n_(truncated — too long)_' : lyr
        return fmt.box('LYRICS', [head, ``, body])
    } catch (e) { console.log('[lyrics] Nexray failed:', e.response?.status || e.message); return null }
}

async function getLyrics(query, ctx) {
    const nx = await nexrayLyrics(query, ctx)
    if (nx) return nx
    try {
        const parts  = query.split(' ')
        const artist = parts[0]
        const title  = parts.slice(1).join(' ') || parts[0]

        // lyrics.ovh — free
        const res = await fetch(
            `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`,
            { signal: AbortSignal.timeout(10000) }
        )
        const data = await res.json()
        if (data.lyrics) {
            const lyrics = data.lyrics.substring(0, 3000)
            return fmt.box('LYRICS', [
                `🎵 *${query}*`,
                ``,
                lyrics,
                data.lyrics.length > 3000 ? `\n_(truncated — too long)_` : null,
            ].filter(v => v !== null))
        }

        // some-random-api fallback
        const res2 = await fetch(
            `https://some-random-api.com/lyrics?title=${encodeURIComponent(query)}`,
            { signal: AbortSignal.timeout(10000) }
        )
        const data2 = await res2.json()
        if (data2.lyrics) {
            const lyrics = data2.lyrics.substring(0, 3000)
            return fmt.box('LYRICS', [
                `🎵 *${data2.title}* — ${data2.author}`,
                ``,
                lyrics,
            ])
        }
        return fmt.box('NOT FOUND', [
            `❌ Lyrics not found for: *${query}*`,
            ``,
            `💡 Try format: *Artist SongName*`,
            `Example: *.lyrics Adele Hello*`,
        ])
    } catch {
        return fmt.box('ERROR', [`❌ Could not fetch lyrics. Format: *Artist SongName*`])
    }
}

async function getIMDB(query) {
    try {
        // OMDb API — free tier
        const apikeys = ['trilogy', 'thewdb', 'a70c9b59']
        let data = null
        for (const key of apikeys) {
            try {
                const res = await fetch(
                    `https://www.omdbapi.com/?t=${encodeURIComponent(query)}&apikey=${key}`,
                    { signal: AbortSignal.timeout(10000) }
                )
                data = await res.json()
                if (data.Response === 'True') break
                data = null
            } catch {}
        }
        if (data?.Response === 'True') {
            return fmt.box('IMDB', [
                `🎬 *${data.Title}* (${data.Year})`,
                `⭐ *Rating:* ${data.imdbRating}/10`,
                `🎭 *Genre:* ${data.Genre}`,
                `📝 *Plot:* ${data.Plot}`,
                `👤 *Director:* ${data.Director}`,
                `🌟 *Cast:* ${data.Actors}`,
                `⏱ *Runtime:* ${data.Runtime}`,
            ])
        }
        return fmt.box('NOT FOUND', [`❌ Movie not found: *${query}*`])
    } catch {
        return fmt.box('ERROR', [`❌ Could not fetch IMDB data.`])
    }
}

async function getYTS(query) {
    try {
        const res = await fetch(
            `https://yts.mx/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}&limit=5`,
            { signal: AbortSignal.timeout(10000) }
        )
        const data   = await res.json()
        const movies = data.data?.movies
        if (!movies?.length) return fmt.box('YTS', [`❌ No movies found for: *${query}*`])

        const lines = []
        movies.forEach((m, i) => {
            const torrent = m.torrents?.[0]
            lines.push(`${i + 1}. *${m.title}* (${m.year}) ⭐${m.rating}`)
            if (torrent) lines.push(`   📥 ${torrent.quality} — ${torrent.size}\n   🔗 ${torrent.url}`)
            lines.push(``)
        })
        return fmt.box('YTS RESULTS', lines)
    } catch {
        return fmt.box('ERROR', [`❌ Could not fetch YTS results.`])
    }
}

module.exports = { getLyrics, getIMDB, getYTS }
