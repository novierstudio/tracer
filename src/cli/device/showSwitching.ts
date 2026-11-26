import type { MacTableEntry } from '../../engine/api';
import {
  formatVlans,
  normalizeVlans,
  vlanAllowed,
  type Port,
  type PortId,
  type Switchport,
  type VlanId,
} from '../../model';
import { shortInterfaceName } from '../interfaces';
import type { SwitchDevice } from './context';
import type { PortStates } from './query';
import { ciscoMac } from './show';

const NO_ENGINE = ['% The simulation is not running, so there is no live state to show.'];

/** `show mac address-table`: what the switch has learned, by VLAN then address. */
export function showMacAddressTable(
  entries: readonly MacTableEntry[] | undefined,
): readonly string[] {
  if (!entries) return NO_ENGINE;
  return [
    '          Mac Address Table',
    '-------------------------------------------',
    '',
    'Vlan    Mac Address       Type        Ports',
    '----    -----------       --------    -----',
    '',
    ...entries.map(
      ({ vlan, mac, port }) =>
        `${String(vlan).padStart(4)}    ${ciscoMac(mac)}    DYNAMIC     ${shortInterfaceName(port)}`,
    ),
    `Total Mac Addresses for this criterion: ${entries.length}`,
  ];
}

/** The VLANs every Catalyst lists for the old FDDI and Token Ring media, which it cannot delete. */
const MEDIA_VLANS = [
  [1002, 'fddi-default'],
  [1003, 'token-ring-default'],
  [1004, 'fddinet-default'],
  [1005, 'trnet-default'],
] as const;

const PORTS_PER_ROW = 4;
const PORTS_COLUMN = 48;

const vlanIds = (device: SwitchDevice) =>
  Object.keys(device.config.vlans)
    .map((id) => Number(id) as VlanId)
    .sort((a, b) => a - b);

function switchports(device: SwitchDevice): [Port, Switchport][] {
  return device.ports.flatMap((port): [Port, Switchport][] => {
    const config = device.config.interfaces[port.id];
    return config?.switchport ? [[port, config.switchport]] : [];
  });
}

/** `show vlan brief`: each VLAN with the access ports in it, four to a row. */
export function showVlanBrief(device: SwitchDevice): readonly string[] {
  const row = (id: string, name: string, status: string, ports: string) =>
    `${id.padEnd(4)} ${name.padEnd(32)} ${status.padEnd(9)} ${ports}`.trimEnd();
  const out = [
    '',
    row('VLAN', 'Name', 'Status', 'Ports'),
    row('----', '-'.repeat(32), '-'.repeat(9), '-'.repeat(31)),
  ];
  const ports = switchports(device);
  for (const id of vlanIds(device)) {
    const members = ports
      .filter(([, switchport]) => switchport.mode === 'access' && switchport.vlan === id)
      .map(([port]) => shortInterfaceName(port.id));
    const rows: string[] = [];
    for (let i = 0; i < members.length; i += PORTS_PER_ROW) {
      rows.push(members.slice(i, i + PORTS_PER_ROW).join(', '));
    }
    const name = device.config.vlans[id]?.name ?? '';
    out.push(row(String(id), name, 'active', rows[0] ?? ''));
    for (const more of rows.slice(1)) out.push(' '.repeat(PORTS_COLUMN) + more);
  }
  for (const [id, name] of MEDIA_VLANS) out.push(row(String(id), name, 'act/unsup', ''));
  return out;
}

/** Up as the simulation sees it, or from config alone when there is no simulation to ask. */
function portUp(device: SwitchDevice, port: PortId, ports: PortStates | undefined): boolean {
  return ports ? ports[port] === true : device.config.interfaces[port]?.shutdown === false;
}

type Trunk = { readonly port: PortId; readonly switchport: Extract<Switchport, { mode: 'trunk' }> };

/** VLANs in `list` that the switch's VLAN database has. */
function activeVlans(device: SwitchDevice, allowed: Switchport['allowedVlans']): string {
  const active = vlanIds(device).filter((id) => vlanAllowed(allowed, id));
  return formatVlans(normalizeVlans(active.map((id) => ({ first: id, last: id }))));
}

/**
 * `show interfaces trunk`: every port trunking now, with its native VLAN, the VLANs it allows,
 * and those of them the switch knows. Without spanning tree, every active VLAN is forwarding.
 */
export function showInterfacesTrunk(
  device: SwitchDevice,
  ports: PortStates | undefined,
): readonly string[] {
  const trunks = switchports(device).flatMap(([port, switchport]): Trunk[] =>
    switchport.mode === 'trunk' && portUp(device, port.id, ports)
      ? [{ port: port.id, switchport }]
      : [],
  );
  if (trunks.length === 0) return [];
  const name = (trunk: Trunk) => shortInterfaceName(trunk.port).padEnd(12);
  const section = (title: string, value: (trunk: Trunk) => string) => [
    '',
    `${'Port'.padEnd(12)}${title}`,
    ...trunks.map((trunk) => name(trunk) + value(trunk)),
  ];
  return [
    'Port        Mode         Encapsulation  Status        Native vlan',
    ...trunks.map(
      (trunk) =>
        `${name(trunk)}${'on'.padEnd(13)}${'802.1q'.padEnd(15)}${'trunking'.padEnd(14)}${trunk.switchport.nativeVlan}`,
    ),
    ...section('Vlans allowed on trunk', (t) => formatVlans(t.switchport.allowedVlans)),
    ...section('Vlans allowed and active in management domain', (t) =>
      activeVlans(device, t.switchport.allowedVlans),
    ),
    ...section('Vlans in spanning tree forwarding state and not pruned', (t) =>
      activeVlans(device, t.switchport.allowedVlans),
    ),
  ];
}

function vlanLabel(device: SwitchDevice, vlan: VlanId): string {
  return `${vlan} (${device.config.vlans[vlan]?.name ?? 'Inactive'})`;
}

/** `show interfaces switchport`: each port's administrative and operational VLAN settings. */
export function showInterfacesSwitchport(
  device: SwitchDevice,
  only: PortId | undefined,
  ports: PortStates | undefined,
): readonly string[] {
  const blocks = switchports(device)
    .filter(([port]) => only === undefined || port.id === only)
    .map(([port, switchport]) => {
      const trunk = switchport.mode === 'trunk';
      const access = trunk ? switchport.accessVlan : switchport.vlan;
      const native = switchport.nativeVlan ?? (1 as VlanId);
      const operational = !portUp(device, port.id, ports)
        ? 'down'
        : trunk
          ? 'trunk'
          : 'static access';
      const allowed = switchport.allowedVlans;
      return [
        `Name: ${shortInterfaceName(port.id)}`,
        'Switchport: Enabled',
        `Administrative Mode: ${trunk ? 'trunk' : 'static access'}`,
        `Operational Mode: ${operational}`,
        'Administrative Trunking Encapsulation: dot1q',
        `Operational Trunking Encapsulation: ${trunk ? 'dot1q' : 'native'}`,
        `Negotiation of Trunking: ${trunk ? 'On' : 'Off'}`,
        `Access Mode VLAN: ${vlanLabel(device, access ?? (1 as VlanId))}`,
        `Trunking Native Mode VLAN: ${vlanLabel(device, native)}`,
        'Voice VLAN: none',
        `Trunking VLANs Enabled: ${allowed ? formatVlans(allowed) : 'ALL'}`,
        'Pruning VLANs Enabled: 2-1001',
        'Protected: false',
        'Appliance trust: none',
      ];
    });
  return blocks.flatMap((block, i) => (i === 0 ? block : ['', ...block]));
}
