import { describe, expect, it } from 'vitest';
import type { DeviceId } from '@/model';
import { alignMoves, distributeMoves } from './arrange';

const at = (device: string, x: number, y: number) => ({
  device: device as DeviceId,
  position: { x, y },
});

const devices = [at('dev_a', 0, 40), at('dev_b', 100, 0), at('dev_c', 300, 200)];

describe('alignMoves', () => {
  it.each([
    ['left', { x: 0 }, ['dev_b', 'dev_c']],
    ['centre', { x: 150 }, ['dev_a', 'dev_b', 'dev_c']],
    ['right', { x: 300 }, ['dev_a', 'dev_b']],
    ['top', { y: 0 }, ['dev_a', 'dev_c']],
    ['middle', { y: 100 }, ['dev_a', 'dev_b', 'dev_c']],
    ['bottom', { y: 200 }, ['dev_a', 'dev_b']],
  ] as const)('aligns %s and moves only devices that are not there yet', (edge, line, moved) => {
    const moves = alignMoves(devices, edge);
    expect(moves.map((m) => m.device)).toEqual(moved);
    for (const move of moves) expect(move.position).toMatchObject(line);
  });

  it('keeps the other coordinate', () => {
    expect(alignMoves(devices, 'left')).toEqual([
      { device: 'dev_b', position: { x: 0, y: 0 } },
      { device: 'dev_c', position: { x: 0, y: 200 } },
    ]);
  });

  it('needs two devices', () => {
    expect(alignMoves([at('dev_a', 5, 5)], 'left')).toEqual([]);
  });
});

describe('distributeMoves', () => {
  it('spaces devices evenly between the outermost two, in their current order', () => {
    const row = [at('dev_a', 0, 0), at('dev_d', 400, 0), at('dev_b', 50, 0), at('dev_c', 390, 0)];
    expect(distributeMoves(row, 'horizontal')).toEqual([
      { device: 'dev_b', position: { x: 400 / 3, y: 0 } },
      { device: 'dev_c', position: { x: 800 / 3, y: 0 } },
    ]);
  });

  it('distributes vertically', () => {
    expect(distributeMoves(devices, 'vertical')).toEqual([
      { device: 'dev_a', position: { x: 0, y: 100 } },
    ]);
  });

  it('keeps devices that share a coordinate in selection order', () => {
    const stack = [at('dev_a', 0, 0), at('dev_b', 0, 10), at('dev_c', 0, 0), at('dev_d', 30, 0)];
    expect(distributeMoves(stack, 'horizontal')).toEqual([
      { device: 'dev_b', position: { x: 10, y: 10 } },
      { device: 'dev_c', position: { x: 20, y: 0 } },
    ]);
  });

  it('needs three devices', () => {
    expect(distributeMoves(devices.slice(0, 2), 'horizontal')).toEqual([]);
  });
});
