// Unit tests for the agent-flow git porcelain parsers (the bug farm). These run in vitest's node
// env against fixture STRINGS — no git, no child process — so a parsing regression is caught
// headlessly. Control bytes: NUL=\x00, US=\x1f, RS=\x1e (matching the backend's git format flags).
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const {
  parseStatus,
  parseLog,
  parseStashList,
  parseSubmodules,
  parseBranches,
  parseWorktrees,
  parseDiff,
  parseDiffMulti
} = require('./gitParse.cjs')

const NUL = '\x00'
const US = '\x1f'
const RS = '\x1e'

describe('parseStatus (--porcelain=v2 --branch -z)', () => {
  it('parses branch headers with ahead/behind', () => {
    const raw =
      '# branch.oid 1a2b3c4' +
      NUL +
      '# branch.head main' +
      NUL +
      '# branch.upstream origin/main' +
      NUL +
      '# branch.ab +2 -1' +
      NUL
    const r = parseStatus(raw)
    expect(r.branch).toBe('main')
    expect(r.upstream).toBe('origin/main')
    expect(r.ahead).toBe(2)
    expect(r.behind).toBe(1)
  })

  it('classifies staged, unstaged, untracked, and conflicts', () => {
    const raw =
      '# branch.head main' +
      NUL +
      // staged modify (X=M, Y=.)
      '1 M. N... 100644 100644 100644 aaa bbb src/a.ts' +
      NUL +
      // unstaged modify (X=., Y=M)
      '1 .M N... 100644 100644 100644 ccc ddd src/b.ts' +
      NUL +
      // both staged add and unstaged modify (X=A, Y=M)
      '1 AM N... 000000 100644 100644 000 eee src/c.ts' +
      NUL +
      '? untracked.txt' +
      NUL +
      'u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.ts' +
      NUL
    const r = parseStatus(raw)
    expect(r.staged.map((s) => s.path)).toEqual(['src/a.ts', 'src/c.ts'])
    expect(r.unstaged.map((s) => s.path)).toEqual(['src/b.ts', 'src/c.ts'])
    expect(r.untracked.map((s) => s.path)).toEqual(['untracked.txt'])
    expect(r.conflicted.map((c) => c.path)).toEqual(['conflict.ts'])
    expect(r.staged[0].status).toBe('M')
    expect(r.unstaged[0].status).toBe('M')
  })

  it('handles a rename record (type 2) with its NUL-separated original path', () => {
    const raw =
      '# branch.head main' +
      NUL +
      '2 R. N... 100644 100644 100644 aaa bbb R100 new/name.ts' +
      NUL +
      'old/name.ts' +
      NUL
    const r = parseStatus(raw)
    expect(r.staged).toHaveLength(1)
    expect(r.staged[0].path).toBe('new/name.ts')
    expect(r.staged[0].orig).toBe('old/name.ts')
    expect(r.staged[0].status).toBe('R')
  })

  it('handles paths containing spaces', () => {
    const raw = '1 .M N... 100644 100644 100644 ccc ddd my file with spaces.txt' + NUL
    const r = parseStatus(raw)
    expect(r.unstaged[0].path).toBe('my file with spaces.txt')
  })

  it('detached HEAD → null branch', () => {
    const r = parseStatus('# branch.head (detached)' + NUL)
    expect(r.branch).toBeNull()
  })

  it('empty / non-string input returns an empty shape without throwing', () => {
    expect(parseStatus('').staged).toEqual([])
    expect(parseStatus(undefined).untracked).toEqual([])
    expect(parseStatus(null).branch).toBeNull()
  })
})

