import {
  openVty,
  type DeviceSession,
  type IosDevice,
  type OutputStream,
  type RemoteRequest,
  type VtySession,
} from '@/cli';
import type { TerminalEvent, TerminalHandle } from '@/engine/api';
import { vtyLineFor, type DeviceId, type Ipv4Address, type Topology } from '@/model';
import type { EditorStore } from '@/model/store';
import { deviceTerminal, type EngineLink, type SimLink, type TerminalSession } from './session';

/** The vty sessions open on each device, so a new one hunts for a free line and `show users` lists them. */
export interface VtyRegistry {
  list(device: DeviceId): readonly VtySession[];
  /** Records a session. Returns the function that forgets it. */
  add(device: DeviceId, session: VtySession): () => void;
}

export function createVtyRegistry(): VtyRegistry {
  const open = new Map<DeviceId, readonly VtySession[]>();
  return {
    list: (device) => open.get(device) ?? [],
    add(device, session) {
      open.set(device, [...(open.get(device) ?? []), session]);
      return () => {
        const rest = (open.get(device) ?? []).filter((other) => other !== session);
        if (rest.length > 0) open.set(device, rest);
        else open.delete(device);
      };
    },
  };
}

/** The router or switch with `address` on one of its interfaces that is up. */
export function iosDeviceWithAddress(
  topology: Topology,
  address: Ipv4Address,
): IosDevice | undefined {
  return Object.values(topology.devices).find((device): device is IosDevice => {
    if (device.kind !== 'router' && device.kind !== 'switch') return false;
    const interfaces = [
      ...Object.values(device.config.interfaces),
      ...Object.values(device.config.virtualInterfaces),
      ...(device.kind === 'router' ? Object.values(device.config.subinterfaces) : []),
    ];
    return interfaces.some((entry) => !entry.shutdown && entry.ipv4?.address === address);
  });
}

/** What a device terminal in a stack calls when its CLI asks to open or end a session. */
export interface RemoteHooks {
  /** `telnet` or `ssh` from `origin`: opens the session, writing what the client shows. */
  connect(origin: DeviceId, request: RemoteRequest): OutputStream;
  /** The session at the top of the stack ended at its far end. Returns the lines to print. */
  disconnect(): readonly string[];
  /** The sessions open on a device's vty lines, for `show users`. */
  sessions(device: DeviceId): readonly VtySession[];
}

/** Builds the terminal for a session on a device, wired to the stack's hooks. */
export type HopTerminal = (
  device: DeviceId,
  session: DeviceSession,
  hooks: RemoteHooks,
) => TerminalSession;

/** A stack of device terminals on `deps.store`, starting from `start` on device `id`, if any. */
export function deviceStack(deps: RemoteDeps, start?: { id: DeviceId; session: DeviceSession }) {
  const terminal: HopTerminal = (device, session, hooks) =>
    deviceTerminal(deps.store, device, session, deps.engine, hooks);
  return createRemoteStack(
    deps,
    terminal,
    start && ((hooks) => terminal(start.id, start.session, hooks)),
  );
}

export type RemoteDeps = {
  readonly store: EditorStore;
  readonly engine: EngineLink | undefined;
  readonly vty: VtyRegistry;
};

type Hop = {
  readonly terminal: TerminalSession;
  readonly handle: TerminalHandle;
  readonly target: Ipv4Address;
  /** Closes its connection from the far end and frees its line. */
  readonly close: () => void;
};

type Failure = Extract<TerminalEvent, { kind: 'failed' }>['why'];

const FAILURES: Readonly<Record<Failure, string>> = {
  refused: '% Connection refused by remote host',
  reset: '% Connection refused by remote host',
  timeout: '% Connection timed out; remote host not responding',
  cancelled: '% Connection closed',
};

const NOT_RUNNING = '% The simulation is not running, so there is nowhere to connect to.';

const closedLines = (target: Ipv4Address) => [
  '',
  `[Connection to ${target} closed by foreign host]`,
];

const asText = (lines: readonly string[]) => lines.map((line) => `${line}\n`).join('');

/**
 * A terminal that can Telnet or SSH onward, any number of hops deep. Lines go to the session at
 * the top of the stack, or to `base` when it is empty: the console it started from. `exit` on a
 * remote session pops it and returns to the one below, as on IOS.
 */
export interface RemoteStack {
  readonly session: TerminalSession;
  /** How many remote sessions are open on top of the base. */
  readonly depth: number;
  readonly hooks: RemoteHooks;
  /** Resolves when the stack is next empty. */
  emptied(): Promise<void>;
}

