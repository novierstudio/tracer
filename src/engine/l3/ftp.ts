import type { FtpPermissions, Ipv4Address, StoredFile } from '@/model';
import { SERVER_IMAGES, serverServices } from '@/model/defaults';
import { APP_PORT } from '../apps';
import { byteLength } from '../http';
import type { TcpPayload } from '../tcp';
import { freePort, serviceFiles, setServiceFiles, withFile } from './appState';
import type { IpContext } from './context';
import { tcpClose, tcpConnect, tcpSend, type TcpAbort } from './tcpStack';
import { ephemeralPort, type TcpConnection } from './transport';

/** What a user types at `ftp>`, as the client sends it. */
export type FtpRequest =
  | { readonly kind: 'user'; readonly name: string }
  | { readonly kind: 'pass'; readonly password: string }
  | { readonly kind: 'put'; readonly file: string; readonly content: string }
  | { readonly kind: 'get'; readonly file: string }
  | { readonly kind: 'list' }
  | { readonly kind: 'delete'; readonly file: string }
  | { readonly kind: 'rename'; readonly from: string; readonly to: string }
  | { readonly kind: 'quit' };

/** A server reply: `331 Username ok, need password`. */
export type FtpReply = { readonly code: number; readonly text: string };

/** A file in a server's listing, with its size in bytes. */
export type FtpListing = { readonly name: string; readonly size: number };

/**
 * How a request ended: the server's last reply, and for a `get` the file, for a `list` the
 * listing, when the server sent them.
 */
export type FtpResult = {
  readonly request: FtpRequest['kind'];
  readonly reply: FtpReply;
  readonly content?: string;
  readonly listing?: readonly FtpListing[];
};

/**
 * An FTP session, step by step: `open` with the server's greeting, or `failed`; then a `result`
 * for each request; then `closed` when the server ends the session.
 */
export type FtpEvent =
  | { readonly kind: 'open'; readonly greeting: FtpReply }
  | { readonly kind: 'failed'; readonly why: TcpAbort | 'cancelled' }
  /** `seq` counts the session's results from 1. */
  | { readonly kind: 'result'; readonly seq: number; readonly result: FtpResult }
  | { readonly kind: 'closed' };

export type FtpListener = (event: FtpEvent) => void;

/** Where a request is: waiting on a reply, on the data connection, or on both. */
type FtpStep = 'reply' | 'pasv' | 'data-open' | 'transfer' | 'rnfr';

export type FtpClient = {
  readonly id: number;
  readonly server: Ipv4Address;
  readonly listener: FtpListener;
  connection?: number;
  /** Set once the greeting came. */
  opened?: true;
  request?: FtpRequest;
  step?: FtpStep;
  /** The passive data connection of the request in progress. */
  data?: number;
  /** What came over the data connection. */
  received?: string;
  /** How many requests have ended. */
  results: number;
};

export type FtpServerSession = {
  /** The user named by USER, before PASS. */
  user?: string;
  /** What the logged-in user may do. */
  permissions?: FtpPermissions;
  /** RNFR's file, until RNTO. */
  renameFrom?: string;
  /** The passive data connection, once the client opened it. */
  data?: number;
  /** STOR's file, until its data arrives. */
  storing?: string;
};

const reply = (code: number, text: string): FtpReply => ({ code, text });

const replyText = ({ code, text }: FtpReply) => `${code} ${text}`;

/** `331 Username ok, need password` as a reply. */
export function parseReply(text: string): FtpReply {
  const match = /^(\d{3})[ -]?(.*)$/.exec(text.split('\r\n')[0] ?? '');
  return match ? reply(Number(match[1]), match[2]!) : reply(500, text);
}

// Server

/** Whether a server's FTP listens on `port`: 21 with FTP on, or a passive data port it opened. */
export function ftpListening(ctx: IpContext, port: number): 'control' | 'data' | undefined {
  if (ctx.state.apps.ftpPassive.has(port)) return 'data';
  if (port !== APP_PORT.ftp || ctx.device.kind !== 'server') return undefined;
  return serverServices(ctx.device.config).ftp.enabled ? 'control' : undefined;
}

