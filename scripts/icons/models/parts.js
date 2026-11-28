// Parts that several models share. Units are loose: a 1U chassis is about 3 wide. Fronts face +z.
import { box, cylinder, group, slab, sphere } from '../renderer.js';

/** A row of `count` boxes along x on a front face at depth `z`, centred on `x`. */
export function row(parent, { count, pitch, size, x = 0, y, z, material, radius = 0.02 }) {
  for (let i = 0; i < count; i++) {
    box(parent, size, [x + (i - (count - 1) / 2) * pitch, y, z], material, radius);
  }
}

/** RJ45 sockets: dark mouths a touch proud of the face so the ink frames each one. */
export function ports(parent, look, { count, x = 0, y, z, pitch = 0.27, rows = 1, gap = 0.22 }) {
  for (let r = 0; r < rows; r++) {
    row(parent, {
      count,
      pitch,
      size: [pitch * 0.74, 0.15, 0.06],
      x,
      y: y - r * gap,
      z,
      material: look.black,
    });
  }
}

/** Status lights: small accent studs. */
export function leds(
  parent,
  look,
  { count, x = 0, y, z, pitch = 0.16, material = look.accentGlow },
) {
  row(parent, { count, pitch, size: [0.09, 0.09, 0.05], x, y, z, material, radius: 0.03 });
}

/**
 * A rack chassis: an off-white case with a darker faceplate across its front. Returns the
 * faceplate's front depth so details can sit on it.
 */
export function chassis(
  parent,
  look,
  { width, height, depth, body = look.shell, face = look.trim },
) {
  slab(parent, [width, height, depth], [0, 0, 0], body, 0.09);
  const plate = 0.08;
  box(parent, [width - 0.1, height - 0.1, plate], [0, height / 2, depth / 2], face, 0.04);
  // Rack ears.
  for (const side of [-1, 1]) {
    box(
      parent,
      [0.12, height - 0.04, 0.12],
      [side * (width / 2 + 0.03), height / 2, depth / 2 - 0.02],
      look.grey,
      0.03,
    );
  }
  return depth / 2 + plate / 2;
}

/** A whip antenna standing on a hinge block. */
export function antenna(
  parent,
  look,
  { x, y, z, height = 1.1, tilt = 0, material = look.charcoal },
) {
  const mount = group(parent, [x, y, z], [0, 0, tilt]);
  box(mount, [0.2, 0.16, 0.2], [0, 0.08, 0], material, 0.04);
  cylinder(mount, 0.075, height, [0, 0.16 + height / 2, 0], material, undefined, 16);
  sphere(mount, 0.075, [0, 0.16 + height, 0], material);
  return mount;
}

/** A screen in a bezel, facing +z, centred on `[x, y]`, with its front at `z`. */
export function screen(
  parent,
  look,
  { width, height, x = 0, y, z, bezel = 0.1, frame = look.charcoal },
) {
  box(parent, [width, height, 0.12], [x, y, z - 0.06], frame, 0.06);
  box(parent, [width - 2 * bezel, height - 2 * bezel, 0.04], [x, y, z], look.screen, 0.03);
}

/** Feet under a case: four short dark pads. */
export function feet(parent, look, { width, depth, size = 0.18 }) {
  for (const x of [-1, 1]) {
    for (const z of [-1, 1]) {
      box(
        parent,
        [size, 0.06, size],
        [x * (width / 2 - size), 0.03, z * (depth / 2 - size)],
        look.charcoal,
        0.02,
      );
    }
  }
}
