import type { ReactNode } from 'react';

const PATHS: Record<string, ReactNode> = {
  send: <path d="M3 13.5 13.5 8 3 2.5l1.6 4.6L9.5 8l-4.9.9L3 13.5Z" fill="currentColor" stroke="none" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  close: <path d="m4.5 4.5 7 7m0-7-7 7" />,
  check: <path d="m3.5 8.5 3 3 6-7" />,
  chevronRight: <path d="m6 4 4 4-4 4" />,
  chevronDown: <path d="m4 6 4 4 4-4" />,
  file: (
    <>
      <path d="M4.5 2.5h4.6l2.4 2.4v8.6h-7Z" />
      <path d="M9 2.5V5h2.5" />
    </>
  ),
  fileAdd: (
    <>
      <path d="M4.5 2.5h4.6l2.4 2.4v8.6h-7Z" />
      <path d="M8 7v4M6 9h4" />
    </>
  ),
  fileRemove: (
    <>
      <path d="M4.5 2.5h4.6l2.4 2.4v8.6h-7Z" />
      <path d="M6 9h4" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="3.5" />
      <path d="m9.8 9.8 3 3" />
    </>
  ),
  folder: <path d="M2.5 4.5h4l1.2 1.5h5.8v6.5h-11Z" />,
  terminal: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="m4.8 6.5 2 1.6-2 1.6M8.5 10h2.8" />
    </>
  ),
  git: (
    <>
      <circle cx="5" cy="4" r="1.5" />
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="11" cy="6" r="1.5" />
      <path d="M5 5.5v5M11 7.5c0 2-2.5 2-6 3" />
    </>
  ),
  diff: (
    <>
      <path d="M5.5 3v5M3 5.5h5M8.5 11.5h5" />
      <path d="M13 3 3 13" opacity=".45" />
    </>
  ),
  gear: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 2.2v1.6M8 12.2v1.6M2.2 8h1.6M12.2 8h1.6M3.9 3.9l1.1 1.1M11 11l1.1 1.1M3.9 12.1 5 11M11 5l1.1-1.1" />
    </>
  ),
  history: (
    <>
      <path d="M3 8a5 5 0 1 0 1.6-3.7" />
      <path d="M3 3v2.6h2.6M8 5.3V8l1.9 1.2" />
    </>
  ),
  trash: <path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 8.5h5l.5-8.5M7 6.8v4M9 6.8v4" />,
  edit: <path d="m3 13 .6-2.6 6.9-6.9 2 2-6.9 6.9L3 13Zm6.4-8.4 2 2" />,
  copy: (
    <>
      <rect x="5.5" y="5.5" width="7" height="7.5" rx="1.2" />
      <path d="M10.5 5.5V4a1 1 0 0 0-1-1H4.5a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1" />
    </>
  ),
  warning: (
    <>
      <path d="M8 2.5 14 13H2L8 2.5Z" />
      <path d="M8 6.5v3M8 11.2v.1" />
    </>
  ),
  error: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="m6 6 4 4m0-4-4 4" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 7.3v3.4M8 5.2v.1" />
    </>
  ),
  shield: <path d="M8 2.2 12.5 4v3.6c0 2.9-1.9 5-4.5 6.2-2.6-1.2-4.5-3.3-4.5-6.2V4L8 2.2Z" />,
  bolt: <path d="M9 2 4 9h3.5L7 14l5-7H8.5L9 2Z" />,
  layers: <path d="m8 2.5 5.5 3L8 8.5l-5.5-3L8 2.5ZM2.5 8.5 8 11.5l5.5-3M2.5 11 8 14l5.5-3" />,
  list: <path d="M6 4.5h7M6 8h7M6 11.5h7M3 4.5h.1M3 8h.1M3 11.5h.1" />,
  eye: (
    <>
      <path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8Z" />
      <circle cx="8" cy="8" r="1.8" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8Z" />
      <path d="m3 13 10-10" />
    </>
  ),
  key: (
    <>
      <circle cx="5.5" cy="10.5" r="2.5" />
      <path d="m7.3 8.7 5.2-5.2M10.5 5.5l1.5 1.5M12 4l1.5 1.5" />
    </>
  ),
  plug: <path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v2.5a3.5 3.5 0 0 1-7 0V5.5ZM8 11.5v2.5" />,
  refresh: (
    <>
      <path d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path d="M13 3v2.6h-2.6" />
    </>
  ),
  arrowLeft: <path d="M9.5 3.5 5 8l4.5 4.5M5 8h8" />,
  at: (
    <>
      <circle cx="8" cy="8" r="2.3" />
      <path d="M10.3 5.7v3.1c0 1.9 3.2 1.6 3.2-.8a5.5 5.5 0 1 0-2.2 4.4" />
    </>
  ),
  external: <path d="M9 3h4v4M13 3 7.5 8.5M11 9.5V13H3V5h3.5" />,
  play: <path d="M5 3.5v9l7-4.5-7-4.5Z" />,
  sparkle: <path d="M8 2.5 9.3 6.7 13.5 8 9.3 9.3 8 13.5 6.7 9.3 2.5 8l4.2-1.3L8 2.5Z" />,
  circle: <circle cx="8" cy="8" r="4.5" />,
  dot: <circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none" />,
  book: <path d="M3 3.5h4a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 0 7 11.5H3v-8ZM13 3.5H9.5A1.5 1.5 0 0 0 8 5v8a1.5 1.5 0 0 1 1.5-1.5H13v-8Z" />,
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  return (
    <svg
      className={`icon${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name] ?? PATHS.circle}
    </svg>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg className="spinner" width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.6" opacity=".22" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** The ByteAgent mark used on the welcome screen. */
export function Logo({ size = 40 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5.5 3.5h13A2.5 2.5 0 0 1 21 6v9a2.5 2.5 0 0 1-2.5 2.5H12l-4.6 3.4a.5.5 0 0 1-.8-.4v-3H5.5A2.5 2.5 0 0 1 3 15V6a2.5 2.5 0 0 1 2.5-2.5Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="m7.5 8 3 2.5-3 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.5 13.25h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
