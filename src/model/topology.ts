import { z } from 'zod';
import { AnnotationId, DeviceId, LinkId } from './ids';
import { Hostname, Ipv4Address, Ipv4Cidr, MacAddress, VlanId } from './values';

export const TOPOLOGY_VERSION = 1;

export const Point = z.object({ x: z.number(), y: z.number() });
export type Point = z.infer<typeof Point>;

const PORT_NAME_PREFIX = {
  fastEthernet: 'FastEthernet',
  gigabitEthernet: 'GigabitEthernet',
  serial: 'Serial',
} as const;

export const PortId = z
  .string()
  .regex(
    new RegExp(`^(?:${Object.values(PORT_NAME_PREFIX).join('|')})\\d+(?:/\\d+)*$`),
    'Invalid interface name',
  )
  .brand<'PortId'>();
export type PortId = z.infer<typeof PortId>;

const VIRTUAL_INTERFACE_LIMIT = { Loopback: 2147483647, Vlan: 4094 } as const;

/** A config-only interface: it exists because the config creates it, not because of hardware. */
export const VirtualInterfaceId = z
  .string()
  .regex(/^(?:Loopback(?:0|[1-9]\d*)|Vlan[1-9]\d*)$/, 'Invalid interface name')
  .refine((name) => {
    const [, type = '', number = ''] = /^([A-Za-z]+)(\d+)$/.exec(name) ?? [];
    return Number(number) <= VIRTUAL_INTERFACE_LIMIT[type as keyof typeof VIRTUAL_INTERFACE_LIMIT];
  }, 'Interface number out of range')
  .brand<'VirtualInterfaceId'>();
export type VirtualInterfaceId = z.infer<typeof VirtualInterfaceId>;

export const InterfaceId = z.union([PortId, VirtualInterfaceId]);
export type InterfaceId = z.infer<typeof InterfaceId>;

/** Every interface type name, in the order IOS lists interfaces in a running-config. */
export const INTERFACE_TYPES = [
  'Loopback',
  'FastEthernet',
  'GigabitEthernet',
  'Serial',
  'Vlan',
] as const satisfies readonly (
  (typeof PORT_NAME_PREFIX)[keyof typeof PORT_NAME_PREFIX] | keyof typeof VIRTUAL_INTERFACE_LIMIT
)[];
export type InterfaceType = (typeof INTERFACE_TYPES)[number];

export const Port = z.discriminatedUnion('kind', [
  z.object({ kind: z.enum(['fastEthernet', 'gigabitEthernet']), id: PortId, mac: MacAddress }),
  z.object({ kind: z.literal('serial'), id: PortId }),
]);
export type Port = z.infer<typeof Port>;
export type PortKind = Port['kind'];

const interfaceFields = {
  shutdown: z.boolean(),
  description: z.string().optional(),
  /** Mbit/s on an Ethernet port. Absent means auto. */
  speed: z.union([z.literal(10), z.literal(100), z.literal(1000)]).optional(),
  /** On an Ethernet port. Absent means auto. */
  duplex: z.enum(['full', 'half']).optional(),
};

export const RoutedInterface = z.object({
  ...interfaceFields,
  ipv4: Ipv4Cidr.optional(),
  /** Bit/s a serial port clocks when its end of the cable is DCE. */
  clockRate: z.int().positive().optional(),
});
export type RoutedInterface = z.infer<typeof RoutedInterface>;

/** Each mode also keeps the other mode's VLAN setting, as IOS does, so switching back restores it. */
export const Switchport = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('access'), vlan: VlanId, nativeVlan: VlanId.optional() }),
  z.object({ mode: z.literal('trunk'), nativeVlan: VlanId, accessVlan: VlanId.optional() }),
]);
export type Switchport = z.infer<typeof Switchport>;

export const SwitchInterface = z.object({ ...interfaceFields, switchport: Switchport });
export type SwitchInterface = z.infer<typeof SwitchInterface>;

/** An MD5-crypt hash, which IOS shows as `enable secret 5 $1$salt$hash`. */
export const Md5CryptHash = z
  .string()
  .regex(/^\$1\$[./0-9A-Za-z]{0,8}\$[./0-9A-Za-z]{22}$/, 'Invalid MD5-crypt hash')
  .brand<'Md5CryptHash'>();
