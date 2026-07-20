// agent-flow — service backend (the git reader). Runs as an isolated Electron utility process; it
// never touches the app or the renderer. It answers panel RPC (A7 — status/diff/log/commit/branches)
// and pushes `flow:status` onto the DataBus (A6/A8 lifecycle) on a debounced timer so the pane gets
// refreshes without polling. ALL git output is parsed backend-side (gitParse.cjs) into typed JSON;
// the pane never parses `.git` itself.
//
// Protocol (see /plugins/examples/tool-plugin/backend.cjs): parent posts
//   { hello: { pluginId, service, cwd? } }            on spawn
//   { enable | disable: { conversationId, cwd? } }     as the service is toggled per conversation
//   { id, rpc: { conversationId, op, params } }         a panel RPC call → reply { id, result|error }
// We reply pushes with { publish: { conversationId, channel, data } } (needs data:publish).
//
// Crash-resilience: git may be absent, on a non-repo cwd, or emit weird output. Every op returns
// { error } instead of throwing; the child never crashes on bad git state (that would trip the
// manager's crash-loop guard and wedge the plugin).

'use strict'

const { spawn } = require('node:child_process')
const path = require('node:path')
const {
  parseStatus,
  parseLog,
  parseBranches,
  parseWorktrees,
  parseDiff
} = require('./gitParse.cjs')

const DIFF_CAP = 500 * 1024 // 500KB — larger diffs are truncated with a marker (spec §3)
const LOG_CAP = 200 // recent commits cap (spec: History ~200)
const STATUS_DEBOUNCE_MS = 5000 // ≥5s debounce for the pushed flow:status refresh (spec §2 Changes)
const GIT_TIMEOUT_MS = 15000

// ── lifecycle state ────────────────────────────────────────────────────────
let cwd = null // learned from hello/enable
let conversationId = null // last-enabled conversation (the one we publish to)
let statusTimer = null

// ── git runner ───────────────────────────────────────────────────────────────
// Spawn git, capture stdout (up to maxBytes) and stderr. Resolves { code, stdout, stderr,
// truncated } — never rejects on a non-zero exit; the caller decides what a failure means. Rejects
// only if git can't be spawned at all (ENOENT), which the caller maps to a friendly error.
function runGit(args, maxBytes) {
  return new Promise((resolve, reject) => {
    if (!cwd) {
      reject(new Error('no cwd'))
      return
    }
    let child
    try {
      child = spawn('git', args, { cwd, windowsHide: true })
    } catch (err) {
      reject(err)
      return
    }
    const cap = maxBytes || 8 * 1024 * 1024
    const outChunks = []
    let outLen = 0
    let truncated = false
    let errText = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      reject(new Error('git timed out'))
    }, GIT_TIMEOUT_MS)

    child.stdout.on('data', (d) => {
      if (truncated) return
      if (outLen + d.length > cap) {
        outChunks.push(d.slice(0, Math.max(0, cap - outLen)))
        truncated = true
      } else {
        outChunks.push(d)
        outLen += d.length
      }
    })
    child.stderr.on('data', (d) => {
      if (errText.length < 8192) errText += d.toString('utf8')
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        code,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: errText,
        truncated
      })
    })
  })
}

// Is `cwd` inside a git work tree? A non-repo cwd (or missing git) → false, and every op then
// returns the friendly { error: 'not a git repository' } the spec mandates.
async function isRepo() {
  try {
    const r = await runGit(['rev-parse', '--is-inside-work-tree'], 4096)
    return r.code === 0 && r.stdout.trim() === 'true'
  } catch {
    return false // git absent (ENOENT) or timed out
  }
}

const NOT_A_REPO = { error: 'not a git repository' }

// ── RPC ops ──────────────────────────────────────────────────────────────────
async function opStatus() {
  if (!(await isRepo())) return NOT_A_REPO
  try {
    const r = await runGit(['status', '--porcelain=v2', '--branch', '-z'], 4 * 1024 * 1024)
    return parseStatus(r.stdout)
  } catch (err) {
    return { error: errMsg(err) }
  }
}

async function opDiff(params) {
  if (!(await isRepo())) return NOT_A_REPO
  const file = params && typeof params.file === 'string' ? params.file : null
  const staged = !!(params && params.staged)
  const commit = params && typeof params.commit === 'string' ? params.commit : null
  const args = ['diff', '--no-color']
  if (commit) {
    // A single commit's diff vs its first parent (spec: per-commit diff reusing the renderer).
    args.push(commit + '^!', '--')
  } else {
    if (staged) args.push('--staged')
  }
  if (file) {
    args.push('--')
    args.push(file)
  }
  try {
    const r = await runGit(args, DIFF_CAP)
    const parsed = parseDiff(r.stdout)
    parsed.truncated = r.truncated || false
    return parsed
  } catch (err) {
    return { error: errMsg(err) }
  }
}

async function opLog(params) {
  if (!(await isRepo())) return NOT_A_REPO
  const limit = clampInt(params && params.limit, 1, LOG_CAP, LOG_CAP)
  // US (\x1f) between fields, RS (\x1e) after each record — robust vs. subjects with newlines/pipes.
  const fmt = '\x1f%H\x1f%h\x1f%an\x1f%ae\x1f%aI\x1f%s\x1f%P\x1e'
  try {
    const r = await runGit(
      ['log', '-n', String(limit), '--no-color', '--pretty=format:' + fmt],
      8 * 1024 * 1024
    )
    return { commits: parseLog(r.stdout) }
  } catch (err) {
    return { error: errMsg(err) }
  }
}

