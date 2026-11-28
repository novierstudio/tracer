// The stroked-toon look from isom3trics (https://github.com/sloemo01/isom3trics, MIT, sloemo01),
// adapted to render still sprites: toon surfaces lit through a four-step ramp, then warm charcoal
// ink wherever view-space normals or depth break. Each sprite renders at SUPERSAMPLE times its
// size and is halved down, so the ink stays a crisp, even line at 96 px.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const SUPERSAMPLE = 4;
const INK = 0x34312d;
// Ink width as a share of the sprite's side: 1.4 px on the 96 px sprite, 2.8 px at 2x.
const STROKE = 1.4 / 96;
// The camera: orthographic, from the front right, at the 2:1 isometric of pixel art.
const AZIMUTH = 36;
const ELEVATION = 30;

/** Half the side of the square view, in model units. A class shares one scale across models. */
export const SIZE_CLASSES = { large: 2.35, medium: 2.0, small: 1.6 };

/** The colour family: warm off-whites, mid greys and charcoal, with Tracer's accent. */
export const COLORS = {
  shell: '#efebe3',
  trim: '#dcd5c7',
  grey: '#aaa69e',
  steel: '#c4c6c8',
  slate: '#77746e',
  charcoal: '#45433f',
  black: '#2e2d2b',
  accent: '#5b5bd6',
  accentLight: '#9a9bf0',
  screen: '#c3c5f3',
  glass: '#d9e6ee',
  glow: '#ffe7a8',
};

function toonRamp(bands = [96, 150, 208, 255]) {
  const ramp = new THREE.DataTexture(new Uint8Array(bands), 4, 1, THREE.RedFormat);
  ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
  ramp.generateMipmaps = false;
  ramp.needsUpdate = true;
  return ramp;
}

const quadVertex = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// One-texel discontinuities in normal and depth, weighted per material by the ink pass.
const edgeShader = /* glsl */ `
  uniform sampler2D tNormal;
  uniform sampler2D tDepth;
  uniform sampler2D tInk;
  uniform vec2 texel;
  varying vec2 vUv;
  void main() {
    float d = texture2D(tDepth, vUv).r;
    vec4 normal = texture2D(tNormal, vUv);
    vec3 n = normal.rgb * 2.0 - 1.0;
    float a = normal.a;
    vec3 attributes = texture2D(tInk, vUv).rgb;
    if (a < 0.5 || attributes.r < 0.001) discard;
    float edge = 0.0;
    for (int i = 0; i < 8; i++) {
      float angle = float(i) * 0.78539816339;
      vec2 uv = vUv + vec2(cos(angle), sin(angle)) * texel;
      float nd = texture2D(tDepth, uv).r;
      vec4 other = texture2D(tNormal, uv);
      vec3 nn = other.rgb * 2.0 - 1.0;
      float na = other.a;
      float neighborWeight = texture2D(tInk, uv).r;
      float depthEdge = smoothstep(0.0004, 0.0014, max(0.0, d - nd)) * attributes.g;
      float normalEdge = (1.0 - smoothstep(0.4, 0.76, dot(n, nn))) * min(a, na) * attributes.b;
      float silhouette = abs(a - na) * step(0.5, a + na);
      float pairWeight = min(attributes.r, na > 0.5 ? neighborWeight : 1.0);
      edge = max(edge, max(depthEdge * min(a, na), max(normalEdge, silhouette)) * pairWeight);
    }
    gl_FragColor = vec4(vec3(edge), 1.0);
  }
`;

