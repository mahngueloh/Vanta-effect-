'use strict'

// Persistent, repository-aware context for MAHNGUELOH's coding AI.
// This is deliberately dependency-free: it builds a searchable source index
// on disk and retrieves only the parts of the codebase relevant to a question.
// The model never needs the entire repository pasted into every prompt.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { listFiles, ROOT, readProjectFile } = require('./codeContext')

const AGENT_DIR = path.join(ROOT, 'data', 'ai-agent')
const INDEX_PATH = path.join(AGENT_DIR, 'index.json')
const MEMORY_PATH = path.join(AGENT_DIR, 'memory.json')

const MAX_INDEXED_FILE_BYTES = 1024 * 1024
const DEFAULT_CONTEXT_CHARS = 36000
const MAX_SNIPPET_CHARS = 7000
const STOP_WORDS = new Set(['the','and','for','with','that','this','from','what','how','does','why','can','you','are','bot','code','file','into','inside','about','please','make','fix','tell','show'])

function ensureDir() {
    fs.mkdirSync(AGENT_DIR, { recursive: true })
}

function safeJsonRead(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function atomicJsonWrite(file, value) {
    ensureDir()
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(tmp, file)
}

function hash(text) {
    return crypto.createHash('sha1').update(text).digest('hex').slice(0, 12)
}

function tokenize(q) {
    return [...new Set((q.toLowerCase().match(/[a-z0-9_.$/-]{2,}/g) || []).filter(t => !STOP_WORDS.has(t)))]
}

function extractSymbols(text) {
    const out = []
    const patterns = [
        /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
        /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
        /(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*\{/g,
        /case\s+['"]([^'"]+)['"]\s*:/g,
    ]
    for (const re of patterns) {
        for (const m of text.matchAll(re)) {
            if (m[1] && !out.includes(m[1])) out.push(m[1])
            if (out.length >= 250) return out
        }
    }
    return out
}

function extractRequires(text) {
    const out = []
    const re = /require\(['"]([^'"]+)['"]\)/g
    for (const m of text.matchAll(re)) {
        if (m[1] && !out.includes(m[1])) out.push(m[1])
    }
    return out.slice(0, 120)
}

function inspectFile(rel) {
    const full = path.join(ROOT, rel)
    const stat = fs.statSync(full)
    const meta = { path: rel, size: stat.size, mtimeMs: stat.mtimeMs, hash: null, symbols: [], requires: [] }
    if (stat.size <= MAX_INDEXED_FILE_BYTES) {
        const text = fs.readFileSync(full, 'utf8')
        meta.hash = hash(text)
        meta.symbols = extractSymbols(text)
        meta.requires = extractRequires(text)
    }
    return meta
}

function buildIndex(force = false) {
    ensureDir()
    const old = safeJsonRead(INDEX_PATH, { version: 1, files: {} })
    const files = {}
    for (const rel of listFiles()) {
        try {
            const full = path.join(ROOT, rel)
            const stat = fs.statSync(full)
            const prev = old.files?.[rel]
            if (!force && prev && prev.mtimeMs === stat.mtimeMs && prev.size === stat.size) files[rel] = prev
            else files[rel] = inspectFile(rel)
        } catch {}
    }
    const index = { version: 1, updatedAt: new Date().toISOString(), fileCount: Object.keys(files).length, files }
    atomicJsonWrite(INDEX_PATH, index)
    return index
}

function loadIndex() {
    const idx = safeJsonRead(INDEX_PATH, null)
    if (!idx || !idx.files) return buildIndex(false)

    // Lightweight freshness check so a changed file is picked up without
    // rebuilding every metadata record from scratch.
    let stale = false
    for (const rel of listFiles()) {
        try {
            const s = fs.statSync(path.join(ROOT, rel))
            const prev = idx.files[rel]
            if (!prev || prev.mtimeMs !== s.mtimeMs || prev.size !== s.size) { stale = true; break }
        } catch {}
    }
    if (!stale && Object.keys(idx.files).length === listFiles().length) return idx
    return buildIndex(false)
}

function readFile(rel, maxChars = 30000) {
    const { content, truncated } = readProjectFile(rel, maxChars)
    return { content, truncated }
}

function scoreFile(meta, terms, question) {
    const hay = `${meta.path} ${meta.symbols.join(' ')} ${meta.requires.join(' ')}`.toLowerCase()
    let score = 0
    for (const t of terms) {
        if (meta.path.toLowerCase().includes(t)) score += 12
        if (hay.includes(t)) score += 3
        if (meta.symbols.some(s => s.toLowerCase() === t)) score += 10
    }
    if (/handler|router|command|switch/.test(question.toLowerCase()) && /handler\.js/.test(meta.path)) score += 10
    if (/ai|model|provider|memory/.test(question.toLowerCase()) && /(ai|agent|codeContext)/i.test(meta.path)) score += 8
    return score
}

function findInText(text, terms) {
    const lines = text.split('\n')
    const hits = []
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].toLowerCase()
        if (terms.some(t => line.includes(t))) hits.push(i)
    }
    const selected = []
    for (const hit of hits.slice(0, 12)) {
        const start = Math.max(0, hit - 3)
        const end = Math.min(lines.length, hit + 6)
        const block = lines.slice(start, end).join('\n')
        if (!selected.some(s => s.start === start && s.end === end)) selected.push({ start, end, text: block })
    }
    return selected
}

function search(question, limit = 10) {
    const idx = loadIndex()
    const terms = tokenize(question)
    return Object.values(idx.files)
        .map(meta => ({ meta, score: scoreFile(meta, terms, question) }))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score || a.meta.path.localeCompare(b.meta.path))
        .slice(0, limit)
}

