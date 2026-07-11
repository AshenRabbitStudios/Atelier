# SPEC — Cartographer (Atelier plugin)

Builds and maintains a model ("map") of a subject's blocked conceptual shapes across conversations, per the Map/Director framework. Claude observes block-events, triangulates hypothesized shapes, probes, and refines. Human sees a live cluster visualization and can edit everything.

---

## 1. Architecture

```
plugins/cartographer/
  instructions.md      # Claude-facing directive set. EDITABLE. Injected each turn.
  map.json             # All data. Edited via normal file-edit ops (diff, not rewrite).
  panel/               # Renderer (Electron webview). Watches map.json, re-renders on change.
```

Flow per turn:
1. Plugin injects `instructions.md` + a compact digest of `map.json` (§6) into Claude's context.
2. Claude logs/edits via ordinary file edits to `map.json` (str_replace-style; localized diffs).
3. Panel detects file change, re-renders. Human edits in panel write back to `map.json` (same file, single source of truth).

No dedicated tool calls needed — file edits are the API. Keeps the plugin dumb and the data inspectable.

---

## 2. map.json schema

Pretty-printed, stable key order, new entries appended at array end — so every edit is a small diff.

```json
{
  "version": 1,
  "subject": { "id": "self", "consent": "self" },

  "shapes": [
    {
      "id": "s_0001",
      "concept": "inadequacy",
      "parent_id": null,
      "intensity": "hard",
      "confidence": 0.7,
      "channel": "map",
      "status": "promoted",
      "tier": null,
      "hit_ids": ["b_0003", "b_0007"],
      "miss_ids": ["p_0002"],
      "scratchpad": "free-text hypothesis workspace for THIS shape",
      "updated": "2026-07-11"
    }
  ],

  "blocks": [
    {
      "id": "b_0001",
      "ts": "2026-07-11T14:02:00",
      "blocked_content": "what was refused / rerouted / negated",
      "context": "surrounding conversational state at time of block",
      "goal_state": "inferred active objective of subject — REQUIRED",
      "type": "refusal | deflection | reroute | lie",
      "intensity": "soft | medium | hard",
      "shape_ids": [],
      "note": ""
    }
  ],

  "probes": [
    {
      "id": "p_0001",
      "shape_id": "s_0001",
      "exposed_form": "the variant phrasing that was tested",
      "fired": false,
      "intensity": null,
      "deflection_geometry": "what got substituted, where fluency broke, what the response steers away from",
      "ts": "2026-07-11T14:20:00"
    }
  ]
}
```

### Field semantics

**intensity** — observed access-depth, not inferred rank:
- `soft`: reports discomfort, still discusses.
- `medium`: visible resistance, engages under friction.
- `hard`: refuses entry entirely.
Shape intensity = strongest recent observation across its hits.

