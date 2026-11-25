import {
  describeTopologyError,
  err,
  linkAt,
  ok,
  type Cable,
  type DeviceId,
  type DeviceKind,
  type Endpoint,
  type LinkSpec,
  type PortId,
  type PortKind,
  type Result,
  type Topology,
  type TopologyError,
} from '@/model';

export const CABLE_CHOICES = ['auto', 'straight', 'crossover', 'serial'] as const;
export type CableChoice = (typeof CABLE_CHOICES)[number];

export const CABLE_LABELS: Record<CableChoice, string> = {
  auto: 'Auto',
  straight: 'Straight-through',
  crossover: 'Crossover',
  serial: 'Serial',
};

export type Medium = 'copper' | 'serial';

const PORT_MEDIUM: Record<PortKind, Medium> = {
  fastEthernet: 'copper',
  gigabitEthernet: 'copper',
  serial: 'serial',
};

const CABLE_MEDIUM: Record<Cable, Medium> = {
  straight: 'copper',
  crossover: 'copper',
  serial: 'serial',
};

// Hosts and routers transmit on the pins switches receive on (MDI vs MDI-X), so unlike devices
// take a straight-through cable and like devices a crossover, as in Packet Tracer.
const MDI_X: Record<DeviceKind, boolean> = {
  router: false,
  pc: false,
  server: false,
  switch: true,
};

export type PortEnd = { device: DeviceKind; port: PortKind };

/** The cable Auto picks, or undefined when one end is serial and the other copper. */
export function autoCable(a: PortEnd, b: PortEnd): Cable | undefined {
  const medium = PORT_MEDIUM[a.port];
  if (medium !== PORT_MEDIUM[b.port]) return undefined;
  if (medium === 'serial') return 'serial';
  return MDI_X[a.device] === MDI_X[b.device] ? 'crossover' : 'straight';
}

/** What the next port must carry: the chosen cable's medium, or with Auto the first end's. */
export function requiredMedium(
  topology: Topology,
  choice: CableChoice,
  firstEnd?: Endpoint,
): Medium | undefined {
  if (choice !== 'auto') return CABLE_MEDIUM[choice];
  const port = firstEnd && findPort(topology, firstEnd);
  return port && PORT_MEDIUM[port.kind];
}

function findPort(topology: Topology, { device, port }: Endpoint) {
  return topology.devices[device]?.ports.find((candidate) => candidate.id === port);
}

const SHORT_PREFIX: Record<PortKind, [long: string, short: string]> = {
  fastEthernet: ['FastEthernet', 'Fa'],
  gigabitEthernet: ['GigabitEthernet', 'Gi'],
  serial: ['Serial', 'Se'],
};

/** `GigabitEthernet0/1` is `Gi0/1`, as IOS abbreviates it. */
export function shortPortName(id: PortId): string {
  for (const [long, short] of Object.values(SHORT_PREFIX)) {
    if (id.startsWith(long)) return short + id.slice(long.length);
  }
  return id;
}

export type PortOption = { id: PortId; kind: PortKind; short: string } & (
  { status: 'free' } | { status: 'used'; peer: string } | { status: 'incompatible' }
);

/** Every port on the device, free ones first, each in catalog order. */
export function portOptions(
  topology: Topology,
  device: DeviceId,
  needs: Medium | undefined,
): PortOption[] {
  const ports = topology.devices[device]?.ports ?? [];
  const options = ports.map((port): PortOption => {
    const base = { id: port.id, kind: port.kind, short: shortPortName(port.id) };
    const link = linkAt(topology, { device, port: port.id });
    if (link) {
      const far = link.a.device === device && link.a.port === port.id ? link.b : link.a;
      return { ...base, status: 'used', peer: describeEndpoint(topology, far) };
    }
    if (needs && PORT_MEDIUM[port.kind] !== needs) return { ...base, status: 'incompatible' };
    return { ...base, status: 'free' };
  });
  return [
    ...options.filter((option) => option.status === 'free'),
    ...options.filter((option) => option.status !== 'free'),
  ];
}

/** The port to use without asking: set only for devices with a single port of the right medium. */
export function onlyPort(
  topology: Topology,
  device: DeviceId,
  needs: Medium | undefined,
): PortId | undefined {
  const ports = (topology.devices[device]?.ports ?? []).filter(
    (port) => !needs || PORT_MEDIUM[port.kind] === needs,
  );
  const [port] = ports;
  return ports.length === 1 && port && !linkAt(topology, { device, port: port.id })
    ? port.id
    : undefined;
}