function buildContext(question, opts = {}) {
    const maxChars = Number(opts.maxChars || DEFAULT_CONTEXT_CHARS)
    const hits = search(question, Number(opts.maxFiles || 10))
    const parts = []
    let used = 0

    const architecture = Object.values(loadIndex().files)
        .map(m => `${m.path}${m.symbols.length ? ` — ${m.symbols.slice(0, 18).join(', ')}` : ''}`)
        .join('\n')
    const archBlock = `PROJECT FILE MAP (${Object.keys(loadIndex().files).length} files)\n${architecture}`
    parts.push(archBlock)
    used += archBlock.length

    for (const hit of hits) {
        if (used >= maxChars) break
        try {
            const full = readFile(hit.meta.path, MAX_SNIPPET_CHARS)
            let body = full.content
            if (!full.truncated) {
                const lines = body.split('\n')
                const focused = findInText(body, tokenize(question))
                if (focused.length) body = focused.map(h => h.text).join('\n...\n')
            }
            const block = `\n--- ${hit.meta.path} (relevance ${hit.score}) ---\n${body}`
            if (used + block.length > maxChars) continue
            parts.push(block)
            used += block.length
        } catch {}
    }

    return {
        context: parts.join('\n'),
        files: hits.map(h => h.meta.path),
        truncated: used >= maxChars,
    }
}

function loadMemory() {
    return safeJsonRead(MEMORY_PATH, { version: 1, updatedAt: null, facts: [] })
}

function remember(fact, source = 'owner') {
    const clean = String(fact || '').trim()
    if (!clean) throw new Error('Memory entry is empty')
    const memory = loadMemory()
    const exists = memory.facts.some(f => f.text.toLowerCase() === clean.toLowerCase())
    if (!exists) memory.facts.push({ id: crypto.randomUUID(), text: clean, source, createdAt: new Date().toISOString() })
    memory.updatedAt = new Date().toISOString()
    atomicJsonWrite(MEMORY_PATH, memory)
    return memory.facts[memory.facts.length - 1]
}

function recall(question = '', limit = 12) {
    const facts = loadMemory().facts || []
    const terms = tokenize(question)
    if (!terms.length) return facts.slice(-limit).reverse()
    return facts
        .map(f => ({ f, score: terms.reduce((n, t) => n + (f.text.toLowerCase().includes(t) ? 1 : 0), 0) }))
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(x => x.f)
}

function status() {
    const idx = loadIndex()
    const memory = loadMemory()
    return {
        files: Object.keys(idx.files).length,
        indexedAt: idx.updatedAt,
        memories: (memory.facts || []).length,
        indexPath: path.relative(ROOT, INDEX_PATH),
        memoryPath: path.relative(ROOT, MEMORY_PATH),
    }
}

module.exports = {
    buildIndex,
    loadIndex,
    search,
    buildContext,
    remember,
    recall,
    status,
}
