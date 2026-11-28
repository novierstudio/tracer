import { DNS_RCODE, type DnsMessage } from '@/engine/dns';
import { httpText, type HttpMessage } from '@/engine/http';
import { IP_PROTOCOL, UDP_PORT, type Ipv4Packet } from '@/engine/pdu';
import {
  TCP_PORT,
  type TcpFlags,
  type TcpPayload,
  type TcpSegment,
  type TerminalData,
} from '@/engine/tcp';
import { APP_PORT_NAMES, appParts, describeApp } from './apps';
import { formatSeconds, hex, internetChecksum, ipBytes, u16, u32, type Part } from './encode';

/** Dissectors for what a browser sends: DNS to find the server, TCP to reach it, HTTP over TCP. */

const PORT_NAMES: Record<number, string> = {
  [UDP_PORT.dns]: 'DNS',
  [UDP_PORT.dhcpServer]: 'DHCP server',
  [UDP_PORT.dhcpClient]: 'DHCP client',
  [TCP_PORT.http]: 'HTTP',
  [TCP_PORT.telnet]: 'Telnet',
  [TCP_PORT.ssh]: 'SSH',
  [UDP_PORT.rip]: 'RIP',
  [UDP_PORT.hsrp]: 'HSRP',
  ...APP_PORT_NAMES,
};

export const portName = (port: number) => {
  const name = PORT_NAMES[port];
  return name ? `${port} (${name})` : String(port);
};

// TCP

/** The flags in wire order, lowest bit first, which is also the order Wireshark lists them. */
const TCP_FLAGS = [
  ['fin', 0x01, 'FIN says the sender has nothing more to send.'],
  ['syn', 0x02, 'SYN opens a connection and sets where the sender’s byte count starts.'],
  ['rst', 0x04, 'RST aborts the connection at once, as for a port nothing listens on.'],
  ['psh', 0x08, 'PSH asks the receiver to hand the data to the program now.'],
  ['ack', 0x10, 'ACK says the acknowledgment number counts.'],
] as const satisfies readonly (readonly [keyof TcpFlags, number, string])[];

/** The flags a segment has set, as `SYN`, `ACK`. */
export const tcpFlagNames = (flags: TcpFlags) =>
  TCP_FLAGS.filter(([flag]) => flags[flag]).map(([flag]) => flag.toUpperCase());

const flagByte = (flags: TcpFlags) =>
  TCP_FLAGS.reduce((byte, [flag, bit]) => (flags[flag] ? byte | bit : byte), 0);

/** `49152 → 80 [SYN] Seq=123`, the way Wireshark writes a segment. */
export function describeTcp(segment: TcpSegment): string {
  const ack = segment.flags.ack ? ` Ack=${segment.ack}` : '';
  return `${segment.srcPort} → ${segment.dstPort} [${tcpFlagNames(segment.flags).join(', ')}] Seq=${segment.seq}${ack}`;
}

/** No options, so the header is 5 words of 4 bytes. */
const DATA_OFFSET = 5;

/**
 * A segment's TCP header fields, with the checksum over the IPv4 pseudo-header, and the fields of
 * the HTTP message it carries, if any.
 */
