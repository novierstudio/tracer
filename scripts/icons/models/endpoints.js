// Computers, servers, printers, screens and phones.
import { box, cylinder, group, slab, sphere, torus } from '../renderer.js';
import { leds, ports, row, screen } from './parts.js';

const pc = {
  size: 'medium',
  build(look) {
    const model = group();
    // The monitor on its stand, a keyboard in front, the tower to the right.
    const monitor = group(model, [-0.5, 0, -0.25]);
    slab(monitor, [1.0, 0.1, 0.7], [0, 0, 0], look.trim, 0.05);
    box(monitor, [0.24, 0.6, 0.14], [0, 0.4, -0.1], look.grey, 0.04);
    box(monitor, [2.3, 1.6, 0.2], [0, 1.4, 0], look.shell, 0.1);
    screen(monitor, look, { width: 2.05, height: 1.35, y: 1.42, z: 0.15, bezel: 0.08 });
    const keyboard = group(model, [-0.5, 0, 0.85]);
    slab(keyboard, [1.9, 0.1, 0.6], [0, 0, 0], look.shell, 0.04);
    slab(keyboard, [1.7, 0.06, 0.42], [0, 0.1, 0], look.trim, 0.03);
    const tower = group(model, [1.3, 0, 0]);
    slab(tower, [0.85, 1.9, 1.7], [0, 0, 0], look.shell, 0.1);
    box(tower, [0.6, 0.12, 0.06], [0, 1.5, 0.86], look.charcoal, 0.03);
    cylinder(tower, 0.12, 0.06, [0, 1.2, 0.86], look.accent, [Math.PI / 2, 0, 0]);
    return model;
  },
};

const laptop = {
  size: 'medium',
  build(look) {
    const model = group();
    slab(model, [2.6, 0.16, 1.7], [0, 0, 0.1], look.shell, 0.06);
    box(model, [2.2, 0.04, 0.8], [0, 0.17, -0.05], look.charcoal, 0.03);
    box(model, [0.8, 0.03, 0.42], [0, 0.17, 0.65], look.trim, 0.03);
    // The lid, open a little past upright, hinged at the back edge.
    const lid = group(model, [0, 0.16, -0.72], [-0.22, 0, 0]);
    box(lid, [2.6, 1.7, 0.1], [0, 0.85, 0], look.shell, 0.06);
    screen(lid, look, { width: 2.4, height: 1.5, y: 0.87, z: 0.12, bezel: 0.1 });
    return model;
  },
};

const server = {
  size: 'medium',
  build(look) {
    const model = group();
    slab(model, [1.9, 0.12, 1.8], [0, 0, 0], look.charcoal, 0.04);
    slab(model, [1.8, 2.5, 1.7], [0, 0.12, 0], look.steel, 0.08);
    slab(model, [1.9, 0.14, 1.8], [0, 2.62, 0], look.shell, 0.06);
    // Three drawers; the middle one in the accent, each with a light and a handle.
    for (const [i, material] of [look.trim, look.accent, look.trim].entries()) {
      const y = 2.05 - i * 0.68;
      box(model, [1.6, 0.6, 0.1], [0, y, 0.86], look.black, 0.03);
      box(model, [1.5, 0.5, 0.1], [0, y, 0.9], material, 0.04);
      box(model, [0.7, 0.1, 0.08], [0.15, y, 0.97], look.shell, 0.04);
      box(model, [0.1, 0.1, 0.06], [-0.55, y, 0.97], i === 1 ? look.glow : look.accentGlow, 0.03);
    }
    return model;
  },
};

const printer = {
  size: 'medium',
  build(look) {
    const model = group();
    slab(model, [2.4, 1.0, 1.7], [0, 0, 0], look.shell, 0.14);
    slab(model, [2.2, 0.12, 1.4], [0, 1.0, -0.05], look.trim, 0.06);
    // Paper standing in the feed at the back and lying in the output tray.
    box(model, [1.6, 0.9, 0.04], [0, 1.45, -0.72], look.shell, 0.01, [-0.3, 0, 0]);
    box(model, [1.8, 0.7, 0.1], [0, 1.3, -0.85], look.grey, 0.04, [-0.3, 0, 0]);
    box(model, [1.8, 0.1, 0.06], [0, 0.6, 0.86], look.black, 0.03);
    box(model, [1.5, 0.03, 0.6], [0, 0.5, 1.0], look.shell, 0.01);
    slab(model, [1.9, 0.06, 0.7], [0, 0.4, 0.95], look.grey, 0.03);
    box(model, [0.5, 0.06, 0.3], [0.75, 1.13, 0.4], look.charcoal, 0.03);
    cylinder(model, 0.1, 0.06, [0.75, 1.17, 0.4], look.accent);
    return model;
  },
};

const tablet = {
  size: 'small',
  build(look) {
    const model = group();
    slab(model, [1.2, 0.1, 1.0], [0, 0, 0], look.grey, 0.04);
    const body = group(model, [0, 0.1, 0.2], [-0.32, 0, 0]);
    box(body, [2.1, 1.55, 0.12], [0, 0.8, 0], look.charcoal, 0.1);
    box(body, [1.86, 1.32, 0.04], [0, 0.8, 0.06], look.screen, 0.04);
    row(body, {
      count: 3,
      pitch: 0.4,
      size: [0.26, 0.26, 0.04],
      x: -0.3,
      y: 1.1,
      z: 0.09,
      material: look.accent,
      radius: 0.05,
    });
    return model;
  },
};

