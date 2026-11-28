// No runtime imports: the simulation worker uses these, and must not pull in zod.
import { WAN_PORT } from './cabling';
import type { DeviceId, LinkId } from './ids';
import type {
  AccessList,
  AclName,
  CentralOfficeConfig,
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

/**
 * The networks each lightweight AP broadcasts now: the WLANs of the controller it joined over
 * CAPWAP, which only the simulation knows. An AP that has joined none broadcasts nothing.
 */
export type ApBroadcasts = Readonly<Partial<Record<DeviceId, readonly WirelessProfile[]>>>;

/** A radio that takes Wi-Fi clients, with its port and the networks it offers on it. */
type OfferedRadio = { readonly port: PortId; readonly networks: readonly WirelessProfile[] };

/** The Wi-Fi networks a device offers: an access point's or home router's one, a joined LAP's WLANs. */
export function radioOf(device: Device, broadcasts: ApBroadcasts = {}): OfferedRadio | undefined {
  const port = device.ports.find(
    (candidate) => candidate.kind === 'wireless' && !candidate.cellular,
  );
  if (!port) return undefined;
  switch (device.kind) {
    case 'accessPoint':
    case 'wirelessRouter':
      return { port: port.id, networks: [device.config.radio] };
    case 'lightweightAp':
      return { port: port.id, networks: broadcasts[device.id] ?? [] };
    default:
      return undefined;
  }
}

/** A host's wireless NIC, if it has one in place of an Ethernet one. */
export function wirelessNic(device: Device): WirelessPort | undefined {
  if (device.kind !== 'pc' && device.kind !== 'server') return undefined;
  return device.ports.find(
    (port): port is WirelessPort => port.kind === 'wireless' && !port.cellular,
  );
}

/** A host's 3G/4G radio, as a smartphone's, which joins the nearest cell tower. */
export function cellularNic(device: Device): WirelessPort | undefined {
  if (device.kind !== 'pc' && device.kind !== 'server') return undefined;
  return device.ports.find(
    (port): port is WirelessPort => port.kind === 'wireless' && !!port.cellular,
  );
}

const sameSecurity = (a: WirelessSecurity, b: WirelessSecurity) =>
  a.mode === 'none' ? b.mode === 'none' : b.mode === a.mode && b.passphrase === a.passphrase;

/** Whether a network lets in a client: the same SSID, the same security and the same passphrase. */
export const admits = (network: WirelessProfile, profile: WirelessProfile) =>
  network.ssid === profile.ssid && sameSecurity(network.security, profile.security);

/**
 * A host associated with a radio: a wireless link from the host's NIC (`a`) to an access point's,
 * home router's or lightweight AP's radio, or to a cell tower (`b`). The engine and the canvas
 * derive it from the devices; files never store it.
 */
export type Association = {
  readonly id: LinkId;
  readonly cable: 'wireless';
  readonly a: Endpoint;
  readonly b: Endpoint;
};

/** The id of a host's association. It is not a stored link's id, so it never clashes with one. */
export const associationId = (client: DeviceId) => `wifi_${client}` as LinkId;

/** The id of a host's 3G/4G link to a cell tower. */
export const cellularId = (client: DeviceId) => `cell_${client}` as LinkId;

const distance = (a: Device, b: Device) =>
  Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);

