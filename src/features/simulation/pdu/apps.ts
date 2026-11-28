import {
  APP_PORT,
  CAPWAP_TYPE,
  NTP_MODE,
  type CapwapMessage,
  type IotMessage,
  TFTP_OPCODE,
  type AppTcpPayload,
  type AppUdpPayload,
  type LineMessage,
  type NtpMessage,
  type SyslogMessage,
  type TftpMessage,
} from '@/engine/apps';
import { formatSeconds, hex, u16, u32, type Part } from './encode';

/** Dissectors for the server services: TFTP, NTP and syslog over UDP, FTP, SMTP and POP3 over TCP. */

export type AppPayload = AppUdpPayload | AppTcpPayload;

/** The well-known ports of these services, by number, for the transport layers' summaries. */
export const APP_PORT_NAMES: Record<number, string> = {
  [APP_PORT.tftp]: 'TFTP',
  [APP_PORT.ntp]: 'NTP',
  [APP_PORT.syslog]: 'Syslog',
  [APP_PORT.ftp]: 'FTP',
  [APP_PORT.smtp]: 'SMTP',
  [APP_PORT.pop3]: 'POP3',
  [APP_PORT.capwap]: 'CAPWAP',
  [APP_PORT.iot]: 'IoT',
};

/** Each service's name as the inspector shows it. */
export const APP_NAMES: Record<AppPayload['kind'], string> = {
  tftp: 'TFTP',
  ntp: 'NTP',
  syslog: 'Syslog',
  ftp: 'FTP',
  'ftp-data': 'FTP-DATA',
  smtp: 'SMTP',
  pop3: 'POP3',
  capwap: 'CAPWAP',
  iot: 'IoT',
};

const CAPWAP_NAMES: Record<CapwapMessage['type'], string> = {
  'discovery-request': 'Discovery Request',
  'discovery-response': 'Discovery Response',
  'join-request': 'Join Request',
  'join-response': 'Join Response',
  'configuration-update': 'Configuration Update Request',
  'echo-request': 'Echo Request',
  'echo-response': 'Echo Response',
};

const CAPWAP_EXPLAIN: Record<CapwapMessage['type'], string> = {
  'discovery-request':
    'A lightweight AP asks for wireless LAN controllers: the ones its DHCP option 43 named, or every controller on its subnet by broadcast.',
  'discovery-response': 'A controller answers an AP looking for one, with its name.',
  'join-request': 'The AP asks to join the controller that answered first.',
  'join-response': 'The controller takes the AP, and lists it among its APs.',
  'configuration-update':
    'The controller pushes its enabled WLANs. The AP broadcasts them, and its clients can associate.',
  'echo-request': 'The AP checks every 30 seconds that its controller is still there.',
  'echo-response': 'The controller answers the AP’s keepalive.',
};

function describeIot(message: IotMessage): string {
  switch (message.type) {
    case 'register':
      return `IoT register ${message.name}`;
    case 'registered':
      return message.ok ? 'IoT registered' : 'IoT registration refused';
    case 'report':
      return `IoT report ${message.name}`;
    case 'set':
      return `IoT set ${message.key} to ${message.value}`;
  }
}

const stateText = (state: Readonly<Record<string, string>>) =>
  Object.entries(state)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');

