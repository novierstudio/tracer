import { produce, type Draft } from 'immer';
import {
  DEFAULT_ROUTER_HOSTNAME,
  DEFAULT_SWITCH_HOSTNAME,
  VlanId,
  VTY_LINE_COUNT,
  type ConfigUpdate,
  type LineConfig,
  type RouterConfig,
  type SwitchConfig,
} from '../../model';
import { formatError, formatHelp } from '../format';
import { GLOBAL_CONFIG, isConfigMode, PRIV_EXEC, prompt, USER_EXEC, type Mode } from '../modes';
import { complete, help, parse, type CliError, type CompleteResult } from '../parser';
import { verifySecret } from '../passwords';
import { buildTree, type CommandTree } from '../tree';
import { routerCommands, switchCommands } from './commands';
import { multilayerCommands } from './layer3';
import {
  CONSOLE_LINE,
  type DeviceContext,
  type IosDevice,
  type Pending,
  type RemoteRequest,
  type RouterContext,
  type RouterDevice,
  type SessionLine,
  type SwitchContext,
  type SwitchDevice,
} from './context';
import { applyModifier, pipeComplete, pipeHelp, readPipe } from './pipe';
import { bindQuery, mapQuery, type EngineQuery, type EngineStream } from './query';
import { continueKeys, rsaPrompt, verifyUser } from './remote';
import { blankLine } from './show';

const ROUTER_TREE = buildTree<RouterContext>(routerCommands);
const SWITCH_TREE = buildTree<SwitchContext>([...switchCommands, ...multilayerCommands]);

type ContextFor<D extends IosDevice> = D extends RouterDevice ? RouterContext : SwitchContext;

export interface SessionState {
  readonly mode: Mode;
  readonly pending?: Pending;
}

export type Outcome =
  /** The line ran, was input to a pending command, or was blank or a `!` comment. */
  | { readonly kind: 'done' }
  /** The parser did not accept the line. */
  | { readonly kind: 'invalid'; readonly error: CliError }
  /** The line parsed, but the device refused it, such as an interface it does not have. */
  | { readonly kind: 'rejected'; readonly message: string };

interface Step<D extends IosDevice> {
  readonly device: D;
  readonly state: SessionState;
  readonly output: readonly string[];
  readonly outcome: Outcome;
  /** Set by a show command that reads live state. `output` is what it prints without it. */
  readonly query?: EngineQuery;
  /** Set by a command whose output streams from the simulation. */
  readonly stream?: EngineStream;
  /** Set by `telnet` and `ssh`: the session to open from this device. */
  readonly connect?: RemoteRequest;
  /** Set when this session ends: `exit` on a vty line, or a login that failed too often. */
  readonly disconnect?: true;
}

const DONE: Outcome = { kind: 'done' };

function continueBanner<D extends IosDevice>(
  device: D,
  state: SessionState,
  pending: Extract<Pending, { kind: 'banner' }>,
  line: string,
): Step<D> {
  const end = line.indexOf(pending.delimiter);
  if (end === -1) {
    const next = { ...pending, text: `${pending.text}\n${line}` };
    return { device, state: { mode: state.mode, pending: next }, output: [], outcome: DONE };
  }
  const text = `${pending.text}\n${line.slice(0, end)}`;
  const next = produce(device, (draft: Draft<D>) => void (draft.config.bannerMotd = text));
  return { device: next, state: { mode: state.mode }, output: [], outcome: DONE };
}

const ENABLE_ATTEMPTS = 3;

function checkEnablePassword<D extends IosDevice>(
  device: D,
  state: SessionState,
  pending: Extract<Pending, { kind: 'enable-password' }>,
  line: string,
): Step<D> {
  const { enableSecret, enablePassword } = device.config;
  const accepted = enableSecret ? verifySecret(line, enableSecret) : line === enablePassword;
  if (accepted) return { device, state: { mode: PRIV_EXEC }, output: [], outcome: DONE };
  const attempts = pending.attempts + 1;
  if (attempts >= ENABLE_ATTEMPTS) {
    return { device, state: { mode: state.mode }, output: ['% Bad secrets'], outcome: DONE };
  }
  return {
    device,
    state: { mode: state.mode, pending: { ...pending, attempts } },
    output: [],
    outcome: DONE,
  };
}

const LOGIN_ATTEMPTS = 3;

