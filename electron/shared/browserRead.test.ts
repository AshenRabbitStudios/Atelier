import { describe, it, expect } from 'vitest'
import {
  browserExecScript,
  browserClickScript,
  browserFillScript,
  BROWSER_EXEC_MAX_CHARS
} from './browserRead.js'

describe('browser drive script builders', () => {
  it('exec wraps user JS via eval, size-caps the result, and returns ok/error data', () => {
    const s = browserExecScript('document.title')
    expect(s).toContain('await eval(' + JSON.stringify('document.title'))
    expect(s).toContain(String(BROWSER_EXEC_MAX_CHARS))
    expect(s).toContain('JSON.parse')
    expect(s).toMatch(/error/)
  })

  it('exec embeds user code as a string literal (no breakout)', () => {
    const evil = '"); window.__pwned = 1; ("'
    const s = browserExecScript(evil)
    // The payload appears ONLY inside a JSON string literal passed to eval — never as bare code.
    expect(s).toContain(JSON.stringify(evil))
  })

  it('click embeds the selector as a JSON literal and clicks the match', () => {
    const evil = '"]; window.x = 1; //'
    const s = browserClickScript(evil)
    expect(s).toContain(JSON.stringify(evil))
    expect(s).toContain('document.querySelector(')
    expect(s).toContain('.click()')
  })

  it('fill embeds selector + value safely and fires input/change', () => {
    const s = browserFillScript('#name', 'hello "world"')
    expect(s).toContain(JSON.stringify('#name'))
    expect(s).toContain(JSON.stringify('hello "world"'))
    expect(s).toContain("dispatchEvent(new Event('input'")
    expect(s).toContain("dispatchEvent(new Event('change'")
  })
})
