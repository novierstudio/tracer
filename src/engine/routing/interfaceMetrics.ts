import type { InterfaceId, Ipv4Address, PortId, RoutedInterface } from '@/model';
import { ipInterfaces, type IpInterface, type RoutingDevice } from '../l3/interfaces';
import { compareAddresses } from '../l3/ipv4';
import type { DeviceContext } from '../module';

/**
 * What routing protocols read of a router's or multilayer switch's interfaces: their settings,
 * speed and router ID.
 */

/** The settings routing protocols read from an interface's config. */
type MetricSettings = Pick<RoutedInterface, 'ospfCost' | 'ospfPriority' | 'bandwidth' | 'delay'>;

/**
 * The config an interface's own settings live in: its port, a router's subinterface, or a
 * loopback or VLAN interface.
 */
export function settingsOf(device: RoutingDevice, name: InterfaceId): MetricSettings | undefined {
  const { config } = device;
  const lookup = (record: object) => (record as Partial<Record<string, MetricSettings>>)[name];
  return (
    lookup(config.interfaces) ??
    ('subinterfaces' in config ? lookup(config.subinterfaces) : undefined) ??
    lookup(config.virtualInterfaces)
  );
}

/** An Ethernet port's speed in Mbit/s: its `speed`, else the fastest its kind runs at. */
function ethernetSpeed(device: RoutingDevice, port: PortId) {
  const kind = device.ports.find((candidate) => candidate.id === port)?.kind;
  return device.config.interfaces[port]?.speed ?? (kind === 'gigabitEthernet' ? 1000 : 100);
}

/**
 * The interface's bandwidth in kbit/s: its `bandwidth`, else what IOS gives its kind. A
 * subinterface takes its port's speed, and a 3560's VLAN interface claims 1 Gbit/s.
 */
export function bandwidthOf(device: RoutingDevice, ip: IpInterface): number {
  const configured = settingsOf(device, ip.name)?.bandwidth;
  if (configured !== undefined) return configured;
  switch (ip.medium.kind) {
    case 'loopback':
      return 8_000_000;
    case 'serial':
      return 1544;
    case 'ethernet':
      return ethernetSpeed(device, ip.medium.port) * 1000;
    case 'svi':
      return 1_000_000;
  }
}

/**
 * The interface's delay in tens of microseconds: its `delay`, else what IOS gives its kind, as
 * `show interfaces` prints it in microseconds: 10 at 1 Gbit/s, 100 at 100 Mbit/s and 1000 at
 * 10 Mbit/s, 20000 on a serial link and 5000 on a loopback.
 */
export function delayOf(device: RoutingDevice, ip: IpInterface): number {
  const configured = settingsOf(device, ip.name)?.delay;
  if (configured !== undefined) return configured;
  switch (ip.medium.kind) {
    case 'loopback':
      return 500;
    case 'serial':
      return 2000;
    case 'ethernet':
      return 1000 / ethernetSpeed(device, ip.medium.port);
    case 'svi':
      return 1;
  }
}

/** The configured router ID, else the highest loopback address, else the highest interface address. */
export function pickRouterId(
  ctx: DeviceContext,
  configured: Ipv4Address | undefined,
): Ipv4Address | undefined {
  if (configured) return configured;
  const interfaces = ipInterfaces(ctx.device, ctx, undefined);
  const highest = (list: readonly IpInterface[]) =>
    list
      .map((iface) => iface.cidr.address)
      .sort(compareAddresses)
      .at(-1);
  return (
    highest(interfaces.filter((iface) => iface.medium.kind === 'loopback')) ?? highest(interfaces)
  );
}