// Widens the one-texel mask to the stroke, then inks the premultiplied colour under it.
const compositeShader = /* glsl */ `
  uniform sampler2D tColor;
  uniform sampler2D tEdge;
  uniform vec3 ink;
  uniform vec2 texel;
  uniform float radius;
  varying vec2 vUv;
  void main() {
    vec4 surface = texture2D(tColor, vUv);
    float amount = 0.0;
    for (int x = -8; x <= 8; x++) {
      for (int y = -8; y <= 8; y++) {
        vec2 offset = vec2(float(x), float(y));
        float reach = length(offset);
        if (reach > radius + 0.5) continue;
        float coverage = clamp(radius + 0.5 - reach, 0.0, 1.0);
        amount = max(amount, texture2D(tEdge, vUv + offset * texel).r * coverage);
      }
    }
    vec3 linear = mix(surface.rgb, ink * surface.a, clamp(amount, 0.0, 1.0) * 0.9);
    gl_FragColor = vec4(linear, surface.a);
    #include <colorspace_fragment>
  }
`;

/** Toon and flat materials that carry their own ink settings, as isom3trics' `look` does. */
function createLook(ramp) {
  function material(
    type,
    color,
    { outline = true, stroke = 1, depth = 1, normal = 1, ...options },
  ) {
    const extra = type === THREE.MeshToonMaterial ? { gradientMap: ramp } : {};
    const result = new type({ color, ...extra, ...options });
    result.userData.ink = { visible: outline, weight: stroke, depth, normal };
    return result;
  }
  const cache = new Map();
  const toon = (color, options = {}) => {
    const key = `toon:${color}:${JSON.stringify(options)}`;
    if (!cache.has(key)) cache.set(key, material(THREE.MeshToonMaterial, color, options));
    return cache.get(key);
  };
  const flat = (color, options = {}) => {
    const key = `flat:${color}:${JSON.stringify(options)}`;
    if (!cache.has(key)) {
      cache.set(
        key,
        material(THREE.MeshBasicMaterial, color, {
          outline: true,
          depth: 1,
          normal: 0,
          ...options,
        }),
      );
    }
    return cache.get(key);
  };
  const palette = Object.fromEntries(
    Object.entries(COLORS).map(([name, hex]) => [name, toon(hex)]),
  );
  palette.screen = flat(COLORS.screen);
  palette.glow = flat(COLORS.glow);
  palette.accentGlow = flat(COLORS.accentLight);
  return { toon, flat, ...palette };
}

