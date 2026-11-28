// The edge: firewalls, the WAN cloud and the modems that reach it.
import { box, cylinder, group, slab, sphere, tube } from '../renderer.js';
import { chassis, leds, ports } from './parts.js';

const firewall = {
  size: 'medium',
  build(look) {
    const model = group();
    const front = chassis(model, look, {
      width: 3.0,
      height: 1.15,
      depth: 2.0,
      face: look.charcoal,
    });
    // A brick wall across the face, three courses, staggered.
    const brick = [0.46, 0.24, 0.08];
    for (let course = 0; course < 3; course++) {
      const y = 0.29 + course * 0.29;
      const offset = course % 2 ? 0.26 : 0;
      for (let i = 0; i < 4; i++) {
        const x = -1.18 + offset + i * 0.52;
        box(model, brick, [x, y, front], look.accent, 0.03);
      }
    }
    ports(model, look, { count: 2, x: 1.03, y: 0.75, z: front, pitch: 0.28, rows: 2, gap: 0.3 });
    return model;
  },
};

const cloud = {
  size: 'medium',
  build(look) {
    const model = group();
    slab(model, [2.6, 0.32, 1.5], [0, 0, 0], look.charcoal, 0.1);
    box(model, [2.4, 0.08, 0.06], [0, 0.16, 0.76], look.accent, 0.03);
    // Puffs of one off-white, the middle one tallest.
    const puffs = [
      [-0.95, 0.95, 0.1, 0.5],
      [-0.35, 1.25, 0, 0.68],
      [0.4, 1.35, -0.05, 0.78],
      [1.05, 0.98, 0.05, 0.5],
      [0, 0.85, 0.25, 0.55],
    ];
    for (const [x, y, z, r] of puffs) sphere(model, r, [x, y, z], look.shell, [1, 0.92, 0.85]);
    cylinder(model, 0.12, 0.35, [0, 0.45, 0], look.slate, undefined, 16);
    return model;
  },
};

const dslModem = {
  size: 'medium',
  build(look) {
    const model = group();
    slab(model, [1.2, 0.12, 1.6], [0, 0, 0], look.charcoal, 0.05);
    slab(model, [0.6, 1.9, 1.5], [0, 0.12, 0], look.shell, 0.18);
    // Lights down the front edge, a phone cord out the back to its plug.
    for (let i = 0; i < 4; i++)
      box(model, [0.1, 0.16, 0.05], [0, 1.6 - i * 0.28, 0.76], look.accentGlow, 0.03);
    box(model, [0.32, 0.22, 0.06], [0.31, 0.5, -0.4], look.black, 0.03);
    tube(
      model,
      [
        [0.33, 0.5, -0.4],
        [0.75, 0.5, -0.3],
        [1.1, 0.3, 0.2],
        [1.3, 0.1, 0.8],
      ],
      0.05,
      look.slate,
    );
    slab(model, [0.22, 0.16, 0.32], [1.3, 0.02, 0.9], look.slate, 0.03);
    return model;
  },
};

const cableModem = {
  size: 'medium',
  build(look) {
    const model = group();
    slab(model, [2.3, 0.75, 1.5], [0, 0.06, 0], look.trim, 0.22);
    box(model, [1.9, 0.08, 1.0], [0, 0.82, 0.05], look.accent, 0.04);
    leds(model, look, { count: 5, x: -0.2, y: 0.42, z: 0.77, pitch: 0.22 });
    // The coax barrel on the side, with its thick cable.
    cylinder(model, 0.15, 0.22, [1.25, 0.42, 0.1], look.slate, [0, 0, Math.PI / 2], 6);
    cylinder(model, 0.1, 0.24, [1.45, 0.42, 0.1], look.steel, [0, 0, Math.PI / 2], 16);
    tube(
      model,
      [
        [1.55, 0.42, 0.1],
        [1.8, 0.4, 0.3],
        [1.85, 0.2, 0.7],
        [1.6, 0.08, 1.0],
      ],
      0.09,
      look.black,
    );
    return model;
  },
};

export const MODELS = {
  firewall,
  cloud,
  'dsl-modem': dslModem,
  'cable-modem': cableModem,
};
