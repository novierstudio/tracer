// Routers, switches and the small boxes of the wired network.
import { box, cylinder, group, slab, torus, tube } from '../renderer.js';
import { antenna, chassis, feet, leds, ports, row } from './parts.js';

const router = {
  size: 'medium',
  build(look) {
    const model = group();
    const front = chassis(model, look, {
      width: 3.0,
      height: 0.85,
      depth: 2.0,
      face: look.charcoal,
    });
    ports(model, look, { count: 4, x: 0.6, y: 0.42, z: front, pitch: 0.3 });
    leds(model, look, { count: 2, x: -1.05, y: 0.42, z: front, pitch: 0.2 });
    // A round accent badge marks a router at a glance.
    cylinder(model, 0.22, 0.06, [-0.4, 0.42, front], look.accent, [Math.PI / 2, 0, 0]);
    for (const x of [-1.1, 1.1]) antenna(model, look, { x, y: 0.85, z: -0.7, height: 0.85 });
    return model;
  },
};

const routerIsr = {
  size: 'medium',
  build(look) {
    const model = group();
    const front = chassis(model, look, { width: 3.0, height: 0.95, depth: 2.0, face: look.shell });
    // The grille: deep slats across most of the bezel.
    row(model, {
      count: 7,
      pitch: 0.2,
      size: [0.1, 0.56, 0.06],
      x: -0.55,
      y: 0.52,
      z: front,
      material: look.charcoal,
    });
    ports(model, look, { count: 2, x: 0.95, y: 0.6, z: front, pitch: 0.3 });
    box(model, [2.8, 0.12, 0.07], [0, 0.14, front], look.accent, 0.03);
    return model;
  },
};

const routerPt = {
  size: 'medium',
  build(look) {
    const model = group();
    const front = chassis(model, look, { width: 2.7, height: 1.35, depth: 2.0, face: look.slate });
    // Two by two module bays; one holds an accent module with its own ports.
    for (const [x, y] of [
      [-0.62, 0.95],
      [0.62, 0.95],
      [-0.62, 0.42],
      [0.62, 0.42],
    ]) {
      box(model, [1.08, 0.4, 0.05], [x, y, front], look.black, 0.03);
    }
    box(model, [1.0, 0.33, 0.1], [-0.62, 0.95, front + 0.03], look.accent, 0.03);
    row(model, {
      count: 2,
      pitch: 0.3,
      size: [0.2, 0.13, 0.05],
      x: -0.55,
      y: 0.95,
      z: front + 0.08,
      material: look.black,
    });
    box(model, [1.0, 0.33, 0.1], [0.62, 0.42, front + 0.03], look.trim, 0.03);
    return model;
  },
};

const switchModel = {
  size: 'medium',
  build(look) {
    const model = group();
    const front = chassis(model, look, { width: 3.2, height: 0.75, depth: 1.9, face: look.trim });
    ports(model, look, { count: 8, x: -0.25, y: 0.5, z: front, pitch: 0.28, rows: 2, gap: 0.25 });
    // Uplink block in the accent.
    box(model, [0.55, 0.5, 0.08], [1.2, 0.375, front], look.accent, 0.04);
    row(model, {
      count: 2,
      pitch: 0.22,
      size: [0.15, 0.14, 0.05],
      x: 1.2,
      y: 0.375,
      z: front + 0.05,
      material: look.black,
    });
    return model;
  },
};

const multilayerSwitch = {
  size: 'medium',
  build(look) {
    const model = group();
    const front = chassis(model, look, { width: 3.2, height: 0.75, depth: 1.9, face: look.trim });
    ports(model, look, { count: 9, x: 0, y: 0.5, z: front, pitch: 0.28, rows: 2, gap: 0.25 });
    // The routing layer: an accent deck on top with its uplinks.
    slab(model, [2.6, 0.5, 1.5], [0, 0.75, -0.1], look.accent, 0.08);
    row(model, {
      count: 4,
      pitch: 0.34,
      size: [0.24, 0.16, 0.06],
      x: 0,
      y: 1.0,
      z: 0.66,
      material: look.black,
    });
    return model;
  },
};