describe('parseLog (US/RS-delimited pretty format)', () => {
  const rec = (fields) => US + fields.join(US) + RS
  it('parses commits with all fields', () => {
    const raw =
      rec([
        'fullhash1111111111111111111111111111111',
        'fullhas',
        'Ada Lovelace',
        'ada@example.com',
        '2026-07-20T10:00:00+00:00',
        'feat: first',
        'parenthash'
      ]) +
      rec([
        'fullhash2222222222222222222222222222222',
        'fullha2',
        'Grace Hopper',
        'grace@example.com',
        '2026-07-19T09:00:00+00:00',
        'fix: second',
        'p1 p2'
      ])
    const r = parseLog(raw)
    expect(r).toHaveLength(2)
    expect(r[0].hash).toBe('fullhash1111111111111111111111111111111')
    expect(r[0].author).toBe('Ada Lovelace')
    expect(r[0].subject).toBe('feat: first')
    expect(r[0].parents).toEqual(['parenthash'])
    expect(r[1].parents).toEqual(['p1', 'p2']) // merge commit
  })

  it('tolerates a subject with pipes/special chars and an empty parent (root commit)', () => {
    const raw = rec(['h', 's', 'a', 'e', '2026-01-01T00:00:00Z', 'chore: a | b || c', ''])
    const r = parseLog(raw)
    expect(r[0].subject).toBe('chore: a | b || c')
    expect(r[0].parents).toEqual([])
  })

  it('empty input → empty array', () => {
    expect(parseLog('')).toEqual([])
    expect(parseLog(null)).toEqual([])
  })

  it('old 7-field records get empty refs/body (backward compat)', () => {
    const raw = rec(['h', 's', 'a', 'e', '2026-01-01T00:00:00Z', 'subj', 'p'])
    const r = parseLog(raw)
    expect(r[0].refs).toEqual([])
    expect(r[0].body).toBe('')
  })

  it('parses trailing refs (%D) and multi-line body (%b)', () => {
    const raw = rec([
      'h1',
      'h1s',
      'a',
      'e',
      '2026-01-01T00:00:00Z',
      'feat: subject',
      'p1',
      'HEAD -> main, origin/main, tag: v1.2',
      'Body line one.\nBody line two.\n'
    ])
    const r = parseLog(raw)
    expect(r[0].refs).toEqual(['HEAD -> main', 'origin/main', 'tag: v1.2'])
    expect(r[0].body).toBe('Body line one.\nBody line two.')
  })
})

describe('parseStashList (US/RS-delimited)', () => {
  it('parses refs, dates, and subjects', () => {
    const raw =
      US +
      'stash@{0}' +
      US +
      '2026-07-21T01:00:00+00:00' +
      US +
      'WIP on main: 1a2b3c4 subject' +
      RS +
      US +
      'stash@{1}' +
      US +
      '2026-07-20T00:00:00+00:00' +
      US +
      'On feat/x: custom message' +
      RS
    const r = parseStashList(raw)
    expect(r).toHaveLength(2)
    expect(r[0]).toMatchObject({ ref: 'stash@{0}', index: 0 })
    expect(r[1]).toMatchObject({ index: 1, subject: 'On feat/x: custom message' })
  })

  it('empty input → empty array', () => {
    expect(parseStashList('')).toEqual([])
    expect(parseStashList(undefined)).toEqual([])
  })
})

describe('parseSubmodules (submodule status)', () => {
  it('parses sync/modified/uninitialized/conflict flags', () => {
    const raw = [
      ' 1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d vendor/lib (v1.0)',
      '+2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e vendor/dirty (v1.1-2-gabc)',
      '-3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f vendor/uninit',
      'U4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70 vendor/conflict (broken)'
    ].join('\n')
    const r = parseSubmodules(raw)
    expect(r).toHaveLength(4)
    expect(r[0]).toMatchObject({ flag: 'ok', path: 'vendor/lib', describe: 'v1.0' })
    expect(r[1].flag).toBe('modified')
    expect(r[2]).toMatchObject({ flag: 'uninit', describe: '' })
    expect(r[3].flag).toBe('conflict')
  })

  it('empty input → empty array', () => {
    expect(parseSubmodules('')).toEqual([])
  })
})

describe('parseBranches (branch -vv)', () => {
  it('parses current, upstream, ahead/behind, and plain branches', () => {
    const raw = [
      '* main            1a2b3c4 [origin/main: ahead 2, behind 1] latest subject',
      '  feat/x          9f8e7d6 [origin/feat/x] wip',
      '  local-only      abcdef0 no upstream here'
    ].join('\n')
    const r = parseBranches(raw)
    expect(r).toHaveLength(3)
    expect(r[0]).toMatchObject({
      name: 'main',
      current: true,
      upstream: 'origin/main',
      ahead: 2,
      behind: 1
    })
    expect(r[1]).toMatchObject({ name: 'feat/x', current: false, upstream: 'origin/feat/x' })
    expect(r[2]).toMatchObject({ name: 'local-only', upstream: null, ahead: 0, behind: 0 })
  })

  it('handles ahead-only and behind-only tracking', () => {
    const raw = ['  a 111 [up: ahead 5] x', '  b 222 [up: behind 3] y'].join('\n')
    const r = parseBranches(raw)
    expect(r[0]).toMatchObject({ ahead: 5, behind: 0 })
    expect(r[1]).toMatchObject({ ahead: 0, behind: 3 })
  })

  it('parses a detached HEAD line', () => {
    const raw = '* (HEAD detached at 1a2b3c4) 1a2b3c4 some subject'
    const r = parseBranches(raw)
    expect(r[0]).toMatchObject({
      name: '(detached)',
      detached: true,
      current: true,
      sha: '1a2b3c4'
    })
  })

  it('empty input → empty array', () => {
    expect(parseBranches('')).toEqual([])
  })
})

