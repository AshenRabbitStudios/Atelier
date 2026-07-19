// Electron-mechanics harness for the browser:embed surface (the parts the vitest gate cannot
// exercise): webview attach + hardening, real page load, the shared readback script, popup
// denial → in-place navigation, guest history, and non-http attach rejection.
//
// Run: npx electron scripts/verify-webview.mjs
//
// Deliberately standalone: its own hidden BrowserWindow, its own temp userData, a local HTTP
// fixture — it never touches the running app or its conversation storage. The guard wiring
// mirrors installWebviewGuard in electron/main.ts (keep in sync by hand); the readback script is
// regex-extracted from electron/shared/browserRead.ts so the exact production script is tested.
import { app, BrowserWindow } from 'electron'
import http from 'node:http'
import os from 'node:os'
import { join, dirname } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(new URL(import.meta.url)))

app.setPath('userData', join(os.tmpdir(), 'atelier-webview-verify'))

const readSource = readFileSync(join(__dirname, '../electron/shared/browserRead.ts'), 'utf8')
const readMatch = readSource.match(/String\.raw`([\s\S]*?)`/)
if (!readMatch) {
  console.error('FAIL setup: could not extract BROWSER_READ_SCRIPT from browserRead.ts')
  process.exit(1)
}
const READ_SCRIPT = readMatch[1]

const results = []
function record(ok, name, detail = '') {
  results.push({ ok, name })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_r, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), ms))
  ])
}

const once = (emitter, event) => new Promise((resolve) => emitter.once(event, resolve))

// ---- Fixture pages ----
const PAGE_1 = `<!doctype html><html><head><title>Fixture Page</title></head><body>
  <h1>Atelier fixture</h1><p>hello fixture text</p>
  <a href="/page2">go two</a>
  <input placeholder="searchbox" />
  <button onclick="window.open('/page2')">open popup</button>
</body></html>`
const PAGE_2 = `<!doctype html><html><head><title>Fixture Two</title></head><body>
  <p>second page</p><a href="/page1">back home</a>
</body></html>`

