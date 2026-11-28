import { PortId, type PortKind, type PortSpec } from '@/model';

const PORT_PREFIX: Record<PortKind, string> = {
  fastEthernet: 'FastEthernet',
  gigabitEthernet: 'GigabitEthernet',
  serial: 'Serial',
  wireless: 'Wireless',
};

/** `ports('gigabitEthernet', '0/', 0, 2)` is GigabitEthernet0/0 and GigabitEthernet0/1. */
export function ports(kind: PortKind, slot: string, first: number, count: number): PortSpec[] {
  return Array.from({ length: count }, (_, i) => ({
    kind,
    id: PortId.parse(`${PORT_PREFIX[kind]}${slot}${first + i}`),
  }));
}

export const fiber = (specs: PortSpec[]): PortSpec[] =>
  specs.map((spec) => ({ ...spec, fiber: true }));

/** Packet Tracer's `Port 0`, `Port 1`, …: how a hub names its ports. */
export const numbered = (count: number): PortSpec[] =>
  Array.from({ length: count }, (_, i) => ({
    kind: 'fastEthernet',
    id: PortId.parse(`Port${i}`),
  }));

export const radio = (name: string): PortSpec => ({ kind: 'wireless', id: PortId.parse(name) });

/** The radio a PC or laptop takes in place of its Ethernet card, as Packet Tracer's WMP300N. */
export const WIRELESS_NIC: PortSpec = radio('Wireless0');

/** One port with no slot number, such as a PC's FastEthernet0. */
export const single = (kind: PortKind): PortSpec[] => [
  { kind, id: PortId.parse(`${PORT_PREFIX[kind]}0`) },
];
