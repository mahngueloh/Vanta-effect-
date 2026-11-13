'use strict'

const fs   = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const config = require('../config')
const { chatCompletion } = require('../lib/aiProviders')

const ROOT     = path.join(__dirname, '..')
const BACKUP_DIR = path.join(ROOT, 'data', 'repair-backups')

// Every plugin/handler file that might contain a command worth repairing.
// (Deliberately excludes config.js, package.json, .env, index.js's
// connection logic — those aren't "commands" and a bad auto-edit there
// could take the whole bot offline in a way `.repair` can't recover from.)
function candidateFiles() {
    const files = [path.join(ROOT, 'handler.js')]
    const pluginsDir = path.join(ROOT, 'plugins')
    for (const f of fs.readdirSync(pluginsDir)) {
        if (f.endsWith('.js')) files.push(path.join(pluginsDir, f))
    }
    return files
}

// Finds `case 'cmdName':` (possibly chained with other case labels on the
// same line, e.g. `case 'vv': case 'reveal': {`) and extracts the full
// braced block that follows it, using brace-depth counting rather than
// "next case" — several blocks in this codebase contain their own nested
// braces (if/for/try), so a naive line-scan would grab the wrong amount.
function findCommandBlock(source, cmdName) {
    const caseRegex = new RegExp(`case\\s+'${cmdName}'\\s*:`)
    const match = caseRegex.exec(source)
    if (!match) return null

    // Walk backward to the start of the line so we capture any chained
    // `case 'x': case 'y':` labels on the same line as our match.
    let lineStart = source.lastIndexOf('\n', match.index) + 1

    const braceOpen = source.indexOf('{', match.index)
    if (braceOpen === -1) return null

    let depth = 0
    let i = braceOpen
    for (; i < source.length; i++) {
        if (source[i] === '{') depth++
        else if (source[i] === '}') {
            depth--
            if (depth === 0) { i++; break }
        }
    }
    if (depth !== 0) return null // unbalanced — bail rather than guess

    return {
        start: lineStart,
        end: i,
        text: source.slice(lineStart, i),
    }
}

function stripCodeFence(text) {
    // If there's a fenced code block anywhere in the response, use ITS
    // contents — models sometimes add a sentence before/after the fence
    // despite being told not to, so "starts/ends with ```" isn't reliable.
    const fenced = text.match(/```[\w]*\n?([\s\S]*?)```/)
    if (fenced) return fenced[1].trim()
    return text.trim()
}

// stripCodeFence handles a fenced response. This handles the harder case:
// the AI skips markdown fences entirely and just prefixes/suffixes plain
// commentary ("Yes, here's the fix:" / "This should resolve it.") around
// the code, which stripCodeFence can't detect at all. We know exactly what
// the fix must start with — the same case label(s) as the ORIGINAL block —
// so anchor on that to drop any preamble, then use brace-depth counting
// (same technique as findCommandBlock) to drop any trailing commentary too.
function extractFixedBlock(aiText, originalBlockText) {
    let text = stripCodeFence(aiText)

    const firstCaseMatch = originalBlockText.match(/case\s+'[^']+'\s*:/)
    if (firstCaseMatch) {
        const idx = text.indexOf(firstCaseMatch[0])
        if (idx > 0) text = text.slice(idx)          // drop leading chatter
        else if (idx === -1) return null              // AI didn't even keep the case label — reject rather than guess
    }

    const braceOpen = text.indexOf('{')
    if (braceOpen !== -1) {
        let depth = 0
        for (let i = braceOpen; i < text.length; i++) {
            if (text[i] === '{') depth++
            else if (text[i] === '}') {
                depth--
                if (depth === 0) { text = text.slice(0, i + 1); break }  // drop trailing chatter
            }
        }
    }

    return text.trim()
}