export type Md5CryptHash = z.infer<typeof Md5CryptHash>;

export const LineConfig = z.object({
  /** Kept in clear text. `service password-encryption` only changes how it is shown. */
  password: z.string().min(1).optional(),
  /** `login` checks the line password, `login local` checks usernames. */
  login: z.enum(['none', 'password', 'local']),
  /** `transport input`: the protocols that may open a session on the line. */
  transportInput: z.object({ ssh: z.boolean(), telnet: z.boolean() }),
});
export type LineConfig = z.infer<typeof LineConfig>;

export const VTY_LINE_COUNT = 16;

const vtyLines = z.array(LineConfig).length(VTY_LINE_COUNT);

export const RouterLines = z.object({ console: LineConfig, aux: LineConfig, vty: vtyLines });
export type RouterLines = z.infer<typeof RouterLines>;

export const SwitchLines = z.object({ console: LineConfig, vty: vtyLines });
export type SwitchLines = z.infer<typeof SwitchLines>;

export const StaticRoute = z.object({
  prefix: Ipv4Cidr,
  nextHop: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('address'), address: Ipv4Address }),
    z.object({ kind: z.literal('interface'), interface: InterfaceId }),
  ]),
  /** Administrative distance. Absent means 1. */
  distance: z.int().min(1).max(255).optional(),
});
export type StaticRoute = z.infer<typeof StaticRoute>;

export const DEFAULT_ROUTER_HOSTNAME = Hostname.parse('Router');
export const DEFAULT_SWITCH_HOSTNAME = Hostname.parse('Switch');

/** A line as a device ships: no password, and vty lines ask for one. */
function factoryLine(login: LineConfig['login']): LineConfig {
  return { login, transportInput: { ssh: true, telnet: true } };
}

export function factoryRouterLines(): RouterLines {
  return {
    console: factoryLine('none'),
    aux: factoryLine('none'),
    vty: Array.from({ length: VTY_LINE_COUNT }, () => factoryLine('password')),
  };
}

export function factorySwitchLines(): SwitchLines {
  return {
    console: factoryLine('none'),
    vty: Array.from({ length: VTY_LINE_COUNT }, () => factoryLine('password')),
  };
}

/** Fields that routers and switches share. Each has a default, so older files still load. */
const iosFields = {
  hostname: Hostname,
  virtualInterfaces: z.record(VirtualInterfaceId, RoutedInterface).default(() => ({})),
  enableSecret: Md5CryptHash.optional(),
  /** Kept in clear text, like line passwords. */
  enablePassword: z.string().min(1).optional(),
  servicePasswordEncryption: z.boolean().default(false),
  /** `ip domain-lookup`, on unless the config says `no ip domain-lookup`. */
  domainLookup: z.boolean().default(true),
  bannerMotd: z.string().optional(),
  /** The saved config in NVRAM, as running-config lines. Absent until the first save. */
  startupConfig: z.array(z.string()).optional(),
  unknownLines: z.array(z.string()),
};

export const RouterConfig = z.object({
  ...iosFields,
  interfaces: z.record(PortId, RoutedInterface),
  lines: RouterLines.default(factoryRouterLines),
  staticRoutes: z.array(StaticRoute).default(() => []),
});
export type RouterConfig = z.infer<typeof RouterConfig>;

export const SwitchConfig = z.object({
  ...iosFields,
  interfaces: z.record(PortId, SwitchInterface),
  vlans: z.record(VlanId, z.object({ name: z.string().min(1).max(32) })),
  lines: SwitchLines.default(factorySwitchLines),
  defaultGateway: Ipv4Address.optional(),
});
export type SwitchConfig = z.infer<typeof SwitchConfig>;

export const HostIpv4 = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('dhcp') }),
  z.object({
    mode: z.literal('static'),
    address: Ipv4Cidr.optional(),
    gateway: Ipv4Address.optional(),
    dns: Ipv4Address.optional(),
  }),
]);
export type HostIpv4 = z.infer<typeof HostIpv4>;

