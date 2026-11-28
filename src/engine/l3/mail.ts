import type { Ipv4Address } from '@/model';
import { serverServices } from '@/model/defaults';
import { APP_PORT } from '../apps';
import { byteLength } from '../http';
import type { TcpPayload } from '../tcp';
import { clockOf, type Mail } from './appState';
import type { IpContext } from './context';
import type { DnsLookup } from './dnsResolver';
import { startLookup } from './dnsResolver';
import { asAddress } from './httpClient';
import { tcpClose, tcpConnect, tcpSend, type TcpAbort } from './tcpStack';
import type { TcpConnection } from './transport';

/** A mail to send: who from, who to, and what it says. */
export type OutgoingMail = {
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly body: string;
};

/** What an email client asks of its servers: to send a mail by SMTP, or fetch its mail by POP3. */
export type MailRequest =
  | { readonly kind: 'send'; readonly server: string; readonly mail: OutgoingMail }
  | {
      readonly kind: 'receive';
      readonly server: string;
      readonly username: string;
      readonly password: string;
    };

export type MailFailure =
  | { readonly kind: 'no-dns-server' }
  | { readonly kind: 'name-not-found'; readonly name: string }
  | { readonly kind: 'dns-timeout' }
  /** Nothing listens: the server is off, or not a mail server. */
  | { readonly kind: 'refused' }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'reset' }
  /** The server said no, as to an unknown recipient or a wrong password. */
  | { readonly kind: 'rejected'; readonly reply: string }
  | { readonly kind: 'cancelled' };

/** How a send or a fetch ended. A fetch's mails come off the server as it sends them. */
export type MailOutcome =
  | { readonly kind: 'sent'; readonly server: Ipv4Address }
  | { readonly kind: 'received'; readonly server: Ipv4Address; readonly mails: readonly Mail[] }
  | { readonly kind: 'failed'; readonly failure: MailFailure };

export type MailListener = (outcome: MailOutcome) => void;

export type MailJob = {
  readonly id: number;
  readonly request: MailRequest;
  readonly listener: MailListener;
  /** The server's address, once known. */
  address?: Ipv4Address;
  connection?: number;
  /** The commands still to send, one per reply. */
  queue: string[];
  /** The command whose reply comes next, for the replies that need reading. */
  awaiting?: string;
  readonly mails: Mail[];
};

export type SmtpSession = {
  from?: string;
  to: string[];
  /** Set after DATA's 354: the next message is the mail. */
  data?: true;
};

export type Pop3Session = {
  user?: string;
  /** The mailbox's owner, once PASS matched. */
  authed?: string;
  /** Messages marked by DELE, removed at QUIT, by number from 1. */
  readonly deleted: Set<number>;
};

// Mail text

/** A mail as SMTP's DATA carries it: headers, a blank line, then the body. */
export function mailText(mail: OutgoingMail): string {
  return [
    `From: ${mail.from}`,
    `To: ${mail.to.join(', ')}`,
    `Subject: ${mail.subject}`,
    '',
    mail.body,
  ].join('\r\n');
}

