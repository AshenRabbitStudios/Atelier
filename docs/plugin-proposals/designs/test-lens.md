# test-lens — design

The TDD red/green loop as a first-class pane. Status: **design** (not built). Grounded in
PLUGIN_API.md, docs/PLUGIN_ARCHITECTURE.md, docs/CONTEXT_SYSTEM.md, and the proposal
"5. test-lens" in docs/plugin-proposals/PROPOSALS.md. Tier: **T1** (ships enabled-by-default).

Anything not directly supported by those docs is marked **[extrapolation]**.

---

## 1. Purpose + user stories

**Purpose.** Turn test output — the agent's primary verification signal — from scrolled-away
terminal spam into a persistent, structured pane, and export the current failing set as a
context document so the agent knows what's red **without re-running tests just to see state**
(PROPOSALS §5). This is the two-sided win the proposal names: a visual red/green loop for the
human, and a measurable cost reduction for the agent (no "run the tests again to check" turns).

**User stories.**

- _As the human_, I want to see suites → tests as a red/green tree with failure messages
  inline, so I can read a failure without scrolling a terminal.
- _As the human_, I want one-click re-run of a single test or file, so tightening a red test
  into green is a click, not a re-typed command.
- _As the human_, I want a per-test history sparkline so I can spot a **flaky** test (a
  red/green/red pattern) before I waste a debugging session on it.
- _As the agent_, I want the current failing set injected into my context every turn, so I
  resume a TDD loop knowing exactly what's failing without spending a turn (and tokens)
  re-running the suite.
- _As the agent_, I want a backend tool to run the suite (or a filtered subset) and get a
  parsed, bounded result, so verification is one structured call, not a bash tail I must
  scrape (architecture invariant 1: no TUI scraping).
- _As either party_, I want the runner **auto-detected** (vitest/jest/pytest/cargo/go) so the
  plugin works on a fresh repo with zero configuration.

---

## 2. Panel UX

Single docked pane (`defaultDock: "bottom"` — verification output belongs under the work,
alongside a terminal/proc pane). Three regions.

**a. Header / control strip.**

- Detected runner badge (e.g. "vitest") + the resolved command, with a click to override
  detection (see §4 detection) when a repo has more than one plausible runner.
- Summary counts: ● N passed · ● M failed · ○ K skipped · ⧗ elapsed.
- Global controls: **Run all**, **Run failed only**, **Stop** (visible while a run is in
  flight), and a **Watch** toggle (§4 watch mode).
- Status: idle / running (with a live-updating count as results stream) / errored (runner
  crashed or command not found — surfaced as a pane error, never thrown into the host).

**b. Result tree.** Suites → files → tests, collapsible.

- Each node carries a red (fail) / green (pass) / grey (skipped) / amber (running) state dot.
  A parent rolls up to red if any descendant is red.
- A failing test expands to show its **inline failure message**: assertion diff
  (expected/received), error message, and the stack's first in-repo frame as a `file:line`
  the user can click to open in their editor **[extrapolation — depends on an editor-open
  affordance; the plugin can at minimum render the location as text]**.
- Per-test row affordances: **▶ re-run this test**, **▶ re-run this file** (on file nodes),
  and a **history sparkline** (see c).
- Default filter presents _failures first, expanded_; passes collapse into a green summary
  bar so a 900-test suite with 3 reds shows the 3 reds immediately. A filter control toggles
  "failed only / all".

**c. Per-test history + flaky detection.** Each test row shows a small sparkline of its last
N outcomes (e.g. last 20 runs: a row of red/green ticks). A test whose recent history mixes
red and green **without an intervening code change to its file** is badged **flaky**
(a small ⚡). History is keyed by a stable test id (see §4 parsing) and stored in plugin
`storage` so it survives reload, conversation-switch, and app restart (PLUGIN_API §8). Flaky
detection "falls out for free" from keeping this history, exactly as the proposal claims.