function nearest<T extends { readonly device: Device }>(client: Device, candidates: readonly T[]) {
  let best: T | undefined;
  for (const candidate of candidates) {
    if (!best || distance(client, candidate.device) < distance(client, best.device)) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Every association the devices make now. A powered host with a wireless NIC joins the nearest
 * powered radio offering a network its profile matches, as Packet Tracer's PC Wireless app does
 * once it has the right SSID and key; a lightweight AP offers the WLANs `broadcasts` gives it. A
 * host with a 3G/4G radio joins the nearest powered cell tower. Radio frequencies are not
 * simulated: any distance, band and channel will do.
 */
export function associations(
  devices: Iterable<Device>,
  broadcasts: ApBroadcasts = {},
): Association[] {
  const all = [...devices].filter((device) => device.powered);
  const radios = all.flatMap((device) => {
    const offered = radioOf(device, broadcasts);
    return offered ? [{ device, ...offered }] : [];
  });
  const towers = all.flatMap((device) => {
    const port = device.kind === 'cellTower' && device.ports.find((p) => p.kind === 'wireless');
    return port ? [{ device, port: port.id }] : [];
  });
  const found: Association[] = [];
  for (const client of all) {
    const nic = wirelessNic(client);
    const profile = (client.kind === 'pc' || client.kind === 'server') && client.config.wireless;
    const radio =
      nic && profile
        ? nearest(
            client,
            radios.filter((offer) => offer.networks.some((network) => admits(network, profile))),
          )
        : undefined;
    if (nic && radio) {
      found.push({
        id: associationId(client.id),
        cable: 'wireless',
        a: { device: client.id, port: nic.id },
        b: { device: radio.device.id, port: radio.port },
      });
    }
    const modem = cellularNic(client);
    const tower = modem && nearest(client, towers);
    if (modem && tower) {
      found.push({
        id: cellularId(client.id),
        cable: 'wireless',
        a: { device: client.id, port: modem.id },
        b: { device: tower.device.id, port: tower.port },
      });
    }
  }
  return found;
}

/** A device that routes between an uplink and one LAN it serves by DHCP, as a home router does. */
export type Gateway = Extract<Device, { kind: 'wirelessRouter' | 'centralOffice' }>;

export const isGateway = (device: Device): device is Gateway =>
  device.kind === 'wirelessRouter' || device.kind === 'centralOffice';

/** A central office server's port toward the rest of the network. */
export const BACKBONE_PORT = 'Backbone' as PortId;

/** A gateway's uplink: a home router's Internet port, a central office server's Backbone. */
export const uplinkPort = (device: Gateway): PortId =>
  device.kind === 'centralOffice' ? BACKBONE_PORT : WAN_PORT;

/**
 * The ports a bridging device switches between: all of an access point's, lightweight AP's and
 * cell tower's, and a gateway's LAN.
 */
export function bridgedPorts(device: Device): PortId[] {
  switch (device.kind) {
    case 'accessPoint':
    case 'lightweightAp':
    case 'cellTower':
      return device.ports.map((port) => port.id);
    case 'wirelessRouter':
    case 'centralOffice': {
      const uplink = uplinkPort(device);
      return device.ports.filter((port) => port.id !== uplink).map((port) => port.id);
    }
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
export function dhcpLast(config: CentralOfficeConfig): Ipv4Address {
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
 * server, else the DNS servers its ISP leased it (`upstreamDns`), and PAT from the LAN to the
 * Internet port's address.
 */
export function homeRouterIos(
  config: CentralOfficeConfig,
  upstreamDns: readonly Ipv4Address[] = [],
): HomeRouterIos {
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
  const dns = config.wan.mode === 'static' ? config.wan.dns : upstreamDns[0];
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

/**
 * A Home Gateway as it ships, as Packet Tracer's DLC100: 192.168.25.1/24, DHCP from .100, and an
 * open network named HomeGateway.
 */
export const DEFAULT_HOME_GATEWAY: Omit<WirelessRouterConfig, 'hostname'> = {
  wan: { mode: 'dhcp' },
  lan: { address: '192.168.25.1' as Ipv4Address, prefixLength: 24 as PrefixLength },
  dhcp: { enabled: true, start: '192.168.25.100' as Ipv4Address, maxUsers: 50 },
  radio: { ssid: 'HomeGateway', security: { mode: 'none' }, channel: 6 },
};

/**
 * A central office server as it ships: no Backbone address yet, and the cell network
 * 172.16.1.0/24, whose phones it lends addresses from 172.16.1.100.
 */
export const DEFAULT_CENTRAL_OFFICE: Omit<CentralOfficeConfig, 'hostname'> = {
  wan: { mode: 'static' },
  lan: { address: '172.16.1.1' as Ipv4Address, prefixLength: 24 as PrefixLength },
  dhcp: { enabled: true, start: '172.16.1.100' as Ipv4Address, maxUsers: 50 },
};