const sendLine = (ctx: IpContext, connection: TcpConnection, line: FtpReply | string) =>
  tcpSend(ctx, connection, {
    kind: 'ftp',
    text: typeof line === 'string' ? line : replyText(line),
  });

/** A client connected to port 21: greet it. */
export function onFtpAccepted(ctx: IpContext, connection: TcpConnection) {
  ctx.state.apps.ftpSessions.set(connection.id, {});
  sendLine(ctx, connection, reply(220, 'Welcome to PT Ftp server'));
}

/** A client opened the passive data connection a session waits for. */
export function onFtpDataAccepted(ctx: IpContext, control: number, connection: TcpConnection) {
  ctx.state.apps.ftpPassive.delete(connection.localPort);
  const session = ctx.state.apps.ftpSessions.get(control);
  if (session) session.data = connection.id;
  else tcpClose(ctx, connection);
}

/** Every file the server lists: the IOS images it ships with, then the uploaded ones. */
function listing(ctx: IpContext): FtpListing[] {
  const uploaded = serviceFiles(ctx, 'ftp');
  const names = new Set(uploaded.map((file) => file.name));
  return [
    ...SERVER_IMAGES.filter((image) => !names.has(image.name)),
    ...uploaded.map((file) => ({ name: file.name, size: byteLength(file.content) })),
  ];
}

const findFile = (ctx: IpContext, name: string): StoredFile | undefined =>
  serviceFiles(ctx, 'ftp').find((file) => file.name === name);

const exists = (ctx: IpContext, name: string) =>
  !!findFile(ctx, name) || SERVER_IMAGES.some((image) => image.name === name);

const DENIED = reply(550, 'Permission denied.');
const NO_FILE = reply(550, 'File not found.');

/** Splits `STOR name` into its verb and argument. */
function command(text: string): { verb: string; argument: string } {
  const space = text.indexOf(' ');
  return space < 0
    ? { verb: text.toUpperCase(), argument: '' }
    : { verb: text.slice(0, space).toUpperCase(), argument: text.slice(space + 1) };
}