export const HostConfig = z.object({ hostname: Hostname, ipv4: HostIpv4 });
export type HostConfig = z.infer<typeof HostConfig>;

const deviceFields = {
  id: DeviceId,
  model: z.string().min(1),
  position: Point,
  powered: z.boolean(),
  ports: z.array(Port),
};

const DeviceShape = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('router'), ...deviceFields, config: RouterConfig }),
  z.object({ kind: z.literal('switch'), ...deviceFields, config: SwitchConfig }),
  z.object({ kind: z.literal('pc'), ...deviceFields, config: HostConfig }),
  z.object({ kind: z.literal('server'), ...deviceFields, config: HostConfig }),
]);
export type Device = z.infer<typeof DeviceShape>;
export type DeviceKind = Device['kind'];
export type DeviceConfig = Device['config'];

export const Device = DeviceShape.superRefine((device, ctx) => {
  const problem = findDeviceProblem(device);
  if (problem) ctx.addIssue({ code: 'custom', message: describeTopologyError(problem) });
});

export const Endpoint = z.object({ device: DeviceId, port: PortId });
export type Endpoint = z.infer<typeof Endpoint>;

export const Link = z.discriminatedUnion('cable', [
  z.object({ id: LinkId, cable: z.enum(['straight', 'crossover']), a: Endpoint, b: Endpoint }),
  z.object({
    id: LinkId,
    cable: z.literal('serial'),
    a: Endpoint,
    b: Endpoint,
    dce: z.enum(['a', 'b']),
  }),
]);
export type Link = z.infer<typeof Link>;
export type Cable = Link['cable'];

export const Annotation = z.discriminatedUnion('kind', [
  z.object({ id: AnnotationId, kind: z.literal('note'), position: Point, text: z.string() }),
]);
export type Annotation = z.infer<typeof Annotation>;

