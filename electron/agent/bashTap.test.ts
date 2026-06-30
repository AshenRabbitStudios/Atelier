import { describe, it, expect } from 'vitest'
import { bashResponseText } from './bashTap.js'

// The Bash tap's PostToolUse handler turns the SDK's `tool_response` (typed `unknown`, and shaped
// differently across versions) into the faithful, ANSI-preserved text the bash-stream pane writes.
describe('bashResponseText', () => {
  it('passes a plain string through verbatim (ANSI preserved)', () => {
    expect(bashResponseText('hello\n\x1b[31mred\x1b[0m')).toBe('hello\n\x1b[31mred\x1b[0m')
  })

  it('joins stdout + stderr from an object response', () => {
    expect(bashResponseText({ stdout: 'out\n', stderr: 'err\n' })).toBe('out\nerr\n')
  })

  it('uses stdout alone when stderr is empty', () => {
    expect(bashResponseText({ stdout: 'only out', stderr: '' })).toBe('only out')
  })

  it('concatenates text content blocks', () => {
    expect(
      bashResponseText({
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' }
        ]
      })
    ).toBe('ab')
  })

  it('returns empty string for undefined (e.g. a tap with no output)', () => {
    expect(bashResponseText(undefined)).toBe('')
  })

  it('falls back to JSON for an unrecognized object shape', () => {
    expect(bashResponseText({ code: 0 })).toBe('{"code":0}')
  })
})
