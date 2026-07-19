import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssetReader, MAX_ASSET_BYTES } from './assets.js'

const CONV = 'conv-1'
const PNG = Buffer.from('89504e470d0a1a0a', 'hex') // PNG magic — enough to prove round-trip

describe('createAssetReader', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'atelier-assets-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads an image file as a base64 data URL with the right mime', async () => {
    writeFileSync(join(dir, 'logo.png'), PNG)
    const read = createAssetReader((_c, rel) => join(dir, rel))
    const r = await read(CONV, 'logo.png')
    expect(r).toEqual({ dataUrl: `data:image/png;base64,${PNG.toString('base64')}` })
  })

  it('serves a known non-image type with the right mime', async () => {
    const bytes = Buffer.from('%PDF-1.4')
    writeFileSync(join(dir, 'doc.pdf'), bytes)
    const read = createAssetReader((_c, rel) => join(dir, rel))
    const r = await read(CONV, 'doc.pdf')
    expect(r).toEqual({ dataUrl: `data:application/pdf;base64,${bytes.toString('base64')}` })
  })

  it('serves an unknown extension as application/octet-stream (no type refusal)', async () => {
    writeFileSync(join(dir, 'blob.xyz'), Buffer.from('data'))
    const read = createAssetReader((_c, rel) => join(dir, rel))
    const r = await read(CONV, 'blob.xyz')
    expect(r).toMatchObject({ dataUrl: expect.stringContaining('data:application/octet-stream') })
  })

  it('refuses a path the resolver rejects (out of bounds)', async () => {
    const read = createAssetReader(() => null)
    const r = await read(CONV, '../../etc/logo.png')
    expect(r).toMatchObject({ error: expect.stringContaining('outside the conversation folder') })
  })

  it('errors on a missing file rather than throwing', async () => {
    const read = createAssetReader((_c, rel) => join(dir, rel))
    const r = await read(CONV, 'nope.png')
    expect(r).toHaveProperty('error')
    expect(r).not.toHaveProperty('dataUrl')
  })

  it('refuses a file over the size cap', async () => {
    writeFileSync(join(dir, 'huge.png'), Buffer.alloc(MAX_ASSET_BYTES + 1))
    const read = createAssetReader((_c, rel) => join(dir, rel))
    const r = await read(CONV, 'huge.png')
    expect(r).toMatchObject({ error: expect.stringContaining('too large') })
  })
})
