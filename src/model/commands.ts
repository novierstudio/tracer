import { produce, type Draft } from 'immer';
import type { DeviceId, IdSource, LinkId } from './ids';
import { err, ok, type Result } from './result';
import {
  findDeviceProblem,
  findLinkProblem,
  type Device,
  type DeviceKind,
  type Link,
  type Point,
  type Port,
  type PortId,
  type RoutedInterface,
  type SwitchInterface,
  type Topology,
  type TopologyError,
} from './topology';
import { VlanId, type Hostname, type MacAddress } from './values';

export type CommandResult = Result<Topology, TopologyError>;

export function addDevice(topology: Topology, device: Device): CommandResult {
  if (device.id in topology.devices) return err({ kind: 'duplicate-id', id: device.id });
  const problem = findDeviceProblem(device);
  if (problem) return err(problem);
  return ok(putDevice(topology, device));
}

export function removeDevices(topology: Topology, ids: readonly DeviceId[]): Topology {
  const removed = new Set(ids);
  return produce(topology, (draft) => {
    for (const id of removed) delete draft.devices[id];
    for (const link of Object.values(topology.links)) {
      if (removed.has(link.a.device) || removed.has(link.b.device)) delete draft.links[link.id];
    }
  });
}

export type Move = { device: DeviceId; position: Point };

export function moveDevices(topology: Topology, moves: readonly Move[]): Topology {
  return produce(topology, (draft) => {
    for (const { device, position } of moves) {
      const target = draft.devices[device];
      if (target) target.position = position;
    }
  });
}

export function renameDevice(
  topology: Topology,
  { device, hostname }: { device: DeviceId; hostname: Hostname },
): CommandResult {
  return editDevice(topology, device, (draft) => {
    draft.config.hostname = hostname;
  });
}

export type ConfigUpdate = {
  [K in DeviceKind]: { device: DeviceId; kind: K; config: Extract<Device, { kind: K }>['config'] };
}[DeviceKind];

export function updateConfig(topology: Topology, update: ConfigUpdate): CommandResult {
  const current = topology.devices[update.device];
  if (!current) return err({ kind: 'device-not-found', device: update.device });

  const next = withConfig(current, update);
  if (!next) {
    return err({
      kind: 'device-kind-mismatch',
      device: update.device,
      expected: update.kind,
      actual: current.kind,
    });
  }
  const problem = findDeviceProblem(next);
  if (problem) return err(problem);
  return ok(putDevice(topology, next));
}

export function addLink(topology: Topology, link: Link): CommandResult {
  if (link.id in topology.links) return err({ kind: 'duplicate-id', id: link.id });
  const problem = findLinkProblem(topology, link);
  if (problem) return err(problem);
  return ok(
    produce(topology, (draft) => {
      draft.links[link.id] = link;
    }),
  );
}

export function removeLinks(topology: Topology, ids: readonly LinkId[]): Topology {
  return produce(topology, (draft) => {
    for (const id of ids) delete draft.links[id];
  });
}

export type PortSpec = Pick<Port, 'kind' | 'id'>;

export type DeviceSpec = {
  kind: DeviceKind;
  model: string;
  hostname: Hostname;
  position: Point;
  ports: readonly PortSpec[];
};

const DEFAULT_VLAN = VlanId.parse(1);

export function createDevice(
  spec: DeviceSpec,
  { ids, topology }: { ids: IdSource; topology: Topology },
): Device {
  let id = ids.deviceId();
  while (id in topology.devices) id = ids.deviceId();

  const takenMacs = new Set(
    Object.values(topology.devices).flatMap((device) =>
      device.ports.flatMap((port) => (port.kind === 'serial' ? [] : [port.mac])),
    ),
  );
  const freshMac = (): MacAddress => {
    let mac = ids.macAddress();
    while (takenMacs.has(mac)) mac = ids.macAddress();
    takenMacs.add(mac);
    return mac;
  };

  const ports = spec.ports.map((port): Port =>
    port.kind === 'serial'
      ? { kind: 'serial', id: port.id }
      : { kind: port.kind, id: port.id, mac: freshMac() },
  );
  const fields = { id, model: spec.model, position: spec.position, powered: true, ports };
  const { hostname } = spec;

  switch (spec.kind) {
    case 'router':
      return {
        ...fields,
        kind: 'router',
        config: {
          hostname,
          interfaces: Object.fromEntries(
            ports.map((port): [PortId, RoutedInterface] => [port.id, { shutdown: true }]),
          ),
          unknownLines: [],
        },
      };
    case 'switch':
      return {
        ...fields,
        kind: 'switch',
        config: {
          hostname,
          interfaces: Object.fromEntries(
            ports.map((port): [PortId, SwitchInterface] => [
              port.id,
              { shutdown: false, switchport: { mode: 'access', vlan: DEFAULT_VLAN } },
            ]),
          ),
          vlans: { [DEFAULT_VLAN]: { name: 'default' } },
          unknownLines: [],
        },
      };
    case 'pc':
    case 'server':
      return { ...fields, kind: spec.kind, config: { hostname, ipv4: { mode: 'static' } } };
    default: {
      const exhaustive: never = spec.kind;
      return exhaustive;
    }
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type LinkSpec = DistributiveOmit<Link, 'id'>;

export function createLink(
  spec: LinkSpec,
  { ids, topology }: { ids: IdSource; topology: Topology },
): Link {
  let id = ids.linkId();
  while (id in topology.links) id = ids.linkId();
  return { ...spec, id };
}

function putDevice(topology: Topology, device: Device): Topology {
  return produce(topology, (draft) => {
    draft.devices[device.id] = device;
  });
}

function editDevice(
  topology: Topology,
  id: DeviceId,
  recipe: (draft: Draft<Device>) => void,
): CommandResult {
  const device = topology.devices[id];
  if (!device) return err({ kind: 'device-not-found', device: id });
  return ok(putDevice(topology, produce(device, recipe)));
}

function withConfig(device: Device, update: ConfigUpdate): Device | undefined {
  switch (update.kind) {
    case 'router':
      return device.kind === 'router' ? { ...device, config: update.config } : undefined;
    case 'switch':
      return device.kind === 'switch' ? { ...device, config: update.config } : undefined;
    case 'pc':
      return device.kind === 'pc' ? { ...device, config: update.config } : undefined;
    case 'server':
      return device.kind === 'server' ? { ...device, config: update.config } : undefined;
    default: {
      const exhaustive: never = update;
      return exhaustive;
    }
  }
}
