import {
  addDevice,
  addLink,
  createDevice,
  createLink,
  createIdSource,
  emptyTopology,
  Hostname,
  InterfaceId,
  Ipv4Address,
  Ipv4Cidr,
  PortId,
  VirtualInterfaceId,
  VlanId,
  type Device,
  type DeviceId,
  type DeviceKind,
  type LinkSpec,
  type RoutedInterface,
  type StaticRoute,
  type SwitchInterface,
  type Topology,
} from '@/model';
import { expectOk } from '@/model/testing';
import { ms, simTime, type SimDuration } from './core/time';
import { STP_TIMES, type StpTimes } from './l2/stp';
import type { SimModule, Stacks } from './module';

/** How long a new switch port takes to forward on a profile: a forward delay each to listen and learn. */
const convergence = (profile: StpTimes) => simTime(2 * profile.forwardDelay * 1000);

/** When a lab loaded at time 0 has every switch port forwarding on the default fast timers: 4 s. */
export const STP_CONVERGED = convergence(STP_TIMES.fast);

/** The same on the real IOS timers: 30 s. */
export const STP_CONVERGED_IOS = convergence(STP_TIMES.ios);

export function stacksOf(modules: Partial<Record<DeviceKind, readonly SimModule[]>>): Stacks {
  return { router: [], switch: [], pc: [], server: [], ...modules };
}

const noteHooks = {
  onLinkChange: (ctx, port, up) => ctx.note(`${port} ${up ? 'up' : 'down'}`),
  onConfigChange: (ctx) => ctx.note('config changed'),
  onFrame: (ctx, port, frame) => {
    if (frame.kind === 'hello') ctx.note(`hello ${frame.seq} from ${frame.origin} on ${port}`);
  },
} satisfies Partial<SimModule<unknown>>;

/** Receives frames and notes every hook. Never sends. */
export const listenerModule: SimModule<null> = { id: 'listener', init: () => null, ...noteHooks };

/**
 * Sends a hello frame out of every port when the device boots, then every `period` plus up to
 * `jitter` of seeded randomness. Without a period it sends once.
 */
export function helloModule({
  period,
  jitter = ms(0),
}: { period?: SimDuration; jitter?: SimDuration } = {}): SimModule<{ seq: number }> {
  return {
    id: 'hello',
    init: (ctx) => {
      ctx.setTimer('hello', ms(0));
      return { seq: 0 };
    },
    onTimer: (ctx) => {
      ctx.state.seq += 1;
      for (const port of ctx.device.ports) {
        ctx.send(port.id, { kind: 'hello', origin: ctx.device.id, seq: ctx.state.seq });
      }
      if (period !== undefined) ctx.setTimer('hello', ms(period + ctx.random() * jitter));
    },
    ...noteHooks,
  };
}

export const cidr = (text: string): Ipv4Cidr => {
  const [address, prefixLength] = text.split('/');
  return Ipv4Cidr.parse({ address, prefixLength: Number(prefixLength) });
};

export const ip = (text: string) => Ipv4Address.parse(text);

/** `via` is a next-hop address or an exit interface name. */
export function staticRoute(prefix: string, via: string): StaticRoute {
  const address = Ipv4Address.safeParse(via);
  return {
    prefix: cidr(prefix),
    nextHop: address.success
      ? { kind: 'address', address: address.data }
      : { kind: 'interface', interface: InterfaceId.parse(via) },
  };
}

export const access = (vlan: number): SwitchInterface['switchport'] => ({
  mode: 'access',
  vlan: VlanId.parse(vlan),
});

export const trunk = (nativeVlan = 1): SwitchInterface['switchport'] => ({
  mode: 'trunk',
  nativeVlan: VlanId.parse(nativeVlan),
});

const ports = (kind: 'fastEthernet' | 'gigabitEthernet' | 'serial', names: string[]) =>
  names.map((name) => ({ kind, id: PortId.parse(name) }));

const SWITCH_PORTS = [
  ...ports(
    'fastEthernet',
    Array.from({ length: 8 }, (_, n) => `FastEthernet0/${n + 1}`),
  ),
  ...ports('gigabitEthernet', ['GigabitEthernet0/1', 'GigabitEthernet0/2']),
];

const ROUTER_PORTS = [
  ...ports('gigabitEthernet', ['GigabitEthernet0/0', 'GigabitEthernet0/1', 'GigabitEthernet0/2']),
  ...ports('serial', ['Serial0/0/0', 'Serial0/0/1']),
];

/**
 * Builds a lab in code, one device or cable at a time, through the model's own commands. Devices
 * are created powered on with the model's factory config, then given the addressing a test needs.
 */
