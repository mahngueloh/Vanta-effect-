'use strict'
// ─────────────────────────────────────────────────────────────────────────────
// In-chat text games. Every move is a normal command (.ttt 5, .hm e, ...), the
// bot answers with the updated board. State is kept in memory, one game per
// player per chat per game type, and expires after 20 minutes of silence.
// ─────────────────────────────────────────────────────────────────────────────
const config = require('../config')

// ── infrastructure ───────────────────────────────────────────────────────────
const TTL_MS = 20 * 60 * 1000
const cfg = { moveGapMs: 600 }          // per-player spam guard (tests set 0)
let rng = Math.random
function _setRng(fn) { rng = fn || Math.random }
const ri = n => Math.floor(rng() * n)
const pick = arr => arr[ri(arr.length)]
function shuffle(a) {
    const r = a.slice()
    for (let i = r.length - 1; i > 0; i--) { const j = ri(i + 1);[r[i], r[j]] = [r[j], r[i]] }
    return r
}
const NUM = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣']
const FENCE = '```'
const P = () => config.prefix || '.'

const sessions = new Map()
const lastMove = new Map()
const skey = (from, sender, game) => `${from}|${sender}|${game}`

function sweep() {
    if (sessions.size < 200) return
    const now = Date.now()
    for (const [k, s] of sessions) if (now - s.last > TTL_MS) sessions.delete(k)
}
function getSession(from, sender, game) {
    const k = skey(from, sender, game)
    const s = sessions.get(k)
    if (!s) return null
    if (Date.now() - s.last > TTL_MS) { sessions.delete(k); return null }
    s.last = Date.now()
    return s
}
function newSession(from, sender, game, state) {
    sweep()
    const s = { game, state, last: Date.now() }
    sessions.set(skey(from, sender, game), s)
    return s
}
function endSession(from, sender, game) { return sessions.delete(skey(from, sender, game)) }

function tooFast(sender, game) {
    if (!cfg.moveGapMs) return false
    const k = `${sender}|${game}`
    const now = Date.now()
    if (now - (lastMove.get(k) || 0) < cfg.moveGapMs) return true
    lastMove.set(k, now)
    if (lastMove.size > 500) { for (const [kk, v] of lastMove) if (now - v > 60000) lastMove.delete(kk) }
    return false
}

const isStop = a => a === 'stop' || a === 'end' || a === 'quit' || a === 'exit'

