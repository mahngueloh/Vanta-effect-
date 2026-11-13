#!/usr/bin/env node
'use strict'
const fs = require('fs')
const path = require('path')
const { getSportsCommands, resolveSportsCommand } = require('../plugins/sports')

const root = path.join(__dirname, '..')
let failures = 0
function ok(label, detail='') { console.log(`✅ ${label}${detail ? ` — ${detail}` : ''}`) }
function fail(label, detail='') { console.log(`❌ ${label}${detail ? ` — ${detail}` : ''}`); failures++ }

// Syntax-check every JavaScript source file without executing the bot.
const { execFileSync } = require('child_process')
for (const f of walk(root).filter(f => f.endsWith('.js'))) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'ignore' }); }
  catch { fail('Syntax', path.relative(root, f)) }
}
if (!failures) ok('JavaScript syntax', 'all source files pass node --check')

const sports = getSportsCommands()
for (const c of ['sports','epl','eplmatches','eplstandings','eplscorers','eplupcoming','pl','plfixtures','laliga','bundesliga','seriea','ligue1','cl','efl','el','wcmatches']) {
  if (!sports.has(c) || !resolveSportsCommand(c)) fail('Sports command', c)
}
if (!failures) ok('Sports registry', `${sports.size} generated commands/aliases resolve`)

// Detect obvious credential literals anywhere in source — including
// config.js. An earlier version of this check exempted config.js on the
// theory that "centralized in one file" made a hardcoded key safe — it
// doesn't: this project gets pushed to GitHub (.updatecode) and handed to
// other people as a template, so a real key belongs in .env, never in any
// committed file, config.js included.
const secretPatterns = [/sk-proj-[A-Za-z0-9_-]{20,}/, /AQ\.[A-Za-z0-9_-]{20,}/, /savage_[A-Za-z0-9_-]{4,}/]
for (const f of walk(root).filter(f => /\.(js|md|json)$/.test(f))) {
  const text = fs.readFileSync(f, 'utf8')
  if (secretPatterns.some(r => r.test(text))) {
    fail('Credential scan', path.relative(root, f))
  }
}
if (!failures) ok('Credential scan', 'no hardcoded credential literals found anywhere')

console.log(failures ? `\nAudit finished with ${failures} failure(s).` : '\nAudit finished cleanly.')
process.exitCode = failures ? 1 : 0

function walk(dir) {
  const out=[]
  for (const ent of fs.readdirSync(dir,{withFileTypes:true})) {
    if (['node_modules','.git','auth_info'].includes(ent.name)) continue
    const p=path.join(dir,ent.name)
    if (ent.isDirectory()) out.push(...walk(p)); else out.push(p)
  }
  return out
}
