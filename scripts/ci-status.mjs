#!/usr/bin/env node
// Reports this repo's latest GitHub Actions run for a commit, and by default waits
// for it to finish. Auth comes from $GH_TOKEN/$GITHUB_TOKEN, else the local git
// credential helper (GitHub Desktop / `git credential`). The token is read into
// memory only and never printed.
//
// Usage:
//   node scripts/ci-status.mjs              # latest run for HEAD, poll until done
//   node scripts/ci-status.mjs <sha>        # a specific commit
//   node scripts/ci-status.mjs --no-wait    # single check, don't poll
//
// Env: CI_INTERVAL (s, default 15), CI_TIMEOUT (s, default 600).
// Exit: 0 success · 1 CI failed · 2 setup problem · 3 not finished / timeout.
//
// Note: we never call process.exit() — doing so while a fetch socket is still open
// trips a libuv assertion on Windows. Instead we set process.exitCode and let the
// event loop drain.
import { execFileSync } from 'node:child_process'

class ExitError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}
const fail = (msg, code) => {
  throw new ExitError(msg, code)
}

function git(...a) {
  return execFileSync('git', a, { encoding: 'utf8' }).trim()
}

function repoSlug() {
  const url = git('remote', 'get-url', 'origin')
  const m = url.replace(/\.git$/, '').match(/github\.com[/:]([^/]+\/[^/]+)$/)
  if (!m) fail(`cannot parse a github repo from origin: ${url}`, 2)
  return m[1]
}

function token() {
  const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (env) return env
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8'
    })
    const m = out.match(/^password=(.*)$/m)
    if (m) return m[1]
  } catch {
    /* fall through to the error below */
  }
  fail('no GitHub token (set GH_TOKEN or sign in via the git credential helper)', 2)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function latestRun(repo, tok, sha) {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/actions/runs?head_sha=${sha}&per_page=1`,
    { headers: { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json' } }
  )
  if (!res.ok) fail(`GitHub API responded ${res.status}`, 2)
  const data = await res.json()
  return data.workflow_runs?.[0] ?? null
}

async function main() {
  const args = process.argv.slice(2)
  const noWait = args.includes('--no-wait')
  const sha = args.find((a) => !a.startsWith('--')) ?? git('rev-parse', 'HEAD')
  const interval = Number(process.env.CI_INTERVAL ?? 15) * 1000
  const timeout = Number(process.env.CI_TIMEOUT ?? 600) * 1000
  const short = sha.slice(0, 7)
  const repo = repoSlug()
  const tok = token()

  const start = Date.now()
  for (;;) {
    const run = await latestRun(repo, tok, sha)
    if (run?.status === 'completed') {
      console.log(`CI ${run.conclusion} for ${short} — ${run.html_url}`)
      return run.conclusion === 'success' ? 0 : 1
    }
    const state = run ? run.status : 'no run yet'
    if (noWait) {
      console.log(`CI ${state} (${short}) — not finished`)
      return 3
    }
    if (Date.now() - start >= timeout) {
      console.log(`timeout waiting for CI on ${short} (last: ${state})`)
      return 3
    }
    console.log(`CI ${state} (${short})… waiting ${interval / 1000}s`)
    await sleep(interval)
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err) => {
    if (err instanceof ExitError) {
      if (err.message) console.error(err.message)
      process.exitCode = err.code
    } else {
      console.error(err?.message ?? err)
      process.exitCode = 2
    }
  })
