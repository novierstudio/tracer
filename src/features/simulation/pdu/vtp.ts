import type { VtpPdu, VtpVlanInfo } from '@/engine/pdu';
import { ipBytes, u16, u32, type Part } from './encode';

const DOMAIN_FIELD = 32;
const VLAN_MTU = 1500;
/** IOS gives each Ethernet VLAN an 802.10 SAID of 100000 plus its number. */
const SAID_BASE = 100_000;

const CODE: Record<VtpPdu['code'], number> = { summary: 0x01, subset: 0x02, request: 0x03 };

const CODE_NAMES: Record<VtpPdu['code'], string> = {
  summary: 'Summary Advertisement',
  subset: 'Subset Advertisement',
  request: 'Advertisement Request',
};

const ascii = (text: string) => [...new TextEncoder().encode(text)];

const padded = (bytes: readonly number[], length: number) => [
  ...bytes.slice(0, length),
  ...new Array<number>(Math.max(0, length - bytes.length)).fill(0),
];

/** A `yymmddhhmmss` stamp as Wireshark shows it: `93-03-01 00:27:41`. */
const stampText = (stamp: string) =>
  `${stamp.slice(0, 2)}-${stamp.slice(2, 4)}-${stamp.slice(4, 6)} ${stamp.slice(6, 8)}:${stamp.slice(8, 10)}:${stamp.slice(10, 12)}`;

const digestText = (digest: string) => digest.match(/../g)?.join(' ').toUpperCase() ?? digest;

/** One VLAN's record in a subset advertisement. Its name pads to a multiple of four bytes. */
function vlanBytes(vlan: VtpVlanInfo): number[] {
  const name = ascii(vlan.name);
  const nameField = padded(name, Math.ceil(name.length / 4) * 4);
  const body = [0x00, 0x01, name.length, ...u16(vlan.id), ...u16(VLAN_MTU), ...u32(SAID_BASE + vlan.id)];
  return [body.length + 1 + nameField.length, ...body, ...nameField];
}

/** The header every VTP message starts with: version, code, a code-specific byte, then the domain. */
function headerParts(pdu: VtpPdu, third: Part): Part[] {
  const domain = ascii(pdu.domain);
  return [
    {
      id: 'vtp.version',
      label: 'Version',
      value: String(pdu.version),
      explain:
        pdu.version === 2
          ? 'VTP version 2. A transparent switch passes version 2 messages on whatever their domain.'
          : 'VTP version 1, the IOS default.',
      bytes: [pdu.version],
    },
    {
      id: 'vtp.code',
      label: 'Code',
      value: `${CODE_NAMES[pdu.code]} (${CODE[pdu.code]})`,
      explain: {
        summary:
          'A summary gives the domain and revision. A switch with an older revision asks for, or waits for, the VLANs that follow.',
        subset:
          'A subset carries the VLANs themselves. A server or client in the domain with an older revision replaces its own with them.',
        request:
          'Asks the neighbour to send its VLANs. A switch sends one when it hears a newer revision without the VLANs.',
      }[pdu.code],
      bytes: [CODE[pdu.code]],
    },
    third,
    {
      id: 'vtp.domainLength',
      label: 'Domain name length',
      value: String(domain.length),
      explain: 'How many of the 32 domain bytes that follow are the name.',
      bytes: [domain.length],
    },
    {
      id: 'vtp.domain',
      label: 'Domain name',
      value: pdu.domain,
      explain:
        'Switches take updates only from their own domain. A switch with no domain yet joins the first one it hears.',
      bytes: padded(domain, DOMAIN_FIELD),
    },
  ];
}

function revisionPart(revision: number): Part {
  return {
    id: 'vtp.revision',
    label: 'Configuration revision',
    value: String(revision),
    explain:
      'Goes up by one with each VLAN change on a server. The highest revision in the domain wins, even from a switch just plugged in.',
    bytes: u32(revision),
  };
}

/** A VTP message taken apart into fields, with its bytes. */
export function vtpParts(pdu: VtpPdu): Part[] {
  switch (pdu.code) {
    case 'summary':
      return [
        ...headerParts(pdu, {
          id: 'vtp.followers',
          label: 'Followers',
          value: String(pdu.followers),
          explain: 'How many subset advertisements with the VLANs follow this summary.',
          bytes: [pdu.followers],
        }),
        revisionPart(pdu.revision),
        {
          id: 'vtp.updater',
          label: 'Updater identity',
          value: pdu.updater,
          explain: 'The address of the switch that made the change, as show vtp status names it.',
          bytes: ipBytes(pdu.updater),
        },
        {
          id: 'vtp.timestamp',
          label: 'Update timestamp',
          value: stampText(pdu.timestamp),
          explain: 'When that switch made the change, by its own clock.',
          bytes: ascii(pdu.timestamp),
        },
        {
          id: 'vtp.digest',
          label: 'MD5 digest',
          value: digestText(pdu.digest),
          explain:
            'A hash of the VTP password and the VLANs. A switch whose password differs gets another hash and ignores the update.',
          bytes: pdu.digest.match(/../g)?.map((pair) => parseInt(pair, 16)) ?? [],
        },
      ];
    case 'subset':
      return [
        ...headerParts(pdu, {
          id: 'vtp.sequence',
          label: 'Sequence number',
          value: String(pdu.sequence),
          explain: 'Which subset this is, counting from 1, when the VLANs take more than one.',
          bytes: [pdu.sequence],
        }),
        revisionPart(pdu.revision),
        ...pdu.vlans.map(
          (vlan): Part => ({
            id: `vtp.vlan.${vlan.id}`,
            label: `VLAN ${vlan.id}`,
            value: `${vlan.name}, Ethernet, active, MTU ${VLAN_MTU}`,
            explain: 'One VLAN: its status, type, number, MTU, 802.10 index and name.',
            bytes: vlanBytes(vlan),
          }),
        ),
      ];
    case 'request':
      return [
        ...headerParts(pdu, {
          id: 'vtp.reserved',
          label: 'Reserved',
          value: '0',
          explain: 'A byte the request leaves empty.',
          bytes: [0],
        }),
        {
          id: 'vtp.start',
          label: 'Start value',
          value: String(pdu.start),
          explain: 'The first VLAN it asks for: 0 asks for them all.',
          bytes: u16(pdu.start),
        },
      ];
  }
}

/** The one-line summary of a VTP message for its layer heading. */
export function vtpSummary(pdu: VtpPdu): string {
  switch (pdu.code) {
    case 'summary':
      return `Summary, domain ${pdu.domain}, revision ${pdu.revision}`;
    case 'subset':
      return `Subset, revision ${pdu.revision}, ${pdu.vlans.length} VLAN${pdu.vlans.length === 1 ? '' : 's'}`;
    case 'request':
      return `Request, domain ${pdu.domain}`;
  }
}
