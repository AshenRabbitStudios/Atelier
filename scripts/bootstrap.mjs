// Atelier bootstrap — the single install/startup brain (see docs/INSTALL.md).
// Invoked by run.bat / run.sh / scripts/launch.ps1. Must import ONLY node builtins:
// it runs before `npm install` has ever happened.
//
//   node scripts/bootstrap.mjs [run|dev|doctor] [--yes] [--no-launch]
//
// Every step narrates what it found, explains what it wants to do about it, and asks
// before acting (Enter = the default in brackets; --yes accepts everything). Re-running
// is always safe: a healthy tree re-runs in seconds with no prompts and no side effects.
// Exit codes are distinct per failure class
// (10 node, 11 deps, 12 electron binary, 13 claude cli, 14 auth, 15 build, 16 launch).

import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const win = process.platform === 'win32'
const terminalName = win ? 'PowerShell' : 'a terminal'
const runCmdName = win ? 'run.bat' : './run.sh'

// ---- CLI parsing ------------------------------------------------------------
const args = process.argv.slice(2)
const flags = new Set(args.filter((a) => a.startsWith('--')))
const command = args.find((a) => !a.startsWith('--')) ?? 'run'
const assumeYes = flags.has('--yes')
const noLaunch = flags.has('--no-launch')
const doctor = command === 'doctor'
if (!['run', 'dev', 'doctor'].includes(command)) {
  console.error(
    `Unknown command '${command}'. Usage: bootstrap.mjs [run|dev|doctor] [--yes] [--no-launch]`
  )
  process.exit(2)
}

// ---- reporting --------------------------------------------------------------
const issues = []
function ok(label, detail = '') {
  console.log(`  [ OK ] ${label}${detail ? ` — ${detail}` : ''}`)
}
function fix(label, detail) {
  console.log(`  [FIX ] ${label} — ${detail}`)
  issues.push(label)
}
// Indented free-text block under a step: explanations, instructions.
function say(...lines) {
  for (const l of lines) console.log(`         ${l}`)
}
function fail(code, label, ...remedyLines) {
  console.error(`  [FAIL] ${label}`)
  for (const l of remedyLines) console.error(`         ${l}`)
  console.error('')
  console.error(`         When that is done, run ${runCmdName} again — it re-checks`)
  console.error('         everything and picks up where it left off.')
  process.exit(code)
}

// ---- helpers ----------------------------------------------------------------
// shell:true so Windows .cmd/.exe shims (npm, claude) resolve like they do in a terminal.
// Args are joined into one line (all static strings from this file, never user input):
// Node 24 deprecates the args-array + shell:true combination (DEP0190).
function run(cmd, argv, opts = {}) {
  const line = [cmd, ...argv.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' ')
  return spawnSync(line, { cwd: root, shell: true, encoding: 'utf8', ...opts })
}
function runLoud(cmd, argv) {
  return run(cmd, argv, { stdio: 'inherit', encoding: undefined })
}

// Ask before acting. Enter accepts the bracketed default. --yes accepts everything.
// Without a terminal to ask on (CI, pipes), safe in-repo actions proceed by default;
// system-level actions (defaultYes:false) refuse unless --yes was passed.
async function consent(question, { defaultYes = true } = {}) {
  if (assumeYes) return true
  if (!process.stdin.isTTY) return defaultYes
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const suffix = defaultYes ? '[Y/n]' : '[y/N]'
  const answer = await new Promise((res) => rl.question(`\n         ${question} ${suffix} `, res))
  rl.close()
  const a = String(answer).trim()
  if (a === '') return defaultYes
  return /^y(es)?$/i.test(a)
}

function newestMtime(paths) {
  let newest = 0
  const walk = (p) => {
    let st
    try {
      st = statSync(p)
    } catch {
      return
    }
    if (st.isDirectory()) {
      for (const entry of readdirSync(p)) walk(join(p, entry))
    } else if (st.mtimeMs > newest) {
      newest = st.mtimeMs
    }
  }
  for (const p of paths) walk(p)
  return newest
}

// ---- step 1: Node version ---------------------------------------------------
// Vite 7 floor: ^20.19 || >=22.12. We can't upgrade the runtime we're running on.
function checkNode() {
  const [maj, min] = process.versions.node.split('.').map(Number)
  const supported = (maj === 20 && min >= 19) || (maj >= 22 && !(maj === 22 && min < 12))
  if (supported) return ok('Node.js', `v${process.versions.node}`)
  console.error(
    `  [FAIL] Node.js v${process.versions.node} is too old — Atelier needs 20.19+ or 22.12+`
  )
  if (win) {
    say(
      'To upgrade: open PowerShell (press the Windows key, type "powershell",',
      'press Enter), then paste this line and press Enter:',
      '',
      '    winget install OpenJS.NodeJS.LTS',
      '',
      'Or download the installer from https://nodejs.org and run it.',
      'Afterwards CLOSE this window and any open terminals (they keep the old',
      `PATH), open a fresh one, and run ${runCmdName} again.`
    )
  } else {
    say(
      'Upgrade via your version manager (e.g. `nvm install --lts`) or download',
      'it from https://nodejs.org. Then open a fresh terminal and run',
      `${runCmdName} again.`
    )
  }
  process.exit(10)
}