/** A command on a control connection. */
export function onFtpCommand(ctx: IpContext, connection: TcpConnection, payload: TcpPayload) {
  const session = ctx.state.apps.ftpSessions.get(connection.id);
  if (!session || payload.kind !== 'ftp' || ctx.device.kind !== 'server') return;
  const answer = (line: FtpReply) => sendLine(ctx, connection, line);
  const { verb, argument } = command(payload.text);
  if (verb === 'USER') {
    session.user = argument;
    session.permissions = undefined;
    answer(reply(331, 'Username ok, need password'));
    return;
  }
  if (verb === 'PASS') {
    const account = serverServices(ctx.device.config).ftp.users.find(
      (user) => user.username === session.user && user.password === argument,
    );
    if (account) session.permissions = account.permissions;
    answer(account ? reply(230, 'Logged in') : reply(530, 'Login incorrect.'));
    return;
  }
  if (verb === 'QUIT') {
    answer(reply(221, 'Service closing control connection.'));
    tcpClose(ctx, connection);
    return;
  }
  const allowed = session.permissions;
  if (!allowed) {
    answer(reply(530, 'Not logged in.'));
    return;
  }
  const data =
    session.data === undefined ? undefined : ctx.state.transport.connections.get(session.data);
  switch (verb) {
    case 'PASV': {
      const port = freePort(ctx, () => ephemeralPort(ctx));
      ctx.state.apps.ftpPassive.set(port, connection.id);
      const host = connection.local.split('.').join(',');
      answer(reply(227, `Entering Passive Mode (${host},${port >> 8},${port & 0xff})`));
      return;
    }
    case 'STOR':
      if (!allowed.write) return refuseTransfer(ctx, session, answer, DENIED);
      if (!data) return answer(reply(425, "Can't open data connection."));
      session.storing = argument;
      answer(reply(150, 'Opening data connection.'));
      return;
    case 'RETR': {
      if (!allowed.read) return refuseTransfer(ctx, session, answer, DENIED);
      const file = findFile(ctx, argument);
      if (!file) return refuseTransfer(ctx, session, answer, NO_FILE);
      if (!data) return answer(reply(425, "Can't open data connection."));
      answer(reply(150, 'Opening data connection.'));
      sendData(ctx, session, data, file.content);
      answer(reply(226, 'Transfer complete.'));
      return;
    }
    case 'LIST': {
      if (!allowed.list) return refuseTransfer(ctx, session, answer, DENIED);
      if (!data) return answer(reply(425, "Can't open data connection."));
      answer(reply(150, 'Opening data connection.'));
      const text = listing(ctx)
        .map((file) => `${file.name} ${file.size}`)
        .join('\r\n');
      sendData(ctx, session, data, text);
      answer(reply(226, 'Transfer complete.'));
      return;
    }
    case 'DELE': {
      if (!allowed.delete) return answer(DENIED);
      if (!findFile(ctx, argument)) return answer(exists(ctx, argument) ? DENIED : NO_FILE);
      const files = serviceFiles(ctx, 'ftp').filter((file) => file.name !== argument);
      setServiceFiles(ctx, 'ftp', files);
      answer(reply(250, 'Deleted file successfully.'));
      return;
    }
    case 'RNFR':
      if (!allowed.rename) return answer(DENIED);
      if (!findFile(ctx, argument)) return answer(exists(ctx, argument) ? DENIED : NO_FILE);
      session.renameFrom = argument;
      answer(reply(350, 'Requested file action pending further information.'));
      return;
    case 'RNTO': {
      const from = session.renameFrom;
      session.renameFrom = undefined;
      const file = from === undefined ? undefined : findFile(ctx, from);
      if (!file) return answer(reply(503, 'Bad sequence of commands.'));
      const files = serviceFiles(ctx, 'ftp')
        .filter((candidate) => candidate.name !== argument)
        .map((candidate) => (candidate === file ? { ...file, name: argument } : candidate));
      setServiceFiles(ctx, 'ftp', files);
      answer(reply(250, 'Renamed file successfully.'));
      return;
    }
    default:
      answer(reply(502, 'Command not implemented.'));
  }
}

/** Refuses a transfer: the data connection opened for it closes. */
function refuseTransfer(
  ctx: IpContext,
  session: FtpServerSession,
  answer: (line: FtpReply) => void,
  why: FtpReply,
) {
  closeData(ctx, session);
  answer(why);
}

function closeData(ctx: IpContext, session: FtpServerSession) {
  const data =
    session.data === undefined ? undefined : ctx.state.transport.connections.get(session.data);
  session.data = undefined;
  if (data) tcpClose(ctx, data);
}

function sendData(ctx: IpContext, session: FtpServerSession, data: TcpConnection, text: string) {
  tcpSend(ctx, data, { kind: 'ftp-data', text });
  closeData(ctx, session);
}

/** A file arrived on a session's data connection, as STOR asked: keep it. */
export function onFtpDataReceived(
  ctx: IpContext,
  control: number,
  connection: TcpConnection,
  payload: TcpPayload,
) {
  const session = ctx.state.apps.ftpSessions.get(control);
  const controlConnection = ctx.state.transport.connections.get(control);
  if (!session || !controlConnection || payload.kind !== 'ftp-data') return;
  const name = session.storing;
  session.storing = undefined;
  if (name === undefined || session.data !== connection.id) return;
  setServiceFiles(ctx, 'ftp', withFile(serviceFiles(ctx, 'ftp'), { name, content: payload.text }));
  closeData(ctx, session);
  sendLine(ctx, controlConnection, reply(226, 'Transfer complete.'));
}

