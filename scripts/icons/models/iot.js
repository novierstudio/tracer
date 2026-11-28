// Things on the IoT network: boards, and the household objects they drive.
import { box, cone, cylinder, group, mesh, slab, sphere, THREE, torus } from '../renderer.js';
import { antenna, row } from './parts.js';

const mcu = {
  size: 'small',
  build(look) {
    const model = group(null, [0, 0, 0], [0, 0.35, 0]);
    slab(model, [1.25, 0.12, 2.8], [0, 0.1, 0], look.accent, 0.03);
    // Header strips down both long edges, the chip between them, USB at the end.
    for (const x of [-0.46, 0.46]) slab(model, [0.2, 0.26, 2.3], [x, 0.22, -0.1], look.black, 0.03);
    slab(model, [0.56, 0.14, 0.56], [0, 0.22, 0.1], look.black, 0.03);
    slab(model, [0.5, 0.26, 0.36], [0, 0.22, 1.3], look.steel, 0.04);
    box(model, [0.12, 0.06, 0.12], [0.2, 0.25, -0.7], look.glow, 0.03);
    for (const z of [-0.95, 0.95]) {
      for (const x of [-0.42, 0.42])
        cylinder(model, 0.07, 0.1, [x, 0.05, z * 1.3], look.slate, undefined, 12);
    }
    return model;
  },
};

const sbc = {
  size: 'small',
  build(look) {
    const model = group();
    slab(model, [2.3, 0.1, 1.6], [0, 0.1, 0], look.accent, 0.03);
    for (const x of [-0.9, 0.9])
      for (const z of [-0.6, 0.6])
        cylinder(model, 0.06, 0.1, [x, 0.05, z], look.slate, undefined, 12);
    // Stacked USB and Ethernet blocks on the right edge, the processor, the GPIO header.
    slab(model, [0.6, 0.5, 0.42], [0.85, 0.2, 0.45], look.steel, 0.04);
    slab(model, [0.6, 0.5, 0.42], [0.85, 0.2, -0.05], look.steel, 0.04);
    slab(model, [0.6, 0.45, 0.42], [0.85, 0.2, -0.55], look.steel, 0.04);
    slab(model, [0.55, 0.1, 0.55], [-0.3, 0.2, 0.1], look.black, 0.03);
    slab(model, [1.6, 0.2, 0.18], [-0.25, 0.2, -0.65], look.black, 0.03);
    return model;
  },
};

const lamp = {
  size: 'small',
  build(look) {
    const model = group();
    cylinder(model, 0.6, 0.16, [0, 0.08, 0], look.charcoal, undefined, 40);
    torus(model, 0.6, 0.04, [0, 0.16, 0], look.accent, [Math.PI / 2, 0, 0]);
    cylinder(model, 0.07, 1.3, [0, 0.8, 0], look.steel, undefined, 16);
    // A warm bulb under a cone of a shade.
    sphere(model, 0.26, [0, 1.38, 0], look.glow);
    cone(model, 0.4, 0.85, 0.8, [0, 1.75, 0], look.shell, undefined, 40);
    cylinder(model, 0.4, 0.04, [0, 2.16, 0], look.trim, undefined, 40);
    return model;
  },
};

const fan = {
  size: 'small',
  build(look) {
    const model = group(null, [0, 0, 0], [0, 0.2, 0]);
    slab(model, [1.2, 0.18, 1.0], [0, 0, 0], look.charcoal, 0.08);
    cylinder(model, 0.08, 1.0, [0, 0.65, -0.1], look.steel, undefined, 16);
    // The motor, the blades and the guard face the viewer.
    const head = group(model, [0, 1.6, 0]);
    cylinder(head, 0.28, 0.5, [0, 0, -0.32], look.shell, [Math.PI / 2, 0, 0]);
    for (let i = 0; i < 3; i++) {
      const blade = group(head, [0, 0, 0.02], [0, 0, (i * 2 * Math.PI) / 3]);
      sphere(blade, 0.4, [0, 0.42, 0], look.accent, [0.62, 1, 0.12]);
    }
    sphere(head, 0.14, [0, 0, 0.06], look.shell);
    torus(head, 0.88, 0.06, [0, 0, 0.05], look.trim);
    for (let i = 0; i < 4; i++) {
      box(head, [0.04, 1.72, 0.04], [0, 0, 0.12], look.trim, 0.01, [
        0,
        0,
        (i * Math.PI) / 4 + Math.PI / 8,
      ]);
    }
    return model;
  },
};

