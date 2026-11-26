import type { Ipv4Address, RemoteProtocol } from '@/model';
import { REMOTE_PORTS, sshEnabled, vtyLineFor } from '@/model/remote';
import type { TerminalData } from '../tcp';
import type { IpContext } from './context';
import { tcpClose, tcpConnect, tcpSend, type TcpAbort } from './tcpStack';
import type { TcpConnection, TcpOwner, Terminal } from './transport';

/**
 * A Telnet or SSH client's connection, step by step: `open` or `failed`, then `closed` when the
 * far end hangs up. The CLI on the far end runs outside the simulation; these connections carry
 * its typed lines so they show as TCP to port 23 or 22.
 */
export type TerminalEvent =
  /** The far end accepted. `local` is this end's address, which the far end sees as the peer. */
  | { readonly kind: 'open'; readonly local: Ipv4Address }
  | { readonly kind: 'failed'; readonly why: TcpAbort | 'cancelled' }
  | { readonly kind: 'closed' };

export type TerminalListener = (event: TerminalEvent) => void;

const PROTOCOL_BY_PORT = new Map<number, RemoteProtocol>(
  (Object.entries(REMOTE_PORTS) as [RemoteProtocol, number][]).map(([name, port]) => [port, name]),
);

/**
 * Whether a router or switch takes a connection to `port`: Telnet on 23, SSH on 22 once it has
 * RSA keys, each on the lowest free vty line whose `transport input` lets it in.
 */
export function vtyListening(ctx: IpContext, port: number): TcpOwner | undefined {
  const protocol = PROTOCOL_BY_PORT.get(port);
  const { device } = ctx;
  if (!protocol || (device.kind !== 'router' && device.kind !== 'switch')) return undefined;
  if (protocol === 'ssh' && !sshEnabled(device.config)) return undefined;
  const busy = new Set<number>();
  for (const connection of ctx.state.transport.connections.values()) {
    if (connection.owner.kind === 'vty') busy.add(connection.owner.line);
  }
  const line = vtyLineFor(device.config.lines.vty, protocol, busy);
  return line === undefined ? undefined : { kind: 'vty', protocol, line };
}

/** Opens a Telnet or SSH connection from this device. Returns the terminal's id. */
export function startTerminal(
  ctx: IpContext,
  target: Ipv4Address,
  protocol: RemoteProtocol,
  listener: TerminalListener,
): number {
  const { transport } = ctx.state;
  const terminal: Terminal = { id: transport.nextId++, protocol, listener };
  transport.terminals.set(terminal.id, terminal);
  const connection = tcpConnect(ctx, target, REMOTE_PORTS[protocol], {
    kind: 'terminal',
    terminal: terminal.id,
  });
  terminal.connection = connection.id;
  return terminal.id;
}

function end(ctx: IpContext, terminal: Terminal, event: TerminalEvent) {
  ctx.state.transport.terminals.delete(terminal.id);
  terminal.listener(event);
}

export function onTerminalOpened(ctx: IpContext, id: number, connection: TcpConnection) {
  const terminal = ctx.state.transport.terminals.get(id);
  if (!terminal) {
    tcpClose(ctx, connection);
    return;
  }
  terminal.opened = true;
  terminal.listener({ kind: 'open', local: connection.local });
}

export function onTerminalAborted(ctx: IpContext, id: number, why: TcpAbort) {
  const terminal = ctx.state.transport.terminals.get(id);
  if (terminal) end(ctx, terminal, terminal.opened ? { kind: 'closed' } : { kind: 'failed', why });
}

/** The far end closed the connection: the session is over. */
export function onTerminalClosed(ctx: IpContext, id: number) {
  const terminal = ctx.state.transport.terminals.get(id);
  if (terminal) end(ctx, terminal, { kind: 'closed' });
}

/** SSH pads each message to its 16-byte cipher block and adds a 20-byte MAC. */
const sshBytes = (text: string) => Math.ceil((text.length + 5) / 16) * 16 + 20;

/** Sends a line typed into the session, as Telnet text or SSH ciphertext. */
export function sendTerminal(ctx: IpContext, id: number, text: string) {
  const terminal = ctx.state.transport.terminals.get(id);
  const connection = terminalEnds(ctx, id);
  if (!terminal || connection?.state !== 'established') return;
  const data: TerminalData =
    terminal.protocol === 'telnet'
      ? { kind: 'telnet', text }
      : { kind: 'ssh', bytes: sshBytes(text) };
  tcpSend(ctx, connection, data);
}

/** The client end's addresses and ports, so the far end can find its side of the connection. */
export function terminalEnds(ctx: IpContext, id: number) {
  const terminal = ctx.state.transport.terminals.get(id);
  return terminal?.connection === undefined
    ? undefined
    : ctx.state.transport.connections.get(terminal.connection);
}

/**
 * The vty session for the client end `client` ended, as `exit` does: this device, the server,
 * closes its side. Returns false when it has no such connection.
 */
export function closeVty(ctx: IpContext, client: TcpConnection): boolean {
  const connection = [...ctx.state.transport.connections.values()].find(
    (candidate) =>
      candidate.owner.kind === 'vty' &&
      candidate.local === client.remote &&
      candidate.localPort === client.remotePort &&
      candidate.remote === client.local &&
      candidate.remotePort === client.localPort,
  );
  if (!connection) return false;
  tcpClose(ctx, connection);
  return true;
}

/** Closes the client's own end, when the far end cannot. */
export function closeTerminal(ctx: IpContext, id: number) {
  const connection = terminalEnds(ctx, id);
  if (connection) tcpClose(ctx, connection);
}

/** The device is going away: every terminal hears that its session ended. */
export function stopTerminals(ctx: IpContext) {
  for (const terminal of [...ctx.state.transport.terminals.values()]) {
    end(ctx, terminal, terminal.opened ? { kind: 'closed' } : { kind: 'failed', why: 'cancelled' });
  }
}
