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
      {
        key: 'headers',
        label: 'Headers',
        placeholder: '{"Authorization":"Bearer …"}',
        hint: 'Optional extra request headers as a JSON object.'
      }
    ],
    discord: [
      { key: 'url', label: 'Webhook URL', placeholder: 'https://discord.com/api/webhooks/…' }
    ],
    slack: [
      { key: 'url', label: 'Webhook URL', placeholder: 'https://hooks.slack.com/services/…' }
    ],
    telegram: [
      { key: 'botToken', label: 'Bot token', placeholder: '123456:ABC…' },
      {
        key: 'chatId',
        label: 'Chat id',
        placeholder: '@channel or 12345',
        hint: 'Numeric id for a private chat, or @channelname for a channel the bot admins.'
      }
    ],
    ntfy: [
      {
        key: 'server',
        label: 'Server',
        placeholder: 'https://ntfy.sh',
        hint: 'Leave as ntfy.sh unless you self-host.'
      },
      { key: 'topic', label: 'Topic', placeholder: 'my-atelier-alerts' },
      {
        key: 'token',
        label: 'Token',
        placeholder: '(optional)',
        hint: 'Only needed for protected topics.'
      }
    ],
    pushover: [
      { key: 'appToken', label: 'App token', placeholder: 'azGD…' },
      { key: 'userKey', label: 'User key', placeholder: 'uQi…' }
    ]
  }
  // Fields treated as secrets (rendered as password inputs). URLs that embed a secret (discord/slack
  // webhook, generic webhook) are masked too since the token is in the path.
  const SECRET_FIELDS = ['url', 'headers', 'botToken', 'token', 'appToken', 'userKey']

  // Per-type setup help, rendered by the pane as an expandable box on each channel card
  // (and summarized next to the add-channel picker). Plain text; `steps` render as an
  // ordered list, `note` in faint text below.
  const HELP = {
    'os-toast': {
      summary: 'Native desktop notification on this machine. Nothing to configure.',
      steps: ['Add the channel and hit "Send test" — a toast should pop immediately.'],
      note:
        'If nothing appears on Windows, check Settings → System → Notifications ' +
        '(Focus Assist / Do Not Disturb silently swallows toasts).'
    },
    webhook: {
      summary: 'POSTs a JSON payload to any URL you control.',
      steps: [
        'Stand up an endpoint that accepts POST (to try it out, https://webhook.site gives you a throwaway URL).',
        'Paste the URL above.',
        'If your endpoint needs auth, add headers as JSON, e.g. {"Authorization":"Bearer abc123"}.'
      ],
      note:
        'Payload we send: {"title","body","event","urgency","conversation","ts"} as JSON. ' +
        'Any 2xx response counts as delivered.'
    },
    discord: {
      summary: 'Posts into a Discord channel via a channel webhook.',
      steps: [
        'In Discord, open the target server → Server Settings → Integrations → Webhooks.',
        'New Webhook → pick the channel it should post to.',
        '"Copy Webhook URL" and paste it above.'
      ],
      note: 'The URL contains its own secret — no bot or token setup needed.'
    },
    slack: {
      summary: 'Posts into a Slack channel via an incoming webhook.',
      steps: [
        'Go to api.slack.com/apps → Create New App → From scratch.',
        'In the app: Incoming Webhooks → toggle Activate.',
        '"Add New Webhook to Workspace" → pick a channel → copy the generated URL here.'
      ]
    },
    telegram: {
      summary: 'Sends messages from your own Telegram bot to you (or a group/channel).',
      steps: [
        'Message @BotFather in Telegram → /newbot → follow the prompts → copy the bot token.',
        'Open a chat with your new bot and send it any message (bots cannot message you first).',
        'Get your chat id: message @userinfobot, or for a group/channel add the bot and use @channelname.'
      ]
    },
    ntfy: {
      summary: 'Publish/subscribe push via ntfy — easiest way to reach your phone.',
      steps: [
        'Pick a topic name nobody would guess (it doubles as the secret), e.g. atelier-<random>.',
        'Install the ntfy app (or open ntfy.sh/<topic> in a browser) and subscribe to that topic.',
        'Enter the same topic above. Server stays https://ntfy.sh unless you self-host.'
      ],
      note: 'Token is only for servers/topics with access control enabled.'
    },
    pushover: {
      summary: 'Pushover — paid app ($5 one-time) with reliable phone push.',
      steps: [
        'Log in at pushover.net — your User Key is on the dashboard.',
        'Scroll to "Your Applications" → Create an Application/API Token.',
        'Paste the API token (app token) and your user key above.'
      ]
    }
  }

  window.__notifyChannels = { FIELDS, SECRET_FIELDS, HELP }
})()
