// Tool Plugin backend (P4 S3). Runs as an isolated Electron utility process — it never touches the
// app or the renderer; it only answers tool calls the agent makes. One child per plugin, spawned by
// PluginBackendManager on the first call and killed on disable/reload (so a reloaded plugin always
// runs fresh code — CLAUDE.md: backend logic is never hot-reloaded in-process).
//
// Protocol: the parent posts { id, tool, input }; reply with { id, result } or { id, error }.
// The parent may also post lifecycle messages a backend can ignore or use: { hello: { pluginId,
// service } } on spawn, { enable/disable: { conversationId } } as a service plugin is toggled, and
// { bye: { conversationId } }. A SERVICE backend may push unsolicited { publish: { conversationId,
// channel, data } } messages (needs the plugin's data:publish permission). This example is an
// on-demand tool responder, so it just ignores the lifecycle messages.

const handlers = {
  reverse_text: (input) => {
    const text = input && input.text != null ? String(input.text) : ''
    return [...text].reverse().join('')
  },
  sum_numbers: (input) => Number(input.a) + Number(input.b)
}

process.parentPort.on('message', (e) => {
  const msg = (e && e.data) || {}
  if (msg.tool === undefined) return // a lifecycle message (hello/enable/disable/bye) — nothing to do
  const { id, tool, input } = msg
  try {
    const fn = handlers[tool]
    if (!fn) throw new Error(`unknown tool: ${tool}`)
    process.parentPort.postMessage({ id, result: fn(input || {}) })
  } catch (err) {
    process.parentPort.postMessage({ id, error: err && err.message ? err.message : String(err) })
  }
})