// Grid helpers: letters = rows (A,B,...), numbers = columns (1,2,...)
function parseCell(args, rows, cols) {
    const t = args.join('').toLowerCase().replace(/[^a-z0-9]/g, '')
    let r, c
    let m = t.match(/^([a-z])(\d{1,2})$/)
    if (m) { r = m[1].charCodeAt(0) - 97; c = parseInt(m[2], 10) - 1 }
    else {
        m = t.match(/^(\d{1,2})([a-z])$/)
        if (!m) return null
        c = parseInt(m[1], 10) - 1; r = m[2].charCodeAt(0) - 97
    }
    if (r < 0 || r >= rows || c < 0 || c >= cols) return null
    return { r, c, idx: r * cols + c }
}
const rowLabel = r => String.fromCharCode(0xFF21 + r)      // fullwidth A, B, C...
const colHeader = cols => '　' + Array.from({ length: cols }, (_, i) => NUM[i + 1]).join('')
const neighbors8 = (r, c, rows, cols) => {
    const out = []
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue
        const rr = r + dr, cc = c + dc
        if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) out.push([rr, cc])
    }
    return out
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. TIC-TAC-TOE  (you ❌ vs bot ⭕)
// ═════════════════════════════════════════════════════════════════════════════
const TTT_LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]]
function tttWinner(b) {
    for (const [x, y, z] of TTT_LINES) if (b[x] && b[x] === b[y] && b[x] === b[z]) return b[x]
    return b.every(Boolean) ? 'draw' : null
}
function tttMinimax(b, turn) {
    const w = tttWinner(b)
    if (w === 'O') return 1
    if (w === 'X') return -1
    if (w === 'draw') return 0
    let best = turn === 'O' ? -2 : 2
    for (let i = 0; i < 9; i++) {
        if (b[i]) continue
        b[i] = turn
        const s = tttMinimax(b, turn === 'O' ? 'X' : 'O')
        b[i] = null
        best = turn === 'O' ? Math.max(best, s) : Math.min(best, s)
    }
    return best
}
function tttBotMove(b, mode) {
    const empty = []
    for (let i = 0; i < 9; i++) if (!b[i]) empty.push(i)
    for (const i of empty) { b[i] = 'O'; const w = tttWinner(b); b[i] = null; if (w === 'O') return i }
    for (const i of empty) { b[i] = 'X'; const w = tttWinner(b); b[i] = null; if (w === 'X') return i }
    if (mode === 'hard') {
        let best = -2, moves = []
        for (const i of empty) {
            b[i] = 'O'; const s = tttMinimax(b, 'X'); b[i] = null
            if (s > best) { best = s; moves = [i] } else if (s === best) moves.push(i)
        }
        return pick(moves)
    }
    if (rng() < 0.25) return pick(empty)
    return [4, 0, 2, 6, 8, 1, 3, 5, 7].filter(i => empty.includes(i))[0]
}
function tttView(st, status) {
    const cell = i => st.b[i] === 'X' ? '❌' : st.b[i] === 'O' ? '⭕' : NUM[i + 1]
    const row = r => [0, 1, 2].map(c => cell(r * 3 + c)).join('')
    return `*❌⭕ TIC-TAC-TOE${st.mode === 'hard' ? ' (hard)' : ''}*\n\n${row(0)}\n${row(1)}\n${row(2)}\n\n${status}`
}
function gameTtt({ from, sender, args }) {
    const p = P(), a = args[0]
    if (isStop(a)) return endSession(from, sender, 'ttt') ? '🛑 Tic-Tac-Toe ended.' : `No Tic-Tac-Toe game running. Type ${p}ttt to start.`
    if (a === 'start' || a === 'new' || a === 'normal' || a === 'hard' || (!a && !getSession(from, sender, 'ttt'))) {
        const s = newSession(from, sender, 'ttt', { b: Array(9).fill(null), mode: a === 'hard' ? 'hard' : 'normal' })
        return tttView(s.state, `You are ❌ — your move: ${p}ttt <1-9>`)
    }
    const s = getSession(from, sender, 'ttt')
    if (!s) return `No Tic-Tac-Toe game running. Type ${p}ttt to start (${p}ttt hard for a tougher bot).`
    const st = s.state
    if (!a) return tttView(st, `Your move: ${p}ttt <1-9>`)
    if (!/^[1-9]$/.test(a)) return tttView(st, `Pick a free square 1-9: ${p}ttt <1-9>  (${p}ttt stop to quit)`)
    const i = parseInt(a, 10) - 1
    if (st.b[i]) return tttView(st, `⚠️ Square ${a} is taken. Pick another.`)
    st.b[i] = 'X'
    let w = tttWinner(st.b)
    if (w === 'X') { endSession(from, sender, 'ttt'); return tttView(st, '🎉 You win!') }
    if (w === 'draw') { endSession(from, sender, 'ttt'); return tttView(st, '🤝 It\'s a draw.') }
    const m = tttBotMove(st.b, st.mode)
    st.b[m] = 'O'
    w = tttWinner(st.b)
    if (w === 'O') { endSession(from, sender, 'ttt'); return tttView(st, '🤖 Bot wins this time!') }
    if (w === 'draw') { endSession(from, sender, 'ttt'); return tttView(st, '🤝 It\'s a draw.') }
    return tttView(st, `🤖 Bot took ${m + 1}. Your move: ${p}ttt <1-9>`)
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. CONNECT 4  (you 🔴 vs bot 🟡)
// ═════════════════════════════════════════════════════════════════════════════
const C4_R = 6, C4_C = 7
const c4New = () => Array.from({ length: C4_R }, () => Array(C4_C).fill(null))
function c4Drop(g, col, who) {
    for (let r = C4_R - 1; r >= 0; r--) if (!g[r][col]) { g[r][col] = who; return r }
    return -1
}
function c4Undo(g, col) { for (let r = 0; r < C4_R; r++) if (g[r][col]) { g[r][col] = null; return } }
const C4_DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]]
function c4Win(g, who) {
    for (let r = 0; r < C4_R; r++) for (let c = 0; c < C4_C; c++) {
        if (g[r][c] !== who) continue
        for (const [dr, dc] of C4_DIRS) {
            let k = 1
            while (k < 4) {
                const rr = r + dr * k, cc = c + dc * k
                if (rr < 0 || rr >= C4_R || cc < 0 || cc >= C4_C || g[rr][cc] !== who) break
                k++
            }
            if (k === 4) return true
        }
    }
    return false
}
const c4Full = g => g[0].every(Boolean)
function c4Score(g) {
    let s = 0
    for (let r = 0; r < C4_R; r++) if (g[r][3] === 'B') s += 3
    for (let r = 0; r < C4_R; r++) for (let c = 0; c < C4_C; c++) for (const [dr, dc] of C4_DIRS) {
        const er = r + dr * 3, ec = c + dc * 3
        if (er < 0 || er >= C4_R || ec < 0 || ec >= C4_C) continue
        let b = 0, pl = 0, e = 0
        for (let k = 0; k < 4; k++) {
            const v = g[r + dr * k][c + dc * k]
            if (v === 'B') b++; else if (v === 'P') pl++; else e++
        }
        if (b && pl) continue
        if (b === 3 && e === 1) s += 5
        else if (b === 2 && e === 2) s += 2
        else if (pl === 3 && e === 1) s -= 6
        else if (pl === 2 && e === 2) s -= 1
    }
    return s
}
const C4_ORDER = [3, 2, 4, 1, 5, 0, 6]
function c4Minimax(g, depth, alpha, beta, botTurn) {
    if (c4Win(g, 'B')) return 1e6 + depth
    if (c4Win(g, 'P')) return -1e6 - depth
    if (c4Full(g)) return 0
    if (depth === 0) return c4Score(g)
    const cols = C4_ORDER.filter(c => !g[0][c])
    if (botTurn) {
        let best = -Infinity
        for (const c of cols) {
            c4Drop(g, c, 'B'); const s = c4Minimax(g, depth - 1, alpha, beta, false); c4Undo(g, c)
            if (s > best) best = s
            if (best > alpha) alpha = best
            if (alpha >= beta) break
        }
        return best
    }
    let best = Infinity
    for (const c of cols) {
        c4Drop(g, c, 'P'); const s = c4Minimax(g, depth - 1, alpha, beta, true); c4Undo(g, c)
        if (s < best) best = s
        if (best < beta) beta = best
        if (alpha >= beta) break
    }
    return best
}
function c4BotMove(g) {
    const cols = C4_ORDER.filter(c => !g[0][c])
    for (const c of cols) { c4Drop(g, c, 'B'); const w = c4Win(g, 'B'); c4Undo(g, c); if (w) return c }
    for (const c of cols) { c4Drop(g, c, 'P'); const w = c4Win(g, 'P'); c4Undo(g, c); if (w) return c }
    let best = -Infinity, bestCols = []
    for (const c of cols) {
        c4Drop(g, c, 'B'); const s = c4Minimax(g, 4, -Infinity, Infinity, false); c4Undo(g, c)
        if (s > best) { best = s; bestCols = [c] } else if (s === best) bestCols.push(c)
    }
    return pick(bestCols)
}
function c4View(g, status) {
    const rows = g.map(r => r.map(v => v === 'P' ? '🔴' : v === 'B' ? '🟡' : '⚪').join('')).join('\n')
    return `*🔴🟡 CONNECT 4*\n\n${NUM.slice(1, 8).join('')}\n${rows}\n\n${status}`
}
function gameC4({ from, sender, args }) {
    const p = P(), a = args[0]
    if (isStop(a)) return endSession(from, sender, 'c4') ? '🛑 Connect 4 ended.' : `No Connect 4 game running. Type ${p}c4 to start.`
    if (a === 'start' || a === 'new' || (!a && !getSession(from, sender, 'c4'))) {
        const s = newSession(from, sender, 'c4', { g: c4New() })
        return c4View(s.state.g, `You are 🔴 — drop a disc: ${p}c4 <1-7>`)
    }
    const s = getSession(from, sender, 'c4')
    if (!s) return `No Connect 4 game running. Type ${p}c4 to start.`
    const g = s.state.g
    if (!a) return c4View(g, `Your move: ${p}c4 <1-7>`)
    if (!/^[1-7]$/.test(a)) return c4View(g, `Pick a column 1-7: ${p}c4 <1-7>  (${p}c4 stop to quit)`)
    const col = parseInt(a, 10) - 1
    if (g[0][col]) return c4View(g, `⚠️ Column ${a} is full. Pick another.`)
    c4Drop(g, col, 'P')
    if (c4Win(g, 'P')) { endSession(from, sender, 'c4'); return c4View(g, '🎉 Four in a row — you win!') }
    if (c4Full(g)) { endSession(from, sender, 'c4'); return c4View(g, '🤝 Board full — it\'s a draw.') }
    const m = c4BotMove(g)
    c4Drop(g, m, 'B')
    if (c4Win(g, 'B')) { endSession(from, sender, 'c4'); return c4View(g, '🤖 Bot connected four — it wins!') }
    if (c4Full(g)) { endSession(from, sender, 'c4'); return c4View(g, '🤝 Board full — it\'s a draw.') }
    return c4View(g, `🤖 Bot played column ${m + 1}. Your move: ${p}c4 <1-7>`)
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. HANGMAN
// ═════════════════════════════════════════════════════════════════════════════
const HM_WORDS = {
    Animal: ['elephant', 'giraffe', 'penguin', 'dolphin', 'cheetah', 'kangaroo', 'crocodile', 'butterfly', 'hippopotamus', 'chimpanzee', 'leopard', 'flamingo', 'buffalo', 'ostrich', 'zebra', 'squirrel'],
    Country: ['kenya', 'nigeria', 'ghana', 'egypt', 'brazil', 'canada', 'germany', 'japan', 'india', 'mexico', 'tanzania', 'uganda', 'ethiopia', 'zambia', 'rwanda', 'morocco', 'argentina', 'portugal'],
    Fruit: ['banana', 'mango', 'pineapple', 'watermelon', 'strawberry', 'papaya', 'avocado', 'coconut', 'orange', 'guava', 'cherry', 'pomegranate', 'blueberry'],
    Tech: ['keyboard', 'internet', 'software', 'database', 'network', 'browser', 'server', 'password', 'android', 'computer', 'battery', 'algorithm', 'bluetooth', 'keyboard'],
    Thing: ['umbrella', 'football', 'mountain', 'birthday', 'guitar', 'bicycle', 'sunshine', 'treasure', 'lantern', 'library', 'volcano', 'harmony', 'journey', 'blanket'],
}
const HM_STAGES = [
    [' +---+', ' |   |', '     |', '     |', '     |', '     |', '======='],
    [' +---+', ' |   |', ' O   |', '     |', '     |', '     |', '======='],
    [' +---+', ' |   |', ' O   |', ' |   |', '     |', '     |', '======='],
    [' +---+', ' |   |', ' O   |', '/|   |', '     |', '     |', '======='],
    [' +---+', ' |   |', ' O   |', '/|\\  |', '     |', '     |', '======='],
    [' +---+', ' |   |', ' O   |', '/|\\  |', '/    |', '     |', '======='],
    [' +---+', ' |   |', ' O   |', '/|\\  |', '/ \\  |', '     |', '======='],
]
function hmView(st, status) {
    const masked = st.word.split('').map(ch => st.guessed.includes(ch) ? ch : '_').join(' ')
    const wrong = st.wrong.length ? st.wrong.join(' ') : '—'
    return `*🔤 HANGMAN* — ${st.cat}\n${FENCE}\n${HM_STAGES[Math.min(st.wrong.length, 6)].join('\n')}\n${FENCE}\n*${masked}*\n\nWrong: ${wrong}\nLives: ${'❤️'.repeat(Math.max(0, 6 - st.wrong.length))}${'🖤'.repeat(Math.min(6, st.wrong.length))}\n\n${status}`
}
function gameHangman({ from, sender, args }) {
    const p = P(), a = args[0]
    if (isStop(a)) {
        const s = getSession(from, sender, 'hm')
        endSession(from, sender, 'hm')
        return s ? `🛑 Hangman ended. The word was *${s.state.word}*.` : `No Hangman game running. Type ${p}hm to start.`
    }
    if (a === 'start' || a === 'new' || (!a && !getSession(from, sender, 'hm'))) {
        const cat = pick(Object.keys(HM_WORDS))
        const word = pick(HM_WORDS[cat])
        const s = newSession(from, sender, 'hm', { word, cat, guessed: [], wrong: [] })
        return hmView(s.state, `Guess a letter: ${p}hm <letter>  (or the whole word: ${p}hm <word>)`)
    }
    const s = getSession(from, sender, 'hm')
    if (!s) return `No Hangman game running. Type ${p}hm to start.`
    const st = s.state
    if (!a) return hmView(st, `Guess a letter: ${p}hm <letter>`)
    if (!/^[a-z]+$/.test(a)) return hmView(st, `Letters only, please: ${p}hm <letter>`)
    if (a.length === 1) {
        if (st.guessed.includes(a) || st.wrong.includes(a)) return hmView(st, `⚠️ You already tried "${a}".`)
        if (st.word.includes(a)) {
            st.guessed.push(a)
            if (st.word.split('').every(ch => st.guessed.includes(ch))) { endSession(from, sender, 'hm'); return hmView(st, `🎉 You got it! The word is *${st.word}*.`) }
            return hmView(st, `✅ Yes, there's an "${a}".`)
        }
        st.wrong.push(a)
    } else {
        if (a === st.word) { st.guessed = st.word.split(''); endSession(from, sender, 'hm'); return hmView(st, `🎉 Correct! The word is *${st.word}*.`) }
        st.wrong.push(a.length > 8 ? a.slice(0, 8) + '…' : a)
    }
    if (st.wrong.length >= 6) { endSession(from, sender, 'hm'); st.guessed = st.word.split(''); return hmView(st, `💀 Game over. The word was *${st.word}*.`) }
    return hmView(st, `❌ No "${a}". ${6 - st.wrong.length} lives left.`)
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. NUMBER GUESS  (1-100, 7 tries)
// ═════════════════════════════════════════════════════════════════════════════
function gameGuess({ from, sender, args }) {
    const p = P(), a = args[0]
    if (isStop(a)) {
        const s = getSession(from, sender, 'guess')
        endSession(from, sender, 'guess')
        return s ? `🛑 Game ended. The number was *${s.state.n}*.` : `No guessing game running. Type ${p}guess to start.`
    }
    if (a === 'start' || a === 'new' || (!a && !getSession(from, sender, 'guess'))) {
        newSession(from, sender, 'guess', { n: 1 + ri(100), tries: 7 })
        return `*🔢 GUESS THE NUMBER*\n\nI'm thinking of a number from 1 to 100.\nYou have 7 tries: ${p}guess <number>`
    }
    const s = getSession(from, sender, 'guess')
    if (!s) return `No guessing game running. Type ${p}guess to start.`
    const st = s.state
    if (!a) return `*🔢 GUESS THE NUMBER*\n\nTries left: ${st.tries}\nSend ${p}guess <number>`
    if (!/^\d{1,3}$/.test(a) || +a < 1 || +a > 100) return `Send a whole number from 1 to 100: ${p}guess <number>`
    const g = parseInt(a, 10)
    st.tries--
    if (g === st.n) {
        const used = 7 - st.tries
        endSession(from, sender, 'guess')
        return `🎉 *${g}* is right! You needed ${used} ${used === 1 ? 'try' : 'tries'}.`
    }
    if (st.tries <= 0) { endSession(from, sender, 'guess'); return `💀 Out of tries! The number was *${st.n}*.` }
    return `${g < st.n ? '📈 Higher' : '📉 Lower'} than ${g}.\nTries left: ${st.tries}`
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. MEMORY  (4x4, find the pairs)
// ═════════════════════════════════════════════════════════════════════════════
const MEM_EMOJI = ['🐶', '🐱', '🦊', '🐼', '🐸', '🦁', '🐵', '🐙', '🍎', '🍕', '⚽', '🚗', '🎸', '🌵']
function memView(st, status, show = []) {
    const lines = []
    for (let r = 0; r < 4; r++) {
        let row = ''
        for (let c = 0; c < 4; c++) {
            const i = r * 4 + c
            row += (st.matched[i] || i === st.first || show.includes(i)) ? st.cards[i] : '🟦'
        }
        lines.push(rowLabel(r) + row)
    }
    return `*🧠 MEMORY* — moves: ${st.moves}\n\n${colHeader(4)}\n${lines.join('\n')}\n\n${status}`
}
function gameMemory({ from, sender, args }) {
    const p = P(), a = args[0]
    if (isStop(a)) return endSession(from, sender, 'memory') ? '🛑 Memory game ended.' : `No Memory game running. Type ${p}memory to start.`
    if (a === 'start' || a === 'new' || (!a && !getSession(from, sender, 'memory'))) {
        const set = shuffle(MEM_EMOJI).slice(0, 8)
        const s = newSession(from, sender, 'memory', { cards: shuffle([...set, ...set]), matched: Array(16).fill(false), first: null, moves: 0 })
        return memView(s.state, `Flip a card: ${p}memory a1   (rows A-D, columns 1-4)`)
    }
    const s = getSession(from, sender, 'memory')
    if (!s) return `No Memory game running. Type ${p}memory to start.`
    const st = s.state
    if (!a) return memView(st, `Flip a card: ${p}memory a1`)
    const cell = parseCell(args, 4, 4)
    if (!cell) return memView(st, `Pick a card like a1, b3, d4: ${p}memory <row><col>`)
    const i = cell.idx
    if (st.matched[i]) return memView(st, '⚠️ That pair is already found.')
    if (st.first === i) return memView(st, '⚠️ That\'s the card you just flipped. Pick a different one.')
    if (st.first === null) {
        st.first = i
        return memView(st, `Now flip a second card: ${p}memory <cell>`)
    }
    st.moves++
    const j = st.first
    st.first = null
    if (st.cards[i] === st.cards[j]) {
        st.matched[i] = st.matched[j] = true
        if (st.matched.every(Boolean)) { endSession(from, sender, 'memory'); return memView(st, `🎉 All pairs found in ${st.moves} moves!`) }
        return memView(st, '✅ A match! Flip another card.')
    }
    return memView(st, '❌ No match — remember them and try again.', [i, j])
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. MINESWEEPER  (6x6, 6 mines)
// ═════════════════════════════════════════════════════════════════════════════
const MS_N = 6, MS_MINES = 6
function msCount(st, r, c) {
    let n = 0
    for (const [rr, cc] of neighbors8(r, c, MS_N, MS_N)) if (st.mines[rr * MS_N + cc]) n++
    return n
}
function msPlace(st, safeIdx) {
    const sr = Math.floor(safeIdx / MS_N), sc = safeIdx % MS_N
    const banned = new Set([safeIdx, ...neighbors8(sr, sc, MS_N, MS_N).map(([r, c]) => r * MS_N + c)])
    const pool = []
    for (let i = 0; i < MS_N * MS_N; i++) if (!banned.has(i)) pool.push(i)
    st.mines = Array(MS_N * MS_N).fill(false)
    for (const i of shuffle(pool).slice(0, MS_MINES)) st.mines[i] = true
}
function msFlood(st, r0, c0) {
    const stack = [[r0, c0]]
    while (stack.length) {
        const [r, c] = stack.pop()
        const i = r * MS_N + c
        if (st.revealed[i] || st.flags[i]) continue
        st.revealed[i] = true
        if (msCount(st, r, c) === 0) for (const [rr, cc] of neighbors8(r, c, MS_N, MS_N)) if (!st.revealed[rr * MS_N + cc]) stack.push([rr, cc])
    }
}
function msView(st, status, hit = -1) {
    const lines = []
    for (let r = 0; r < MS_N; r++) {
        let row = ''
        for (let c = 0; c < MS_N; c++) {
            const i = r * MS_N + c
            if (st.over && st.mines && st.mines[i]) row += (i === hit ? '💥' : '💣')
            else if (st.revealed[i]) { const n = msCount(st, r, c); row += n === 0 ? '⬜' : NUM[n] }
            else if (st.flags[i]) row += '🚩'
            else row += '🟦'
        }
        lines.push(rowLabel(r) + row)
    }
    const flags = st.flags.filter(Boolean).length
    return `*💣 MINESWEEPER* — ${MS_MINES} mines, 🚩 ${flags}\n\n${colHeader(MS_N)}\n${lines.join('\n')}\n\n${status}`
}
function gameMines({ from, sender, args }) {
    const p = P(), a = args[0]
    if (isStop(a)) return endSession(from, sender, 'mines') ? '🛑 Minesweeper ended.' : `No Minesweeper game running. Type ${p}mines to start.`
    if (a === 'start' || a === 'new' || (!a && !getSession(from, sender, 'mines'))) {
        const s = newSession(from, sender, 'mines', { mines: null, revealed: Array(MS_N * MS_N).fill(false), flags: Array(MS_N * MS_N).fill(false), over: false })
        return msView(s.state, `Dig: ${p}mines a1   Flag: ${p}mines flag a1\n(your first dig is always safe)`)
    }
    const s = getSession(from, sender, 'mines')
    if (!s) return `No Minesweeper game running. Type ${p}mines to start.`
    const st = s.state
    if (!a) return msView(st, `Dig: ${p}mines a1   Flag: ${p}mines flag a1`)
    const flagging = a === 'flag' || a === 'f' || a === 'unflag'
    const cell = parseCell(flagging ? args.slice(1) : args, MS_N, MS_N)
    if (!cell) return msView(st, `Pick a square like a1 or f6.\nDig: ${p}mines a1   Flag: ${p}mines flag a1`)
    const i = cell.idx
    if (flagging) {
        if (st.revealed[i]) return msView(st, '⚠️ That square is already open.')
        st.flags[i] = !st.flags[i]
        return msView(st, st.flags[i] ? '🚩 Flag placed.' : 'Flag removed.')
    }
    if (st.revealed[i]) return msView(st, '⚠️ That square is already open.')
    if (st.flags[i]) return msView(st, '⚠️ That square is flagged. Remove the flag first.')
    if (!st.mines) msPlace(st, i)
    if (st.mines[i]) { st.over = true; endSession(from, sender, 'mines'); return msView(st, '💥 Boom! You hit a mine.', i) }
    msFlood(st, cell.r, cell.c)
    const safeLeft = st.revealed.filter(v => !v).length - MS_MINES
    if (safeLeft <= 0) { st.over = true; endSession(from, sender, 'mines'); return msView(st, '🎉 Cleared the field — you win!') }
    return msView(st, `Safe. ${safeLeft} safe squares to go.`)
}

// ═════════════════════════════════════════════════════════════════════════════
// 7. 2048
// ═════════════════════════════════════════════════════════════════════════════
function slideRow(row) {
    const t = row.filter(Boolean)
    const out = []
    let gained = 0
    for (let i = 0; i < t.length; i++) {
        if (i + 1 < t.length && t[i] === t[i + 1]) { out.push(t[i] * 2); gained += t[i] * 2; i++ }
        else out.push(t[i])
    }
    while (out.length < row.length) out.push(0)
    return { row: out, gained }
}
const G_LINES = {            // index lists, each read in the direction tiles slide TOWARD
    left:  [0, 1, 2, 3].map(r => [0, 1, 2, 3].map(c => r * 4 + c)),
    right: [0, 1, 2, 3].map(r => [3, 2, 1, 0].map(c => r * 4 + c)),
    up:    [0, 1, 2, 3].map(c => [0, 1, 2, 3].map(r => r * 4 + c)),
    down:  [0, 1, 2, 3].map(c => [3, 2, 1, 0].map(r => r * 4 + c)),
}
function g2048Move(b, dir) {
    const nb = b.slice()
    let gained = 0
    for (const line of G_LINES[dir]) {
        const res = slideRow(line.map(i => b[i]))
        gained += res.gained
        line.forEach((idx, k) => { nb[idx] = res.row[k] })
    }
    return { board: nb, gained, changed: nb.some((v, i) => v !== b[i]) }
}
const g2048CanMove = b => ['left', 'right', 'up', 'down'].some(d => g2048Move(b, d).changed)
function g2048Spawn(b) {
    const empty = []
    b.forEach((v, i) => { if (!v) empty.push(i) })
    if (!empty.length) return
    b[pick(empty)] = rng() < 0.9 ? 2 : 4
}
function g2048View(st, status) {
    const cell = v => (v ? String(v) : '·').padStart(5, ' ')
    const sep = (l, m, r) => l + Array(4).fill('─────').join(m) + r
    const rows = [0, 1, 2, 3].map(r => '│' + [0, 1, 2, 3].map(c => cell(st.b[r * 4 + c])).join('│') + '│')
    const grid = [sep('┌', '┬', '┐'), rows[0], sep('├', '┼', '┤'), rows[1], sep('├', '┼', '┤'), rows[2], sep('├', '┼', '┤'), rows[3], sep('└', '┴', '┘')].join('\n')
    return `*🔢 2048* — score: ${st.score}\n${FENCE}\n${grid}\n${FENCE}\n${status}`
}
const G_DIR = { w: 'up', up: 'up', a: 'left', left: 'left', s: 'down', down: 'down', d: 'right', right: 'right' }
function game2048({ from, sender, args }) {
    const p = P(), a = args[0]
    if (isStop(a)) {
        const s = getSession(from, sender, '2048')
        endSession(from, sender, '2048')
        return s ? `🛑 2048 ended. Final score: ${s.state.score}.` : `No 2048 game running. Type ${p}2048 to start.`
    }
    if (a === 'start' || a === 'new' || (!a && !getSession(from, sender, '2048'))) {
        const b = Array(16).fill(0)
        g2048Spawn(b); g2048Spawn(b)
        const s = newSession(from, sender, '2048', { b, score: 0, won: false })
        return g2048View(s.state, `Move: ${p}2048 w (up) · a (left) · s (down) · d (right)`)
    }
    const s = getSession(from, sender, '2048')
    if (!s) return `No 2048 game running. Type ${p}2048 to start.`
    const st = s.state
    if (!a) return g2048View(st, `Move: ${p}2048 w / a / s / d`)
    const dir = G_DIR[a]
    if (!dir) return g2048View(st, `Use w (up), a (left), s (down) or d (right): ${p}2048 <w/a/s/d>`)
    const res = g2048Move(st.b, dir)
    if (!res.changed) return g2048View(st, `⚠️ Nothing moves ${dir}. Try another direction.`)
    st.b = res.board
    st.score += res.gained
    g2048Spawn(st.b)
    if (!st.won && st.b.some(v => v >= 2048)) {
        st.won = true
        return g2048View(st, `🏆 You made 2048! Keep going or ${p}2048 stop.`)
    }
    if (!g2048CanMove(st.b)) { endSession(from, sender, '2048'); return g2048View(st, `💀 No moves left. Final score: ${st.score}.`) }
    return g2048View(st, `Move: ${p}2048 w / a / s / d`)
}

// ═════════════════════════════════════════════════════════════════════════════
// 8. SLOTS  (virtual coins, no real money)
// ═════════════════════════════════════════════════════════════════════════════
const SLOT_SYMBOLS = [['🍒', 30, 5], ['🍋', 25, 8], ['🍉', 20, 12], ['🍇', 12, 20], ['⭐', 8, 40], ['💎', 4, 80], ['7️⃣', 1, 200]]
const slotCoins = new Map()
function slotSpin() {
    const total = SLOT_SYMBOLS.reduce((n, s) => n + s[1], 0)
    let x = rng() * total
    for (const s of SLOT_SYMBOLS) { if (x < s[1]) return s; x -= s[1] }
    return SLOT_SYMBOLS[0]
}
function slotPayout(reels, bet) {
    const [a, b, c] = reels.map(r => r[0])
    if (a === b && b === c) return { mult: reels[0][2], label: `JACKPOT ×${reels[0][2]}` }
    if (a === b || b === c || a === c) return { mult: 1, label: 'two of a kind — bet returned' }
    return { mult: 0, label: 'no match' }
}
function gameSlots({ sender, args }) {
    const p = P(), a = args[0]
    let coins = slotCoins.has(sender) ? slotCoins.get(sender) : 100
    if (a === 'balance' || a === 'coins' || a === 'bal') return `🪙 You have *${coins}* coins.\nSpin: ${p}slots <bet>`
    let bet = 10
    if (a) {
        if (!/^\d{1,4}$/.test(a) || +a < 1) return `Bet a whole number of coins: ${p}slots <bet>   (default 10)`
        bet = parseInt(a, 10)
    }
    let refill = ''
    if (coins <= 0) { coins = 100; refill = '🎁 You were out of coins — here are 100 free ones.\n\n' }
    if (bet > coins) return `${refill}⚠️ You only have ${coins} coins. Try ${p}slots ${Math.min(coins, 10)}.`
    const reels = [slotSpin(), slotSpin(), slotSpin()]
    const pay = slotPayout(reels, bet)
    coins = coins - bet + bet * pay.mult
    slotCoins.set(sender, coins)
    const net = bet * pay.mult - bet
    const result = pay.mult === 0 ? `😢 ${pay.label} — you lost ${bet}.`
        : pay.mult === 1 ? `😐 ${pay.label}.`
        : `🎉 ${pay.label}! You won ${net}.`
    return `${refill}*🎰 SLOTS*\n\n┃ ${reels.map(r => r[0]).join(' ┃ ')} ┃\n\n${result}\n🪙 Coins: *${coins}*`
}

// ═════════════════════════════════════════════════════════════════════════════
// 9. ROCK PAPER SCISSORS
// ═════════════════════════════════════════════════════════════════════════════
const rpsScore = new Map()
const RPS_MAP = { rock: 'rock', r: 'rock', '🪨': 'rock', paper: 'paper', p: 'paper', '📄': 'paper', scissors: 'scissors', scissor: 'scissors', s: 'scissors', '✂️': 'scissors', '✂': 'scissors' }
const RPS_ICON = { rock: '🪨', paper: '📄', scissors: '✂️' }
const RPS_BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' }
function gameRps({ sender, args }) {
    const p = P(), a = args[0]
    const sc = rpsScore.get(sender) || { w: 0, l: 0, d: 0 }
    if (a === 'score' || a === 'stats') return `*✊ RPS SCORE*\nWins: ${sc.w}  Losses: ${sc.l}  Draws: ${sc.d}`
    if (a === 'reset') { rpsScore.delete(sender); return 'Score reset.' }
    const me = RPS_MAP[a]
    if (!me) return `*✊ ROCK PAPER SCISSORS*\n\nPlay: ${p}rps rock | paper | scissors\n(or r / p / s)  ·  ${p}rps score`
    const bot = pick(['rock', 'paper', 'scissors'])
    let res
    if (me === bot) { sc.d++; res = '🤝 Draw!' }
    else if (RPS_BEATS[me] === bot) { sc.w++; res = '🎉 You win!' }
    else { sc.l++; res = '🤖 Bot wins!' }
    rpsScore.set(sender, sc)
    return `*✊ ROCK PAPER SCISSORS*\n\nYou: ${RPS_ICON[me]}   Bot: ${RPS_ICON[bot]}\n${res}\n\nWins ${sc.w} · Losses ${sc.l} · Draws ${sc.d}`
}

// ═════════════════════════════════════════════════════════════════════════════
// 10. QUIZ
// ═════════════════════════════════════════════════════════════════════════════
const QUIZ = [
    ['What is the capital of Kenya?', 'Nairobi', 'Mombasa', 'Kisumu', 'Nakuru'],
    ['Which is the largest planet in our solar system?', 'Jupiter', 'Saturn', 'Neptune', 'Earth'],
    ['What is the chemical formula of water?', 'H2O', 'CO2', 'O2', 'NaCl'],
    ['Who wrote "Romeo and Juliet"?', 'William Shakespeare', 'Charles Dickens', 'Mark Twain', 'Jane Austen'],
    ['Which is the largest ocean on Earth?', 'Pacific Ocean', 'Atlantic Ocean', 'Indian Ocean', 'Arctic Ocean'],
    ['How many days are in a leap year?', '366', '365', '364', '367'],
    ['Which is the fastest land animal?', 'Cheetah', 'Lion', 'Horse', 'Leopard'],
    ['What is the capital of Egypt?', 'Cairo', 'Alexandria', 'Giza', 'Luxor'],
    ['Which planet is known as the Red Planet?', 'Mars', 'Venus', 'Mercury', 'Saturn'],
    ['What is the hardest natural substance?', 'Diamond', 'Gold', 'Iron', 'Quartz'],
    ['Which is the longest river in Africa?', 'The Nile', 'The Congo', 'The Niger', 'The Zambezi'],
    ['Who painted the Mona Lisa?', 'Leonardo da Vinci', 'Michelangelo', 'Raphael', 'Pablo Picasso'],
    ['How many players does one football (soccer) team have on the pitch?', '11', '10', '9', '12'],
    ['What is the currency of Japan?', 'Yen', 'Won', 'Yuan', 'Dollar'],
    ['Which gas do plants take in from the air?', 'Carbon dioxide', 'Oxygen', 'Nitrogen', 'Hydrogen'],
    ['What is the capital of France?', 'Paris', 'Lyon', 'Marseille', 'Nice'],
    ['What is the square root of 144?', '12', '14', '11', '13'],
    ['Which is the largest mammal?', 'Blue whale', 'African elephant', 'Giraffe', 'Hippopotamus'],
    ['How many sides does a hexagon have?', '6', '5', '7', '8'],
    ['Mount Kilimanjaro is in which country?', 'Tanzania', 'Kenya', 'Uganda', 'Ethiopia'],
    ['What is the smallest prime number?', '2', '0', '1', '3'],
    ['What is the capital of Nigeria?', 'Abuja', 'Lagos', 'Kano', 'Ibadan'],
    ['What is the chemical symbol "H" for?', 'Hydrogen', 'Helium', 'Holmium', 'Mercury'],
    ['Which language has the most native speakers?', 'Mandarin Chinese', 'English', 'Spanish', 'Hindi'],
    ['Who was the first President of the United States?', 'George Washington', 'Abraham Lincoln', 'Thomas Jefferson', 'John Adams'],
    ['How many strings does a standard guitar have?', '6', '4', '5', '7'],
    ['In which country are the Great Pyramids of Giza?', 'Egypt', 'Mexico', 'Sudan', 'Iraq'],
    ['Which animal is called the "King of the Jungle"?', 'Lion', 'Tiger', 'Elephant', 'Leopard'],
    ['Which of these do bees produce?', 'Honey', 'Milk', 'Silk', 'Sap'],
    ['How many minutes are in 2 hours?', '120', '100', '150', '90'],
    ['Which is the largest country in the world by area?', 'Russia', 'Canada', 'China', 'United States'],
    ['Which organ pumps blood around the body?', 'Heart', 'Liver', 'Lung', 'Kidney'],
    ['Who is famous for the theory of gravity and the falling apple story?', 'Isaac Newton', 'Albert Einstein', 'Galileo Galilei', 'Nikola Tesla'],
    ['What is 7 × 8?', '56', '54', '58', '64'],
    ['Which planet is famous for its bright rings?', 'Saturn', 'Mars', 'Venus', 'Mercury'],
    ['In which year did humans first land on the Moon?', '1969', '1959', '1972', '1965'],
    ['What does HTML stand for?', 'HyperText Markup Language', 'HighText Machine Language', 'Hyper Transfer Markup Language', 'HyperText Making Language'],
    ['Who was the first President of Kenya?', 'Jomo Kenyatta', 'Daniel arap Moi', 'Tom Mboya', 'Raila Odinga'],
    ['What is the capital of Uganda?', 'Kampala', 'Entebbe', 'Jinja', 'Gulu'],
    ['What is the official capital of Tanzania?', 'Dodoma', 'Dar es Salaam', 'Arusha', 'Mwanza'],
    ['Which is the largest lake in Africa?', 'Lake Victoria', 'Lake Tanganyika', 'Lake Malawi', 'Lake Turkana'],
    ['Which country won the first FIFA World Cup in 1930?', 'Uruguay', 'Brazil', 'Argentina', 'Italy'],
    ['How many colours are in a rainbow?', '7', '5', '6', '8'],
    ['Which metal is liquid at room temperature?', 'Mercury', 'Iron', 'Lead', 'Aluminium'],
    ['Which is the largest hot desert in the world?', 'Sahara', 'Gobi', 'Kalahari', 'Arabian Desert'],
    ['Which vitamin does your skin make from sunlight?', 'Vitamin D', 'Vitamin A', 'Vitamin C', 'Vitamin K'],
    ['Which is the longest bone in the human body?', 'Femur', 'Tibia', 'Humerus', 'Radius'],
    ['What is the capital of Ghana?', 'Accra', 'Kumasi', 'Tamale', 'Takoradi'],
    ['How many squares are on a chess board?', '64', '32', '81', '100'],
    ['Who wrote the novel "Things Fall Apart"?', 'Chinua Achebe', 'Wole Soyinka', 'Ngũgĩ wa Thiong\'o', 'Chimamanda Ngozi Adichie'],
    ['Which sport is played with a shuttlecock?', 'Badminton', 'Tennis', 'Squash', 'Golf'],
]
const LETTERS = ['A', 'B', 'C', 'D']
function quizAsk(st) {
    if (st.pool.length === 0) st.pool = shuffle(QUIZ.map((_, i) => i))
    const qi = st.pool.pop()
    const [q, right, ...wrong] = QUIZ[qi]
    const opts = shuffle([right, ...wrong])
    st.current = { q, opts, correct: opts.indexOf(right) }
    return quizView(st)
}
function quizView(st) {
    const c = st.current
    return `*❓ QUIZ* — score ${st.score}/${st.asked}\n\n${c.q}\n\n${c.opts.map((o, i) => `*${LETTERS[i]}.* ${o}`).join('\n')}\n\nAnswer: ${P()}ans a / b / c / d`
}
function gameQuiz({ cmd, from, sender, args }) {
    const p = P(), a = args[0]
    const isAns = cmd === 'ans' || cmd === 'answer'
    let s = getSession(from, sender, 'quiz')
    if (isStop(a)) {
        endSession(from, sender, 'quiz')
        return s ? `🛑 Quiz over. Final score: *${s.state.score}/${s.state.asked}*.` : `No quiz running. Type ${p}quiz to start.`
    }
    if (isAns || (a && /^[a-d]$/.test(a) && s && s.state.current)) {
        if (!s || !s.state.current) return `No question waiting. Type ${p}quiz to get one.`
        const idx = LETTERS.map(l => l.toLowerCase()).indexOf(a)
        if (idx < 0) return `Answer with a, b, c or d: ${p}ans <letter>`
        const st = s.state, c = st.current
        st.asked++
        let res
        if (idx === c.correct) { st.score++; res = `✅ Correct! *${LETTERS[c.correct]}. ${c.opts[c.correct]}*` }
        else res = `❌ Not quite. The answer was *${LETTERS[c.correct]}. ${c.opts[c.correct]}*`
        st.current = null
        return `${res}\n\nScore: *${st.score}/${st.asked}*\nNext question: ${p}quiz`
    }
    if (!s) s = newSession(from, sender, 'quiz', { score: 0, asked: 0, pool: shuffle(QUIZ.map((_, i) => i)), current: null })
    if (s.state.current) return quizView(s.state)
    return quizAsk(s.state)
}

// ═════════════════════════════════════════════════════════════════════════════
// 11. LIGHTS OUT  (5x5, turn every light off)
// ═════════════════════════════════════════════════════════════════════════════
const LO_N = 5
function loPress(b, r, c) {
    for (const [rr, cc] of [[r, c], [r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]) {
        if (rr >= 0 && rr < LO_N && cc >= 0 && cc < LO_N) b[rr * LO_N + cc] = !b[rr * LO_N + cc]
    }
}
function loNew() {
    const b = Array(LO_N * LO_N).fill(false)
    do {
        for (let k = 0; k < 8 + ri(5); k++) { const i = ri(LO_N * LO_N); loPress(b, Math.floor(i / LO_N), i % LO_N) }
    } while (!b.some(Boolean))
    return b
}
function loView(st, status) {
    const lines = []
    for (let r = 0; r < LO_N; r++) lines.push(rowLabel(r) + st.b.slice(r * LO_N, r * LO_N + LO_N).map(v => v ? '🟨' : '⬛').join(''))
    return `*💡 LIGHTS OUT* — moves: ${st.moves}\n\n${colHeader(LO_N)}\n${lines.join('\n')}\n\n${status}`
}
function gameLights({ from, sender, args }) {
    const p = P(), a = args[0]
    if (isStop(a)) return endSession(from, sender, 'lights') ? '🛑 Lights Out ended.' : `No Lights Out game running. Type ${p}lights to start.`
    if (a === 'start' || a === 'new' || (!a && !getSession(from, sender, 'lights'))) {
        const s = newSession(from, sender, 'lights', { b: loNew(), moves: 0 })
        return loView(s.state, `Turn every light off 🟨→⬛. Pressing a square flips it and its 4 neighbours.\nPress: ${p}lights a1`)
    }
    const s = getSession(from, sender, 'lights')
    if (!s) return `No Lights Out game running. Type ${p}lights to start.`
    const st = s.state
    if (!a) return loView(st, `Press a square: ${p}lights a1`)
    const cell = parseCell(args, LO_N, LO_N)
    if (!cell) return loView(st, `Pick a square like a1 … e5: ${p}lights <row><col>`)
    loPress(st.b, cell.r, cell.c)
    st.moves++
    if (!st.b.some(Boolean)) { endSession(from, sender, 'lights'); return loView(st, `🎉 All lights off in ${st.moves} moves!`) }
    return loView(st, `Press a square: ${p}lights a1`)
}

// ═════════════════════════════════════════════════════════════════════════════
// 12. SLIDING PUZZLE  (3x3, tiles 1-8)
// ═════════════════════════════════════════════════════════════════════════════
const SL_SOLVED = [1, 2, 3, 4, 5, 6, 7, 8, 0]
function slNeighbors(i) {
    const r = Math.floor(i / 3), c = i % 3, out = []
    if (r > 0) out.push(i - 3)
    if (r < 2) out.push(i + 3)
    if (c > 0) out.push(i - 1)
    if (c < 2) out.push(i + 1)
    return out
}
function slNew() {
    const t = SL_SOLVED.slice()
    let blank = 8, prev = -1
    for (let k = 0; k < 90; k++) {
        const opts = slNeighbors(blank).filter(n => n !== prev)
        const n = pick(opts)
        t[blank] = t[n]; t[n] = 0
        prev = blank; blank = n
    }
    if (t.every((v, i) => v === SL_SOLVED[i])) return slNew()
    return t
}
function slView(st, status) {
    const cell = v => v ? NUM[v] : '⬛'
    const rows = [0, 1, 2].map(r => [0, 1, 2].map(c => cell(st.t[r * 3 + c])).join(''))
    return `*🧩 SLIDING PUZZLE* — moves: ${st.moves}\n\n${rows.join('\n')}\n\n${status}`
}
function gameSlide({ from, sender, args }) {
    const p = P(), a = args[0]
    if (isStop(a)) return endSession(from, sender, 'slide') ? '🛑 Puzzle ended.' : `No puzzle running. Type ${p}slide to start.`
    if (a === 'start' || a === 'new' || (!a && !getSession(from, sender, 'slide'))) {
        const s = newSession(from, sender, 'slide', { t: slNew(), moves: 0 })
        return slView(s.state, `Put the tiles in order 1-8 with ⬛ last.\nSlide a tile next to ⬛: ${p}slide <number>`)
    }
    const s = getSession(from, sender, 'slide')
    if (!s) return `No puzzle running. Type ${p}slide to start.`
    const st = s.state
    if (!a) return slView(st, `Slide a tile: ${p}slide <number>`)
    if (!/^[1-8]$/.test(a)) return slView(st, `Pick a tile number 1-8: ${p}slide <number>`)
    const tile = parseInt(a, 10)
    const ti = st.t.indexOf(tile), bi = st.t.indexOf(0)
    if (!slNeighbors(ti).includes(bi)) return slView(st, `⚠️ Tile ${tile} isn't next to the empty square.`)
    st.t[bi] = tile; st.t[ti] = 0
    st.moves++
    if (st.t.every((v, i) => v === SL_SOLVED[i])) { endSession(from, sender, 'slide'); return slView(st, `🎉 Solved in ${st.moves} moves!`) }
    return slView(st, `Slide a tile: ${p}slide <number>`)
}

// ═════════════════════════════════════════════════════════════════════════════
// .games  — the list
// ═════════════════════════════════════════════════════════════════════════════
function gameList() {
    const p = P()
    return `*🎮 GAMES*\nPlay right here in the chat — every move is a command.\n\n` +
        `❌ ${p}ttt — Tic-Tac-Toe vs bot (${p}ttt hard)\n` +
        `🔴 ${p}c4 — Connect 4 vs bot\n` +
        `🔤 ${p}hm — Hangman\n` +
        `🔢 ${p}guess — Guess the number\n` +
        `🧠 ${p}memory — Memory pairs\n` +
        `💣 ${p}mines — Minesweeper\n` +
        `🔢 ${p}2048 — 2048\n` +
        `🎰 ${p}slots — Slots (virtual coins)\n` +
        `✊ ${p}rps — Rock Paper Scissors\n` +
        `❓ ${p}quiz — Quiz questions\n` +
        `💡 ${p}lights — Lights Out\n` +
        `🧩 ${p}slide — Sliding puzzle\n\n` +
        `Type a game's command to start it. Add "stop" to quit (${p}ttt stop).`
}

// ── routing ──────────────────────────────────────────────────────────────────
const ROUTES = {
    games: ['list', gameList], game: ['list', gameList],
    ttt: ['ttt', gameTtt], tictactoe: ['ttt', gameTtt],
    c4: ['c4', gameC4], connect4: ['c4', gameC4],
    hangman: ['hm', gameHangman], hm: ['hm', gameHangman],
    guess: ['guess', gameGuess],
    memory: ['memory', gameMemory],
    mines: ['mines', gameMines], minesweeper: ['mines', gameMines],
    '2048': ['2048', game2048],
    slots: ['slots', gameSlots], slot: ['slots', gameSlots],
    rps: ['rps', gameRps],
    quiz: ['quiz', gameQuiz], ans: ['quiz', gameQuiz], answer: ['quiz', gameQuiz],
    lights: ['lights', gameLights],
    slide: ['slide', gameSlide],
}
const gameCmds = new Set(Object.keys(ROUTES))

function runGame(cmd, from, sender, args = []) {
    const route = ROUTES[cmd]
    if (!route) return null
    const clean = args.map(a => String(a).toLowerCase())
    return route[1]({ cmd, from, sender, args: clean })
}

async function handleGame(sock, from, cmd, args, msg, sender) {
    const route = ROUTES[cmd]
    if (!route) return
    if (route[0] !== 'list' && tooFast(sender, route[0])) return
    let text
    try { text = runGame(cmd, from, sender, args) }
    catch (e) { console.error('[games]', cmd, e); text = `❌ Game error: ${e.message}` }
    if (text) await sock.sendMessage(from, { text }, { quoted: msg })
}

module.exports = { gameCmds, handleGame, runGame, _setRng, _cfg: cfg, _sessions: sessions, _internals: { slideRow, g2048Move, tttWinner, c4Win, c4New, c4Drop, c4BotMove, tttBotMove, QUIZ, loPress, slNeighbors, SL_SOLVED, SLOT_SYMBOLS, slotCoins, rpsScore } }
