/**
 * The application protocols a server runs beyond DNS and HTTP, as plain data like every PDU:
 * TFTP, NTP and syslog over UDP, and FTP, SMTP and POP3 over TCP.
 */

/** Well-known ports of these protocols. */
export const APP_PORT = {
  tftp: 69,
  ntp: 123,
  syslog: 514,
  ftp: 21,
  smtp: 25,
  pop3: 110,
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

export type AppUdpPayload = TftpMessage | NtpMessage | SyslogMessage;

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
