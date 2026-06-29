# ROADMAP — Atelier

Build in this order. Each phase is a **thin vertical slice** that runs end to end before
the next begins. Do not scaffold later phases early. Each phase lists acceptance criteria;
where a criterion can't be checked headlessly, list it in `docs/PROGRESS.md` as
"needs human spot-check."

---

## P0 — Skeleton + one chat panel (never garbled)

Electron + Vite + React + TypeScript. Dockview workspace with a `LayoutService`. Typed IPC
bridge (preload `contextBridge`). `AgentManager` supporting **one** instance. Structured
rendering: text (markdown + Shiki code), thinking (collapsible), tool_use/tool_result
(expandable). Streaming + interrupt.

**Do first:** the SDK verification step in CLAUDE.md; write `docs/SDK_NOTES.md`.

**Acceptance**

- `npm run dev` opens a window with one docked chat panel.
- Typing a prompt streams a response token-by-token.
- A response containing a fenced code block renders highlighted, not garbled, with original
  whitespace intact.
- A thinking block renders collapsed and expands on click.
- A tool call (e.g. ask it to read a file) shows an expandable tool_use row with its result.
- An in-flight response can be interrupted.

## P1 — Multiple instances + editable history

`AgentManager` supports N instances, each with its own `cwd` and session. An instance
switcher / multiple chat panels. Editable user messages via session fork.

> **Descoped (2026-06-28):** "also rewind files" / file checkpointing is intentionally
> NOT built. Reverting the working tree on a fork is a foot-gun that can silently undo
> work the user meant to keep; file history is handled by git versioning instead. The
> fork is conversation-only and never touches files. (DECISIONS.md.)

**Acceptance**

- Create two instances pointing at two different folders; both run concurrently and
  independently; each loads its own project `CLAUDE.md` (`settingSources: ['project']`).
- Editing a past user message forks the session there and streams a new continuation; the
  transcript truncates correctly after the edited message.
- Forking is conversation-only; the working tree is never modified by Atelier.

## P2 — Docking polish + persistence

Dock bottom/side/center/fullscreen; tabify; in-app floating groups. Font-scale control on
the chat panel. Serialize layout to disk and restore on launch.

**Acceptance**

- A panel can be docked to each region, tabbed, and floated in-app.
- Chat text scales up/down via the control.
- Closing and reopening the app restores the previous layout.
- (Spot-check) The float/dock/tab interactions feel like Photoshop-style panel management.

## P3 — Plugin host + first panel plugin

`/plugins` watcher; collapsible plugin sidebar with discovered plugins and a "Load plugin"
action; load/unload/reload mounting the entry in a sandboxed pane; the host API subset
needed for panels (`layout`, `storage`, lifecycle); Zod-validated manifests. Ship
`/plugins/examples/hello-panel`.

**Acceptance**

- `hello-panel` appears in the sidebar on discovery and loads into a dockable pane.
- Editing the plugin's file and hitting reload updates the pane **without app restart**.
- The pane can dock/float via `layout`, and a value persists across reload via `storage`.
- A deliberately broken plugin shows an error in the sidebar and does **not** crash the app.

## P4 — Data channels + tool-contributing plugins + ambient Bash tap

The `DataBus` and the `data` host API. A PreToolUse/PostToolUse hook that opens a
`bash:<toolUseId>:stdout` channel tailing each Bash command. Plugin-contributed agent tools
(`tools` permission + backend module). Ship `/plugins/examples/bash-stream` (xterm.js pane
subscribed to the bash channel).

**Acceptance**

- Running a bash command via an agent instance streams its real stdout/stderr into the
  `bash-stream` pane live, rendered faithfully (ANSI intact) by xterm.js.
- The bash-stream surface is visibly marked as ambient/reality (not agent-authored).
- A `kind: "both"` example plugin registers an agent tool; an instance can call it and the
  result returns; unloading the plugin removes the tool.

## P5 — Self-hosting proof

Demonstrate the loop end to end: an agent instance pointed at the Atelier repo authors a
new plugin folder; the watcher surfaces it; the user loads it without restart.

**Acceptance**

- From inside Atelier, ask an instance to "make a plugin that renders X." It writes a valid
  `/plugins/<id>/` folder.
- The new plugin appears in the sidebar and loads and works without restarting the app.
- `docs/PROGRESS.md` records this as the self-hosting milestone.

## P6 — Deferred / optional

- True OS-detached windows: tear a panel into its own OS window and re-dock it (serialize
  panel → child `BrowserWindow` → re-insert). Only after P0–P5 are solid.
- Richer ambient surfaces (metrics JSONL channel + a chart plugin; a living-doc surface).
- Plugin `apiVersion` gating once the host API first changes.

---

## Global definition of done

Per CLAUDE.md: each phase builds with no type errors, `npm run dev` launches, the phase's
acceptance criteria are met (or un-automatable ones are listed for spot-check), and
`docs/PROGRESS.md` + `docs/DECISIONS.md` are updated. Stop and surface for review at the
end of each phase rather than running all phases unattended.
