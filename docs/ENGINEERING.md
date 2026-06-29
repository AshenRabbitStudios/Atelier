# ENGINEERING.md — Atelier engineering standards

The engineering bar for this repository. It defines how we keep the codebase legible,
reviewable, and safe to change. It is normative: "MUST" items are enforced (or are being
wired to be enforced — see **Status of enforcement** at the end); "SHOULD" items are strong
defaults you deviate from only with a recorded reason.

This complements, and does not replace:

- **CLAUDE.md** — how work is sequenced (phases, definition of done).
- **SPEC.md / ROADMAP.md** — what we build and in what order.
- **docs/DECISIONS.md** — the running log of non-obvious choices.

---

## 1. Guiding principles

1. **Legibility over cleverness.** This app's entire thesis is that an agent workbench can be
   legible; the code must model that. Prefer small, single-purpose, explicitly-typed modules
   with named interfaces over dense or implicit constructs. If a reviewer can't explain a
   block in one sentence, it's too clever.
2. **The boundary is the contract.** Every cross-process / cross-trust edge (IPC, plugin host
   RPC, plugin manifests, the SDK surface) is a validated, typed contract. Trust nothing that
   crosses a boundary until it is validated.
3. **Fail loud in dev, degrade safe in prod.** Errors surface as structured, actionable UI or
   logs — never swallowed silently. A failure in one isolated unit (agent instance, plugin)
   must never take down the app.
4. **The repo is the source of truth.** Decisions, progress, and rationale live in version
   control, not in chat history or memory. If it isn't committed, it didn't happen.

---

## 2. Repository management

- **Everything lives in git from commit zero.** A new project is `git init` + first commit
  before any second file is written. (We learned this the hard way — see DECISIONS.md.)
- **Default branch:** `main`, always in a releasable/launchable state (typechecks, builds,
  `npm run dev` runs).
- **Branching:** non-trivial work happens on a short-lived branch
  `type/short-description` (e.g. `feat/floating-panels`, `fix/stop-error-pane`), merged back
  via review. Trivial doc/typo fixes may go straight to `main`.
- **Commits:** small, atomic, each leaving the tree in a working state. Use
  [Conventional Commits](https://www.conventionalcommits.org): `type(scope): summary`, where
  type ∈ `feat | fix | refactor | docs | test | chore | build | perf`. Subject ≤ 72 chars,
  imperative mood ("add", not "added"). Body explains **why**, not what the diff already shows.
- **Never commit:** secrets, API keys, `node_modules/`, build output (`out/`, `dist/`), or
  build caches (`*.tsbuildinfo`). Enforced via `.gitignore`; a stray secret is a stop-the-line
  event (rotate the key, then scrub).
- **Pushing is deliberate.** Push when a unit of work is coherent and green, not mid-refactor.

---

## 3. Code hygiene

- **TypeScript strict everywhere.** `strict`, `noUnusedLocals`, `noUnusedParameters`,
  `noFallthroughCasesInSwitch` are on for both bundles and MUST stay on. `npm run typecheck`
  MUST be clean before any commit.
- **`any` is a smell.** Prefer precise types; where the SDK's runtime shape genuinely drifts
  from its types, isolate the cast behind a small, commented, defensively-parsed adapter (see
  the `StreamEvent`/`ContentBlock` narrowing in `AgentManager.ts` for the pattern) — never let
  an untyped value travel.
- **Naming:** descriptive and consistent. Files: `PascalCase.tsx` for React components,
  `camelCase.ts` for modules. Exported types in `electron/shared` are the canonical names; the
  renderer imports them, never re-declares them.
- **Module size:** when a file does more than one job, split it. Services behind interfaces
  (`LayoutService`, `AgentClient`) so implementations are swappable.
- **Comments explain _why_, not _what_.** Match the surrounding density. Good comments capture
  a non-obvious constraint, a probe-verified SDK quirk, or an invariant — not a paraphrase of
  the code. (The existing codebase does this well; keep that bar.)
- **No dead code, no commented-out blocks, no stray `console.log`.** Delete it; git remembers.
- **No suppressions without a reason.** An `eslint-disable` / `@ts-expect-error` MUST carry an
  inline justification and be as narrowly scoped as possible.

---

## 4. Architecture invariants (hard rules — violations are bugs)

These are load-bearing and restated from CLAUDE.md because review enforces them:

1. **No TUI scraping.** Render structured SDK message blocks. ANSI is rendered only in xterm.js
   stream panes.
2. **Renderer is sandboxed.** `contextIsolation: true`, `nodeIntegration: false`. All
   privileged work (SDK, fs, process spawn) lives in main, behind the preload `contextBridge`.
3. **Plugins are capability-bounded.** A plugin reaches the app only through the host API. No
   direct fs / SDK / IPC. A malformed or crashing plugin must never crash the app.
4. **Every boundary payload is validated at the receiving side** (Zod).
5. **Agent instances are isolated** — own `cwd`, session, transcript. One instance's failure is
   contained.
6. **Layout and plugin state are filesystem/JSON, not hardcoded.**

A change that weakens any of these requires an explicit, recorded decision — not a quiet diff.

---

## 5. Exception handling

- **Validate at the boundary, then trust inward.** Parse external/`unknown` data with Zod (or a
  documented defensive adapter) at the edge; interior code works with known-good types.
- **Catch narrowly, handle meaningfully.** A `catch` either (a) recovers, (b) translates to a
  typed/surfaced error, or (c) is a deliberate, commented no-op for a known-benign case (e.g.
  closing an already-dead query). An empty `catch {}` without a comment is not acceptable.
- **Surface, don't swallow.** User-facing failures become structured error UI blocks (message +
  expandable detail); background failures are logged with context. Never let an error vanish.
