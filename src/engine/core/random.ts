/** One draw from mulberry32: the number it gives, in [0, 1), and the generator's next state. */
export function drawRandom(state: number): { value: number; state: number } {
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return { value: ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000, state: next };
}

/** A small seeded generator of numbers in [0, 1). The same seed gives the same stream. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    const draw = drawRandom(state);
    state = draw.state;
    return draw.value;
  };
}