function lineConfigOf(device: IosDevice, line: SessionLine): LineConfig {
  return line.kind === 'console'
    ? device.config.lines.console
    : (device.config.lines.vty[line.index] ?? device.config.lines.console);
}

/**
 * A login's password. A console asks again after three failures; a vty line hangs up. With
 * `login local` the account's password counts, and a user with privilege 15 starts in privileged
 * EXEC. SSH asks only for the password, since the client named the user.
 */
function checkLogin<D extends IosDevice>(
  device: D,
  state: SessionState,
  pending: Extract<Pending, { kind: 'login' }>,
  input: string,
  line: SessionLine,
): Step<D> {
  const config = lineConfigOf(device, line);
  const local = config.login === 'local';
  const user = local ? device.config.users?.[pending.user ?? ''] : undefined;
  const accepted = local
    ? verifyUser(user, input)
    : config.password === undefined || input === config.password;
  if (accepted) {
    const mode = user?.privilege === 15 ? PRIV_EXEC : USER_EXEC;
    return { device, state: { mode }, output: [], outcome: DONE };
  }
  const attempts = pending.attempts + 1;
  const spent = attempts >= LOGIN_ATTEMPTS;
  const output = local ? ['% Login invalid', ''] : spent ? ['% Bad passwords'] : [];
  if (spent && line.kind === 'vty') {
    return { device, state, output, outcome: DONE, disconnect: true };
  }
  const left = attempts % LOGIN_ATTEMPTS;
  const next: Pending =
    local && !(line.kind === 'vty' && line.protocol === 'ssh')
      ? { kind: 'username', attempts: left }
      : { ...pending, attempts: left };
  return { device, state: { mode: state.mode, pending: next }, output, outcome: DONE };
}

function readUsername<D extends IosDevice>(
  device: D,
  state: SessionState,
  pending: Extract<Pending, { kind: 'username' }>,
  input: string,
): Step<D> {
  const user = input.trim();
  const next: Pending = user ? { kind: 'login', attempts: pending.attempts, user } : pending;
  return { device, state: { mode: state.mode, pending: next }, output: [], outcome: DONE };
}

function answerKeys<D extends IosDevice>(
  device: D,
  state: SessionState,
  pending: Extract<Pending, { kind: 'rsa-replace' | 'rsa-modulus' }>,
  input: string,
): Step<D> {
  const result = continueKeys(device, pending, input);
  const next = { mode: state.mode, ...(result.pending && { pending: result.pending }) };
  return { device: result.device, state: next, output: result.output, outcome: DONE };
}

const isComment = (line: string) => /^\s*!/.test(line);

function stepWith<D extends IosDevice>(
  tree: CommandTree<ContextFor<D>>,
  device: D,
  state: SessionState,
  line: string,
  history: readonly string[],
  terminal: SessionLine,
): Step<D> {
  const { pending } = state;
  if (pending?.kind === 'banner') return continueBanner(device, state, pending, line);
  if (pending?.kind === 'enable-password') return checkEnablePassword(device, state, pending, line);
  if (pending?.kind === 'login') return checkLogin(device, state, pending, line, terminal);
  if (pending?.kind === 'username') return readUsername(device, state, pending, line);
  if (pending?.kind === 'rsa-replace' || pending?.kind === 'rsa-modulus') {
    return answerKeys(device, state, pending, line);
  }
  if (isComment(line)) return { device, state, output: [], outcome: DONE };

  const parsed = parse(line, state.mode, tree);
  if (parsed.kind === 'empty') return { device, state, output: [], outcome: DONE };
  if (parsed.kind === 'error') {
    return { device, state, output: [], outcome: { kind: 'invalid', error: parsed.error } };
  }

  const effects: {
    rejected?: string;
    asked?: Pending;
    query?: EngineQuery;
    stream?: EngineStream;
    connect?: RemoteRequest;
    disconnect?: true;
  } = {};
  let output: readonly string[] = [];
  const next = produce(device, (draft: Draft<D>) => {
    const context = {
      device: draft,
      history,
      line: terminal,
      reject: (message: string) => {
        effects.rejected ??= message;
        return [];
      },
      ask: (asked: Pending) => {
        effects.asked = asked;
        return asked.kind === 'banner'
          ? [`Enter TEXT message.  End with the character '${asked.delimiter}'.`]
          : [];
      },
      query: (kind, render) => {
        // Show commands change nothing, so the device as it was is the device to render.
        effects.query = bindQuery(kind, render, device);
        return render(undefined, device);
      },
      stream: (stream) => void (effects.stream = stream),
      connect: (request) => void (effects.connect = request),
      disconnect: () => void (effects.disconnect = true),
    } satisfies DeviceContext;
    output = parsed.execute(context as ContextFor<D>);
  });
  if (effects.rejected !== undefined) {
    return { device, state, output: [], outcome: { kind: 'rejected', message: effects.rejected } };
  }
  if (effects.asked) {
    return {
      device: next,
      state: { mode: state.mode, pending: effects.asked },
      output,
      outcome: DONE,
    };
  }
  const { query, stream, connect, disconnect } = effects;
  return {
    device: next,
    state: { mode: parsed.mode },
    output,
    outcome: DONE,
    ...(query && { query }),
    ...(stream && { stream }),
    ...(connect && { connect }),
    ...(disconnect && { disconnect }),
  };
}

