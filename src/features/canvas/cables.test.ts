import { describe, expect, it } from 'vitest';
import { deviceSpec } from '@/devices/create';
import type { DeviceModelId } from '@/devices/catalog';
import { PortId, type DeviceId } from '@/model';
import { createEditorStore } from '@/model/store';
import { expectOk } from '@/model/testing';
import {
  autoCable,
  describeCableError,
  onlyPort,
  planLink,
  planQuickCable,
  portOptions,
  type PortEnd,
} from './cables';

const port = (name: string) => PortId.parse(name);

function lab(...models: DeviceModelId[]) {
  const editor = createEditorStore();
  const ids = models.map((model, i) => {
    const names = Object.values(editor.getState().topology.devices).map((d) => d.config.hostname);
    const spec = deviceSpec(model, { position: { x: i * 100, y: 0 }, existingNames: names });
    return expectOk(editor.getState().addDevice(spec));
  });
  return { editor, ids, topology: () => editor.getState().topology };
}

describe('autoCable', () => {
  const end = (device: PortEnd['device'], portKind: PortEnd['port'] = 'fastEthernet'): PortEnd => ({
    device,
    port: portKind,
  });

  it.each([
    ['pc', 'switch', 'straight'],
    ['server', 'switch', 'straight'],
    ['router', 'switch', 'straight'],
    ['switch', 'router', 'straight'],
    ['switch', 'switch', 'crossover'],
    ['router', 'router', 'crossover'],
    ['pc', 'router', 'crossover'],
    ['pc', 'pc', 'crossover'],
  ] as const)('connects a %s to a %s with %s', (a, b, cable) => {
    expect(autoCable(end(a), end(b))).toBe(cable);
  });

  it('uses serial between serial ports and refuses to mix serial with copper', () => {
    expect(autoCable(end('router', 'serial'), end('router', 'serial'))).toBe('serial');
    expect(autoCable(end('router', 'serial'), end('router', 'gigabitEthernet'))).toBeUndefined();
  });

  it('uses a console cable from RS-232 to Console, and never between two of a kind', () => {
    expect(autoCable(end('pc', 'rs232'), end('router', 'console'))).toBe('console');
    expect(autoCable(end('switch', 'console'), end('pc', 'rs232'))).toBe('console');
    expect(autoCable(end('router', 'console'), end('switch', 'console'))).toBeUndefined();
    expect(autoCable(end('pc', 'rs232'), end('switch', 'fastEthernet'))).toBeUndefined();
  });
});

describe('portOptions', () => {
  it('lists free ports first and names the far end of used ones', () => {
    const { editor, ids, topology } = lab('router-2g2s', 'switch-24');
    const [router, sw] = ids as [DeviceId, DeviceId];
    expectOk(
      editor.getState().addLink({
        cable: 'straight',
        a: { device: router, port: port('GigabitEthernet0/0') },
        b: { device: sw, port: port('FastEthernet0/1') },
      }),
    );

    expect(portOptions(topology(), router, undefined)).toEqual([
      { id: 'GigabitEthernet0/1', kind: 'gigabitEthernet', short: 'Gi0/1', status: 'free' },
      { id: 'Serial0/0/0', kind: 'serial', short: 'Se0/0/0', status: 'free' },
      { id: 'Serial0/0/1', kind: 'serial', short: 'Se0/0/1', status: 'free' },
      { id: 'Console', kind: 'console', short: 'Console', status: 'free' },
      {
        id: 'GigabitEthernet0/0',
        kind: 'gigabitEthernet',
        short: 'Gi0/0',
        status: 'used',
        peer: 'Switch0 Fa0/1',
      },
    ]);
  });

  it('marks ports the cable cannot reach as incompatible', () => {
    const { ids, topology } = lab('router-2g2s');
    const [router] = ids as [DeviceId];

    const options = portOptions(topology(), router, 'serial');
    expect(options.map(({ short, status }) => [short, status])).toEqual([
      ['Se0/0/0', 'free'],
      ['Se0/0/1', 'free'],
      ['Gi0/0', 'incompatible'],
      ['Gi0/1', 'incompatible'],
      ['Console', 'incompatible'],
    ]);
  });

  it('skips the picker only for a device with one suitable port, and only while it is free', () => {
    const { editor, ids, topology } = lab('pc', 'router-2g2s', 'switch-24');
    const [pc, router, sw] = ids as [DeviceId, DeviceId, DeviceId];

    expect(onlyPort(topology(), pc, undefined)).toBe('FastEthernet0');
    expect(onlyPort(topology(), router, undefined)).toBeUndefined();
    expect(onlyPort(topology(), router, 'serial')).toBeUndefined();

    expectOk(
      editor.getState().addLink({
        cable: 'straight',
        a: { device: pc, port: port('FastEthernet0') },
        b: { device: sw, port: port('FastEthernet0/1') },
      }),
    );
    expect(onlyPort(topology(), pc, undefined)).toBeUndefined();
  });
});

