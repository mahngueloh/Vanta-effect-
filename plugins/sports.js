const config = require('../config')

const LEAGUES = {
    epl:        { code: 'PL',  name: 'Premier League', aliases: ['pl','prem','premierleague'] },
    laliga:     { code: 'PD',  name: 'La Liga', aliases: ['liga'] },
    bundesliga: { code: 'BL1', name: 'Bundesliga', aliases: ['bundes'] },
    seriea:     { code: 'SA',  name: 'Serie A', aliases: ['serie'] },
    ligue1:     { code: 'FL1', name: 'Ligue 1', aliases: ['ligue'] },
    cl:         { code: 'CL',  name: 'Champions League', aliases: ['champions','championsleague'] },
    efl:        { code: 'ELC', name: 'EFL Championship', aliases: ['championship'] },
    el:         { code: 'EL',  name: 'Europa League', aliases: ['europa','europaleague'] },
    wc:         { code: 'WC',  name: 'World Cup', aliases: ['worldcup'] },
}


const SPORTS_TYPES = ['matches', 'standings', 'scorers', 'upcoming']
const TYPE_ALIASES = { results: 'matches', result: 'matches', table: 'standings', top: 'scorers', next: 'upcoming', fixtures: 'upcoming' }

// Generated from the same league/type definitions used by the fetcher.
// This prevents handler.js/menu.js from drifting out of sync when a league
// or alias is added later.
function getSportsCommands() {
    const out = new Set(['sports', 'sport', 'wrestlingevents', 'wwenews', 'wweschedule'])
    for (const [key, meta] of Object.entries(LEAGUES)) {
        for (const name of [key, ...(meta.aliases || [])]) {
            out.add(name)
            for (const type of SPORTS_TYPES) out.add(name + type)
            for (const alias of Object.keys(TYPE_ALIASES)) out.add(name + alias)
        }
    }
    return out
}

function resolveSportsCommand(cmd) {
    const raw = String(cmd || '').toLowerCase().trim()
    if (raw === 'sports' || raw === 'sport') return { help: true }
    for (const [key, meta] of Object.entries(LEAGUES)) {
        const names = [key, ...(meta.aliases || [])].sort((a, b) => b.length - a.length)
        for (const name of names) {
            if (!raw.startsWith(name)) continue
            const suffix = raw.slice(name.length)
            const type = suffix ? (TYPE_ALIASES[suffix] || suffix) : 'matches'
            if (SPORTS_TYPES.includes(type)) return { league: key, type }
        }
    }
    return null
}

// Savage's /sports/*-matches endpoints, confirmed directly from their docs:
// Premier League matches live at the bare "/sports/matches" (no "epl-"
// prefix — that was the earlier wrong assumption that broke .eplmatches),
// while other leagues get their own "<league>-matches" path, e.g.
// "/sports/bundesliga-matches" (added below, wasn't wired in at all before —
// that's why .bundesliga said "Unknown sports command").
const SAVAGE_LEAGUES = { epl: 'matches', laliga: 'laliga-matches', bundesliga: 'bundesliga-matches' }
const SAVAGE_STANDINGS_LEAGUES = { epl: 'epl-standings' }
const SAVAGE_SCORERS_LEAGUES = { epl: 'epl-scorers' }

// ESPN's public scoreboard JSON — no API key, ever, for anyone. Not
// officially documented, but it's the same endpoint ESPN's own site/app
// calls, and it's been stable and free for years, which is exactly what a
// "the free fallback token keeps expiring" problem needs: one link in the
// chain that structurally can't expire. Used as the fallback for
// matches/upcoming before football-data.org, so a dead token there no
// longer takes results down completely.
const ESPN_SLUGS = {
    epl: 'eng.1', laliga: 'esp.1', bundesliga: 'ger.1', seriea: 'ita.1',
    ligue1: 'fra.1', cl: 'uefa.champions', efl: 'eng.2', el: 'uefa.europa',
}

