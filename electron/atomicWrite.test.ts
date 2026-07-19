import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from './atomicWrite.js'

describe('writeFileAtomic', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atelier-atomic-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes the file with the given contents', () => {
    const f = join(dir, 'a.json')
    writeFileAtomic(f, '{"x":1}')
    expect(readFileSync(f, 'utf8')).toBe('{"x":1}')
  })

  it('creates missing parent directories', () => {
    const f = join(dir, 'deep', 'nested', 'b.json')
    writeFileAtomic(f, 'hi')
    expect(readFileSync(f, 'utf8')).toBe('hi')
  })

  it('overwrites an existing file', () => {
    const f = join(dir, 'c.json')
    writeFileSync(f, 'old')
    writeFileAtomic(f, 'new')
    expect(readFileSync(f, 'utf8')).toBe('new')
  })

  it('leaves no temp files behind on success', () => {
    const f = join(dir, 'd.json')
    writeFileAtomic(f, 'x')
    writeFileAtomic(f, 'y')
    // Only the target should remain — no orphaned .tmp siblings.
    expect(readdirSync(dir)).toEqual(['d.json'])
  })

  it('throws (leaving no temp junk) when the parent cannot be created', () => {
    // A file where a directory is expected → mkdirSync of the parent throws ENOTDIR before any
    // temp file is written. Asserts the failure propagates and nothing is left behind.
    const fileAsParent = join(dir, 'iamafile')
    writeFileSync(fileAsParent, 'x')
    const target = join(fileAsParent, 'child.json')
    expect(() => writeFileAtomic(target, 'boom')).toThrow()
    expect(readdirSync(dir)).toEqual(['iamafile'])
  })
})
