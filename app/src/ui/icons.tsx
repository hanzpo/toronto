// Inline stroke icons (24-unit grid, 1.75 stroke, round caps) — one visual
// language for every HUD control. Drawn for this app; sized by CSS (1em).
import type { ReactNode } from 'react';

function Svg({ children, fill }: { children: ReactNode; fill?: boolean }) {
  return (
    <svg className="ico" viewBox="0 0 24 24" aria-hidden fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'}
      strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

export const Icon = {
  search: () => <Svg><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></Svg>,
  play: () => <Svg fill><path d="M8 5.2v13.6a.8.8 0 0 0 1.2.7l10.9-6.8a.8.8 0 0 0 0-1.4L9.2 4.5A.8.8 0 0 0 8 5.2Z" /></Svg>,
  pause: () => <Svg fill><rect x="6.5" y="5" width="4" height="14" rx="1" /><rect x="13.5" y="5" width="4" height="14" rx="1" /></Svg>,
  close: () => <Svg><path d="M6 6l12 12M18 6 6 18" /></Svg>,
  layers: () => <Svg><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 13 9 5 9-5" /></Svg>,
  chevronDown: () => <Svg><path d="m6 9 6 6 6-6" /></Svg>,
  chevronUp: () => <Svg><path d="m6 15 6-6 6 6" /></Svg>,
  walk: () => <Svg><circle cx="13" cy="4.5" r="1.8" /><path d="m9 21 2.2-6.5L14 17v4" /><path d="M11.2 14.5 12 9l3 2.5 3 1" /><path d="M12 9 8.5 10.5 7 14" /></Svg>,
  follow: () => <Svg><path d="M12 3 5 20l7-4 7 4-7-17Z" /></Svg>,
  cab: () => <Svg><rect x="4" y="3.5" width="16" height="14" rx="3" /><path d="M4 10.5h16" /><path d="m7 21 2-3.5M17 21l-2-3.5" /><circle cx="8" cy="14" r=".6" fill="currentColor" /><circle cx="16" cy="14" r=".6" fill="currentColor" /></Svg>,
  seat: () => <Svg><path d="M7 4v9a2 2 0 0 0 2 2h7" /><path d="M9.5 15 8 21M16 15l1.5 6M7 11h6" /></Svg>,
  wheel: () => <Svg><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="2" /><path d="M3.8 10.5 10 12M14 12l6.2-1.5M12 14v6.5" /></Svg>,
  pin: () => <Svg><path d="M12 21s6.5-5.6 6.5-11a6.5 6.5 0 0 0-13 0c0 5.4 6.5 11 6.5 11Z" /><circle cx="12" cy="10" r="2.3" /></Svg>,
  exit: () => <Svg><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" /><path d="M10 16 6 12l4-4M6 12h10" /></Svg>,
  station: () => <Svg><rect x="5" y="3" width="14" height="14" rx="3.5" /><path d="M5 10h14" /><path d="m8.5 21 1.5-4M15.5 21 14 17" /><circle cx="9" cy="13.5" r=".6" fill="currentColor" /><circle cx="15" cy="13.5" r=".6" fill="currentColor" /></Svg>,
  place: () => <Svg><path d="M12 21s6.5-5.6 6.5-11a6.5 6.5 0 0 0-13 0c0 5.4 6.5 11 6.5 11Z" /><circle cx="12" cy="10" r="2.3" /></Svg>,
  arrow: () => <Svg><path d="M5 12h14M13 6l6 6-6 6" /></Svg>,
  keyboard: () => <Svg><rect x="3" y="6" width="18" height="12" rx="2.5" /><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" /></Svg>,
};
