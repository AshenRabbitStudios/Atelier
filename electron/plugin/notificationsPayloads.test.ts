// Headless unit tests for the notifications plugin's PURE delivery logic: per-channel HTTP request
// builders (channels.cjs) and the notify_user rate limiter (ratelimit.cjs). These modules live under
// plugins/notifications (lint-ignored sandbox code) but are framework-free CommonJS, so we import
// them directly here to exercise them in Node. Live channel delivery (real webhooks/tokens) cannot
// run in CI — see docs/PROGRESS.md's live-spot-check list.
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { ManifestSchema } from '../shared/plugins.js'

const require_ = createRequire(import.meta.url)
const channels = require_(
  resolve(__dirname, '../../plugins/notifications/channels.cjs')
) as typeof import('../../plugins/notifications/channels.cjs')
const { createRateLimiter } = require_(
  resolve(__dirname, '../../plugins/notifications/ratelimit.cjs')
) as typeof import('../../plugins/notifications/ratelimit.cjs')

const notice = {
  title: 'Hi',
  body: 'Body text',
  urgency: 'high',
  event: 'agent-initiated',
  conversation: 'conv-1',
  ts: 1234
}

describe('notifications manifest', () => {
  it('validates against the real ManifestSchema (schema is ground truth)', () => {
    const raw = JSON.parse(
      readFileSync(resolve(__dirname, '../../plugins/notifications/manifest.json'), 'utf8')
    )
    const parsed = ManifestSchema.safeParse(raw)
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues, null, 2))
    expect(parsed.data.id).toBe('notifications')
    expect(parsed.data.kind).toBe('both')
    expect(parsed.data.service).toBe(true)
    expect(parsed.data.tools.map((t) => t.name)).toContain('notify_user')
    // The status export must be readonly (agent cannot overwrite it) — secrets never round-trip.
    expect(parsed.data.contextExports[0]).toMatchObject({ key: 'notify_status', readonly: true })
  })
})

