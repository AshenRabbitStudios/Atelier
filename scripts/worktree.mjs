#!/usr/bin/env node
// worktree.mjs — create/remove/list git worktrees for parallel work on Atelier, following the
// conventions in docs/MULTI_AGENT.md. A worktree gets its own directory + branch (filesystem
// isolation so concurrent sessions don't race) and a node_modules symlink to the main checkout
// (so it is runnable immediately, no reinstall). No interactive prompts; safe to run from an agent.
//
//   node scripts/worktree.mjs add <topic> [--branch <name>]
//   node scripts/worktree.mjs remove <topic>
//   node scripts/worktree.mjs list

import { execFileSync } from 'node:child_process'
import { existsSync, symlinkSync, rmSync, lstatSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'

function git(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...opts
  }).trim()
}

const root = git(['rev-parse', '--show-toplevel'])
const parent = dirname(root)

function dirFor(topic) {
  return resolve(parent, `atelier-${topic}`)
}

function linkNodeModules(dir) {
  const target = join(root, 'node_modules')
  const link = join(dir, 'node_modules')
  if (!existsSync(target)) {
    console.warn(
      '! main checkout has no node_modules to link — run `npm install` there first, or in the worktree'
    )
    return
  }
  if (existsSync(link)) return
  // 'junction' on Windows needs no admin and works for directories; 'dir' elsewhere.
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  console.log(`  linked node_modules → ${target}`)
}

function add(topic, branch) {
  if (!topic) throw new Error('usage: worktree.mjs add <topic> [--branch <name>]')
  const dir = dirFor(topic)
  const br = branch || `feat/${topic}`
  if (existsSync(dir)) throw new Error(`worktree dir already exists: ${dir}`)
  console.log(`Creating worktree ${dir} on branch ${br} …`)
  git(['worktree', 'add', dir, '-b', br])
  linkNodeModules(dir)
  console.log('\nDone. Next:')
  console.log(`  cd ${dir}`)
  console.log('  # work, commit small + often on this branch')
  console.log(`  # merge back from the main checkout: git -C ${root} merge ${br}`)
  console.log(`  # then: node scripts/worktree.mjs remove ${topic}`)
}

function remove(topic) {
  if (!topic) throw new Error('usage: worktree.mjs remove <topic>')
  const dir = dirFor(topic)
  // Drop the node_modules symlink first so `git worktree remove` doesn't traverse into the
  // main checkout's modules (and so a stale link never blocks removal).
  const link = join(dir, 'node_modules')
  try {
    if (lstatSync(link).isSymbolicLink()) rmSync(link, { recursive: false, force: true })
  } catch {
    /* no link present — fine */
  }
  console.log(`Removing worktree ${dir} …`)
  git(['worktree', 'remove', dir, '--force'])
  console.log('Done. The branch is kept; delete it with `git branch -d <branch>` once merged.')
}

function list() {
  console.log(git(['worktree', 'list']))
}

const [cmd, ...rest] = process.argv.slice(2)
const flags = {}
const positional = []
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--branch') flags.branch = rest[++i]
  else positional.push(rest[i])
}

try {
  if (cmd === 'add') add(positional[0], flags.branch)
  else if (cmd === 'remove') remove(positional[0])
  else if (cmd === 'list') list()
  else {
    console.log('usage:')
    console.log('  node scripts/worktree.mjs add <topic> [--branch <name>]')
    console.log('  node scripts/worktree.mjs remove <topic>')
    console.log('  node scripts/worktree.mjs list')
    process.exit(cmd ? 1 : 0)
  }
} catch (err) {
  console.error(`error: ${err.message}`)
  process.exit(1)
}
