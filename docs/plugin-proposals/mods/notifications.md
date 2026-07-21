# notifications — modification plan (user review 2026-07-21)

**Verdict from review:** "good, I think… best plugin so far assuming it works." One ask:
a question-mark affordance on each option explaining how to set it up.

## Changes

1. **Per-channel setup help.** Each channel card gets a `?` button in its head row that
   expands an inline help box (collapsed by default) with concrete setup steps:
   - **OS toast** — nothing to configure; what it does, plus the Windows Focus-Assist caveat.
   - **Generic webhook** — the POST contract (JSON body we send: title/body/event/urgency),
     optional headers JSON, how to test with webhook.site.
   - **Discord** — Server Settings → Integrations → Webhooks → New Webhook → Copy URL.
   - **Slack** — api.slack.com/apps → Incoming Webhooks → Activate → Add to workspace → copy URL.
   - **Telegram** — talk to @BotFather → /newbot → copy token; then message the bot once and
     get your chat id from @userinfobot (or use `@channelname` for a channel the bot admins).
   - **ntfy** — pick any topic string, subscribe in the ntfy app to the same topic;
     server defaults to https://ntfy.sh; token only for protected topics.
   - **Pushover** — pushover.net → Your User Key; Create an Application → API Token.
2. **Add-row help.** A `?` beside the type `<select>` summarizing the channel types in one
   line each, so choosing one is informed before the card exists.
3. **Field-level hints.** `FIELDS` entries gain an optional `hint` rendered under the input
   in faint text (e.g. headers JSON shape; chat id formats).
4. **Auto-ping/quiet-hours help.** Small `?` on the "Auto-ping on" and "Quiet hours"
   section headers explaining pane-open requirement and the notify_user exception (this text
   exists in the lede/warn; keep it but make it discoverable at point of use).

## Non-goals

No backend changes; no new channels. Delivery logic untouched.

## Acceptance

- Every channel type shows a `?`; clicking expands/collapses concrete setup steps.
- Help renders inside the card (no native tooltips only — must be readable/clickable text).
- Gate green; no manifest change needed.
