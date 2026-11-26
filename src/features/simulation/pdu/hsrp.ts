import type { HsrpMessage, HsrpOpcode, HsrpState } from '@/engine/pdu';
import { ipBytes, macBytes, u16, u32, type Part } from './encode';

const OPCODE: Record<HsrpOpcode, number> = { hello: 0, coup: 1, resign: 2 };

/** Version 1 codes each state by its own bit; version 2 counts them. */
const STATE_V1: Record<HsrpState, number> = {
  init: 0,
  learn: 1,
  listen: 2,
  speak: 4,
  standby: 8,
  active: 16,
};
const STATE_V2: Record<HsrpState, number> = {
  init: 1,
  learn: 2,
  listen: 3,
  speak: 4,
  standby: 5,
  active: 6,
};

const capitalize = (text: string) => `${text[0]!.toUpperCase()}${text.slice(1)}`;

const ascii8 = (text: string) => {
  const bytes = [...new TextEncoder().encode(text)].slice(0, 8);
  return [...bytes, ...new Array<number>(8 - bytes.length).fill(0)];
};

const OPCODE_EXPLAIN: Record<HsrpOpcode, string> = {
  hello:
    'A hello: the sender is alive, in this state, at this priority. The active and standby routers send one every hello time.',
  coup: 'A coup: a router with preempt and a higher priority takes over as active.',
  resign: 'A resign: the active router is giving up, so the standby router takes over at once.',
};

const STATE_EXPLAIN: Record<HsrpState, string> = {
  init: 'Not yet running on this interface.',
  learn: 'Waiting to learn the virtual IP from the active router.',
  listen: 'Knows the virtual IP, and listens for the active and standby routers.',
  speak: 'Sends hellos and stands for election as standby or active.',
  standby: 'Next in line: it takes over if the active router’s hellos stop.',
  active: 'Forwards packets sent to the virtual MAC, and answers ARP for the virtual IP.',
};

function commonParts(message: HsrpMessage, codes: Record<HsrpState, number>) {
  return {
    opcode: {
      id: 'hsrp.opcode',
      label: 'Op code',
      value: `${capitalize(message.opcode)} (${OPCODE[message.opcode]})`,
      explain: OPCODE_EXPLAIN[message.opcode],
      bytes: [OPCODE[message.opcode]],
    },
    state: {
      id: 'hsrp.state',
      label: 'State',
      value: `${capitalize(message.state)} (${codes[message.state]})`,
      explain: STATE_EXPLAIN[message.state],
      bytes: [codes[message.state]],
    },
    priority: (bytes: number[]): Part => ({
      id: 'hsrp.priority',
      label: 'Priority',
      value: String(message.priority),
      explain: 'The highest priority becomes active; a tie goes to the higher interface address.',
      bytes,
    }),
    group: (bytes: number[]): Part => ({
      id: 'hsrp.group',
      label: 'Group',
      value: String(message.group),
      explain: 'The standby group. Routers back each other up only within one group.',
      bytes,
    }),
    virtualIp: (bytes: number[]): Part => ({
      id: 'hsrp.virtualIp',
      label: 'Virtual IP address',
      value: message.virtualIp,
      explain: 'The default gateway the hosts use. Whichever router is active answers for it.',
      bytes,
    }),
    authentication: (bytes: number[]): Part => ({
      id: 'hsrp.authentication',
      label: 'Authentication',
      value: message.authentication,
      explain: 'A plain-text password, cisco unless configured. Routers ignore hellos without theirs.',
      bytes,
    }),
  };
}

function timerPart(id: 'hello' | 'hold', seconds: number, bytes: number[]): Part {
  return {
    id: `hsrp.${id}`,
    label: id === 'hello' ? 'Hello time' : 'Hold time',
    value: `${seconds} s`,
    explain:
      id === 'hello'
        ? 'How often the active and standby routers send hellos.'
        : 'How long the others wait without a hello before they take the sender for dead.',
    bytes,
  };
}

/** An HSRP message taken apart into fields, with its bytes. */
export function hsrpParts(message: HsrpMessage): Part[] {
  if (message.version === 1) {
    const common = commonParts(message, STATE_V1);
    return [
      {
        id: 'hsrp.version',
        label: 'Version',
        value: '0 (HSRPv1)',
        explain: 'HSRP version 1, the IOS default, numbered 0 on the wire.',
        bytes: [0],
      },
      common.opcode,
      common.state,
      timerPart('hello', message.helloTime, [message.helloTime]),
      timerPart('hold', message.holdTime, [message.holdTime]),
      common.priority([message.priority]),
      common.group([message.group]),
      { id: 'hsrp.reserved', label: 'Reserved', value: '0', explain: 'Unused.', bytes: [0] },
      common.authentication(ascii8(message.authentication)),
      common.virtualIp(ipBytes(message.virtualIp)),
    ];
  }
  const common = commonParts(message, STATE_V2);
  const identifier = message.identifier ?? '00:00:00:00:00:00';
  return [
    {
      id: 'hsrp.tlv',
      label: 'Group State TLV',
      value: 'type 1, length 40',
      explain: 'HSRP version 2 sends its fields as TLVs; the group state comes first.',
      bytes: [1, 40],
    },
    {
      id: 'hsrp.version',
      label: 'Version',
      value: '2',
      explain: 'HSRP version 2: groups up to 4095, timers in milliseconds, and its own multicast group.',
      bytes: [2],
    },
    common.opcode,
    common.state,
    {
      id: 'hsrp.ipVersion',
      label: 'IP version',
      value: '4',
      explain: 'The virtual address is IPv4.',
      bytes: [4],
    },
    common.group(u16(message.group)),
    {
      id: 'hsrp.identifier',
      label: 'Identifier',
      value: identifier,
      explain: 'The sender’s own MAC address, so routers can tell each other apart.',
      bytes: macBytes(identifier),
    },
    common.priority(u32(message.priority)),
    timerPart('hello', message.helloTime, u32(message.helloTime * 1000)),
    timerPart('hold', message.holdTime, u32(message.holdTime * 1000)),
    common.virtualIp([...ipBytes(message.virtualIp), ...new Array<number>(12).fill(0)]),
    common.authentication([3, 8, ...ascii8(message.authentication)]),
  ];
}

export function hsrpSummary(message: HsrpMessage): string {
  return `${capitalize(message.opcode)}, group ${message.group}, ${message.state}, priority ${message.priority}`;
}
