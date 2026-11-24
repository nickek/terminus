const PATHS: Record<string, string> = {
  terminal: 'M4 5h16v14H4z M7 9l3 3-3 3 M12 15h5',
  dashboard: 'M4 4h7v9H4z M13 4h7v5h-7z M13 11h7v9h-7z M4 15h7v5H4z',
  agents: 'M12 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8z M4 21c0-4 3.6-7 8-7s8 3 8 7',
  settings:
    'M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6z M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  plus: 'M12 5v14 M5 12h14',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
  stop: 'M7 7h10v10H7z',
  maximize: 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5',
  minimize: 'M9 4v5H4 M15 4v5h5 M9 20v-5H4 M15 20v-5h5',
  float: 'M3 8h12v12H3z M8 8V4h13v12h-6',
  dock: 'M4 4h16v16H4z M12 4v16',
  folder: 'M3 6h6l2 2h10v11H3z',
  close: 'M6 6l12 12 M18 6L6 18',
  fork: 'M6 3v12 M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M18 9a9 9 0 0 1-9 9',
  skill: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z M19 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z',
  edit: 'M4 20h4L19 9l-4-4L4 16z M13.5 6.5l4 4',
  copy: 'M9 9h11v11H9z M5 15H4V4h11v1',
  plug: 'M9 3v5 M15 3v5 M7 8h10v3.5a5 5 0 0 1-10 0z M12 16.5V21',
  sidebar: 'M4 5h16v14H4z M9.5 5v14',
  chevronLeft: 'M14.5 7l-5 5 5 5',
  chevronRight: 'M9.5 7l5 5-5 5',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7 M20 4v7h-7',
};

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name] || ''} />
    </svg>
  );
}
