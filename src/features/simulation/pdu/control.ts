import type {
  CdpPacket,
  DeviceCapability,
  LacpActor,
  LacpPdu,
  LldpPacket,
  PagpPdu,
} from '@/engine/pdu';
import type { MacAddress } from '@/model';
import { hex, internetChecksum, ipBytes, macBytes, u16, u32, type Part } from './encode';

/** What a device sends only to the device at the other end of the link: discovery and EtherChannel. */
export type ControlPdu = CdpPacket | LldpPacket | LacpPdu | PagpPdu;

export type ControlSection = {
  readonly id: ControlPdu['kind'];
  readonly name: string;
  readonly summary: string;
  readonly parts: readonly Part[];
};

const ZERO_MAC = '00:00:00:00:00:00' as MacAddress;

const encoder = new TextEncoder();
const ascii = (text: string) => [...encoder.encode(text)];

const CAPABILITY_NAMES: Record<DeviceCapability, string> = {
  router: 'router',
  switch: 'switch',
  igmp: 'IGMP',
  host: 'host',
};

const capabilityText = (capabilities: readonly DeviceCapability[]) =>
  capabilities.map((capability) => CAPABILITY_NAMES[capability]).join(', ') || 'none';

const bits = (capabilities: readonly DeviceCapability[], bit: Record<DeviceCapability, number>) =>
  capabilities.reduce((mask, capability) => mask | bit[capability], 0);

// CDP

const CDP_CAPABILITY_BIT: Record<DeviceCapability, number> = {
  router: 0x01,
  switch: 0x08,
  host: 0x10,
  igmp: 0x20,
};

/** A CDP TLV: a 16-bit type, a 16-bit length that counts these four bytes too, then the value. */
const cdpTlv = (type: number, value: readonly number[]) => [
  ...u16(type),
  ...u16(value.length + 4),
  ...value,
];

function cdpSection(cdp: CdpPacket): ControlSection {
  const addresses = cdp.addresses.flatMap((address) => [
    0x01,
    0x01,
    0xcc,
    ...u16(4),
    ...ipBytes(address),
  ]);
  const tlvs: Part[] = [
    {
      id: 'cdp.deviceId',
      label: 'Device ID',
      value: cdp.deviceId,
      explain: 'The sender’s hostname, which the neighbour lists in show cdp neighbors.',
      bytes: cdpTlv(0x0001, ascii(cdp.deviceId)),
    },
    {
      id: 'cdp.addresses',
      label: 'Addresses',
      value: cdp.addresses.join(', ') || 'none',
      explain:
        'The sender’s IP address, so the neighbour can reach it even without knowing the subnet.',
      bytes: cdpTlv(0x0002, [...u32(cdp.addresses.length), ...addresses]),
    },
    {
      id: 'cdp.portId',
      label: 'Port ID',
      value: cdp.portId,
      explain: 'The port the advertisement left by: the far end of this cable.',
      bytes: cdpTlv(0x0003, ascii(cdp.portId)),
    },
    {
      id: 'cdp.capabilities',
      label: 'Capabilities',
      value: capabilityText(cdp.capabilities),
      explain: 'What kind of device the sender is: one bit for each role it plays.',
      bytes: cdpTlv(0x0004, u32(bits(cdp.capabilities, CDP_CAPABILITY_BIT))),
    },
    {
      id: 'cdp.software',
      label: 'Software',
      value: cdp.software,
      explain: 'The operating system and version the sender runs, as show version starts.',
      bytes: cdpTlv(0x0005, ascii(cdp.software)),
    },
    {
      id: 'cdp.platform',
      label: 'Platform',
      value: cdp.platform,
      explain: 'The sender’s hardware model.',
      bytes: cdpTlv(0x0006, ascii(cdp.platform)),
    },
    ...(cdp.nativeVlan === undefined
      ? []
      : [
          {
            id: 'cdp.nativeVlan',
            label: 'Native VLAN',
            value: String(cdp.nativeVlan),
            explain:
              'The sending port’s access or native VLAN. IOS warns of a mismatch when the two ends differ.',
            bytes: cdpTlv(0x000a, u16(cdp.nativeVlan)),
          },
        ]),
    {
      id: 'cdp.duplex',
      label: 'Duplex',
      value: cdp.duplex,
      explain: 'The sending port’s duplex. IOS warns of a mismatch when the two ends differ.',
      bytes: cdpTlv(0x000b, [cdp.duplex === 'full' ? 1 : 0]),
    },
  ];
  const checksum = internetChecksum([
    cdp.version,
    cdp.holdtime,
    0,
    0,
    ...tlvs.flatMap((tlv) => tlv.bytes),
  ]);
  return {
    id: 'cdp',
    name: 'CDP',
    summary: `${cdp.deviceId} ${cdp.portId}, holdtime ${cdp.holdtime} s`,
    parts: [
      {
        id: 'cdp.version',
        label: 'Version',
        value: String(cdp.version),
        explain: 'CDP version 2, which IOS sends unless told otherwise.',
        bytes: [cdp.version],
      },
      {
        id: 'cdp.holdtime',
        label: 'Holdtime',
        value: `${cdp.holdtime} s`,
        explain:
          'How long the neighbour keeps this advertisement. The sender repeats it well before then.',
        bytes: [cdp.holdtime],
      },
      {
        id: 'cdp.checksum',
        label: 'Checksum',
        value: hex(checksum, 4),
        explain: 'Covers the whole CDP packet, so the neighbour drops a damaged one.',
        bytes: u16(checksum),
      },
      ...tlvs,
    ],
  };
}

