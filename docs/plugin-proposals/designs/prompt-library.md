# Design: `prompt-library` plugin

A default Atelier plugin. A pane of user-curated prompt entries (title, description, template
with `{placeholders}`); one click fills the template — after placeholder substitution — into the
chat composer. Entries are stored as **plain markdown files with YAML frontmatter** in a folder so
they are portable and git-syncable. An agent tool can **propose** new entries when it notices a
repeated pattern; proposals land in an approval queue and only become library files after the user
approves.

Status: **design** (not built). Grounds every claim in PLUGIN_API.md / PLUGIN_ARCHITECTURE.md /
CONTEXT_SYSTEM.md; two capabilities the current contract does not provide are flagged as
**HOST-GAP** with a proposed API. Anything not directly supported by those docs is marked
**[extrapolation]**.

---

## 1. Purpose + user stories

**Purpose.** Personal prompt scaffolds ("my review checklist", "my release runbook", "the way I
like commit messages") today live in scattered text files and get re-pasted. This plugin makes
them first-class, parameterizable, one-click, portable, and — crucially — **grow-able by the
agent** so the library captures patterns the user keeps repeating (PROPOSALS.md §11).

**User stories.**

1. _As a user_, I keep a "PR review" prompt with `{pr_url}` and `{focus}` placeholders. I click it,
   fill the two fields in a small form, and the composed prompt lands in the chat input — I read it,
   tweak a word, and send. (One click → composer, not auto-send.)
2. _As a user_, I search my library by title/description/body and by tag, because I have 40 entries.
3. _As a user_, I edit an entry and, because it is just a markdown file in a folder, I `git commit`
   it and it syncs to my other machine. No export step.
4. _As a user_, after I paste the same "write a conventional-commit message for the staged diff"
   instruction for the third time, the agent proposes it as a library entry; I see it in an
   **approval queue**, edit the title/placeholders, and **Approve** — only then does a file appear
   in the library folder.
5. _As a user_, I reject a bad proposal and it is gone; nothing was ever written to the library.
6. _As the agent_, when I notice a repeated instruction shape, I call `propose_prompt(...)` with a
   title/description/template. I never write to the library directly; the user is the gate.

**Non-goals (v1).** No cross-device sync engine (git is the sync); no sharing/marketplace; no
server-side templating language beyond `{placeholder}` substitution; no auto-send of composed
prompts (the human always confirms in the composer).

---

## 2. Panel UX

`kind: "both"` — a panel (the library UI) plus a backend that registers the `propose_prompt` tool.
Default dock **left** [extrapolation — a reference/pick list reads well as a tall left pane].

**Layout (top → bottom):**

- **Search bar.** Filters the list live over title + description + tags + body substring. Client-side
  over the in-memory entry set (the pane owns the parsed entries). A tag chip row below the search
  narrows by tag.
- **Entry list.** Each row: title (bold), one-line description, tag chips, and a small
  placeholder-count badge (e.g. `2 fields`). Row click opens the fill-in form; a kebab menu offers
  Edit / Duplicate / Delete.
- **Fill-in form (inline drawer or modal over the pane).** Renders one labeled input per unique
  `{placeholder}` discovered in the template, in first-appearance order. Multi-line placeholders (a
  `{diff}` field) get a textarea; single-line get an input. A **live preview** shows the composed
  text with substitutions applied. Buttons: **Insert into composer** (primary), **Copy**, **Cancel**.
  Missing required fields are highlighted but do not block insertion (a leftover `{placeholder}` is
  passed through literally, so the user can fill it in the composer). Field values are remembered
  per entry via `storage` [extrapolation — convenience; keyed `lastfill:<entryId>`].
- **Approval queue.** A collapsible section (badge = pending count) listing agent-proposed entries.
  Each proposal card shows the proposed title/description/template (with placeholders highlighted),
  the agent's rationale, and the source signal ("seen 3× this conversation"). Actions: **Approve**
  (opens the same editor pre-filled so the user can refine title/tags/placeholders before it is
  written), **Edit**, **Reject** (discards). Approval is the _only_ path from proposal → library file.
- **Editor.** A plain form (title, description, tags, template textarea) used for new/edit/approve.
  Saving writes the markdown file (§4).

**Empty states.** Fresh install ships 3–4 starter entries [extrapolation] so the pane is not blank
and the format is self-documenting. Empty approval queue is hidden until the first proposal.

**Restore.** Per PLUGIN_API §8 / PLUGIN_ARCHITECTURE "treat every mount as a restore": on `load` the
pane re-reads the library folder and re-derives the list; the pending-proposal queue is rebuilt from
`storage` (§6). No DOM/runtime is snapshotted by the host.

---

## 3. Manifest sketch

Real JSON matching the PLUGIN_API §1/§5 schema and the `contextExports` field from
PLUGIN_ARCHITECTURE §2. Permissions are least-privilege and declared up front.

```jsonc
{
  "id": "prompt-library",
  "name": "Prompt Library",
  "version": "0.1.0",
  // single-path 16px line-icon `d` (viewBox 0 0 16 16, stroke currentColor) — a bookmarked-doc glyph
  "icon": "M4 2h6l2 2v10l-3-1.5L6 14V2H4v12",
  "kind": "both",
  "entry": "index.html",
  "backend": "plugin.js",
  "permissions": ["storage", "data:subscribe", "data:write", "tools"],
  "defaultDock": "left",
  "tools": [
    {
      "name": "propose_prompt",
      "description": "Propose a new reusable prompt-library entry when the user has repeated an instruction pattern. The proposal enters an approval queue; the user must approve before it is saved. Never writes to the library directly.",
      "inputSchema": {
        "title": "string",
        "description": "string",
        "template": "string",
        "tags": { "type": "array", "items": "string", "optional": true },
        "rationale": "string",
        "occurrences": "number?"
      },
      "timeoutMs": 15000
    }
  ]
}
```

Notes:

- `permissions` uses exactly the §4 vocabulary. `data:write` + `data:subscribe` cover reading/writing
  the library **inside the conversation cwd** (per-workspace mode — see §4 and the HOST-GAP for a
  per-user location). `tools` requires the `backend` module (§4/§5). `storage` holds the pending
  proposal queue and per-entry last-fill values.
- `inputSchema` uses the §5 shorthand (`"string"`, trailing `?` = optional) and the JSON-Schema
  subset object for the `tags` array.
- No `net:`, `browser:`, or `agent:send` permission is requested — the plugin does not fetch, embed
  web content, or send to the agent. (Whether it _can_ insert into the composer is the §5 HOST-GAP;
  note that `agent:send` would auto-send, which is explicitly not what we want.)
- **`contextExports` is deliberately omitted in v1.** A prompt library is a pick-list, not living
  working-memory the agent must see every turn (contrast CONTEXT_SYSTEM.md's model/memory/plan). A
  future `catalog` export (titles+descriptions of the library, so the agent knows what macros exist)
  is a plausible v2 addition [extrapolation]; leaving it out keeps token cost at zero by default.

---

## 4. Storage design

### 4.1 File format — markdown + YAML frontmatter

One entry = one `.md` file. This is the portable, git-syncable unit (PROPOSALS.md §11).

```markdown
---
id: pr-review
title: PR review checklist
description: Structured review of a pull request with a focus area.
tags: [review, github]
placeholders:
  - { name: pr_url, label: PR URL, multiline: false, required: true }
  - { name: focus, label: Focus area, multiline: false, required: false }
created: 2026-07-19T10:00:00Z
source: user # "user" | "agent-proposed"
---

Review the pull request at {pr_url}.

Focus especially on {focus}. Produce:

1. Correctness bugs (blocking)
2. Simplification / reuse opportunities
3. A one-line verdict.
```

- **Body = the template.** Everything after the frontmatter is the raw template; `{name}` tokens are
  substituted at fill time. The `placeholders` frontmatter is metadata (labels, multiline, required)
  used to render the form; the source of truth for _which_ placeholders exist is the set of `{...}`
  tokens found in the body, so an entry authored by hand without a `placeholders` block still works
  (labels default to the token name). [extrapolation — reconciliation rule.]
- `id` is stable and filename-derived (`<id>.md`); `source` distinguishes user vs agent-approved
  entries for display.
- The frontmatter is a small, fixed schema; the pane parses YAML in-sandbox (bundle a tiny YAML
  parser — the sandbox is a normal multi-file app per §1). All parsed frontmatter is validated
  in-pane; a malformed file is listed with an error and skipped, never thrown.

### 4.2 Folder location — per-user vs per-workspace

The contract's file verbs are **cwd-scoped**: `data.writeFile(path)` and the `file:<rel>` subscribe
source are both "cwd-scoped" and **refuse a path that escapes the conversation cwd** (PLUGIN_API §3).
There is no host verb for a per-user/global directory. So:

- **Per-workspace (supported today).** Store the library under the conversation cwd, e.g.
  `.atelier/prompt-library/*.md`. This travels with the repo, is git-syncable exactly as the proposal
  wants, and is reachable with the existing `data:write` + `data:subscribe` permissions. This is the
  **v1 default** because it maps cleanly onto the contract. It also mirrors the Phase-7
  workspace-plugin convention of a `.atelier/` dir (PLUGIN_API §6). [extrapolation — path choice.]
- **Per-user / global (NOT supported by the current API).** A single library shared across all
  workspaces (`~/.atelier/prompt-library/`) has no host verb — `writeFile`/`file:` cannot escape the
  cwd, and `storage` is per-(conversation,plugin) JSON, not a shared folder of files. See the
  **HOST-GAP** below. Until it exists, a user who wants a global library keeps the folder in one repo
  and symlinks/copies it, or accepts per-workspace scope.

**Recommendation:** ship per-workspace in v1 (fully within contract); add a per-user location behind
the HOST-GAP verb in a later milestone, with a toggle in the pane to choose scope.

**HOST-GAP — per-user file storage.** _[extrapolation of the API.]_ A new host verb + permission:

```ts
// permission: "userfiles" — a per-user, app-scoped directory OUTSIDE any conversation cwd.
userFiles: {
  // rooted at <userData>/atelier/userfiles/<pluginId>/ ; path may not escape that root.
  list(glob: string): Promise<string[]>
  read(path: string): Promise<{ content: string } | { error: string }>
  write(path: string, content: string): Promise<{ ok: true } | { error: string }> // atomic, size-capped
  delete(path: string): Promise<{ ok: true } | { error: string }>
}
```

This is the minimal, symmetric extension of `data.writeFile` to a plugin-owned per-user root; it keeps
the "no direct fs" invariant (host-mediated, rooted, size-capped) while unlocking a global library.

### 4.3 How the sandboxed pane reads/writes files

Within the contract, using the per-workspace location:

- **List/read.** The pane subscribes to each library file via `data.subscribe('file:.atelier/prompt-library/<name>.md', cb)`
  (needs `data:subscribe`), which live-tails the file so external `git pull`/manual edits refresh the
  pane. To discover _which_ files exist, v1 keeps an **index file**
  `.atelier/prompt-library/index.json` (list of entry ids) that the pane maintains and tails — because
  the `data` API has no directory-listing verb. [extrapolation — an index sidesteps the missing
  `list`; note this is a second reason the `userFiles.list` HOST-GAP is worth having, as it removes the
  need for a hand-maintained index.]
- **Write (create/edit/delete).** `data.writeFile('.atelier/prompt-library/<id>.md', markdown)` (needs
  `data:write`; atomic, ≤5MB, parents created, cwd-bounded per §3). Delete is modeled as removing the
  id from `index.json` and writing an empty/tombstoned file [extrapolation — there is no
  `deleteFile` verb in the contract; a per-workspace hard delete is another motivation for the
  HOST-GAP `userFiles.delete`, or a future `data.deleteFile`].
- **Queue state (not files).** The pending-proposal queue is NOT written to the library folder (it is
  not yet a library entry). It lives in per-(conversation,plugin) `storage` under `queue:` (§6), so it
  survives reload/restart and is invisible to other conversations (PLUGIN_API §8).

---

## 5. The composer-insertion mechanism

**Requirement:** one click fills the composed template into the **chat composer** (the input box),
_without sending it_, so the user can review/edit and press Send.

**What the contract offers.** The `agent` API (PLUGIN_API §3, needs `agent:send`) has:

```ts
agent.send(text: string): Promise<void>
```

`send` **submits** a turn — it does not populate the composer for review. There is **no host verb that
writes text into the chat input without sending.** Nothing in `layout`, `data`, `agent`, `context`, or
`storage` targets the composer.

**Conclusion: this is a HOST-GAP.** Auto-sending via `agent.send` would violate the user story (the
human must confirm/edit before sending). Proposed minimal API:

**HOST-GAP — composer insertion.** _[extrapolation of the API.]_ Extend the `agent` surface:

```ts
agent: {
  // ...existing info/onEvent/send...
  // Put text into THIS conversation's composer WITHOUT sending. Does not submit a turn.
  // mode: "replace" overwrites the composer; "insert" inserts at caret / appends. Needs "agent:compose".
  compose(text: string, opts?: { mode?: "replace" | "insert" }): Promise<void>
}
```

- New permission **`agent:compose`**, split from `agent:send` because "prefill the input for the human"
  is a distinctly weaker capability than "submit a turn on the user's behalf." The prompt-library
  requests `agent:compose` only.
- Scoped to the pane's own conversation, exactly like `agent.info/send` (§3: "Scoped to the
  conversation the pane is mounted in").
- Implementation lives in the renderer host (the composer is app chrome, not a plugin): the host RPC
  handler routes `compose` to the active conversation's composer state and sets/inserts the text; the
  plugin sandbox never touches the composer DOM directly (keeps the sandbox invariant intact).

**Fallback until the verb lands.** The **Insert into composer** button degrades to **Copy to
clipboard** with a toast ("Composer insertion needs `agent:compose` — copied instead; paste into the
chat input"). This keeps the plugin useful and honest about the gap. [extrapolation — degradation
strategy.]

---

## 6. The agent-proposal flow (end to end)

Goal: the agent can _suggest_ new entries; **nothing lands in the library without user approval**
(PROPOSALS.md §11).

1. **Detection (agent side).** During a conversation the agent notices the user has pasted/typed a
   near-identical instruction several times. Judgment lives with the model; the tool's `description`
   states the trigger ("when the user has repeated an instruction pattern").
2. **Tool call.** The agent calls `propose_prompt({ title, description, template, tags?, rationale,
occurrences? })`. Flow per PLUGIN_API §5: agent → SDK in-process MCP tool → host → the plugin's
   **backend child process** (`plugin.js`) → result to the agent.
3. **Backend handles the call.** In `tools.onInvoke("propose_prompt", handler)` (§3), the backend:
   - Validates/normalizes the input (title non-empty, template contains at least one `{token}` or is a
     useful fixed scaffold), derives a candidate `id` (slug of title, de-duplicated).
   - Enqueues the proposal. **The backend does NOT write a library file.** It publishes the proposal
     to the pane. Two viable transports [extrapolation — pick one at build time]:
     - (a) `data.publish` on a plugin topic `prompt-library:proposals`, which the pane subscribes to
       (backend needs `data:publish`; add to permissions if this transport is chosen); or
     - (b) the backend writes the proposal into a `storage` key it and the pane share. Since the pane
       is the durable owner of the queue, the recommended shape is: backend returns the normalized
       proposal as its tool `output`, AND publishes it on the control/data channel so an _open_ pane
       shows it immediately; the pane appends it to `storage` under `queue:<proposalId>`.
   - Returns `{ output: { status: "queued", proposalId } }` to the agent, so the agent can tell the
     user "I proposed it — approve it in the Prompt Library pane." The tool result is **data, not an
     approval**; it never implies the entry exists yet.
4. **Queue persistence.** The pane stores each pending proposal in per-(conversation,plugin) `storage`
   (`queue:<proposalId>` → the proposal object). This survives reload/restart and is
   conversation-scoped (PLUGIN_API §8). If the pane is closed when the tool fires, the proposal is
   still captured on next mount **only if** transport (b)/backend-storage is used; a pure
   `data.publish` to a closed pane could be missed unless the channel has history — so the backend
   should persist via a channel the host retains, or the pane reconciles from the tool-result trail on
   load [extrapolation — closed-pane durability caveat; simplest robust choice is: backend also asks
   the host to persist, or the queue is rebuilt from DataBus history if enabled].
5. **User review (pane).** The approval queue (§2) shows the card. The user can **Reject** (delete the
   `queue:` key — nothing else happens) or **Approve**.
6. **Approve = write the file.** Approve opens the editor pre-filled; on save the pane writes
   `.atelier/prompt-library/<id>.md` via `data.writeFile` (§4.3), adds the id to `index.json`, sets
   frontmatter `source: agent-proposed`, and removes the `queue:` key. Only now does a library entry
   exist. This is the single gate the proposal-flow requirement demands.
7. **Agent-driven approval is not possible.** The agent has no verb to approve its own proposal (it
   only has `propose_prompt`), which is the intended asymmetry — user is always the gate.

**Optional universal-control hook [extrapolation].** PLUGIN_ARCHITECTURE §3 gives every plugin a free
`plugin_control(pluginId, command, payload)` lever. The pane could accept a `control:` command like
`{ command: "openProposal", payload: { proposalId } }` so the agent can say "open the proposal I just
made" and focus the queue — without any new per-plugin tool. It cannot approve; it can only navigate.

---

## 7. Implementation milestones (ordered)

Each milestone builds, launches, and meets its slice before the next (CLAUDE.md definition of done).

1. **M1 — read-only library pane (per-workspace).** Manifest (`kind: "panel"` first), `index.html`,
   YAML+frontmatter parser, `data.subscribe` on `index.json` + each file, list + search + tag filter.
   Ships the 3–4 starter entries. _Acceptance:_ starter entries render; search filters; external file
   edits refresh the pane.
2. **M2 — fill-in form + Copy.** Placeholder extraction from `{tokens}`, form generation, live
   preview, substitution, **Copy to clipboard** (the pre-composer-verb fallback). Per-entry last-fill
   remembered in `storage`. _Acceptance:_ clicking an entry, filling fields, and copying yields the
   substituted text.
3. **M3 — authoring (create/edit/delete).** Editor form; `data.writeFile` + `index.json` maintenance
   (needs `data:write`); tombstone-delete. _Acceptance:_ create/edit/delete round-trips to `.md` files
   on disk and is git-visible.
4. **M4 — composer insertion (needs HOST-GAP §5).** Implement `agent.compose` + `agent:compose`
   permission in the host; wire the **Insert into composer** button. Until merged, M2's Copy fallback
   stands. _Acceptance:_ one click puts composed text into the input without sending.
5. **M5 — agent proposals.** Switch manifest to `kind: "both"` + `backend: plugin.js`; register
   `propose_prompt`; approval queue UI; `storage` queue persistence; Approve → write file. _Acceptance:_
   an agent tool call produces a queued card; Reject discards; Approve writes a `source: agent-proposed`
   file — and nothing lands without Approve.
6. **M6 — per-user library (needs HOST-GAP §4.2).** Add `userFiles` host verb + `userfiles`
   permission; scope toggle (workspace vs user) in the pane. _Acceptance:_ a global library persists
   across different-cwd conversations.

M1–M3 and M5 are fully implementable on today's contract (per-workspace). M4 and M6 each depend on a
declared HOST-GAP and are sequenced after the core is proven.

---

## 8. Risks

- **Composer HOST-GAP (§5).** The headline UX ("one click → composer") is not achievable on the
  current API without either auto-sending (wrong) or the proposed `agent.compose` verb. Mitigation:
  Copy-to-clipboard fallback in M2/M4; land the verb as its own small host change.
- **No directory-list / delete verbs.** The `data` API tails named files but cannot enumerate or hard-
  delete. Mitigation: a maintained `index.json` + tombstones; longer-term the `userFiles` verb removes
  both crutches. Risk: `index.json` drift if a file is added out-of-band (git pull) — mitigate by
  reconciling the index against known ids on load and surfacing orphans.
- **Per-workspace scope surprises users** expecting a single global library (§4.2). Mitigation: clear
  in-pane labeling of the current scope + the M6 per-user option.
- **Closed-pane proposals (§6 step 4).** A `propose_prompt` call while the pane is closed can be lost
  if transport relies on a live subscriber. Mitigation: persist the queue via a host-retained channel
  or rebuild from DataBus history; do not rely solely on `data.publish` to a possibly-unmounted pane.
- **Frontmatter/template drift.** Hand-edited files may have malformed YAML or placeholder blocks that
  disagree with the body. Mitigation: body tokens are the source of truth; malformed files list with an
  error and are skipped, never thrown into the host (PLUGIN_API §1 invariant).
- **Template injection into the composer.** A malicious/garbled template is only ever placed in the
  user's editable composer, never auto-sent — the human reviews before Send. Low risk; consistent with
  "plugins are trusted, remote content is not" (PLUGIN_API §top).
- **Storage vs. files duality.** The queue lives in `storage` (conversation-scoped) while entries live
  in files (cwd-scoped). A proposal made in conversation A is invisible to B (correct per §8), but a
  user might expect proposals to be global. Documented behavior, not a bug.

---

## 9. Acceptance criteria

The plugin is done (for the contract-native slice) when:

1. **Discovery/restore.** The folder validates (Zod, PLUGIN_API §1), lists in the rail with its icon
   and declared permissions; enabling mounts the pane; on reload/restart the pane rebuilds its list
   from the library folder and its queue from `storage` (§8) — no host DOM snapshot relied upon.
2. **Read + search.** Existing `.md` entries render as rows (title/description/tags); search filters
   across title/description/tags/body; tag chips narrow. Malformed files are listed-with-error, never
   crash the pane or host.
3. **Fill + insert.** Clicking an entry renders one field per unique `{placeholder}`; the live preview
   substitutes correctly; **Insert into composer** places the composed text in the chat input **without
   sending** (or, pre-HOST-GAP, **Copy** yields the same text and a toast explains the gap).
4. **Authoring.** Create/edit/delete round-trips to markdown files under the conversation cwd via
   `data.writeFile`; changes are visible to `git status`.
5. **Portability.** An entry file committed and pulled on another checkout appears in the pane with no
   import step; an external edit live-refreshes via the `file:` subscription.
6. **Agent proposal gate.** `propose_prompt(...)` enqueues a proposal (never a file); the queue shows
   it with rationale; **Reject** discards it; **Approve** (after optional edit) writes a
   `source: agent-proposed` `.md` file and clears the queue. **No path exists for the agent to add a
   library file without user approval.**
7. **Least privilege.** The plugin requests only `storage`, `data:subscribe`, `data:write`, `tools`
   (+`data:publish` if the publish transport is chosen; +`agent:compose`/`userfiles` when those
   HOST-GAP verbs land). No `net`, `browser`, or `agent:send`.
8. **Isolation.** A parse error, a bad template, or a backend crash is contained and surfaced in the
   pane/rail; it never throws into the host or affects another plugin or conversation (PLUGIN_API §1/§2,
   PLUGIN_ARCHITECTURE Dos & Don'ts).

---

## Appendix — HOST-GAP summary

Two capabilities the current PLUGIN_API.md does not provide, required for the full experience:

| Gap                | Need                                               | Proposed API                         | Permission      | Milestone |
| ------------------ | -------------------------------------------------- | ------------------------------------ | --------------- | --------- |
| Composer insertion | Fill composer without sending (§5)                 | `agent.compose(text, { mode })`      | `agent:compose` | M4        |
| Per-user library   | Files outside cwd, shared across workspaces (§4.2) | `userFiles.{list,read,write,delete}` | `userfiles`     | M6        |

Everything else in this design is implementable on the contract as written (per-workspace scope, Copy
fallback). Both gaps are minimal, host-mediated, rooted, and capped — consistent with the "no direct
fs / no composer DOM reach" invariants (PLUGIN_API §3/§4, PLUGIN_ARCHITECTURE Dos & Don'ts).
