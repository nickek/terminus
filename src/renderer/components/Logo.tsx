/** Terminus mark: a terminal prompt branching out to subagent nodes. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-label="Terminus">
      <defs>
        <linearGradient id="lg-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#64D2FF" />
          <stop offset="0.45" stopColor="#0A84FF" />
          <stop offset="1" stopColor="#5E5CE6" />
        </linearGradient>
        <linearGradient id="lg-shine" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8.5" fill="url(#lg-bg)" />
      <rect x="1.5" y="1.5" width="29" height="14" rx="8" fill="url(#lg-shine)" opacity="0.6" />
      <rect x="1.25" y="1.25" width="29.5" height="29.5" rx="8.25" fill="none" stroke="#fff" strokeOpacity="0.35" strokeWidth="0.5" />
      <path d="M8.5 10.5 L13.5 16 L8.5 21.5" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path
        d="M15.5 16 H22.5 M19 16 L22.5 11 M19 16 L22.5 21"
        fill="none"
        stroke="#fff"
        strokeOpacity="0.9"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="23.2" cy="10.4" r="2" fill="#fff" />
      <circle cx="24.2" cy="16" r="2" fill="#fff" />
      <circle cx="23.2" cy="21.6" r="2" fill="#fff" />
    </svg>
  );
}
