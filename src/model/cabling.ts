// No runtime imports: the simulation worker uses these, and must not pull in zod.
import { portOf, type ConsolePortKind } from './remote';
import type { Cable, DeviceKind, Endpoint, Link, PortId, PortKind, Topology } from './topology';

/** What a cable is made of, and so which ports it plugs into. */
export type Medium = 'copper' | 'fiber' | 'coaxial' | 'serial' | 'console' | 'wireless';

/** A network port or a console port: anything a cable plugs into, or a radio, which none does. */
export type JackKind = PortKind | ConsolePortKind;

/** A port as far as cabling cares: its kind, and whether an Ethernet port is fiber or coaxial. */
export type Jack = { readonly kind: JackKind; readonly fiber?: true; readonly coaxial?: true };

const JACK_MEDIUM: Record<JackKind, Medium> = {
  fastEthernet: 'copper',
  gigabitEthernet: 'copper',
  serial: 'serial',
  wireless: 'wireless',
  console: 'console',
  rs232: 'console',
};

export const portMedium = (jack: Jack): Medium =>
  jack.fiber ? 'fiber' : jack.coaxial ? 'coaxial' : JACK_MEDIUM[jack.kind];

export const CABLE_MEDIUM: Record<Cable, Medium> = {
  straight: 'copper',
  crossover: 'copper',
  fiber: 'fiber',
  coaxial: 'coaxial',
  serial: 'serial',
  console: 'console',
};

/** The port on a home wireless router that faces the ISP. Its other Ethernet ports are its LAN. */
export const WAN_PORT = 'Internet' as PortId;

/** One end of a copper link: the device's kind, and the port's name and kind. */
export type CopperEnd = {
  readonly kind: DeviceKind;
  readonly port: PortId;
  readonly portKind: JackKind;
};

/**
 * Whether a copper port receives on the pins hosts and routers transmit on (MDI-X), as switch,
 * hub and home router LAN ports do. Like ports take a crossover cable and unlike ports a
 * straight-through one. An access point's Ethernet port and a home router's Internet port are
 * MDI, as a host's is, so each takes a straight-through cable to a switch.
 */
export function isMdiX(end: CopperEnd): boolean {
  switch (end.kind) {
    case 'switch':
    case 'hub':
      return true;
    case 'wirelessRouter':
      return end.port !== WAN_PORT;
    case 'centralOffice':
      return end.port !== 'Backbone';
    case 'router':
    case 'pc':
    case 'server':
    case 'accessPoint':
    case 'lightweightAp':
    case 'wlc':
    case 'cellTower':
      return false;
    default: {
      const exhaustive: never = end.kind;
      return exhaustive;
    }
  }
}

/** The copper cable that is right between two Ethernet ports. */
export const copperCable = (a: CopperEnd, b: CopperEnd): 'straight' | 'crossover' =>
  isMdiX(a) === isMdiX(b) ? 'crossover' : 'straight';

/**
 * Whether a copper link comes up on `cable`. As in Packet Tracer, GigabitEthernet ports run
 * auto-MDIX, so a link with a Gigabit end works on either cable. Fast Ethernet ports do not: two
 * of them come up only on the right cable, so PC to PC and switch to switch take a crossover,
 * and PC to switch a straight-through.
 */
export const copperWorks = (cable: 'straight' | 'crossover', a: CopperEnd, b: CopperEnd) =>
  a.portKind === 'gigabitEthernet' ||
  b.portKind === 'gigabitEthernet' ||
  cable === copperCable(a, b);

/** One end of a cable: the device's kind, and the port's name, kind and medium. */
export type CableEnd = { readonly device: DeviceKind; readonly id: PortId; readonly port: Jack };

/**
 * The cable Packet Tracer's automatic cable picks, or undefined when the ends take different
 * cables, such as serial and copper, or two Console ports. Between copper ports it picks the one
 * that works: crossover between like ports, straight-through between unlike ones.
 */
export function autoCable(a: CableEnd, b: CableEnd): Cable | undefined {
  const medium = portMedium(a.port);
  if (medium !== portMedium(b.port)) return undefined;
  if (medium === 'serial' || medium === 'fiber' || medium === 'coaxial') return medium;
  if (medium === 'console') return a.port.kind === b.port.kind ? undefined : 'console';
  return copperCable(
    { kind: a.device, port: a.id, portKind: a.port.kind },
    { kind: b.device, port: b.id, portKind: b.port.kind },
  );
}

/** The end at `endpoint` in the topology, if its device and port exist. */
export function cableEnd(topology: Topology, endpoint: Endpoint): CableEnd | undefined {
  const device = topology.devices[endpoint.device];
  const port = device && portOf(device, endpoint.port);
  return device && port && { device: device.kind, id: port.id, port };
}

/** Whether the link's cable works between its ends, as `copperWorks` judges a copper one. */
export function cableWorks(topology: Topology, link: Link): boolean {
  if (link.cable !== 'straight' && link.cable !== 'crossover') return true;
  const [a, b] = [link.a, link.b].map((endpoint) => cableEnd(topology, endpoint));
  if (!a || !b) return false;
  const copper = (end: CableEnd) => ({ kind: end.device, port: end.id, portKind: end.port.kind });
  return copperWorks(link.cable, copper(a), copper(b));
}
