// Browser-side channel field metadata for the notifications pane (loaded as a plain <script> in the
// sandboxed iframe; NOT a module). The pane only needs to know which config fields each channel type
// has and which are secrets (so they render masked). Payload BUILDING lives in the backend
// (channels.cjs) — the pane never touches secrets beyond storing them. Keep the field keys in sync
// with the config keys the builders in channels.cjs read.
;(function () {
  const FIELDS = {
    'os-toast': [],
    webhook: [
      { key: 'url', label: 'URL', placeholder: 'https://example.com/hook' },
      { key: 'headers', label: 'Headers', placeholder: '{"Authorization":"Bearer …"}' }
    ],
    discord: [
      { key: 'url', label: 'Webhook URL', placeholder: 'https://discord.com/api/webhooks/…' }
    ],
    slack: [
      { key: 'url', label: 'Webhook URL', placeholder: 'https://hooks.slack.com/services/…' }
    ],
    telegram: [
      { key: 'botToken', label: 'Bot token', placeholder: '123456:ABC…' },
      { key: 'chatId', label: 'Chat id', placeholder: '@channel or 12345' }
    ],
    ntfy: [
      { key: 'server', label: 'Server', placeholder: 'https://ntfy.sh' },
      { key: 'topic', label: 'Topic', placeholder: 'my-atelier-alerts' },
      { key: 'token', label: 'Token', placeholder: '(optional)' }
    ],
    pushover: [
      { key: 'appToken', label: 'App token', placeholder: 'azGD…' },
      { key: 'userKey', label: 'User key', placeholder: 'uQi…' }
    ]
  }
  // Fields treated as secrets (rendered as password inputs). URLs that embed a secret (discord/slack
  // webhook, generic webhook) are masked too since the token is in the path.
  const SECRET_FIELDS = ['url', 'headers', 'botToken', 'token', 'appToken', 'userKey']

  window.__notifyChannels = { FIELDS, SECRET_FIELDS }
})()
