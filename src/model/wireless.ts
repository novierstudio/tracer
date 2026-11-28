// No runtime imports: the simulation worker uses these, and must not pull in zod.
import { WAN_PORT } from './cabling';
import type { DeviceId, LinkId } from './ids';
import type {
  AccessList,
  AclName,
  Device,
  DhcpServerConfig,
  Endpoint,
  InterfaceId,
  NatConfig,
  Port,
  PortId,
  WirelessProfile,
  WirelessRadio,
  WirelessRouterConfig,
  WirelessSecurity,
} from './topology';
import type { Ipv4Address, Ipv4Cidr, PrefixLength } from './values';

export type WirelessPort = Extract<Port, { kind: 'wireless' }>;

/** The radio a device offers clients, with its port: an access point's or a home router's. */
export function radioOf(device: Device): { port: PortId; radio: WirelessRadio } | undefined {
  if (device.kind !== 'accessPoint' && device.kind !== 'wirelessRouter') return undefined;
  const port = device.ports.find((candidate) => candidate.kind === 'wireless');
  return port && { port: port.id, radio: device.config.radio };
}

/** A host's wireless NIC, if it has one in place of an Ethernet one. */
export function wirelessNic(device: Device): WirelessPort | undefined {
  if (device.kind !== 'pc' && device.kind !== 'server') return undefined;
  return device.ports.find((port): port is WirelessPort => port.kind === 'wireless');
}

const sameSecurity = (a: WirelessSecurity, b: WirelessSecurity) =>
  a.mode === 'none' ? b.mode === 'none' : b.mode === a.mode && b.passphrase === a.passphrase;

/** Whether a radio lets in a client: the same SSID, the same security and the same passphrase. */
export const admits = (radio: WirelessRadio, profile: WirelessProfile) =>
  radio.ssid === profile.ssid && sameSecurity(radio.security, profile.security);

/**
 * A host associated with an access point or home router: a wireless link from the host's NIC
 * (`a`) to the radio (`b`). The engine and the canvas derive it from the devices; files never
 * store it.
 */
export type Association = {
  readonly id: LinkId;
  readonly cable: 'wireless';
  readonly a: Endpoint;
  readonly b: Endpoint;
};

/** The id of a host's association. It is not a stored link's id, so it never clashes with one. */
export const associationId = (client: DeviceId) => `wifi_${client}` as LinkId;

const distance = (a: Device, b: Device) =>
  Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);

/**
 * Every association the devices make now. A powered host with a wireless NIC joins the nearest
 * powered radio that admits its profile, as Packet Tracer's PC Wireless app does once it has the
 * right SSID and key. Radio frequencies are not simulated: any distance and channel will do.
 */
export function associations(devices: Iterable<Device>): Association[] {
  const all = [...devices].filter((device) => device.powered);
  const radios = all.flatMap((device) => {
    const offered = radioOf(device);
    return offered ? [{ device, ...offered }] : [];
  });
  const found: Association[] = [];
  for (const client of all) {
    const nic = wirelessNic(client);
    const profile = (client.kind === 'pc' || client.kind === 'server') && client.config.wireless;
    if (!nic || !profile) continue;
    let best: (typeof radios)[number] | undefined;
    for (const candidate of radios) {
      if (!admits(candidate.radio, profile)) continue;
      if (!best || distance(client, candidate.device) < distance(client, best.device)) {
        best = candidate;
      }
    }
    if (!best) continue;
    found.push({
      id: associationId(client.id),
      cable: 'wireless',
      a: { device: client.id, port: nic.id },
      b: { device: best.device.id, port: best.port },
    });
  }
  return found;
}

/** The ports a bridging device switches between: all of an access point's, a home router's LAN. */
export function bridgedPorts(device: Device): PortId[] {
  switch (device.kind) {
    case 'accessPoint':
      return device.ports.map((port) => port.id);
    case 'wirelessRouter':
      return device.ports.filter((port) => port.id !== WAN_PORT).map((port) => port.id);
    default:
      return [];
  }
}