- **Bound your recovery.** Self-healing loops (e.g. the agent pump's auto-restart) MUST be
  bounded and reset on success, so a persistent failure can't spin forever. (See `Session.restart()`.)
- **Guard external calls that can hang** with a timeout (see the usage-poll `Promise.race`).
- **Distinguish expected from exceptional.** A user pressing Stop is not an error; model
  unavailability is. Render each as what it is.

---

## 6. Documentation

- **DECISIONS.md** — one line per non-obvious choice, dated, with the _why_. Append on every
  such choice. This is the project's memory; keep it current.
- **PROGRESS.md** — running build log: what's done, what's next, open questions, and any
  acceptance criterion that needs a human spot-check. Update it as part of finishing work, not
  as an afterthought. It MUST reflect reality — a stale "current phase" is a defect.
- **SDK_NOTES.md** — what we confirmed against the live Agent SDK reference (the SDK surface
  drifts; never trust a remembered snippet). Update before building on a new SDK feature.
- **Code-level:** every exported function/type and every non-obvious invariant gets a short doc
  comment. README stays accurate enough that a new contributor can clone, install, and run.
- **Decisions are recorded where they're discoverable** — in the repo, not in chat.

---

## 7. Testing

Target a pragmatic, value-first test pyramid — not coverage theater:

- **Unit tests (most):** pure logic with clear inputs/outputs and real risk of regression. In
  this codebase the priority targets are the transcript/session model (`sessionStore.ts`,
  `transcriptModel.ts` — uuid/parent threading, tool-result pairing, edit-in-place, branch/
  fork-point grouping), conversation persistence (`conversationStore.ts`), and Zod boundary
  schemas (valid/invalid payloads).
- **Integration tests (some):** the IPC contract and AgentManager lifecycle (create → send →
  branch → close → restore) with the SDK faked at the boundary.
- **End-to-end / manual (few):** anything requiring a live model or real Electron windows is
  captured as an explicit **"needs human spot-check"** item in PROGRESS.md until automatable.
- **Rules:** new non-trivial logic ships with tests. A bug fix ships with a test that fails
  before the fix and passes after (regression lock). Tests are deterministic and isolated — no
  network, no real model calls, no shared mutable state; mock the SDK and fs boundaries.
- **Runner:** **Vitest** (Vite-native, matches our toolchain). Test files live next to source
  as `*.test.ts`. `npm test` MUST pass before merge.

---

## 8. Continuous integration

- A CI workflow runs on every push and PR: **install → typecheck → lint → format:check → test →
  build**. A red pipeline blocks merge. `main` is protected.
- CI is the objective gate; "works on my machine" is not a status.
- Keep the pipeline fast (cache `node_modules`); a slow gate gets bypassed.
- **Confirm the result after every push — don't assume green.** Run `npm run ci:status` (waits for
  the run on `HEAD` and reports success/failure) or `npm run ci:check` (single, no wait). It reads
  the Actions API via `$GH_TOKEN` or the local git credential helper, so no manual visit to the
  Actions tab is needed. A push isn't "done" until its CI run is confirmed green.

