# Atelier install & startup system — plan and reference

Goal (bugs.txt feature 1): a fresh user clones the repo, runs `run.bat` (Windows) or
`./run.sh` (macOS/Linux), and Atelier comes up — with every prerequisite detected,
installed or clearly explained, and an auth check before launch. Re-running is always
safe and fast (idempotent, doctor-style).

## Ground truth this design is built on (verified 2026-07-19)

- **This is a pure Node/Electron project.** There is no Python and no venv; the
  equivalent of "create the venv + install reqs" is `node_modules` via `npm ci`.
- **Auth is the ambient Claude Code session, not an API key.** `electron/main.ts`
  deliberately deletes `ANTHROPIC_API_KEY` at launch so the user's Claude subscription
  is used. Therefore the install-time auth check is "is the Claude Code CLI logged
  in", not "is a key set".
- **`claude auth status` exists and is scriptable** (verified against CLI v2.1.198):
  prints JSON with `loggedIn: true|false`, exit 0 when logged in. `claude auth login`
  runs the interactive OAuth flow. These are the only auth commands we use.
- **Toolchain floor:** Vite 7 requires Node `^20.19 || >=22.12`; that is our gate
  (recommend the current LTS). npm ships with Node, so npm needs no separate check
  beyond existence.
- **Known local failure mode:** Electron's postinstall can be skipped, leaving
  `node_modules/electron/dist/electron(.exe)` missing even though `npm install`
  "succeeded". Fix is `node node_modules/electron/install.js`. The bootstrap checks
  for the binary explicitly.

## Architecture: thin wrappers, one Node brain

```
run.bat ─┐
run.sh  ─┼─► scripts/bootstrap.mjs  (all logic; node builtins only, zero deps)
launch.ps1 (shortcut) ─┘
```

- **`run.bat` / `run.sh` do exactly one job:** find a usable Node (PATH, then known
  install locations: `C:\Program Files\nodejs`, nvm/fnm/homebrew dirs) and exec
  `node scripts/bootstrap.mjs run "$@"`. If Node is missing they print the one
  per-OS install command (winget / brew / nodejs.org) and exit non-zero. They stay
  dumb because anything before Node exists can't share code with the rest.
- **`scripts/bootstrap.mjs` is the entire install/startup brain.** It must import
  only Node builtins — it runs before `npm install` has ever happened.
- **`scripts/launch.ps1`** (Desktop-shortcut launcher) delegates to the same
  bootstrap so build-staleness logic exists in exactly one place.

## The check pipeline (in order; each is check → explain → fix → re-check)

| #   | Check                   | Detect                                                                                                                               | Auto-fix                                                                                                                                                              | If unfixable                          |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 1   | Node version            | `process.version` vs `^20.19 \|\| >=22.12`                                                                                           | — (can't reinstall the runtime we're on)                                                                                                                              | print per-OS upgrade command, exit 10 |
| 2   | Dependencies in sync    | lockfile hash vs stamp file `node_modules/.atelier-deps.json`; missing `node_modules`                                                | `npm ci` (falls back to `npm install` if `npm ci` fails)                                                                                                              | exit 11 with npm output               |
| 3   | Electron binary present | `node_modules/electron/dist/electron(.exe)` exists                                                                                   | `node node_modules/electron/install.js`                                                                                                                               | exit 12                               |
| 4   | Claude Code CLI         | `claude --version` on PATH                                                                                                           | offer official installer (consent-gated; `--yes` accepts): Windows `irm https://claude.ai/install.ps1 \| iex`, unix `curl -fsSL https://claude.ai/install.sh \| bash` | exit 13 with manual instructions      |
| 5   | Logged in               | `claude auth status` JSON `loggedIn`                                                                                                 | run `claude auth login` interactively, then re-check                                                                                                                  | exit 14                               |
| 6   | API-key warning         | `ANTHROPIC_API_KEY` set in env                                                                                                       | warn only (Atelier strips it at launch; not an error)                                                                                                                 | —                                     |
| 7   | Build fresh             | newest mtime of `electron/ src/ index.html package.json electron.vite.config.ts` vs `out/main/main.js` (same rule as old launch.ps1) | `npm run build`                                                                                                                                                       | exit 15                               |
| 8   | Launch                  | —                                                                                                                                    | spawn `node_modules/electron/dist/electron(.exe) .` detached                                                                                                          | exit 16                               |

Principles applied (standard doctor/bootstrap practice):

- **Idempotent:** every step is "verify, and only act if needed"; running twice in a
  row does nothing the second time and finishes in seconds.
- **Fail with the fix:** every failure message states the exact command to run next.
- **Narrate + ask before every fix:** each step explains what it found, why the fix
  is needed, and what the fix touches, then asks (Enter = bracketed default). In-repo
  fixes (deps, electron, build) default **Yes**; the one system-level install (the
  Claude CLI, which writes outside the repo) defaults **No**. Without a terminal to
  ask on (CI/pipes) the defaults apply; `--yes` accepts everything unattended.
- **Fail with a where/how:** every printed command comes with where to paste it
  (which terminal, which folder) and what to do afterwards.
- **Distinct exit codes** per failure class so wrappers/CI can react.
- **Deterministic installs:** `npm ci` against the committed lockfile, not
  `npm install` drift.

## CLI surface

```
node scripts/bootstrap.mjs <command> [flags]
  run       full pipeline then launch the built app      (default; what run.bat does)
  dev       full pipeline then `electron-vite dev` (HMR)
  doctor    checks only — report PASS/FIX-NEEDED per step, change nothing, exit 0/1
flags:
  --yes     non-interactive: accept all consent prompts (CI / unattended)
  --no-launch  run every check+fix but stop before starting the app
```

## What is deliberately NOT here

- No global installs beyond the official Claude Code installer (consent-gated).
- No Node auto-install — installing a runtime from inside a script that needs that
  runtime is the classic bootstrap trap; we print the one-liner instead.
- No packaged-app installer (MSI/DMG) — out of scope; this is the clone-and-run path.
- In-app auth UX beyond the existing `authStatus` IPC — the pre-launch gate makes the
  common failure impossible; richer in-app re-auth can come later if needed.

## Test plan

Automatable now: `doctor` on a healthy tree (all PASS); staleness logic (touch a
source file → doctor reports build stale); electron-binary check (rename `dist`,
doctor flags it); full `run` launches the app. Needs human spot-check (recorded in
PROGRESS.md): true fresh clone on a machine without Node/Claude CLI, and the
interactive `claude auth login` path.

Sources consulted for the pattern: [idempotent bash scripts](https://arslan.io/2019/07/03/how-to-write-idempotent-bash-scripts/),
[environment-bootstrap init-script pattern](https://lobehub.com/skills/troykelly-claude-skills-environment-bootstrap),
[Claude Code authentication docs](https://code.claude.com/docs/en/authentication).
