import { describe, it, expect } from 'vitest'
import {
  AnswerQuestionSchema,
  ConversationRefSchema,
  CreateOptsSchema,
  EditSaveSchema,
  ForkSchema,
  ImportSessionSchema,
  InstanceRefSchema,
  PermissionDecisionSchema,
  PluginBackendCallSchema,
  PluginBadgeCountSchema,
  PluginComposeSchema,
  PluginConvPluginSchema,
  PluginContextGetSchema,
  PluginContextSetSchema,
  PluginDataChannelSchema,
  PluginDataHistorySchema,
  PluginDataPublishSchema,
  PluginFlashFrameSchema,
  PluginFsListSchema,
  PluginHistorySchema,
  PluginIdSchema,
  PluginNetFetchSchema,
  PluginNotifySchema,
  PluginReadAssetSchema,
  PluginShellOpenSchema,
  PluginStorageGetSchema,
  PluginStorageKeysSchema,
  PluginStorageSetSchema,
  PluginWriteFileSchema,
  RenameSchema,
  SaveLayoutSchema,
  SendSchema,
  SessionsForSchema,
  SetAutoResumeSchema,
  SetEffortSchema,
  SetModelSchema,
  SetPermissionModeSchema,
  SetPluginEnabledSchema,
  SwitchBranchSchema
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

// ---- Schemas not yet covered by the tests above ----

describe('instance-scoped schemas (InstanceRef, Rename, SaveLayout, SetModel, SetAutoResume)', () => {
  describe('InstanceRefSchema', () => {
    it('accepts a non-empty instanceId', () => {
      expect(InstanceRefSchema.safeParse({ instanceId: 'abc' }).success).toBe(true)
    })

    it('rejects an empty instanceId', () => {
      expect(InstanceRefSchema.safeParse({ instanceId: '' }).success).toBe(false)
    })

    it('rejects a missing instanceId', () => {
      expect(InstanceRefSchema.safeParse({}).success).toBe(false)
    })
  })

  describe('RenameSchema', () => {
    it('accepts valid instanceId + title', () => {
      expect(RenameSchema.safeParse({ instanceId: 'i1', title: 'My session' }).success).toBe(true)
    })

    it('rejects an empty title', () => {
      expect(RenameSchema.safeParse({ instanceId: 'i1', title: '' }).success).toBe(false)
    })

    it('rejects a missing title', () => {
      expect(RenameSchema.safeParse({ instanceId: 'i1' }).success).toBe(false)
    })
  })

  describe('SaveLayoutSchema', () => {
    it('accepts any unknown layout value', () => {
      expect(SaveLayoutSchema.safeParse({ instanceId: 'i1', layout: { panels: [] } }).success).toBe(
        true
      )
    })

    it('accepts null as a layout value', () => {
      expect(SaveLayoutSchema.safeParse({ instanceId: 'i1', layout: null }).success).toBe(true)
    })

    it('rejects a missing instanceId', () => {
      expect(SaveLayoutSchema.safeParse({ layout: {} }).success).toBe(false)
    })
  })

  describe('SetModelSchema', () => {
    it('accepts a non-empty model string', () => {
      expect(SetModelSchema.safeParse({ instanceId: 'i1', model: 'claude-opus-4-8' }).success).toBe(
        true
      )
    })

    it('rejects an empty model string', () => {
      expect(SetModelSchema.safeParse({ instanceId: 'i1', model: '' }).success).toBe(false)
    })
  })

  describe('SetAutoResumeSchema', () => {
    it('accepts true and false', () => {
      expect(SetAutoResumeSchema.safeParse({ instanceId: 'i1', enabled: true }).success).toBe(true)
      expect(SetAutoResumeSchema.safeParse({ instanceId: 'i1', enabled: false }).success).toBe(true)
    })

    it('rejects a non-boolean enabled', () => {
      expect(SetAutoResumeSchema.safeParse({ instanceId: 'i1', enabled: 'yes' }).success).toBe(
        false
      )
    })
  })
})

describe('session management schemas (SessionsFor, ImportSession, SwitchBranch)', () => {
  describe('SessionsForSchema', () => {
    it('accepts a non-empty cwd', () => {
      expect(SessionsForSchema.safeParse({ cwd: '/projects/foo' }).success).toBe(true)
    })

    it('rejects an empty cwd', () => {
      expect(SessionsForSchema.safeParse({ cwd: '' }).success).toBe(false)
    })
  })

  describe('ImportSessionSchema', () => {
    it('accepts cwd + sessionId (title optional)', () => {
      expect(ImportSessionSchema.safeParse({ cwd: '/work', sessionId: 'sess-abc' }).success).toBe(
        true
      )
    })

    it('accepts an optional title', () => {
      expect(
        ImportSessionSchema.safeParse({
          cwd: '/work',
          sessionId: 'sess-abc',
          title: 'Old session'
        }).success
      ).toBe(true)
    })

    it('rejects a missing sessionId', () => {
      expect(ImportSessionSchema.safeParse({ cwd: '/work' }).success).toBe(false)
    })

    it('rejects an empty sessionId', () => {
      expect(ImportSessionSchema.safeParse({ cwd: '/work', sessionId: '' }).success).toBe(false)
    })
  })

  describe('SwitchBranchSchema', () => {
    it('accepts instanceId + sessionId', () => {
      expect(SwitchBranchSchema.safeParse({ instanceId: 'i1', sessionId: 'sess-x' }).success).toBe(
        true
      )
    })

    it('rejects an empty sessionId', () => {
      expect(SwitchBranchSchema.safeParse({ instanceId: 'i1', sessionId: '' }).success).toBe(false)
    })
  })
})

describe('transcript mutation schemas (EditSave, Fork)', () => {
  describe('EditSaveSchema', () => {
    it('accepts instanceId, uuid, and newText (including empty newText)', () => {
      expect(
        EditSaveSchema.safeParse({ instanceId: 'i1', uuid: 'u1', newText: 'updated' }).success
      ).toBe(true)
      expect(EditSaveSchema.safeParse({ instanceId: 'i1', uuid: 'u1', newText: '' }).success).toBe(
        true
      )
    })

    it('rejects a missing uuid', () => {
      expect(EditSaveSchema.safeParse({ instanceId: 'i1', newText: 'x' }).success).toBe(false)
    })

    it('rejects an empty uuid', () => {
      expect(EditSaveSchema.safeParse({ instanceId: 'i1', uuid: '', newText: 'x' }).success).toBe(
        false
      )
    })
  })

  describe('ForkSchema', () => {
    it('accepts instanceId, uuid, and newText', () => {
      expect(
        ForkSchema.safeParse({ instanceId: 'i1', uuid: 'u1', newText: 'forked' }).success
      ).toBe(true)
    })

    it('rejects a missing uuid', () => {
      expect(ForkSchema.safeParse({ instanceId: 'i1', newText: 'x' }).success).toBe(false)
    })
  })
})

describe('plugin host schemas', () => {
  describe('ConversationRefSchema', () => {
    it('accepts a non-empty conversationId', () => {
      expect(ConversationRefSchema.safeParse({ conversationId: 'conv-1' }).success).toBe(true)
    })

    it('rejects an empty conversationId', () => {
      expect(ConversationRefSchema.safeParse({ conversationId: '' }).success).toBe(false)
    })
  })

  describe('PluginIdSchema', () => {
    it('accepts a non-empty pluginId', () => {
      expect(PluginIdSchema.safeParse({ pluginId: 'hello-panel' }).success).toBe(true)
    })

    it('rejects an empty pluginId', () => {
      expect(PluginIdSchema.safeParse({ pluginId: '' }).success).toBe(false)
    })
  })

  describe('SetPluginEnabledSchema', () => {
    it('accepts valid enable/disable payloads', () => {
      expect(
        SetPluginEnabledSchema.safeParse({
          conversationId: 'c1',
          pluginId: 'p1',
          enabled: true
        }).success
      ).toBe(true)
      expect(
        SetPluginEnabledSchema.safeParse({
          conversationId: 'c1',
          pluginId: 'p1',
          enabled: false
        }).success
      ).toBe(true)
    })

    it('rejects a non-boolean enabled', () => {
      expect(
        SetPluginEnabledSchema.safeParse({ conversationId: 'c1', pluginId: 'p1', enabled: 1 })
          .success
      ).toBe(false)
    })
  })

  describe('PluginStorageGetSchema / PluginStorageSetSchema / PluginStorageKeysSchema', () => {
    it('PluginStorageGetSchema accepts valid triple and rejects empty key', () => {
      expect(
        PluginStorageGetSchema.safeParse({
          conversationId: 'c1',
          pluginId: 'p1',
          key: 'my-key'
        }).success
      ).toBe(true)
      expect(
        PluginStorageGetSchema.safeParse({ conversationId: 'c1', pluginId: 'p1', key: '' }).success
      ).toBe(false)
    })

    it('PluginStorageSetSchema accepts unknown value (including null)', () => {
      expect(
        PluginStorageSetSchema.safeParse({
          conversationId: 'c1',
          pluginId: 'p1',
          key: 'k',
          value: null
        }).success
      ).toBe(true)
      expect(
        PluginStorageSetSchema.safeParse({
          conversationId: 'c1',
          pluginId: 'p1',
          key: 'k',
          value: { nested: true }
        }).success
      ).toBe(true)
    })

    it('PluginStorageKeysSchema requires conversationId and pluginId', () => {
      expect(
        PluginStorageKeysSchema.safeParse({ conversationId: 'c1', pluginId: 'p1' }).success
      ).toBe(true)
      expect(PluginStorageKeysSchema.safeParse({ conversationId: 'c1' }).success).toBe(false)
    })
  })

  describe('PluginContextGetSchema / PluginContextSetSchema', () => {
    it('PluginContextGetSchema accepts conversationId + pluginId + key', () => {
      expect(
        PluginContextGetSchema.safeParse({ conversationId: 'c1', pluginId: 'p1', key: 'k' }).success
      ).toBe(true)
    })

    it('PluginContextSetSchema requires a string value', () => {
      expect(
        PluginContextSetSchema.safeParse({
          conversationId: 'c1',
          pluginId: 'p1',
          key: 'k',
          value: 'text'
        }).success
      ).toBe(true)
      expect(
        PluginContextSetSchema.safeParse({
          conversationId: 'c1',
          pluginId: 'p1',
          key: 'k',
          value: 123
        }).success
      ).toBe(false)
    })
  })

  describe('DataBus channel schemas', () => {
    it('PluginDataChannelSchema requires non-empty channel', () => {
      expect(
        PluginDataChannelSchema.safeParse({
          conversationId: 'c1',
          pluginId: 'p1',
          channel: 'bash:stdout'
        }).success
      ).toBe(true)
      expect(
        PluginDataChannelSchema.safeParse({
          conversationId: 'c1',
          pluginId: 'p1',
          channel: ''
        }).success
      ).toBe(false)
    })

    it('PluginDataPublishSchema accepts any data value (unknown)', () => {
      expect(
        PluginDataPublishSchema.safeParse({
          conversationId: 'c1',
          pluginId: 'p1',
          channel: 'ch',
          data: { event: 'click' }
        }).success
      ).toBe(true)
      expect(
        PluginDataPublishSchema.safeParse({
          conversationId: 'c1',
          pluginId: 'p1',
          channel: 'ch',
          data: null
        }).success
      ).toBe(true)
    })

    it('PluginDataHistorySchema accepts an optional positive limit', () => {
      expect(
        PluginDataHistorySchema.safeParse({
          conversationId: 'c1',
          pluginId: 'p1',
          channel: 'ch',
          limit: 50
        }).success
      ).toBe(true)
      expect(
        PluginDataHistorySchema.safeParse({
          conversationId: 'c1',
          pluginId: 'p1',
          channel: 'ch'
        }).success
      ).toBe(true) // limit is optional
    })

    it('PluginDataHistorySchema rejects a limit exceeding 1000', () => {
      expect(
        PluginDataHistorySchema.safeParse({
          conversationId: 'c1',
          pluginId: 'p1',
          channel: 'ch',
          limit: 1001
        }).success
      ).toBe(false)
    })

    it('PluginDataHistorySchema rejects a non-integer limit', () => {
      expect(
        PluginDataHistorySchema.safeParse({
          conversationId: 'c1',
          pluginId: 'p1',
          channel: 'ch',
          limit: 1.5
        }).success
      ).toBe(false)
    })
  })

  describe('PluginReadAssetSchema', () => {
    it('accepts valid path', () => {
      expect(
        PluginReadAssetSchema.safeParse({
          conversationId: 'c1',
          pluginId: 'p1',
          path: 'images/logo.png'
        }).success
      ).toBe(true)
    })

    it('rejects an empty path', () => {
      expect(
        PluginReadAssetSchema.safeParse({ conversationId: 'c1', pluginId: 'p1', path: '' }).success
      ).toBe(false)
    })
  })

  describe('PluginWriteFileSchema', () => {
    it('accepts path + content (content may be empty string)', () => {
      expect(
        PluginWriteFileSchema.safeParse({
          conversationId: 'c1',
          pluginId: 'p1',
          path: 'out/file.txt',
          content: 'hello'
        }).success
      ).toBe(true)
      expect(
        PluginWriteFileSchema.safeParse({
          conversationId: 'c1',
          pluginId: 'p1',
          path: 'out/file.txt',
          content: ''
        }).success
      ).toBe(true)
    })

    it('rejects a missing content field', () => {
      expect(
        PluginWriteFileSchema.safeParse({ conversationId: 'c1', pluginId: 'p1', path: 'f.txt' })
          .success
      ).toBe(false)
    })
  })

  describe('PluginNetFetchSchema', () => {
    it('accepts a minimal payload (url only, opts optional)', () => {
      expect(
        PluginNetFetchSchema.safeParse({ conversationId: 'c1', pluginId: 'p1', url: 'https://x' })
          .success
      ).toBe(true)
    })

    it('accepts a full opts object', () => {
      expect(
        PluginNetFetchSchema.safeParse({
          conversationId: 'c1',
          pluginId: 'p1',
          url: 'https://api.example.com/data',
          opts: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
            timeoutMs: 5000,
            binary: false
          }
        }).success
      ).toBe(true)
    })

    it('rejects an empty url', () => {
      expect(
        PluginNetFetchSchema.safeParse({ conversationId: 'c1', pluginId: 'p1', url: '' }).success
      ).toBe(false)
    })

    it('rejects a negative timeoutMs', () => {
      expect(
        PluginNetFetchSchema.safeParse({
          conversationId: 'c1',
          pluginId: 'p1',
          url: 'https://x',
          opts: { timeoutMs: -1 }
        }).success
      ).toBe(false)
    })
  })

  describe('PluginFsListSchema', () => {
    it('accepts a payload with no dir (list root)', () => {
      expect(PluginFsListSchema.safeParse({ conversationId: 'c1', pluginId: 'p1' }).success).toBe(
        true
      )
    })

    it('accepts an explicit dir', () => {
      expect(
        PluginFsListSchema.safeParse({ conversationId: 'c1', pluginId: 'p1', dir: 'src' }).success
      ).toBe(true)
    })

    it('rejects a missing conversationId', () => {
      expect(PluginFsListSchema.safeParse({ pluginId: 'p1' }).success).toBe(false)
    })
  })

  describe('PluginShellOpenSchema', () => {
    it('accepts a non-empty path', () => {
      expect(
        PluginShellOpenSchema.safeParse({
          conversationId: 'c1',
          pluginId: 'p1',
          path: 'docs/README.md'
        }).success
      ).toBe(true)
    })

    it('rejects an empty path', () => {
      expect(
        PluginShellOpenSchema.safeParse({ conversationId: 'c1', pluginId: 'p1', path: '' }).success
      ).toBe(false)
    })
  })

  describe('PluginComposeSchema', () => {
    it('accepts an empty text (compose clears the composer)', () => {
      expect(
        PluginComposeSchema.safeParse({ conversationId: 'c1', pluginId: 'p1', text: '' }).success
      ).toBe(true)
    })

    it('accepts a non-empty text', () => {
      expect(
        PluginComposeSchema.safeParse({
          conversationId: 'c1',
          pluginId: 'p1',
          text: 'Hello agent!'
        }).success
      ).toBe(true)
    })

    it('rejects a missing text field', () => {
      expect(PluginComposeSchema.safeParse({ conversationId: 'c1', pluginId: 'p1' }).success).toBe(
        false
      )
    })
  })

  describe('OS notification schemas (Notify, FlashFrame, BadgeCount)', () => {
    it('PluginNotifySchema accepts title + body, optional sound and tag', () => {
      expect(
        PluginNotifySchema.safeParse({
          conversationId: 'c1',
          pluginId: 'p1',
          title: 'Done',
          body: 'Build succeeded',
          sound: true,
          tag: 'build'
        }).success
      ).toBe(true)
    })

    it('PluginNotifySchema rejects an empty title', () => {
      expect(
        PluginNotifySchema.safeParse({
          conversationId: 'c1',
          pluginId: 'p1',
          title: '',
          body: 'x'
        }).success
      ).toBe(false)
    })

    it('PluginNotifySchema accepts an empty body', () => {
      expect(
        PluginNotifySchema.safeParse({
          conversationId: 'c1',
          pluginId: 'p1',
          title: 'Hi',
          body: ''
        }).success
      ).toBe(true)
    })

    it('PluginFlashFrameSchema accepts true and false', () => {
      expect(
        PluginFlashFrameSchema.safeParse({ conversationId: 'c1', pluginId: 'p1', on: true }).success
      ).toBe(true)
      expect(
        PluginFlashFrameSchema.safeParse({ conversationId: 'c1', pluginId: 'p1', on: false })
          .success
      ).toBe(true)
    })

    it('PluginBadgeCountSchema accepts zero and positive integers', () => {
      expect(
        PluginBadgeCountSchema.safeParse({ conversationId: 'c1', pluginId: 'p1', count: 0 }).success
      ).toBe(true)
      expect(
        PluginBadgeCountSchema.safeParse({ conversationId: 'c1', pluginId: 'p1', count: 5 }).success
      ).toBe(true)
    })

    it('PluginBadgeCountSchema rejects negative counts', () => {
      expect(
        PluginBadgeCountSchema.safeParse({ conversationId: 'c1', pluginId: 'p1', count: -1 })
          .success
      ).toBe(false)
    })

    it('PluginBadgeCountSchema rejects non-integer counts', () => {
      expect(
        PluginBadgeCountSchema.safeParse({ conversationId: 'c1', pluginId: 'p1', count: 1.5 })
          .success
      ).toBe(false)
    })
  })

  describe('PluginConvPluginSchema / PluginHistorySchema', () => {
    it('PluginConvPluginSchema requires both conversationId and pluginId', () => {
      expect(
        PluginConvPluginSchema.safeParse({ conversationId: 'c1', pluginId: 'p1' }).success
      ).toBe(true)
      expect(PluginConvPluginSchema.safeParse({ conversationId: 'c1' }).success).toBe(false)
    })

    it('PluginHistorySchema accepts an optional bounded limit', () => {
      expect(
        PluginHistorySchema.safeParse({ conversationId: 'c1', pluginId: 'p1', limit: 200 }).success
      ).toBe(true)
      expect(PluginHistorySchema.safeParse({ conversationId: 'c1', pluginId: 'p1' }).success).toBe(
        true
      ) // limit is optional
    })

    it('PluginHistorySchema rejects a limit exceeding 1000', () => {
      expect(
        PluginHistorySchema.safeParse({ conversationId: 'c1', pluginId: 'p1', limit: 9999 }).success
      ).toBe(false)
    })
  })

  describe('PluginBackendCallSchema', () => {
    it('accepts a minimal payload (op only, params and timeoutMs optional)', () => {
      expect(
        PluginBackendCallSchema.safeParse({
          conversationId: 'c1',
          pluginId: 'p1',
          op: 'status'
        }).success
      ).toBe(true)
    })

    it('accepts a full payload with params and timeoutMs', () => {
      expect(
        PluginBackendCallSchema.safeParse({
          conversationId: 'c1',
          pluginId: 'p1',
          op: 'diff',
          params: { file: 'src/main.ts' },
          timeoutMs: 30000
        }).success
      ).toBe(true)
    })

    it('rejects an empty op string', () => {
      expect(
        PluginBackendCallSchema.safeParse({ conversationId: 'c1', pluginId: 'p1', op: '' }).success
      ).toBe(false)
    })

    it('rejects a timeoutMs exceeding 600000 (10 min cap)', () => {
      expect(
        PluginBackendCallSchema.safeParse({
          conversationId: 'c1',
          pluginId: 'p1',
          op: 'x',
          timeoutMs: 600001
        }).success
      ).toBe(false)
    })

    it('rejects a negative timeoutMs', () => {
      expect(
        PluginBackendCallSchema.safeParse({
          conversationId: 'c1',
          pluginId: 'p1',
          op: 'x',
          timeoutMs: -1
        }).success
      ).toBe(false)
    })
  })
})
