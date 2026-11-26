// No runtime imports: the simulation worker uses these, and must not pull in zod.
import type { DeviceId } from './ids';
import type {
  Device,
  DeviceKind,
  Endpoint,
  LineConfig,
  Link,
  PortId,
  RouterConfig,
  SwitchConfig,
  Topology,
} from './topology';

/** A management port: a router or switch's Console port, or a PC's RS-232 serial port. */
export type ConsolePortKind = 'console' | 'rs232';

/** A port a console cable plugs into. It carries no network traffic, so it is not in `ports`. */
export type ConsolePort = { readonly kind: ConsolePortKind; readonly id: PortId };

const CONSOLE_PORTS: Readonly<Record<DeviceKind, ConsolePort | undefined>> = {
  router: { kind: 'console', id: 'Console' as PortId },
  switch: { kind: 'console', id: 'Console' as PortId },
  pc: { kind: 'rs232', id: 'RS232' as PortId },
  server: undefined,
};

/** Every router and switch has a Console port, and every PC an RS-232 port. Servers have neither. */
export const consolePortOf = (kind: DeviceKind): ConsolePort | undefined => CONSOLE_PORTS[kind];

/** The device's port named `id`: one of its network ports, or its console port. */
export function portOf(device: Device, id: PortId) {
  const console = consolePortOf(device.kind);
  return device.ports.find((port) => port.id === id) ?? (console?.id === id ? console : undefined);
}

/** The far end of the console cable in `device`'s console or RS-232 port, if one is plugged in. */
export function consolePeer(topology: Topology, device: DeviceId): Endpoint | undefined {
  const own = topology.devices[device];
  const port = own && consolePortOf(own.kind);
  if (!port) return undefined;
  const link = Object.values(topology.links).find(
    (candidate): candidate is Link =>
      candidate.cable === 'console' &&
      [candidate.a, candidate.b].some((end) => end.device === device && end.port === port.id),
  );
  if (!link) return undefined;
  return link.a.device === device ? link.b : link.a;
}

/** What opens a session on a vty line. */
export type RemoteProtocol = 'telnet' | 'ssh';

export const REMOTE_PORTS: Readonly<Record<RemoteProtocol, number>> = { telnet: 23, ssh: 22 };

/** The smallest RSA key IOS will run SSH version 2 with. */
export const SSH_V2_MIN_MODULUS = 768;

type IosConfig = RouterConfig | SwitchConfig;

/** IOS runs an SSH server once it has RSA keys, and only version 2 needs keys of 768 bits or more. */
export function sshEnabled(config: IosConfig): boolean {
  const { rsaModulus, sshVersion } = config;
  if (rsaModulus === undefined) return false;
  return sshVersion !== 2 || rsaModulus >= SSH_V2_MIN_MODULUS;
}

/**
 * The vty line a new session takes: the lowest free one whose `transport input` lets the protocol
 * in, as IOS hunts for a line. Undefined when none does, and the connection is refused.
 */
export function vtyLineFor(
  lines: readonly LineConfig[],
  protocol: RemoteProtocol,
  busy: ReadonlySet<number>,
): number | undefined {
  const index = lines.findIndex((line, n) => !busy.has(n) && line.transportInput[protocol]);
  return index === -1 ? undefined : index;
}