async function main() {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html')
    res.end(req.url === '/page2' ? PAGE_2 : PAGE_1)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`

  await app.whenReady()

  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true
    }
  })

  // Mirror of installWebviewGuard (electron/main.ts).
  let blockedAttach = false
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    const src = params.src ?? ''
    if (src && !/^(https?:|about:blank)/i.test(src)) {
      blockedAttach = true
      event.preventDefault()
    }
  })
  const attachedGuest = new Promise((resolve) => {
    win.webContents.once('did-attach-webview', (_e, guest) => resolve(guest))
  })
  win.webContents.on('did-attach-webview', (_e, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      // Deferred, mirroring main.ts: navigating from inside the handler can wedge the open.
      if (/^https?:/i.test(url)) setImmediate(() => void guest.loadURL(url))
      return { action: 'deny' }
    })
    // Post-attach nav guard (Phase 0 / main.ts installWebviewGuard): confine every navigation to
    // http(s) so page JS / redirects can't reach file:// etc.
    const blockNonHttp = (details) => {
      if (details.url && !/^https?:\/\//i.test(details.url)) details.preventDefault()
    }
    guest.on('will-navigate', blockNonHttp)
    guest.on('will-redirect', blockNonHttp)
  })

  // Mirror of the browserRead.ts drive builders (keep in sync by hand, like the guard above).
  const execScript = (js) =>
    '(async function () { try { var __r = await eval(' +
    JSON.stringify(js) +
    "); var __s; try { __s = JSON.stringify(__r); } catch (e) { return { error: 'not serializable' }; } " +
    "if (__s === undefined) return { ok: null }; if (__s.length > 65536) return { error: 'too large' }; " +
    'return { ok: JSON.parse(__s) }; } catch (e) { return { error: (e && e.message) ? e.message : String(e) }; } })()'
  const clickScript = (sel) =>
    '(function () { var el = document.querySelector(' +
    JSON.stringify(sel) +
    "); if (!el) return { error: 'no match' }; el.click(); return { ok: true }; })()"
  const fillScript = (sel, val) =>
    '(function () { var el = document.querySelector(' +
    JSON.stringify(sel) +
    "); if (!el) return { error: 'no match' }; " +
    "var d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value'); " +
    'if (d && d.set) d.set.call(el, ' +
    JSON.stringify(val) +
    '); else el.value = ' +
    JSON.stringify(val) +
    "; el.dispatchEvent(new Event('input', { bubbles: true })); " +
    "el.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true }; })()"

  const hostHtml = `<!doctype html><html><body style="margin:0">
    <webview id="wv" src="${base}/page1" allowpopups style="width:780px;height:560px"></webview>
  </body></html>`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(hostHtml))

  // 1. Attach + first load.
  const guest = await withTimeout(attachedGuest, 8000, 'webview attach')
  record(true, 'webview attaches under webviewTag:true')
  if (guest.isLoading()) await withTimeout(once(guest, 'did-finish-load'), 8000, 'first load')
  record(guest.getURL().endsWith('/page1'), 'guest loads local http fixture', guest.getURL())

  // 2. Guest is privilege-free (the hardening took).
  const nodeLeak = await guest.executeJavaScript('typeof require + "/" + typeof process')
  record(nodeLeak === 'undefined/undefined', 'guest has no node globals', nodeLeak)

  // 3. The production readback script.
  const page = await guest.executeJavaScript(READ_SCRIPT)
  record(page && page.title === 'Fixture Page', 'read: title', String(page && page.title))
  record(
    typeof page.text === 'string' && page.text.includes('hello fixture text'),
    'read: visible text'
  )
  const linkStr = (page.links || []).join('\n')
  record(
    linkStr.includes('a: go two') && linkStr.includes('/page2'),
    'read: interactive links with href',
    linkStr.split('\n')[0]
  )
  record(linkStr.includes('input: searchbox'), 'read: input placeholder captured')

  // 4. window.open → denied as a window, navigates in place.
  const before = BrowserWindow.getAllWindows().length
  const navved = once(guest, 'did-navigate')
  // userGesture=true: window.open without user activation is popup-blocked before the handler.
  await guest.executeJavaScript(`window.open('${base}/page2'); true`, true)
  await withTimeout(navved, 8000, 'popup in-place navigation')
  record(BrowserWindow.getAllWindows().length === before, 'window.open opens no OS window')
  record(guest.getURL().endsWith('/page2'), 'window.open navigated in place', guest.getURL())

  // 5. Guest history works (webview-first back/forward).
  record(guest.navigationHistory.canGoBack() === true, 'guest history: canGoBack after nav')
  const backNav = once(guest, 'did-navigate')
  guest.navigationHistory.goBack()
  await withTimeout(backNav, 8000, 'goBack navigation')
  record(guest.getURL().endsWith('/page1'), 'guest history: goBack returns', guest.getURL())

  // 6. Non-http src is refused at attach.
  await win.webContents.executeJavaScript(`
    const w = document.createElement('webview')
    w.setAttribute('src', 'file:///C:/')
    document.body.appendChild(w)
    true
  `)
  await new Promise((r) => setTimeout(r, 1500))
  record(blockedAttach, 'non-http src attach is prevented')

  // 7. Bonus, non-fatal (needs network): a real https site loads + reads back.
  try {
    const httpsNav = once(guest, 'did-finish-load')
    await guest.loadURL('https://example.com/')
    await withTimeout(httpsNav, 10000, 'https load')
    const ext = await guest.executeJavaScript(READ_SCRIPT)
    console.log(
      ext && /Example Domain/i.test(String(ext.title))
        ? 'PASS (bonus) https example.com loads + reads back'
        : `SKIP (bonus) https loaded but unexpected title: ${ext && ext.title}`
    )
  } catch (err) {
    console.log(`SKIP (bonus) https check — ${err && err.message ? err.message : err}`)
  }

  // 8. Drive verbs (Phase 6): exec / fill / click on the local fixture.
  await guest.loadURL(`${base}/page1`)
  await withTimeout(once(guest, 'did-finish-load'), 8000, 'reload page1 for drive tests')
  const execRes = await guest.executeJavaScript(execScript('document.title'))
  record(execRes && execRes.ok === 'Fixture Page', 'exec returns page data as { ok }')
  const execErr = await guest.executeJavaScript(execScript('throw new Error("boom")'))
  record(
    execErr && /boom/.test(execErr.error || ''),
    'exec surfaces a thrown error as { error }',
    execErr && execErr.error
  )
  const fillRes = await guest.executeJavaScript(fillScript('input', 'typed value'))
  const readback = await guest.executeJavaScript('document.querySelector("input").value')
  record(
    fillRes && fillRes.ok === true && readback === 'typed value',
    'fill sets an input value + fires events',
    readback
  )
  const noMatch = await guest.executeJavaScript(clickScript('#nope'))
  record(noMatch && /no match/.test(noMatch.error || ''), 'click on no match returns { error }')
  const clickNav = once(guest, 'did-navigate')
  const clickRes = await guest.executeJavaScript(clickScript('a'))
  await withTimeout(clickNav, 8000, 'click navigation')
  record(
    clickRes && clickRes.ok === true && guest.getURL().endsWith('/page2'),
    'click follows a link',
    guest.getURL()
  )

  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  server.close()
  app.exit(failed ? 1 : 0)
}

setTimeout(() => {
  console.error('FAIL harness: global 45s timeout')
  app.exit(1)
}, 45000)

main().catch((err) => {
  console.error('FAIL harness:', err && err.message ? err.message : err)
  app.exit(1)
})