/**
 * Runs one line, as typed at the console or read from a config file. `history` is what
 * `show history` lists, and `terminal` the line the session runs on.
 */
export function step<D extends IosDevice>(
  device: D,
  state: SessionState,
  line: string,
  history: readonly string[] = [],
  terminal: SessionLine = CONSOLE_LINE,
): Step<D> {
  const result =
    device.kind === 'router'
      ? stepWith<RouterDevice>(ROUTER_TREE, device, state, line, history, terminal)
      : stepWith<SwitchDevice>(SWITCH_TREE, device, state, line, history, terminal);
  return result as Step<D>;
}

export interface LineError {
  /** 1-based. */
  readonly line: number;
  readonly text: string;
  readonly message: string;
}

export interface ApplyResult<D extends IosDevice> {
  readonly config: D['config'];
  readonly errors: readonly LineError[];
}

const isSubConfig = (mode: Mode) => isConfigMode(mode) && mode.kind !== 'global-config';

/**
 * Replays config lines from global config mode, the way IOS loads a config file. Pure: no store,
 * no UI. Lines the CLI does not understand go to `unknownLines`, so an import loses nothing. An
 * unknown line inside a known block, such as ` ip nat inside` under an interface, is kept with
 * the block's first line so it replays in the same place.
 *
 * `errors` lists lines that parsed but that the device refused, such as `interface` for a port it
 * lacks. They are kept in `unknownLines` too.
 */
export function applyLines<D extends IosDevice>(
  device: D,
  lines: readonly string[],
): ApplyResult<D> {
  let current = device;
  let state: SessionState = { mode: GLOBAL_CONFIG };
  const unknown: string[] = [];
  const errors: LineError[] = [];
  let header: { text: string; kept: boolean } | undefined;

  lines.forEach((raw, index) => {
    const text = raw.trimEnd();
    const before = state;
    const result = step(current, state, text);
    current = result.device;
    state = result.state;
    if (before.pending) return;

    const indented = /^\s/.test(text);
    if (result.outcome.kind === 'done') {
      if (!indented && text !== '' && !isComment(text)) header = { text, kept: false };
      return;
    }
    if (result.outcome.kind === 'rejected') {
      errors.push({ line: index + 1, text, message: result.outcome.message });
    }
    if (indented && header && !header.kept && isSubConfig(before.mode)) {
      unknown.push(header.text);
      header.kept = true;
    }
    unknown.push(text);
    if (!indented) header = { text, kept: true };
  });

  if (state.pending?.kind === 'banner') {
    errors.push({
      line: lines.length,
      text: '',
      message: 'The banner is missing its closing delimiter',
    });
  }
  return { config: withUnknown(current.config, unknown), errors };
}

function withUnknown<C extends RouterConfig | SwitchConfig>(
  config: C,
  lines: readonly string[],
): C {
  return lines.length === 0
    ? config
    : { ...config, unknownLines: [...config.unknownLines, ...lines] };
}

/**
 * The device with the config IOS starts from when it loads a config file: command defaults
 * everywhere, so an interface without `shutdown` comes up. Hardware and NVRAM state, the VLAN
 * database and the saved startup-config, are kept.
 */
