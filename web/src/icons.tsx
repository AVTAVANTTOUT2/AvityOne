// AvityOne icon set — drawn for the libraries.dev look: 24px grid, 1.7 stroke, round caps, no fills unless noted.
import type { SVGProps } from 'react';

const P: Record<string, string> = {
  send: 'M12 19V5M5.5 11.5 12 5l6.5 6.5',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12.5 10 17.5 19 7',
  chevron: 'm7 10 5 5 5-5',
  chevronRight: 'm10 7 5 5-5 5',
  mic: 'M12 3.5a3 3 0 0 1 3 3V12a3 3 0 0 1-6 0V6.5a3 3 0 0 1 3-3ZM5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5',
  folder: 'M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2.2h7.4a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z',
  chat: 'M5 18.5V7a2.5 2.5 0 0 1 2.5-2.5h9A2.5 2.5 0 0 1 19 7v6.5a2.5 2.5 0 0 1-2.5 2.5H8.2Z',
  memory: 'M12 4.5c-2.4 0-4 1.6-4 3.4-1.9.3-3 1.8-3 3.5 0 1.3.6 2.3 1.6 3-.3 2 1.3 3.6 3.3 3.6.6 1 1.4 1.5 2.1 1.5s1.5-.5 2.1-1.5c2 0 3.6-1.6 3.3-3.6 1-.7 1.6-1.7 1.6-3 0-1.7-1.1-3.2-3-3.5 0-1.8-1.6-3.4-4-3.4ZM12 4.5v15',
  layers: 'm12 4 8 4.2-8 4.3-8-4.3Zm-8 8.3 8 4.2 8-4.2M4 16l8 4.2 8-4.2',
  branch: 'M7 4.5v10M7 14.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Zm10-10a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Zm0 5c0 4-10 2.5-10 5',
  eye: 'M2.8 12S6.2 5.8 12 5.8 21.2 12 21.2 12 17.8 18.2 12 18.2 2.8 12 2.8 12Zm9.2 2.8a2.8 2.8 0 1 0 0-5.6 2.8 2.8 0 0 0 0 5.6Z',
  sparkle: 'M12 3.5c.5 3.9 2.1 5.5 6 6-3.9.5-5.5 2.1-6 6-.5-3.9-2.1-5.5-6-6 3.9-.5 5.5-2.1 6-6ZM18.5 15.5c.2 1.7.9 2.4 2.5 2.5-1.6.2-2.3.9-2.5 2.5-.2-1.6-.9-2.3-2.5-2.5 1.6-.1 2.3-.8 2.5-2.5Z',
  summary: 'M5 6.5h14M5 11h9M5 15.5h6M17 14.5c.3 2 1.1 2.8 3 3-1.9.3-2.7 1.1-3 3-.3-1.9-1.1-2.7-3-3 1.9-.2 2.7-1 3-3Z',
  play: 'M8 5.8v12.4a.8.8 0 0 0 1.2.7l10-6.2a.8.8 0 0 0 0-1.4l-10-6.2A.8.8 0 0 0 8 5.8Z',
  parallel: 'M5 5v4.5a3 3 0 0 0 3 3h8a3 3 0 0 1 3 3V19M5 19v-3.5a3 3 0 0 1 3-3M19 5v4.5a3 3 0 0 1-3 3M12 4v16',
  merge: 'M7 4.5v15M7 9.5c0 4 10 2.5 10 7.5v2.5M17 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z',
  search: 'M10.8 17.6a6.8 6.8 0 1 0 0-13.6 6.8 6.8 0 0 0 0 13.6ZM20 20l-4.2-4.2',
  trash: 'M4.5 6.5h15M9.5 6.5V4.8a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.7M6.5 6.5l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12',
  panel: 'M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5ZM14.5 4v16',
  menu: 'M4.5 7h15M4.5 12h15M4.5 17h15',
  file: 'M7 3.5h6.5L18.5 8.5V19a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V5A1.5 1.5 0 0 1 7 3.5ZM13 3.5V9h5.5',
  edit: 'M14.5 5.5l4 4M4.5 19.5l1-4.5L16 4.5a1.4 1.4 0 0 1 2 0l1.5 1.5a1.4 1.4 0 0 1 0 2L9 18.5Z',
  terminal: 'M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5ZM8 9.5l2.5 2.5L8 14.5M12.5 15h3.5',
  globe: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17ZM3.5 12h17M12 3.5c2.3 2.3 3.4 5.1 3.4 8.5s-1.1 6.2-3.4 8.5c-2.3-2.3-3.4-5.1-3.4-8.5S9.7 5.8 12 3.5Z',
  bulb: 'M9.5 17.5h5M10 20.5h4M12 3.5a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.2v1h5v-1c0-.9.4-1.7 1.1-2.2A6 6 0 0 0 12 3.5Z',
  refresh: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4',
  shield: 'M12 3.5 5 6.2v5.3c0 4.4 3 7.7 7 9 4-1.3 7-4.6 7-9V6.2Zm-3 8.7 2.2 2.2 4-4.2',
  tree: 'M12 20.5v-6M12 14.5c-3.3 0-6-2.3-6-5.3S8.7 3.5 12 3.5s6 2.4 6 5.7-2.7 5.3-6 5.3ZM9 17.5h6',
  bolt: 'M13 3.5 5.5 13.5h6l-1 7 7.5-10h-6Z',
  info: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17ZM12 11v5.5M12 7.8v.2',
  alert: 'M12 4.5 2.8 19.5h18.4ZM12 10v4.5M12 17.2v.2',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
  logout: 'M14 4.5h3.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H14M10 16l-4-4 4-4M6 12h9.5',
  plug: 'M9 3.5v4M15 3.5v4M6.5 7.5h11V11a5.5 5.5 0 0 1-11 0ZM12 16.5v4',
  pin: 'M9.5 3.5h5M10.5 3.5v5.2L7 13h10l-3.5-4.3V3.5M12 13v7.5',
  archive: 'M4 5h16v4H4ZM5.5 9v9.5a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5V9M10 13h4',
  download: 'M12 4v11M7 10.5l5 5 5-5M5 19.5h14',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  copy: 'M9 9.5A1.5 1.5 0 0 1 10.5 8h7A1.5 1.5 0 0 1 19 9.5v9a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 9 18.5ZM15 8V6a1.5 1.5 0 0 0-1.5-1.5h-7A1.5 1.5 0 0 0 5 6v9a1.5 1.5 0 0 0 1.5 1.5H9',
  chevronUp: 'm7 14 5-5 5 5',
  bell: 'M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2h-14ZM10 20.5h4',
};

const FILLED = new Set(['stop']);

export type IconName = keyof typeof P | 'stop';

export function Icon({ name, size = 16, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {FILLED.has(name) ? <rect x="7" y="7" width="10" height="10" rx="2.2" fill="currentColor" stroke="none" /> : <path d={P[name]} />}
    </svg>
  );
}

/** Tool-call kinds (ACP) → icon. */
export const KIND_ICON: Record<string, IconName> = {
  read: 'file', edit: 'edit', delete: 'trash', move: 'arrowRight', search: 'search',
  execute: 'terminal', think: 'bulb', fetch: 'globe', switch_mode: 'play', other: 'plug',
};