describe('parseWorktrees (worktree list --porcelain)', () => {
  it('parses multiple worktrees with branch/detached/bare/locked', () => {
    const raw = [
      'worktree /repo/main',
      'HEAD 1a2b3c4d',
      'branch refs/heads/main',
      '',
      'worktree /repo/../atelier-agent-flow',
      'HEAD 9f8e7d6c',
      'branch refs/heads/feat/agent-flow',
      '',
      'worktree /repo/detached',
      'HEAD abcdef01',
      'detached',
      'locked reason here'
    ].join('\n')
    const r = parseWorktrees(raw)
    expect(r).toHaveLength(3)
    expect(r[0]).toMatchObject({ path: '/repo/main', branch: 'main', detached: false })
    expect(r[1]).toMatchObject({ branch: 'feat/agent-flow' })
    expect(r[2]).toMatchObject({ detached: true, branch: null, locked: true })
  })

  it('empty input → empty array', () => {
    expect(parseWorktrees('')).toEqual([])
  })
})

describe('parseDiff (unified)', () => {
  it('parses a hunk into typed add/del/ctx lines and counts', () => {
    const raw = [
      'diff --git a/src/x.ts b/src/x.ts',
      'index 111..222 100644',
      '--- a/src/x.ts',
      '+++ b/src/x.ts',
      '@@ -1,3 +1,4 @@ function f() {',
      ' const a = 1',
      '-const b = 2',
      '+const b = 3',
      '+const c = 4',
      ' return a'
    ].join('\n')
    const r = parseDiff(raw)
    expect(r.file).toBe('src/x.ts')
    expect(r.oldPath).toBe('src/x.ts')
    expect(r.hunks).toHaveLength(1)
    expect(r.additions).toBe(2)
    expect(r.deletions).toBe(1)
    const types = r.hunks[0].lines.map((l) => l.type)
    expect(types).toEqual(['ctx', 'del', 'add', 'add', 'ctx'])
    // line numbering: first ctx is old 1 / new 1
    expect(r.hunks[0].lines[0]).toMatchObject({ oldNo: 1, newNo: 1 })
  })

  it('flags a binary diff', () => {
    const raw = [
      'diff --git a/img.png b/img.png',
      'Binary files a/img.png and b/img.png differ'
    ].join('\n')
    const r = parseDiff(raw)
    expect(r.binary).toBe(true)
  })

  it('handles a new-file diff (/dev/null old path)', () => {
    const raw = [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,2 @@',
      '+line one',
      '+line two'
    ].join('\n')
    const r = parseDiff(raw)
    expect(r.file).toBe('new.ts')
    expect(r.additions).toBe(2)
    expect(r.deletions).toBe(0)
    expect(r.hunks[0].lines[0]).toMatchObject({ type: 'add', newNo: 1 })
  })

  it('handles "no newline at end of file" marker', () => {
    const raw = [
      'diff --git a/f b/f',
      '--- a/f',
      '+++ b/f',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '\\ No newline at end of file'
    ].join('\n')
    const r = parseDiff(raw)
    const last = r.hunks[0].lines[r.hunks[0].lines.length - 1]
    expect(last.type).toBe('meta')
  })

  it('empty input → empty shape without throwing', () => {
    const r = parseDiff('')
    expect(r.hunks).toEqual([])
    expect(r.binary).toBe(false)
  })
})

describe('parseDiffMulti (commit/stash diffs spanning files)', () => {
  it('splits a two-file diff into per-file sections', () => {
    const raw = [
      'diff --git a/one.ts b/one.ts',
      '--- a/one.ts',
      '+++ b/one.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/two.md b/two.md',
      '--- a/two.md',
      '+++ b/two.md',
      '@@ -1 +1,2 @@',
      ' keep',
      '+added'
    ].join('\n')
    const r = parseDiffMulti(raw)
    expect(r.files).toHaveLength(2)
    expect(r.files[0].file).toBe('one.ts')
    expect(r.files[0].additions).toBe(1)
    expect(r.files[0].deletions).toBe(1)
    expect(r.files[1].file).toBe('two.md')
    expect(r.files[1].additions).toBe(1)
  })

  it('binary sections are kept with their flag', () => {
    const raw = [
      'diff --git a/img.png b/img.png',
      'Binary files a/img.png and b/img.png differ',
      'diff --git a/t.txt b/t.txt',
      '--- a/t.txt',
      '+++ b/t.txt',
      '@@ -1 +1 @@',
      '-x',
      '+y'
    ].join('\n')
    const r = parseDiffMulti(raw)
    expect(r.files[0].binary).toBe(true)
    expect(r.files[1].file).toBe('t.txt')
  })

  it('empty input → empty files array', () => {
    expect(parseDiffMulti('').files).toEqual([])
  })
})