const door = {
  size: 'small',
  build(look) {
    const model = group();
    slab(model, [1.9, 0.1, 0.8], [0, 0, 0], look.grey, 0.03);
    // The frame, the accent door and its handle.
    for (const x of [-0.78, 0.78]) slab(model, [0.2, 2.3, 0.4], [x, 0.1, 0], look.shell, 0.04);
    slab(model, [1.76, 0.2, 0.4], [0, 2.4, 0], look.shell, 0.04);
    slab(model, [1.36, 2.28, 0.16], [0, 0.11, 0], look.accent, 0.04);
    for (const y of [0.8, 1.7]) box(model, [1.0, 0.62, 0.04], [0, y, 0.09], look.accentLight, 0.04);
    sphere(model, 0.1, [0.48, 1.3, 0.16], look.steel);
    box(model, [0.16, 0.26, 0.08], [0.48, 1.62, 0.1], look.charcoal, 0.03);
    return model;
  },
};

const windowModel = {
  size: 'small',
  build(look) {
    const model = group();
    const width = 2.0;
    const height = 2.2;
    const bottom = 0.3;
    // Glass first, then the frame and the cross over it, then the accent sill.
    box(model, [width - 0.2, height - 0.2, 0.04], [0, bottom + height / 2, 0], look.glass, 0.01);
    for (const x of [-1, 1])
      box(
        model,
        [0.16, height, 0.3],
        [x * (width / 2 - 0.08), bottom + height / 2, 0],
        look.shell,
        0.04,
      );
    for (const y of [0, 1])
      box(model, [width, 0.16, 0.3], [0, bottom + 0.08 + y * (height - 0.16), 0], look.shell, 0.04);
    box(model, [0.1, height - 0.2, 0.2], [0, bottom + height / 2, 0], look.shell, 0.03);
    box(model, [width - 0.2, 0.1, 0.2], [0, bottom + height / 2, 0], look.shell, 0.03);
    slab(model, [width + 0.3, 0.16, 0.7], [0, bottom - 0.16, 0.15], look.accent, 0.04);
    return model;
  },
};

const motion = {
  size: 'small',
  scale: 1.15,
  build(look) {
    const model = group();
    slab(model, [1.4, 0.1, 1.0], [0, 0, 0], look.grey, 0.03);
    slab(model, [1.2, 1.5, 0.3], [0, 0.1, -0.3], look.trim, 0.05);
    slab(model, [0.9, 1.1, 0.5], [0, 0.4, 0.05], look.shell, 0.12);
    // A faceted lens, the sensor's eye.
    const lens = mesh(
      model,
      new THREE.SphereGeometry(0.4, 8, 6, 0, Math.PI * 2, 0, Math.PI / 2),
      look.screen,
      [0, 1.0, 0.3],
      [Math.PI / 2, 0, 0],
    );
    lens.material = look.toon('#e9e4f8', { stroke: 0.7 });
    box(model, [0.1, 0.1, 0.05], [0.28, 0.6, 0.31], look.accentGlow, 0.03);
    box(model, [0.9, 0.1, 0.1], [0, 0.48, 0.3], look.accent, 0.03);
    return model;
  },
};

const smoke = {
  size: 'small',
  build(look) {
    const model = group();
    cylinder(model, 1.0, 0.3, [0, 0.15, 0], look.shell, undefined, 48);
    sphere(model, 0.55, [0, 0.3, 0], look.trim, [1, 0.35, 1]);
    for (let i = 0; i < 10; i++) {
      const angle = (i * Math.PI * 2) / 10;
      box(
        model,
        [0.08, 0.06, 0.24],
        [Math.sin(angle) * 0.78, 0.3, Math.cos(angle) * 0.78],
        look.slate,
        0.02,
        [0, angle, 0],
      );
    }
    cylinder(model, 0.09, 0.05, [0.35, 0.48, 0.2], look.accentGlow, undefined, 16);
    // Puffs of smoke rising from it.
    const puff = look.toon('#c9c6c0', { stroke: 0.8 });
    for (const [x, y, z, r] of [
      [-0.15, 0.85, 0.1, 0.2],
      [0.2, 1.2, -0.05, 0.28],
      [0.6, 1.62, -0.2, 0.36],
    ]) {
      sphere(model, r, [x, y, z], puff);
    }
    return model;
  },
};