describe('console cables', () => {
  it('picks the only port of each end for a console cable', () => {
    const { ids, topology } = lab('pc', 'router-2g2s');
    const [pc, router] = ids as [DeviceId, DeviceId];
    expect(onlyPort(topology(), pc, 'console')).toBe('RS232');
    expect(onlyPort(topology(), router, 'console')).toBe('Console');
  });

  it('plans a console link a store accepts, and refuses one between two Console ports', () => {
    const { editor, ids, topology } = lab('pc', 'router-2g2s', 'switch-24');
    const [pc, router, sw] = ids as [DeviceId, DeviceId, DeviceId];
    const a = { device: pc, port: port('RS232') };
    const b = { device: router, port: port('Console') };
    const plan = planLink(topology(), 'console', a, b);
    expect(plan).toEqual({ ok: true, value: { cable: 'console', a, b } });
    expectOk(editor.getState().addLink(expectOk(plan)));
    expect(portOptions(topology(), router, undefined).at(-1)).toMatchObject({
      id: 'Console',
      status: 'used',
      peer: 'PC0 RS232',
    });

    const twoConsoles = editor.getState().addLink({
      cable: 'console',
      a: { device: sw, port: port('Console') },
      b: { device: router, port: port('GigabitEthernet0/0') },
    });
    expect(twoConsoles).toMatchObject({ ok: false, error: { kind: 'cable-mismatch' } });
    const auto = planLink(topology(), 'auto', { device: sw, port: port('Console') }, b);
    expect(auto.ok).toBe(false);
    if (!auto.ok) {
      expect(describeCableError(topology(), auto.error)).toBe(
        "A console cable joins a PC's RS232 port to a router or switch's Console port.",
      );
    }
  });
});

describe('planLink', () => {
  it('makes the first end DCE on a serial link', () => {
    const { ids, topology } = lab('router-2g2s', 'router-2g2s');
    const [r0, r1] = ids as [DeviceId, DeviceId];
    const a = { device: r0, port: port('Serial0/0/0') };
    const b = { device: r1, port: port('Serial0/0/1') };

    expect(planLink(topology(), 'auto', a, b)).toEqual({
      ok: true,
      value: { cable: 'serial', a, b, dce: 'a' },
    });
  });

  it('rejects a cable that starts and ends on the same device', () => {
    const { ids, topology } = lab('router-4g');
    const [router] = ids as [DeviceId];
    const plan = planLink(
      topology(),
      'auto',
      { device: router, port: port('GigabitEthernet0/0') },
      { device: router, port: port('GigabitEthernet0/1') },
    );
    expect(plan).toMatchObject({ ok: false, error: { kind: 'same-device' } });
  });
});

describe('planQuickCable', () => {
  const cable = (
    editor: ReturnType<typeof lab>['editor'],
    [a, aPort]: [DeviceId, string],
    [b, bPort]: [DeviceId, string],
  ) =>
    expectOk(
      editor.getState().addLink({
        cable: 'straight',
        a: { device: a, port: port(aPort) },
        b: { device: b, port: port(bPort) },
      }),
    );

  it('joins the first free port on the first device to the first compatible one on the second', () => {
    const { editor, ids, topology } = lab('router-2g2s', 'switch-24');
    const [router, sw] = ids as [DeviceId, DeviceId];
    expect(planQuickCable(topology(), router, sw)).toEqual({
      ok: true,
      value: {
        cable: 'straight',
        a: { device: router, port: port('GigabitEthernet0/0') },
        b: { device: sw, port: port('FastEthernet0/1') },
      },
    });
    cable(editor, [router, 'GigabitEthernet0/0'], [sw, 'FastEthernet0/1']);
    expect(planQuickCable(topology(), sw, router)).toMatchObject({
      ok: true,
      value: {
        a: { device: sw, port: port('FastEthernet0/2') },
        b: { device: router, port: port('GigabitEthernet0/1') },
      },
    });
  });

  it('falls through to serial when the copper ports are taken, with the first end as DCE', () => {
    const { editor, ids, topology } = lab('router-2g2s', 'router-2g2s', 'switch-24');
    const [r0, r1, sw] = ids as [DeviceId, DeviceId, DeviceId];
    cable(editor, [r0, 'GigabitEthernet0/0'], [sw, 'FastEthernet0/1']);
    cable(editor, [r0, 'GigabitEthernet0/1'], [sw, 'FastEthernet0/2']);
    expect(planQuickCable(topology(), r0, r1)).toEqual({
      ok: true,
      value: {
        cable: 'serial',
        dce: 'a',
        a: { device: r0, port: port('Serial0/0/0') },
        b: { device: r1, port: port('Serial0/0/0') },
      },
    });
  });

  it('refuses the same device, a device with no free port and ports that share no medium', () => {
    const { editor, ids, topology } = lab('pc', 'pc', 'router-2g2s', 'switch-24');
    const [pc0, pc1, router, sw] = ids as [DeviceId, DeviceId, DeviceId, DeviceId];
    expect(planQuickCable(topology(), pc0, pc0)).toEqual({
      ok: false,
      error: { kind: 'same-device', device: pc0 },
    });
    cable(editor, [pc0, 'FastEthernet0'], [sw, 'FastEthernet0/1']);
    expect(planQuickCable(topology(), pc0, pc1)).toEqual({
      ok: false,
      error: { kind: 'no-free-port', device: pc0 },
    });
    cable(editor, [router, 'GigabitEthernet0/0'], [sw, 'FastEthernet0/2']);
    cable(editor, [router, 'GigabitEthernet0/1'], [sw, 'FastEthernet0/3']);
    const error = { kind: 'no-shared-medium', a: router, b: pc1 } as const;
    expect(planQuickCable(topology(), router, pc1)).toEqual({ ok: false, error });
    expect(describeCableError(topology(), error)).toBe(
      'Router0 and PC1 have no free ports that take the same cable.',
    );
  });
});
