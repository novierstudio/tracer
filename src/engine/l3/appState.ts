import type { Ipv4Address, StoredFile } from '@/model';
import { serverServices } from '@/model/defaults';
import type { FileService } from '../module';
import type { IpContext } from './context';
import type { FtpClient, FtpServerSession } from './ftp';
import type { MailJob, Pop3Session, SmtpSession } from './mail';
import type { NtpClient } from './ntp';
import type { TftpTransfer } from './tftp';

/** A mail a server holds in a user's mailbox until a POP3 client takes it. */
export type Mail = {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  /** The server's clock when the mail arrived, in milliseconds since 1970 UTC. */
  readonly received: number;
};

/** A message a syslog server logged: who sent it, and its text. */
export type SyslogEntry = {
  /** The sender's timestamp, as it wrote it: `*Mar  1 00:02:13.142`, `*` while its clock is unset. */
  readonly time: string;
  readonly host: Ipv4Address;
  /** The message without its timestamp, such as `%LINK-5-CHANGED: ...`. */
  readonly message: string;
};

/**
 * A server's TFTP or FTP files as the run changed them. `seen` is the config's list as JSON when
 * the run last took it, so a config edit to the files wins and an unrelated edit does not.
 */
type LiveFiles = { seen: string; live: readonly StoredFile[] };

/** The applications on one device: plain data, so snapshots copy it. */
export type AppState = {
  /** TFTP transfers, as client or server, by the local port they run on. */
  readonly tftp: Map<number, TftpTransfer>;
  readonly files: Partial<Record<FileService, LiveFiles>>;
  /** A server's FTP sessions, by control connection. */
  readonly ftpSessions: Map<number, FtpServerSession>;
  /** The ports a server's FTP sessions wait for a passive data connection on, by port. */
  readonly ftpPassive: Map<number, number>;
  /** FTP clients, by id. */
  readonly ftpClients: Map<number, FtpClient>;
  readonly smtpSessions: Map<number, SmtpSession>;
  readonly pop3Sessions: Map<number, Pop3Session>;
  /** Mails being sent or fetched, by id. */
  readonly mailJobs: Map<number, MailJob>;
  /** A mail server's mailboxes, by user name. */
  readonly mailboxes: Map<string, Mail[]>;
  /** A router or switch's NTP client, once it has servers to ask. */
  ntp: NtpClient | undefined;
  /** Console messages waiting to go to the logging hosts. */
  readonly syslogQueue: string[];
  /** A syslog server's log, oldest first. */
  readonly syslog: SyslogEntry[];
};

export const emptyApps = (): AppState => ({
  tftp: new Map(),
  files: {},
  ftpSessions: new Map(),
  ftpPassive: new Map(),
  ftpClients: new Map(),
  smtpSessions: new Map(),
  pop3Sessions: new Map(),
  mailJobs: new Map(),
  mailboxes: new Map(),
  ntp: undefined,
  syslogQueue: [],
  syslog: [],
});

/** The config's file list for a service, or none on a device that is not a server. */
function configFiles(ctx: IpContext, service: FileService): readonly StoredFile[] {
  return ctx.device.kind === 'server' ? serverServices(ctx.device.config)[service].files : [];
}

/** A server's TFTP or FTP files now: its config's, as uploads and deletions since have changed them. */
export function serviceFiles(ctx: IpContext, service: FileService): readonly StoredFile[] {
  const config = configFiles(ctx, service);
  const seen = JSON.stringify(config);
  const entry = ctx.state.apps.files[service];
  if (entry && entry.seen === seen) return entry.live;
  ctx.state.apps.files[service] = { seen, live: config };
  return config;
}

/** Changes a server's files, and asks for its config to keep them. */
export function setServiceFiles(
  ctx: IpContext,
  service: FileService,
  files: readonly StoredFile[],
) {
  serviceFiles(ctx, service);
  ctx.state.apps.files[service]!.live = files;
  ctx.learnFiles(service, files);
}

/** The file list with `file` added, replacing any of the same name in place. */
export function withFile(files: readonly StoredFile[], file: StoredFile): StoredFile[] {
  const index = files.findIndex((candidate) => candidate.name === file.name);
  if (index < 0) return [...files, file];
  return files.map((candidate, at) => (at === index ? file : candidate));
}

/** A router whose clock was never set counts from boot on March 1, 1993, as IOS does. */
export const BOOT_CLOCK = Date.UTC(1993, 2, 1);

/** A device's clock: what NTP set it to, or else the boot date plus the time since the run began. */
export function clockOf(ctx: IpContext): { readonly time: number; readonly synced: boolean } {
  const { ntp } = ctx.state.apps;
  if (ntp?.sync) return { time: ctx.now + ntp.sync.offset, synced: true };
  if (ctx.device.kind === 'server') {
    return { time: serverServices(ctx.device.config).ntp.epoch + ctx.now, synced: true };
  }
  return { time: BOOT_CLOCK + ctx.now, synced: false };
}

/** A free port in the dynamic range that no connection, query or transfer uses. */
export function freePort(ctx: IpContext, draw: () => number): number {
  let port = draw();
  while (ctx.state.apps.tftp.has(port) || ctx.state.apps.ftpPassive.has(port)) port = draw();
  return port;
}
