import { describe, it, expect } from 'vitest'
import { resolve, sep } from 'node:path'
import { createPathOpener } from './openPath.js'

const CONV = 'conv-1'
const BASE = resolve('/workspace')

function scopedResolver(base: string) {
  return (_conversationId: string, rel: string): string | null => {
    const b = resolve(base)
    const full = resolve(b, rel)
    if (full !== b && !full.startsWith(b + sep)) return null
    return full
  }
}

describe('createPathOpener', () => {
  it('opens a cwd-relative path via the injected opener', async () => {
    const opened: string[] = []
    const open = createPathOpener(scopedResolver(BASE), async (abs) => {
      opened.push(abs)
      return '' // shell.openPath: '' means success
    })
    const r = await open(CONV, 'docs/readme.md')
    expect(r).toEqual({ ok: true })
    expect(opened).toEqual([resolve(BASE, 'docs/readme.md')])
  })

  it('refuses a path that escapes the cwd (..) without calling the opener', async () => {
    let called = false
    const open = createPathOpener(scopedResolver(BASE), async () => {
      called = true
      return ''
    })
    const r = await open(CONV, '../../etc/passwd')
    expect(r).toMatchObject({ error: expect.stringContaining('outside the conversation folder') })
    expect(called).toBe(false)
  })

  it('surfaces the shell error string as { error }', async () => {
    const open = createPathOpener(scopedResolver(BASE), async () => 'no application to open .xyz')
    const r = await open(CONV, 'file.xyz')
    expect(r).toEqual({ error: 'no application to open .xyz' })
  })

  it('returns { error } instead of throwing when the opener throws', async () => {
    const open = createPathOpener(scopedResolver(BASE), async () => {
      throw new Error('boom')
    })
    const r = await open(CONV, 'file.txt')
    expect(r).toEqual({ error: 'boom' })
  })
})
