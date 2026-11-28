import type { ThingKind, WirelessProfile } from '@/model';

/**
 * The application protocols a server runs beyond DNS and HTTP, as plain data like every PDU:
 * TFTP, NTP, syslog, CAPWAP and IoT over UDP, and FTP, SMTP and POP3 over TCP.
 */

/** Well-known ports of these protocols. */
export const APP_PORT = {
  tftp: 69,
  ntp: 123,
  syslog: 514,
  ftp: 21,
  smtp: 25,
  pop3: 110,
  capwap: 5246,
  iot: 5683,
} as const;

/** The most data one TFTP DATA packet carries. A shorter one is the transfer's last. */
export const TFTP_BLOCK = 512;

/**
 * A TFTP packet (RFC 1350). A transfer starts with a read or write request to port 69, and goes
 * on between the client's port and one the server picks for it, block by block, each acknowledged.
 */
export type TftpMessage =
  | {
      readonly kind: 'tftp';
      readonly op: 'rrq' | 'wrq';
      readonly file: string;
      readonly mode: 'octet';
    }
  | { readonly kind: 'tftp'; readonly op: 'data'; readonly block: number; readonly data: string }
  | { readonly kind: 'tftp'; readonly op: 'ack'; readonly block: number }
  | {
      readonly kind: 'tftp';
      readonly op: 'error';
      /** 1 is File not found, 2 Access violation. */
      readonly code: number;
      readonly message: string;
    };

export const TFTP_OPCODE = { rrq: 1, wrq: 2, data: 3, ack: 4, error: 5 } as const satisfies Record<
  TftpMessage['op'],
  number
>;

/**
 * An NTP packet (RFC 5905), reduced to what a client sets its clock from. Times are milliseconds
 * since 1970 UTC on the sender's clock.
 */
export type NtpMessage = {
  readonly kind: 'ntp';
  /** 3 is a client's request, 4 a server's answer. */
  readonly mode: 'client' | 'server';
  /** 1 for a server with its own reference clock, one more per hop away; 16 is unsynchronized. */
  readonly stratum: number;
  /** The poll interval as a power of two seconds. */
  readonly poll: number;
  /** The server's reference clock, as `127.127.1.1` names a local one. Empty in a request. */
  readonly reference: string;
  /** In an answer, the request's transmit time, so the client can match them. */
  readonly originate: number;
  readonly transmit: number;
};

/** The NTP mode numbers. */
export const NTP_MODE = { client: 3, server: 4 } as const;

/**
 * A syslog message (RFC 3164), as IOS sends one to a `logging host`: its facility (23, local7)
 * and severity make the priority, and `text` is the timestamped message, such as
 * `*Mar 01 00:02:13.142: %LINK-5-CHANGED: ...`.
 */
export type SyslogMessage = {
  readonly kind: 'syslog';
  readonly facility: number;
  /** 0 emergencies to 7 debugging, from the `%FACILITY-N-MNEMONIC` tag. */
  readonly severity: number;
  readonly text: string;
};

/** The facility IOS logs to unless `logging facility` says otherwise: local7. */
export const SYSLOG_FACILITY = 23;

/**
 * A CAPWAP control message (RFC 5415), between a lightweight AP and a wireless LAN controller. An
 * AP asks for controllers by Discovery Request, joins one, then takes its WLANs in Configuration
 * Update Requests, and keeps the session alive with Echo Requests.
 */
export type CapwapMessage =
  | { readonly kind: 'capwap'; readonly type: 'discovery-request' }
  | { readonly kind: 'capwap'; readonly type: 'discovery-response'; readonly controller: string }
  | {
      readonly kind: 'capwap';
      readonly type: 'join-request';
      /** The AP's name and model, as the controller lists it. */
      readonly ap: string;
      readonly model: string;
    }
  | { readonly kind: 'capwap'; readonly type: 'join-response' }
  | {
      readonly kind: 'capwap';
      readonly type: 'configuration-update';
      /** The controller's enabled WLANs, which the AP broadcasts. */
      readonly wlans: readonly WirelessProfile[];
    }
  | { readonly kind: 'capwap'; readonly type: 'echo-request' | 'echo-response' };

/** CAPWAP's control message types, as the header numbers them. */
export const CAPWAP_TYPE = {
  'discovery-request': 1,
  'discovery-response': 2,
  'join-request': 3,
  'join-response': 4,
  'configuration-update': 7,
  'echo-request': 13,
  'echo-response': 14,
} as const satisfies Record<CapwapMessage['type'], number>;

/**
 * A message between an IoT thing and its registration server: a Home Gateway, or a server with the
 * IoT service on. A thing registers with its kind and state, reports its state when it changes and
 * every so often, and takes the server's orders to change an actuator.
 */
export type IotMessage =
  | {
      readonly kind: 'iot';
      readonly type: 'register';
      readonly name: string;
      readonly thing: ThingKind;
      readonly state: Readonly<Record<string, string>>;
      /** The account it registers under on a remote server. A Home Gateway takes any. */
      readonly username: string;
      readonly password: string;
    }
  | {
      readonly kind: 'iot';
      readonly type: 'registered';
      readonly ok: boolean;
      /** Why the server refused, when it did. */
      readonly reason?: string;
    }
  | {
      readonly kind: 'iot';
      readonly type: 'report';
      readonly name: string;
      readonly state: Readonly<Record<string, string>>;
    }
  | { readonly kind: 'iot'; readonly type: 'set'; readonly key: string; readonly value: string };

export type AppUdpPayload = TftpMessage | NtpMessage | SyslogMessage | CapwapMessage | IotMessage;

/**
 * One command or reply on an FTP control connection, an SMTP session or a POP3 session. A reply
 * that spans lines, such as a POP3 listing or a mail's text, joins them with CR LF.
 */
export type LineMessage = {
  readonly kind: 'ftp' | 'smtp' | 'pop3';
  readonly text: string;
};

/** What an FTP data connection carries: a file's text, or a directory listing. */
export type FtpData = { readonly kind: 'ftp-data'; readonly text: string };

export type AppTcpPayload = LineMessage | FtpData;