function iotParts(message: IotMessage): Part[] {
  const type: Part = {
    id: 'iot.type',
    label: 'Message',
    value: message.type,
    explain:
      'A thing registers with its server, then reports its state; the server orders it to change an actuator.',
    bytes: utf8(message.type),
  };
  switch (message.type) {
    case 'register':
      return [
        type,
        {
          id: 'iot.name',
          label: 'Device',
          value: `${message.name} (${message.thing})`,
          explain: 'The thing’s name and kind, as the server’s page lists it.',
          bytes: utf8(message.name),
        },
        {
          id: 'iot.account',
          label: 'Account',
          value: message.username || '(none)',
          explain:
            'A remote IoT server registers a thing under an account. A Home Gateway takes any.',
          bytes: utf8(message.username),
        },
        {
          id: 'iot.state',
          label: 'State',
          value: stateText(message.state),
          explain: 'Each attribute’s state now.',
          bytes: utf8(stateText(message.state)),
        },
      ];
    case 'registered':
      return [
        type,
        {
          id: 'iot.result',
          label: 'Result',
          value: message.ok ? 'OK' : (message.reason ?? 'Not registered'),
          explain: 'Whether the server took the thing. A thing it refused registers again.',
          bytes: [message.ok ? 1 : 0],
        },
      ];
    case 'report':
      return [
        type,
        {
          id: 'iot.state',
          label: 'State',
          value: stateText(message.state),
          explain: 'The thing’s state, sent when it changes and every 30 seconds.',
          bytes: utf8(stateText(message.state)),
        },
      ];
    case 'set':
      return [
        type,
        {
          id: 'iot.set',
          label: 'Order',
          value: `${message.key} = ${message.value}`,
          explain: 'The server tells the thing to change an actuator, as its web page asked.',
          bytes: utf8(`${message.key}=${message.value}`),
        },
      ];
  }
}

function capwapParts(message: CapwapMessage): Part[] {
  const parts: Part[] = [
    {
      id: 'capwap.type',
      label: 'Message type',
      value: `${CAPWAP_TYPE[message.type]} (${CAPWAP_NAMES[message.type]})`,
      explain: CAPWAP_EXPLAIN[message.type],
      bytes: u32(CAPWAP_TYPE[message.type]),
    },
  ];
  if (message.type === 'discovery-response') {
    parts.push({
      id: 'capwap.controller',
      label: 'AC name',
      value: message.controller,
      explain: 'The controller’s name.',
      bytes: utf8(message.controller),
    });
  }
  if (message.type === 'join-request') {
    parts.push({
      id: 'capwap.ap',
      label: 'WTP name',
      value: `${message.ap} (${message.model})`,
      explain: 'The AP’s name and model, as the controller lists it.',
      bytes: utf8(message.ap),
    });
  }
  if (message.type === 'configuration-update') {
    const ssids = message.wlans.map((wlan) => wlan.ssid).join(', ') || 'none';
    parts.push({
      id: 'capwap.wlans',
      label: 'WLANs',
      value: ssids,
      explain: 'The SSIDs the AP broadcasts from now on, with their security.',
      bytes: utf8(ssids),
    });
  }
  return parts;
}

const encoder = new TextEncoder();
const utf8 = (text: string) => [...encoder.encode(text)];
const firstLine = (text: string) => text.split('\r\n')[0] ?? '';

const TFTP_NAMES: Record<TftpMessage['op'], string> = {
  rrq: 'Read request',
  wrq: 'Write request',
  data: 'Data',
  ack: 'Acknowledgement',
  error: 'Error',
};

function describeTftp(message: TftpMessage): string {
  switch (message.op) {
    case 'rrq':
    case 'wrq':
      return `${TFTP_NAMES[message.op]}, File: ${message.file}`;
    case 'data':
      return `Data block ${message.block}, ${utf8(message.data).length} bytes`;
    case 'ack':
      return `Acknowledgement, block ${message.block}`;
    case 'error':
      return `Error ${message.code}: ${message.message}`;
  }
}

const SEVERITIES = [
  'emergencies',
  'alerts',
  'critical',
  'errors',
  'warnings',
  'notifications',
  'informational',
  'debugging',
];

/** `TFTP Write request, File: R1-confg` or `SMTP: 250 OK`: the message in one line. */
export function describeApp(payload: AppPayload): string {
  switch (payload.kind) {
    case 'tftp':
      return `TFTP ${describeTftp(payload)}`;
    case 'ntp':
      return payload.mode === 'client'
        ? 'NTP client request'
        : `NTP server reply, stratum ${payload.stratum}`;
    case 'syslog':
      return `Syslog: ${payload.text}`;
    case 'ftp':
    case 'smtp':
    case 'pop3':
      return `${APP_NAMES[payload.kind]}: ${firstLine(payload.text)}`;
    case 'ftp-data':
      return `FTP-DATA: ${utf8(payload.text).length} bytes`;
    case 'capwap':
      return `CAPWAP ${CAPWAP_NAMES[payload.type]}`;
    case 'iot':
      return describeIot(payload);
  }
}

