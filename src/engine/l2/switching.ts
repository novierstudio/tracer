import type { Device, LabSettings, MacAddress, PortId, Switchport, VlanId } from '@/model';
import { carriesVlan, vlanAllowed } from '@/model/vlans';
import { ms, type SimDuration, type SimTime } from '../core/time';
import type { DeviceContext, ModuleContext, SimModule } from '../module';
import type { SwitchL2Status } from './status';
import { CDP_MAC, LLDP_MAC, PVST_MAC, SLOW_PROTOCOLS_MAC, type EthernetFrame } from '../pdu';
import {
  bridgePortUp,
  bridgeView,
  bundled,
  createChannelState,
  etherchannelStatus,
  isPortChannel,
  logicalPort,
  logicalPorts,
  memberFor,
  onChannelTimer,
  portChannelPort,
  receiveChannelPdu,
  syncChannels,
  type ChannelChange,
  type ChannelState,
} from './etherchannel';
import {
  checkSource,
  createSecurityState,
  errDisabledPorts,
  forgetDynamic,
  isErrDisabled,
  onSecurityTimer,
  portSecurityStatus,
  syncSecurity,
  type SecurityState,
} from './portSecurity';
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
export type SwitchState = {
  readonly table: Map<string, Learned>;
  readonly stp: StpState;
  readonly channel: ChannelState;
  readonly security: SecurityState;
};

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

/**
 * Spanning tree's view of the switch: its bridge view, where each port-channel in use is one port
 * and bundled members are none. A port-channel's BPDUs leave by its first bundled member.
 */
function stpContext(ctx: DeviceContext, device: Switch, state: SwitchState): StpContext {
  const view = bridgeView(device, state.channel);
  return {
    get now() {
      return ctx.now;
    },
    device: view,
    get settings() {
      return ctx.settings;
    },
    portUp: (port) => bridgePortUp(ctx, device, state.channel, port),
    setTimer: (key, delay) => ctx.setTimer(key, delay),
    clearTimer: (key) => ctx.clearTimer(key),
    note: (text) => ctx.note(text),
    sendBpdu(port, vlan, bpdu) {
      const switchport = view.config.interfaces[port]?.switchport;
      const out = isPortChannel(port) ? bundled(state.channel, device, groupOf(port))[0] : port;
      const hardware = device.ports.find((candidate) => candidate.id === out);
      if (!switchport || !out || !hardware || hardware.kind === 'serial') return;
      const frame: EthernetFrame = {
        kind: 'ethernet',
        dst: PVST_MAC,
        src: hardware.mac,
        payload: bpdu,
      };
      ctx.send(out, egressFrame(switchport, vlan, frame));
    },
  };
}

const groupOf = (port: PortId) => Number(port.slice('Port-channel'.length));

/** `%LINK-3-UPDOWN` and `%LINEPROTO-5-UPDOWN` for a port-channel that came up or went down. */
function announceChannels(ctx: DeviceContext, change: ChannelChange) {
  for (const [groups, state] of [
    [change.up, 'up'],
    [change.down, 'down'],
  ] as const) {
    for (const group of groups) {
      const name = portChannelPort(group);
      ctx.syslog(`%LINK-3-UPDOWN: Interface ${name}, changed state to ${state}`);
      ctx.syslog(
        `%LINEPROTO-5-UPDOWN: Line protocol on Interface ${name}, changed state to ${state}`,
      );
    }
  }
}

/** Forgets addresses learned on a port the bridge no longer has, as a member that joined a bundle. */
function forgetGonePorts(device: Switch, state: SwitchState) {
  const ports = new Set(logicalPorts(device, state.channel));
  forget(state, (entry) => !ports.has(entry.port));
}

/** Brings EtherChannel, the MAC table and spanning tree in line with the config and links. */
function sync(ctx: DeviceContext, state: SwitchState, change?: ChannelChange) {
  const { device } = ctx;
  if (device.kind !== 'switch') return;
  announceChannels(ctx, change ?? syncChannels(ctx, device, state.channel));
  forgetGonePorts(device, state);
  syncStp(stpContext(ctx, device, state), state.stp);
}

/** The bridge's own control frames: CDP, LLDP, LACP and PAgP never cross a switch. */
const isLinkLocal = (frame: EthernetFrame) =>
  frame.dst === CDP_MAC || frame.dst === LLDP_MAC || frame.dst === SLOW_PROTOCOLS_MAC;

/**
 * A transparent bridge. It learns each source address on its port and VLAN, sends a frame for a
 * known address out that one port, floods the rest out every other up port in the VLAN, and never
 * sends a frame back out the port it arrived on. Spanning tree decides which ports take part: a
 * port learns once it is learning or forwarding, and only a forwarding port relays frames.
 *
 * An EtherChannel is one port to the bridge: it learns addresses on the port-channel, spanning
 * tree runs on it, and a frame out of it leaves by the member its addresses hash to. Port
 * security checks each frame's source on a secure port before the bridge learns it.
 */