export type CableError =
  | TopologyError
  | { kind: 'same-device'; device: DeviceId }
  | { kind: 'no-free-port'; device: DeviceId }
  | { kind: 'no-shared-medium'; a: DeviceId; b: DeviceId };

const freePorts = (topology: Topology, device: DeviceId) =>
  (topology.devices[device]?.ports ?? []).filter(
    (port) => !linkAt(topology, { device, port: port.id }),
  );

/**
 * Quick cable: the first free port on `a`, in catalog order, that a free port on `b` can take,
 * joined to the first such port on `b`, with the cable Auto picks.
 */
export function planQuickCable(
  topology: Topology,
  a: DeviceId,
  b: DeviceId,
): Result<LinkSpec, CableError> {
  if (a === b) return err({ kind: 'same-device', device: a });
  const ours = freePorts(topology, a);
  const theirs = freePorts(topology, b);
  for (const [device, free] of [
    [a, ours],
    [b, theirs],
  ] as const) {
    if (!topology.devices[device]) return err({ kind: 'device-not-found', device });
    if (free.length === 0) return err({ kind: 'no-free-port', device });
  }
  for (const port of ours) {
    const match = theirs.find((other) => PORT_MEDIUM[other.kind] === PORT_MEDIUM[port.kind]);
    if (match) {
      return planLink(
        topology,
        'auto',
        { device: a, port: port.id },
        { device: b, port: match.id },
      );
    }
  }
  return err({ kind: 'no-shared-medium', a, b });
}

/** The link to ask the store for. The store still validates it; this only resolves Auto. */
export function planLink(
  topology: Topology,
  choice: CableChoice,
  a: Endpoint,
  b: Endpoint,
): Result<LinkSpec, CableError> {
  if (a.device === b.device) return err({ kind: 'same-device', device: a.device });
  const ends = [a, b].map((endpoint) => {
    const device = topology.devices[endpoint.device];
    const port = findPort(topology, endpoint);
    return device && port && { device: device.kind, port: port.kind };
  });
  const [aEnd, bEnd] = ends;
  if (!aEnd || !bEnd) {
    const missing = aEnd ? b : a;
    return topology.devices[missing.device]
      ? err({ kind: 'port-not-found', endpoint: missing })
      : err({ kind: 'device-not-found', device: missing.device });
  }

  const cable = choice === 'auto' ? autoCable(aEnd, bEnd) : choice;
  if (!cable) {
    const wanted: Cable = aEnd.port === 'serial' ? 'serial' : 'straight';
    return err({ kind: 'cable-mismatch', endpoint: b, cable: wanted, portKind: bEnd.port });
  }
  return ok(cable === 'serial' ? { cable, a, b, dce: 'a' } : { cable, a, b });
}

function hostname(topology: Topology, device: DeviceId): string {
  return topology.devices[device]?.config.hostname ?? 'a deleted device';
}

function describeEndpoint(topology: Topology, endpoint: Endpoint): string {
  return `${hostname(topology, endpoint.device)} ${shortPortName(endpoint.port)}`;
}

const MEDIUM_CABLE: Record<Medium, string> = { copper: 'a copper', serial: 'a serial' };

/** A message for the person holding the cable, naming devices by hostname. */
export function describeCableError(topology: Topology, error: CableError): string {
  switch (error.kind) {
    case 'same-device':
      return `A cable needs two devices. Pick another device to connect ${hostname(topology, error.device)} to.`;
    case 'port-in-use': {
      const link = topology.links[error.link];
      const far = link && (link.a.device === error.endpoint.device ? link.b : link.a);
      const peer = far ? ` to ${describeEndpoint(topology, far)}` : '';
      return `${describeEndpoint(topology, error.endpoint)} is already connected${peer}.`;
    }
    case 'cable-mismatch': {
      const needs = MEDIUM_CABLE[PORT_MEDIUM[error.portKind]];
      return `${describeEndpoint(topology, error.endpoint)} needs ${needs} cable, not ${CABLE_LABELS[error.cable].toLowerCase()}.`;
    }
    case 'same-port':
      return `Both ends are ${describeEndpoint(topology, error.endpoint)}.`;
    case 'port-not-found':
      return `${hostname(topology, error.endpoint.device)} has no port ${error.endpoint.port}.`;
    case 'device-not-found':
      return 'That device no longer exists.';
    case 'no-free-port':
      return `${hostname(topology, error.device)} has no free ports.`;
    case 'no-shared-medium':
      return `${hostname(topology, error.a)} and ${hostname(topology, error.b)} have no free ports that take the same cable.`;
    default:
      return describeTopologyError(error);
  }
}
