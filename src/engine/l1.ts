import type { Device, Link, PortId } from '@/model';
import type { Association } from '@/model/wireless';
import { CABLE_MEDIUM, copperWorks, portMedium } from '@/model/cabling';

function adminUp(device: Device, port: PortId): boolean {
  switch (device.kind) {
    case 'router':
    case 'switch':
      return device.config.interfaces[port]?.shutdown === false;
    case 'pc':
    case 'server':
    case 'hub':
    case 'accessPoint':
    case 'wirelessRouter':
    case 'lightweightAp':
    case 'wlc':
    case 'cellTower':
    case 'centralOffice':
      return true;
    default: {
      const exhaustive: never = device;
      return exhaustive;
    }
  }
}

/** One end of a link is up when its device is powered, its port is not shut down and the cable fits it. */
function endUp(device: Device | undefined, port: PortId, link: Link) {
  if (!device?.powered) return undefined;
  const found = device.ports.find((candidate) => candidate.id === port);
  // A console cable carries the CLI from a PC's Terminal app, never frames, so it never comes up.
  const fits =
    found !== undefined &&
    link.cable !== 'console' &&
    portMedium(found) === CABLE_MEDIUM[link.cable] &&
    adminUp(device, port);
  return fits ? { kind: device.kind, port, portKind: found.kind } : undefined;
}

/**
 * A link is up when both ends are and the cable works between them. A copper link between Fast
 * Ethernet ports stays down on the wrong cable, as in Packet Tracer: see `copperWorks`.
 */
export function linkUp(
  link: Link | Association,
  a: Device | undefined,
  b: Device | undefined,
): boolean {
  // An association exists only while both ends are powered and the radio admits the client.
  if (link.cable === 'wireless') return !!a?.powered && !!b?.powered;
  const aEnd = endUp(a, link.a.port, link);
  const bEnd = endUp(b, link.b.port, link);
  if (!aEnd || !bEnd) return false;
  if (link.cable !== 'straight' && link.cable !== 'crossover') return true;
  return copperWorks(link.cable, aEnd, bEnd);
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