// ---- step 2: dependencies in sync with the lockfile -------------------------
// Stamp = sha256 of package-lock.json, written after a successful install. Missing
// stamp with an existing node_modules gets a cheap `npm install` (near no-op when in
// sync) rather than a destructive `npm ci`; a hash MISMATCH gets deterministic `npm ci`.
const stampPath = join(root, 'node_modules', '.atelier-deps.json')
function lockHash() {
  return createHash('sha256')
    .update(readFileSync(join(root, 'package-lock.json')))
    .digest('hex')
}
function depsState() {
  if (!existsSync(join(root, 'node_modules'))) return 'missing'
  if (!existsSync(stampPath)) return 'unverified'
  try {
    return JSON.parse(readFileSync(stampPath, 'utf8')).lockHash === lockHash() ? 'ok' : 'stale'
  } catch {
    return 'unverified'
  }
}
async function checkDeps() {
  const state = depsState()
  if (state === 'ok') return ok('Dependencies', 'node_modules matches package-lock.json')
  if (doctor) return fix('Dependencies', `${state} — \`npm ci\` (or npm install) needed`)
  const why = {
    missing: "Atelier's libraries (node_modules) have not been downloaded yet.",
    stale: 'The dependency list changed since the last install (lockfile mismatch).',
    unverified: 'node_modules exists but has not been verified by this launcher yet.'
  }[state]
  console.log(`  [FIX ] Dependencies — ${state}`)
  say(
    why,
    'Fix: run npm to download/sync them into the node_modules folder INSIDE',
    'this project directory — nothing outside this folder is touched.',
    state === 'missing'
      ? 'First-time download is a few hundred MB and can take a few minutes.'
      : 'This is usually quick when most packages are already present.'
  )
  if (!(await consent('Install dependencies now?')))
    fail(
      11,
      'Dependencies are required to continue',
      `Install them yourself by running \`npm ci\` in ${terminalName}`,
      `from this folder (${root}).`
    )
  console.log('')
  const useCi = state === 'stale' || state === 'missing'
  let r = runLoud('npm', useCi ? ['ci'] : ['install'])
  if (r.status !== 0 && useCi) r = runLoud('npm', ['install']) // npm ci can fail on odd trees; install is the fallback
  if (r.status !== 0)
    fail(11, 'npm could not install dependencies', 'Fix the npm error shown above.')
  writeFileSync(stampPath, JSON.stringify({ lockHash: lockHash(), at: new Date().toISOString() }))
  ok('Dependencies', 'installed and verified')
}

// ---- step 3: electron binary ------------------------------------------------
// npm's electron postinstall is occasionally skipped, leaving a dep tree that "looks
// installed" but has no binary. Its own install.js repairs that in place.
function electronBin() {
  if (win) return join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  if (process.platform === 'darwin')
    return join(
      root,
      'node_modules',
      'electron',
      'dist',
      'Electron.app',
      'Contents',
      'MacOS',
      'Electron'
    )
  return join(root, 'node_modules', 'electron', 'dist', 'electron')
}
async function checkElectron() {
  if (existsSync(electronBin())) return ok('Electron binary')
  if (doctor)
    return fix('Electron binary', 'missing — `node node_modules/electron/install.js` needed')
  console.log('  [FIX ] Electron binary — missing')
  say(
    'Electron is the desktop shell Atelier runs in. Its download step was',
    'skipped during install (a known npm quirk), so the app binary is absent.',
    "Fix: run Electron's own repair script; it downloads the binary into",
    'node_modules inside this project folder. Nothing outside it is touched.'
  )
  if (!(await consent('Download the Electron binary now?')))
    fail(
      12,
      'The Electron binary is required to run the app',
      `Repair it yourself with \`node node_modules/electron/install.js\``,
      `run in ${terminalName} from this folder (${root}).`
    )
  console.log('')
  const r = runLoud('node', [join('node_modules', 'electron', 'install.js')])
  if (r.status !== 0 || !existsSync(electronBin()))
    fail(
      12,
      'The Electron binary is still missing after the repair script',
      'Delete the node_modules folder inside this project directory.'
    )
  ok('Electron binary', 'repaired')
}

