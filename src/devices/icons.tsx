import { useState, type ReactNode, type SVGProps } from 'react';
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
  // A thin box that sends what it hears both ways at once.
  hub: (
    <>
      <rect x="8" y="17" width="32" height="14" rx="3.5" />
      <path d="M14 24h20M17.5 20.5 14 24l3.5 3.5M30.5 20.5 34 24l-3.5 3.5" stroke={ACCENT} />
    </>
  ),
  // A router with a square body: an ISR 4000.
  'router-isr': (
    <>
      <rect x="9.5" y="9.5" width="29" height="29" rx="6" />
      <path d="M14 24h7m0 0c4 0 5-7.5 10.5-7.5M21 24c4 0 5 7.5 10.5 7.5" />
      <circle cx="21" cy="24" r="3" fill={ACCENT} stroke="none" />
    </>
  ),
  // A generic router: a ring with four arrows in and out.
  'router-pt': (
    <>
      <circle cx="24" cy="24" r="14.5" />
      <path d="M24 13v8m0 6v8M13 24h8m6 0h8" stroke={ACCENT} />
    </>
  ),
  // A switch on a DIN rail, with fins for cooling.
  'industrial-switch': (
    <>
      <rect x="14" y="8" width="20" height="32" rx="3" />
      <path d="M19 14h10M19 18h10M19 22h10" />
      <path d="M20 29v5M24 29v5M28 29v5" stroke={ACCENT} />
    </>
  ),
  // Two segments joined by a span.
  bridge: (
    <>
      <path d="M7 31h34" />
      <path d="M11 31c0-8 6-13 13-13s13 5 13 13" stroke={ACCENT} />
      <path d="M17 31v-9M24 31v-13M31 31v-9" />
    </>
  ),
  // A small box that passes the signal straight through.
  repeater: (
    <>
      <rect x="15" y="17" width="18" height="14" rx="3.5" />
      <path d="M7 24h8M33 24h8" />
      <path d="M21 24h6m-2.5-2.5L27 24l-2.5 2.5" stroke={ACCENT} />
    </>
  ),
  // A puck on the ceiling, with the waves it sends.
  'access-point': (
    <>
      <rect x="12" y="29" width="24" height="9" rx="4.5" />
      <path d="M18.5 22.5a8 8 0 0 1 11 0M14.5 18a14 14 0 0 1 19 0" stroke={ACCENT} />
      <circle cx="24" cy="33.5" r="1.5" fill={ACCENT} stroke="none" />
    </>
  ),
  // A home router: a box with two antennas and its waves.
  'wireless-router': (
    <>
      <rect x="9" y="26" width="30" height="11" rx="3" />
      <path d="M15 26v-9M33 26v-9" />
      <path d="M20 17.5a6 6 0 0 1 8 0M17 13.5a11 11 0 0 1 14 0" stroke={ACCENT} />
      <path d="M15 31.5h2M20 31.5h2M25 31.5h2" />
    </>
  ),
};

type DeviceIconProps = Omit<SVGProps<SVGSVGElement>, 'name'> & { name: DeviceIconName };

/**
 * A device as a flat glyph on a rounded tile, for spots too small for its sprite. The glyph takes
 * `currentColor`; tile and accent follow the theme.
 */
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

// Rendered by `pnpm icons:render` from the models in scripts/icons/models/.
const SPRITES = `${import.meta.env.BASE_URL}devices/`;

type DeviceSpriteProps = {
  name: DeviceIconName;
  className?: string;
  loading?: 'eager' | 'lazy';
};

/** A device as its isometric sprite. A name with no sprite yet falls back to its glyph. */
export function DeviceSprite({ name, className, loading }: DeviceSpriteProps) {
  const [missing, setMissing] = useState<DeviceIconName>();
  if (missing === name) return <DeviceIcon name={name} className={className} />;
  return (
    <img
      src={`${SPRITES}${name}.webp`}
      srcSet={`${SPRITES}${name}.webp 1x, ${SPRITES}${name}@2x.webp 2x`}
      alt=""
      aria-hidden="true"
      draggable={false}
      decoding="async"
      loading={loading}
      onError={() => setMissing(name)}
      className={className}
    />
  );
}