const smartphone = {
  size: 'small',
  build(look) {
    const model = group();
    slab(model, [0.9, 0.18, 0.7], [0, 0, 0], look.shell, 0.08);
    const body = group(model, [0, 0.12, 0.05], [-0.22, 0, 0]);
    box(body, [0.95, 1.9, 0.12], [0, 0.95, 0], look.charcoal, 0.13);
    box(body, [0.8, 1.6, 0.04], [0, 0.95, 0.06], look.screen, 0.08);
    for (const [i, j] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]) {
      box(body, [0.22, 0.22, 0.04], [-0.17 + i * 0.34, 1.4 - j * 0.34, 0.09], look.accent, 0.05);
    }
    box(body, [0.3, 0.05, 0.04], [0, 1.82, 0.07], look.black, 0.02);
    return model;
  },
};

const tv = {
  size: 'medium',
  build(look) {
    const model = group();
    slab(model, [1.6, 0.1, 0.8], [0, 0, 0], look.charcoal, 0.04);
    box(model, [0.3, 0.5, 0.14], [0, 0.35, -0.1], look.slate, 0.04);
    box(model, [3.4, 2.0, 0.2], [0, 1.55, 0], look.charcoal, 0.08);
    box(model, [3.2, 1.8, 0.04], [0, 1.57, 0.11], look.screen, 0.03);
    box(model, [3.2, 0.06, 0.04], [0, 0.6, 0.11], look.accent, 0.02);
    return model;
  },
};

const ipPhone = {
  size: 'small',
  build(look) {
    const model = group();
    // A wedge of a base, tilted towards the user.
    const body = group(model, [0, 0.25, 0], [0.3, 0, 0]);
    box(body, [2.1, 0.4, 1.7], [0, 0, 0], look.charcoal, 0.14);
    box(body, [1.0, 0.06, 0.6], [0.35, 0.21, -0.35], look.screen, 0.03);
    for (let r = 0; r < 3; r++) {
      row(body, {
        count: 3,
        pitch: 0.24,
        size: [0.17, 0.06, 0.15],
        x: 0.35,
        y: 0.22,
        z: 0.18 + r * 0.22,
        material: look.shell,
        radius: 0.03,
      });
    }
    // The handset lies along the left side, with its line key in the accent.
    box(body, [0.55, 0.32, 1.7], [-0.68, 0.32, 0], look.slate, 0.15);
    box(body, [0.16, 0.06, 0.5], [0.98, 0.21, -0.35], look.accent, 0.03);
    return model;
  },
};

const voipAdapter = {
  size: 'small',
  scale: 1.2,
  build(look) {
    const model = group();
    slab(model, [1.7, 0.55, 1.3], [0, 0, 0], look.shell, 0.14);
    box(model, [0.28, 0.18, 0.06], [-0.4, 0.28, 0.66], look.black, 0.03);
    box(model, [0.22, 0.16, 0.06], [0.1, 0.28, 0.66], look.slate, 0.03);
    leds(model, look, { count: 2, x: 0.55, y: 0.28, z: 0.66, pitch: 0.2 });
    // A handset resting on the lid, in the accent.
    const handset = group(model, [0, 0.55, 0], [0, -0.35, 0]);
    box(handset, [1.1, 0.14, 0.28], [0, 0.12, 0], look.accent, 0.06);
    for (const x of [-0.5, 0.5]) box(handset, [0.34, 0.24, 0.42], [x, 0.12, 0], look.accent, 0.1);
    return model;
  },
};

const analogPhone = {
  size: 'small',
  build(look) {
    const model = group();
    slab(model, [1.9, 0.6, 1.6], [0, 0, 0], look.accent, 0.2);
    slab(model, [1.5, 0.3, 1.1], [0, 0.6, -0.1], look.accent, 0.14);
    // The dial on the sloped front, the handset across the cradle.
    const dial = group(model, [0, 0.55, 0.7], [-0.6, 0, 0]);
    cylinder(dial, 0.36, 0.08, [0, 0, 0], look.shell, [Math.PI / 2, 0, 0]);
    cylinder(dial, 0.13, 0.1, [0, 0, 0.02], look.charcoal, [Math.PI / 2, 0, 0]);
    box(model, [2.1, 0.22, 0.32], [0, 1.1, -0.1], look.charcoal, 0.1);
    for (const x of [-0.9, 0.9])
      box(model, [0.4, 0.34, 0.52], [x, 1.02, -0.1], look.charcoal, 0.14);
    return model;
  },
};

const sniffer = {
  size: 'small',
  scale: 1.15,
  build(look) {
    const model = group();
    slab(model, [1.8, 0.5, 1.2], [0, 0, 0], look.charcoal, 0.1);
    ports(model, look, { count: 2, x: -0.4, y: 0.25, z: 0.61, pitch: 0.36 });
    box(model, [0.4, 0.06, 0.4], [0.5, 0.5, 0], look.slate, 0.03);
    // A magnifying glass held over the box.
    const glass = group(model, [0.25, 1.15, 0.25], [-0.5, 0.3, 0.4]);
    torus(glass, 0.55, 0.1, [0, 0, 0], look.accent, [0, 0, 0]);
    cylinder(glass, 0.5, 0.03, [0, 0, 0], look.glass, [Math.PI / 2, 0, 0], 40);
    cylinder(glass, 0.1, 0.8, [0.7, -0.7, 0], look.shell, [0, 0, Math.PI / 4], 16);
    sphere(glass, 0.04, [-0.2, 0.2, 0.05], look.shell);
    return model;
  },
};

export const MODELS = {
  pc,
  laptop,
  server,
  printer,
  tablet,
  smartphone,
  tv,
  'ip-phone': ipPhone,
  'voip-adapter': voipAdapter,
  'analog-phone': analogPhone,
  sniffer,
};