/** A control connection ended: its session and any data connection go with it. */
export function onFtpSessionEnded(ctx: IpContext, connection: TcpConnection) {
  const session = ctx.state.apps.ftpSessions.get(connection.id);
  if (!session) return;
  closeData(ctx, session);
  ctx.state.apps.ftpSessions.delete(connection.id);
  for (const [port, control] of ctx.state.apps.ftpPassive) {
    if (control === connection.id) ctx.state.apps.ftpPassive.delete(port);
  }
}

// Client

/** Opens an FTP session from this device to `server`. Returns the client's id. */
export function startFtp(ctx: IpContext, server: Ipv4Address, listener: FtpListener): number {
  const { transport } = ctx.state;
  const client: FtpClient = { id: transport.nextId++, server, listener, results: 0 };
  ctx.state.apps.ftpClients.set(client.id, client);
  const connection = tcpConnect(ctx, server, APP_PORT.ftp, {
    kind: 'app',
    app: 'ftp-client',
    id: client.id,
  });
  client.connection = connection.id;
  return client.id;
}

const controlOf = (ctx: IpContext, client: FtpClient) =>
  client.connection === undefined
    ? undefined
    : ctx.state.transport.connections.get(client.connection);

const dataOf = (ctx: IpContext, client: FtpClient) =>
  client.data === undefined ? undefined : ctx.state.transport.connections.get(client.data);

function finishRequest(ctx: IpContext, client: FtpClient, line: FtpReply) {
  const request = client.request;
  if (!request) return;
  const data = dataOf(ctx, client);
  if (data) tcpClose(ctx, data);
  const received = client.received;
  client.request = undefined;
  client.step = undefined;
  client.data = undefined;
  client.received = undefined;
  const result: FtpResult = {
    request: request.kind,
    reply: line,
    ...(request.kind === 'get' && line.code === 226 && { content: received ?? '' }),
    ...(request.kind === 'list' &&
      line.code === 226 && {
        listing: (received ?? '')
          .split('\r\n')
          .filter((entry) => entry !== '')
          .map((entry) => {
            const space = entry.lastIndexOf(' ');
            return { name: entry.slice(0, space), size: Number(entry.slice(space + 1)) };
          }),
      }),
  };
  client.results += 1;
  client.listener({ kind: 'result', seq: client.results, result });
}

/**
 * Sends a request on an open session. A put, get or list first asks for passive mode and opens
 * the data connection. A request while another runs, or before the session opens, is dropped.
 */
export function sendFtp(ctx: IpContext, id: number, request: FtpRequest) {
  const client = ctx.state.apps.ftpClients.get(id);
  const control = client && controlOf(ctx, client);
  if (!client?.opened || client.request || control?.state !== 'established') return;
  client.request = request;
  const send = (text: string) => sendLine(ctx, control, text);
  switch (request.kind) {
    case 'user':
      client.step = 'reply';
      return send(`USER ${request.name}`);
    case 'pass':
      client.step = 'reply';
      return send(`PASS ${request.password}`);
    case 'delete':
      client.step = 'reply';
      return send(`DELE ${request.file}`);
    case 'rename':
      client.step = 'rnfr';
      return send(`RNFR ${request.from}`);
    case 'quit':
      client.step = 'reply';
      return send('QUIT');
    case 'put':
    case 'get':
    case 'list':
      client.step = 'pasv';
      return send('PASV');
  }
}

/** The command a put, get or list sends once its data connection is open. */
function transferCommand(request: FtpRequest): string {
  switch (request.kind) {
    case 'put':
      return `STOR ${request.file}`;
    case 'get':
      return `RETR ${request.file}`;
    default:
      return 'LIST';
  }
}

