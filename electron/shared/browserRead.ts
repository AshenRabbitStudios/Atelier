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

// Max serialized size of an exec result (guest-side check) — bounds memory and forces a small,
// data-shaped return. Over-cap → { error }.
export const BROWSER_EXEC_MAX_CHARS = 65536

// ---- Drive scripts (Phase 6): run in the untrusted guest page; the RESULT is data, never code ----
// All three build a self-contained script that embeds caller input via JSON.stringify (never raw
// concatenation, so a selector/value can't break out into code) and returns { ok } | { error }. Kept
// here (shared, dependency-free) so PluginPane and scripts/verify-webview.mjs run the exact same code.

/** Wrap arbitrary plugin-supplied JS: eval it (so statements OR an expression both yield a value),
 *  JSON round-trip + size-check the result, and turn any throw into `{ error }` data. */
export function browserExecScript(userJs: string): string {
  return (
    '(async function () {' +
    '  try {' +
    '    var __r = await eval(' +
    JSON.stringify(String(userJs)) +
    ');' +
    '    var __s;' +
    "    try { __s = JSON.stringify(__r); } catch (e) { return { error: 'result is not JSON-serializable' }; }" +
    '    if (__s === undefined) return { ok: null };' +
    '    if (__s.length > ' +
    BROWSER_EXEC_MAX_CHARS +
    ") return { error: 'result too large (> 64KB)' };" +
    '    return { ok: JSON.parse(__s) };' +
    '  } catch (e) { return { error: (e && e.message) ? e.message : String(e) }; }' +
    '})()'
  )
}

/** Click the first element matching `selector`. Returns { ok:true } | { error }. */
export function browserClickScript(selector: string): string {
  const sel = JSON.stringify(String(selector))
  return (
    '(function () {' +
    '  var el = document.querySelector(' +
    sel +
    ');' +
    "  if (!el) return { error: 'no match for ' + " +
    sel +
    ' };' +
    '  el.click();' +
    '  return { ok: true };' +
    '})()'
  )
}

/** Set the value of an input/textarea/select and fire input+change (framework-controlled inputs
 *  listen to those). Uses the native value setter so React et al. register the change. */
export function browserFillScript(selector: string, value: string): string {
  const sel = JSON.stringify(String(selector))
  const val = JSON.stringify(String(value))
  return (
    '(function () {' +
    '  var el = document.querySelector(' +
    sel +
    ');' +
    "  if (!el) return { error: 'no match for ' + " +
    sel +
    ' };' +
    '  var proto = (el instanceof HTMLTextAreaElement) ? HTMLTextAreaElement.prototype' +
    '            : (el instanceof HTMLSelectElement) ? HTMLSelectElement.prototype' +
    '            : HTMLInputElement.prototype;' +
    "  var d = Object.getOwnPropertyDescriptor(proto, 'value');" +
    '  if (d && d.set) d.set.call(el, ' +
    val +
    '); else el.value = ' +
    val +
    ';' +
    "  el.dispatchEvent(new Event('input', { bubbles: true }));" +
    "  el.dispatchEvent(new Event('change', { bubbles: true }));" +
    '  return { ok: true };' +
    '})()'
  )
}
