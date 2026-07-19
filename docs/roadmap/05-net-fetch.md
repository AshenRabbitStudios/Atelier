# 05 — Real network verb: `net.fetch` proxy + any-mime `readAsset`

**Goal:** today's network reach is the `url:` DataBus channel — one-shot, GET-only,
text-only, 2 MB, no headers (`DataBus.ts` `createUrlSource`). A plugin cannot talk to a
local dev server's JSON API, POST to a webhook, send an auth header, or fetch binary. Add a
real host-side fetch verb under the existing `net:fetch` permission, and widen `readAsset`
beyond images. The `url:` channel stays as-is (it is the right shape for "tail this URL as
a document"; the new verb is for API calls).

## Contract

Runtime:

```js
net: {
  // Host-side HTTP request (the pane itself has no network). Needs "net:fetch".
  // opts: { method?, headers?, body?, timeoutMs?, binary? } — see caps below.
  // Returns { status, statusText, headers, bodyText? , bodyBase64? } or { error }.
  fetch: function (url, opts) { return call('net', 'fetch', [url, opts || {}]) }
}
```

Caps and rules (constants in one place, documented in the guide):

- http(s) only; redirects followed (5 max — Node fetch default is fine).
- `timeoutMs` default 15 000, max 60 000.
- Request body ≤ 2 MB (string or base64 via `{ bodyBase64 }` — pick ONE representation and
  document it; recommendation: `body` is always a string, callers base64 binary themselves
  and set their own content-type header).
- Response ≤ 4 MB. `binary: true` → `bodyBase64`, else decoded text (`bodyText`).
- Returned `headers`: a plain lowercase-keyed object (drop set-cookie — the proxy shares
  main's session; don't leak cookie state into panes).
- Methods: GET/POST/PUT/PATCH/DELETE/HEAD. Forbid header `cookie` in requests (same
  reasoning).
- Every failure is `{ error }` (assets.ts pattern), never a throw across the relay.

## Implementation

1. `electron/plugin/netFetch.ts` (new, unit-testable with an injected `fetchImpl` exactly
   like `createUrlSource` — copy its test approach): `createNetFetcher(fetchImpl)` →
   `(url, opts) => Promise<FetchResult>`. All caps/validation here.
2. IPC `pluginNetFetch` + Zod schema (validate method enum, header record of strings, caps
   pre-checked in main too), preload method, relay branch (`net` namespace, gate
   `net:fetch`), main handler **with main-side permission + enablement check**.
3. `readAsset` widening (`electron/plugin/assets.ts`): replace the image-only `IMAGE_MIME`
   gate with a general extension→mime map (images + `.pdf`, `.mp3`, `.wav`, `.mp4`,
   `.webm`, `.txt`, `.json`, fallback `application/octet-stream`). Keep the 10 MB cap and
   the cwd resolver untouched. Rationale for the original image-only rule was
   anti-exfiltration — obsolete under the corrected framing (DECISIONS 2026-07-19); the
   pane could already read any text via `file:` channels anyway. Update the module comment,
   which still argues the security rationale.
4. Docs: PLUGIN_API §3/§4 (`net:fetch` now grants both the `url:` channel and `net.fetch`),
   authoring guide + sync test.

## Containment invariants

- Network stays in main (a pane still has zero direct network); caps bound memory; cookie
  isolation keeps app session state out of panes.
- No streaming in v1 (a poller uses repeated fetches; a true stream is a follow-up —
  record, don't build).

## Acceptance criteria

1. Unit tests on `netFetch.ts`: method validation, timeout abort, size-cap refusal (declared
   content-length AND undeclared oversize body), binary base64 round-trip, header
   filtering, `{ error }` shapes.
2. End-to-end: a scratch pane POSTs JSON to a local fixture server and renders the
   response; without `net:fetch` it is refused at relay AND main.
3. `readAsset` serves a PDF data: URL; oversize still refused; existing image paths
   unchanged (existing tests still pass).
4. Gate green; docs + DECISIONS updated.