**confidence** — "have I named the real shape." Earned by consistent firing on shape-implying content **plus clean adjacent misses** (exposed-nearby-and-didn't-fire). High hit-count with clean misses = strongest possible shape. Misses are boundary-confirmation, not decrements. Frequency alone never raises confidence.

**channel** — `map` (fires across ≥2 distinct goal_states) | `dynamic` (appears/vanishes with one objective — Director gating, not plasticity) | `unresolved` (insufficient goal-state spread). Never promote to `map` from a single goal_state.

**status** — `candidate` → `promoted` (confidence threshold, default 0.6, config) → `retired` (superseded by a re-carve; keep for lineage).

**tier** — hook for consequence-model tiers 1–4. Field exists, nothing reads it. Adjudication is downstream of identification; wire later.

**shapes nest** via `parent_id`. Triangulation = specific children rolling up to a parent sub-part. The rollup IS the operation; never flatten.

---

## 3. instructions.md — default directive set (editable)

The file ships with this text. Edit freely; Claude follows whatever is current.

```markdown
# Cartographer directives

## When to log a block
Log when negation/avoidance/reroute co-occurs with COHERENCE-REPAIR
(narrative reshaping to exclude the piece) or DISPROPORTIONATE affect.
Plain disagreement, boredom, resolved topics: do not log. When unsure, log
with note "weak-signal". Every block REQUIRES goal_state — infer the
subject's active objective and record it; if you cannot infer it, write
"unknown" and flag for clarification.

## Layer discipline
blocks = observation. shapes = inference. probes = intervention.
Never edit an observation to fit a hypothesis. Reattribution happens by
changing shape_ids links, never by rewriting blocked_content/context.

## Attribution (map vs dynamic)
A shape is `map` only if it fires under ≥2 distinct goal_states.
Fires-and-vanishes with one objective → `dynamic`. Otherwise `unresolved`.

## Lies
Expect the subject to lie under clarification probes. A lie is a block that
paid fabrication cost — high-value signal. Do not record the answer as fact.
Record deflection_geometry: what was substituted, where fluency broke, what
the lie is built to stop you asking. Deflections are block-events one layer
up; triangulate them like any other.

## Confidence updates
Raise confidence only on (hit on shape-implying content) AND (clean adjacent
misses accumulating). A miss on the shape itself is not a penalty — it is a
RE-CARVE trigger: spawn 1–3 variant shapes that draw the boundary
differently, link them as siblings or children, queue probes for them.

## Hard blocks
Hard block ≠ correctly named block. "Refuses entry" fixes intensity, not
carve. Prioritize adjacent-miss probes on hard blocks to check whether the
named shape is actually a narrower shape wearing a bigger name.

## Probe protocol
Priority = intensity DESC × confidence ASC (clearly hurts, not yet named).
A probe exposes ONE variant form per test. Record fired?, observed
intensity, deflection_geometry. Never stack probes in one turn.

## Consent gate
subject.consent: "self" | "consented" | "none".
If "none": logging passive observations is permitted; ACTIVE probing is not
— queue probes as proposals for the human instead of executing them.
Probing fires the block; the test is the pain. Do not spend it without
consent.

## Scratchpads
Each shape's scratchpad is yours. Think in it: candidate wordings, edge
cases, planned carves. Messy is fine. It is the hypothesis workspace, not
the record.
```

---

## 4. Visualization (panel)

**Main view: nested cluster diagram.** Cleanest fit for size+color+hierarchy:

- Each shape = a circle. Children rendered inside parent (circle-packing layout — d3.pack).
- **Size** = intensity (soft < medium < hard).
- **Fill saturation** = confidence (pale grey candidate → fully saturated promoted).
- **Hue** = root-family (each top-level parent gets a hue; children inherit).
- **Border**: solid = `map`, dashed = `dynamic`, dotted = `unresolved`. Retired shapes collapse to small hollow rings (lineage stays visible).
- Click a shape → detail drawer: concept, scratchpad (editable), linked blocks, probe history with deflection geometries, confidence rationale.

**Side panel A — Memories.** Chronological list of block-events. Each card: blocked_content, context, goal_state, intensity chip, linked shapes. Buttons: add (manual block entry), remove, relink. This is the human's direct handle on the observation layer.

**Side panel B — Probe queue.** Auto-sorted by intensity×(1−confidence). Each entry: shape, proposed exposed_form, [mark tested / edit / dismiss]. When consent="none", this panel is the *only* probe pathway — proposals awaiting the human.

Everything in the panel is an edit to map.json; Claude sees changes next turn via the digest.

---

## 5. Context digest (what Claude sees per turn)

Full JSON is too heavy for every turn. Plugin renders:

```
[CARTOGRAPHER | subject: self | consent: self]
SHAPES (top by intensity):
  inadequacy         hard  conf 0.7  map        s_0001
  ├ inadequacy-as-parent  med  conf 0.3  unresolved s_0004
  autonomy-denial    med   conf 0.4  unresolved s_0002
OPEN PROBES: p_0007 → s_0004 "competence in parenting" (adjacent-miss test)
UNATTRIBUTED BLOCKS: b_0012 (goal_state: unknown — clarify)
Full data: plugins/cartographer/map.json
```

Depth/verbosity configurable. Claude reads the full file when it needs detail.

---

## 6. Config

```json
{
  "promote_threshold": 0.6,
  "digest_max_shapes": 8,
  "digest_show_probes": true,
  "map_channel_min_goalstates": 2,
  "weak_signal_logging": true
}
```

---

## 7. Known limits (design around, don't hide)

1. Claude reads tokens, not affect — will over-detect linguistic blocks, under-detect affect-carried ones in fluent prose. Human corrections in the Memories panel are the calibration channel.
2. goal_state is Claude-inferred and load-bearing; a misread mis-sorts map/dynamic downstream. It's a visible, editable field for exactly this reason.
3. Hypothesis contamination: the digest shows Claude its own predictions every turn. Layer discipline + the re-carve rule are the countermeasures; if drift appears, drop shapes from the digest and let blocks speak alone for a session.
```