// LLDP

const LLDP_CAPABILITY_BIT: Record<DeviceCapability, number> = {
  // LLDP has no IGMP bit: it counts as other.
  igmp: 0x01,
  switch: 0x04,
  router: 0x10,
  host: 0x80,
};

/** An LLDP TLV: a 7-bit type and a 9-bit length in two bytes, then the value. */
const lldpTlv = (type: number, value: readonly number[]) => [
  ...u16((type << 9) | value.length),
  ...value,
];

function lldpSection(lldp: LldpPacket): ControlSection {
  const capabilities = u16(bits(lldp.capabilities, LLDP_CAPABILITY_BIT));
  const management = lldp.managementAddress;
  return {
    id: 'lldp',
    name: 'LLDP',
    summary: `${lldp.systemName} ${lldp.portId}, TTL ${lldp.ttl} s`,
    parts: [
      {
        id: 'lldp.chassisId',
        label: 'Chassis ID',
        value: lldp.chassisId,
        explain: 'Who sent it, by MAC address. Every LLDP advertisement starts with it.',
        bytes: lldpTlv(1, [4, ...macBytes(lldp.chassisId)]),
      },
      {
        id: 'lldp.portId',
        label: 'Port ID',
        value: lldp.portId,
        explain: 'The port the advertisement left by, by name: the far end of this cable.',
        bytes: lldpTlv(2, [5, ...ascii(lldp.portId)]),
      },
      {
        id: 'lldp.ttl',
        label: 'Time to live',
        value: `${lldp.ttl} s`,
        explain:
          'How long the neighbour keeps this advertisement. The sender repeats it well before then.',
        bytes: lldpTlv(3, u16(lldp.ttl)),
      },
      {
        id: 'lldp.systemName',
        label: 'System name',
        value: lldp.systemName,
        explain: 'The sender’s hostname, which the neighbour lists in show lldp neighbors.',
        bytes: lldpTlv(5, ascii(lldp.systemName)),
      },
      {
        id: 'lldp.systemDescription',
        label: 'System description',
        value: lldp.systemDescription,
        explain: 'What the sender is and the software it runs.',
        bytes: lldpTlv(6, ascii(lldp.systemDescription)),
      },
      {
        id: 'lldp.capabilities',
        label: 'Capabilities',
        value: capabilityText(lldp.capabilities),
        explain: 'What the sender can do, then what it has turned on. IOS turns on all it can.',
        bytes: lldpTlv(7, [...capabilities, ...capabilities]),
      },
      ...(management === undefined
        ? []
        : [
            {
              id: 'lldp.managementAddress',
              label: 'Management address',
              value: management,
              explain: 'An address to reach the sender on, such as for SSH or SNMP.',
              bytes: lldpTlv(8, [5, 1, ...ipBytes(management), 2, ...u32(0), 0]),
            },
          ]),
      {
        id: 'lldp.end',
        label: 'End',
        value: 'End of LLDPDU',
        explain: 'An empty TLV that marks the last one.',
        bytes: lldpTlv(0, []),
      },
    ],
  };
}

// LACP

/** IOS's default LACP system and port priority. */
const LACP_PRIORITY = 32768;

const LACP_STATE_BITS = [
  [0x02, 'short timeout'],
  [0x04, 'aggregatable'],
  [0x08, 'in sync'],
  [0x10, 'collecting'],
  [0x20, 'distributing'],
  [0x40, 'defaulted'],
] as const;

const stateText = (state: number) =>
  LACP_STATE_BITS.filter(([bit]) => state & bit).map(([, name]) => name);

/** One end's TLV: type and length, then system, key, port and state, then three spare bytes. */
function lacpEnd(
  end: 'actor' | 'partner',
  side: Omit<LacpActor, 'active'> | undefined,
  state: number,
  stateValue: string,
): Part[] {
  const actor = end === 'actor';
  const Name = actor ? 'Actor' : 'Partner';
  return [
    {
      id: `lacp.${end}.system`,
      label: `${Name} system`,
      value: side ? `${LACP_PRIORITY} ${side.system}` : 'none yet',
      explain: actor
        ? 'The switch that sent it: its LACP priority, then its MAC.'
        : 'The switch the sender has heard on this link, so both ends know they agree.',
      bytes: [
        actor ? 1 : 2,
        20,
        ...u16(side ? LACP_PRIORITY : 0),
        ...macBytes(side?.system ?? ZERO_MAC),
      ],
    },
    {
      id: `lacp.${end}.key`,
      label: `${Name} key`,
      value: String(side?.key ?? 0),
      explain: 'IOS uses the channel group number. Ports bundle only when their keys match.',
      bytes: u16(side?.key ?? 0),
    },
    {
      id: `lacp.${end}.port`,
      label: `${Name} port`,
      value: side ? `${LACP_PRIORITY}.${side.port}` : 'none yet',
      explain: 'The port: its priority, then its number.',
      bytes: [...u16(side ? LACP_PRIORITY : 0), ...u16(side?.port ?? 0)],
    },
    {
      id: `lacp.${end}.state`,
      label: `${Name} state`,
      value: stateValue,
      explain: actor
        ? 'An active port starts the conversation; a passive one only answers. In sync means the port is bundled.'
        : 'What the sender last heard the partner say about its own port.',
      bytes: [state, 0, 0, 0],
    },
  ];
}

