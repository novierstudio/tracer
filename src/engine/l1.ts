import type { Cable, Device, PortId, PortKind } from '@/model';

/**
 * The ports each cable fits. Every Ethernet port runs auto-MDIX, so straight-through and
 * crossover both work between any two copper ports. Hubs are not a device kind yet.
 */
const CABLE_FITS: Record<Cable, readonly PortKind[]> = {
  straight: ['fastEthernet', 'gigabitEthernet'],
  crossover: ['fastEthernet', 'gigabitEthernet'],
  serial: ['serial'],
  // It carries the CLI from a PC's Terminal app, never frames, so it never comes up.
  console: [],
};

function adminUp(device: Device, port: PortId): boolean {
  switch (device.kind) {
    case 'router':
    case 'switch':
      return device.config.interfaces[port]?.shutdown === false;
    case 'pc':
    case 'server':
      return true;
    default: {
      const exhaustive: never = device;
      return exhaustive;
    }
  }
}

/** One end of a link is up when its device is powered, its port is not shut down and the cable fits it. */
export function endUp(device: Device | undefined, port: PortId, cable: Cable): boolean {
  if (!device?.powered) return false;
  const kind = device.ports.find((candidate) => candidate.id === port)?.kind;
  return kind !== undefined && CABLE_FITS[cable].includes(kind) && adminUp(device, port);
}

/**
 * What a router or switch prints on its console as a port's link changes, as Packet Tracer does:
 * `%LINK-5-CHANGED`, then the line protocol. A port taken down by err-disable logs as IOS does,
 * line protocol first. Hosts print nothing.
 */
export function linkSyslog(
  device: Device | undefined,
  port: PortId,
  up: boolean,
  errDisabled: boolean,
): string[] {
  if (device?.kind !== 'router' && device?.kind !== 'switch') return [];
  const state = up ? 'up' : 'down';
  const protocol = `%LINEPROTO-5-UPDOWN: Line protocol on Interface ${port}, changed state to ${state}`;
  if (!up && errDisabled) {
    return [protocol, `%LINK-3-UPDOWN: Interface ${port}, changed state to down`];
  }
  const shut = !up && device.config.interfaces[port]?.shutdown === true;
  const link = `%LINK-5-CHANGED: Interface ${port}, changed state to ${shut ? 'administratively down' : state}`;
  return [link, protocol];
}