/** The name a home router's LAN goes by in the routing table and NAT, as on IOS. */
export const HOME_LAN = 'Vlan1' as InterfaceId;

/** The access list a home router's PAT translates by: everything from its LAN. */
const LAN_ACL = 'LAN' as AclName;

const toNumber = (address: string) =>
  address.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);

const toAddress = (value: number) =>
  [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.') as Ipv4Address;

const maskOf = (prefixLength: number) =>
  prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;

/** The LAN's network, such as 192.168.0.0/24 for a router at 192.168.0.1/24. */
export function lanNetwork({ address, prefixLength }: Ipv4Cidr): Ipv4Cidr {
  return { address: toAddress((toNumber(address) & maskOf(prefixLength)) >>> 0), prefixLength };
}

/** The last address the router's DHCP server lends: `maxUsers` addresses from `start`. */
export function dhcpLast(config: WirelessRouterConfig): Ipv4Address {
  return toAddress(toNumber(config.dhcp.start) + config.dhcp.maxUsers - 1);
}

/** What a home router's GUI settings mean in IOS terms, so its DHCP server and PAT run as a router's. */
export type HomeRouterIos = {
  readonly dhcp: DhcpServerConfig | undefined;
  readonly nat: NatConfig;
  readonly accessLists: Readonly<Record<AclName, AccessList>>;
  /** Each interface's NAT role, by name. */
  readonly interfaces: Readonly<Record<string, { readonly nat: 'inside' | 'outside' }>>;
};

/**
 * A home router's settings as the IOS config that would do the same: a DHCP pool for its LAN
 * that lends `maxUsers` addresses from `start`, with the router as gateway and its static DNS
 * server, and PAT from the LAN to the Internet port's address.
 */
export function homeRouterIos(config: WirelessRouterConfig): HomeRouterIos {
  const network = lanNetwork(config.lan);
  const first = toNumber(network.address);
  const broadcast = (first | (~maskOf(network.prefixLength) >>> 0)) >>> 0;
  const start = toNumber(config.dhcp.start);
  const last = toNumber(dhcpLast(config));
  const excluded = [
    ...(start > first + 1 ? [{ first: toAddress(first + 1), last: toAddress(start - 1) }] : []),
    ...(last < broadcast - 1
      ? [{ first: toAddress(last + 1), last: toAddress(broadcast - 1) }]
      : []),
  ];
  const dns = config.wan.mode === 'static' ? config.wan.dns : undefined;
  const dhcp: DhcpServerConfig | undefined = config.dhcp.enabled
    ? {
        pools: {
          LAN: {
            network,
            defaultRouters: [config.lan.address],
            ...(dns && { dnsServers: [dns] }),
          },
        },
        excluded,
      }
    : undefined;
  const wildcard = toAddress(~maskOf(network.prefixLength) >>> 0);
  return {
    dhcp,
    nat: {
      pools: {},
      statics: [],
      dynamic: [{ acl: LAN_ACL, to: { kind: 'interface', interface: WAN_PORT }, overload: true }],
    },
    accessLists: {
      [LAN_ACL]: {
        type: 'standard',
        entries: [
          { kind: 'rule', action: 'permit', source: { address: network.address, wildcard } },
        ],
      },
    },
    interfaces: { [HOME_LAN]: { nat: 'inside' }, [WAN_PORT]: { nat: 'outside' } },
  };
}

/** A home router as it ships, as Packet Tracer's WRT300N: 192.168.0.1/24, DHCP from .100 for 50. */
export const DEFAULT_HOME_ROUTER: Omit<WirelessRouterConfig, 'hostname'> = {
  wan: { mode: 'dhcp' },
  lan: { address: '192.168.0.1' as Ipv4Address, prefixLength: 24 as PrefixLength },
  dhcp: { enabled: true, start: '192.168.0.100' as Ipv4Address, maxUsers: 50 },
  radio: { ssid: 'Default', security: { mode: 'none' }, channel: 6 },
};

/** An access point's radio as it ships: SSID `Default`, open, on channel 6. */
export const DEFAULT_RADIO: WirelessRadio = DEFAULT_HOME_ROUTER.radio;
