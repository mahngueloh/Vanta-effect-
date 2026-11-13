'use strict'

// Produces dist/ — a standalone, obfuscated copy of this bot you can deploy
// or hand to someone else, WITHOUT touching your real source at all. Your
// actual plugins/, handler.js, lib/, and `.repair` keep working exactly as
// before — this only ever reads them, never writes them.
//
// Two-stage pipeline, same shape June-Ultra's own build almost certainly
// uses (its shipped index.js is one 550KB single-line file with no other
// source files at all — that's a bundle-then-obfuscate output, not
// hand-written code):
//
//   1. esbuild bundles index.js and every local file it requires
//      (handler.js, plugins/*, lib/*, config.js, scripts/ensure-env.js)
//      into ONE file. Real npm dependencies (baileys, sharp, etc.) are
//      left as normal `require()` calls, NOT inlined — dist/ still needs
//      `npm install` to pull those from the registry like any Node app.
//   2. javascript-obfuscator scrambles that bundle: renamed identifiers,
//      control-flow flattening, encoded string literals, self-defending
//      code that breaks if someone tries to reformat/beautify it.
//
// Usage (from your real project root, not from inside dist/):
//   npm install --save-dev esbuild javascript-obfuscator
//   npm run build:obfuscate
//
// Requires real internet access to npm during that first install line —
// this sandbox doesn't have that, so this script is written but untested
// end-to-end here. esbuild's half was verified directly; javascript-
// obfuscator's API usage below follows its documented options exactly,
// but you should run it once yourself and smoke-test dist/index.js before
// relying on it.

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'dist')


// esbuild merges every file into ONE file, so __dirname in plugins/menu.js
// stops meaning "the plugins folder" and becomes the bot root. That breaks
// paths like path.join(__dirname, '../assets/banner.png'). This plugin
// rewrites __dirname/__filename per source file so they keep their ORIGINAL
// meaning inside the bundle.
const keepDirname = {
    name: 'keep-dirname',
    setup(build) {
        build.onLoad({ filter: /\.js$/ }, async (args) => {
            if (args.path.includes(path.sep + 'node_modules' + path.sep)) return null
            let code = await fs.promises.readFile(args.path, 'utf8')
            if (!/__dirname|__filename/.test(code)) return null
            const relDir = path.relative(ROOT, path.dirname(args.path)).split(path.sep).join('/')
            const relFile = path.relative(ROOT, args.path).split(path.sep).join('/')
            const dir = relDir ? `require('path').join(__dirname, ${JSON.stringify(relDir)})` : '__dirname'
            const file = `require('path').join(__dirname, ${JSON.stringify(relFile)})`
            code = code.replace(/\b__dirname\b/g, dir).replace(/\b__filename\b/g, file)
            return { contents: code, loader: 'js' }
        })
    },
}

function log(msg) { console.log(`[build] ${msg}`) }

