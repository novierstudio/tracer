import { z } from 'zod';
import { AnnotationId, DeviceId, LinkId } from './ids';
import { Hostname, Ipv4Address, Ipv4Cidr, ipv4ToUint32, MacAddress, VlanId } from './values';

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

const SUBINTERFACE_LIMIT = 4294967295;

/** A router's 802.1Q subinterface on an Ethernet port, such as `GigabitEthernet0/0.10`. */
export const SubinterfaceId = z
  .string()
  .regex(/^(?:FastEthernet|GigabitEthernet)\d+(?:\/\d+)*\.[1-9]\d*$/, 'Invalid interface name')
  .refine(
    (name) => Number(name.slice(name.lastIndexOf('.') + 1)) <= SUBINTERFACE_LIMIT,
    'Subinterface number out of range',
  )
  .brand<'SubinterfaceId'>();
export type SubinterfaceId = z.infer<typeof SubinterfaceId>;

export const InterfaceId = z.union([PortId, VirtualInterfaceId, SubinterfaceId]);
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

/** `ip helper-address`: where a router relays the DHCP broadcasts it hears on an interface. */
const helperAddresses = z.array(Ipv4Address).min(1).optional();

/** `ip ospf cost`: what sending out of the interface adds to an OSPF path, 1 to 65535. */
export const OspfCost = z.int().min(1).max(65535);

/** `ip ospf priority`: who becomes DR on a multi-access network. 0 never does. */
export const OspfPriority = z.int().min(0).max(255);

/** Interface settings that OSPF reads. Absent means the defaults. */
const ospfInterfaceFields = {
  /** Absent means the cost of the interface's bandwidth: 100 Mbit/s divided by it, at least 1. */
  ospfCost: OspfCost.optional(),
  /** Absent means 1. */
  ospfPriority: OspfPriority.optional(),
};

export const RoutedInterface = z.object({
  ...interfaceFields,
  ...ospfInterfaceFields,
  ipv4: Ipv4Cidr.optional(),
  /** Bit/s a serial port clocks when its end of the cable is DCE. */
  clockRate: z.int().positive().optional(),
  helperAddresses,
});
export type RoutedInterface = z.infer<typeof RoutedInterface>;

/** VLANs `first` to `last`, both included. */
export const VlanRange = z
  .object({ first: VlanId, last: VlanId })
  .refine((range) => range.first <= range.last, 'A VLAN range must not run backwards');
export type VlanRange = z.infer<typeof VlanRange>;

/**
 * `switchport trunk allowed vlan`: sorted ranges that neither overlap nor touch. Absent means every
 * VLAN, the IOS default; an empty list is `none`.
 */
const allowedVlans = z.array(VlanRange).optional();

/** Each mode also keeps the other mode's VLAN settings, as IOS does, so switching back restores them. */
export const Switchport = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('access'),
    vlan: VlanId,
    nativeVlan: VlanId.optional(),
    allowedVlans,
  }),
  z.object({
    mode: z.literal('trunk'),
    nativeVlan: VlanId,
    accessVlan: VlanId.optional(),
    allowedVlans,
  }),
]);
export type Switchport = z.infer<typeof Switchport>;

/** `spanning-tree cost`: what a port adds to the path cost to the root, from 1 to 200000000. */
export const PathCost = z.int().min(1).max(200_000_000).brand<'PathCost'>();
export type PathCost = z.infer<typeof PathCost>;

export const SwitchInterface = z.object({
  ...interfaceFields,
  /**
   * Absent on a multilayer switch's routed port (`no switchport`): it leaves switching and
   * spanning tree, and takes an address as a router's port does.
   */
  switchport: Switchport.optional(),
  /** `spanning-tree portfast`. An access port with it forwards as soon as its link comes up. */
  portfast: z.literal(true).optional(),
  /** `spanning-tree cost`. Absent means the cost of the port's speed. */
  stpCost: PathCost.optional(),
  /** A routed port's address. */
  ipv4: Ipv4Cidr.optional(),
  /** A routed port's `ip helper-address` lines. */
  helperAddresses,
});
export type SwitchInterface = z.infer<typeof SwitchInterface>;

/** A switch port that switches: every port but a multilayer switch's routed ports. */
export type SwitchedInterface = SwitchInterface & { readonly switchport: Switchport };

/** `spanning-tree vlan <id> priority`: lower wins the root election. A multiple of 4096 up to 61440. */
export const BridgePriority = z
  .int()
  .min(0)
  .max(61440)
  .multipleOf(4096, 'Bridge priority must be a multiple of 4096')
  .brand<'BridgePriority'>();
export type BridgePriority = z.infer<typeof BridgePriority>;

/** `encapsulation dot1Q <vlan> [native]`: the VLAN a subinterface tags, or sends untagged when native. */
export const Dot1q = z.object({ vlan: VlanId, native: z.boolean() });
export type Dot1q = z.infer<typeof Dot1q>;

