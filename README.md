<div align="center">

# Atelier

**A legible, dockable, hot-reloadable desktop workbench for working with Claude.**

[![CI](https://github.com/AshenRabbitStudios/Atelier/actions/workflows/ci.yml/badge.svg)](https://github.com/AshenRabbitStudios/Atelier/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

_Chat is a keyhole. Atelier is the workshop._

</div>

---

Atelier is a desktop app for working with Claude on real projects, built on the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript). Instead of a
single scrolling transcript, you get a **Photoshop-style dockable workspace**: chat panels,
live terminal streams, living documents, diagrams, data tables, and 3D architecture maps —
each one a plugin pane you can arrange, float, and stack however the work demands.

The core idea: **make the agent's activity legible.** When Claude edits files, runs
commands, or reasons through a problem, you should be able to _see_ that work through the
right surface — a diff, a terminal, a rendered document, a map — not squint at it through
scraped terminal output.

## Why Atelier

- **Structured rendering, never TUI scraping.** Atelier drives Claude through the SDK's
  structured message stream. Markdown renders as markdown, code renders through Shiki with
  real highlighting, thinking is collapsible, tool calls are expandable rows with
  pretty-printed inputs and diffs. Output is never garbled, because nothing is scraped.
- **A workspace, not a window.** Docking via [Dockview](https://dockview.dev): split, tab,
  float, and rearrange panes freely. Layouts are serializable JSON — your arrangement
  survives restarts.
- **Multiple isolated conversations.** Each conversation is its own agent instance with its
  own working directory, session, transcript, and set of enabled plugins. One instance
  crashing never touches another.
- **Plugins the agent can author.** A plugin is just a folder — a manifest plus a web pane
  and/or a small tool backend — hot-loaded from `plugins/` and reached only through a
  narrow, capability-bounded host API. Claude can write new plugins for you _from inside a
  conversation_, and there's a built-in `plugin_authoring_guide` tool that teaches it the
  contract. The surfaces you use to watch the agent work can grow over time, authored by
  the agent itself.
- **Context documents.** Plugins can contribute persistent per-conversation working state
  (a mental model, a plan, a data table, a map) that is injected back into Claude's context
  every turn — shared state you can both read and edit, that survives clearing the chat.
- **Your subscription, not your API bill.** Atelier authenticates through your local
  Claude Code session (Pro/Max or Console). It deliberately strips `ANTHROPIC_API_KEY`
  from its environment so it can never silently bill your API account.

## What ships in the box

| Plugin           | What it gives you                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| **hologram**     | A navigable 3D subway-style architecture map of a codebase; Claude pushes scenes, you drill into nodes  |
| **cartographer** | Maps a subject's blocked conceptual shapes across a conversation (Map/Director framework)               |
| **cognition**    | Persistent agent working state — mental model, working-memory slots, plan, problems log — across clears |
| **browser**      | An embedded Chromium surface Claude can point at local files or the web, and read back what you see     |
| **living-doc**   | Tails a Markdown file in the working directory and live-renders it as it changes                        |
| **bash-stream**  | A real terminal pane (xterm.js) mirroring the shell I/O of the commands Claude runs                     |
| **data-table**   | A spreadsheet-style grid backed by a CSV context document you and Claude both edit                      |
| **diagram**      | 2D node-and-edge diagrams Claude describes and the pane lays out                                        |
| **instructions** | A user-authored standing instruction appended to the system prompt, editable in a pane                  |
| **tool-plugin**  | A minimal example of contributing callable tools backed by a sandboxed child process                    |

## Getting started

### Prerequisites

- **Node.js 20.19+ or 22.12+** — the one thing you must install yourself
  ([nodejs.org](https://nodejs.org), or `winget install OpenJS.NodeJS.LTS` /
  `brew install node`). npm is included with Node.
- **A Claude account** — a claude.ai subscription (Pro/Max) or a Claude Console account.
- **Windows, macOS, or Linux.**

Everything else — dependencies, the Electron binary, the
[Claude Code CLI](https://code.claude.com/docs), sign-in, and the app build — is handled
by the launcher.

### Install & run

```bash
git clone https://github.com/AshenRabbitStudios/Atelier.git
cd Atelier
```

Then start it:

| Platform      | Command                        |
| ------------- | ------------------------------ |
| Windows       | `run.bat` (double-click works) |
| macOS / Linux | `./run.sh`                     |

The launcher is a guided, idempotent bootstrap: it checks every prerequisite, explains
anything that's missing and what the fix touches, and **asks before each fix** (press
Enter to accept the default). If you're not signed in to Claude, it opens the browser
sign-in flow and continues automatically. On a healthy tree it re-checks everything in a
couple of seconds and starts the app. Safe to re-run anytime.

```
Atelier startup — /home/you/Atelier
  [ OK ] Node.js — v22.14.0
  [ OK ] Dependencies — node_modules matches package-lock.json
  [ OK ] Electron binary
  [ OK ] Claude Code CLI — 2.1.198 (Claude Code)
  [ OK ] Claude sign-in — signed in
  [ OK ] App build — up to date

Starting Atelier...
```

More launcher modes:

```bash
run.bat doctor      # health check only — reports, changes nothing
run.bat dev         # start with hot reload (development)
run.bat --yes       # unattended: accept every fix without prompting
```

Full details, failure modes, and design rationale: [docs/INSTALL.md](docs/INSTALL.md).

## Architecture at a glance

```
┌────────────────────────────────────────────────────────────┐
│ Main process (Node)                                        │
│   AgentManager ──── Claude Agent SDK (N isolated sessions) │
│   PluginHost ────── watches plugins/, hot-loads, sandboxes │
│   Typed IPC ─────── Zod-validated at every boundary        │
├────────────────────────────────────────────────────────────┤
│ Renderer (React, fully sandboxed — no Node, no SDK)        │
│   Dockview workspace · chat panels · plugin sidebar        │
├────────────────────────────────────────────────────────────┤
│ Plugin sandboxes (one webview per plugin pane)             │
│   reach the app only through the narrow host API           │
└────────────────────────────────────────────────────────────┘
```

- **Electron + TypeScript end to end**; React renderer; Vite bundling.
- The SDK lives in the **main process only**; the renderer talks over a typed,
  Zod-validated IPC bridge (`contextIsolation: true`, `nodeIntegration: false`).
- Plugins are **capability-bounded**: a pane can render anything, but it reaches the app
  only through the host API. A crashing or malformed plugin can never take down the app.
- Only remote web content is treated as hostile; plugins are trusted, contained code.

The full contracts live in [SPEC.md](SPEC.md) (architecture) and
[PLUGIN_API.md](PLUGIN_API.md) (the plugin manifest + host API).

## Writing a plugin

A plugin is a folder in `plugins/`:

```
plugins/my-plugin/
├── manifest.json   # id, name, permissions, panel/tools/context entries
├── index.html      # a web pane (optional)
└── backend.cjs     # tool handlers in a sandboxed child process (optional)
```

Drop the folder in and it hot-loads — no restart, no build step. Panes are plain web
pages talking to the host over a small `window.atelier` API; backends contribute tools
Claude can call. The complete contract — manifest schema, host API, permissions, context
documents — is in [PLUGIN_API.md](PLUGIN_API.md), and Claude can fetch the same contract
at runtime via the built-in `plugin_authoring_guide` tool, so you can simply ask it to
build you a new pane.

## Built by the agent it hosts

This codebase is being built **autonomously by Claude Code**, working phase by phase from
a doc set checked into the repo — and Atelier is itself the workbench used to build
Atelier. If you're curious how that works, read in this order:

1. [CLAUDE.md](CLAUDE.md) — the operating manual the agent follows every session
2. [SPEC.md](SPEC.md) — architecture and contracts
3. [PLUGIN_API.md](PLUGIN_API.md) — the extensibility contract
4. [ROADMAP.md](ROADMAP.md) — phased vertical slices with acceptance criteria
5. [docs/](docs/) — engineering standard, decisions log, progress log, SDK notes

## Development

```bash
npm run dev           # electron-vite dev server with hot reload
npm run doctor        # environment health check
npm run build         # production build into out/
npm run typecheck     # tsc, node + web configs
npm run lint          # eslint
npm run format:check  # prettier
npm test              # vitest
```

CI runs the same gate on every push. Engineering conventions, the definition of done, and
the review checklist live in [docs/ENGINEERING.md](docs/ENGINEERING.md).

## Status & scope

Atelier is a **single-user, local** tool under active development. There is no auth
layer, no multi-user mode, and no remote hosting — it runs on your machine against your
own Claude session. Expect sharp edges; the decisions log
([docs/DECISIONS.md](docs/DECISIONS.md)) and progress log
([docs/PROGRESS.md](docs/PROGRESS.md)) are the honest state of things.

## License

[MIT](LICENSE) © Ashen Rabbit Studios
