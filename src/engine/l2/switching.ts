import type { Device, LabSettings, MacAddress, PortId, Switchport, VlanId } from '@/model';
import { carriesVlan, vlanAllowed } from '@/model/vlans';
import { ms, type SimDuration, type SimTime } from '../core/time';
import type { DeviceContext, SimModule } from '../module';
import { PVST_MAC, type EthernetFrame } from '../pdu';
import {
  isHeld,
  onStpTimer,
  portState,
  receiveBpdu,
  spanningTree,
  STP_TIMES,
  syncStp,
  type Instance,
  type SpanningTreeVlan,
  type StpContext,
  type StpState,
} from './stp';

/** How long a learned address stays without traffic from it. The IOS default. */
export const MAC_AGING = ms(300_000);

export type MacTableEntry = {
  readonly vlan: VlanId;
  readonly mac: MacAddress;
  readonly port: PortId;
};

type Learned = MacTableEntry & { readonly learnedAt: SimTime };

type Switch = Extract<Device, { kind: 'switch' }>;

/**
 * Learned addresses by VLAN and MAC: one MAC can sit in two VLANs. An expired entry counts as
 * absent. Spanning tree runs in the same module because the relay reads its port states on every
 * frame and ages addresses by its topology changes, and a module's state is its own.
 */
export type SwitchState = { readonly table: Map<string, Learned>; readonly stp: StpState };

const tableKey = (vlan: VlanId, mac: MacAddress) => `${vlan} ${mac}`;

/** Broadcast and multicast addresses have the group bit set in their first octet. */
const isGroup = (mac: MacAddress) => (parseInt(mac.slice(0, 2), 16) & 1) === 1;

/** Addresses age out after forward delay while the root reports a topology change, as in 802.1D. */
const agingOf = (instance: Instance | undefined): SimDuration =>
  instance?.topologyChange ? ms(instance.times.forwardDelay * 1000) : MAC_AGING;

const fresh = (state: SwitchState, entry: Learned, now: SimTime) =>
  now - entry.learnedAt < agingOf(state.stp.get(entry.vlan));

/**
 * The VLAN a frame arriving on a port belongs to, or undefined when the port drops it. An access
 * port drops tagged frames. A trunk reads the tag, takes an untagged frame as its native VLAN, and
 * drops a VLAN its allowed list leaves out. There is no DTP: a port is access or trunk as set.
 */
export function ingressVlan(switchport: Switchport, frame: EthernetFrame): VlanId | undefined {
  switch (switchport.mode) {
    case 'access':
      return frame.tag ? undefined : switchport.vlan;
    case 'trunk': {
      const vlan = frame.tag?.vlan ?? switchport.nativeVlan;
      return vlanAllowed(switchport.allowedVlans, vlan) ? vlan : undefined;
    }
  }
}

/** The frame as it leaves a port: tagged on a trunk unless it is in the native VLAN. */
export function egressFrame(
  switchport: Switchport,
  vlan: VlanId,
  frame: EthernetFrame,
): EthernetFrame {
  const { dst, src, payload } = frame;
  const tagged = switchport.mode === 'trunk' && vlan !== switchport.nativeVlan;
  return tagged
    ? { kind: 'ethernet', dst, src, tag: { vlan }, payload }
    : { kind: 'ethernet', dst, src, payload };
}

/** Every port that carries `vlan` out of a switch, with its switchport. */
export function vlanPorts(device: Switch, vlan: VlanId) {
  return device.ports.flatMap((port) => {
    const switchport = device.config.interfaces[port.id]?.switchport;
    return switchport && carriesVlan(switchport, vlan) ? [{ port: port.id, switchport }] : [];
  });
}

/** A frame for one of the switch's own addresses is for its management interface, not to switch. */
const ownAddress = (device: Device, mac: MacAddress) =>
  device.ports.some((port) => port.kind !== 'serial' && port.mac === mac);

function forget(state: SwitchState, drop: (entry: Learned) => boolean) {
  for (const [key, entry] of state.table) if (drop(entry)) state.table.delete(key);
}

/**
 * Drops expired addresses for good, so one that ages out during a topology change stays gone
 * after it. Runs before every frame and timer: before the BPDU or timer that ends the change.
 */
const prune = (state: SwitchState, now: SimTime) =>
  forget(state, (entry) => !fresh(state, entry, now));