async function opCommit(params) {
  if (!(await isRepo())) return NOT_A_REPO
  const hash = params && typeof params.hash === 'string' ? params.hash : null
  if (!hash) return { error: 'commit hash required' }
  try {
    // Details: one log record for the header, plus a name-status file list.
    const fmt = '\x1f%H\x1f%h\x1f%an\x1f%ae\x1f%aI\x1f%s\x1f%P\x1e'
    const head = await runGit(
      ['show', '-s', '--no-color', '--pretty=format:' + fmt, hash],
      64 * 1024
    )
    const commits = parseLog(head.stdout)
    const files = await runGit(
      ['show', '--no-color', '--name-status', '--pretty=format:', hash],
      1 * 1024 * 1024
    )
    const fileList = parseNameStatus(files.stdout)
    return { commit: commits[0] || null, files: fileList }
  } catch (err) {
    return { error: errMsg(err) }
  }
}

async function opBranches() {
  if (!(await isRepo())) return NOT_A_REPO
  try {
    const b = await runGit(['branch', '-vv', '--no-color'], 1 * 1024 * 1024)
    const w = await runGit(['worktree', 'list', '--porcelain'], 1 * 1024 * 1024)
    return { branches: parseBranches(b.stdout), worktrees: parseWorktrees(w.stdout) }
  } catch (err) {
    return { error: errMsg(err) }
  }
}

// `git show --name-status` lines: "<X>\t<path>" or "<R100>\t<old>\t<new>". Tolerant of blanks.
function parseNameStatus(raw) {
  const out = []
  if (typeof raw !== 'string') return out
  for (const line of raw.split('\n')) {
    const l = line.replace(/\s+$/, '')
    if (!l) continue
    const parts = l.split('\t')
    const status = (parts[0] || '')[0] || '?'
    if (status === 'R' || status === 'C') {
      out.push({ status, orig: parts[1] || '', path: parts[2] || parts[1] || '' })
    } else {
      out.push({ status, path: parts[1] || '' })
    }
  }
  return out
}

// ── flow:status push (debounced) ─────────────────────────────────────────────
function scheduleStatusPush() {
  if (statusTimer) return // already pending — debounce coalesces
  statusTimer = setTimeout(async () => {
    statusTimer = null
    if (!conversationId) return
    const status = await opStatus()
    publish('flow:status', status)
  }, STATUS_DEBOUNCE_MS)
}

function publish(channel, data) {
  if (!conversationId) return
  try {
    process.parentPort.postMessage({ publish: { conversationId, channel, data } })
  } catch {
    /* parent gone — nothing to do */
  }
}

// ── RPC dispatch ─────────────────────────────────────────────────────────────
const OPS = {
  status: opStatus,
  diff: opDiff,
  log: opLog,
  commit: opCommit,
  branches: opBranches
}

async function handleRpc(id, rpc) {
  const op = rpc && rpc.op
  const params = rpc && rpc.params
  // A panel RPC refreshes our knowledge of which conversation to publish to.
  if (rpc && rpc.conversationId) conversationId = rpc.conversationId
  const fn = OPS[op]
  if (!fn) {
    reply(id, undefined, `unknown op: ${op}`)
    return
  }
  try {
    const result = await fn(params)
    reply(id, result)
    // Any RPC touching the tree is a good moment to arm the debounced status push.
    scheduleStatusPush()
  } catch (err) {
    // Should not happen (ops catch internally) — but never let a throw escape to a crash.
    reply(id, undefined, errMsg(err))
  }
}

function reply(id, result, error) {
  try {
    if (error) process.parentPort.postMessage({ id, error })
    else process.parentPort.postMessage({ id, result })
  } catch {
    /* parent gone */
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
function errMsg(err) {
  if (err && err.code === 'ENOENT') return 'git not found'
  return (err && err.message) || String(err)
}
function clampInt(v, min, max, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.max(min, Math.min(max, Math.floor(n)))
}
function normCwd(c) {
  return c && typeof c === 'string' ? path.resolve(c) : null
}

// ── message loop ─────────────────────────────────────────────────────────────
process.parentPort.on('message', (e) => {
  const msg = (e && e.data) || {}
  try {
    if (msg.hello) {
      if (msg.hello.cwd) cwd = normCwd(msg.hello.cwd)
      return
    }
    if (msg.enable) {
      if (msg.enable.cwd) cwd = normCwd(msg.enable.cwd)
      if (msg.enable.conversationId) conversationId = msg.enable.conversationId
      // Push an initial status shortly after enable so a freshly-opened pane has data.
      scheduleStatusPush()
      return
    }
    if (msg.disable) {
      if (statusTimer) {
        clearTimeout(statusTimer)
        statusTimer = null
      }
      return
    }
    if (msg.rpc) {
      handleRpc(msg.id, msg.rpc)
      return
    }
    // agent-flow contributes no agent tools; a stray { tool } message is answered, not ignored.
    if (msg.tool !== undefined) {
      reply(msg.id, undefined, 'agent-flow exposes no tools')
      return
    }
  } catch (err) {
    // Absolute backstop — the loop must never throw out (that kills the child).
    if (msg && msg.id !== undefined) reply(msg.id, undefined, errMsg(err))
  }
})