/** A router subinterface. It has no speed, duplex or clock of its own: those belong to its port. */
export const Subinterface = z.object({
  ...ospfInterfaceFields,
  shutdown: z.boolean(),
  description: z.string().optional(),
  /** IOS refuses an address until the subinterface has an encapsulation. */
  encapsulation: Dot1q.optional(),
  ipv4: Ipv4Cidr.optional(),
  helperAddresses,
});
export type Subinterface = z.infer<typeof Subinterface>;

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

/** `lease days [hours [minutes]]` at its longest: 365 days, 23 hours and 59 minutes. */
export const MAX_LEASE_MINUTES = 365 * 1440 + 23 * 60 + 59;

/** `lease`: how long a pool lends an address, in whole minutes, or `infinite`. */
export const DhcpLease = z.union([
  z.literal('infinite'),
  z.int().min(1).max(MAX_LEASE_MINUTES).brand<'LeaseMinutes'>(),
]);
export type DhcpLease = z.infer<typeof DhcpLease>;

/** IOS takes up to 8 addresses on one `default-router` or `dns-server` line. */
export const MAX_DHCP_OPTION_ADDRESSES = 8;

const optionAddresses = z.array(Ipv4Address).min(1).max(MAX_DHCP_OPTION_ADDRESSES).optional();

/** `ip dhcp pool NAME`: an address pool and the options its clients get with an address. */
export const DhcpPool = z.object({
  /** `network`: the subnet the pool lends from. A pool without one serves nobody. */
  network: Ipv4Cidr.optional(),
  /** `default-router`, in order of preference. */
  defaultRouters: optionAddresses,
  /** `dns-server`, in order of preference. */
  dnsServers: optionAddresses,
  /** Absent means DEFAULT_DHCP_LEASE. */
  lease: DhcpLease.optional(),
});
export type DhcpPool = z.infer<typeof DhcpPool>;

export const DhcpPoolName = z.string().regex(/^\S+$/, 'Invalid pool name');

/** `ip dhcp excluded-address first [last]`: addresses no pool lends, `first` to `last` included. */
export const DhcpExcludedRange = z
  .object({ first: Ipv4Address, last: Ipv4Address })
  .refine(
    (range) => ipv4ToUint32(range.first) <= ipv4ToUint32(range.last),
    'An excluded range must not run backwards',
  );
export type DhcpExcludedRange = z.infer<typeof DhcpExcludedRange>;

/** A router's DHCP server: its pools by name, and the ranges excluded from every pool. */
export const DhcpServerConfig = z.object({
  pools: z.record(DhcpPoolName, DhcpPool),
  /** In the order they were entered, as IOS lists them. */
  excluded: z.array(DhcpExcludedRange),
});
export type DhcpServerConfig = z.infer<typeof DhcpServerConfig>;

/**
 * `router rip`. Without `version`, IOS sends RIPv1 and accepts either version; `version 1` or
 * `version 2` pins both to one.
 */
export const RipConfig = z.object({
  version: z.union([z.literal(1), z.literal(2)]).optional(),
  /** `network`: classful networks, as IOS keeps them, so `network 10.1.1.0` is 10.0.0.0. */
  networks: z.array(Ipv4Address).default(() => []),
  /** On unless `no auto-summary`: subnets of another classful network go out as that network. */
  autoSummary: z.boolean().default(true),
  /** `passive-interface`: RIP advertises their networks but sends no updates out of them. */
  passiveInterfaces: z.array(InterfaceId).default(() => []),
  /** `default-information originate`: advertise a default route to every neighbour. */
  defaultOriginate: z.boolean().default(false),
});
export type RipConfig = z.infer<typeof RipConfig>;

/**
 * `network <address> <wildcard> area <id>`: an interface whose address matches, bit for bit where
 * the wildcard has a 0, runs OSPF in that area.
 */
export const OspfNetwork = z.object({
  address: Ipv4Address,
  wildcard: Ipv4Address,
  area: z.int().min(0).max(4294967295),
});
export type OspfNetwork = z.infer<typeof OspfNetwork>;

/** `router ospf <process-id>`. Tracer runs one process per router, in a single area. */
export const OspfConfig = z.object({
  /** Local to the router, 1 to 65535. Neighbours need not agree on it. */
  processId: z.int().min(1).max(65535),
  /** `router-id`. Absent means the highest loopback address, else the highest interface address. */
  routerId: Ipv4Address.optional(),
  /** In the order entered: the first that matches an interface puts it in its area. */
  networks: z.array(OspfNetwork).default(() => []),
  /** `passive-interface`: no hellos, so no neighbours, but its network is still advertised. */
  passiveInterfaces: z.array(InterfaceId).default(() => []),
});
export type OspfConfig = z.infer<typeof OspfConfig>;

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
  subinterfaces: z.record(SubinterfaceId, Subinterface).default(() => ({})),
  lines: RouterLines.default(factoryRouterLines),
  staticRoutes: z.array(StaticRoute).default(() => []),
  /** Absent until the first `ip dhcp` command, and again once the last pool and range go. */
  dhcp: DhcpServerConfig.optional(),
  /** Absent until `router rip`. */
  rip: RipConfig.optional(),
  /** Absent until `router ospf`. */
  ospf: OspfConfig.optional(),
});
export type RouterConfig = z.infer<typeof RouterConfig>;

