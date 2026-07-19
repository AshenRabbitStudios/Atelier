// The extraction script the host runs inside a browser-surface guest page (its own process — no
// bridge access) to produce what a pane's context exports need: visible text + interactive
// elements. Shared so PluginPane (the real consumer) and scripts/verify-webview.mjs (the Electron
// mechanics harness, which regex-extracts the template body from this file's source) exercise the
// exact same script. Kept dependency-free ES5-ish because it executes in arbitrary remote pages.
export const BROWSER_READ_SCRIPT = String.raw`(function () {
  var text = ((document.body && document.body.innerText) || '').slice(0, 6000)
  var nodes = document.querySelectorAll('a, button, input, select, textarea, [role=button]')
  var links = []
  for (var i = 0; i < nodes.length && links.length < 40; i++) {
    var n = nodes[i]
    var t = ((n.innerText || n.value || n.getAttribute('aria-label') || n.getAttribute('placeholder') || '') + '').trim().slice(0, 60)
    if (!t) continue
    var href = n.getAttribute ? n.getAttribute('href') : null
    links.push('• ' + n.tagName.toLowerCase() + ': ' + t + (href ? ' → ' + String(href).slice(0, 80) : ''))
  }
  return { url: location.href, title: document.title, text: text, links: links }
})()`