// Free token for football-data.org (allows 10 req/min) — kept as the proven
// fallback for every league/type Savage doesn't cover, and for whenever
// Savage itself is down or its response shape doesn't parse as expected.
// The hardcoded one below can expire/get revoked over time — set
// FOOTBALL_DATA_TOKEN in .env with a fresh free token from
// https://www.football-data.org/client/register to override it.
const TOKEN = process.env.FOOTBALL_DATA_TOKEN || '7b7639a1b6d5476aae3c2e6e70b4cf08'

function isoDate(d) { return d.toISOString().slice(0, 10) }
function addDays(base, n) { const d = new Date(base); d.setDate(d.getDate() + n); return d }

// Auto-computed date window for a match query — this is what "the same
// flow of fetching" from the Savage docs example needs, just with a real
// rolling window instead of a hardcoded month. Results look back 14 days;
// upcoming looks forward 30 days.
function dateWindow(type) {
    const today = new Date()
    if (type === 'upcoming') return { dateFrom: isoDate(today), dateTo: isoDate(addDays(today, 30)), status: 'SCHEDULED' }
    return { dateFrom: isoDate(addDays(today, -14)), dateTo: isoDate(today), status: 'FINISHED' }
}

async function savageFetch(endpoint, params = {}) {
    const url = new URL(`/sports/${endpoint}`, config.savageApiBase)
    for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v)
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    const data = await res.json()
    if (!res.ok || data?.error) throw new Error(data?.error || `Savage sports HTTP ${res.status}`)
    return data
}

async function fbFetch(code, path) {
    const res = await fetch(`https://api.football-data.org/v4/competitions/${code}/${path}`, {
        headers: { 'X-Auth-Token': TOKEN },
        signal: AbortSignal.timeout(15000)
    })
    const data = await res.json()
    if (data.errorCode) throw new Error(data.message || 'API error')
    return data
}

// Normalizes ESPN's event shape into the exact same {matches:[...]} shape
// football-data.org uses, so the existing parseResults/parseUpcoming below
// work unchanged regardless of which source the data came from.
function espnToFbShape(events) {
    return (events || []).map(e => {
        const comp = e.competitions?.[0]
        const home = comp?.competitors?.find(c => c.homeAway === 'home')
        const away = comp?.competitors?.find(c => c.homeAway === 'away')
        if (!home || !away) return null
        return {
            utcDate: e.date,
            homeTeam: { shortName: home.team?.shortDisplayName || home.team?.displayName, name: home.team?.displayName },
            awayTeam: { shortName: away.team?.shortDisplayName || away.team?.displayName, name: away.team?.displayName },
            score: { fullTime: { home: home.score ?? '?', away: away.score ?? '?' } },
        }
    }).filter(Boolean)
}

async function espnFetch(slug) {
    const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard`, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`ESPN HTTP ${res.status}`)
    const data = await res.json()
    return { matches: espnToFbShape(data.events) }
}

// ── Shared parsers — same shape whether the JSON came from Savage or
// straight from football-data.org, since Savage mirrors that shape exactly.

function parseStandings(data) {
    const table = data.standings?.[0]?.table?.slice(0, 10)
    if (!table?.length) return null
    return table.map(t => `┃ ${String(t.position).padStart(2)}. ${t.team.shortName || t.team.name} — *${t.points}pts* (${t.won}W ${t.draw}D ${t.lost}L)`).join('\n')
}

function parseResults(data) {
    const matches = [...(data.matches || [])].filter(m => m?.utcDate).sort((a,b) => new Date(b.utcDate) - new Date(a.utcDate)).slice(0, 8)
    if (!matches?.length) return null
    return matches.map(m => {
        const h = m.score?.fullTime?.home ?? '?'
        const a = m.score?.fullTime?.away ?? '?'
        return `┃ ${m.homeTeam.shortName || m.homeTeam.name} *${h}-${a}* ${m.awayTeam.shortName || m.awayTeam.name}`
    }).join('\n')
}

function parseUpcoming(data) {
    const matches = [...(data.matches || [])].filter(m => m?.utcDate).sort((a,b) => new Date(a.utcDate) - new Date(b.utcDate)).slice(0, 8)
    if (!matches?.length) return null
    return matches.map(m => {
        const d = new Date(m.utcDate).toLocaleDateString('en-KE', { timeZone: 'Africa/Nairobi', day: '2-digit', month: 'short' })
        const t = new Date(m.utcDate).toLocaleTimeString('en-KE', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit' })
        return `┃ ${m.homeTeam.shortName || m.homeTeam.name} vs ${m.awayTeam.shortName || m.awayTeam.name} — *${d} ${t}*`
    }).join('\n')
}

function parseScorers(data) {
    const scorers = data.scorers?.slice(0, 10)
    if (!scorers?.length) return null
    return scorers.map((s, i) => `┃ ${i + 1}. *${s.player.name}* (${s.team.shortName || s.team.name}) — ${s.goals} ⚽`).join('\n')
}

// Tries Savage first (when this league/type is covered by it), falls back
// to football-data.org directly on any failure or unexpected shape — so a
// Savage outage or an undocumented response change never surfaces as an
// error to the user as long as the fallback still works.
// ESPN's standings endpoint has a messier, less-documented shape than the
// scoreboard one, so this is deliberately defensive: if any expected field
// comes back missing/undefined, it returns null instead of a broken-looking
// row. fetchAndParse treats a null result as "try the next source," so a
// wrong guess about the shape safely falls through to football-data.org
// instead of showing garbage.
async function espnStandingsFetch(slug) {
    const res = await fetch(`https://site.api.espn.com/apis/v2/sports/soccer/${slug}/standings`, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`ESPN HTTP ${res.status}`)
    return res.json()
}