const TopologyShape = z.object({
  version: z.literal(TOPOLOGY_VERSION),
  meta: z.object({ name: z.string(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() }),
  devices: z.record(DeviceId, Device),
  links: z.record(LinkId, Link),
  annotations: z.record(AnnotationId, Annotation),
});
export type Topology = z.infer<typeof TopologyShape>;

export const Topology = TopologyShape.superRefine((topology, ctx) => {
  for (const collection of ['devices', 'links', 'annotations'] as const) {
    for (const [key, entry] of Object.entries(topology[collection])) {
      if (key !== entry.id) {
        ctx.addIssue({
          code: 'custom',
          path: [collection, key, 'id'],
          message: `Key ${key} does not match id ${entry.id}`,
        });
      }
    }
  }

  const accepted: Topology = { ...topology, links: {} };
  for (const [key, link] of Object.entries(topology.links)) {
    const problem = findLinkProblem(accepted, link);
    if (problem) {
      ctx.addIssue({
        code: 'custom',
        path: ['links', key],
        message: describeTopologyError(problem),
      });
    } else {
      accepted.links[link.id] = link;
    }
  }
});

export function emptyTopology({ name, now }: { name: string; now: Date }): Topology {
  const timestamp = now.toISOString();
  return {
    version: TOPOLOGY_VERSION,
    meta: { name, createdAt: timestamp, updatedAt: timestamp },
    devices: {},
    links: {},
    annotations: {},
  };
}

type Medium = 'copper' | 'serial';

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

export type TopologyError =
  | { kind: 'duplicate-id'; id: DeviceId | LinkId | AnnotationId }
  | { kind: 'device-not-found'; device: DeviceId }
  | { kind: 'annotation-not-found'; annotation: AnnotationId }
  | { kind: 'device-kind-mismatch'; device: DeviceId; expected: DeviceKind; actual: DeviceKind }
  | { kind: 'link-not-found'; link: LinkId }
  | { kind: 'duplicate-port'; device: DeviceId; port: PortId }
  | { kind: 'port-name-mismatch'; device: DeviceId; port: PortId; portKind: PortKind }
  | { kind: 'interfaces-mismatch'; device: DeviceId; missing: PortId[]; extra: string[] }
  | { kind: 'port-not-found'; endpoint: Endpoint }
  | { kind: 'port-in-use'; endpoint: Endpoint; link: LinkId }
  | { kind: 'cable-mismatch'; endpoint: Endpoint; cable: Cable; portKind: PortKind }
  | { kind: 'same-port'; endpoint: Endpoint };

export function findDeviceProblem(device: Device): TopologyError | undefined {
  const portIds = new Set<string>();
  for (const port of device.ports) {
    if (portIds.has(port.id)) return { kind: 'duplicate-port', device: device.id, port: port.id };
    portIds.add(port.id);
    if (!port.id.startsWith(PORT_NAME_PREFIX[port.kind])) {
      return { kind: 'port-name-mismatch', device: device.id, port: port.id, portKind: port.kind };
    }
  }

  if (device.kind === 'router' || device.kind === 'switch') {
    const interfaces = device.config.interfaces;
    const missing = device.ports.filter((port) => !(port.id in interfaces)).map((port) => port.id);
    const extra = Object.keys(interfaces).filter((key) => !portIds.has(key));
    if (missing.length > 0 || extra.length > 0) {
      return { kind: 'interfaces-mismatch', device: device.id, missing, extra };
    }
  }
  return undefined;
}

export function linkAt(topology: Topology, endpoint: Endpoint): Link | undefined {
  return Object.values(topology.links).find(
    (link) => sameEndpoint(link.a, endpoint) || sameEndpoint(link.b, endpoint),
  );
}

function sameEndpoint(left: Endpoint, right: Endpoint): boolean {
  return left.device === right.device && left.port === right.port;
}

export function findLinkProblem(topology: Topology, link: Link): TopologyError | undefined {
  if (sameEndpoint(link.a, link.b)) return { kind: 'same-port', endpoint: link.a };

  for (const endpoint of [link.a, link.b]) {
    const device = topology.devices[endpoint.device];
    if (!device) return { kind: 'device-not-found', device: endpoint.device };

    const port = device.ports.find((candidate) => candidate.id === endpoint.port);
    if (!port) return { kind: 'port-not-found', endpoint };

    if (PORT_MEDIUM[port.kind] !== CABLE_MEDIUM[link.cable]) {
      return { kind: 'cable-mismatch', endpoint, cable: link.cable, portKind: port.kind };
    }

    const occupant = linkAt(topology, endpoint);
    if (occupant && occupant.id !== link.id) {
      return { kind: 'port-in-use', endpoint, link: occupant.id };
    }
  }
  return undefined;
}

export function describeTopologyError(error: TopologyError): string {
  switch (error.kind) {
    case 'duplicate-id':
      return `ID ${error.id} is already in use`;
    case 'device-not-found':
      return `Device ${error.device} does not exist`;
    case 'annotation-not-found':
      return `Annotation ${error.annotation} does not exist`;
    case 'device-kind-mismatch':
      return `Device ${error.device} is a ${error.actual}, not a ${error.expected}`;
    case 'link-not-found':
      return `Link ${error.link} does not exist`;
    case 'duplicate-port':
      return `Device ${error.device} lists port ${error.port} more than once`;
    case 'port-name-mismatch':
      return `Port ${error.port} on device ${error.device} is not named like a ${error.portKind} port`;
    case 'interfaces-mismatch': {
      const parts = [
        error.missing.length > 0 ? `missing ${error.missing.join(', ')}` : '',
        error.extra.length > 0 ? `unknown ${error.extra.join(', ')}` : '',
      ].filter(Boolean);
      return `Interface config on device ${error.device} must cover exactly its ports (${parts.join('; ')})`;
    }
    case 'port-not-found':
      return `Device ${error.endpoint.device} has no port ${error.endpoint.port}`;
    case 'port-in-use':
      return `Port ${error.endpoint.port} on device ${error.endpoint.device} is already connected by link ${error.link}`;
    case 'cable-mismatch':
      return `A ${error.cable} cable cannot connect to ${error.endpoint.port} on device ${error.endpoint.device}`;
    case 'same-port':
      return `Both ends of the link are port ${error.endpoint.port} on device ${error.endpoint.device}`;
    default: {
      const exhaustive: never = error;
      return exhaustive;
    }
  }
}