export const switchingModule: SimModule<SwitchState> = {
  id: 'switching',
  init(ctx) {
    const state: SwitchState = {
      table: new Map(),
      stp: new Map(),
      channel: createChannelState(),
      security: createSecurityState(),
    };
    sync(ctx, state);
    return state;
  },
  onFrame(ctx, ingress, frame) {
    const { device, now, state } = ctx;
    if (frame.kind !== 'ethernet' || device.kind !== 'switch') return;
    const { payload } = frame;
    if (payload.kind === 'lacp' || payload.kind === 'pagp') {
      const change = receiveChannelPdu(ctx, device, state.channel, ingress, payload);
      if (change?.membership) sync(ctx, state, change);
      return;
    }
    if (isLinkLocal(frame)) return;
    const logical = logicalPort(device, state.channel, ingress);
    if (logical === undefined) return;
    const interfaces = bridgeView(device, state.channel).config.interfaces;
    const arrivedOn = interfaces[logical];
    const vlan = arrivedOn?.switchport && ingressVlan(arrivedOn.switchport, frame);
    if (vlan === undefined) return;

    prune(state, now);
    if (payload.kind === 'bpdu') {
      receiveBpdu(stpContext(ctx, device, state), state.stp, vlan, logical, payload);
      return;
    }
    const arrivedState = portState(state.stp, vlan, logical);
    if (arrivedState !== 'learning' && arrivedState !== 'forwarding') return;
    if (!isGroup(frame.src)) {
      const verdict = checkSource(ctx, device, state.security, ingress, vlan, frame.src);
      if (verdict === 'err-disable') ctx.relink();
      if (verdict !== 'forward') return;
      state.table.set(tableKey(vlan, frame.src), {
        vlan,
        mac: frame.src,
        port: logical,
        learnedAt: now,
      });
    }
    if (arrivedState !== 'forwarding' || ownAddress(device, frame.dst)) return;
    const known = isGroup(frame.dst) ? undefined : state.table.get(tableKey(vlan, frame.dst));
    const out = known ? [known.port] : logicalPorts(device, state.channel);

    for (const port of out) {
      const switchport = interfaces[port]?.switchport;
      if (port === logical || !switchport || portState(state.stp, vlan, port) !== 'forwarding')
        continue;
      const member = isPortChannel(port)
        ? memberFor(device, state.channel, groupOf(port), frame)
        : port;
      if (member) ctx.send(member, egressFrame(switchport, vlan, frame));
    }
  },
  onTimer(ctx, key) {
    const { device, state } = ctx;
    if (device.kind !== 'switch') return;
    prune(state, ctx.now);
    const change = onChannelTimer(ctx, device, state.channel, key);
    if (change?.membership) sync(ctx, state, change);
    if (change || key.startsWith('ec ')) return;
    if (onSecurityTimer(ctx, state.security, key)) {
      ctx.relink();
      return;
    }
    onStpTimer(stpContext(ctx, device, state), state.stp, key);
  },
  onLinkChange(ctx, port, up) {
    if (!up) {
      forget(ctx.state, (entry) => entry.port === port);
      forgetDynamic(ctx.state.security, port);
    }
    sync(ctx, ctx.state);
  },
  onConfigChange(ctx) {
    const { device, state } = ctx;
    if (device.kind !== 'switch') return;
    const recovered = syncSecurity(ctx, device, state.security);
    const interfaces = bridgeView(device, state.channel).config.interfaces;
    forget(state, (entry) => {
      const switchport = interfaces[entry.port]?.switchport;
      return !switchport || !carriesVlan(switchport, entry.vlan);
    });
    sync(ctx, state);
    if (recovered) ctx.relink();
  },
  holdsPort(ctx, port) {
    const { device, state } = ctx;
    const logical = device.kind === 'switch' ? logicalPort(device, state.channel, port) : port;
    return logical === undefined || isHeld(state.stp, logical);
  },
  holdsVlan(ctx, port, vlan) {
    const { device, state } = ctx;
    const logical = device.kind === 'switch' ? logicalPort(device, state.channel, port) : port;
    return logical === undefined || portState(state.stp, vlan, logical) !== 'forwarding';
  },
  disablesPort: (ctx, port) => isErrDisabled(ctx.state.security, port),
  bundleOf(ctx, port) {
    const { device, state } = ctx;
    if (device.kind !== 'switch') return undefined;
    const logical = logicalPort(device, state.channel, port);
    return logical !== undefined && isPortChannel(logical) ? logical : undefined;
  },
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
  const view = bridgeView(device, state.channel);
  return spanningTree(view, state.stp, own, (instance) => agingOf(instance) / 1000);
}

export type { SpanningTreeVlan };

/** The switch's EtherChannels and port security, for their show commands. */
export function switchL2Status(ctx: ModuleContext<SwitchState>): SwitchL2Status {
  const { device, state } = ctx;
  if (device.kind !== 'switch') return { etherchannels: [], portSecurity: [], errDisabled: [] };
  return {
    etherchannels: etherchannelStatus(device, state.channel),
    portSecurity: portSecurityStatus(ctx, device, state.security),
    errDisabled: errDisabledPorts(state.security),
  };
}