function parseEspnStandings(data) {
    const entries = data?.children?.[0]?.standings?.entries || data?.standings?.[0]?.entries
    if (!entries?.length) return null
    const statVal = (entry, name) => entry.stats?.find(s => s.name === name || s.abbreviation === name)?.value
    const rows = entries.slice(0, 10).map((e, i) => {
        const team = e.team?.shortDisplayName || e.team?.displayName
        const pts = statVal(e, 'points')
        const w = statVal(e, 'wins')
        const d = statVal(e, 'ties') ?? statVal(e, 'draws')
        const l = statVal(e, 'losses')
        const rank = statVal(e, 'rank') ?? (i + 1)
        if (!team || pts === undefined) return null
        return `┃ ${String(rank).padStart(2)}. ${team} — *${pts}pts* (${w ?? '?'}W ${d ?? '?'}D ${l ?? '?'}L)`
    })
    return rows.every(Boolean) ? rows.join('\n') : null
}

async function fetchAndParse(league, code, type) {
    if (type === 'standings' && SAVAGE_STANDINGS_LEAGUES[league]) {
        try {
            const data = await savageFetch(SAVAGE_STANDINGS_LEAGUES[league])
            const parsed = parseStandings(data)
            if (parsed) return parsed
        } catch { /* fall through to football-data.org below */ }
    }
    // ESPN standings next — no key needed, so it can't go dark the way a
    // free football-data.org token eventually does. Covers every league
    // ESPN has a slug for, not just the one Savage supports.
    if (type === 'standings' && ESPN_SLUGS[league]) {
        try {
            const data = await espnStandingsFetch(ESPN_SLUGS[league])
            const parsed = parseEspnStandings(data)
            if (parsed) return parsed
        } catch { /* fall through */ }
    }
    if (type === 'scorers' && SAVAGE_SCORERS_LEAGUES[league]) {
        try {
            const data = await savageFetch(SAVAGE_SCORERS_LEAGUES[league])
            const parsed = parseScorers(data)
            if (parsed) return parsed
        } catch { /* fall through */ }
    }
    if ((type === 'matches' || type === 'upcoming') && SAVAGE_LEAGUES[league]) {
        try {
            const data = await savageFetch(SAVAGE_LEAGUES[league], dateWindow(type))
            const parsed = type === 'upcoming' ? parseUpcoming(data) : parseResults(data)
            if (parsed) return parsed
        } catch { /* fall through */ }
    }

    // ESPN next — needs no key/token at all, so it can't go dark the way a
    // free football-data.org token eventually does.
    if ((type === 'matches' || type === 'upcoming') && ESPN_SLUGS[league]) {
        try {
            const data = await espnFetch(ESPN_SLUGS[league])
            const parsed = type === 'upcoming' ? parseUpcoming(data) : parseResults(data)
            if (parsed) return parsed
        } catch { /* fall through to football-data.org below */ }
    }

    // football-data.org fallback — covers every league Savage/ESPN don't,
    // and catches both being down or returning something unparseable.
    if (type === 'standings') return parseStandings(await fbFetch(code, 'standings'))
    if (type === 'matches')   return parseResults(await fbFetch(code, 'matches?status=FINISHED&limit=8'))
    if (type === 'upcoming')  return parseUpcoming(await fbFetch(code, 'matches?status=SCHEDULED&limit=8'))
    if (type === 'scorers')   return parseScorers(await fbFetch(code, 'scorers?limit=10'))
    return null
}

