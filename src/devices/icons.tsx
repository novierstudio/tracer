import type { ReactNode, SVGProps } from 'react';
import type { DeviceIconName } from './catalog';

const ACCENT = 'var(--accent-text)';

const GLYPHS: Record<DeviceIconName, ReactNode> = {
  router: (
    <>
      <circle cx="24" cy="24" r="14.5" />
      <path d="M14 24h7m0 0c4 0 5-7.5 10.5-7.5M21 24c4 0 5 7.5 10.5 7.5" />
      <circle cx="21" cy="24" r="3" fill={ACCENT} stroke="none" />
    </>
  ),
  switch: (
    <>
      <rect x="8" y="16" width="32" height="16" rx="3.5" />
      <path d="M14 21.5v5M19 21.5v5M24 21.5v5M29 21.5v5" />
      <circle cx="34.5" cy="24" r="2" fill={ACCENT} stroke="none" />
    </>
  ),
  'multilayer-switch': (
    <>
      <rect x="8" y="22" width="32" height="14" rx="3.5" />
      <path d="M14 27v4M19 27v4M24 27v4M29 27v4" />
      <circle cx="34.5" cy="29" r="2" fill={ACCENT} stroke="none" />
      <path d="M15 15h18m-3.5-3.5L33 15l-3.5 3.5" stroke={ACCENT} />
    </>
  ),
  pc: (
    <>
      <rect x="9" y="11" width="30" height="20" rx="3" fill={ACCENT} fillOpacity="0.16" />
      <path d="M24 31v5m-6 1h12" />
    </>
  ),
  laptop: (
    <>
      <rect x="12" y="13" width="24" height="16" rx="2.5" fill={ACCENT} fillOpacity="0.16" />
      <path d="M7.5 34.5h33" />
    </>
  ),
  server: (
    <>
      <rect x="11" y="9.5" width="26" height="7" rx="2" />
      <rect x="11" y="20.5" width="26" height="7" rx="2" />
      <rect x="11" y="31.5" width="26" height="7" rx="2" />
      <path d="M23 13h8M23 24h8M23 35h8" />
      <circle cx="16.5" cy="13" r="1.5" fill={ACCENT} stroke="none" />
      <circle cx="16.5" cy="24" r="1.5" fill={ACCENT} stroke="none" />
      <circle cx="16.5" cy="35" r="1.5" fill={ACCENT} stroke="none" />
    </>
  ),
};

type DeviceIconProps = Omit<SVGProps<SVGSVGElement>, 'name'> & { name: DeviceIconName };

/** A device on a rounded tile. The glyph takes `currentColor`; tile and accent follow the theme. */
export function DeviceIcon({ name, ...props }: DeviceIconProps) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" {...props}>
      <rect
        x="0.5"
        y="0.5"
        width="47"
        height="47"
        rx="11"
        fill="var(--surface-2)"
        stroke="var(--line-strong)"
        vectorEffect="non-scaling-stroke"
      />
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {GLYPHS[name]}
      </g>
    </svg>
  );
}