export function createSpriteRenderer() {
  const canvas = document.createElement('canvas');
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const ramp = toonRamp();
  const look = createLook(ramp);
  const colorTarget = new THREE.WebGLRenderTarget(1, 1, { samples: 4 });
  const normalTarget = new THREE.WebGLRenderTarget(1, 1, { samples: 4 });
  normalTarget.depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
  const inkTarget = new THREE.WebGLRenderTarget(1, 1);
  inkTarget.depthTexture = normalTarget.depthTexture;
  const edgeTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
  const normalMaterial = new THREE.MeshNormalMaterial();
  const inkMaterial = new THREE.ShaderMaterial({
    vertexShader:
      'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader:
      'uniform vec3 attributes; void main() { gl_FragColor = vec4(attributes, 1.0); }',
    uniforms: { attributes: { value: new THREE.Vector3(1, 1, 1) } },
  });
  const edgeMaterial = new THREE.ShaderMaterial({
    vertexShader: quadVertex,
    fragmentShader: edgeShader,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      tNormal: { value: normalTarget.texture },
      tDepth: { value: normalTarget.depthTexture },
      tInk: { value: inkTarget.texture },
      texel: { value: new THREE.Vector2() },
    },
  });
  const compositeMaterial = new THREE.ShaderMaterial({
    vertexShader: quadVertex,
    fragmentShader: compositeShader,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      tColor: { value: colorTarget.texture },
      tEdge: { value: edgeTarget.texture },
      ink: { value: new THREE.Color(INK) },
      texel: { value: new THREE.Vector2() },
      radius: { value: 1 },
    },
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), edgeMaterial);
  const passScene = new THREE.Scene();
  passScene.add(quad);
  const passCamera = new THREE.Camera();

  function lights(scene) {
    scene.add(new THREE.HemisphereLight(0xf7f5ee, 0x8f969c, 1.05));
    const key = new THREE.DirectionalLight(0xfff4e6, 1.45);
    key.position.set(-5, 10, 7);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, {
      left: -5,
      right: 5,
      top: 5,
      bottom: -5,
      near: 0.5,
      far: 40,
    });
    key.shadow.bias = -0.0002;
    key.shadow.normalBias = 0.02;
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xdce4f1, 0.5);
    fill.position.set(6, 5, -6);
    scene.add(fill);
  }

  function camera(model, half) {
    const a = THREE.MathUtils.degToRad(AZIMUTH);
    const e = THREE.MathUtils.degToRad(ELEVATION);
    const direction = new THREE.Vector3(
      Math.cos(e) * Math.sin(a),
      Math.sin(e),
      Math.cos(e) * Math.cos(a),
    );
    const right = new THREE.Vector3()
      .crossVectors(new THREE.Vector3(0, 1, 0), direction)
      .normalize();
    const up = new THREE.Vector3().crossVectors(direction, right);
    // Centre the projected bounds; the class, not the model, sets the scale.
    const bounds = new THREE.Box3().setFromObject(model);
    let [minX, maxX, minY, maxY] = [Infinity, -Infinity, Infinity, -Infinity];
    model.traverse((part) => {
      if (!part.isMesh) return;
      const position = part.geometry.attributes.position;
      const point = new THREE.Vector3();
      for (let i = 0; i < position.count; i++) {
        point.fromBufferAttribute(position, i).applyMatrix4(part.matrixWorld);
        const x = point.dot(right);
        const y = point.dot(up);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    });
    const centre = new THREE.Vector3()
      .addScaledVector(right, (minX + maxX) / 2)
      .addScaledVector(up, (minY + maxY) / 2);
    const depthCentre = bounds.getCenter(new THREE.Vector3()).dot(direction);
    centre.addScaledVector(direction, depthCentre);
    const view = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 100);
    view.position.copy(centre).addScaledVector(direction, 30);
    view.up.copy(up);
    view.lookAt(centre);
    view.updateProjectionMatrix();
    const fill = Math.max(maxX - minX, maxY - minY) / (2 * half);
    return { view, fill };
  }

  function draw(scene, view, size) {
    renderer.setSize(size, size, false);
    for (const target of [colorTarget, normalTarget, inkTarget, edgeTarget]) {
      target.setSize(size, size);
    }
    edgeMaterial.uniforms.texel.value.set(1 / size, 1 / size);
    compositeMaterial.uniforms.texel.value.set(1 / size, 1 / size);
    compositeMaterial.uniforms.radius.value = Math.max(0, (STROKE * size - 2) / 2);

    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(colorTarget);
    renderer.clear();
    renderer.render(scene, view);

    scene.overrideMaterial = normalMaterial;
    renderer.setRenderTarget(normalTarget);
    renderer.setClearColor(0x8080ff, 0);
    renderer.clear();
    renderer.render(scene, view);
    scene.overrideMaterial = null;

    const swaps = [];
    scene.traverse((part) => {
      if (!part.isMesh) return;
      const ink = part.material.userData.ink ?? { visible: true, weight: 1, depth: 1, normal: 1 };
      const override = inkMaterial.clone();
      override.uniforms.attributes.value.set(ink.visible ? ink.weight : 0, ink.depth, ink.normal);
      override.side = part.material.side;
      swaps.push([part, part.material, override]);
      part.material = override;
    });
    renderer.setRenderTarget(inkTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, view);
    for (const [part, original, override] of swaps) {
      part.material = original;
      override.dispose();
    }

    quad.material = edgeMaterial;
    renderer.setRenderTarget(edgeTarget);
    renderer.clear();
    renderer.render(passScene, passCamera);
    quad.material = compositeMaterial;
    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.render(passScene, passCamera);
  }

  /** Halve the supersampled frame down to the sprite: each step is an exact 2x2 box filter. */
  function downsample(size) {
    let source = canvas;
    let side = size * SUPERSAMPLE;
    while (side > size) {
      side /= 2;
      const step = document.createElement('canvas');
      step.width = step.height = side;
      const context = step.getContext('2d');
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(source, 0, 0, side, side);
      source = step;
    }
    return source;
  }

  /** Render one model to a square WebP with alpha. `fill` is the model's share of the frame. */
  function render(entry, size, { quality = 0.9 } = {}) {
    const scene = new THREE.Scene();
    lights(scene);
    const model = entry.build(look);
    // A model may be built small and grown to read at its class's scale.
    model.scale.setScalar(entry.scale ?? 1);
    scene.add(model);
    model.updateMatrixWorld(true);
    model.traverse((part) => {
      if (!part.isMesh) return;
      const extent = new THREE.Box3().setFromObject(part).getSize(new THREE.Vector3());
      // Tiny parts cast no blocks of shadow onto their neighbours.
      part.castShadow = Math.max(extent.x, extent.y, extent.z) > 0.5;
      part.receiveShadow = true;
    });
    const { view, fill } = camera(model, SIZE_CLASSES[entry.size]);
    draw(scene, view, size * SUPERSAMPLE);
    const sprite = downsample(size);
    model.traverse((part) => part.isMesh && part.geometry.dispose());
    return { dataUrl: sprite.toDataURL('image/webp', quality), fill };
  }

  return { render };
}

