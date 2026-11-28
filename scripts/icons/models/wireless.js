// Access points, controllers, home routers and the carrier's side of the network.
import { box, cone, cylinder, group, mesh, slab, sphere, THREE, torus } from '../renderer.js';
import { antenna, chassis, leds, ports } from './parts.js';

/** Wi-Fi arcs lying flat on a surface at height `y`, opening towards the viewer. */
function arcs(parent, look, { x = 0, y, z = 0, scale = 1 }) {
  const fan = group(parent, [x, y, z], [-Math.PI / 2, 0, Math.PI / 4]);
  for (const [i, radius] of [0.28, 0.52, 0.76].entries()) {
    torus(fan, radius * scale, 0.07 * scale, [0, 0, 0], look.accent, [0, 0, 0], Math.PI / 2);
    if (i === 0) sphere(fan, 0.1 * scale, [0, 0, 0], look.accent);
  }
  return fan;
}

const accessPoint = {
  size: 'small',
  build(look) {
    const model = group();
    cylinder(model, 1.2, 0.3, [0, 0.15, 0], look.shell, undefined, 48);
    cylinder(model, 1.0, 0.12, [0, 0.36, 0], look.trim, undefined, 48);
    torus(model, 0.45, 0.07, [0, 0.43, 0], look.accentGlow, [Math.PI / 2, 0, 0]);
    for (const x of [-0.8, 0.8]) {
      antenna(model, look, {
        x,
        y: 0.25,
        z: -0.85,
        height: 0.7,
        tilt: -x * 0.25,
        material: look.slate,
      });
    }
    return model;
  },
};

const lightweightAp = {
  size: 'small',
  build(look) {
    const model = group();
    slab(model, [1.5, 0.12, 1.5], [0, 0, 0], look.grey, 0.04);
    slab(model, [2.0, 0.38, 2.0], [0, 0.12, 0], look.shell, 0.3);
    slab(model, [1.4, 0.06, 1.4], [0, 0.48, 0], look.trim, 0.25);
    cylinder(model, 0.2, 0.06, [0, 0.55, 0], look.accentGlow);
    return model;
  },
};

const wlc = {
  size: 'medium',
  build(look) {
    const model = group();
    const front = chassis(model, look, {
      width: 3.0,
      height: 0.8,
      depth: 2.0,
      face: look.charcoal,
    });
    ports(model, look, { count: 6, x: 0.4, y: 0.4, z: front, pitch: 0.3 });
    leds(model, look, { count: 2, x: -1.05, y: 0.4, z: front, pitch: 0.2 });
    arcs(model, look, { x: -0.35, y: 0.82, z: 0.35, scale: 1.05 });
    return model;
  },
};

const wirelessRouter = {
  size: 'medium',
  build(look) {
    const model = group();
    slab(model, [2.5, 0.55, 1.7], [0, 0.05, 0], look.shell, 0.22);
    box(model, [2.0, 0.06, 1.1], [0, 0.6, 0.1], look.accent, 0.04);
    box(model, [2.2, 0.2, 0.06], [0, 0.3, 0.84], look.trim, 0.04);
    leds(model, look, { count: 4, x: 0, y: 0.3, z: 0.88, pitch: 0.3 });
    for (const [x, tilt] of [
      [-1.0, 0.18],
      [0, 0],
      [1.0, -0.18],
    ]) {
      antenna(model, look, { x, y: 0.5, z: -0.72, height: 1.25, tilt });
    }
    return model;
  },
};

const homeGateway = {
  size: 'medium',
  build(look) {
    const model = group();
    slab(model, [1.5, 1.5, 1.5], [0, 0, 0], look.shell, 0.12);
    // A gabled roof: a triangular prism along z.
    const roof = mesh(
      model,
      new THREE.CylinderGeometry(1.05, 1.05, 1.7, 3),
      look.accent,
      [0, 1.5 + 0.52, 0],
      [Math.PI / 2, 0, 0],
    );
    roof.rotation.order = 'XZY';
    roof.rotation.set(Math.PI / 2, Math.PI, 0);
    box(model, [0.42, 0.7, 0.06], [-0.3, 0.45, 0.76], look.charcoal, 0.04);
    leds(model, look, { count: 3, x: 0.35, y: 1.1, z: 0.77, pitch: 0.18 });
    box(model, [0.42, 0.3, 0.06], [0.35, 0.6, 0.76], look.black, 0.03);
    return model;
  },
};