/** A reply on the client's control connection. */
export function onFtpReply(ctx: IpContext, id: number, payload: TcpPayload) {
  const client = ctx.state.apps.ftpClients.get(id);
  const control = client && controlOf(ctx, client);
  if (!client || !control || payload.kind !== 'ftp') return;
  const line = parseReply(payload.text);
  if (!client.opened) {
    client.opened = true;
    client.listener({ kind: 'open', greeting: line });
    return;
  }
  const request = client.request;
  if (!request) return;
  switch (client.step) {
    case 'reply':
      finishRequest(ctx, client, line);
      return;
    case 'rnfr':
      if (line.code !== 350 || request.kind !== 'rename') return finishRequest(ctx, client, line);
      client.step = 'reply';
      sendLine(ctx, control, `RNTO ${request.to}`);
      return;
    case 'pasv': {
      const port = /\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/.exec(line.text);
      if (line.code !== 227 || !port) return finishRequest(ctx, client, line);
      client.step = 'data-open';
      const data = tcpConnect(ctx, client.server, Number(port[5]) * 256 + Number(port[6]), {
        kind: 'app',
        app: 'ftp-data-client',
        id: client.id,
      });
      client.data = data.id;
      return;
    }
    case 'transfer':
      if (line.code === 150) {
        if (request.kind === 'put') {
          const data = dataOf(ctx, client);
          if (data) tcpSend(ctx, data, { kind: 'ftp-data', text: request.content });
        }
        return;
      }
      finishRequest(ctx, client, line);
      return;
    default:
      return;
  }
}

/** The data connection opened: send the transfer's command on the control connection. */
export function onFtpDataOpened(ctx: IpContext, id: number, connection: TcpConnection) {
  const client = ctx.state.apps.ftpClients.get(id);
  const control = client && controlOf(ctx, client);
  if (!client?.request || !control || client.data !== connection.id) {
    tcpClose(ctx, connection);
    return;
  }
  client.step = 'transfer';
  sendLine(ctx, control, transferCommand(client.request));
}

/** A file or listing arrived on the client's data connection. */
export function onFtpDataArrived(ctx: IpContext, id: number, payload: TcpPayload) {
  const client = ctx.state.apps.ftpClients.get(id);
  if (client && payload.kind === 'ftp-data')
    client.received = (client.received ?? '') + payload.text;
}

/** The data connection failed to open or broke: the request fails with a 425. */
export function onFtpDataAborted(ctx: IpContext, id: number) {
  const client = ctx.state.apps.ftpClients.get(id);
  if (!client?.request) return;
  client.data = undefined;
  finishRequest(ctx, client, reply(425, "Can't open data connection."));
}

function endClient(ctx: IpContext, client: FtpClient, event: FtpEvent) {
  ctx.state.apps.ftpClients.delete(client.id);
  client.listener(event);
}

/** The control connection could not open, or broke. */
export function onFtpAborted(ctx: IpContext, id: number, why: TcpAbort) {
  const client = ctx.state.apps.ftpClients.get(id);
  if (client) endClient(ctx, client, client.opened ? { kind: 'closed' } : { kind: 'failed', why });
}

/** The server closed the control connection, as it does after QUIT. */
export function onFtpClosed(ctx: IpContext, id: number) {
  const client = ctx.state.apps.ftpClients.get(id);
  if (client) endClient(ctx, client, { kind: 'closed' });
}

/** Ends the session from this side, as closing the prompt does. */
export function closeFtp(ctx: IpContext, id: number) {
  const client = ctx.state.apps.ftpClients.get(id);
  if (!client) return;
  const control = controlOf(ctx, client);
  if (control) tcpClose(ctx, control);
  endClient(ctx, client, { kind: 'closed' });
}

/** The device is going away: every FTP session it opened ends. */
export function stopFtp(ctx: IpContext) {
  for (const client of [...ctx.state.apps.ftpClients.values()]) {
    endClient(
      ctx,
      client,
      client.opened ? { kind: 'closed' } : { kind: 'failed', why: 'cancelled' },
    );
  }
}
