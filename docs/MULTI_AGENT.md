# MULTI_AGENT.md — working on Atelier in parallel

This repo is often edited by **more than one Claude session at once** (the user runs several
Claude CLI terminals; you can also spawn sub-agents). This file is the operating manual for
doing that without stepping on each other. If you are about to start work and another session
might be active, **read this first**.

## The one failure mode this prevents

Two sessions sharing **one working directory and one branch** race even when they touch
different files. Symptoms: `git diff HEAD` shows changes you didn't make (or _omits_ changes
you did make), a commit "already contains" code you're about to write, or a near-empty diff
after a big edit. That is not a mystery — it is the other session's commit moving `HEAD`
under you.

**The fix is filesystem isolation, not just branch isolation.** Each parallel line of work
gets its own **git worktree** (own directory) on its own **branch**, sharing one `.git`.

## Golden rules

1. **One worktree + one branch per parallel task.** Never have two sessions editing the same
   directory at the same time.
2. **Branch off the latest `main`.** The helper does this; if doing it by hand, `git fetch`
   first.
3. **Small, frequent commits.** They make merges trivial and collisions cheap to unwind.
4. **Merge back through `main`, then run CI** (`npm run ci:status`) — see
   [docs/ENGINEERING.md](./ENGINEERING.md).
5. **Never hand-merge `plugins/hologram/hologram.bundle.js`.** It is generated. On any
   conflict, rebuild it and take the rebuilt version (see _The bundle rule_ below).
6. **Windows/Node:** Node is not always on PATH. Prepend `C:\Program Files\nodejs` in shell
   commands (Git Bash: `export PATH="/c/Program Files/nodejs:$PATH"`).

## Create a worktree

Use the helper (preferred — it also links `node_modules` so the worktree is usable
immediately without a reinstall):

```bash
node scripts/worktree.mjs add <topic>        # e.g. "hologram-edges"
# → creates worktree dir  ../atelier-<topic>
#   on branch             feat/<topic>
#   with node_modules symlinked to the main checkout
```

Override the branch name with `--branch <name>` (e.g. `--branch fix/edge-raycast`).

Raw equivalent, if you can't run the script:

```bash
git worktree add ../atelier-<topic> -b feat/<topic>
# then make the worktree runnable without `npm install`:
#   Windows: cmd //c mklink //J ..\atelier-<topic>\node_modules node_modules
#   POSIX:   ln -s "$(pwd)/node_modules" ../atelier-<topic>/node_modules
```

Worktrees live as **siblings** of the main checkout (`../atelier-<topic>`), deliberately
outside `D:\…\betterclaude` so the plugin watcher and editor tooling don't scan them.

## Work in it

`cd ../atelier-<topic>` and work normally. The committed `hologram.bundle.js` is present, so
the app runs from a fresh worktree with no build step. Typecheck/tests/prettier all work
because `node_modules` is linked.

## The bundle rule

`plugins/hologram/hologram.bundle.js` is a **generated** esbuild artifact (from
`plugins/hologram/*.js` via `npm run build:hologram`). It is committed so the app runs from a
clean checkout, but it must **never be hand-merged** — a minified diff is meaningless and two
branches that both rebuilt it will always textually conflict.

If a merge conflicts on the bundle:

```bash
export PATH="/c/Program Files/nodejs:$PATH"
git checkout --theirs plugins/hologram/hologram.bundle.js   # or --ours; either way:
npm run build:hologram                                       # regenerate from merged source
git add plugins/hologram/hologram.bundle.js
```

The rebuild is deterministic from the merged source, so the regenerated bundle is always the
correct resolution. `.gitattributes` marks the file `-diff` so it doesn't spam diffs/reviews.

## Merge back and verify

From the **main** checkout (not the worktree):

```bash
export PATH="/c/Program Files/nodejs:$PATH"
git -C <main-checkout> fetch
git -C <main-checkout> switch main && git -C <main-checkout> pull
git -C <main-checkout> merge feat/<topic>
npm run typecheck && npm test && npm run format:check
git push                  # then:
npm run ci:status         # confirm green yourself; don't ask the user to check Actions
```

Then retire the worktree:

```bash
node scripts/worktree.mjs remove <topic>     # removes the worktree dir + its node_modules link
# (the branch is kept; delete with `git branch -d feat/<topic>` once merged)
```

## Sub-agents (autonomous parallel work)

To run a task autonomously without leaving your own session, spawn a sub-agent with its own
isolated worktree:

- `Agent(subagent_type, prompt, isolation: "worktree")` — the harness gives the agent a fresh
  worktree, and **auto-cleans it if the agent makes no changes**. Add `run_in_background: true`
  to keep working while it runs.
- Give the sub-agent a **self-contained brief**: the goal, the acceptance check (build/tests),
  the bundle rule above, and "commit on your branch; report the branch name and a summary."
- The sub-agent commits to its branch; **you** merge it back through `main` and run CI, exactly
  as above. Treat its returned message as a report — verify before merging.
- Scope each sub-agent to **one concern** (one plugin, one subsystem) so its branch merges
  cleanly against whatever else is in flight.

## When something looks wrong

A near-empty `git diff HEAD`, a surprise commit, or "HEAD already has my change" almost always
means a concurrent session moved `main`. Before theorizing about anything exotic:

```bash
git reflog -6                       # did HEAD move when you didn't commit?
git log origin/main..HEAD           # what's local-and-unpushed?
git rev-list --left-right --count origin/main...HEAD   # how far ahead/behind origin
git worktree list                   # who else has a checkout
```

If `HEAD` moved and you didn't move it, you're sharing a branch with another session — stop and
move your work into its own worktree (above) before continuing.