export function withBlankConfig<D extends IosDevice>(device: D): D {
  const { startupConfig } = device.config;
  const shared = {
    virtualInterfaces: {},
    servicePasswordEncryption: false,
    domainLookup: true,
    unknownLines: [],
    ...(startupConfig && { startupConfig }),
  };
  const vty = () => Array.from({ length: VTY_LINE_COUNT }, blankLine);
  const ports = device.ports.map((port) => port.id);
  if (device.kind === 'router') {
    const config: RouterConfig = {
      ...shared,
      hostname: DEFAULT_ROUTER_HOSTNAME,
      interfaces: Object.fromEntries(ports.map((id) => [id, { shutdown: false }])),
      subinterfaces: {},
      lines: { console: blankLine(), aux: blankLine(), vty: vty() },
      staticRoutes: [],
    };
    return { ...device, config };
  }
  const access = { mode: 'access', vlan: VlanId.parse(1) } as const;
  const config: SwitchConfig = {
    ...shared,
    hostname: DEFAULT_SWITCH_HOSTNAME,
    interfaces: Object.fromEntries(
      ports.map((id) => [id, { shutdown: false, switchport: access }]),
    ),
    vlans: device.config.vlans,
    lines: { console: blankLine(), vty: vty() },
  };
  return { ...device, config };
}

export function toConfigUpdate(device: IosDevice): ConfigUpdate {
  return device.kind === 'router'
    ? { device: device.id, kind: 'router', config: device.config }
    : { device: device.id, kind: 'switch', config: device.config };
}

export interface SessionResult {
  /** What to print. For a show command with a `query`, this is its output from config alone. */
  readonly output: readonly string[];
  /** The config edit to commit, for example with the editor store's `updateConfig`. */
  readonly update: ConfigUpdate | undefined;
  /**
   * Set by a show command that reads live simulation state. A terminal that can reach the
   * simulation answers it and prints that output in place of `output`.
   */
  readonly query?: EngineQuery;
  /**
   * Set by a command whose output streams from the simulation, such as `ping`. A terminal that can
   * reach the simulation opens it and prints its pieces in place of `output`.
   */
  readonly stream?: EngineStream;
  /** Set by `telnet` and `ssh`: a terminal that can reach the simulation opens the session. */
  readonly connect?: RemoteRequest;
  /** The session has ended. The terminal closes it and returns to where it came from. */
  readonly disconnect?: true;
}

/**
 * One console session on a device. It holds only the mode and any input a command waits for.
 * Each call takes the device as it is now, so edits from the GUI between lines are seen.
 */
export interface DeviceSession {
  readonly state: SessionState;
  /** The terminal line it runs on. */
  readonly line: SessionLine;
  /** The session is reading a password: the terminal must not echo the line. */
  readonly readingPassword: boolean;
  prompt(device: IosDevice): string;
  run(device: IosDevice, line: string): SessionResult;
  /** The `?` output for the text before the `?`. */
  help(device: IosDevice, line: string): readonly string[];
  complete(device: IosDevice, line: string): CompleteResult;
}

const treeOf = (device: IosDevice): CommandTree<never> =>
  (device.kind === 'router' ? ROUTER_TREE : SWITCH_TREE) as CommandTree<never>;

/** IOS keeps the last 10 lines of each history by default (`terminal history size 10`). */
const HISTORY_SIZE = 10;