function tftpParts(message: TftpMessage): Part[] {
  const opcode: Part = {
    id: 'tftp.opcode',
    label: 'Opcode',
    value: `${TFTP_OPCODE[message.op]} (${TFTP_NAMES[message.op]})`,
    explain:
      'What the packet is: 1 asks to read a file, 2 to write one, 3 carries a block, 4 acknowledges one, 5 reports an error.',
    bytes: u16(TFTP_OPCODE[message.op]),
  };
  switch (message.op) {
    case 'rrq':
    case 'wrq':
      return [
        opcode,
        {
          id: 'tftp.file',
          label: 'File name',
          value: message.file,
          explain: 'The file to read or write on the server, ended by a zero byte.',
          bytes: [...utf8(message.file), 0],
        },
        {
          id: 'tftp.mode',
          label: 'Mode',
          value: message.mode,
          explain: 'octet sends the file byte for byte, with no line-ending changes.',
          bytes: [...utf8(message.mode), 0],
        },
      ];
    case 'data':
      return [
        opcode,
        {
          id: 'tftp.block',
          label: 'Block',
          value: String(message.block),
          explain:
            'Which 512-byte block of the file this is, counting from 1. A block shorter than 512 bytes is the last.',
          bytes: u16(message.block),
        },
        {
          id: 'tftp.data',
          label: 'Data',
          value: `${utf8(message.data).length} bytes`,
          explain: 'The block’s bytes. The receiver acknowledges it before the next one comes.',
          bytes: utf8(message.data),
        },
      ];
    case 'ack':
      return [
        opcode,
        {
          id: 'tftp.block',
          label: 'Block',
          value: String(message.block),
          explain:
            'The block received. Block 0 answers a write request: the server is ready for block 1.',
          bytes: u16(message.block),
        },
      ];
    case 'error':
      return [
        opcode,
        {
          id: 'tftp.code',
          label: 'Error code',
          value: String(message.code),
          explain: '1 is File not found, 2 Access violation. The transfer ends here.',
          bytes: u16(message.code),
        },
        {
          id: 'tftp.message',
          label: 'Error message',
          value: message.message,
          explain: 'The error in words, ended by a zero byte.',
          bytes: [...utf8(message.message), 0],
        },
      ];
  }
}

/** NTP counts seconds from 1900; Unix time from 1970. */
const NTP_EPOCH_OFFSET = 2208988800;

function ntpTimestamp(time: number): number[] {
  if (time === 0) return [...u32(0), ...u32(0)];
  const seconds = Math.floor(time / 1000) + NTP_EPOCH_OFFSET;
  const fraction = Math.floor(((time % 1000) / 1000) * 0x1_0000_0000);
  return [...u32(seconds), ...u32(fraction)];
}

const ntpTime = (time: number) => (time === 0 ? '0 (unset)' : new Date(time).toISOString());

