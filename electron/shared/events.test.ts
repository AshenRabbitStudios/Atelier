import { describe, it, expect } from 'vitest'
import {
  CreateOptsSchema,
  SendSchema,
  PermissionDecisionSchema,
  AnswerQuestionSchema,
  SetPermissionModeSchema,
  SetEffortSchema
} from './events.js'

// The IPC boundary contract: main MUST reject malformed renderer payloads. These lock
// the validation behavior so a regression can't silently widen the trust boundary.
describe('IPC boundary schemas', () => {
  describe('CreateOptsSchema', () => {
    it('accepts a minimal valid payload', () => {
      expect(CreateOptsSchema.safeParse({ cwd: '/work' }).success).toBe(true)
    })

    it('accepts optional model and title', () => {
      const r = CreateOptsSchema.safeParse({ cwd: '/work', model: 'opus', title: 'Atelier' })
      expect(r.success).toBe(true)
    })

    it('rejects an empty cwd', () => {
      expect(CreateOptsSchema.safeParse({ cwd: '' }).success).toBe(false)
    })

    it('rejects a missing cwd', () => {
      expect(CreateOptsSchema.safeParse({}).success).toBe(false)
    })

    it('rejects a non-string cwd', () => {
      expect(CreateOptsSchema.safeParse({ cwd: 42 }).success).toBe(false)
    })
  })

  describe('SendSchema', () => {
    it('allows empty text but requires an instanceId', () => {
      expect(SendSchema.safeParse({ instanceId: 'i1', text: '' }).success).toBe(true)
      expect(SendSchema.safeParse({ instanceId: '', text: 'hi' }).success).toBe(false)
    })
  })

  describe('PermissionDecisionSchema', () => {
    it('accepts allow/deny with optional allowAlways', () => {
      expect(
        PermissionDecisionSchema.safeParse({
          instanceId: 'i1',
          requestId: 'r1',
          behavior: 'allow',
          allowAlways: true
        }).success
      ).toBe(true)
      expect(
        PermissionDecisionSchema.safeParse({ instanceId: 'i1', requestId: 'r1', behavior: 'deny' })
          .success
      ).toBe(true)
    })

    it('rejects an unknown behavior', () => {
      expect(
        PermissionDecisionSchema.safeParse({ instanceId: 'i1', requestId: 'r1', behavior: 'maybe' })
          .success
      ).toBe(false)
    })
  })

  describe('AnswerQuestionSchema', () => {
    it('accepts a string→string answers map', () => {
      const r = AnswerQuestionSchema.safeParse({
        instanceId: 'i1',
        requestId: 'r1',
        answers: { 'Which lib?': 'Zod' }
      })
      expect(r.success).toBe(true)
    })

    it('rejects non-string answer values', () => {
      const r = AnswerQuestionSchema.safeParse({
        instanceId: 'i1',
        requestId: 'r1',
        answers: { 'Which lib?': 3 }
      })
      expect(r.success).toBe(false)
    })
  })

  describe('enum payloads', () => {
    it('accepts every valid permission mode and effort level', () => {
      for (const mode of [
        'default',
        'acceptEdits',
        'plan',
        'bypassPermissions',
        'dontAsk',
        'auto'
      ]) {
        expect(SetPermissionModeSchema.safeParse({ instanceId: 'i1', mode }).success).toBe(true)
      }
      for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
        expect(SetEffortSchema.safeParse({ instanceId: 'i1', effort }).success).toBe(true)
      }
    })

    it('rejects an out-of-range effort level', () => {
      expect(SetEffortSchema.safeParse({ instanceId: 'i1', effort: 'turbo' }).success).toBe(false)
    })
  })
})