export function tcpParts(
  packet: Ipv4Packet,
  segment: TcpSegment,
): { header: Part[]; data: Part[] } {
  const data = segment.payload ? payloadParts(segment.payload) : [];
  const dataBytes = data.flatMap((part) => part.bytes);
  const flags = flagByte(segment.flags);
  const length = DATA_OFFSET * 4 + dataBytes.length;
  const pseudo = [
    ...ipBytes(packet.src),
    ...ipBytes(packet.dst),
    0,
    IP_PROTOCOL.tcp,
    ...u16(length),
  ];
  const header = [
    ...u16(segment.srcPort),
    ...u16(segment.dstPort),
    ...u32(segment.seq),
    ...u32(segment.ack),
    DATA_OFFSET << 4,
    flags,
    ...u16(segment.window),
    0,
    0,
    0,
    0,
  ];
  const checksum = internetChecksum([...pseudo, ...header, ...dataBytes]);
  const names = tcpFlagNames(segment.flags);
  return {
    header: [
      {
        id: 'tcp.srcPort',
        label: 'Source port',
        value: portName(segment.srcPort),
        explain:
          'The sender’s port. A client picks a free one from 49152 up for each connection; a server answers from the port it listens on.',
        bytes: u16(segment.srcPort),
      },
      {
        id: 'tcp.dstPort',
        label: 'Destination port',
        value: portName(segment.dstPort),
        explain: 'The receiver’s port. Web servers listen on 80, so a browser connects there.',
        bytes: u16(segment.dstPort),
      },
      {
        id: 'tcp.seq',
        label: 'Sequence number',
        value: String(segment.seq),
        explain: segment.flags.syn
          ? 'The initial sequence number, picked at random. The sender counts its bytes from here, and the SYN itself counts as one.'
          : 'The number of the first byte this segment carries. Each side counts the bytes it sends, and a SYN or FIN counts as one.',
        bytes: u32(segment.seq),
      },
      {
        id: 'tcp.ack',
        label: 'Acknowledgment number',
        value: String(segment.ack),
        explain: segment.flags.ack
          ? 'The next byte the sender expects from the other side. Every byte before it has arrived.'
          : 'Unused: the ACK flag is off, as in the first SYN, which has nothing to acknowledge yet.',
        bytes: u32(segment.ack),
      },
      {
        id: 'tcp.offset',
        label: 'Header length',
        value: `${DATA_OFFSET} (${DATA_OFFSET * 4} bytes)`,
        explain:
          'Where the data starts, in 4-byte words. 5 words is the 20-byte header with no options.',
        bytes: [DATA_OFFSET << 4],
      },
      {
        id: 'tcp.flags',
        label: 'Flags',
        value: `${hex(flags, 2)} (${names.join(', ')})`,
        explain: TCP_FLAGS.filter(([flag]) => segment.flags[flag])
          .map(([, , explain]) => explain)
          .join(' '),
        bytes: [flags],
      },
      {
        id: 'tcp.window',
        label: 'Window',
        value: `${segment.window} bytes`,
        explain:
          'How many more bytes the sender can take before the other side must wait for an acknowledgment.',
        bytes: u16(segment.window),
      },
      {
        id: 'tcp.checksum',
        label: 'Checksum',
        value: hex(checksum, 4),
        explain:
          'Covers the header, the data and the IP addresses, so a segment damaged or delivered to the wrong host is noticed.',
        bytes: u16(checksum),
      },
      {
        id: 'tcp.urgent',
        label: 'Urgent pointer',
        value: '0',
        explain:
          'Points at urgent data when the URG flag is set. It is off, as it almost always is.',
        bytes: u16(0),
      },
    ],
    data,
  };
}

// Telnet and SSH

/** `Telnet: show ip route` or `SSH: encrypted, 52 bytes`. */
export function describeTerminal(data: TerminalData): string {
  return data.kind === 'telnet' ? `Telnet: ${data.text}` : `SSH: encrypted, ${data.bytes} bytes`;
}

function terminalParts(data: TerminalData): Part[] {
  if (data.kind === 'telnet') {
    return [
      {
        id: 'telnet.data',
        label: 'Data',
        value: JSON.stringify(data.text),
        explain:
          'The line the user typed, and the CR LF that ends it. Telnet sends it as plain text, so anyone on the path can read it, passwords included.',
        bytes: utf8(`${data.text}\r\n`),
      },
    ];
  }
  return [
    {
      id: 'ssh.encrypted',
      label: 'Encrypted packet',
      value: `${data.bytes} bytes`,
      explain:
        'SSH encrypts everything after the key exchange. Only the two ends hold the key, so the path sees noise of a cipher block’s length.',
      bytes: Array.from({ length: data.bytes }, (_, i) => (i * 167 + 59) & 0xff),
    },
  ];
}

/**
 * What a TCP segment carries: an HTTP message, a line of a Telnet or SSH session, or a line or
 * file of FTP, SMTP or POP3.
 */
export function describePayload(payload: TcpPayload): string {
  switch (payload.kind) {
    case 'http':
      return `HTTP ${describeHttp(payload)}`;
    case 'telnet':
    case 'ssh':
      return describeTerminal(payload);
    default:
      return describeApp(payload);
  }
}

function payloadParts(payload: TcpPayload): Part[] {
  switch (payload.kind) {
    case 'http':
      return httpParts(payload);
    case 'telnet':
    case 'ssh':
      return terminalParts(payload);
    default:
      return appParts(payload);
  }
}

// HTTP

const encoder = new TextEncoder();
const utf8 = (text: string) => [...encoder.encode(text)];