function ntpParts(message: NtpMessage): Part[] {
  const mode = NTP_MODE[message.mode];
  const first = (4 << 3) | mode;
  const reference =
    message.reference === '' ? [0, 0, 0, 0] : message.reference.split('.').map(Number);
  return [
    {
      id: 'ntp.flags',
      label: 'Flags',
      value: `${hex(first, 2)} (version 4, mode ${mode}, ${message.mode})`,
      explain:
        'The leap indicator, the version and the mode. Mode 3 is a client asking the time, mode 4 a server answering.',
      bytes: [first],
    },
    {
      id: 'ntp.stratum',
      label: 'Stratum',
      value: String(message.stratum),
      explain:
        'How far the sender is from a reference clock: 1 has its own, each hop adds one, 16 means not synchronized.',
      bytes: [message.stratum],
    },
    {
      id: 'ntp.poll',
      label: 'Poll',
      value: `${message.poll} (${formatSeconds(2 ** message.poll)})`,
      explain: 'How often the client asks, as a power of two seconds.',
      bytes: [message.poll],
    },
    {
      id: 'ntp.precision',
      label: 'Precision',
      value: '-19',
      explain: 'How fine the sender’s clock is, as a power of two seconds.',
      bytes: [0xed],
    },
    {
      id: 'ntp.delay',
      label: 'Root delay',
      value: '0',
      explain: 'The round trip to the reference clock.',
      bytes: u32(0),
    },
    {
      id: 'ntp.dispersion',
      label: 'Root dispersion',
      value: '0',
      explain: 'How far off the reference clock may be.',
      bytes: u32(0),
    },
    {
      id: 'ntp.reference',
      label: 'Reference ID',
      value: message.reference || '(none)',
      explain: 'The clock the sender follows. 127.127.1.1 is its own local clock.',
      bytes: reference,
    },
    {
      id: 'ntp.originate',
      label: 'Origin timestamp',
      value: ntpTime(message.originate),
      explain:
        'In an answer, the request’s transmit time, so the client can match them and time the round trip.',
      bytes: [...ntpTimestamp(0), ...ntpTimestamp(message.originate)],
    },
    {
      id: 'ntp.transmit',
      label: 'Transmit timestamp',
      value: ntpTime(message.transmit),
      explain: 'The sender’s clock as the packet left. A client sets its clock from the server’s.',
      bytes: [...ntpTimestamp(message.transmit), ...ntpTimestamp(message.transmit)],
    },
  ];
}

function syslogParts(message: SyslogMessage): Part[] {
  const priority = message.facility * 8 + message.severity;
  return [
    {
      id: 'syslog.priority',
      label: 'Priority',
      value: `<${priority}> (facility local${message.facility - 16}, ${SEVERITIES[message.severity]})`,
      explain:
        'The facility times 8 plus the severity. IOS logs to local7, and the severity comes from the %FACILITY-N-MNEMONIC tag.',
      bytes: utf8(`<${priority}>`),
    },
    {
      id: 'syslog.message',
      label: 'Message',
      value: message.text,
      explain: 'The timestamp and the message, as it shows on the device’s console.',
      bytes: utf8(message.text),
    },
  ];
}

const LINE_EXPLAIN: Record<LineMessage['kind'], string> = {
  ftp: 'One FTP command, or the server’s numbered reply, on the control connection. Files travel on a separate data connection.',
  smtp: 'One SMTP command, or the server’s numbered reply. SMTP carries mail from a client to its server.',
  pop3: 'One POP3 command, or the server’s +OK or -ERR reply. POP3 lets a client fetch its mail from the server.',
};

function lineParts(message: LineMessage): Part[] {
  return message.text.split('\r\n').map((line, index) => ({
    id: `${message.kind}.line${index + 1}`,
    label: index === 0 ? 'Line' : `Line ${index + 1}`,
    value: line,
    explain: LINE_EXPLAIN[message.kind],
    bytes: utf8(`${line}\r\n`),
  }));
}

/** The fields of an application message, in wire order, with their bytes. */
export function appParts(payload: AppPayload): Part[] {
  switch (payload.kind) {
    case 'tftp':
      return tftpParts(payload);
    case 'ntp':
      return ntpParts(payload);
    case 'syslog':
      return syslogParts(payload);
    case 'ftp':
    case 'smtp':
    case 'pop3':
      return lineParts(payload);
    case 'capwap':
      return capwapParts(payload);
    case 'iot':
      return iotParts(payload);
    case 'ftp-data':
      return [
        {
          id: 'ftp-data.data',
          label: 'Data',
          value: `${utf8(payload.text).length} bytes`,
          explain:
            'A file’s bytes, or a directory listing, on the data connection the client opened for this transfer.',
          bytes: utf8(payload.text),
        },
      ];
  }
}