function lacpSection({ actor, partner }: LacpPdu): ControlSection {
  const bundled = partner ? 0x08 | 0x10 | 0x20 : 0x40;
  const actorState = (actor.active ? 0x01 : 0) | 0x04 | bundled;
  const partnerState = partner ? 0x04 | 0x08 | 0x10 | 0x20 : 0;
  const activity = actor.active ? 'active' : 'passive';
  return {
    id: 'lacp',
    name: 'LACP',
    summary: partner
      ? `${activity}, key ${actor.key}, partner ${partner.system}`
      : `${activity}, key ${actor.key}, no partner yet`,
    parts: [
      {
        id: 'lacp.subtype',
        label: 'Subtype',
        value: '1 (LACP)',
        explain: 'Slow Protocols carry more than LACP: subtype 1 says this is LACP.',
        bytes: [1],
      },
      {
        id: 'lacp.version',
        label: 'Version',
        value: '1',
        explain: 'The LACP version every switch sends.',
        bytes: [1],
      },
      ...lacpEnd('actor', actor, actorState, [activity, ...stateText(actorState)].join(', ')),
      ...lacpEnd('partner', partner, partnerState, stateText(partnerState).join(', ') || 'none'),
      {
        id: 'lacp.rest',
        label: 'Collector, terminator',
        value: '68 bytes',
        explain: 'A collector TLV and the end marker, padded so that every LACPDU is 110 bytes.',
        bytes: [3, 16, ...new Array<number>(66).fill(0)],
      },
    ],
  };
}

// PAgP

function pagpSection(pagp: PagpPdu): ControlSection {
  const { partner } = pagp;
  const mode = pagp.desirable ? 'desirable' : 'auto';
  const flags = (pagp.desirable ? 0 : 0x02) | (partner ? 0x04 : 0);
  /** Learning method, priority, then the port's number. */
  const portBytes = (port: number) => [0x01, 128, ...u32(port)];
  return {
    id: 'pagp',
    name: 'PAgP',
    summary: partner
      ? `${mode}, group ${pagp.group}, partner ${partner.device}`
      : `${mode}, group ${pagp.group}, no partner yet`,
    parts: [
      {
        id: 'pagp.version',
        label: 'Version',
        value: '1 (information)',
        explain: 'An information packet: what the sender knows of its port and its partner.',
        bytes: [1],
      },
      {
        id: 'pagp.flags',
        label: 'Flags',
        value: partner ? `${mode}, consistent` : mode,
        explain:
          'A desirable port starts the negotiation; an auto one only answers. Consistent means it has heard its partner.',
        bytes: [flags],
      },
      {
        id: 'pagp.device',
        label: 'Device ID',
        value: pagp.device,
        explain: 'The switch that sent it, by MAC address.',
        bytes: macBytes(pagp.device),
      },
      {
        id: 'pagp.port',
        label: 'Port',
        value: String(pagp.port),
        explain: 'The port it left by: how it learns addresses, its priority, then its number.',
        bytes: portBytes(pagp.port),
      },
      {
        id: 'pagp.group',
        label: 'Group',
        value: String(pagp.group),
        explain: 'The channel group. Ports bundle only with partners in the same group.',
        bytes: [...u32(pagp.group), ...u32(pagp.group)],
      },
      {
        id: 'pagp.partnerDevice',
        label: 'Partner device',
        value: partner?.device ?? 'none yet',
        explain: 'The switch the sender has heard on this link.',
        bytes: macBytes(partner?.device ?? ZERO_MAC),
      },
      {
        id: 'pagp.partnerPort',
        label: 'Partner port',
        value: partner ? String(partner.port) : 'none yet',
        explain: 'The port on that switch, so both ends know they agree.',
        bytes: partner ? portBytes(partner.port) : new Array<number>(6).fill(0),
      },
      {
        id: 'pagp.partners',
        label: 'Partner count',
        value: String(partner ? 1 : 0),
        explain: 'How many partners the port has heard, then how many more TLVs follow: none here.',
        bytes: [...u16(partner ? 1 : 0), ...u16(0)],
      },
    ],
  };
}

/** A discovery or EtherChannel PDU taken apart into fields, with its bytes. */
export function controlSection(pdu: ControlPdu): ControlSection {
  switch (pdu.kind) {
    case 'cdp':
      return cdpSection(pdu);
    case 'lldp':
      return lldpSection(pdu);
    case 'lacp':
      return lacpSection(pdu);
    case 'pagp':
      return pagpSection(pdu);
  }
}
