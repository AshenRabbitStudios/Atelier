// terminal backend (kind: panel, service). Owns one live PTY per conversation, spawned in the
// conversation's cwd when the plugin is enabled there and killed when it's disabled. Streams the
// shell's raw output onto the `terminal:out` DataBus channel (the pane writes it into xterm) and
// accepts keystrokes / resize / restart from the pane over the A7 RPC path.
//
// The PTY native addon (@homebridge/node-pty-prebuilt-multiarch) ships a prebuilt binary that loads
// under Electron's ABI without a rebuild (verified: Electron 42, NODE_MODULE_VERSION 146, Win x64) —
// so this backend runs in the utilityProcess exactly like the other service backends.
//
// Protocol (see plugins/http-workbench/backend.cjs and electron/plugin/PluginBackendManager.ts):
//   parent → { hello: { pluginId, service, cwd } }                 lifecycle, no reply
//   parent → { enable: { conversationId, cwd } }                   spawn/attach a shell for that conv
//   parent → { disable: { conversationId } }                       kill that conv's shell
//   parent → { id, rpc: { conversationId, op, params } }           reply { id, result } | { id, error }
//   backend → { publish: { conversationId, channel, data } }       needs data:publish (shell output)
// Every failure is a { id, error } reply — never a throw across the boundary.

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

const OUT_CHANNEL = 'terminal:out'
// Cap the per-conversation replay buffer so a long-lived shell can't grow unbounded; a pane that
// (re)opens mid-session gets the tail of the scrollback, which is what matters.
const BUFFER_CAP = 256 * 1024

let pty = null
let ptyLoadError = null
try {
  pty = require('@homebridge/node-pty-prebuilt-multiarch')
} catch (err) {
  ptyLoadError = (err && err.message) || String(err)
}

// conversationId → { term, buffer, cols, rows, shell, cwd, exited }
const sessions = new Map()
// Best-effort cwd for a conversation whose shell is spawned lazily (before its `enable` arrives).
let defaultCwd = process.cwd()

function post(msg) {
  try {
    process.parentPort.postMessage(msg)
  } catch {
    /* parent gone */
  }
}
function publish(conversationId, data) {
  post({ publish: { conversationId, channel: OUT_CHANNEL, data } })
}

// Resolve the shell to spawn. Honors ATELIER_TERMINAL_SHELL; otherwise prefers a real bash
// (git-bash) on Windows so "terminal" means bash as expected, falling back to PowerShell then cmd.
function resolveShell() {
  const override = process.env.ATELIER_TERMINAL_SHELL
  if (override && override.trim()) return { file: override.trim(), args: [] }

  if (process.platform === 'win32') {
    const candidates = [
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
      process.env['ProgramFiles(x86)'] &&
        path.join(process.env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
      process.env.LOCALAPPDATA &&
        path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')
    ].filter(Boolean)
    // Also scan PATH for bash.exe.
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (dir) candidates.push(path.join(dir, 'bash.exe'))
    }
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return { file: c, args: ['-i', '-l'] }
      } catch {
        /* keep looking */
      }
    }
    // No bash found — fall back to cmd.exe (PowerShell would need its own arg handling).
    return { file: process.env.ComSpec || 'cmd.exe', args: [] }
  }
  return { file: process.env.SHELL || '/bin/bash', args: [] }
}

function appendBuffer(session, data) {
  session.buffer += data
  if (session.buffer.length > BUFFER_CAP) {
    session.buffer = session.buffer.slice(session.buffer.length - BUFFER_CAP)
  }
}

// Spawn (or replace) the shell for a conversation. Returns the session, or throws with a clear
// message if the native module never loaded.
function spawnSession(conversationId, cwd) {
  if (!pty)
    throw new Error(`terminal PTY unavailable — native module failed to load: ${ptyLoadError}`)
  killSession(conversationId)

  const useCwd = safeCwd(cwd || defaultCwd)
  const { file, args } = resolveShell()
  const cols = 80
  const rows = 24
  const term = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: useCwd,
    env: process.env
  })
  const session = {
    term,
    buffer: '',
    cols,
    rows,
    shell: file,
    cwd: useCwd,
    exited: false
  }
  sessions.set(conversationId, session)

  term.onData((data) => {
    appendBuffer(session, data)
    publish(conversationId, data)
  })
  term.onExit(({ exitCode, signal }) => {
    session.exited = true
    const note = `\r\n\x1b[2m[process exited${exitCode != null ? ` — code ${exitCode}` : ''}${
      signal ? ` signal ${signal}` : ''
    }]\x1b[0m\r\n`
    appendBuffer(session, note)
    publish(conversationId, note)
  })
  return session
}

function killSession(conversationId) {
  const session = sessions.get(conversationId)
  if (!session) return
  sessions.delete(conversationId)
  try {
    session.term.kill()
  } catch {
    /* already gone */
  }
}

// Keep a shell inside a real directory: fall back to the OS temp dir if the requested cwd is gone.
function safeCwd(cwd) {
  try {
    if (cwd && fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) return cwd
  } catch {
    /* fall through */
  }
  return os.tmpdir()
}

// Ensure a session exists for this conversation (lazy-spawn if the pane attaches before `enable`).
function ensureSession(conversationId) {
  let session = sessions.get(conversationId)
  if (!session || session.exited)
    session = spawnSession(conversationId, session ? session.cwd : null)
  return session
}

function handleRpc(id, conversationId, op, params) {
  const p = params || {}
  switch (op) {
    case 'attach': {
      const session = ensureSession(conversationId)
      return post({
        id,
        result: {
          buffer: session.buffer,
          cols: session.cols,
          rows: session.rows,
          pid: session.term.pid,
          shell: session.shell,
          cwd: session.cwd,
          exited: session.exited
        }
      })
    }
    case 'write': {
      const session = ensureSession(conversationId)
      if (!session.exited && typeof p.data === 'string') session.term.write(p.data)
      return post({ id, result: { ok: true } })
    }
    case 'resize': {
      const session = sessions.get(conversationId)
      const cols = Math.max(1, Math.floor(p.cols || 0))
      const rows = Math.max(1, Math.floor(p.rows || 0))
      if (session && !session.exited && cols && rows) {
        session.cols = cols
        session.rows = rows
        try {
          session.term.resize(cols, rows)
        } catch {
          /* a mid-exit resize can race; harmless */
        }
      }
      return post({ id, result: { ok: true } })
    }
    case 'restart': {
      const prev = sessions.get(conversationId)
      const session = spawnSession(conversationId, prev ? prev.cwd : null)
      return post({ id, result: { ok: true, pid: session.term.pid, shell: session.shell } })
    }
    default:
      return post({ id, error: `unknown terminal op: ${op}` })
  }
}

process.parentPort.on('message', (e) => {
  const msg = (e && e.data) || {}
  try {
    if (msg.hello) {
      if (msg.hello.cwd) defaultCwd = msg.hello.cwd
      return
    }
    if (msg.enable) {
      const { conversationId, cwd } = msg.enable
      if (cwd) defaultCwd = cwd
      // (Re)spawn a fresh shell for this conversation when it's enabled.
      if (pty) spawnSession(conversationId, cwd)
      return
    }
    if (msg.disable) {
      killSession(msg.disable.conversationId)
      return
    }
    if (msg.rpc && typeof msg.id === 'number') {
      const { conversationId, op, params } = msg.rpc
      handleRpc(msg.id, conversationId, op, params)
      return
    }
  } catch (err) {
    if (typeof msg.id === 'number') {
      post({ id: msg.id, error: err && err.message ? err.message : String(err) })
    }
  }
})