// Stage 1 — DIAGNOSE. Gemini (fallback OpenAI) gets the full file for real
// context: helper functions it calls, patterns used elsewhere, what would
// break. Neither is Savage-relay-limited, so file size is a non-issue here.
// Output is a short, plain-English root cause + fix plan — NOT code — kept
// short on purpose so stage 2 stays under the relay's prompt-size cap.
function buildDiagnosisPrompt(cmdName, bugDescription, fullFileSource, block, relativeFile) {
    return [
        `You are debugging a Node.js WhatsApp bot built on @neoxr/baileys (a Baileys v7 fork).`,
        `Shared conventions in this codebase, for context:`,
        `- lib/utils.js exports isOwner/isAdmin/isBotAdmin/jidToNum/normNum/numsMatch/getBody/getCachedGroupMeta for permission and JID handling`,
        `- lib/format.js (imported as "fmt") provides fmt.box(title, lines), fmt.error(text), fmt.react(sock, msg, emoji) for consistent replies`,
        `- runtimeSettings (from plugins/ownerCmds.js) holds owner-togglable feature flags`,
        `- Commands live as \`case 'name': { ... break }\` blocks inside a big switch in handler.js, or in per-topic files under plugins/`,
        ``,
        `File under repair: ${relativeFile}`,
        `Command with the bug: "${cmdName}"`,
        `Reported bug: ${bugDescription}`,
        ``,
        `Full current file content, for context:`,
        '```javascript',
        fullFileSource,
        '```',
        ``,
        `The specific block believed to contain the bug:`,
        '```javascript',
        block,
        '```',
        ``,
        `Work out the ROOT CAUSE using the full file for context — not just the block in isolation `,
        `(the real cause may be that something ELSE in the file never calls/checks this block at all).`,
        `Reply in plain English, under 150 words: what's actually wrong, and exactly what needs to `,
        `change to fix it. Do NOT write the fixed code itself — another step handles that. No markdown, `,
        `no code blocks, just the explanation.`,
    ].join('\n')
}

// Stage 2 — FIX. Claude (fallback OpenAI/Gemini/DeepSeek) gets ONLY the
// diagnosis + the block — not the whole file — both because that's all it
// actually needs to write the fix, and because it keeps this prompt short
// enough that Claude's Savage-relay fallback can handle it even without an
// official ANTHROPIC_API_KEY.
function buildFixPrompt(cmdName, bugDescription, diagnosis, block, relativeFile) {
    return [
        `You are fixing a bug in a Node.js WhatsApp bot (Baileys library) based on a diagnosis `,
        `another engineer already worked out.`,
        ``,
        `File: ${relativeFile} — command: "${cmdName}"`,
        `Reported bug: ${bugDescription}`,
        ``,
        `Diagnosis (root cause + what needs to change):`,
        diagnosis,
        ``,
        `The exact block to fix:`,
        '```javascript',
        block,
        '```',
        ``,
        `Respond with ONLY the corrected code for that exact block — nothing else. Do not include `,
        `markdown fences, explanations, or any words at all outside the code itself — not even a leading `,
        `"Yes," or "Here's the fix:" or a trailing note. Your entire response must be valid to paste directly `,
        `into the file in place of the block above. Preserve the exact same case label(s), overall structure, `,
        `and surrounding style. Only change what's needed per the diagnosis — do not touch anything outside `,
        `this block, and do not introduce calls to helpers that don't exist in this file.`,
    ].join('\n')
}