const cellTower = {
  size: 'large',
  build(look) {
    const model = group();
    slab(model, [1.9, 0.25, 1.9], [0, 0, 0], look.grey, 0.06);
    const base = 0.68;
    const top = 0.22;
    const height = 3.4;
    // Four legs lean in to the top; rings brace them.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const from = new THREE.Vector3(sx * base, 0.25, sz * base);
        const to = new THREE.Vector3(sx * top, 0.25 + height, sz * top);
        const leg = cylinder(
          model,
          0.06,
          from.distanceTo(to),
          [0, 0, 0],
          look.slate,
          undefined,
          10,
        );
        leg.position.copy(from).add(to).multiplyScalar(0.5);
        leg.quaternion.setFromUnitVectors(
          new THREE.Vector3(0, 1, 0),
          to.clone().sub(from).normalize(),
        );
      }
    }
    for (const t of [0.22, 0.48, 0.74]) {
      const half = base + (top - base) * t;
      const y = 0.25 + height * t;
      for (const [w, d] of [
        [2 * half, 0.07],
        [0.07, 2 * half],
      ]) {
        for (const s of [-1, 1]) {
          const z = w > d ? s * half : 0;
          const x = w > d ? 0 : s * half;
          box(model, [w, 0.07, d], [x, y, z], look.slate, 0.02);
        }
      }
    }
    // Panel antennas round the head, and a beacon on top.
    for (const angle of [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3]) {
      const panel = group(model, [0, 3.1, 0], [0, angle + Math.PI / 6, 0]);
      box(panel, [0.36, 0.95, 0.14], [0, 0, 0.42], look.shell, 0.05);
    }
    cylinder(model, 0.06, 0.4, [0, 3.85, 0], look.slate, undefined, 10);
    sphere(model, 0.14, [0, 4.1, 0], look.accent);
    return model;
  },
};

const centralOffice = {
  size: 'large',
  build(look) {
    const model = group();
    slab(model, [2.8, 2.2, 2.2], [0, 0, 0], look.shell, 0.08);
    slab(model, [2.9, 0.16, 2.3], [0, 2.2, 0], look.trim, 0.04);
    // Windows on the front and the side, and an accent door.
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 4; c++) {
        if (r === 0 && (c === 1 || c === 2)) continue;
        box(model, [0.4, 0.38, 0.06], [-1.0 + c * 0.66, 0.45 + r * 0.6, 1.11], look.screen, 0.03);
      }
      for (let c = 0; c < 3; c++) {
        box(model, [0.06, 0.38, 0.4], [1.41, 0.45 + r * 0.6, -0.65 + c * 0.65], look.screen, 0.03);
      }
    }
    box(model, [0.9, 0.62, 0.08], [0, 0.31, 1.12], look.accent, 0.03);
    // A rooftop mast with a dish.
    cylinder(model, 0.05, 0.9, [-0.7, 2.81, -0.5], look.slate, undefined, 10);
    const dish = group(model, [0.6, 2.62, -0.4], [-0.6, 0.6, 0]);
    cone(dish, 0.38, 0.08, 0.22, [0, 0.12, 0], look.trim);
    slab(model, [0.6, 0.28, 0.6], [0.6, 2.36, -0.4], look.grey, 0.04);
    return model;
  },
};

export const MODELS = {
  'access-point': accessPoint,
  'lightweight-ap': lightweightAp,
  wlc,
  'wireless-router': wirelessRouter,
  'home-gateway': homeGateway,
  'cell-tower': cellTower,
  'central-office': centralOffice,
};