// Geometry helpers. Every model is built from these, front facing +z, standing on y = 0.

export function roundedBox(width, height, depth, radius = 0.06) {
  const r = Math.min(radius, width / 2.01, height / 2.01, depth / 2.01);
  return new RoundedBoxGeometry(width, height, depth, 3, Math.max(r, 0.001));
}

export function mesh(parent, geometry, material, position = [0, 0, 0], rotation = [0, 0, 0]) {
  const part = new THREE.Mesh(geometry, material);
  part.position.set(...position);
  part.rotation.set(...rotation);
  parent.add(part);
  return part;
}

/** A beveled box whose centre sits at `position`. */
export function box(parent, size, position, material, radius = 0.06, rotation) {
  return mesh(parent, roundedBox(...size, radius), material, position, rotation);
}

/** A box resting on y = `floor`, centred on x and z. */
export function slab(parent, [width, height, depth], [x, floor, z], material, radius = 0.06) {
  return box(parent, [width, height, depth], [x, floor + height / 2, z], material, radius);
}

export function cylinder(parent, radius, height, position, material, rotation, segments = 32) {
  const geometry = new THREE.CylinderGeometry(radius, radius, height, segments);
  return mesh(parent, geometry, material, position, rotation);
}

export function cone(parent, top, bottom, height, position, material, rotation, segments = 32) {
  const geometry = new THREE.CylinderGeometry(top, bottom, height, segments);
  return mesh(parent, geometry, material, position, rotation);
}

export function sphere(parent, radius, position, material, scale = [1, 1, 1]) {
  const part = mesh(parent, new THREE.SphereGeometry(radius, 32, 20), material, position);
  part.scale.set(...scale);
  return part;
}

export function torus(parent, radius, tubeRadius, position, material, rotation, arc = Math.PI * 2) {
  const geometry = new THREE.TorusGeometry(radius, tubeRadius, 12, 48, arc);
  return mesh(parent, geometry, material, position, rotation);
}

export function tube(parent, points, radius, material) {
  const curve = new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point)));
  return mesh(parent, new THREE.TubeGeometry(curve, 48, radius, 10, false), material);
}

export function group(parent, position = [0, 0, 0], rotation = [0, 0, 0]) {
  const result = new THREE.Group();
  result.position.set(...position);
  result.rotation.set(...rotation);
  parent?.add(result);
  return result;
}

export { THREE };