export function createDeviceSession(
  start: SessionState = { mode: USER_EXEC },
  line: SessionLine = CONSOLE_LINE,
): DeviceSession {
  let state = start;
  // IOS keeps EXEC and config lines apart, so `show history` in EXEC lists only EXEC lines.
  const histories = { exec: [] as readonly string[], config: [] as readonly string[] };
  /** Records a typed line in its mode's history and returns that history. */
  const remember = (line: string): readonly string[] => {
    const kind = isConfigMode(state.mode) ? 'config' : 'exec';
    if (state.pending || line.trim() === '') return histories[kind];
    histories[kind] = [...histories[kind], line.trim()].slice(-HISTORY_SIZE);
    return histories[kind];
  };
  const readingPassword = () =>
    state.pending?.kind === 'enable-password' || state.pending?.kind === 'login';
  const promptOf = (device: IosDevice) => {
    const { pending } = state;
    if (readingPassword()) return 'Password: ';
    if (pending?.kind === 'username') return 'Username: ';
    if (pending?.kind === 'rsa-replace' || pending?.kind === 'rsa-modulus')
      return rsaPrompt(pending);
    if (pending?.kind === 'banner') return '';
    return prompt(device.config.hostname, state.mode);
  };
  return {
    get state() {
      return state;
    },
    get readingPassword() {
      return readingPassword();
    },
    line,
    prompt: promptOf,
    run(device, text) {
      const width = promptOf(device).length;
      const history = remember(text);
      const piped = state.pending
        ? { kind: 'none' as const }
        : readPipe(text, state.mode, treeOf(device), width);
      if (piped.kind === 'error') return { output: piped.output, update: undefined };
      const command = piped.kind === 'piped' ? piped.command : text;
      const result = step(device, state, command, history, line);
      state = result.state;
      const update = result.device === device ? undefined : toConfigUpdate(result.device);
      switch (result.outcome.kind) {
        case 'done': {
          if (piped.kind === 'none') {
            const { output, query, stream, connect, disconnect } = result;
            return {
              output,
              update,
              ...(query && { query }),
              ...(stream && { stream }),
              ...(connect && { connect }),
              ...(disconnect && { disconnect }),
            };
          }
          const filter = (lines: readonly string[]) => applyModifier(piped.modifier, lines);
          const query = result.query && mapQuery(result.query, filter);
          return { output: filter(result.output), update, ...(query && { query }) };
        }
        case 'invalid':
          return { output: formatError(result.outcome.error, width), update };
        case 'rejected':
          return { output: [result.outcome.message], update };
      }
    },
    help(device, line) {
      if (state.pending) return [];
      const width = promptOf(device).length;
      const tree = treeOf(device);
      return (
        pipeHelp(line, state.mode, tree, width) ?? formatHelp(help(line, state.mode, tree), width)
      );
    },
    complete(device, line) {
      if (state.pending) return { line: undefined, candidates: [] };
      const tree = treeOf(device);
      return pipeComplete(line, state.mode, tree) ?? complete(line, state.mode, tree);
    },
  };
}

export interface Console {
  readonly session: DeviceSession;
  /** What the console prints before the first prompt. */
  readonly greeting: readonly string[];
}

/** How a line's `login` setting starts a session: no check, or the first question it asks. */
function loginStart(config: LineConfig, line: SessionLine): Pending | undefined {
  if (config.login === 'local') {
    return line.kind === 'vty' && line.protocol === 'ssh'
      ? { kind: 'login', attempts: 0, user: line.user ?? '' }
      : { kind: 'username', attempts: 0 };
  }
  if (config.login === 'password' && config.password !== undefined) {
    return { kind: 'login', attempts: 0 };
  }
  return undefined;
}

const bannerOf = (device: IosDevice) =>
  device.config.bannerMotd === undefined ? [] : device.config.bannerMotd.split('\n');

/**
 * Connects to the device's console line, as plugging in a console cable does: the MOTD banner,
 * then the line password when the line has `login` and a password, or a username and password
 * with `login local`.
 */
export function openConsole(device: IosDevice): Console {
  const pending = loginStart(device.config.lines.console, CONSOLE_LINE);
  const greeting = [...bannerOf(device), ...(pending ? ['', 'User Access Verification', ''] : [])];
  const session = createDeviceSession({ mode: USER_EXEC, ...(pending && { pending }) });
  return { session, greeting };
}

/** A vty session, or the lines the device sends before it hangs up. */
export type VtyOpening = Console | { readonly refused: readonly string[] };

/**
 * Opens a Telnet or SSH session on vty line `line.index`, which the device accepted the connection
 * on. A line with `login` but no password refuses it, as IOS does. SSH clients ask for the
 * password themselves, so they get no "User Access Verification".
 */
export function openVty(
  device: IosDevice,
  line: Extract<SessionLine, { kind: 'vty' }>,
): VtyOpening {
  const config = lineConfigOf(device, line);
  if (config.login === 'password' && config.password === undefined) {
    return { refused: ['', 'Password required, but none set'] };
  }
  const pending = loginStart(config, line);
  const verification = !pending
    ? []
    : line.protocol === 'ssh'
      ? ['']
      : ['', 'User Access Verification', ''];
  const greeting = [...bannerOf(device), ...verification];
  const session = createDeviceSession({ mode: USER_EXEC, ...(pending && { pending }) }, line);
  return { session, greeting };
}