**d. Re-run affordances summary.** Run all / run failed / run file / run single test — each
routes through the same invocation path (§4) so the pane, the sparkline history, the summary,
and the context export all update from one code path regardless of who triggered the run
(human click, watch event, or the agent's tool call).

---

## 3. Manifest sketch

Real JSON matching the schema in PLUGIN_API.md §1/§4/§5 and CONTEXT_SYSTEM.md. `kind: "both"`
(a panel **and** contributed tools), a `backend` (required because it registers tools and runs
a child process), `contextExports` for the failing set, and least-privilege permissions.

```jsonc
{
  "id": "test-lens",
  "name": "Test Lens",
  "version": "0.1.0",
  "description": "Auto-detects your test runner (vitest/jest/pytest/cargo/go), renders results as a red/green tree with inline failure messages and per-test flaky-detection history, and exports the current failing set as a context document so the agent knows what's red without re-running.",
  "icon": "M4 8.5l2.2 2.3L12 5M3 3.5h10v9H3z",
  "kind": "both",
  "entry": "index.html",
  "backend": "backend.cjs",
  "service": true,
  "defaultDock": "bottom",
  "permissions": ["tools", "context", "storage", "data:subscribe", "data:publish"],
  "contextExports": [
    {
      "key": "failing",
      "label": "Failing tests",
      "format": "markdown",
      "maxTokens": 2000,
      "readonly": true
    }
  ],
  "tools": [
    {
      "name": "run_tests",
      "description": "Run the project's test suite (auto-detected runner) or a filtered subset. Returns a parsed summary: counts plus each failing test's id and message. Prefer reading the pinned 'Failing tests' context over calling this just to see current state.",
      "inputSchema": {
        "filter": "string?",
        "failedOnly": "boolean?",
        "runner": "string?"
      },
      "timeoutMs": 600000
    },
    {
      "name": "list_failing",
      "description": "Return the current failing set from the last run without running anything. Cheap; use this instead of re-running to check state.",
      "inputSchema": {}
    }
  ]
}
```

Notes on the manifest choices:

- **`service: true`** (PLUGIN_API §5). test-lens is a long-running service, not an on-demand
  responder, because watch mode and the freshness contract need a persistent child that owns
  the runner process and pushes results unsolicited. A service is spawned when first enabled
  and kept alive until disabled in the last conversation; it may `publish` onto a DataBus
  channel — which is why `data:publish` is declared.
- **`contextExports[].readonly: true`.** The failing set is host-generated from real test
  output; the agent must not hand-edit it (that would defeat the "ground truth" purpose). The
  `readonly` flag appears on cognition's `north-star` export, so it is a supported field.
  Because it's readonly, the host does **not** register a `set_test-lens__failing` write tool
  for it (CONTEXT_SYSTEM.md's auto-tool generation is for editable exports); the plugin owns
  the value via `context.update` from the backend/pane.
- **`data:publish`** lets the service push run results/progress onto a channel the pane
  subscribes to (`data:subscribe`), so the pane updates live during a run without polling.
- **No `net:fetch` / `browser:embed` / `agent:send`.** Everything is local process + files;
  least-privilege per PLUGIN_API §4. (See §4 for the one case where invoking _through the
  agent_ is considered and rejected as the default.)

---

## 4. Architecture

```
                 ┌──────────────── main process ────────────────┐
  pane (sandbox) │  test-lens backend (service child process)   │
  ── run_file ──▶│  RunnerAdapter (vitest|jest|pytest|cargo|go)  │
  ◀─ results ────│    detect() → command + JSON-reporter flags    │
   (DataBus)     │    spawn child, stream+parse → normalized tree │──▶ context.update('failing', md)
                 │    watch mode: keep child, re-parse on event   │──▶ publish('test-lens:results', …)
  agent          │  history store (storage) + flaky classifier    │
  ── run_tests ─▶│  tool handlers: run_tests / list_failing       │
                 └───────────────────────────────────────────────┘
```

### 4.1 Runner detection

The backend resolves a `RunnerAdapter` by probing the conversation cwd, in priority order,
stopping at the first match. Detection signals per runner:

- **vitest** — `vitest` in `package.json` deps/devDeps, or a `vitest.config.*`, or a `test`
  script that invokes `vitest`. (This repo: `"test": "vitest run"` — the first-class case.)
- **jest** — `jest` dep, `jest.config.*`, or a `jest` key in `package.json`.
- **pytest** — `pytest.ini` / `pyproject.toml` `[tool.pytest]` / `setup.cfg [tool:pytest]`,
  or a `tests/` dir with `test_*.py`.
- **cargo** — a `Cargo.toml`.
- **go** — a `go.mod` or `*_test.go` files.

Ambiguity (JS repo with both vitest and jest; a monorepo) is resolved by (1) an explicit
`runner` override in the manifest/storage, then (2) the `test` script's actual invocation,
then (3) the priority order above. The header badge is clickable so the human can override,
and the override persists in `storage`. Detection re-runs on the `load` hook and when the
watched config files change **[extrapolation — relies on a `file:` subscribe to config
paths; supported via `data:subscribe`]**.

### 4.2 Invocation strategy — backend child process (default), not "ask the agent"

The proposal's phrase is that re-run "writes the command through the agent **or** a backend
runner." This design makes the **backend child process the default** and treats agent-run as
a fallback, for concrete reasons:

- A backend child gives a **structured, parsed** result directly (invariant 1: render
  structured blocks, never scrape a TUI). Asking the agent to run tests puts raw output in
  the transcript and requires re-parsing it out — the exact anti-pattern the plugin exists to
  kill.
- It works **whether or not the agent is mid-turn** — a human clicking "re-run" must not have
  to wait for or interrupt the agent.
- It keeps the freshness contract (§5) cheap: the backend updates the context export itself,
  so a human-triggered run also refreshes what the agent sees, with no agent turn consumed.

The child is spawned by the host's `PluginBackendManager` and speaks the documented protocol
(PLUGIN_API §5): parent → `{ id, tool, input }`, child → `{ id, result | error }`, plus
lifecycle `hello` / `enable` / `disable` / `bye`; as a service it may push
`{ publish: { conversationId, channel, data } }`. The child spawns the _runner_ as its own
grandchild process via Node `child_process` and streams stdout/stderr.

**Agent-run fallback [extrapolation].** If no backend runner can be produced (e.g. the runner
needs an interactive TTY, or the repo needs a bespoke wrapper command), the plugin can fall
back to `agent.send` to ask the agent to run the command — but that needs `agent:send`, which
is **not** in the default manifest. Ship v1 backend-only; add the fallback (and the
permission) only if a real runner demands it. Flag as a decision if adopted.

### 4.3 Output parsing per runner (JSON reporters where available)

Never scrape human-formatted output when a machine-readable reporter exists. Each adapter
normalizes to one internal shape:

```ts
type TestResult = {
  id: string // stable: "<file>::<full test name>" — the sparkline/history key
  file: string
  name: string // full nested name (describe > it)
  status: 'pass' | 'fail' | 'skip'
  durationMs?: number
  message?: string // failure message + assertion diff, capped
  location?: { file: string; line: number } // first in-repo stack frame
}
```

Per runner:

- **vitest** — `vitest run --reporter=json` (or `--reporter=json --outputFile=…`). Emits a
  JSON tree of files → assertion results with `status`, `duration`, and `failureMessages`.
  This is the **first** adapter (§7) since Atelier itself uses vitest.
- **jest** — `jest --json` (optionally `--outputFile`). Same conceptual shape (`testResults[]`
  → `assertionResults[]`); adapter maps it to `TestResult` almost identically to vitest.
- **pytest** — `pytest -q --json-report` via the `pytest-json-report` plugin when present;
  otherwise `--junitxml=<tmp>` (JUnit XML, no extra dependency) parsed into the same shape.
  Adapter prefers JSON, falls back to JUnit XML. **[extrapolation on which reporter is
  installed — the JUnit fallback is dependency-free and is the safe default.]**
- **cargo** — `cargo test -- -Z unstable-options --format json` on nightly, or the stable
  `cargo test --message-format=json` build stream plus parsing the libtest output; simplest
  robust path is `cargo test -- --format json` where available, else parse the `test … ok /
FAILED` lines. **[extrapolation — cargo's stable JSON test output is limited; line-parsing
  is the fallback and is inherently more fragile, see §8.]**
- **go** — `go test -json ./...` — a well-specified stream of `{Action, Package, Test,
Output, Elapsed}` events. Robust; `Action: "fail"|"pass"|"skip"` maps directly.

Each adapter is a small module with `detect()`, `command(filter?)`, and `parse(stream)`.
Adding a runner is adding one file — no host change.

### 4.4 Watch mode

The **Watch** toggle asks the backend service to keep a long-lived runner in watch mode where
the runner supports it (vitest, jest have native watch; pytest via `pytest-watch` if present;
cargo/go via a file-watch loop the backend runs itself). On each watch-triggered completion
the backend re-parses, updates history + the context export, and `publish`es the delta to the
pane. Watch is why the backend is a **service** (§3): the child must outlive any single tool
call. When Watch is off, runs are one-shot (spawn → parse → exit).

---

## 5. The failing-set context export (freshness contract)

The export `failing` is the plugin's reason to exist for the agent. It is a **readonly**
context document (§3), auto-pinned when the plugin is enabled (CONTEXT_SYSTEM.md: enabling a
context-document plugin auto-pins its exports), injected every turn inside the host's
`<atelier-context>` frame, stripped from the visible transcript, and bounded by `maxTokens`
(2000) with host truncation-marking.

**Format** (markdown, so it renders in the injected block and is diff-legible):

```markdown
# Failing tests — 3 of 412 (vitest) · last run 14:02:11, took 6.4s

## src/services/LayoutService.test.ts

- **restores a saved dock position** — expected 'right', received 'left'
  at src/services/LayoutService.ts:88
- **round-trips a floating group** — TypeError: cannot read 'bounds' of undefined
  at src/services/LayoutService.ts:141

## electron/AgentManager.test.ts

- **forks a session** — timeout after 5000ms

_flaky (unstable across recent runs): electron/DataBus.test.ts › tails a channel_
```

Kept fresh by:

- **The backend owns the value.** After _every_ run (human click, watch event, or the agent's
  `run_tests` tool), the backend recomputes the failing set and calls `context.update('failing',
md)`. Because the update is host-side snapshot state re-read at send time (PLUGIN_ARCHITECTURE
  §2 / CONTEXT_SYSTEM.md), the agent sees the newest value on its next turn with no extra turn
  consumed.
- **A green run clears it** to an explicit "All N tests passing (vitest)" — the agent must be
  able to distinguish "nothing failing" from "no data yet". On first enable, before any run,
  the value is "No test run yet — run tests to populate." so the agent knows to run once.
- **Bounded.** When more failures than `maxTokens` allows, the export lists the failing
  _names/locations_ for all and truncates _messages_ first (a count of what's failing matters
  more than every stack), then marks truncation. This keeps the "which tests are red" signal
  intact even for a large red suite.
- **Restore.** The last computed export is also written to `storage` and re-pushed on the
  `load` hook (treat every mount as a restore, PLUGIN_API §8) so a reopened conversation shows
  the last-known failing set immediately, labeled with its run timestamp so staleness is
  visible, until the next run refreshes it.

`list_failing` returns this same set as a tool result so the agent can pull it on demand
without re-running — the tool description explicitly steers the agent to prefer the pinned
context / `list_failing` over `run_tests` for a pure state check.

---

## HOST-GAP

Capabilities this design needs that PLUGIN_API.md does not clearly provide today. None are
believed blocking for the vitest MVP; each is flagged so a reviewer can confirm or push back.

1. **Spawning an arbitrary child process from a backend.** The documented backend protocol
   (§5) describes the plugin↔host message contract but does not state whether a backend
   _child_ may itself spawn a grandchild (the actual `vitest`/`go test` process). The
   examples only compute in-process. **Need:** confirmation that a backend utility process may
   use Node `child_process` to run a subprocess, and whether the V8 heap cap
   (`--max-old-space-size=512`) or any sandbox restricts it. If backends can't spawn
   subprocesses, the whole "backend runner" strategy collapses to the agent-run fallback
   (§4.2). **This is the one gap that could change the plugin's shape — resolve first.**

2. **Long-run tool timeout.** `timeoutMs` maxes at 600000 (10 min) per PLUGIN_API §5. A full
   monorepo suite can exceed that. **Need:** either a streaming/progress result (so the tool
   returns incrementally) or acceptance that `run_tests` on a huge suite must be scoped
   (`filter`/`failedOnly`) — the design assumes the latter for v1 and relies on watch-mode +
   the context export for whole-suite freshness rather than one giant blocking call.

3. **Reading a runner-produced temp JSON file.** Some reporters write JSON to a file
   (`--outputFile`, `--junitxml`). The backend can read it directly with Node fs (it's a main-
   process child, not the sandboxed pane), so this is **not** a gap for the backend — noting it
   only to record that the pane must _not_ try to read those files (it has no fs; it receives
   parsed results over DataBus). No host change needed.

4. **Opening a `file:line` in the user's editor.** The clickable stack-frame affordance (§2b)
   needs an "open in editor" action; PLUGIN_API exposes no such host call. **Fallback:** render
   the location as selectable text. Not blocking; shared with other proposed plugins
   (workspace-explorer names the same need).

---

## 7. Implementation milestones (ordered)

1. **M1 — vitest, one-shot, read-only pane.** Detect vitest; backend spawns
   `vitest run --reporter=json`, parses to `TestResult[]`; pane renders the red/green tree with
   inline failure messages; **Run all** button. Proves detection + parse + tree on the runner
   Atelier itself uses. _(Resolve HOST-GAP 1 as the very first step.)_
2. **M2 — failing-set context export.** Wire `context.update('failing', md)` after each run;
   confirm auto-pin + per-turn injection + display-stripping; add `list_failing` tool. This is
   the milestone that delivers the headline "agent never re-runs just to see state" value.
3. **M3 — re-run affordances + `run_tests` tool.** Per-file / per-test re-run through one
   invocation path; the `run_tests` backend tool (`filter` / `failedOnly`). Human and agent
   now share the run path.
4. **M4 — history + flaky detection.** Persist per-test outcomes in `storage`; render
   sparklines; classify flaky (mixed recent outcomes without a change to the test's file).
5. **M5 — watch mode.** Service keeps a vitest watch child; live `publish` of deltas to the
   pane; export refreshes on every watch completion.
6. **M6 — more runners.** jest → go (both have clean JSON) → pytest (JSON/JUnit) → cargo
   (most fragile, last). Each is one adapter file; the tree/export/history are runner-agnostic.
7. **M7 — monorepo / multi-project** ergonomics: per-package detection, a package selector in
   the header, scoped runs. _(See §8 risk.)_

---

## 8. Risks

- **Parser fragility.** JSON reporters drift between runner versions; cargo has no stable rich
  JSON test format and may require line-parsing (§4.3) — the most brittle adapter. _Mitigation:_
  prefer versioned JSON reporters; keep each adapter isolated so one runner breaking never
  breaks the pane; on a parse failure, surface a pane error with the raw tail rather than
  throwing into the host (invariant: a bad plugin never crashes the app), and degrade to a
  bare pass/fail summary if structure can't be recovered.
- **Long runs.** Whole-suite runs can exceed the 10-min tool cap (HOST-GAP 2) and block a UI
  click for minutes. _Mitigation:_ default re-runs to the narrowest scope (single test/file);
  lean on watch mode + the context export for whole-suite freshness; show a live streaming
  count and a **Stop** control so a run is never a black box.
- **Monorepos.** Multiple projects, multiple runners, per-package configs defeat single-command
  detection. _Mitigation:_ M7 explicit per-package detection + selector; until then, honor the
  root `test` script and the manifest `runner` override, and clearly badge which project the
  pane is showing rather than silently guessing.
- **Test-id stability.** History/flaky detection needs stable ids; renamed or parametrized
  tests churn ids and lose history. _Mitigation:_ key on `file::full-name`; accept that a
  rename resets that test's history (documented, not silent), and never let a stale id badge a
  renamed test as flaky.
- **Cross-conversation leakage.** History and the failing set are per-(conversation, plugin)
  storage (PLUGIN_API §8) — must never bleed between conversations even for the same repo.
  _Mitigation:_ rely on the host's storage scoping; never cache results outside `storage`.

---

## 9. Acceptance criteria

- **Detection:** on this repo, the pane auto-detects **vitest** and shows the resolved command
  with no configuration.
- **Tree:** `npm test` results render as a suites → tests tree with correct red/green/skip
  states; a failing test shows its assertion diff / message inline; passes collapse so reds are
  visible first.
- **Re-run:** clicking re-run on a single failing test runs only that test and updates its row,
  the summary, and the export — without an agent turn.
- **Context export:** with the plugin enabled, the agent's injected context contains a
  `Failing tests` block that matches the pane; after a green run it reads "all passing"; the
  agent can answer "what's failing?" **without** issuing a run. `list_failing` returns the same
  set with no run.
- **Freshness:** a human-triggered run refreshes what the agent sees on its next turn (no agent
  action required).
- **History/flaky:** a test that alternates pass/fail across runs (with no change to its file)
  is badged flaky and shows a mixed sparkline; history survives reload, conversation-switch, and
  app restart.
- **Isolation:** a runner crash, a missing runner binary, or a malformed reporter surfaces as a
  pane error and never crashes Atelier or another plugin.
- **Restore:** closing and reopening the conversation re-shows the last failing set (timestamped)
  from `storage` before any new run.
- **Bounds:** a large red suite keeps every failing test's name in the export, truncates messages
  first, and marks truncation; the export never exceeds its `maxTokens`.
