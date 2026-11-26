import { APP_PORT } from '../apps';
import type { Ipv4Packet, UdpDatagram } from '../pdu';
import type { TcpPayload } from '../tcp';
import type { IpContext } from './context';
import {
  ftpListening,
  onFtpAborted,
  onFtpAccepted,
  onFtpClosed,
  onFtpCommand,
  onFtpDataAborted,
  onFtpDataAccepted,
  onFtpDataArrived,
  onFtpDataOpened,
  onFtpDataReceived,
  onFtpReply,
  onFtpSessionEnded,
  stopFtp,
} from './ftp';
import {
  mailListening,
  onMailAborted,
  onMailClosed,
  onMailReply,
  onMailSessionEnded,
  onPop3Accepted,
  onPop3Command,
  onSmtpAccepted,
  onSmtpCommand,
  stopMail,
} from './mail';
import { onNtpMessage } from './ntp';
import { onSyslogMessage } from './syslog';
import type { TcpAbort } from './tcpStack';
import { onTftpRequest, onTftpTransfer, stopTftp } from './tftp';
import type { TcpConnection, TcpOwner } from './transport';

/**
 * Routes TCP and UDP to the server applications and their clients: TFTP, FTP, SMTP, POP3, NTP
 * and syslog. The transport layers call in here for what they do not handle themselves.
 */

type AppOwner = Extract<TcpOwner, { kind: 'app' }>;

/** The application that takes a connection to `port` on this device, if any. */
export function appListening(ctx: IpContext, port: number): AppOwner | undefined {
  const ftp = ftpListening(ctx, port);
  if (ftp === 'data') {
    return { kind: 'app', app: 'ftp-data-server', id: ctx.state.apps.ftpPassive.get(port)! };
  }
  if (ftp === 'control') return { kind: 'app', app: 'ftp-server', id: 0 };
  const mail = mailListening(ctx, port);
  if (mail) return { kind: 'app', app: mail === 'smtp' ? 'smtp-server' : 'pop3-server', id: 0 };
  return undefined;
}

/** An FTP control connection waits on its user, however long they take to type. */
export const appIdles = (owner: AppOwner) =>
  owner.app === 'ftp-server' || owner.app === 'ftp-client';

/** A connection to one of this device's applications finished its handshake. */
export function appAccepted(ctx: IpContext, owner: AppOwner, connection: TcpConnection) {
  switch (owner.app) {
    case 'ftp-server':
      return onFtpAccepted(ctx, connection);
    case 'ftp-data-server':
      return onFtpDataAccepted(ctx, owner.id, connection);
    case 'smtp-server':
      return onSmtpAccepted(ctx, connection);
    case 'pop3-server':
      return onPop3Accepted(ctx, connection);
    default:
      return;
  }
}

/** A connection a client application opened is up. */
export function appOpened(ctx: IpContext, owner: AppOwner, connection: TcpConnection) {
  if (owner.app === 'ftp-data-client') onFtpDataOpened(ctx, owner.id, connection);
}

export function appReceived(
  ctx: IpContext,
  owner: AppOwner,
  connection: TcpConnection,
  payload: TcpPayload,
) {
  switch (owner.app) {
    case 'ftp-server':
      return onFtpCommand(ctx, connection, payload);
    case 'ftp-data-server':
      return onFtpDataReceived(ctx, owner.id, connection, payload);
    case 'ftp-client':
      return onFtpReply(ctx, owner.id, payload);
    case 'ftp-data-client':
      return onFtpDataArrived(ctx, owner.id, payload);
    case 'smtp-server':
      return onSmtpCommand(ctx, connection, payload);
    case 'pop3-server':
      return onPop3Command(ctx, connection, payload);
    case 'mail-client':
      return onMailReply(ctx, owner.id, connection, payload);
  }
}

/** The peer closed the connection; this side has closed too. */
export function appClosed(ctx: IpContext, owner: AppOwner, connection: TcpConnection) {
  switch (owner.app) {
    case 'ftp-server':
      return onFtpSessionEnded(ctx, connection);
    case 'ftp-client':
      return onFtpClosed(ctx, owner.id);
    case 'smtp-server':
    case 'pop3-server':
      return onMailSessionEnded(ctx, connection);
    case 'mail-client':
      return onMailClosed(ctx, owner.id);
    default:
      return;
  }
}

/** The connection was refused, reset or went silent. */
export function appAborted(
  ctx: IpContext,
  owner: AppOwner,
  connection: TcpConnection,
  why: TcpAbort,
) {
  switch (owner.app) {
    case 'ftp-server':
      return onFtpSessionEnded(ctx, connection);
    case 'ftp-client':
      return onFtpAborted(ctx, owner.id, why);
    case 'ftp-data-client':
      return onFtpDataAborted(ctx, owner.id);
    case 'smtp-server':
    case 'pop3-server':
      return onMailSessionEnded(ctx, connection);
    case 'mail-client':
      return onMailAborted(ctx, owner.id, why);
    default:
      return;
  }
}

/**
 * A datagram for one of the UDP applications: TFTP's requests on 69 and its transfers on the
 * ports they run on, NTP on 123 and syslog on 514. Returns false for anything else.
 */
export function deliverAppUdp(ctx: IpContext, packet: Ipv4Packet, datagram: UdpDatagram): boolean {
  switch (datagram.payload.kind) {
    case 'tftp':
      if (datagram.dstPort === APP_PORT.tftp) onTftpRequest(ctx, packet, datagram);
      else onTftpTransfer(ctx, packet, datagram);
      return true;
    case 'ntp':
      if (datagram.dstPort === APP_PORT.ntp) onNtpMessage(ctx, packet, datagram);
      return true;
    case 'syslog':
      if (datagram.dstPort === APP_PORT.syslog) onSyslogMessage(ctx, packet, datagram);
      return true;
    default:
      return false;
  }
}

/** The device is going away: every transfer, session and job it started ends. */
export function stopApps(ctx: IpContext) {
  stopTftp(ctx);
  stopFtp(ctx);
  stopMail(ctx);
}
