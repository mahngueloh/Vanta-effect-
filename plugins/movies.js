const config = require('../config')
const fmt = require('../lib/format')

// Savage API's movie endpoints. The curl examples in the docs didn't show
// an apikey param, but the live API disagrees — it returned "Missing
// apikey" on a real call. Trusting the live error over the docs screenshot.
async function savageMovieFetch(path, params = {}) {
    const url = new URL(path, config.savageApiBase)
    url.searchParams.set('apikey', config.savageApiKey)
    for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v)
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    const data = await res.json()
    if (!res.ok || data?.error) throw new Error(data?.error || `Savage movie API HTTP ${res.status}`)
    return data
}

function firstResults(data) {
    // The API's exact response shape isn't fully documented — handle the
    // common cases (a results array, a data array, or a bare array).
    if (Array.isArray(data)) return data
    if (Array.isArray(data?.results)) return data.results
    if (Array.isArray(data?.data)) return data.data
    return []
}

async function searchMovies(sock, from, query, msg) {
    if (!query) return sock.sendMessage(from, { text: fmt.usage('movie', '<title>') }, { quoted: msg })
    await fmt.react(sock, msg, '🎬')
    try {
        const data = await savageMovieFetch('/movie/search', { query, page: 1 })
        const results = firstResults(data).slice(0, 10)
        if (!results.length) {
            return sock.sendMessage(from, { text: fmt.box('MOVIE SEARCH', [`❌ No results for *${query}*`]) }, { quoted: msg })
        }
        const lines = results.map((m, i) => {
            const title = m.title || m.name || 'Unknown title'
            const year = m.release_date ? ` (${String(m.release_date).slice(0, 4)})` : (m.year ? ` (${m.year})` : '')
            const id = m.id ?? m.movie_id ?? ''
            return `${i + 1}. *${title}*${year}${id !== '' ? ` — id: ${id}` : ''}`
        })
        await sock.sendMessage(from, {
            text: fmt.box(`MOVIE SEARCH — "${query}"`, [...lines, ``, `💡 *.movie details <id>* for full info`])
        }, { quoted: msg })
    } catch (e) {
        await sock.sendMessage(from, { text: fmt.box('MOVIE SEARCH FAILED', [`❌ ${e.message}`]) }, { quoted: msg })
    }
}

async function topRatedMovies(sock, from, page, msg) {
    await fmt.react(sock, msg, '🎬')
    try {
        const data = await savageMovieFetch('/movie/top-rated', { page: page || 1 })
        const results = firstResults(data).slice(0, 10)
        if (!results.length) {
            return sock.sendMessage(from, { text: fmt.box('TOP RATED', [`❌ No results`]) }, { quoted: msg })
        }
        const lines = results.map((m, i) => {
            const title = m.title || m.name || 'Unknown title'
            const rating = m.vote_average ?? m.rating
            return `${i + 1}. *${title}*${rating ? ` — ⭐ ${rating}` : ''}`
        })
        await sock.sendMessage(from, { text: fmt.box('TOP RATED MOVIES', lines) }, { quoted: msg })
    } catch (e) {
        await sock.sendMessage(from, { text: fmt.box('TOP RATED FAILED', [`❌ ${e.message}`]) }, { quoted: msg })
    }
}

async function movieDetails(sock, from, id, msg) {
    if (!id) return sock.sendMessage(from, { text: fmt.usage('movie details', '<id>') }, { quoted: msg })
    await fmt.react(sock, msg, '🎬')
    try {
        const m = await savageMovieFetch('/movie/details', { id })
        const title = m.title || m.name || 'Unknown title'
        const lines = [
            m.overview ? m.overview.slice(0, 500) : null,
            m.release_date ? `📅 Release: ${m.release_date}` : null,
            m.runtime ? `⏱️ Runtime: ${m.runtime} min` : null,
            m.vote_average ? `⭐ Rating: ${m.vote_average}` : null,
            m.genres ? `🎭 Genres: ${(Array.isArray(m.genres) ? m.genres.map(g => g.name || g).join(', ') : m.genres)}` : null,
            m.cast ? `🎭 Cast: ${(Array.isArray(m.cast) ? m.cast.slice(0, 5).join(', ') : m.cast)}` : null,
        ].filter(Boolean)
        const poster = m.poster_path || m.poster || m.image
        if (poster) {
            const posterUrl = String(poster).startsWith('http') ? poster : `https://image.tmdb.org/t/p/w500${poster}`
            try {
                await sock.sendMessage(from, { image: { url: posterUrl }, caption: fmt.box(title, lines) }, { quoted: msg })
                return
            } catch { /* fall through to text-only below */ }
        }
        await sock.sendMessage(from, { text: fmt.box(title, lines) }, { quoted: msg })
    } catch (e) {
        await sock.sendMessage(from, { text: fmt.box('MOVIE DETAILS FAILED', [`❌ ${e.message}`]) }, { quoted: msg })
    }
}

module.exports = { searchMovies, topRatedMovies, movieDetails }
