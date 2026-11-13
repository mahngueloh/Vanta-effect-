'use strict'
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')

// Never index/read secrets, sessions, or heavy binary/data dirs.
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'sessions', 'session', 'auth', 'auth_info', 'data', 'assets', 'NODE'])
const EXCLUDE_FILES = new Set(['.env', '.env.example', 'package-lock.json'])
const ALLOWED_EXT = new Set(['.js', '.json', '.md'])
const MAX_FILE_CHARS = 12000
const MAX_SEARCH_MATCHES = 8

function walk(dir, base = '') {
    let out = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue
        if (EXCLUDE_DIRS.has(entry.name) || EXCLUDE_FILES.has(entry.name)) continue
        const rel = base ? `${base}/${entry.name}` : entry.name
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) out = out.concat(walk(full, rel))
        else if (ALLOWED_EXT.has(path.extname(entry.name))) out.push(rel)
    }
    return out
}

function listFiles() {
    return walk(ROOT).sort()
}

// Resolve a user-typed name ("handler.js", "aiproviders", "plugins/aiChat.js")
// to a real project-relative file path.
function resolveFile(query) {
    const files = listFiles()
    const q = query.trim().replace(/^\.?\//, '')
    return (
        files.find(f => f === q) ||
        files.find(f => f.toLowerCase() === q.toLowerCase()) ||
        files.find(f => path.basename(f).toLowerCase() === path.basename(q).toLowerCase()) ||
        files.find(f => f.toLowerCase().includes(q.toLowerCase())) ||
        null
    )
}

function readProjectFile(relPath) {
    const resolved = path.resolve(ROOT, relPath)
    if (!resolved.startsWith(ROOT + path.sep)) throw new Error('Path escapes project root')
    let content = fs.readFileSync(resolved, 'utf8')
    let truncated = false
    if (content.length > MAX_FILE_CHARS) {
        content = content.slice(0, MAX_FILE_CHARS)
        truncated = true
    }
    return { content, truncated }
}

// Keyword search across all indexed source files — one snippet per matching
// file, capped, so results stay small enough to hand to an AI as context.
function searchCode(keyword) {
    const term = keyword.toLowerCase()
    const results = []
    for (const rel of listFiles()) {
        if (results.length >= MAX_SEARCH_MATCHES) break
        let text
        try { text = fs.readFileSync(path.resolve(ROOT, rel), 'utf8') } catch { continue }
        const lines = text.split('\n')
        const idx = lines.findIndex(l => l.toLowerCase().includes(term))
        if (idx !== -1) {
            const start = Math.max(0, idx - 2)
            const end = Math.min(lines.length, idx + 3)
            results.push({ file: rel, line: idx + 1, snippet: lines.slice(start, end).join('\n') })
        }
    }
    return results
}

function fileTree() {
    return listFiles().join('\n')
}

module.exports = { listFiles, resolveFile, readProjectFile, searchCode, fileTree, ROOT }