/** Spanning tree's view of the switch. Its BPDUs leave from the port's own MAC, tagged as data. */
function stpContext(ctx: DeviceContext, device: Switch): StpContext {
  return {
    get now() {
      return ctx.now;
    },
    device,
    get settings() {
      return ctx.settings;
    },
    portUp: (port) => ctx.portUp(port),
    setTimer: (key, delay) => ctx.setTimer(key, delay),
    clearTimer: (key) => ctx.clearTimer(key),
    note: (text) => ctx.note(text),
    sendBpdu(port, vlan, bpdu) {
      const switchport = device.config.interfaces[port]?.switchport;
      const hardware = device.ports.find((candidate) => candidate.id === port);
      if (!switchport || !hardware || hardware.kind === 'serial') return;
      const frame: EthernetFrame = {
        kind: 'ethernet',
        dst: PVST_MAC,
        src: hardware.mac,
        payload: bpdu,
      };
      ctx.send(port, egressFrame(switchport, vlan, frame));
    },
  };
}

function sync(ctx: DeviceContext, state: SwitchState) {
  const { device } = ctx;
  if (device.kind === 'switch') syncStp(stpContext(ctx, device), state.stp);
}

/**
 * A transparent bridge. It learns each source address on its port and VLAN, sends a frame for a
 * known address out that one port, floods the rest out every other up port in the VLAN, and never
 * sends a frame back out the port it arrived on. Spanning tree decides which ports take part: a
 * port learns once it is learning or forwarding, and only a forwarding port relays frames.
 */
export const switchingModule: SimModule<SwitchState> = {
  id: 'switching',
  init(ctx) {
    const state: SwitchState = { table: new Map(), stp: new Map() };
    sync(ctx, state);
    return state;
  },
  onFrame(ctx, ingress, frame) {
    const { device, now, state } = ctx;
    if (frame.kind !== 'ethernet' || device.kind !== 'switch') return;
    const interfaces = device.config.interfaces;
    const arrivedOn = interfaces[ingress];
    const vlan = arrivedOn?.switchport && ingressVlan(arrivedOn.switchport, frame);
    if (vlan === undefined) return;

    prune(state, now);
    if (frame.payload.kind === 'bpdu') {
      receiveBpdu(stpContext(ctx, device), state.stp, vlan, ingress, frame.payload);
      return;
    }
    const arrivedState = portState(state.stp, vlan, ingress);
    if (arrivedState !== 'learning' && arrivedState !== 'forwarding') return;
    if (!isGroup(frame.src)) {
      state.table.set(tableKey(vlan, frame.src), {
        vlan,
        mac: frame.src,
        port: ingress,
        learnedAt: now,
      });
    }
    if (arrivedState !== 'forwarding' || ownAddress(device, frame.dst)) return;
    const known = isGroup(frame.dst) ? undefined : state.table.get(tableKey(vlan, frame.dst));
    const out = known ? [known.port] : device.ports.map((port) => port.id);

    for (const port of out) {
      const switchport = interfaces[port]?.switchport;
      if (port === ingress || !switchport || portState(state.stp, vlan, port) !== 'forwarding')
        continue;
      ctx.send(port, egressFrame(switchport, vlan, frame));
    }
  },
  onTimer(ctx, key) {
    const { device } = ctx;
    if (device.kind !== 'switch') return;
    prune(ctx.state, ctx.now);
    onStpTimer(stpContext(ctx, device), ctx.state.stp, key);
  },
  onLinkChange(ctx, port, up) {
    if (!up) forget(ctx.state, (entry) => entry.port === port);
    sync(ctx, ctx.state);
  },
  onConfigChange(ctx) {
    const { device } = ctx;
    if (device.kind !== 'switch') return;
    forget(ctx.state, (entry) => {
      const switchport = device.config.interfaces[entry.port]?.switchport;
      return !switchport || !carriesVlan(switchport, entry.vlan);
    });
    sync(ctx, ctx.state);
  },
  holdsPort: (ctx, port) => isHeld(ctx.state.stp, port),
  holdsVlan: (ctx, port, vlan) => portState(ctx.state.stp, vlan, port) !== 'forwarding',
};

/** The addresses the switch knows now, by VLAN then MAC, as `show mac address-table` lists them. */
export function macTable(state: SwitchState, now: SimTime): MacTableEntry[] {
  return [...state.table.values()]
    .filter((entry) => fresh(state, entry, now))
    .sort((a, b) => a.vlan - b.vlan || a.mac.localeCompare(b.mac))
    .map(({ vlan, mac, port }) => ({ vlan, mac, port }));
}

/** The switch's spanning tree instances, by VLAN, as `show spanning-tree` reports them. */
export function spanningTreeOf(
  device: Device,
  state: SwitchState,
  settings: LabSettings,
): SpanningTreeVlan[] {
  if (device.kind !== 'switch') return [];
  const own = STP_TIMES[settings.stpTimers];
  return spanningTree(device, state.stp, own, (instance) => agingOf(instance) / 1000);
}

export type { SpanningTreeVlan };
