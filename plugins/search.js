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

// Lyrics: Nexray first, then free sources that don't depend on it (LRCLIB by free text, by
// "title by artist", lyrics.ovh). Each failure is logged and summarised in the NOT FOUND card.
async function getLyrics(query, ctx) {
    const axios = require('axios')
    const why = []
    const UA = { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124.0 Mobile Safari/537.36' }
    const card = (title, artist, lyr) => {
        const head = `🎵 *${title}*${artist ? ` — ${artist}` : ''}`
        const body = lyr.length > 6000 ? lyr.slice(0, 6000) + '\n\n_(truncated — too long)_' : lyr
        return fmt.box('LYRICS', [head, ``, body])
    }
    const clean = t => String(t || '').replace(/\r/g, '').trim()

    // 1. Nexray
    const nx = await nexrayLyrics(query, ctx)
    if (nx) return nx
    why.push('nexray: no result')

    // "song by artist" → separate parts
    const by = query.match(/^(.+?)\s+by\s+(.+)$/i)
    const guesses = by ? [{ t: by[1], a: by[2] }] : []

    // 2. LRCLIB free-text search (works with just a song name)
    for (const q of [query, ...(by ? [`${by[2]} ${by[1]}`] : [])]) {
        try {
            const r = await axios.get('https://lrclib.net/api/search', { params: { q }, timeout: 15000, headers: UA })
            const hit = (Array.isArray(r.data) ? r.data : []).find(x => clean(x.plainLyrics).length > 40)
            if (hit) {
                if (ctx?.sock && false) {}
                return card(hit.trackName || query, hit.artistName, clean(hit.plainLyrics))
            }
            why.push('lrclib: none')
        } catch (e) { why.push('lrclib: ' + (e.response?.status || e.code || e.message)); console.log('[lyrics] lrclib failed:', e.message) }
    }

    // 3. Use Nexray's Spotify search to learn the real title + artist, then retry free sources
    try {
        const nxm = require('../lib/nexray')
        const r = await nxm.call('/search/spotify', { params: { q: query }, timeout: 25000 })
        const arr = r.type === 'json' ? (r.json?.result || r.json?.data || []) : []
        const first = Array.isArray(arr) ? arr[0] : null
        const t = first?.title || first?.name || first?.trackName
        const a = first?.artist || first?.artists || first?.artistName
        if (t) guesses.unshift({ t, a: Array.isArray(a) ? a.join(', ') : a })
    } catch (e) { console.log('[lyrics] spotify lookup failed:', e.message) }

    for (const g of guesses) {
        if (!g.t || !g.a) continue
        try {
            const r = await axios.get('https://lrclib.net/api/get', { params: { track_name: g.t, artist_name: g.a }, timeout: 15000, headers: UA })
            if (clean(r.data?.plainLyrics).length > 40) return card(r.data.trackName || g.t, r.data.artistName || g.a, clean(r.data.plainLyrics))
        } catch (e) { why.push('lrclib/get: ' + (e.response?.status || e.message)) }
        try {
            const r = await axios.get(`https://api.lyrics.ovh/v1/${encodeURIComponent(g.a)}/${encodeURIComponent(g.t)}`, { timeout: 15000, headers: UA })
            if (clean(r.data?.lyrics).length > 40) return card(g.t, g.a, clean(r.data.lyrics))
        } catch (e) { why.push('lyrics.ovh: ' + (e.response?.status || e.message)) }
    }

    // 4. Old guess: first word = artist
    try {
        const parts = query.split(' ')
        if (parts.length > 1) {
            const r = await axios.get(`https://api.lyrics.ovh/v1/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts.slice(1).join(' '))}`, { timeout: 15000, headers: UA })
            if (clean(r.data?.lyrics).length > 40) return card(parts.slice(1).join(' '), parts[0], clean(r.data.lyrics))
        }
    } catch {}

    console.log('[lyrics] all sources failed:', why.join(' | '))
    return fmt.box('NOT FOUND', [
        `❌ Lyrics not found for: *${query}*`,
        ``,
        `💡 Try: *.lyrics Artist - Song* (e.g. *.lyrics Toxic - Sick*)`,
        `_${[...new Set(why)].slice(0, 3).join(' · ')}_`,
    ])
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
