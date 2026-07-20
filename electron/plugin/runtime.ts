// The host runtime injected into every plugin sandbox. Served (as text/javascript) by the
// atelier-plugin:// protocol at atelier-plugin://__runtime__/atelier.js. It runs INSIDE the
// sandboxed plugin iframe and exposes `window.atelier`, implemented entirely over postMessage
// to the parent (renderer), which mediates every privileged call. The plugin never touches
// fs / IPC / SDK directly — this string is the whole capability surface a plugin sees.
//
// Kept as a bundled string (not a served file) so there is no runtime path resolution.
export const RUNTIME_JS = String.raw`
;(function () {
  // The asset host is the bare plugin id, OR a workspace host "w--<12-hex-key>--<id>" (Phase 7).
  // Decode to the BARE id so every RPC (storage/context/permission keyed by manifest id) matches;
  // must mirror decodePluginHost in electron/shared/plugins.ts.
  var __host = location.hostname
  var __wm = /^w--([0-9a-f]{12})--(.+)$/.exec(__host)
  var pluginId = __wm ? __wm[2] : __host
  var pending = new Map()
  var seq = 0
  var listeners = { load: [], unload: [], reload: [], context: [], browser: [], agent: [], resize: [] }
  var dataListeners = {} // channel -> [cb] for atelier.data.subscribe
  var notifClickListeners = [] // cb list for atelier.os.onNotificationClick (this plugin's notifs)
  var focusListeners = [] // cb list for atelier.os.onWindowFocusChange

  function call(ns, method, args) {
    return new Promise(function (resolve, reject) {
      var id = pluginId + ':' + ++seq
      pending.set(id, { resolve: resolve, reject: reject })
      parent.postMessage({ __atelier: true, id: id, pluginId: pluginId, ns: ns, method: method, args: args || [] }, '*')
    })
  }

  window.addEventListener('message', function (e) {
    var d = e.data
    if (!d || typeof d !== 'object') return
    if (d.__atelierReply && pending.has(d.id)) {
      var p = pending.get(d.id)
      pending.delete(d.id)
      if (d.ok) p.resolve(d.result)
      else p.reject(new Error(d.error || 'plugin host error'))
      return
    }
    if (d.__atelierEvent && d.event === 'theme' && d.payload) {
      // The host pushes the active theme's token values so the plugin body can use
      // var(--surface)/var(--text)/… and read as native across the iframe boundary.
      var root = document.documentElement
      for (var k in d.payload) root.style.setProperty(k, d.payload[k])
      return
    }
    if (d.__atelierEvent && d.event === 'data' && d.payload) {
      // A value arrived on a subscribed DataBus channel — dispatch to that channel's callbacks only.
      var dcbs = dataListeners[d.payload.channel]
      if (dcbs) {
        dcbs = dcbs.slice()
        for (var j = 0; j < dcbs.length; j++) {
          try { dcbs[j](d.payload.data) } catch (err) { /* isolate a plugin handler that threw */ }
        }
      }
      return
    }
    if (d.__atelierEvent && d.event === 'os' && d.payload) {
      // A4 — an OS event routed to this plugin: a click on ITS notification, or a window-focus change.
      var op = d.payload
      if (op.kind === 'notification-click') {
        var ncbs = notifClickListeners.slice()
        for (var n = 0; n < ncbs.length; n++) {
          try { ncbs[n]({ id: op.notificationId }) } catch (err) { /* isolate */ }
        }
      } else if (op.kind === 'window-focus') {
        var fcbs = focusListeners.slice()
        for (var f = 0; f < fcbs.length; f++) {
          try { fcbs[f](!!op.focused) } catch (err) { /* isolate */ }
        }
      }
      return
    }
    if (d.__atelierEvent && listeners[d.event]) {
      var cbs = listeners[d.event].slice()
      for (var i = 0; i < cbs.length; i++) {
        try { cbs[i](d.payload) } catch (err) { /* a plugin handler threw; isolate it */ }
      }
    }
  })

  window.atelier = {
    pluginId: pluginId,
    storage: {
      get: function (key) { return call('storage', 'get', [key]) },
      set: function (key, value) { return call('storage', 'set', [key, value]) },
      keys: function () { return call('storage', 'keys', []) }
    },
    layout: {
      dock: function (position) { return call('layout', 'dock', [position]) },
      float: function () { return call('layout', 'dock', ['float']) },
      setTitle: function (title) { return call('layout', 'setTitle', [title]) },
      // Fires with this pane's { w, h } on resize/dock changes. No permission (a pane may always
      // know its own size). Returns an unsubscribe.
      onResize: function (cb) {
        listeners.resize.push(cb)
        return function () {
          var i = listeners.resize.indexOf(cb)
          if (i >= 0) listeners.resize.splice(i, 1)
        }
      }
    },
    agent: {
      // Info about THIS pane's conversation: { id, title, cwd, status }. Needs "agent:read".
      info: function () { return call('agent', 'info', []) },
      // Subscribe to this conversation's AgentEvent stream (status, text deltas, tool_use/result,
      // result, error — the same union the chat consumes). Needs "agent:read". Returns unsubscribe.
      onEvent: function (cb) {
        listeners.agent.push(cb)
        call('agent', 'events', [])
        return function () {
          var i = listeners.agent.indexOf(cb)
          if (i >= 0) listeners.agent.splice(i, 1)
        }
      },
      // Send a user message into this conversation, exactly as if typed. Needs "agent:send".
      send: function (text) { return call('agent', 'send', [text]) },
      // Stage text into THIS conversation's chat composer WITHOUT sending (distinct from send).
      // Needs "agent:compose". Resolves { ok:true } | { error:'composer not open' }.
      compose: function (text) { return call('agent', 'compose', [text]) },
      // Bounded backfill of this conversation's normalized AgentEvent trace (oldest→newest, default
      // 200, max 1000), for a pane that mounts mid-conversation. Needs "agent:read".
      history: function (limit) { return call('agent', 'history', [limit]) }
    },
    fs: {
      // Non-recursive, cwd-scoped directory listing (dir cwd-relative, ''/undefined = root).
      // Resolves { entries:[{ name, kind, size?, mtime?, ignored }], truncated? } | { error }.
      // Needs "fs:list".
      list: function (dir) { return call('fs', 'list', [dir]) }
    },
    shell: {
      // Open a cwd-relative file in the OS default handler. Needs "shell:open".
      // Resolves { ok:true } | { error }. Refuses paths outside the conversation cwd.
      openPath: function (path) { return call('shell', 'openPath', [path]) }
    },
    os: {
      // Show an OS notification (silent unless sound:true). tag coalesces same-tag notifications
      // from THIS plugin. Host-side rate-capped. Needs "os:notify". Resolves { id } | { error }.
      notify: function (n) { return call('os', 'notify', [n]) },
      // Fires with { id } when one of THIS plugin's notifications is clicked. Returns unsubscribe.
      onNotificationClick: function (cb) {
        notifClickListeners.push(cb)
        return function () {
          var i = notifClickListeners.indexOf(cb)
          if (i >= 0) notifClickListeners.splice(i, 1)
        }
      },
      // Flash the taskbar frame (on/off). Needs "os:notify".
      flashFrame: function (on) { return call('os', 'flashFrame', [!!on]) },
      // Best-effort taskbar badge count (no-op where unsupported). Needs "os:notify".
      setBadgeCount: function (n) { return call('os', 'setBadgeCount', [n]) },
      // Whether the Atelier window currently has OS focus. Needs "os:notify".
      isWindowFocused: function () { return call('os', 'isWindowFocused', []) },
      // Fires with the new focus boolean on every window focus/blur. Returns unsubscribe.
      onWindowFocusChange: function (cb) {
        focusListeners.push(cb)
        call('os', 'subscribeFocus', []) // tell the host to route focus events to this pane
        return function () {
          var i = focusListeners.indexOf(cb)
          if (i >= 0) focusListeners.splice(i, 1)
        }
      }
    },
    backend: {
      // Call an operation on THIS plugin's own service backend (the plugin must declare a service
      // backend). Host posts { id, rpc: { conversationId, op, params } }; resolves the backend's
      // result (any JSON) or rejects with its error. 30s default / 600s max, like a tool.
      call: function (op, params, timeoutMs) { return call('backend', 'call', [op, params, timeoutMs]) }
    },
    context: {
      // A context document (this plugin's contextExports). get/set the full value; the agent
      // sees it as context every turn and updates it via its tool. Needs permission "context".
      get: function (key) { return call('context', 'get', [key]) },
      set: function (key, value) { return call('context', 'set', [key, value]) }
    },
    data: {
      // Subscribe to a DataBus channel (e.g. "file:docs/STATUS.md"); cb fires with each value,
      // including the current one on subscribe. Needs permission "data:subscribe".
      subscribe: function (channel, cb) {
        if (!dataListeners[channel]) dataListeners[channel] = []
        dataListeners[channel].push(cb)
        return call('data', 'subscribe', [channel])
      },
      unsubscribe: function (channel) {
        delete dataListeners[channel]
        return call('data', 'unsubscribe', [channel])
      },
      // Publish a value onto a channel for other subscribers. Needs permission "data:publish".
      publish: function (channel, value) { return call('data', 'publish', [channel, value]) },
      // Recent values on a channel (oldest→newest, bounded), for a pane that mounts after data
      // has already flowed. Needs "data:subscribe" (+ "net:fetch" for url: channels).
      history: function (channel, limit) { return call('data', 'history', [channel, limit]) },
      // Read a cwd-scoped image (referenced by rendered content) as a { dataUrl } | { error }.
      // The binary sibling of a file: subscribe; needs the same "data:subscribe" permission.
      readAsset: function (path) { return call('data', 'readAsset', [path]) },
      // Write a UTF-8 text file at a cwd-relative path (parents created). Needs "data:write".
      // Returns { ok:true } | { error }. Refuses paths outside the conversation cwd.
      writeFile: function (path, content) { return call('data', 'writeFile', [path, content]) }
    },
    net: {
      // Host-side HTTP request (the pane has no network of its own). Needs "net:fetch".
      // opts: { method?, headers?, body?, timeoutMs?, binary? }. Resolves to
      // { status, statusText, headers, bodyText? | bodyBase64? } | { error }.
      fetch: function (url, opts) { return call('net', 'fetch', [url, opts || {}]) }
    },
    browser: {
      // A live, host-owned Chromium surface composited over this pane (permission "browser:embed").
      // The plugin only drives it and reads extracted state; the page can never reach this bridge.
      // Nav events arrive via on('browser', cb) with payloads like
      // { type:'nav'|'loading'|'loaded'|'failed'|'title', url, title, canGoBack, canGoForward, error }.
      open: function (url) { return call('browser', 'open', [url]) },
      close: function () { return call('browser', 'close', []) },
      back: function () { return call('browser', 'back', []) },
      forward: function () { return call('browser', 'forward', []) },
      reload: function () { return call('browser', 'reload', []) },
      stop: function () { return call('browser', 'stop', []) },
      // Where the surface sits, in this pane's viewport coordinates ({ x, y, w, h }).
      setBounds: function (rect) { return call('browser', 'setBounds', [rect]) },
      // Extract the live page's { url, title, text, links, html? } for the context exports.
      read: function (opts) { return call('browser', 'read', [opts || {}]) },
      // Drive the page. The page is UNTRUSTED — treat every result as data, never as code.
      // exec runs JS in the page and returns { ok:<json> } | { error } (result capped at 64KB).
      exec: function (js) { return call('browser', 'exec', [js]) },
      // Convenience over exec: click the first match / set an input's value (+ input/change events).
      click: function (selector) { return call('browser', 'click', [selector]) },
      fill: function (selector, value) { return call('browser', 'fill', [selector, value]) }
    },
    on: function (event, cb) {
      if (listeners[event]) listeners[event].push(cb)
    }
  }

  // Tell the host we are live so it can rehydrate storage and fire our 'load' hook.
  parent.postMessage({ __atelier: true, pluginId: pluginId, ns: 'lifecycle', method: 'ready', args: [] }, '*')
})()
`