function parseMail(text: string, received: number): Mail {
  const split = text.indexOf('\r\n\r\n');
  const head = split < 0 ? text : text.slice(0, split);
  const body = split < 0 ? '' : text.slice(split + 4);
  const header = (name: string) =>
    head
      .split('\r\n')
      .find((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`))
      ?.slice(name.length + 1)
      .trim() ?? '';
  return { from: header('From'), to: header('To'), subject: header('Subject'), body, received };
}

/** `user@domain` split into its parts, in lower case, or undefined when it is not one. */
function splitAddress(address: string): { user: string; domain: string } | undefined {
  const match = /^<?([^@\s<>]+)@([^@\s<>]+)>?$/.exec(address.trim());
  return match ? { user: match[1]!.toLowerCase(), domain: match[2]!.toLowerCase() } : undefined;
}

// Servers

/** Which mail service listens on `port`: SMTP on 25 or POP3 on 110, each when it is on. */
export function mailListening(ctx: IpContext, port: number): 'smtp' | 'pop3' | undefined {
  if (ctx.device.kind !== 'server') return undefined;
  const { email } = serverServices(ctx.device.config);
  if (port === APP_PORT.smtp && email.smtp) return 'smtp';
  if (port === APP_PORT.pop3 && email.pop3) return 'pop3';
  return undefined;
}

const send = (ctx: IpContext, connection: TcpConnection, kind: 'smtp' | 'pop3', text: string) =>
  tcpSend(ctx, connection, { kind, text });

const domainOf = (ctx: IpContext) =>
  ctx.device.kind === 'server' ? serverServices(ctx.device.config).email.domain.toLowerCase() : '';

const userOf = (ctx: IpContext, name: string) =>
  ctx.device.kind === 'server'
    ? serverServices(ctx.device.config).email.users.find(
        (user) => user.username.toLowerCase() === name.toLowerCase(),
      )
    : undefined;

export function onSmtpAccepted(ctx: IpContext, connection: TcpConnection) {
  ctx.state.apps.smtpSessions.set(connection.id, { to: [] });
  send(ctx, connection, 'smtp', `220 ${domainOf(ctx) || 'localhost'} ESMTP Service ready`);
}

export function onPop3Accepted(ctx: IpContext, connection: TcpConnection) {
  ctx.state.apps.pop3Sessions.set(connection.id, { deleted: new Set() });
  send(ctx, connection, 'pop3', '+OK POP3 server ready');
}

/** A command, or the mail after DATA, on an SMTP session. Mail for a local user is delivered. */
export function onSmtpCommand(ctx: IpContext, connection: TcpConnection, payload: TcpPayload) {
  const session = ctx.state.apps.smtpSessions.get(connection.id);
  if (!session || payload.kind !== 'smtp') return;
  const answer = (text: string) => send(ctx, connection, 'smtp', text);
  if (session.data) {
    session.data = undefined;
    const text = payload.text.replace(/\r\n\.$/, '');
    const mail = parseMail(text, clockOf(ctx).time);
    for (const recipient of session.to) {
      const user = splitAddress(recipient)!.user;
      const box = ctx.state.apps.mailboxes.get(user) ?? [];
      ctx.state.apps.mailboxes.set(user, [...box, mail]);
    }
    session.from = undefined;
    session.to = [];
    answer('250 OK');
    return;
  }
  const [verb = '', ...rest] = payload.text.split(' ');
  const argument = rest.join(' ');
  switch (verb.toUpperCase()) {
    case 'HELO':
    case 'EHLO':
      return answer(`250 ${domainOf(ctx) || 'localhost'}`);
    case 'MAIL':
      session.from = argument.replace(/^FROM:/i, '');
      session.to = [];
      return answer('250 OK');
    case 'RCPT': {
      const address = splitAddress(argument.replace(/^TO:/i, ''));
      const local = address && address.domain === domainOf(ctx) && userOf(ctx, address.user);
      if (!address || !local) return answer('550 Requested action not taken: mailbox unavailable');
      session.to.push(`${address.user}@${address.domain}`);
      return answer('250 OK');
    }
    case 'DATA':
      if (session.to.length === 0) return answer('503 Bad sequence of commands');
      session.data = true;
      return answer('354 Start mail input; end with <CRLF>.<CRLF>');
    case 'QUIT':
      answer('221 Service closing transmission channel');
      tcpClose(ctx, connection);
      return;
    default:
      return answer('502 Command not implemented');
  }
}

/** A command on a POP3 session. QUIT removes the messages DELE marked. */
export function onPop3Command(ctx: IpContext, connection: TcpConnection, payload: TcpPayload) {
  const session = ctx.state.apps.pop3Sessions.get(connection.id);
  if (!session || payload.kind !== 'pop3') return;
  const answer = (text: string) => send(ctx, connection, 'pop3', text);
  const [verb = '', ...rest] = payload.text.split(' ');
  const argument = rest.join(' ');
  const box = session.authed ? (ctx.state.apps.mailboxes.get(session.authed) ?? []) : [];
  const message = (number: number) => (session.deleted.has(number) ? undefined : box[number - 1]);
  switch (verb.toUpperCase()) {
    case 'USER':
      session.user = argument;
      return answer('+OK');
    case 'PASS': {
      const user = session.user === undefined ? undefined : userOf(ctx, session.user);
      if (!user || user.password !== argument) return answer('-ERR Authentication failed');
      session.authed = user.username.toLowerCase();
      return answer('+OK Logged in');
    }
    case 'QUIT':
      if (session.authed) {
        const kept = box.filter((_mail, index) => !session.deleted.has(index + 1));
        ctx.state.apps.mailboxes.set(session.authed, kept);
      }
      answer('+OK Bye');
      tcpClose(ctx, connection);
      return;
    default:
      break;
  }
  if (!session.authed) return answer('-ERR Not logged in');
  switch (verb.toUpperCase()) {
    case 'LIST': {
      const lines = box.flatMap((mail, index) =>
        session.deleted.has(index + 1)
          ? []
          : [`${index + 1} ${byteLength(mailText(asOutgoing(mail)))}`],
      );
      return answer([`+OK ${lines.length} messages`, ...lines, '.'].join('\r\n'));
    }
    case 'RETR': {
      const mail = message(Number(argument));
      if (!mail) return answer('-ERR No such message');
      const text = mailText(asOutgoing(mail));
      return answer([`+OK ${byteLength(text)} octets`, text, '.'].join('\r\n'));
    }
    case 'DELE':
      if (!message(Number(argument))) return answer('-ERR No such message');
      session.deleted.add(Number(argument));
      return answer('+OK');
    default:
      return answer('-ERR Command not implemented');
  }
}

const asOutgoing = (mail: Mail): OutgoingMail => ({
  from: mail.from,
  to: mail.to.split(/,\s*/),
  subject: mail.subject,
  body: mail.body,
});

export function onMailSessionEnded(ctx: IpContext, connection: TcpConnection) {
  ctx.state.apps.smtpSessions.delete(connection.id);
  ctx.state.apps.pop3Sessions.delete(connection.id);
}

// Clients

function finish(ctx: IpContext, job: MailJob, outcome: MailOutcome) {
  ctx.state.apps.mailJobs.delete(job.id);
  job.listener(outcome);
}

const fail = (ctx: IpContext, job: MailJob, failure: MailFailure) =>
  finish(ctx, job, { kind: 'failed', failure });

function connect(ctx: IpContext, job: MailJob, address: Ipv4Address) {
  job.address = address;
  const { request } = job;
  const port = request.kind === 'send' ? APP_PORT.smtp : APP_PORT.pop3;
  job.queue =
    request.kind === 'send'
      ? [
          `HELO ${ctx.device.config.hostname}`,
          `MAIL FROM:<${request.mail.from}>`,
          ...request.mail.to.map((to) => `RCPT TO:<${to}>`),
          'DATA',
          `${mailText(request.mail)}\r\n.`,
          'QUIT',
        ]
      : [`USER ${request.username}`, `PASS ${request.password}`, 'LIST'];
  const connection = tcpConnect(ctx, address, port, {
    kind: 'app',
    app: 'mail-client',
    id: job.id,
  });
  job.connection = connection.id;
}

/**
 * Sends a mail by SMTP, or fetches a user's mail by POP3, from this device. A server named rather
 * than given by address is looked up with DNS first. `listener` hears the outcome once.
 */
export function startMail(ctx: IpContext, request: MailRequest, listener: MailListener) {
  const { transport } = ctx.state;
  const job: MailJob = { id: transport.nextId++, request, listener, queue: [], mails: [] };
  ctx.state.apps.mailJobs.set(job.id, job);
  const address = asAddress(request.server.trim());
  if (address) {
    connect(ctx, job, address);
    return;
  }
  if (!startLookup(ctx, request.server, undefined, { kind: 'mail', job: job.id })) {
    fail(ctx, job, { kind: 'no-dns-server' });
  }
}

/** The lookup of a mail job's server came back. */
export function onMailResolved(ctx: IpContext, id: number, lookup: DnsLookup) {
  const job = ctx.state.apps.mailJobs.get(id);
  if (!job) return;
  switch (lookup.kind) {
    case 'answer':
      return connect(ctx, job, lookup.address);
    case 'not-found':
      return fail(ctx, job, { kind: 'name-not-found', name: lookup.name });
    case 'timeout':
      return fail(ctx, job, { kind: 'dns-timeout' });
    case 'no-server':
      return fail(ctx, job, { kind: 'no-dns-server' });
    case 'cancelled':
      return fail(ctx, job, { kind: 'cancelled' });
  }
}

const okReply = (kind: 'smtp' | 'pop3', text: string) =>
  kind === 'pop3' ? text.startsWith('+OK') : /^[23]\d\d/.test(text);

/**
 * A reply on a mail client's session: send the next command, or end. POP3's LIST adds a RETR
 * and a DELE for each message; each RETR's reply carries one mail.
 */
export function onMailReply(
  ctx: IpContext,
  id: number,
  connection: TcpConnection,
  payload: TcpPayload,
) {
  const job = ctx.state.apps.mailJobs.get(id);
  if (!job || (payload.kind !== 'smtp' && payload.kind !== 'pop3')) return;
  const { kind, text } = payload;
  const answered = job.awaiting;
  if (!okReply(kind, text)) {
    job.queue = [];
    tcpClose(ctx, connection);
    fail(ctx, job, { kind: 'rejected', reply: text.split('\r\n')[0]! });
    return;
  }
  if (answered === 'LIST') {
    const count = text.split('\r\n').slice(1, -1).length;
    for (let number = 1; number <= count; number += 1) job.queue.push(`RETR ${number}`);
    for (let number = 1; number <= count; number += 1) job.queue.push(`DELE ${number}`);
    job.queue.push('QUIT');
  }
  if (answered?.startsWith('RETR ')) {
    const lines = text.split('\r\n');
    job.mails.push(parseMail(lines.slice(1, -1).join('\r\n'), clockOf(ctx).time));
  }
  if (answered === 'QUIT') {
    const server = job.address!;
    finish(
      ctx,
      job,
      job.request.kind === 'send'
        ? { kind: 'sent', server }
        : { kind: 'received', server, mails: job.mails },
    );
    return;
  }
  const next = job.queue.shift();
  if (next === undefined) return;
  job.awaiting = next.startsWith('From: ') ? 'mail' : next;
  send(ctx, connection, kind, next);
}

export function onMailAborted(ctx: IpContext, id: number, why: TcpAbort) {
  const job = ctx.state.apps.mailJobs.get(id);
  if (job) fail(ctx, job, { kind: why });
}

/** The server closed the session before the job ended. */
export function onMailClosed(ctx: IpContext, id: number) {
  const job = ctx.state.apps.mailJobs.get(id);
  if (job) fail(ctx, job, { kind: 'reset' });
}

/** The device is going away: every send or fetch still running hears that it was cancelled. */
export function stopMail(ctx: IpContext) {
  for (const job of [...ctx.state.apps.mailJobs.values()]) fail(ctx, job, { kind: 'cancelled' });
}
