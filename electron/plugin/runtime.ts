// The host runtime injected into every plugin sandbox. Served (as text/javascript) by the
// atelier-plugin:// protocol at atelier-plugin://__runtime__/atelier.js. It runs INSIDE the
// sandboxed plugin iframe and exposes `window.atelier`, implemented entirely over postMessage
// to the parent (renderer), which mediates every privileged call. The plugin never touches
// fs / IPC / SDK directly — this string is the whole capability surface a plugin sees.
//
// Kept as a bundled string (not a served file) so there is no runtime path resolution.
export const RUNTIME_JS = String.raw`
;(function () {
  var pluginId = location.hostname
  var pending = new Map()
  var seq = 0
  var listeners = { load: [], unload: [], reload: [], context: [] }
  var dataListeners = {} // channel -> [cb] for atelier.data.subscribe

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
      setTitle: function (title) { return call('layout', 'setTitle', [title]) }
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
      publish: function (channel, value) { return call('data', 'publish', [channel, value]) }
    },
    on: function (event, cb) {
      if (listeners[event]) listeners[event].push(cb)
    }
  }

  // Tell the host we are live so it can rehydrate storage and fire our 'load' hook.
  parent.postMessage({ __atelier: true, pluginId: pluginId, ns: 'lifecycle', method: 'ready', args: [] }, '*')
})()
`