export function labBuilder(seed = 1) {
  const ids = createIdSource(seed);
  let topology = emptyTopology({ name: 'Lab', now: new Date('2026-01-01T00:00:00.000Z') });
  const base = { position: { x: 0, y: 0 } };

  const add = (device: Device) => {
    topology = expectOk(addDevice(topology, device));
    return device.id;
  };

  return {
    get topology(): Topology {
      return topology;
    },
    device: (id: DeviceId): Device => topology.devices[id]!,

    /** A host whose config asks for DHCP. */
    dhcpHost(kind: 'pc' | 'server', name: string): DeviceId {
      const device = createDevice(
        {
          ...base,
          kind,
          model: kind,
          hostname: Hostname.parse(name),
          ports: ports('fastEthernet', ['FastEthernet0']),
        },
        { ids, topology },
      );
      if (device.kind !== 'pc' && device.kind !== 'server') throw new Error('not a host');
      device.config.ipv4 = { mode: 'dhcp' };
      return add(device);
    },

    /** Replaces a device with `edit`'s copy of it, as a config edit would. */
    edit(id: DeviceId, edit: (device: Device) => Device): void {
      topology = {
        ...topology,
        devices: { ...topology.devices, [id]: edit(topology.devices[id]!) },
      };
    },

    host(kind: 'pc' | 'server', name: string, address?: string, gateway?: string): DeviceId {
      const device = createDevice(
        {
          ...base,
          kind,
          model: kind,
          hostname: Hostname.parse(name),
          ports: ports('fastEthernet', ['FastEthernet0']),
        },
        { ids, topology },
      );
      if (device.kind !== 'pc' && device.kind !== 'server') throw new Error('not a host');
      device.config.ipv4 = {
        mode: 'static',
        address: address === undefined ? undefined : cidr(address),
        gateway: gateway === undefined ? undefined : ip(gateway),
      };
      return add(device);
    },

    switch(
      name: string,
      switchports: Record<string, SwitchInterface['switchport']> = {},
    ): DeviceId {
      const device = createDevice(
        {
          ...base,
          kind: 'switch',
          model: 'switch',
          hostname: Hostname.parse(name),
          ports: SWITCH_PORTS,
        },
        { ids, topology },
      );
      if (device.kind !== 'switch') throw new Error('not a switch');
      for (const [name, switchport] of Object.entries(switchports)) {
        device.config.interfaces[PortId.parse(name)] = { shutdown: false, switchport };
        // As `switchport access vlan` does: a port in a VLAN the switch lacks would stay inactive.
        if (switchport.mode === 'access') {
          const vlan = switchport.vlan;
          device.config.vlans[vlan] ??= { name: `VLAN${String(vlan).padStart(4, '0')}` };
        }
      }
      return add(device);
    },

    /** Interfaces named in `addresses` come up with that address. The rest stay shut down. */
    router(
      name: string,
      addresses: Record<string, string>,
      staticRoutes: StaticRoute[] = [],
    ): DeviceId {
      const device = createDevice(
        {
          ...base,
          kind: 'router',
          model: 'router',
          hostname: Hostname.parse(name),
          ports: ROUTER_PORTS,
        },
        { ids, topology },
      );
      if (device.kind !== 'router') throw new Error('not a router');
      for (const [name, address] of Object.entries(addresses)) {
        const routed: RoutedInterface = { shutdown: false, ipv4: cidr(address) };
        if (name.startsWith('Loopback'))
          device.config.virtualInterfaces[VirtualInterfaceId.parse(name)] = routed;
        else device.config.interfaces[PortId.parse(name)] = routed;
      }
      device.config.staticRoutes = staticRoutes;
      return add(device);
    },

    connect(a: DeviceId, aPort: string, b: DeviceId, bPort: string): void {
      const ends = {
        a: { device: a, port: PortId.parse(aPort) },
        b: { device: b, port: PortId.parse(bPort) },
      };
      const spec: LinkSpec = aPort.startsWith('Serial')
        ? { cable: 'serial', ...ends, dce: 'a' }
        : { cable: 'straight', ...ends };
      topology = expectOk(addLink(topology, createLink(spec, { ids, topology })));
    },
  };
}

/** PC1 192.168.1.10 on SW1, R1 between 192.168.1.0/24 and 192.168.2.0/24, PC2 192.168.2.10 on SW2. */
export function routedLab(r1Routes: StaticRoute[] = []) {
  const lab = labBuilder();
  const sw1 = lab.switch('SW1');
  const sw2 = lab.switch('SW2');
  const pc1 = lab.host('pc', 'PC1', '192.168.1.10/24', '192.168.1.1');
  const pc2 = lab.host('pc', 'PC2', '192.168.2.10/24', '192.168.2.1');
  const r1 = lab.router(
    'R1',
    { 'GigabitEthernet0/0': '192.168.1.1/24', 'GigabitEthernet0/1': '192.168.2.1/24' },
    r1Routes,
  );
  lab.connect(pc1, 'FastEthernet0', sw1, 'FastEthernet0/1');
  lab.connect(sw1, 'GigabitEthernet0/1', r1, 'GigabitEthernet0/0');
  lab.connect(r1, 'GigabitEthernet0/1', sw2, 'GigabitEthernet0/1');
  lab.connect(pc2, 'FastEthernet0', sw2, 'FastEthernet0/1');
  return { lab, pc1, pc2, r1, sw1, sw2 };
}
