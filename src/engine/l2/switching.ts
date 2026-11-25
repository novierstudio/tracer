import type { Device, MacAddress, PortId, Switchport, VlanId } from '@/model';
import { carriesVlan, vlanAllowed } from '@/model/vlans';
import { ms, type SimTime } from '../core/time';
import type { SimModule } from '../module';
import type { EthernetFrame } from '../pdu';

/** How long a learned address stays without traffic from it. The IOS default. */
export const MAC_AGING = ms(300_000);

export type MacTableEntry = {
  readonly vlan: VlanId;
  readonly mac: MacAddress;
  readonly port: PortId;
};

type Learned = MacTableEntry & { readonly learnedAt: SimTime };

/** Learned addresses by VLAN and MAC: one MAC can sit in two VLANs. An expired entry counts as absent. */
export type SwitchState = { readonly table: Map<string, Learned> };

const tableKey = (vlan: VlanId, mac: MacAddress) => `${vlan} ${mac}`;

/** Broadcast and multicast addresses have the group bit set in their first octet. */
const isGroup = (mac: MacAddress) => (parseInt(mac.slice(0, 2), 16) & 1) === 1;

const fresh = (entry: Learned, now: SimTime) => now - entry.learnedAt < MAC_AGING;

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
export function vlanPorts(device: Extract<Device, { kind: 'switch' }>, vlan: VlanId) {
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
 * A transparent bridge. It learns each source address on its port and VLAN, sends a frame for a
 * known address out that one port, floods the rest out every other up port in the VLAN, and never
 * sends a frame back out the port it arrived on.
 */
export const switchingModule: SimModule<SwitchState> = {
  id: 'switching',
  init: () => ({ table: new Map() }),
  onFrame(ctx, ingress, frame) {
    const { device, now, state } = ctx;
    if (frame.kind !== 'ethernet' || device.kind !== 'switch') return;
    const interfaces = device.config.interfaces;
    const arrivedOn = interfaces[ingress];
    const vlan = arrivedOn && ingressVlan(arrivedOn.switchport, frame);
    if (vlan === undefined) return;

    if (!isGroup(frame.src)) {
      state.table.set(tableKey(vlan, frame.src), {
        vlan,
        mac: frame.src,
        port: ingress,
        learnedAt: now,
      });
    }
    if (ownAddress(device, frame.dst)) return;
    const known = isGroup(frame.dst) ? undefined : state.table.get(tableKey(vlan, frame.dst));
    const out = known && fresh(known, now) ? [known.port] : device.ports.map((port) => port.id);

    for (const port of out) {
      const switchport = interfaces[port]?.switchport;
      if (port === ingress || !switchport || !carriesVlan(switchport, vlan) || !ctx.portUp(port))
        continue;
      ctx.send(port, egressFrame(switchport, vlan, frame));
    }
  },
  onLinkChange(ctx, port, up) {
    if (!up) forget(ctx.state, (entry) => entry.port === port);
  },
  onConfigChange(ctx) {
    const { device } = ctx;
    if (device.kind !== 'switch') return;
    forget(ctx.state, (entry) => {
      const switchport = device.config.interfaces[entry.port]?.switchport;
      return !switchport || !carriesVlan(switchport, entry.vlan);
    });
  },
};

/** The addresses the switch knows now, by VLAN then MAC, as `show mac address-table` lists them. */
export function macTable(state: SwitchState, now: SimTime): MacTableEntry[] {
  return [...state.table.values()]
    .filter((entry) => fresh(entry, now))
    .sort((a, b) => a.vlan - b.vlan || a.mac.localeCompare(b.mac))
    .map(({ vlan, mac, port }) => ({ vlan, mac, port }));
}
