import { describe, expect, it } from 'vitest';
import type { EventId } from '@/engine/events';
import type { DeviceId } from '@/model';
import { drawChips, drawPulse, type Drawn, type Palette, type Scene } from './draw';
import { arpRequest, hop } from './testing';
import { createTraffic } from './traffic';

/** A 2D context that records what is painted: each call, with the opacity and fill it used. */
function recordingContext() {
  const calls: string[] = [];
  const state: Record<string | symbol, unknown> = { globalAlpha: 1 };
  const special: Record<string, unknown> = {
    getTransform: () => ({}),
    measureText: (text: string) => ({ width: text.length * 6 }),
    createLinearGradient: () => ({ addColorStop: () => {} }),
  };
  const ctx = new Proxy(state, {
    get: (target, key) =>
      typeof key === 'string' && key in special
        ? special[key]
        : key in target
          ? target[key]
          : (...args: unknown[]) =>
              calls.push(
                `${String(key)}(${args.join(',')}) @${String(target.globalAlpha)} ${String(target.fillStyle)}`,
              ),
    set: (target, key, value) => {
      target[key] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const colour = { fill: '#2563eb', text: '#ffffff' };
const palette: Palette = {
  protocols: {
    arp: colour,
    icmp: colour,
    icmpv6: colour,
    ndp: colour,
    dhcp: colour,
    dns: colour,
    tcp: colour,
    http: colour,
    telnet: colour,
    ssh: colour,
    rip: colour,
    ospf: colour,
    eigrp: colour,
    stp: colour,
    cdp: colour,
    lldp: colour,
    lacp: colour,
    pagp: colour,
    hello: colour,
  },
  outline: '#fefefe',
  accent: '#5b5bd6',
  error: '#c81e1e',
  ink: '#18181b',
};

const positions: Record<string, { x: number; y: number }> = {
  PC1: { x: 0, y: 0 },
  SW1: { x: 300, y: 0 },
  R1: { x: 600, y: 0 },
};

function scene(fields: Partial<Scene> = {}) {
  const { ctx, calls } = recordingContext();
  const value: Scene = {
    ctx,
    transform: [0, 0, 1],
    device: (id: DeviceId) =>
      positions[id] && { centre: positions[id], label: { width: 40, height: 14 } },
    palette,
    hidden: [],
    wallNow: 0,
    reducedMotion: false,
    ...fields,
  };
  return { scene: value, calls };
}

const restingChips = () => {
  const traffic = createTraffic();
  traffic.showMoment(
    {
      arriving: [],
      resting: [
        hop({ id: 1, from: 'PC1', to: 'SW1', sentAt: 0, payload: arpRequest }),
        hop({ id: 2, from: 'SW1', to: 'R1', sentAt: 1 }),
      ],
      leaving: [],
    },
    0,
    400,
  );
  return traffic.frame(0).chips;
};

describe('drawChips', () => {
  /** Where the surface colour was painted over a chip, by call index. */
  const washes = (calls: string[]) =>
    calls.flatMap((call, index) =>
      call.startsWith('fill()') && call.endsWith(palette.outline) ? [index] : [],
    );
  const label = (calls: string[], text: string) =>
    calls.findIndex((call) => call.startsWith(`fillText(${text},`));

  it('washes out every chip but the selected event’s, and paints that one on top', () => {
    const { scene: selecting, calls } = scene({ selected: 1 as EventId });
    const drawn = drawChips(selecting, restingChips());

    expect(drawn.map(({ chip }) => chip.event.id)).toEqual([2, 1]);
    const icmp = label(calls, 'ICMP');
    const arp = label(calls, 'ARP');
    expect(icmp).toBeLessThan(arp);
    expect(washes(calls).length).toBeGreaterThan(0);
    expect(washes(calls).every((index) => index > icmp && index < arp)).toBe(true);
  });

  it('washes out nothing when no event is selected', () => {
    const { scene: plain, calls } = scene();
    drawChips(plain, restingChips());
    expect(washes(calls)).toEqual([]);
  });
});

describe('drawPulse', () => {
  const target = (): Drawn => ({
    chip: restingChips()[0]!.chip,
    x: 100,
    y: 50,
    width: 40,
    height: 18,
  });

  it('breathes over time', () => {
    const early = scene({ wallNow: 100 });
    const late = scene({ wallNow: 800 });
    drawPulse(early.scene, target());
    drawPulse(late.scene, target());
    expect(late.calls).not.toEqual(early.calls);
  });

  it('holds still under reduced motion', () => {
    const early = scene({ wallNow: 100, reducedMotion: true });
    const late = scene({ wallNow: 800, reducedMotion: true });
    drawPulse(early.scene, target());
    drawPulse(late.scene, target());
    expect(late.calls).toEqual(early.calls);
    expect(early.calls.length).toBeGreaterThan(0);
  });
});