async function handleSports(sock, from, cmd, msg, extra) {
    // WWE/Wrestling
    if (['wrestlingevents','wwenews','wweschedule'].includes(cmd)) {
        return sock.sendMessage(from, {
            text: `🤼 *WWE Events*\n\nLatest events: https://www.wwe.com/events\nLatest news: https://www.wwe.com/inside_wwe/news`
        }, { quoted: msg })
    }

    const resolved = resolveSportsCommand(cmd)
    if (resolved?.help) {
        const lines = Object.entries(LEAGUES).map(([key, meta]) =>
            `┃ ⚽ *${meta.name}* — .${key}, .${key}matches, .${key}standings, .${key}scorers, .${key}upcoming`
        )
        return sock.sendMessage(from, { text: `┏━━❐⚽ SPORTS-CMD ✧\n${lines.join('\n')}\n┃ 💡 Short aliases and .<league> alone are supported.\n┗━━━━━━━━━━━━━━━━━━` }, { quoted: msg })
    }
    if (!resolved) return sock.sendMessage(from, { text: `❌ Unknown sports command.\n\nTry *.sports* to see valid sports commands.` }, { quoted: msg })

    // ".bundesliga standings" (two words) used to silently ignore "standings"
    // and default to matches, because only the first word ever reached this
    // function — the natural, human way of typing this ("<league> <type>",
    // with a space) never actually worked, only the concatenated form
    // (".bundesligastandings") did. Now a trailing word overrides the type,
    // whichever style someone types.
    if (resolved.league && extra) {
        const word = extra.trim().toLowerCase().split(/\s+/)[0]
        const type = TYPE_ALIASES[word] || word
        if (SPORTS_TYPES.includes(type)) resolved.type = type
    }

    const { league, type } = resolved

    const { code, name } = LEAGUES[league]
    const wait = await sock.sendMessage(from, { text: `⏳ Fetching *${name}* ${type}...` }, { quoted: msg })

    try {
        const body = await fetchAndParse(league, code, type)
        if (!body) throw new Error('No data')

        const titles = {
            standings: `🏆 ${name} STANDINGS`,
            matches:   `⚽ ${name} RESULTS`,
            upcoming:  `📅 ${name} UPCOMING`,
            scorers:   `⚽ ${name} TOP SCORERS`,
        }
        const text = `┏▣ ◈ *${titles[type] || `${name} ${type.toUpperCase()}`}* ◈\n${body}\n┗▣`

        try { await sock.sendMessage(from, { delete: wait.key }) } catch {}
        await sock.sendMessage(from, { text }, { quoted: msg })

    } catch (err) {
        try { await sock.sendMessage(from, { delete: wait.key }) } catch {}
        const tokenDead = /invalid.*token|token.*invalid/i.test(err.message || '')
        const hint = tokenDead
            ? `💡 The free football-data.org fallback token has expired. Get a new free one at https://www.football-data.org/client/register and set FOOTBALL_DATA_TOKEN in .env.`
            : `💡 Both sources (Savage API and the free football-data.org fallback) failed. Try again shortly.`
        await sock.sendMessage(from, {
            text: `❌ *${name} ${type} unavailable*\n_${err.message}_\n\n${hint}`
        }, { quoted: msg })
    }
}

module.exports = { handleSports, getSportsCommands, resolveSportsCommand }
