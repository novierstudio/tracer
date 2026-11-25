import type { Cable, Device, PortId, PortKind } from '@/model';

/**
 * The ports each cable fits. Every Ethernet port runs auto-MDIX, so straight-through and
 * crossover both work between any two copper ports. Hubs are not a device kind yet.
 */
const CABLE_FITS: Record<Cable, readonly PortKind[]> = {
  straight: ['fastEthernet', 'gigabitEthernet'],
  crossover: ['fastEthernet', 'gigabitEthernet'],
  serial: ['serial'],
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