// ---- step 3b: Terminal PTY native module (optional plugin) -------------------
// The bundled Terminal plugin needs a native PTY addon (@homebridge/node-pty-prebuilt-multiarch).
// Its Windows and Linux prebuilt binaries ship inside the package tarball and load under Electron's
// ABI with no rebuild and no compiler (verified: Electron 42 / NODE_MODULE_VERSION 146 on win-x64);
// macOS may fall back to a source build. This is a SOFT check on purpose: a missing binary only
// disables the Terminal plugin — which reports the problem inside its own pane — so it must never
// block the app or add an install step. We note it and move on.
function checkNativeModules() {
  const modDir = join(root, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch')
  if (!existsSync(modDir)) return // a missing node_modules is the deps step's problem, not ours
  const built = join(modDir, 'build', 'Release', 'pty.node')
  let prebuilt = false
  const prebuildsDir = join(modDir, 'prebuilds')
  if (existsSync(prebuildsDir)) {
    try {
      prebuilt = readdirSync(prebuildsDir).some((d) => {
        const sub = join(prebuildsDir, d)
        try {
          return statSync(sub).isDirectory() && readdirSync(sub).some((f) => f.endsWith('.node'))
        } catch {
          return false
        }
      })
    } catch {
      /* fall through to the note */
    }
  }
  if (existsSync(built) || prebuilt) return ok('Terminal PTY module', 'prebuilt binary present')
  console.log('  [NOTE] Terminal PTY module — no prebuilt binary for this platform')
  say(
    'The optional Terminal plugin needs a native PTY addon and no prebuilt binary',
    'was found for this platform (can happen on macOS). The rest of Atelier is',
    'unaffected; the Terminal pane shows a build hint if you open it.'
  )
}

// ---- step 4: Claude Code CLI ------------------------------------------------
// Atelier authenticates via the ambient Claude Code session (main.ts strips
// ANTHROPIC_API_KEY on purpose), so the CLI is how a user logs in at all.
function claudeVersion() {
  const r = run('claude', ['--version'])
  return r.status === 0 ? r.stdout.trim() : null
}
async function checkClaudeCli() {
  const v = claudeVersion()
  if (v) return ok('Claude Code CLI', v)
  const installCmd = win
    ? 'irm https://claude.ai/install.ps1 | iex'
    : 'curl -fsSL https://claude.ai/install.sh | bash'
  if (doctor) return fix('Claude Code CLI', `not found — official installer needed (${installCmd})`)
  console.log('  [FIX ] Claude Code CLI — not found')
  say(
    "Claude Code is Anthropic's command-line app; Atelier signs in to Claude",
    'THROUGH it (your Claude subscription — no API key needed), so it must be',
    'installed once on this machine.',
    "Fix: run Anthropic's official installer. This is the one step that",
    'installs something OUTSIDE this project folder (into your user profile,',
    `and it adds a \`claude\` command to your PATH).`
  )
  if (!(await consent('Run the official Claude Code installer now?', { defaultYes: false })))
    fail(
      13,
      'Claude Code is required for Atelier to sign in to Claude',
      `To install it yourself: open ${terminalName}, paste this line, press Enter:`,
      '',
      `    ${installCmd}`,
      '',
      '(It is the official installer from claude.ai.) Then close that terminal.'
    )
  console.log('')
  const r = win
    ? runLoud('powershell', ['-ExecutionPolicy', 'Bypass', '-c', installCmd])
    : runLoud('bash', ['-c', installCmd])
  if (r.status !== 0 || !claudeVersion())
    fail(
      13,
      'The Claude Code install did not complete (or `claude` is not on PATH yet)',
      `A just-installed \`claude\` may only be visible to NEW terminals: close`,
      `this window, open a fresh ${terminalName}, and try again. If it still`,
      `fails, install manually by pasting this into ${terminalName}:`,
      '',
      `    ${installCmd}`,
      ''
    )
  ok('Claude Code CLI', 'installed')
}

// ---- step 5: logged in ------------------------------------------------------
// `claude auth status` exits 0 + prints {"loggedIn":true,...} when signed in
// (verified v2.1.198). Login itself is inherently interactive (browser OAuth).
function loggedIn() {
  const r = run('claude', ['auth', 'status'])
  if (r.status !== 0) return false
  try {
    return JSON.parse(r.stdout).loggedIn !== false
  } catch {
    return true // exit 0 but unparseable output: trust the exit code
  }
}
async function checkAuth() {
  if (loggedIn()) return ok('Claude sign-in', 'signed in')
  if (doctor) return fix('Claude sign-in', 'not signed in — `claude auth login` needed')
  console.log('  [FIX ] Claude sign-in — not signed in')
  say(
    'Atelier talks to Claude using your Claude account session, and this',
    'machine is not signed in yet.',
    'Fix: start the sign-in flow. Your web browser will open on a Claude page;',
    'sign in with your Claude account (Pro/Max subscription or Console), then',
    'come back to this window — it continues automatically.'
  )
  if (!(await consent('Open the Claude sign-in flow now?')))
    fail(
      14,
      'Atelier cannot talk to Claude without a signed-in session',
      `To sign in yourself: open ${terminalName}, type \`claude auth login\`,`,
      'press Enter, and finish the sign-in in your browser.'
    )
  console.log('')
  runLoud('claude', ['auth', 'login'])
  if (!loggedIn())
    fail(
      14,
      'Still not signed in after the sign-in flow',
      `Try it directly: open ${terminalName}, type \`claude auth login\`, press`,
      'Enter, and finish the sign-in in your browser.'
    )
  ok('Claude sign-in', 'signed in')
}

// ---- step 6: API-key note (informational) -----------------------------------
function warnApiKey() {
  if (process.env.ANTHROPIC_API_KEY) {
    console.log('  [NOTE] ANTHROPIC_API_KEY is set in this environment.')
    say(
      'Atelier ignores it on purpose and uses your Claude subscription session',
      'instead, so this app never bills your API account. Nothing to do.'
    )
  }
}

// ---- step 7: build freshness ------------------------------------------------
// Same staleness rule the Desktop shortcut used: rebuild out/ only when a bundle
// input is newer than the last build. plugins/ load live from disk — excluded.
function buildStale() {
  const outMain = join(root, 'out', 'main', 'main.js')
  if (!existsSync(outMain)) return true
  const inputs = ['electron', 'src', 'index.html', 'package.json', 'electron.vite.config.ts'].map(
    (p) => join(root, p)
  )
  return newestMtime(inputs) > statSync(outMain).mtimeMs
}
async function checkBuild() {
  if (!buildStale()) return ok('App build', 'up to date')
  if (doctor) return fix('App build', 'out/ stale or missing — `npm run build` needed')
  console.log('  [FIX ] App build — missing or older than the source code')
  say(
    'The app needs to be compiled (source → the out/ folder inside this',
    'project) before it can start. Takes ~30 seconds, all inside this folder.'
  )
  if (!(await consent('Build the app now?')))
    fail(
      15,
      'Atelier cannot start without a build',
      `Build it yourself by running \`npm run build\` in ${terminalName}`,
      `from this folder (${root}).`
    )
  console.log('')
  const r = runLoud('npm', ['run', 'build'])
  if (r.status !== 0) fail(15, 'The build failed', 'Fix the build error shown above.')
  ok('App build', 'rebuilt')
}

// ---- step 8: launch ---------------------------------------------------------
function launch() {
  if (noLaunch) {
    console.log(`\nEverything is ready (--no-launch: not starting). Start with ${runCmdName}`)
    return
  }
  if (command === 'dev') {
    console.log('\nStarting Atelier in dev mode (hot reload; Ctrl+C here to stop)...')
    const r = runLoud('npm', ['run', 'dev'])
    process.exit(r.status ?? 0)
  }
  console.log('\nStarting Atelier... (the app opens in its own window; this window can be closed)')
  try {
    const child = spawn(electronBin(), [root], { cwd: root, detached: true, stdio: 'ignore' })
    child.unref()
  } catch (e) {
    fail(16, `Could not start Electron: ${e.message}`, 'If it persists, delete node_modules.')
  }
}

// ---- pipeline ---------------------------------------------------------------
console.log(`Atelier ${doctor ? 'health check (doctor)' : 'startup'} — ${root}`)
if (doctor) {
  console.log('Checking every prerequisite; nothing will be changed.\n')
} else {
  console.log(
    'Checking prerequisites (dependencies, Claude Code, sign-in, build) and\n' +
      'fixing what is missing — each fix asks first. Safe to re-run anytime.\n'
  )
}
checkNode()
await checkDeps()
if (!doctor || depsState() !== 'missing') await checkElectron()
checkNativeModules()
await checkClaudeCli()
await checkAuth()
warnApiKey()
await checkBuild()
if (doctor) {
  if (issues.length === 0) {
    console.log(`\nAll checks passed. ${runCmdName} will start the app immediately.`)
    process.exit(0)
  }
  console.log(
    `\n${issues.length} issue(s) found: ${issues.join(', ')}.` +
      `\nRun ${runCmdName} to fix them — it explains and asks before each fix.`
  )
  process.exit(1)
}
launch()