export const SwitchConfig = z.object({
  ...iosFields,
  interfaces: z.record(PortId, SwitchInterface),
  vlans: z.record(VlanId, z.object({ name: z.string().min(1).max(32) })),
  lines: SwitchLines.default(factorySwitchLines),
  defaultGateway: Ipv4Address.optional(),
  /** Bridge priority by VLAN. A VLAN without one has DEFAULT_BRIDGE_PRIORITY. */
  stpPriorities: z.record(VlanId, BridgePriority).optional(),
  /**
   * `ip routing`, on a multilayer switch only: it routes between its VLAN interfaces and routed
   * ports, and `ip default-gateway` no longer applies.
   */
  ipRouting: z.literal(true).optional(),
  /** `ip route`, on a multilayer switch only. They take effect with `ip routing`. */
  staticRoutes: z.array(StaticRoute).optional(),
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

export const Size = z.object({ width: z.number().positive(), height: z.number().positive() });
export type Size = z.infer<typeof Size>;

/** The palette annotations draw from. The canvas maps each name to a colour token per theme. */
export const ANNOTATION_COLORS = [
  'slate',
  'blue',
  'teal',
  'green',
  'amber',
  'red',
  'purple',
] as const;
export const AnnotationColor = z.enum(ANNOTATION_COLORS);
export type AnnotationColor = z.infer<typeof AnnotationColor>;

export const TEXT_SIZES = ['small', 'medium', 'large'] as const;
export type TextSize = (typeof TEXT_SIZES)[number];

export const SHAPES = ['rectangle', 'ellipse'] as const;
export type Shape = (typeof SHAPES)[number];

/** A note card's width before anyone resizes it. Its height grows with the text. */
export const NOTE_WIDTH = 192;

// Every annotation is placed by its top-left corner. Fields added after notes shipped have
// defaults, so files saved with notes only still load.
const annotationFields = { id: AnnotationId, position: Point };

export const Annotation = z.discriminatedUnion('kind', [
  z.object({
    ...annotationFields,
    kind: z.literal('note'),
    text: z.string(),
    width: z.number().positive().default(NOTE_WIDTH),
    color: AnnotationColor.default('amber'),
  }),
  /** Free text. Without a width it is as wide as its longest line. */
  z.object({
    ...annotationFields,
    kind: z.literal('text'),
    text: z.string(),
    textSize: z.enum(TEXT_SIZES).default('medium'),
    width: z.number().positive().optional(),
    color: AnnotationColor.default('slate'),
  }),
  /** A labelled, tinted region drawn behind devices and links, such as "Building A". */
  z.object({
    ...annotationFields,
    kind: z.literal('area'),
    label: z.string(),
    size: Size,
    color: AnnotationColor.default('blue'),
  }),
  /** An outline with no fill. */
  z.object({
    ...annotationFields,
    kind: z.literal('shape'),
    shape: z.enum(SHAPES),
    size: Size,
    color: AnnotationColor.default('slate'),
  }),
]);
export type Annotation = z.infer<typeof Annotation>;
export type AnnotationKind = Annotation['kind'];

/**
 * How long spanning tree holds a new switch port. `fast` gets it forwarding in about 4 s, still
 * through listening and learning; `ios` runs the real IOS timers and takes 30 s.
 */
export const StpTimers = z.enum(['fast', 'ios']);
export type StpTimers = z.infer<typeof StpTimers>;

/**
 * How fast routing protocols talk. `fast` gets a lab converged in seconds; `ios` runs the real
 * IOS timers, such as RIP's 30 s updates and OSPF's 10 s hellos.
 */
export const RoutingTimers = z.enum(['fast', 'ios']);
export type RoutingTimers = z.infer<typeof RoutingTimers>;

/** Settings for the whole lab rather than any one device. They never reach a running-config. */
export const LabSettings = z.object({
  stpTimers: StpTimers,
  /** Absent in files from before routing protocols. */
  routingTimers: RoutingTimers.default('fast'),
});
export type LabSettings = z.infer<typeof LabSettings>;

const TopologyShape = z.object({
  version: z.literal(TOPOLOGY_VERSION),
  meta: z.object({ name: z.string(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() }),
  devices: z.record(DeviceId, Device),
  links: z.record(LinkId, Link),
  annotations: z.record(AnnotationId, Annotation),
  /** Absent in files from before lab settings, and in labs that keep the defaults. */
  settings: LabSettings.optional(),
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