---

## 9. Linting & formatting

- **ESLint** (typescript-eslint, React hooks rules) is the correctness/style gate;
  **Prettier** owns formatting so style is never a review topic. Both run in CI; `npm run lint`
  locally.
- Formatting is automated, not argued. One config, applied repo-wide.
- The codebase already references `eslint-disable` in places — those presume the linter is
  wired; closing that gap (below) makes the assumption real.

---

## 10. Dependencies & security

- **Single-user, local tool:** no auth, no multi-user, no remote hosting plumbing.
- **Auth via the user's existing Claude session / `ANTHROPIC_API_KEY`** only. The main process
  MUST NOT silently enable pay-as-you-go API billing; it warns on a present key and treats
  `oauth`/`none` as the safe subscription path. (DECISIONS.md.)
- **Pin dependency versions** (exact, as in `package.json`); upgrade deliberately, noting any
  peer-conflict resolution in DECISIONS.md.
- **Least privilege:** the renderer and plugins get only the capabilities they need. Add a
  dev-compatible strict CSP in the hardening pass (tracked).
- Don't add a dependency for something a few lines of clear code can do.

---

## 11. Review & definition of done

A change is done when **all** hold:

- Typechecks clean; lint clean; tests pass; `npm run build` succeeds; `npm run dev` launches.
- The phase's ROADMAP acceptance criteria are met, or the un-automatable parts are listed in
  PROGRESS.md as spot-checks.
- DECISIONS.md and PROGRESS.md are updated.
- No architecture invariant (§4) is weakened without a recorded decision.
- The diff is small enough to review, or split into reviewable parts.

---

## Status of enforcement (honest current state — 2026-06-28)

This doc sets the bar. As of the 2026-06-28 hardening run, the full gate
(typecheck → lint → format → test → build) is wired and green. What's true today:

| Practice                                      | Status                                                                |
| --------------------------------------------- | --------------------------------------------------------------------- |
| Git repo, `.gitignore`, conventional commits  | **In place** (repo initialized; this is the baseline going forward)   |
| TypeScript strict + `npm run typecheck` gate  | **Enforced** (both bundles, clean)                                    |
| Structured/bounded exception handling         | **Practiced** in main (agent pump, usage guard)                       |
| DECISIONS / PROGRESS / SDK_NOTES discipline   | **Practiced**                                                         |
| Unit tests + `npm test` (Vitest)              | **Enforced** — 25 tests over schemas + session/conversation stores    |
| ESLint + Prettier (`npm run lint` / `format`) | **Enforced** — flat config, repo-wide Prettier, clean pass            |
| CI pipeline (`.github/workflows/ci.yml`)      | **Enforced** — install→typecheck→lint→format→test→build on push/PR    |
| Zod boundary validation                       | **Partial** — used + unit-tested; audit that _every_ boundary covered |

Remaining (tracked in PROGRESS.md, not blocking): broaden test coverage to `transcriptModel.ts`
and the AgentManager lifecycle (SDK faked at the boundary); audit full IPC boundary coverage;
adopt `--max-warnings 0` after burning down `no-explicit-any` warnings; add a dev-compatible
strict CSP.