describe('channel payload builders', () => {
  it('generic webhook posts JSON with the notice fields + parses a JSON headers string', () => {
    const req = channels.buildWebhook(
      { url: 'https://x.test/h', headers: '{"X-Auth":"tok"}' },
      notice
    ) as { url: string; method: string; headers: Record<string, string>; body: string }
    expect(req.url).toBe('https://x.test/h')
    expect(req.method).toBe('POST')
    expect(req.headers['Content-Type']).toBe('application/json')
    expect(req.headers['X-Auth']).toBe('tok')
    const body = JSON.parse(req.body)
    expect(body).toMatchObject({
      title: 'Hi',
      body: 'Body text',
      urgency: 'high',
      event: 'agent-initiated'
    })
  })

  it('webhook reports a clear error for missing url and for bad headers JSON', () => {
    expect(channels.buildWebhook({}, notice)).toEqual({ error: 'webhook channel missing url' })
    expect(channels.buildWebhook({ url: 'u', headers: '{not json' }, notice)).toEqual({
      error: 'webhook headers is not valid JSON'
    })
  })

  it('discord wraps title/body into a content field', () => {
    const req = channels.buildDiscord({ url: 'https://d.test/w' }, notice) as { body: string }
    expect(JSON.parse(req.body)).toEqual({ content: '**Hi**\nBody text' })
  })

  it('slack wraps title/body into a text field', () => {
    const req = channels.buildSlack({ url: 'https://s.test/w' }, notice) as { body: string }
    expect(JSON.parse(req.body)).toEqual({ text: '*Hi*\nBody text' })
  })

  it('telegram targets the bot sendMessage endpoint with chat_id + text', () => {
    const req = channels.buildTelegram({ botToken: 'T', chatId: '99' }, notice) as {
      url: string
      body: string
    }
    expect(req.url).toBe('https://api.telegram.org/botT/sendMessage')
    expect(JSON.parse(req.body)).toEqual({ chat_id: '99', text: 'Hi\nBody text' })
  })

  it('telegram errors clearly on missing token / chat id', () => {
    expect(channels.buildTelegram({ chatId: '1' }, notice)).toEqual({
      error: 'telegram channel missing bot token'
    })
    expect(channels.buildTelegram({ botToken: 't' }, notice)).toEqual({
      error: 'telegram channel missing chat id'
    })
  })

  it('ntfy defaults the server, sets Title + priority, and passes a token as Bearer', () => {
    const req = channels.buildNtfy({ topic: 'alerts', token: 'k' }, notice) as {
      url: string
      headers: Record<string, string>
      body: string
    }
    expect(req.url).toBe('https://ntfy.sh/alerts')
    expect(req.headers.Priority).toBe('5') // high
    expect(req.headers.Authorization).toBe('Bearer k')
    expect(req.body).toBe('Body text')
    // low urgency maps to priority 2, normal to 3.
    const low = channels.buildNtfy({ topic: 't' }, { ...notice, urgency: 'low' }) as {
      headers: Record<string, string>
    }
    expect(low.headers.Priority).toBe('2')
  })

  it('pushover form-encodes token/user/message with mapped priority', () => {
    const req = channels.buildPushover({ appToken: 'A', userKey: 'U' }, notice) as {
      url: string
      body: string
    }
    expect(req.url).toBe('https://api.pushover.net/1/messages.json')
    const params = new URLSearchParams(req.body)
    expect(params.get('token')).toBe('A')
    expect(params.get('user')).toBe('U')
    expect(params.get('message')).toBe('Body text')
    expect(params.get('priority')).toBe('1') // high
  })

  it('buildRequest dispatches by type and rejects unknown types', () => {
    const req = channels.buildRequest(
      { type: 'discord', config: { url: 'https://d/w' } },
      notice
    ) as {
      body: string
    }
    expect(JSON.parse(req.body).content).toContain('Hi')
    expect(channels.buildRequest({ type: 'nope', config: {} }, notice)).toEqual({
      error: 'unknown channel type: nope'
    })
  })

  it('no secret value leaks into a builder ERROR string', () => {
    const err = channels.buildTelegram({ botToken: 'SECRET-TOKEN' }, notice) as { error: string }
    expect(err.error).not.toContain('SECRET-TOKEN')
  })
})

describe('rate limiter (notify_user, per conversation)', () => {
  it('allows the first ping, blocks a second within 10s', () => {
    const rl = createRateLimiter()
    expect(rl.check('c', 0).ok).toBe(true)
    const blocked = rl.check('c', 5_000)
    expect(blocked.ok).toBe(false)
    expect(blocked.error).toMatch(/one notification per 10s/)
  })

  it('allows again after the 10s interval', () => {
    const rl = createRateLimiter()
    expect(rl.check('c', 0).ok).toBe(true)
    expect(rl.check('c', 10_000).ok).toBe(true)
  })

  it('caps at 10 per hour and re-opens after the window slides', () => {
    const rl = createRateLimiter()
    // Space 10 pings 10s apart (0,10s,…,90s) — all allowed by the interval rule.
    for (let i = 0; i < 10; i++) {
      expect(rl.check('c', i * 10_000).ok).toBe(true)
    }
    // 11th within the hour (at 100s) — interval ok but hourly cap hit.
    const capped = rl.check('c', 100_000)
    expect(capped.ok).toBe(false)
    expect(capped.error).toMatch(/10 notifications per hour/)
    // Slide past the hour from the first ping: at 3_600_001ms the first drops out, room for one.
    expect(rl.check('c', 3_600_001).ok).toBe(true)
  })

  it('is isolated per conversation', () => {
    const rl = createRateLimiter()
    expect(rl.check('a', 0).ok).toBe(true)
    expect(rl.check('b', 0).ok).toBe(true) // different conversation, not blocked
    expect(rl.check('a', 1_000).ok).toBe(false)
  })
})
