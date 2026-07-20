import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createFsLister, MAX_ENTRIES } from './fsList.js'

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

describe('createFsLister', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atelier-fslist-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('lists files and directories at one level (non-recursive)', () => {
    writeFileSync(join(dir, 'a.txt'), 'hello')
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'nested.txt'), 'deep') // must NOT appear at root
    const list = createFsLister(scopedResolver(dir), () => dir)
    const r = list(CONV, '')
    expect('entries' in r).toBe(true)
    if (!('entries' in r)) return
    const names = r.entries.map((e) => e.name).sort()
    expect(names).toEqual(['a.txt', 'sub'])
    const a = r.entries.find((e) => e.name === 'a.txt')!
    expect(a.kind).toBe('file')
    expect(a.size).toBe(5)
    expect(r.entries.find((e) => e.name === 'sub')!.kind).toBe('dir')
  })

  it('lists a subdirectory when dir is given', () => {
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'nested.txt'), 'deep')
    const list = createFsLister(scopedResolver(dir), () => dir)
    const r = list(CONV, 'sub')
    if (!('entries' in r)) throw new Error('expected entries')
    expect(r.entries.map((e) => e.name)).toEqual(['nested.txt'])
  })

  it('flags built-in ignores (.git, node_modules)', () => {
    mkdirSync(join(dir, '.git'))
    mkdirSync(join(dir, 'node_modules'))
    writeFileSync(join(dir, 'keep.txt'), 'x')
    const list = createFsLister(scopedResolver(dir), () => dir)
    const r = list(CONV, '')
    if (!('entries' in r)) throw new Error('expected entries')
    expect(r.entries.find((e) => e.name === '.git')!.ignored).toBe(true)
    expect(r.entries.find((e) => e.name === 'node_modules')!.ignored).toBe(true)
    expect(r.entries.find((e) => e.name === 'keep.txt')!.ignored).toBe(false)
  })

  it('flags .gitignore matches (exact, *.ext, dir/)', () => {
    writeFileSync(join(dir, '.gitignore'), 'secret.txt\n*.log\nbuild/\n')
    writeFileSync(join(dir, 'secret.txt'), 'x')
    writeFileSync(join(dir, 'app.log'), 'x')
    writeFileSync(join(dir, 'app.js'), 'x')
    mkdirSync(join(dir, 'build'))
    const list = createFsLister(scopedResolver(dir), () => dir)
    const r = list(CONV, '')
    if (!('entries' in r)) throw new Error('expected entries')
    const byName = Object.fromEntries(r.entries.map((e) => [e.name, e.ignored]))
    expect(byName['secret.txt']).toBe(true)
    expect(byName['app.log']).toBe(true)
    expect(byName['build']).toBe(true)
    expect(byName['app.js']).toBe(false)
  })

  it('refuses a path that escapes the cwd (..)', () => {
    const list = createFsLister(scopedResolver(dir), () => dir)
    const r = list(CONV, '../..')
    expect(r).toMatchObject({ error: expect.stringContaining('outside the conversation folder') })
  })

  it('returns { error } when the resolver denies the path (null)', () => {
    const list = createFsLister(
      () => null,
      () => dir
    )
    const r = list(CONV, 'x')
    expect(r).toMatchObject({ error: expect.stringContaining('outside the conversation folder') })
  })

  it('returns { error } instead of throwing on a non-existent directory', () => {
    const list = createFsLister(scopedResolver(dir), () => dir)
    const r = list(CONV, 'nope')
    expect(r).toHaveProperty('error')
  })

  it('caps entries at MAX_ENTRIES with truncated:true', () => {
    for (let i = 0; i < MAX_ENTRIES + 10; i++) writeFileSync(join(dir, `f${i}.txt`), '')
    const list = createFsLister(scopedResolver(dir), () => dir)
    const r = list(CONV, '')
    if (!('entries' in r)) throw new Error('expected entries')
    expect(r.entries.length).toBe(MAX_ENTRIES)
    expect(r.truncated).toBe(true)
  })
})
