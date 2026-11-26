import {
  createDevice,
  createIdSource,
  emptyTopology,
  Hostname,
  PortId,
  type PortSpec,
} from '../../model';
import { createEditorStore } from '../../model/store';
import type { IosDevice, RouterDevice, SwitchDevice } from './context';
import { openConsole } from './session';

const KIND_BY_PREFIX: Record<string, PortSpec['kind']> = {
  FastEthernet: 'fastEthernet',
  GigabitEthernet: 'gigabitEthernet',
  Serial: 'serial',
};

function ports(names: readonly string[]): PortSpec[] {
  return names.map((name) => {
    const kind = KIND_BY_PREFIX[/^[A-Za-z]+/.exec(name)?.[0] ?? ''];
    if (!kind) throw new Error(`Unknown port type in ${name}`);
    return { kind, id: PortId.parse(name) };
  });
}

function make(kind: 'router' | 'switch', hostname: string, names: readonly string[]): IosDevice {
  const device = createDevice(
    {
      kind,
      model: `${kind}-test`,
      hostname: Hostname.parse(hostname),
      position: { x: 0, y: 0 },
      ports: ports(names),
    },
    { ids: createIdSource(7), topology: emptyTopology({ name: 'Test', now: new Date(0) }) },
  );
  if (device.kind !== kind) throw new Error('createDevice returned the wrong kind');
  return device as IosDevice;
}

export const ROUTER_PORTS = [
  'GigabitEthernet0/0',
  'GigabitEthernet0/1',
  'Serial0/0/0',
  'Serial0/0/1',
];
export const SWITCH_PORTS = [
  ...Array.from({ length: 24 }, (_, i) => `FastEthernet0/${i + 1}`),
  'GigabitEthernet0/1',
  'GigabitEthernet0/2',
];

export function router(names: readonly string[] = ROUTER_PORTS, hostname = 'Router'): RouterDevice {
  return make('router', hostname, names) as RouterDevice;
}

export function switchDevice(
  names: readonly string[] = SWITCH_PORTS,
  hostname = 'Switch',
): SwitchDevice {
  return make('switch', hostname, names) as SwitchDevice;
}

/** A switch of the catalog's multilayer model, which takes `ip routing` and routed ports. */
export function multilayerSwitch(hostname = 'Switch'): SwitchDevice {
  return { ...switchDevice(SWITCH_PORTS, hostname), model: 'switch-l3-24' };
}

/**
 * A console on a device in an editor store, wired the way the terminal binds: each line reads the
 * device from the store and commits the session's update with `updateConfig`.
 */
export function consoleOn<D extends IosDevice>(device: D) {
  const store = createEditorStore({
    topology: {
      ...emptyTopology({ name: 'Test', now: new Date(0) }),
      devices: { [device.id]: device },
    },
    ids: createIdSource(1),
  });
  const { session, greeting } = openConsole(device);
  const current = () => store.getState().topology.devices[device.id] as D;
  return {
    store,
    session,
    greeting,
    get device() {
      return current();
    },
    get prompt() {
      return session.prompt(current());
    },
    run(line: string): readonly string[] {
      const { output, update } = session.run(current(), line);
      if (update) {
        const committed = store.getState().updateConfig(update);
        if (!committed.ok)
          throw new Error(`Store refused the update: ${JSON.stringify(committed.error)}`);
      }
      return output;
    },
    runAll(lines: readonly string[]): readonly string[] {
      return lines.flatMap((line) => this.run(line));
    },
  };
}
