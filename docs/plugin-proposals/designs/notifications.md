# notifications — design

Status: **build spec** (user review 2026-07-20). Supersedes the notification-channel half of
[attention](attention.md); attention's cross-conversation strip remains a future tier (its
HOST-GAPs A/C/D are stretch items in ../HOST-ADDENDUM.md). This plugin is the "low hanging
fruit" the user asked for: **multiple user-configured notification channels + the agent can
elect to ping over them**, plus OS toasts and automatic turn-finished/blocked/error pings for
this conversation.

## 1. Purpose + user stories

- **User steps away** from a long run; when the turn finishes, errors, or blocks on a
  permission, they get pinged on the channels they set up (phone via Telegram/ntfy/Pushover,
  desktop via OS toast, team via Slack/Discord webhook).
- **Agent elects to ping**: mid-task the agent hits something worth a human ("tests are red in a
  way I can't fix", "done early, want me to continue?") and calls `notify_user` — the ping goes
  out over the enabled channels even though the pane may be closed (service backend).
- **User configures once per conversation**: adds channels in the pane, tests each with a "send
  test" button, toggles which event classes auto-ping.

Non-goals v1: cross-conversation watching (attention's tier), inbound replies over the channels
(one-way ping; the reply is "come back to Atelier"), OAuth flows (all channels are
token/webhook-URL based — the user pastes a secret, no browser dance).

## 2. Channels (v1 set — all plain HTTPS POSTs a backend can do with Node `fetch`)

| channel   | config fields                       | delivery                                       |
| --------- | ----------------------------------- | ---------------------------------------------- |
| os-toast  | (none)                              | `atelier.os.notify` from the PANE (A4) — falls back to log-only if pane closed |
| webhook   | url, optional headers JSON, template| POST JSON `{ title, body, event, conversation, ts }` |
| discord   | webhook url                         | POST `{ content: "**title**\nbody" }`          |
| slack     | webhook url                         | POST `{ text: "*title*\nbody" }`               |
| telegram  | bot token, chat id                  | `api.telegram.org/bot<t>/sendMessage`          |
| ntfy      | server url (default ntfy.sh), topic, optional token | POST body with `Title` header |
| pushover  | app token, user key                 | `api.pushover.net/1/messages.json`             |

Secrets live in plugin `storage` (per-conversation, host-persisted) under `settings`. The pane
masks them after entry. They are NEVER placed in a context export (never re-injected into the
agent's context); the agent only sees channel NAMES + enabled flags via the tool description /
a small status export.

## 3. Architecture

`kind: "both"`, `service: true`. Split of responsibilities:

- **Pane** (entry `index.html`): channel config UI (add/edit/test/remove), per-event-class
  toggles (turn-finished / blocked / error / agent-initiated), quiet hours, a bounded ping log,
  OS-toast delivery via `atelier.os.*` (HOST A4), and the auto-event watcher via
  `agent.onEvent` + `agent.history` (A5) for this conversation.
- **Service backend** (`backend.js`, child process): owns OUTBOUND HTTP delivery (webhook-class
  channels) so pings work with the pane closed. Reads `settings` from storage via the backend
  storage protocol (A8). Receives `notify_user` tool invokes (conversationId from A6). Receives
  pane RPC (A7) for "send test" and immediate sends. Publishes delivery results on DataBus
  channel `notify:log` (needs `data:publish`) so the pane can show outcomes live.
- **Auto-event pings with the pane closed**: v1 accepts that AUTO pings (turn finished/blocked)
  require the pane to have been mounted at least once per conversation session — the watcher
  runs in the pane. The agent-initiated `notify_user` path has no such limit (tool → backend).
  Flag this in the pane UI. (A host-side event tap for backends is future work.)

### Manifest sketch

```jsonc
{
  "id": "notifications",
  "name": "Notifications",
  "version": "0.1.0",
  "description": "Pings you where you actually are: OS toasts plus user-configured channels (Discord/Slack webhook, Telegram, ntfy, Pushover, generic webhook). Auto-ping on turn finished / blocked / error, and a notify_user tool the agent can call to reach you mid-run.",
  "icon": "<single-path 16px bell-with-radio-waves glyph>",
  "kind": "both",
  "entry": "index.html",
  "backend": "backend.js",
  "service": true,
  "permissions": ["agent:read", "storage", "os:notify", "data:subscribe", "data:publish", "net:fetch"],
  "defaultDock": "right",
  "tools": [
    { "name": "notify_user",
      "description": "Send a notification to the user over their configured channels. Use when blocked on the user, when finishing something they're waiting on, or when something needs attention they'd want interrupted for. Do not spam: at most one ping per distinct reason.",
      "inputSchema": {
        "title": "string",
        "body": "string",
        "urgency": { "type": "string", "enum": ["low", "normal", "high"], "optional": true },
        "channels": { "type": "array", "items": { "type": "string" }, "optional": true,
                      "description": "restrict to these configured channel names; default all enabled" } },
      "timeoutMs": 30000 }
  ],
  "contextExports": [
    { "key": "notify_status", "label": "Notification channels", "format": "text", "maxTokens": 150,
      "readonly": true,
      "description": "Pane-maintained summary: which channels exist and are enabled, so the agent knows whether notify_user can reach the user." }
  ]
}
```

Note: backend does HTTP itself with Node `fetch` (it is a trusted child process; `net:fetch`
listed for the rail's honesty about capability). If review decides backends must route through
the host fetcher, swap to a parentPort fetch — do not block v1 on that decision; record it in
DECISIONS.md.

## 4. Delivery rules

- Event classes auto-ping only if enabled (defaults: blocked ON, error ON, turn-finished ON,
  quiet hours empty). Debounce: one turn-finished ping per `result` event; one blocked ping per
  unresolved permission/question request; re-arm on resolve.
- `notify_user` always delivers (agent judgment), but rate-capped backend-side: ≤1/10s,
  ≤10/hour per conversation; excess returns an error result to the agent saying so.
- Every delivery (success or failure, per channel) appends to the ping log (storage, bounded
  200) and publishes on `notify:log`.
- Tool result to the agent: `{ delivered: ["telegram", "os-toast"], failed: [{channel, error}] }`
  so the agent knows whether the user was actually reachable.

## 5. Milestones

1. Manifest + backend skeleton (tool invoke → log), pane skeleton with settings storage.
2. Channels: generic webhook + discord + slack (same shape), then telegram/ntfy/pushover.
   "Send test" via pane→backend RPC.
3. notify_user tool end-to-end + rate caps + status export upkeep.
4. Auto-event watcher in pane (onEvent + history catch-up) + OS toast via os.notify.
5. Quiet hours, urgency mapping (pushover priority, ntfy priority), polish + ping log UI.

## 6. Acceptance criteria

1. User adds a Discord (or generic) webhook, clicks "send test" → message arrives; result shows
   in the ping log.
2. Agent calls `notify_user` with the PANE CLOSED → delivery still happens (service backend).
3. Turn finishing / permission block with the pane open → OS toast + enabled channels ping,
   respecting toggles and quiet hours.
4. Secrets never appear in any context export or tool result; pane masks them after entry.
5. A channel failure (bad URL) is contained: reported in log + tool result, other channels
   still deliver, nothing crashes.
6. Rate caps hold: a notify_user loop cannot flood a channel.
