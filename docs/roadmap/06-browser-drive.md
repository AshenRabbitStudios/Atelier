# 06 — Drive the browser surface: `exec` / `click` / `fill`

**Goal:** the `browser:embed` surface is read-only — `browser.read()` extracts
text/links/HTML, but nothing can interact with the page, so "the agent operates a website"
(fill a form, click through a flow, run a query on a dashboard) is impossible. Add driving
verbs. Under the threat model (remote pages ARE hostile), driving input _into_ the guest is
safe — the guard rails that matter constrain what comes _out_ (no bridge access, nav
filtering, capped extraction), and those already exist / land in Phase 0.

**Hard prerequisite:** Phase 0's webview items — the `will-navigate`/`will-redirect` http(s)
guard (ARCH_REVIEW P0 #2) and pane clipping (#3). Do not ship driving verbs into an
unguarded guest.

## Contract

Runtime additions under `atelier.browser` (permission `browser:embed`, unchanged):

```js
// Run JS in the page's main world; result must be JSON-serializable, capped at 64KB
// (over-cap → { error }). The page is untrusted: treat the RESULT as data, never as code.
exec: function (js) { return call('browser', 'exec', [js]) },
// Convenience wrappers implemented over exec (in the RELAY, not the runtime, so the
// capping/serialization discipline lives in one place):
// click the first match; returns { ok } or { error: 'no match' }.
click: function (selector) { return call('browser', 'click', [selector]) },
// set an input/textarea/select value + dispatch input/change events; returns { ok }|{ error }.
fill: function (selector, value) { return call('browser', 'fill', [selector, value]) }
```

Explicit non-goals for v1 (record, don't build): trusted key/mouse event synthesis via
`webContents.sendInputEvent` (needed only for pages that resist synthetic DOM events —
add if a real case appears), screenshots (`capturePage` — raster can't flow through text
context exports; revisit if/when the SDK context can carry images), scroll/hover verbs.

## Implementation

All in the `browser` namespace branch of `src/components/PluginPane.tsx` (the webview is
renderer-held; no new IPC — same as the existing `read`):

1. `exec`: require `webview && webviewReady` (same guard as `read`);
   `webview.executeJavaScript(js)` wrapped so that:
   - the script is wrapped in an IIFE + try/catch that returns
     `{ ok: value } | { error: message }` — a page-thrown error must come back as data,
     not a rejected relay promise semantically different from other verbs;
   - the returned value is `JSON.stringify`-ed inside the guest and size-checked
     (> 65 536 chars → `{ error: 'result too large' }`), then parsed host-side — this
     bounds memory AND guarantees serializability in one step (mirrors how
     `BROWSER_READ_SCRIPT` in `electron/shared/browserRead.ts` keeps everything
     ES5-ish/dependency-free; put the wrapper template next to it in that shared module so
     a future harness can regex-extract it the same way `scripts/verify-webview.mjs`
     does for the read script).
2. `click`/`fill`: build the JS from the shared wrapper with the selector/value passed
   through `JSON.stringify` (never string-concatenate raw user input into the script).
   `fill` must dispatch `input` and `change` events (framework-controlled inputs listen to
   these) and handle `select` elements.
3. After `click`, the page may navigate — the existing nav events
   (`did-navigate`/`did-start-loading` → `pushBrowserEvent`) already inform the plugin;
   no extra plumbing.
4. Extend `scripts/verify-webview.mjs` with drive cases (it already has the harness +
   local fixture pattern): click a link → nav event; fill + submit a form → fixture
   receives the value; exec returning an object; exec throwing; oversized result refused.
5. Docs: PLUGIN_API §3 browser block + authoring guide (including the "result is data"
   warning and the nav-guard prerequisite note).

## Containment invariants

- The guest still has no path to the bridge; drive verbs only _send_ into it.
- Results are size-capped, JSON-only, error-shaped — a hostile page can lie in its DOM but
  cannot break the relay or smuggle non-data.
- Nav guard (Phase 0) bounds where a click can take the guest.

## Acceptance criteria

1. `verify-webview.mjs` drive cases green (this harness is the acceptance vehicle — it
   exists precisely because webview mechanics can't be unit-tested).
2. Browser example plugin gains a minimal proof: agent (or pane UI) can `fill` + `click`
   on a live page and `read` the outcome.
3. Without `browser:embed`, all new verbs are refused.
4. Gate green; docs + DECISIONS updated.