const siren = {
  size: 'small',
  scale: 1.4,
  build(look) {
    const model = group();
    cylinder(model, 0.75, 0.2, [0, 0.1, 0], look.charcoal, undefined, 40);
    cylinder(model, 0.6, 0.35, [0, 0.37, 0], look.slate, undefined, 40);
    // A tall accent dome with a bulb, and a horn on the side.
    const dome = mesh(
      model,
      new THREE.SphereGeometry(0.55, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2),
      look.accent,
      [0, 0.55, 0],
    );
    dome.scale.set(1, 1.6, 1);
    cylinder(model, 0.55, 0.3, [0, 0.69, 0], look.accent, undefined, 40);
    cylinder(model, 0.62, 0.08, [0, 0.58, 0], look.charcoal, undefined, 40);
    return model;
  },
};

const thermostat = {
  size: 'small',
  build(look) {
    const model = group();
    slab(model, [1.6, 0.1, 0.9], [0, 0, 0], look.grey, 0.03);
    slab(model, [1.5, 1.9, 0.14], [0, 0.1, -0.3], look.trim, 0.12);
    // A round dial standing off the plate: steel rim, dark face, accent arc of a setting.
    const dial = group(model, [0, 1.05, -0.08], [Math.PI / 2, 0, 0]);
    cylinder(dial, 0.62, 0.3, [0, 0, 0], look.steel, undefined, 48);
    cylinder(dial, 0.5, 0.06, [0, 0.16, 0], look.charcoal, undefined, 48);
    torus(
      dial,
      0.36,
      0.06,
      [0, 0.2, 0],
      look.accentGlow,
      [-Math.PI / 2, 0, Math.PI * 0.8],
      Math.PI * 1.4,
    );
    box(dial, [0.26, 0.04, 0.14], [0, 0.21, 0], look.accentLight, 0.02);
    return model;
  },
};

const webcam = {
  size: 'small',
  scale: 1.25,
  build(look) {
    const model = group(null, [0, 0, 0], [0, -0.15, 0]);
    // A clip over a monitor's edge, a stalk, then the head with its lens.
    slab(model, [1.0, 0.12, 0.8], [0, 0, 0], look.charcoal, 0.04);
    cylinder(model, 0.09, 0.55, [0, 0.38, 0], look.slate, undefined, 16);
    box(model, [1.7, 0.85, 0.75], [0, 1.05, 0], look.shell, 0.3);
    cylinder(model, 0.34, 0.12, [0, 1.05, 0.39], look.charcoal, [Math.PI / 2, 0, 0], 40);
    cylinder(model, 0.22, 0.06, [0, 1.05, 0.46], look.screen, [Math.PI / 2, 0, 0], 40);
    cylinder(model, 0.08, 0.04, [0, 1.05, 0.5], look.black, [Math.PI / 2, 0, 0], 20);
    cylinder(model, 0.07, 0.05, [0.6, 1.25, 0.37], look.accentGlow, [Math.PI / 2, 0, 0], 16);
    box(model, [1.4, 0.1, 0.06], [0, 0.7, 0.36], look.accent, 0.03);
    return model;
  },
};

const thing = {
  size: 'small',
  build(look) {
    const model = group();
    slab(model, [1.4, 1.2, 1.4], [0, 0, 0], look.shell, 0.3);
    box(model, [1.44, 0.22, 1.44], [0, 0.5, 0], look.accent, 0.1);
    row(model, {
      count: 1,
      pitch: 0,
      size: [0.16, 0.16, 0.05],
      y: 0.85,
      z: 0.71,
      material: look.accentGlow,
      radius: 0.05,
    });
    antenna(model, look, { x: 0.4, y: 1.2, z: -0.35, height: 0.8 });
    return model;
  },
};

export const MODELS = {
  'iot-mcu': mcu,
  'iot-sbc': sbc,
  'iot-lamp': lamp,
  'iot-fan': fan,
  'iot-door': door,
  'iot-window': windowModel,
  'iot-motion': motion,
  'iot-smoke': smoke,
  'iot-siren': siren,
  'iot-thermostat': thermostat,
  'iot-webcam': webcam,
  'iot-thing': thing,
};