export function createRemoteStack(
  deps: RemoteDeps,
  hopTerminal: HopTerminal,
  baseTerminal?: (hooks: RemoteHooks) => TerminalSession,
): RemoteStack {
  const hops: Hop[] = [];
  let waiters: (() => void)[] = [];
  const top = () => hops.at(-1)?.terminal ?? base;

  const pop = (): readonly string[] => {
    const hop = hops.pop();
    if (!hop) return [];
    hop.close();
    if (hops.length === 0) {
      for (const resolve of waiters) resolve();
      waiters = [];
    }
    return closedLines(hop.target);
  };

  /**
   * Opens the session and pushes it, or says why not. Resolves with what the client shows after
   * Telnet's `Trying x ...`.
   */
  async function open(origin: DeviceId, request: RemoteRequest): Promise<string> {
    const { protocol, target } = request;
    const fail = (message: string) => `${protocol === 'telnet' ? '\n' : ''}${message}\n`;
    let sim: SimLink | undefined;
    try {
      sim = await deps.engine?.();
    } catch {
      sim = undefined;
    }
    if (!sim) return fail(NOT_RUNNING);
    const link = sim;

    let heard: (event: TerminalEvent) => void = () => {};
    const first = new Promise<TerminalEvent>((resolve) => (heard = resolve));
    const started = await link.openTerminal(origin, target, protocol, (event) => heard(event));
    if (!started.ok) return fail(FAILURES.cancelled);
    const handle = started.value;
    const event = await first;
    if (event.kind === 'failed') return fail(FAILURES[event.why]);
    if (event.kind === 'closed') return fail(FAILURES.reset);

    const head = protocol === 'telnet' ? 'Open\n' : '';
    const server = iosDeviceWithAddress(deps.store.getState().topology, target);
    const hangUp = (lines: readonly string[]) => {
      link.terminalClose(handle, server?.id);
      return head + asText([...lines, ...closedLines(target)]);
    };
    if (!server) return hangUp([]);
    const busy = new Set(deps.vty.list(server.id).map((session) => session.line));
    const index = vtyLineFor(server.config.lines.vty, protocol, busy);
    if (index === undefined) {
      link.terminalClose(handle, server.id);
      return fail(FAILURES.refused);
    }
    const user = request.user === undefined ? {} : { user: request.user };
    const opening = openVty(server, { kind: 'vty', index, protocol, peer: event.local, ...user });
    if ('refused' in opening) return hangUp(opening.refused);

    const forget = deps.vty.add(server.id, { line: index, protocol, peer: event.local, ...user });
    hops.push({
      terminal: hopTerminal(server.id, opening.session, hooks),
      handle,
      target,
      close: () => {
        forget();
        link.terminalClose(handle, server.id);
      },
    });
    return head + asText(opening.greeting);
  }

  const hooks: RemoteHooks = {
    connect(origin, request) {
      let open_ = true;
      return {
        async start(write) {
          if (request.protocol === 'telnet') write(`Trying ${request.target} ...`);
          const text = await open(origin, request);
          if (open_) write(text);
          open_ = false;
        },
        // The simulation finishes the handshake unseen; the prompt comes back now.
        abort: () => void (open_ = false),
      };
    },
    disconnect: pop,
    sessions: (device) => deps.vty.list(device),
  };

  // `top` reads it only once lines arrive, after this.
  const base = baseTerminal?.(hooks);

  /** Carries a line typed into a remote session across the simulation, as Telnet or SSH data. */
  const send = (line: string) => {
    const hop = hops.at(-1);
    if (!hop || !deps.engine) return;
    void deps
      .engine()
      .then((sim) => sim.terminalSend(hop.handle, line))
      .catch(() => {});
  };

  const session: TerminalSession = {
    get prompt() {
      return top()?.prompt ?? '';
    },
    get masked() {
      return top()?.masked ?? false;
    },
    run(line) {
      send(line);
      return top()?.run(line) ?? [];
    },
    help: (line) => top()?.help(line) ?? [],
    complete: (line) => top()?.complete(line) ?? { line: undefined, candidates: [] },
    end: () => top()?.end() ?? [],
  };

  return {
    session,
    get depth() {
      return hops.length;
    },
    hooks,
    emptied: () =>
      hops.length === 0 ? Promise.resolve() : new Promise((resolve) => waiters.push(resolve)),
  };
}
