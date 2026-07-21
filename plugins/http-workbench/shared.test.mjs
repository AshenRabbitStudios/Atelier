// http-workbench shared helpers — the secret-hygiene and size-discipline rules (design
// §5.2/§8) are the parts that must not regress silently.
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const HW = require('./shared.cjs')

describe('redactHeaders', () => {
  it('redacts auth-style headers, keeps others', () => {
    const r = HW.redactHeaders({
      Authorization: 'Bearer sk-abcdef123456',
      'X-Api-Key': 'key-98765',
      Accept: 'application/json'
    })
    expect(r.Authorization).toBe('Bear•••56')
    expect(r.Authorization).not.toContain('abcdef')
    expect(r['X-Api-Key']).not.toContain('98765')
    expect(r.Accept).toBe('application/json')
  })

  it('short secrets are fully masked', () => {
    expect(HW.redactHeaders({ authorization: 'abc' }).authorization).toBe('•••')
  })
})

describe('normalizeRequest', () => {
  it('rejects non-http(s) URLs and unknown methods', () => {
    expect(HW.normalizeRequest({ url: 'ftp://x' }).error).toMatch(/http/)
    expect(HW.normalizeRequest({ url: 'http://x', method: 'TRACE' }).error).toMatch(/method/)
    expect(HW.normalizeRequest(null).error).toBeTruthy()
  })

  it('drops cookie headers and strips body on GET/HEAD', () => {
    const r = HW.normalizeRequest({
      url: 'http://localhost:3000/a',
      method: 'get',
      headers: { Cookie: 'session=1', Accept: 'text/plain' },
      body: 'ignored'
    })
    expect(r.req.method).toBe('GET')
    expect(r.req.headers.Cookie).toBeUndefined()
    expect(r.req.headers.Accept).toBe('text/plain')
    expect(r.req.body).toBeUndefined()
  })

  it('clamps timeout to the host max', () => {
    expect(HW.normalizeRequest({ url: 'http://x', timeoutMs: 999999 }).req.timeoutMs).toBe(60000)
    expect(HW.normalizeRequest({ url: 'http://x' }).req.timeoutMs).toBe(30000)
  })
})

describe('makeEntry + appendHistory', () => {
  const req = {
    method: 'POST',
    url: 'http://localhost:3000/api',
    headers: { Authorization: 'Bearer tok-123456789' },
    body: '{"a":1}'
  }

  it('stores a capped, redacted entry for a success', () => {
    const e = HW.makeEntry(
      'agent',
      req,
      {
        status: 201,
        statusText: 'Created',
        headers: { 'content-type': 'application/json' },
        bodyText: '{"id":1}',
        bodySize: 8
      },
      42,
      1000
    )
    expect(e.source).toBe('agent')
    expect(e.status).toBe(201)
    expect(e.timingMs).toBe(42)
    expect(e.reqHeaders.Authorization).not.toContain('tok-123456789')
    expect(e.respBody).toBe('{"id":1}')
  })

  it('caps the stored response body and flags truncation', () => {
    const big = 'x'.repeat(200 * 1024)
    const e = HW.makeEntry(
      'user',
      req,
      { status: 200, headers: {}, bodyText: big, bodySize: big.length },
      5,
      1000
    )
    expect(e.respBody.length).toBe(64 * 1024)
    expect(e.respBodyTruncated).toBe(true)
  })

  it('error outcomes store an error entry, not a fake response', () => {
    const e = HW.makeEntry('user', req, { error: 'request timed out (30000ms)' }, 30000, 1000)
    expect(e.error).toMatch(/timed out/)
    expect(e.status).toBeUndefined()
  })

  it('appendHistory is newest-first and FIFO-capped', () => {
    let list = []
    for (let i = 0; i < HW.HISTORY_CAP + 10; i++) {
      list = HW.appendHistory(list, { id: 'e' + i, ts: i })
    }
    expect(list.length).toBe(HW.HISTORY_CAP)
    expect(list[0].id).toBe('e' + (HW.HISTORY_CAP + 9))
  })
})

describe('buildDigest', () => {
  it('renders a compact most-recent-first digest with no full bodies', () => {
    const history = [
      HW.makeEntry(
        'agent',
        { method: 'POST', url: 'http://l/api/users', headers: {}, body: '{"name":"Ada"}' },
        {
          status: 201,
          statusText: 'Created',
          headers: {},
          bodyText: '{"id":"u_88"}',
          bodySize: 13
        },
        34,
        1000
      ),
      HW.makeEntry(
        'user',
        { method: 'GET', url: 'http://l/api/users/u_88', headers: {} },
        { status: 200, statusText: 'OK', headers: {}, bodyText: 'y'.repeat(5000), bodySize: 5000 },
        12,
        2000
      )
    ]
    const d = HW.buildDigest(history)
    expect(d).toContain('POST http://l/api/users → 201 Created · 34ms · agent')
    expect(d).toContain('GET http://l/api/users/u_88 → 200 OK · 12ms · user')
    expect(d).not.toContain('y'.repeat(300)) // snippets are trimmed
    expect(d).toContain('(body 4.9 KB)')
  })

  it('empty history yields a friendly line', () => {
    expect(HW.buildDigest([])).toMatch(/No HTTP requests/)
  })
})