/** `GET / (Host www.lab.local)` or `200 OK, text/html, 312 bytes`. */
export function describeHttp(message: HttpMessage): string {
  return message.type === 'request'
    ? `${message.method} ${message.path} (Host ${message.host})`
    : `${message.status} ${message.reason}, ${message.contentType}, ${utf8(message.body).length} bytes`;
}

const HEADER_EXPLAIN: Record<string, string> = {
  Host: 'The name the user typed. One server can hold many sites, and this says which one is meant.',
  Connection:
    'close: the server closes the connection after its response, so each page takes a new connection.',
  'Content-Type': 'What the body is, so the browser knows how to show it. text/html is a web page.',
  'Content-Length': 'The body’s size in bytes, so the receiver knows where the message ends.',
};

function startExplain(message: HttpMessage) {
  if (message.type === 'request') {
    return 'The method, the path asked for and the HTTP version. GET asks the server to send what is at that path.';
  }
  if (message.status === 200) {
    return 'The HTTP version, the status code and its reason. 200 means the server found the page and sends it.';
  }
  if (message.status === 404) {
    return 'The HTTP version, the status code and its reason. 404 means the server has nothing at that path.';
  }
  return 'The HTTP version, the status code and its reason. 2xx means it worked, 4xx a mistake by the client, 5xx a failure at the server.';
}

const PREVIEW = 40;

/** Each line of the message's wire text, with its CR LF, then the body. */
function httpParts(message: HttpMessage): Part[] {
  const text = httpText(message);
  const end = text.indexOf('\r\n\r\n');
  const [start = '', ...headers] = text.slice(0, end).split('\r\n');
  const body = text.slice(end + 4);
  const parts: Part[] = [
    {
      id: 'http.start',
      label: message.type === 'request' ? 'Request line' : 'Status line',
      value: start,
      explain: startExplain(message),
      bytes: utf8(`${start}\r\n`),
    },
    ...headers.map((line) => {
      const colon = line.indexOf(': ');
      const name = line.slice(0, colon);
      return {
        id: `http.header.${name.toLowerCase()}`,
        label: name,
        value: line.slice(colon + 2),
        explain:
          HEADER_EXPLAIN[name] ?? 'A header: a name and a value that tell the other side more.',
        bytes: utf8(`${line}\r\n`),
      };
    }),
    {
      id: 'http.end',
      label: 'End of headers',
      value: 'Blank line (CR LF)',
      explain:
        message.type === 'request'
          ? 'An empty line ends the headers. A GET has no body, so the request ends here.'
          : 'An empty line ends the headers. The body follows.',
      bytes: utf8('\r\n'),
    },
  ];
  if (body === '') return parts;
  const bytes = utf8(body);
  const flat = body.replace(/\s+/g, ' ').trim();
  const preview = flat.length > PREVIEW ? `${flat.slice(0, PREVIEW)}…` : flat;
  return [
    ...parts,
    {
      id: 'http.body',
      label: 'Body',
      value: `${bytes.length} bytes: ${preview}`,
      explain:
        'The content itself, as many bytes as Content-Length says. For a web page, the HTML the browser draws.',
      bytes,
    },
  ];
}

// DNS

/** `query A www.lab.local`, `response www.lab.local A 192.168.1.20`, or a name that does not exist. */
export function describeDns(message: DnsMessage): string {
  if (message.type === 'query') return `query A ${message.name}`;
  if (message.rcode === 'name-error') return `response: no such name ${message.name}`;
  if (message.answers.length === 0) return `response ${message.name}: no A record`;
  return `response ${message.name} ${message.answers.map((answer) => `A ${answer.address}`).join(', ')}`;
}

const QR = 0x8000;
const AA = 0x0400;
const RD = 0x0100;
const RA = 0x0080;

const RCODE_TEXT = { 'no-error': 'no error', 'name-error': 'no such name' } as const;

/** Where the question's name starts: right after the 12-byte header. */
const NAME_OFFSET = 12;
const POINTER = 0xc000 | NAME_OFFSET;

const TYPE_A = 1;
const CLASS_IN = 1;

/** A name as DNS writes it: each label after its length, then a zero for the root. */
const labels = (name: string) => [
  ...name.split('.').flatMap((label) => {
    const bytes = utf8(label);
    return [bytes.length, ...bytes];
  }),
  0,
];

/** The encoding in words: `3 www 3 lab 5 local 0`. */
const spelled = (name: string) =>
  `${name
    .split('.')
    .map((label) => `${utf8(label).length} ${label}`)
    .join(' ')} 0`;

