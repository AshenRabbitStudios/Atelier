import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createFileWriter, MAX_WRITE_BYTES } from './fileWrite.js'

const CONV = 'conv-1'

// The real cwd-scoping resolver used in main (resolveWithinCwd): resolve under `base`, refuse escape.
function scopedResolver(base: string) {
  return (_conversationId: string, rel: string): string | null => {
    const b = resolve(base)
    const full = resolve(b, rel)
    if (full !== b && !full.startsWith(b + sep)) return null
    return full
  }
}

describe('createFileWriter', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atelier-filewrite-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes a text file inside the cwd', async () => {
    const write = createFileWriter(scopedResolver(dir))
    const r = await write(CONV, 'out.txt', 'hello')
    expect(r).toEqual({ ok: true })
    expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe('hello')
  })

  it('creates parent directories', async () => {
    const write = createFileWriter(scopedResolver(dir))
    await write(CONV, 'reports/2026/summary.html', '<h1>hi</h1>')
    expect(readFileSync(join(dir, 'reports', '2026', 'summary.html'), 'utf8')).toBe('<h1>hi</h1>')
  })

  it('overwrites atomically (no temp junk left behind)', async () => {
    const write = createFileWriter(scopedResolver(dir))
    await write(CONV, 'a.txt', 'one')
    await write(CONV, 'a.txt', 'two')
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('two')
    // Directory holds only the target (no .a.txt.*.tmp survivors).
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(dir)).toEqual(['a.txt'])
  })

  it('refuses a path that escapes the cwd (..)', async () => {
    const write = createFileWriter(scopedResolver(dir))
    const r = await write(CONV, '../escape.txt', 'nope')
    expect(r).toMatchObject({ error: expect.stringContaining('outside the conversation folder') })
    expect(existsSync(join(dir, '..', 'escape.txt'))).toBe(false)
  })

  it('refuses when the resolver denies the path (null)', async () => {
    const write = createFileWriter(() => null)
    const r = await write(CONV, 'x.txt', 'nope')
    expect(r).toMatchObject({ error: expect.stringContaining('outside the conversation folder') })
  })

  it('refuses content over the size cap', async () => {
    const write = createFileWriter(scopedResolver(dir))
    const big = 'x'.repeat(MAX_WRITE_BYTES + 1)
    const r = await write(CONV, 'big.txt', big)
    expect(r).toMatchObject({ error: expect.stringContaining('too large') })
    expect(existsSync(join(dir, 'big.txt'))).toBe(false)
  })

  it('returns { error } instead of throwing on a write failure', async () => {
    // Target a path whose parent is a file → mkdir throws; surfaced as { error }.
    const write = createFileWriter(scopedResolver(dir))
    await write(CONV, 'afile', 'x')
    const r = await write(CONV, 'afile/child.txt', 'boom')
    expect(r).toHaveProperty('error')
    expect(r).not.toHaveProperty('ok')
  })
})
