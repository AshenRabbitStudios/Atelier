// 16px single-path line icons (DESIGN_SYSTEM.md §6): fill none, stroke currentColor.
// A plugin can ship one `d` string; color is inherited (--faint idle, --accent active).
export const ICONS = {
  chat: 'M2.5 4.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6l-2.5 2.2V11.5h-1a1 1 0 0 1-1-1z',
  plugin: 'M6 2.5v2.2a1.3 1.3 0 1 0 0 2.6H6V10H3.5v3.5h10V3.5H6zM6 2.5h4.7',
  metrics: 'M2.5 13.5V2.5M2.5 13.5h11M5 11l2.5-3 2 2 3.5-4.5',
  terminal: 'M2.5 3.5h11v9h-11zM4.5 6.5l2 1.5-2 1.5M8.5 9.5h3'
} as const

export type IconName = keyof typeof ICONS