async function main() {
    let esbuild, obfuscator
    try {
        esbuild = require('esbuild')
        obfuscator = require('javascript-obfuscator')
    } catch (e) {
        console.error(`[build] Missing dependency: ${e.message}`)
        console.error(`[build] Run: npm install --save-dev esbuild javascript-obfuscator`)
        process.exit(1)
    }

    fs.rmSync(DIST, { recursive: true, force: true })
    fs.mkdirSync(DIST, { recursive: true })

    // ── Stage 1: bundle every local file into one, leave real npm
    // packages as external requires (dist/ still does its own npm install).
    log('Bundling local source with esbuild...')
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
    const realDeps = Object.keys(pkg.dependencies || {})

    const bundleResult = await esbuild.build({
        entryPoints: [path.join(ROOT, 'index.js')],
        bundle: true,
        platform: 'node',
        target: 'node18',
        format: 'cjs',
        external: realDeps,
        write: false,
        legalComments: 'none',
        plugins: [keepDirname],
    })
    const bundledCode = bundleResult.outputFiles[0].text
    log(`Bundled to ${(bundledCode.length / 1024).toFixed(0)} KB`)

    // ── Stage 2: obfuscate the bundle.
    // Settings chosen to be strong but not self-sabotaging: full string
    // encoding + control-flow flattening + dead code, but console output
    // is left ALIVE (you still need your own operational logs in the
    // hosting panel's console), and debugProtection is left OFF (it's
    // known to cause runaway CPU/hangs on some hosting panels that attach
    // their own inspector to read logs — a bad tradeoff for a bot that
    // needs to run 24/7).
    log('Obfuscating bundle...')
    const obfuscated = obfuscator.obfuscate(bundledCode, {
        compact: true,
        controlFlowFlattening: true,
        controlFlowFlatteningThreshold: 0.75,
        deadCodeInjection: true,
        deadCodeInjectionThreshold: 0.2,
        stringArray: true,
        stringArrayEncoding: ['base64'],
        stringArrayThreshold: 0.75,
        rotateStringArray: true,
        identifierNamesGenerator: 'mangled-shuffled',
        renameGlobals: false,
        selfDefending: true,
        debugProtection: false,
        disableConsoleOutput: false,
        target: 'node',
    })
    fs.writeFileSync(path.join(DIST, 'index.js'), obfuscated.getObfuscatedCode())

    // ── Copy the small support script postinstall calls directly (not via
    // require, so esbuild wouldn't have bundled it in on its own anyway).
    fs.mkdirSync(path.join(DIST, 'scripts'), { recursive: true })
    fs.copyFileSync(path.join(ROOT, 'scripts', 'ensure-env.js'), path.join(DIST, 'scripts', 'ensure-env.js'))

    // ── A trimmed package.json for dist/: real deps only, no dev tooling,
    // so recipients' `npm install` doesn't need esbuild/javascript-obfuscator
    // at all.
    const distPkg = {
        name: pkg.name,
        version: pkg.version,
        private: true,
        main: 'index.js',
        scripts: { start: 'node index.js' },
        dependencies: pkg.dependencies || {},
        engines: pkg.engines,
        overrides: pkg.overrides,
        allowScripts: pkg.allowScripts,
        postinstall: pkg.scripts?.postinstall,
    }
    if (distPkg.postinstall) distPkg.scripts.postinstall = distPkg.postinstall
    delete distPkg.postinstall
    fs.writeFileSync(path.join(DIST, 'package.json'), JSON.stringify(distPkg, null, 2))

    // ── Carry over whatever deploy metadata files exist — same top-level
    // shape as June-Ultra's own shipped folder (Procfile, app.json, etc.)
    for (const f of ['Procfile', 'app.json', 'render.yaml', 'heroku.yml', 'railway.json', '.gitignore', '.env.example', 'README.md', 'LICENSE']) {
        const src = path.join(ROOT, f)
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(DIST, f))
    }

    // ── deploy/start.sh → dist/start.sh (flattened to root). The panel's
    // STARTUP COMMAND runs `bash ${START_BASH_FILE}` with START_BASH_FILE
    // set to just "start.sh" — a root-relative path, not "deploy/start.sh".
    // This was never being copied into dist/ at all before, which is why
    // the panel's startup step failed with "No such file or directory"
    // once nothing was left over from manual/untracked panel state.
    const startShSrc = path.join(ROOT, 'deploy', 'start.sh')
    if (fs.existsSync(startShSrc)) fs.copyFileSync(startShSrc, path.join(DIST, 'start.sh'))

    // ── Assets (menu banner, logo) are read at runtime, so they must ship too.
    if (fs.existsSync(path.join(ROOT, 'assets'))) {
        fs.cpSync(path.join(ROOT, 'assets'), path.join(DIST, 'assets'), { recursive: true })
    }

    // ── .env is copied into dist/ as a fill-in-the-blanks template, same
    // pattern WolfBot uses: real variable names (SESSION_ID=, PHONE_NUMBER=)
    // but every value left BLANK. That's safe to publish — it's a template,
    // not a secret. This build refuses to copy it if any value below is
    // non-empty, so a real session ID typed in for local testing can never
    // ride along into a public push by accident.
    const envSrc = path.join(ROOT, '.env')
    if (fs.existsSync(envSrc)) {
        const envText = fs.readFileSync(envSrc, 'utf8')
        const hasRealValue = envText.split('\n').some(line => {
            const m = line.match(/^\s*(SESSION_ID|PHONE_NUMBER)\s*=\s*(.+)$/)
            return m && m[2].trim() !== ''
        })
        if (hasRealValue) {
            console.warn('[build] WARNING: .env has a real value filled in — skipping copy into dist/ so nothing leaks. Clear it (or edit dist/.env manually) if you actually meant to publish it.')
        } else {
            fs.copyFileSync(envSrc, path.join(DIST, '.env'))
            // dist/.gitignore was just copied from the root .gitignore, which
            // ignores .env on purpose (so YOUR real, filled-in .env never gets
            // staged when you commit from the project root). But we've just
            // verified the copy in dist/ is blank, so let it be tracked there.
            const giPath = path.join(DIST, '.gitignore')
            if (fs.existsSync(giPath)) {
                const gi = fs.readFileSync(giPath, 'utf8').split('\n').filter(l => l.trim() !== '.env').join('\n')
                fs.writeFileSync(giPath, gi)
            }
        }
    }

    log(`Done. Deploy the dist/ folder — your real source in plugins/, handler.js, and lib/ was never touched.`)
}

main().catch(e => { console.error('[build] Failed:', e); process.exit(1) })
