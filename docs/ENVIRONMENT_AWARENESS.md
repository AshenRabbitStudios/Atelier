# ENVIRONMENT_AWARENESS.md — telling the agent it's inside Atelier

Every Atelier conversation runs an isolated agent instance. Before this feature, that instance was
blind to Atelier itself: the per-turn `<atelier-context>` block and the `systemPrompt.append`
standing instruction only fire for plugins the user has **enabled** in that conversation, so a fresh
conversation in a new folder was never told where it is, that plugins exist, or how to use them. Ask
"what plugins can you access?" and the agent had nothing.

This adds two **always-on** pieces (composed in `main.ts`, independent of enablement) so the agent is
self-aware from turn one. Both live in `electron/plugin/introspection.ts`.

## 1. Environment briefing (system prompt)

`buildEnvironmentBriefing(registry, cwd)` produces an `<atelier-environment>` block prepended to the
system-prompt append (before any enabled plugin's `systemInstruction`). It tells the agent:

- it's an isolated instance inside Atelier (own cwd/session/transcript/plugins), and its cwd;
- what a plugin is (panel / callable tools / injected "context documents") and that activation is
  per-conversation;
- a **catalog of every discovered plugin** — `id — one-line description` (from the manifest's new
  optional `description` field, else the name);
- that it can call `list_plugins` / `describe_plugin` to learn more.

It carries **only install-level facts** (Atelier + catalog + cwd), deliberately excluding
per-conversation state (what's enabled/pinned here). That keeps the value byte-identical across turns
so the system block stays prompt-cached; it only changes when the on-disk plugin catalog or the cwd
changes.

## 2. Built-in `atelier` tool server

`buildAtelierToolServer(registry, pluginState)` returns an in-process MCP server (`atelier`) that is
**always registered** on every conversation's query — not gated on any plugin being enabled — so the
agent can always introspect. Two tools, both reading live registry + per-conversation state at call
time (so enabling/disabling a plugin needs no rebind to be reflected):

- `list_plugins` — the catalog with a `[enabled]` marker per plugin.
- `describe_plugin(id)` — one plugin in detail: kind, description, live enabled/pinned status,
  permissions, contributed tools (name + description), and context documents (label, key, format,
  push-only flag, description). Unknown / invalid ids return a message, never throw.

## Manifest `description`

`ManifestSchema` gains an optional `description` (may be multi-line): prose about the plugin's
intention and use. Its first line is the catalog one-liner; the full text shows in `describe_plugin`.
The example plugins ship one. Absent → the plugin still appears by name.

## Why here, not a plugin

A plugin can't describe the app or a plugin the user hasn't enabled — this is a host concern. The
briefing and tools are wired directly in `main.ts` alongside the existing context/instruction/mcp
providers, using the same `PluginRegistry`.