function dnsFlags(message: DnsMessage): [number, string, string] {
  if (message.type === 'query') {
    return [
      RD,
      'standard query, recursion desired',
      'QR 0 marks a query, and opcode 0 a standard one. RD asks the server to chase the answer down if it does not hold the name itself.',
    ];
  }
  const rcode = DNS_RCODE[message.rcode];
  return [
    QR | AA | RD | RA | rcode,
    `response, authoritative, recursion desired, recursion available, ${RCODE_TEXT[message.rcode]}`,
    `QR 1 marks a response. AA says the server holds the name itself. RA says it would chase down names it does not hold. The last 4 bits are the result: ${rcode}, ${RCODE_TEXT[message.rcode]}.`,
  ];
}

/** The 12-byte header, the question, then each answer. */
export function dnsParts(message: DnsMessage): Part[] {
  const [flags, flagsText, flagsExplain] = dnsFlags(message);
  const answers = message.type === 'response' ? message.answers : [];
  const counts: [string, string, number, string][] = [
    ['qdcount', 'Questions', 1, 'How many questions follow. A client asks one at a time.'],
    [
      'ancount',
      'Answers',
      answers.length,
      message.type === 'query'
        ? 'How many answers follow. A query has none.'
        : 'How many answers follow, each a record that gives the name’s address.',
    ],
    [
      'nscount',
      'Authority records',
      0,
      'Records that name the servers in charge of the name. None here.',
    ],
    ['arcount', 'Additional records', 0, 'Extra records the server thinks will help. None here.'],
  ];
  return [
    {
      id: 'dns.id',
      label: 'Transaction ID',
      value: hex(message.id, 4),
      explain:
        'A number the client picks at random. The response carries it back, so the client can match it to its query.',
      bytes: u16(message.id),
    },
    {
      id: 'dns.flags',
      label: 'Flags',
      value: `${hex(flags, 4)} (${flagsText})`,
      explain: flagsExplain,
      bytes: u16(flags),
    },
    ...counts.map(([key, label, count, explain]) => ({
      id: `dns.${key}`,
      label,
      value: String(count),
      explain,
      bytes: u16(count),
    })),
    {
      id: 'dns.name',
      label: 'Name',
      value: message.name,
      explain: `The name asked about. Each label goes after its length, and a zero ends the name: ${spelled(message.name)}.`,
      bytes: labels(message.name),
    },
    {
      id: 'dns.type',
      label: 'Type',
      value: `${TYPE_A} (A)`,
      explain: 'An A record holds an IPv4 address, so the question asks for the name’s address.',
      bytes: u16(TYPE_A),
    },
    {
      id: 'dns.class',
      label: 'Class',
      value: `${CLASS_IN} (IN)`,
      explain: 'IN is the internet. The other classes are all but unused.',
      bytes: u16(CLASS_IN),
    },
    ...answers.flatMap((answer, index): Part[] => {
      const label = `Answer ${index + 1}`;
      const id = `dns.${index + 1}`;
      const pointed = answer.name === message.name;
      return [
        {
          id: `${id}.name`,
          label: `${label} name`,
          value: pointed ? `${answer.name} (pointer)` : answer.name,
          explain: pointed
            ? 'The name from the question. Rather than spell it out again, two bytes point back to it at byte 12 (0xC00C).'
            : 'The name this record is about.',
          bytes: pointed ? u16(POINTER) : labels(answer.name),
        },
        {
          id: `${id}.type`,
          label: `${label} type`,
          value: `${TYPE_A} (A)`,
          explain: 'An A record: the data is an IPv4 address.',
          bytes: u16(TYPE_A),
        },
        {
          id: `${id}.class`,
          label: `${label} class`,
          value: `${CLASS_IN} (IN)`,
          explain: 'The internet class, as in the question.',
          bytes: u16(CLASS_IN),
        },
        {
          id: `${id}.ttl`,
          label: `${label} TTL`,
          value: formatSeconds(answer.ttl),
          explain: 'How long the client may keep the answer in its cache before it must ask again.',
          bytes: u32(answer.ttl),
        },
        {
          id: `${id}.length`,
          label: `${label} data length`,
          value: '4 bytes',
          explain: 'The size of the data that follows. An IPv4 address takes 4 bytes.',
          bytes: u16(4),
        },
        {
          id: `${id}.address`,
          label: `${label} address`,
          value: answer.address,
          explain: 'The answer itself: the name’s IPv4 address. The client connects to it next.',
          bytes: ipBytes(answer.address),
        },
      ];
    }),
  ];
}
