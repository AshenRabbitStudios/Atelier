# Atelier — build docs

**Atelier** (working codename — rename freely) is a desktop app for working with Claude:
a dockable chat interface to the Claude Agent SDK, plus a hot-reloadable, Photoshop-style
plugin system so the surfaces you use to *see what the agent is doing* can grow over time —
authored by hand now, and eventually by the agent itself.

## This is a doc set for an autonomous Claude Code build

Hand these to Claude Code CLI and let it build in phases. Read them in this order:

1. **CLAUDE.md** — operating manual. Loaded every session. Invariants, stack, working
   method, definition of done. *Start here, and do what its "Before you write any session
   code" step says.*
2. **SPEC.md** — architecture and the contracts that make components interlock.
3. **PLUGIN_API.md** — the extensibility contract (plugin manifest + host API). The heart
   of the "make it do anything" requirement and the self-hosting loop.
4. **ROADMAP.md** — phased vertical slices, each with acceptance criteria the agent can
   self-check. Build in this order. Do not build the whole framework before the first
   slice runs.

## Substrate (decided)

Electron + TypeScript, single language end to end. Agent orchestration via
`@anthropic-ai/claude-agent-sdk` in the main process. UI in React. Docking via Dockview.
Plugins are isolated web panes. Rationale and alternatives considered live in SPEC.md §1.

## The two non-negotiables

If the build tries to simplify these away, push back:

- **Structured rendering, never TUI scraping.** Render the SDK's structured message blocks
  yourself. This is what makes output never-garbled, reasoning expandable, and history
  editable. See SPEC.md §3.
- **Capability-bounded, content-unbounded plugins.** A plugin pane can render anything; it
  reaches the rest of the app only through the narrow host API. See PLUGIN_API.md.
