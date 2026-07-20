import { describe, it, expect, vi } from 'vitest'
import { createNetFetcher, NET_MAX_RESPONSE_BYTES, NET_MAX_REQUEST_BYTES } from './netFetch.js'

const ok = (body: string, init?: { status?: number; headers?: Record<string, string> }) =>
  new Response(body, {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', ...init?.headers }
  })

describe('createNetFetcher', () => {
  it('performs a GET and returns decoded text + lowercased headers', async () => {
    const fetchImpl = vi.fn(async () => ok('{"hi":1}'))
    const net = createNetFetcher(fetchImpl as unknown as typeof fetch)
    const r = await net('https://example.com/api')
    expect(r).toMatchObject({ status: 200, bodyText: '{"hi":1}' })
    expect((r as { headers: Record<string, string> }).headers['content-type']).toContain(
      'application/json'
    )
  })

  it('sends method, headers, and body — but drops a cookie header', async () => {
    const fetchImpl = vi.fn(async () => ok('done'))
    const net = createNetFetcher(fetchImpl as unknown as typeof fetch)
    await net('https://example.com/hook', {
      method: 'post',
      headers: { authorization: 'Bearer t', cookie: 'session=secret' },
      body: '{"x":1}'
    })
    const init = fetchImpl.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"x":1}')
    expect(init.headers).toMatchObject({ authorization: 'Bearer t' })
    expect((init.headers as Record<string, string>).cookie).toBeUndefined()
  })

  it('returns bodyBase64 when binary is requested', async () => {
    const fetchImpl = vi.fn(async () => ok('AB'))
    const net = createNetFetcher(fetchImpl as unknown as typeof fetch)
    const r = await net('https://example.com/bin', { binary: true })
    expect(r).toMatchObject({ bodyBase64: Buffer.from('AB').toString('base64') })
    expect(r).not.toHaveProperty('bodyText')
  })

  it('rejects a non-http(s) URL and a malformed URL', async () => {
    const net = createNetFetcher(vi.fn() as unknown as typeof fetch)
    expect(await net('file:///etc/passwd')).toMatchObject({
      error: expect.stringContaining('http')
    })
    expect(await net('not a url')).toMatchObject({ error: expect.stringContaining('not a valid') })
  })

  it('rejects an unsupported method', async () => {
    const net = createNetFetcher(vi.fn() as unknown as typeof fetch)
    expect(await net('https://x.test', { method: 'TRACE' })).toMatchObject({
      error: expect.stringContaining('unsupported method')
    })
  })

  it('refuses an over-cap request body', async () => {
    const fetchImpl = vi.fn(async () => ok(''))
    const net = createNetFetcher(fetchImpl as unknown as typeof fetch)
    const r = await net('https://x.test', {
      method: 'POST',
      body: 'x'.repeat(NET_MAX_REQUEST_BYTES + 1)
    })
    expect(r).toMatchObject({ error: expect.stringContaining('request body too large') })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('refuses a response whose declared content-length exceeds the cap', async () => {
    const fetchImpl = vi.fn(async () =>
      ok('x', { headers: { 'content-length': String(NET_MAX_RESPONSE_BYTES + 1) } })
    )
    const net = createNetFetcher(fetchImpl as unknown as typeof fetch)
    expect(await net('https://x.test')).toMatchObject({
      error: expect.stringContaining('too large')
    })
  })

  it('returns { error } when the fetch throws (and on timeout abort)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const net = createNetFetcher(fetchImpl as unknown as typeof fetch)
    expect(await net('https://x.test')).toMatchObject({ error: 'ECONNREFUSED' })
  })

  it('does not send a body on GET/HEAD', async () => {
    const fetchImpl = vi.fn(async () => ok('ok'))
    const net = createNetFetcher(fetchImpl as unknown as typeof fetch)
    await net('https://x.test', { method: 'GET', body: 'ignored' })
    expect((fetchImpl.mock.calls[0][1] as RequestInit).body).toBeUndefined()
  })
})