const industrialSwitch = {
  size: 'medium',
  build(look) {
    const model = group();
    // The DIN rail runs behind the unit, left to right.
    box(model, [3.0, 0.4, 0.12], [0, 1.25, -0.72], look.steel, 0.02);
    box(model, [3.0, 0.08, 0.3], [0, 1.41, -0.62], look.steel, 0.02);
    box(model, [3.0, 0.08, 0.3], [0, 1.09, -0.62], look.steel, 0.02);
    slab(model, [1.1, 2.3, 1.3], [0, 0.1, 0], look.grey, 0.1);
    // Cooling fins down the side, a terminal block on top and ports down the face.
    for (let i = 0; i < 5; i++)
      box(model, [0.08, 1.7, 1.0], [0.58, 1.25, -0.45 + i * 0.22], look.trim, 0.03);
    slab(model, [0.9, 0.3, 0.9], [0, 2.4, 0], look.accent, 0.05);
    box(model, [0.9, 1.7, 0.06], [0, 1.15, 0.66], look.charcoal, 0.04);
    for (let i = 0; i < 4; i++)
      box(model, [0.42, 0.24, 0.06], [-0.1, 1.75 - i * 0.36, 0.7], look.black, 0.03);
    for (let i = 0; i < 4; i++)
      box(model, [0.1, 0.1, 0.05], [0.3, 1.75 - i * 0.36, 0.72], look.accentGlow, 0.03);
    return model;
  },
};

const bridge = {
  size: 'medium',
  build(look) {
    const model = group();
    slab(model, [2.4, 0.7, 1.5], [0, 0, 0], look.shell, 0.14);
    box(model, [2.2, 0.5, 0.06], [0, 0.35, 0.76], look.trim, 0.04);
    for (const x of [-0.8, 0.8]) box(model, [0.32, 0.22, 0.06], [x, 0.35, 0.8], look.black, 0.03);
    // An arch spans the case from one port to the other.
    torus(model, 0.8, 0.13, [0, 0.7, 0], look.accent, [0, 0, 0], Math.PI);
    for (const x of [-0.8, 0.8]) slab(model, [0.36, 0.08, 0.36], [x, 0.7, 0], look.slate, 0.03);
    return model;
  },
};

const hub = {
  size: 'medium',
  build(look) {
    const model = group();
    slab(model, [2.6, 0.62, 1.6], [0, 0.06, 0], look.grey, 0.2);
    feet(model, look, { width: 2.4, depth: 1.4 });
    box(model, [2.3, 0.36, 0.06], [0, 0.37, 0.78], look.charcoal, 0.05);
    ports(model, look, { count: 5, x: 0, y: 0.37, z: 0.82, pitch: 0.36 });
    // A strip of light across the lid.
    box(model, [1.8, 0.06, 0.32], [0, 0.69, 0.3], look.accentGlow, 0.03);
    return model;
  },
};

const repeater = {
  size: 'small',
  build(look) {
    const model = group();
    slab(model, [1.2, 0.8, 1.2], [0, 0.1, 0], look.shell, 0.16);
    box(model, [0.9, 0.12, 0.06], [0, 0.5, 0.61], look.accent, 0.03);
    // A cable in one side and out the other.
    for (const side of [-1, 1]) {
      box(model, [0.08, 0.3, 0.3], [side * 0.62, 0.5, 0], look.black, 0.03);
      tube(
        model,
        [
          [side * 0.62, 0.5, 0],
          [side * 0.95, 0.5, 0.1],
          [side * 1.25, 0.25, 0.45],
          [side * 1.35, 0.08, 0.85],
        ],
        0.07,
        look.charcoal,
      );
    }
    cylinder(model, 0.12, 0.06, [0, 0.93, 0], look.accentGlow);
    return model;
  },
};

const coaxialSplitter = {
  size: 'small',
  build(look) {
    const model = group();
    slab(model, [1.3, 0.55, 1.1], [0, 0, 0], look.steel, 0.08);
    box(model, [1.0, 0.06, 0.8], [0, 0.56, 0], look.accent, 0.03);
    const barrel = (x, z, direction) => {
      cylinder(
        model,
        0.17,
        0.2,
        [x + direction * 0.1, 0.28, z],
        look.slate,
        [0, 0, Math.PI / 2],
        6,
      );
      cylinder(
        model,
        0.11,
        0.3,
        [x + direction * 0.3, 0.28, z],
        look.steel,
        [0, 0, Math.PI / 2],
        16,
      );
    };
    barrel(-0.65, 0, -1);
    barrel(0.65, -0.28, 1);
    barrel(0.65, 0.28, 1);
    tube(
      model,
      [
        [-1.0, 0.28, 0],
        [-1.25, 0.28, 0.1],
        [-1.4, 0.2, 0.55],
        [-1.3, 0.1, 0.95],
      ],
      0.09,
      look.black,
    );
    return model;
  },
};

export const MODELS = {
  router,
  'router-isr': routerIsr,
  'router-pt': routerPt,
  switch: switchModel,
  'multilayer-switch': multilayerSwitch,
  'industrial-switch': industrialSwitch,
  bridge,
  hub,
  repeater,
  'coaxial-splitter': coaxialSplitter,
};