// Two-stage repair: Gemini/OpenAI diagnose against the full file (no size
// limit, better context), then Claude/others write the actual fix from that
// short diagnosis (small enough to reach Claude even via the size-limited
// Savage relay). Falls back sensibly at each stage if a provider is down.
async function askAiForFix(cmdName, bugDescription, fullFileSource, block, relativeFile) {
    let diagnosis
    try {
        const diagPrompt = buildDiagnosisPrompt(cmdName, bugDescription, fullFileSource, block.text, relativeFile)
        const diagResult = await chatCompletion({
            prompt: diagPrompt,
            system: 'You are a precise senior Node.js debugging assistant. Diagnose only — do not write code.',
            only: ['gemini', 'openai'],
        })
        diagnosis = diagResult.text
    } catch (e) {
        throw new Error(`Diagnosis step failed — ${e.message}. Set GEMINI_API_KEY or OPENAI_API_KEY in .env (needed to safely read the whole file).`)
    }

    try {
        const fixPrompt = buildFixPrompt(cmdName, bugDescription, diagnosis, block.text, relativeFile)
        const fixResult = await chatCompletion({
            prompt: fixPrompt,
            system: 'You are a precise senior Node.js debugging assistant fixing a WhatsApp bot built on Baileys. Return only corrected code, no commentary — not even a one-word acknowledgement.',
            // Explicit fix-stage order: Claude first, then DeepSeek, then Gemini.
            // Each hands the SAME prompt (diagnosis + block) to the next on
            // failure, so whichever picks it up continues from exactly where
            // the last one left off — nothing is re-explained or lost.
            only: ['claude', 'deepseek', 'gemini'],
        })
        const fixed = extractFixedBlock(fixResult.text, block.text)
        if (!fixed) throw new Error(`${fixResult.provider} response didn't contain the expected code block — got: "${fixResult.text.slice(0, 120)}"`)
        return fixed
    } catch (e) {
        throw new Error(`Fix step failed — ${e.message}. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, or DEEPSEEK_API_KEY in .env.`)
    }
}

function backupFile(filePath) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = path.join(BACKUP_DIR, `${path.basename(filePath)}.${stamp}.bak`)
    fs.copyFileSync(filePath, backupPath)
    return backupPath
}

function validateSyntax(filePath) {
    try {
        execSync(`node --check "${filePath}"`, { stdio: 'pipe' })
        return { ok: true }
    } catch (e) {
        return { ok: false, error: (e.stderr || e.message || '').toString().slice(0, 500) }
    }
}

async function repairCommand(cmdName, bugDescription) {
    for (const filePath of candidateFiles()) {
        const source = fs.readFileSync(filePath, 'utf8')
        const block = findCommandBlock(source, cmdName)
        if (!block) continue

        const relativeFile = path.relative(ROOT, filePath)
        const fixedBlock = await askAiForFix(cmdName, bugDescription, source, block, relativeFile)
        if (!fixedBlock || fixedBlock.length < 10) {
            throw new Error('AI returned an empty/invalid fix — nothing was changed.')
        }

        const backupPath = backupFile(filePath)
        const newSource = source.slice(0, block.start) + fixedBlock + source.slice(block.end)
        fs.writeFileSync(filePath, newSource, 'utf8')

        const check = validateSyntax(filePath)
        if (!check.ok) {
            // Roll back immediately — never leave a file in a broken state.
            fs.copyFileSync(backupPath, filePath)
            return {
                success: false,
                file: relativeFile,
                error: check.error,
                rolledBack: true,
            }
        }

        logRepair({ cmd: cmdName, bug: bugDescription, file: relativeFile, backupPath: path.relative(ROOT, backupPath), at: new Date().toISOString() })

        return {
            success: true,
            file: relativeFile,
            backupPath: path.relative(ROOT, backupPath),
            oldCode: block.text,
            newCode: fixedBlock,
        }
    }
    return { success: false, notFound: true }
}

// ── Repair audit trail ──────────────────────────────────────────────────────
const LOG_PATH = path.join(BACKUP_DIR, 'repair-log.json')

function logRepair(entry) {
    let log = []
    try { log = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8')) } catch {}
    log.push(entry)
    if (log.length > 100) log = log.slice(-100) // keep it bounded
    try {
        fs.mkdirSync(BACKUP_DIR, { recursive: true })
        fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2))
    } catch {}
}

function getRepairLog(limit = 10) {
    try {
        const log = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'))
        return log.slice(-limit).reverse()
    } catch {
        return []
    }
}

module.exports = { repairCommand, getRepairLog }
