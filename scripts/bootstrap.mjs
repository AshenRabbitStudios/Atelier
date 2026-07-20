// Atelier bootstrap — the single install/startup brain (see docs/INSTALL.md).
// Invoked by run.bat / run.sh / scripts/launch.ps1. Must import ONLY node builtins:
// it runs before `npm install` has ever happened.
//
//   node scripts/bootstrap.mjs [run|dev|doctor] [--yes] [--no-launch]
//
// Every step is check → explain → fix → re-check, and idempotent: a healthy tree
// re-runs in seconds with no side effects. Exit codes are distinct per failure class
// (10 node, 11 deps, 12 electron binary, 13 claude cli, 14 auth, 15 build, 16 launch).

import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const win = process.platform === 'win32'

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
function fail(code, label, remedy) {
  console.error(`  [FAIL] ${label}`)
  console.error(`         → ${remedy}`)
  process.exit(code)
}

// ---- helpers ----------------------------------------------------------------
// shell:true so Windows .cmd/.exe shims (npm, claude) resolve like they do in a terminal.
function run(cmd, argv, opts = {}) {
  return spawnSync(cmd, argv, { cwd: root, shell: true, encoding: 'utf8', ...opts })
}
function runLoud(cmd, argv) {
  return run(cmd, argv, { stdio: 'inherit', encoding: undefined })
}
async function consent(question) {
  if (assumeYes) return true
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await new Promise((res) => rl.question(`${question} [y/N] `, res))
  rl.close()
  return /^y(es)?$/i.test(answer.trim())
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
  fail(
    10,
    `Node.js v${process.versions.node} is too old (need ^20.19 or >=22.12)`,
    win
      ? 'Upgrade with:  winget install OpenJS.NodeJS.LTS   (or https://nodejs.org), then re-run run.bat'
      : 'Upgrade via your version manager or https://nodejs.org, then re-run ./run.sh'
  )
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
function checkDeps() {
  const state = depsState()
  if (state === 'ok') return ok('Dependencies', 'node_modules matches package-lock.json')
  if (doctor) return fix('Dependencies', `${state} — \`npm ci\` (or npm install) needed`)
  console.log(`  [....] Dependencies ${state} — installing (this can take a few minutes)...`)
  const useCi = state === 'stale' || state === 'missing'
  let r = runLoud('npm', useCi ? ['ci'] : ['install'])
  if (r.status !== 0 && useCi) r = runLoud('npm', ['install']) // npm ci can fail on odd trees; install is the fallback
  if (r.status !== 0)
    fail(11, 'npm could not install dependencies', 'Fix the npm error above and re-run')
  writeFileSync(stampPath, JSON.stringify({ lockHash: lockHash(), at: new Date().toISOString() }))
  ok('Dependencies', 'installed')
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
function checkElectron() {
  if (existsSync(electronBin())) return ok('Electron binary')
  if (doctor)
    return fix('Electron binary', 'missing — `node node_modules/electron/install.js` needed')
  console.log('  [....] Electron binary missing — running its installer...')
  const r = runLoud('node', [join('node_modules', 'electron', 'install.js')])
  if (r.status !== 0 || !existsSync(electronBin()))
    fail(12, 'Electron binary still missing after install.js', 'Delete node_modules and re-run')
  ok('Electron binary', 'repaired')
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
    ? 'powershell -c "irm https://claude.ai/install.ps1 | iex"'
    : 'curl -fsSL https://claude.ai/install.sh | bash'
  if (doctor) return fix('Claude Code CLI', `not found — install with: ${installCmd}`)
  console.log(
    '  [....] Claude Code CLI not found. Atelier signs in through it (no API key needed).'
  )
  if (!(await consent('Install Claude Code now via the official installer?')))
    fail(13, 'Claude Code CLI is required', `Install it with:  ${installCmd}   then re-run`)
  const r = win
    ? runLoud('powershell', [
        '-ExecutionPolicy',
        'Bypass',
        '-c',
        'irm https://claude.ai/install.ps1 | iex'
      ])
    : runLoud('bash', ['-c', 'curl -fsSL https://claude.ai/install.sh | bash'])
  if (r.status !== 0 || !claudeVersion())
    fail(
      13,
      'Claude Code install did not complete',
      `Install manually:  ${installCmd}   then re-run`
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
  if (loggedIn()) return ok('Claude login', 'signed in')
  if (doctor) return fix('Claude login', 'not signed in — `claude auth login` needed')
  console.log('  [....] Not signed in to Claude. Opening the login flow...')
  if (!process.stdin.isTTY && !assumeYes)
    fail(
      14,
      'Not signed in to Claude (and no terminal to log in with)',
      'Run `claude auth login`, then re-run'
    )
  runLoud('claude', ['auth', 'login'])
  if (!loggedIn()) fail(14, 'Still not signed in', 'Run `claude auth login` manually, then re-run')
  ok('Claude login', 'signed in')
}

// ---- step 6: API-key warning (informational) --------------------------------
function warnApiKey() {
  if (process.env.ANTHROPIC_API_KEY)
    console.log(
      '  [NOTE] ANTHROPIC_API_KEY is set in this environment. Atelier ignores it at launch\n' +
        '         and uses your Claude subscription session instead (see electron/main.ts).'
    )
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
function checkBuild() {
  if (!buildStale()) return ok('Build', 'out/ is up to date')
  if (doctor) return fix('Build', 'out/ stale or missing — `npm run build` needed')
  console.log('  [....] Building...')
  const r = runLoud('npm', ['run', 'build'])
  if (r.status !== 0) fail(15, 'Build failed', 'Fix the build error above and re-run')
  ok('Build', 'rebuilt')
}

// ---- step 8: launch ---------------------------------------------------------
function launch() {
  if (noLaunch)
    return console.log('\n--no-launch: everything is ready. Start with run.bat / ./run.sh')
  if (command === 'dev') {
    console.log('\nStarting dev mode (electron-vite dev)...')
    const r = runLoud('npm', ['run', 'dev'])
    process.exit(r.status ?? 0)
  }
  console.log('\nStarting Atelier...')
  try {
    const child = spawn(electronBin(), [root], { cwd: root, detached: true, stdio: 'ignore' })
    child.unref()
  } catch (e) {
    fail(
      16,
      `Could not start Electron: ${e.message}`,
      'Re-run; if it persists, delete node_modules and re-run'
    )
  }
}

// ---- pipeline ---------------------------------------------------------------
console.log(`Atelier ${doctor ? 'doctor' : 'startup'} — ${root}\n`)
checkNode()
checkDeps()
if (!doctor || depsState() !== 'missing') checkElectron()
await checkClaudeCli()
await checkAuth()
warnApiKey()
checkBuild()
if (doctor) {
  if (issues.length === 0) {
    console.log('\nAll checks passed. `run.bat` / `./run.sh` will start immediately.')
    process.exit(0)
  }
  console.log(
    `\n${issues.length} issue(s) need fixing: ${issues.join(', ')}. Run run.bat / ./run.sh to fix them.`
  )
  process.exit(1)
}
launch()
