// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createIdSource, PortId, type RouterConfig } from '@/model';
import { createEditorStore } from '@/model/store';
import { buildLab } from '@/model/testing';
import { createVtyRegistry } from '@/features/terminal/remote';
import { createConsoleCables } from './consoleCable';

const SIZE = { cols: 80, rows: 24 };

function setup() {
  const lab = buildLab();
  const store = createEditorStore({ topology: lab.topology, ids: createIdSource(5) });
  const cables = createConsoleCables(store, undefined, createVtyRegistry());
  const plug = () =>
    store.getState().addLink({
      cable: 'console',
      a: { device: lab.pc.id, port: PortId.parse('RS232') },
      b: { device: lab.r1.id, port: PortId.parse('Console') },
    });
  return { ...lab, store, cables, plug };
}

describe("a PC's Terminal app", () => {
  it('says there is no console cable until one is in', () => {
    const { pc, cables, plug } = setup();
    expect(cables.connect(pc.id)).toEqual({ kind: 'no-cable' });
    plug();
    expect(cables.connect(pc.id)).toMatchObject({ kind: 'open' });
  });

  it("asks for the console line's password, and keeps the session while the cable stays", () => {
    const { pc, r1, store, cables, plug } = setup();
    const config = store.getState().topology.devices[r1.id]!.config as RouterConfig;
    store.getState().updateConfig({
      device: r1.id,
      kind: 'router',
      config: {
        ...config,
        lines: {
          ...config.lines,
          console: { ...config.lines.console, password: 'cisco', login: 'password' },
        },
      },
    });
    plug();
    const reach = cables.connect(pc.id);
    if (reach.kind !== 'open') throw new Error(reach.kind);
    expect(reach.tty.transcript).toBe('\r\nUser Access Verification\r\n\r\nPassword: ');
    reach.tty.input('cisco\r', SIZE);
    expect(reach.tty.transcript).toContain('Password: \r\nR1>');
    expect(cables.connect(pc.id)).toEqual(reach);
  });

  it('says when the far end is off', () => {
    const { pc, r1, store, cables, plug } = setup();
    plug();
    store.getState().setPowered({ device: r1.id, powered: false });
    expect(cables.connect(pc.id)).toEqual({ kind: 'off', hostname: 'R1' });
  });
});
