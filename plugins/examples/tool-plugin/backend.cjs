// Tool Plugin backend (P4 S3). Runs as an isolated Electron utility process — it never touches the
// app or the renderer; it only answers tool calls the agent makes. One child per plugin, spawned by
// PluginBackendManager on the first call and killed on disable/reload (so a reloaded plugin always
// runs fresh code — CLAUDE.md: backend logic is never hot-reloaded in-process).
//
// Protocol: the parent posts { id, tool, input, conversationId? }; reply with { id, result } or
// { id, error }. The parent may also post lifecycle messages a backend can ignore or use:
// { hello: { pluginId, service, cwd? } } on spawn, { enable/disable: { conversationId, cwd? } } as a
// service plugin is toggled. A SERVICE backend may push unsolicited { publish: { conversationId,
// channel, data } } messages (needs data:publish), and may be called by its own pane via
// { id, rpc: { conversationId, op, params } } → reply { id, result } | { id, error } (A7). A backend
// may also request its per-(conversation, plugin) storage (needs the plugin's `storage` permission):
// post { id, storage: { op:'get'|'set'|'keys', conversationId, key?, value? } } and await the
// matching { id, result } | { id, error } reply (A8). This example is an on-demand tool responder,
// so it just ignores lifecycle/rpc; the storage helper below is shown as the documented pattern.

const handlers = {
  reverse_text: (input) => {
    const text = input && input.text != null ? String(input.text) : ''
    return [...text].reverse().join('')
  },
  sum_numbers: (input) => Number(input.a) + Number(input.b)
}

// A8 — the documented backend storage helper: correlate a storage request/response by id. Any
// backend can copy this to read config the pane wrote (even when the pane is closed).
let __storageSeq = 0
const __storagePending = new Map()
function storageRequest(op, conversationId, key, value) {
  return new Promise((resolve, reject) => {
    const id = `storage:${++__storageSeq}`
    __storagePending.set(id, { resolve, reject })
    process.parentPort.postMessage({ id, storage: { op, conversationId, key, value } })
  })
}

process.parentPort.on('message', (e) => {
  const msg = (e && e.data) || {}
  // A8 — resolve a pending storage request by id (its reply carries no tool/rpc field).
  if (msg.id !== undefined && __storagePending.has(msg.id)) {
    const p = __storagePending.get(msg.id)
    __storagePending.delete(msg.id)
    if (msg.error) p.reject(new Error(msg.error))
    else p.resolve(msg.result)
    return
  }
  // A7 — a panel RPC call to this backend's own service. This example has no service ops.
  if (msg.rpc) {
    process.parentPort.postMessage({ id: msg.id, error: 'this backend exposes no rpc ops' })
    return
  }
  if (msg.tool === undefined) return // a lifecycle message (hello/enable/disable) — nothing to do
  const { id, tool, input } = msg
  try {
    const fn = handlers[tool]
    if (!fn) throw new Error(`unknown tool: ${tool}`)
    process.parentPort.postMessage({ id, result: fn(input || {}) })
  } catch (err) {
    process.parentPort.postMessage({ id, error: err && err.message ? err.message : String(err) })
  }
})

// Referenced so a linter doesn't flag the documented helper as dead code in this example.
void storageRequest
