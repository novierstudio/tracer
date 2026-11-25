import type { Draft } from 'immer';
import {
  DEFAULT_ROUTER_HOSTNAME,
  DEFAULT_SWITCH_HOSTNAME,
  Hostname,
  ipv4ToUint32,
  Md5CryptHash,
  prefixMask,
  uint32ToIpv4,
  VirtualInterfaceId,
  VlanId,
  type InterfaceId,
  type Ipv4Address,
  type LineConfig,
  type Port,
  type PrefixLength,
  type RoutedInterface,
  type StaticRoute,
  type SwitchInterface,
} from '../../model';
import { exitMode, GLOBAL_CONFIG, PRIV_EXEC, USER_EXEC, type LineRef, type ModeOf } from '../modes';
import { choice, iface, ifaceRange, ipv4, keyword, line, mask, num, word } from '../params';
import { decodeType7, hashSecret } from '../passwords';
import { defineCommand } from '../tree';
import {
  INVALID_INPUT,
  type DeviceContext,
  type IosDraft,
  type RouterContext,
  type SwitchContext,
} from './context';
import {
  findInterface,
  runningConfig,
  type InterfaceEntry,
  showInterfaces,
  showIpInterfaceBrief,
  showRunningConfig,
  showStartupConfig,
  showVersion,
} from './show';

const EXEC = ['user-exec', 'priv-exec'] as const;
const PRIV = ['priv-exec'] as const;
const CONFIG = [
  'global-config',
  'interface-config',
  'line-config',
  'vlan-config',
  'router-config',
] as const;
const GLOBAL = ['global-config'] as const;
const IF = ['interface-config'] as const;
const LINE = ['line-config'] as const;
const VLAN = ['vlan-config'] as const;

const NOTHING: readonly string[] = [];

const command = defineCommand<DeviceContext>();
const routerCommand = defineCommand<RouterContext>();
const switchCommand = defineCommand<SwitchContext>();

const show = keyword('show', 'Show running system information');
const interfaceKw = keyword('interface', 'Select an interface to configure');
const globalIp = keyword('ip', 'Global IP configuration subcommands');
const interfaceIp = keyword('ip', 'Interface Internet Protocol config commands');
const enableKw = keyword('enable', 'Modify enable password parameters');
const lineKw = keyword('line', 'Configure a terminal line');
const switchport = keyword('switchport', 'Set switching mode characteristics');
const unencrypted = keyword('0', 'Specifies an UNENCRYPTED password will follow');
const type7 = keyword('7', 'Specifies a HIDDEN password will follow');
const routeKw = keyword('route', 'Establish static routes');
const vlanNumber = num('vlan', 1, 4094, 'VLAN ID of the VLAN when this port is in access mode');

const isVirtual = (id: InterfaceId): id is VirtualInterfaceId =>
  VirtualInterfaceId.safeParse(id).success;

/** Applies `edit` to each interface of the mode. A message from `edit` refuses the whole command. */
function eachInterface(
  ctx: DeviceContext,
  mode: ModeOf<'interface-config'>,
  edit: (target: InterfaceEntry) => string | undefined,
): readonly string[] {
  for (const id of mode.interfaces) {
    const target = findInterface(ctx.device, id);
    const problem = target ? edit(target) : INVALID_INPUT;
    if (problem) return ctx.reject(problem);
  }
  return NOTHING;
}

function enterInterfaces(ctx: DeviceContext, ids: readonly InterfaceId[]): readonly string[] {
  for (const id of ids) {
    if (isVirtual(id)) ctx.device.config.virtualInterfaces[id] ??= { shutdown: false };
    else if (!findInterface(ctx.device, id)) return ctx.reject(INVALID_INPUT);
  }
  return NOTHING;
}

function linesOf(device: IosDraft, ref: LineRef): Draft<LineConfig>[] {
  const { lines } = device.config;
  switch (ref.kind) {
    case 'console':
      return [lines.console];
    case 'aux':
      return 'aux' in lines ? [lines.aux] : [];
    case 'vty':
      return lines.vty.slice(ref.first, ref.last + 1);
  }
}

function eachLine(
  ctx: DeviceContext,
  mode: ModeOf<'line-config'>,
  edit: (line: Draft<LineConfig>) => void,
) {
  for (const target of linesOf(ctx.device, mode.line)) edit(target);
  return NOTHING;
}

const networkOf = (address: Ipv4Address, prefix: PrefixLength) =>
  (ipv4ToUint32(address) & prefixMask(prefix)) >>> 0;

/** IOS refuses a network or broadcast address, and a subnet that overlaps another interface's. */
function addressProblem(
  device: IosDraft,
  self: InterfaceId,
  address: Ipv4Address,
  prefix: PrefixLength,
) {
  const host = (ipv4ToUint32(address) & ~prefixMask(prefix)) >>> 0;
  const hostMask = ~prefixMask(prefix) >>> 0;
  if (prefix <= 30 && (host === 0 || host === hostMask))
    return `Bad mask /${prefix} for address ${address}`;
  const others: [string, RoutedInterface][] = Object.entries(device.config.virtualInterfaces);
  if (device.kind === 'router') others.push(...Object.entries(device.config.interfaces));
  for (const [id, other] of others) {
    if (id === self || !other.ipv4) continue;
    const shorter = Math.min(prefix, other.ipv4.prefixLength) as PrefixLength;
    if (networkOf(address, shorter) === networkOf(other.ipv4.address, shorter)) {
      return `% ${uint32ToIpv4(networkOf(address, prefix))} overlaps with ${id}`;
    }
  }
  return undefined;
}

const isEthernet = (port: Port | undefined) => port !== undefined && port.kind !== 'serial';

/** The rates a Packet Tracer serial port accepts, in bit/s. */
export const CLOCK_RATES = new Set([
  1200, 2400, 4800, 9600, 19200, 38400, 56000, 64000, 72000, 125000, 128000, 148000, 250000, 500000,
  800000, 1000000, 1300000, 2000000, 4000000,
]);

function setPassword(
  text: string,
  encrypted: boolean,
  apply: (password: string) => void,
  ctx: DeviceContext,
) {
  const password = encrypted ? decodeType7(text) : text;
  if (password === undefined) return ctx.reject('Invalid encrypted password');
  apply(password);
  return NOTHING;
}

function setRoute(
  ctx: RouterContext,
  address: Ipv4Address,
  prefix: PrefixLength,
  nextHop: StaticRoute['nextHop'],
  distance: number | undefined,
) {
  if (networkOf(address, prefix) !== ipv4ToUint32(address)) {
    return ctx.reject('%Inconsistent address and mask');
  }
  if (nextHop.kind === 'interface' && !findInterface(ctx.device, nextHop.interface)) {
    return ctx.reject(INVALID_INPUT);
  }
  const route: StaticRoute = {
    prefix: { address, prefixLength: prefix },
    nextHop,
    ...(distance === undefined || distance === 1 ? {} : { distance }),
  };
  const routes = ctx.device.config.staticRoutes;
  const same = routes.findIndex(
    (r) =>
      r.prefix.address === address &&
      r.prefix.prefixLength === prefix &&
      JSON.stringify(r.nextHop) === JSON.stringify(nextHop),
  );
  if (same === -1) routes.push(route);
  else routes[same] = route;
  return NOTHING;
}

function removeRoutes(
  ctx: RouterContext,
  args: { network?: Ipv4Address; mask?: PrefixLength; nextHop?: Ipv4Address; exit?: InterfaceId },
) {
  const { network, mask: prefix, nextHop, exit } = args;
  if (network === undefined || prefix === undefined) return ctx.reject('% Incomplete command.');
  const routes = ctx.device.config.staticRoutes;
  const keep = routes.filter(
    (r) =>
      r.prefix.address !== network ||
      r.prefix.prefixLength !== prefix ||
      (nextHop !== undefined && !(r.nextHop.kind === 'address' && r.nextHop.address === nextHop)) ||
      (exit !== undefined && !(r.nextHop.kind === 'interface' && r.nextHop.interface === exit)),
  );
  if (keep.length === routes.length) return ctx.reject('%No matching route to delete');
  ctx.device.config.staticRoutes = keep;
  return NOTHING;
}

function needsEnablePassword(device: IosDraft): boolean {
  return device.config.enableSecret !== undefined || device.config.enablePassword !== undefined;
}

const saved = ['Building configuration...', '[OK]'];

function save(ctx: DeviceContext) {
  ctx.device.config.startupConfig = runningConfig(ctx.device);
  return saved;
}

/** `banner motd #text#`. Without the closing delimiter, the banner continues on later lines. */
function startBanner(ctx: DeviceContext, rest: string) {
  const delimiter = rest.startsWith('^C') ? '^C' : rest.charAt(0);
  const after = rest.slice(delimiter.length);
  const end = after.indexOf(delimiter);
  if (end === -1) return ctx.ask({ kind: 'banner', delimiter, text: after });
  ctx.device.config.bannerMotd = after.slice(0, end);
  return NOTHING;
}

const VTY_LAST = 15;

export const commonCommands = [
  // EXEC
  command({
    modes: EXEC,
    path: [keyword('enable', 'Turn on privileged commands')],
    to: PRIV_EXEC,
    run: (_args, ctx, mode) =>
      mode.kind === 'user-exec' && needsEnablePassword(ctx.device)
        ? ctx.ask({ kind: 'enable-password', attempts: 0 })
        : NOTHING,
  }),
  command({
    modes: PRIV,
    path: [keyword('disable', 'Turn off privileged commands')],
    to: USER_EXEC,
  }),
  command({ modes: EXEC, path: [keyword('exit', 'Exit from the EXEC')], to: USER_EXEC }),
  command({
    modes: PRIV,
    path: [
      keyword('configure', 'Enter configuration mode'),
      keyword('terminal', 'Configure from the terminal'),
    ],
    to: GLOBAL_CONFIG,
    run: () => ['Enter configuration commands, one per line.  End with CNTL/Z.'],
  }),
  command({
    modes: PRIV,
    path: [keyword('write', 'Write running configuration to memory')],
    run: (_a, ctx) => save(ctx),
  }),
  command({
    modes: PRIV,
    path: [
      keyword('write', 'Write running configuration to memory'),
      keyword('memory', 'Write to NV memory'),
    ],
    run: (_a, ctx) => save(ctx),
  }),
  command({
    modes: PRIV,
    path: [
      keyword('copy', 'Copy from one file to another'),
      keyword('running-config', 'Copy from current system configuration'),
      keyword('startup-config', 'Copy to startup configuration'),
    ],
    run: (_a, ctx) => ['Destination filename [startup-config]?', ...save(ctx)],
  }),
  command({
    modes: PRIV,
    path: [show, keyword('running-config', 'Current operating configuration')],
    run: (_a, ctx) => showRunningConfig(ctx.device),
  }),
  command({
    modes: PRIV,
    path: [show, keyword('startup-config', 'Contents of startup configuration')],
    run: (_a, ctx) => showStartupConfig(ctx.device),
  }),
  command({
    modes: EXEC,
    path: [show, keyword('version', 'System hardware and software status')],
    run: (_a, ctx) => showVersion(ctx.device),
  }),
  command({
    modes: EXEC,
    path: [
      show,
      keyword('ip', 'IP information'),
      keyword('interface', 'IP interface status and configuration'),
      keyword('brief', 'Brief summary of IP status and configuration'),
    ],
    run: (_a, ctx) => showIpInterfaceBrief(ctx.device),
  }),
  command({
    modes: EXEC,
    path: [show, keyword('interfaces', 'Interface status and configuration')],
    run: (_a, ctx) => showInterfaces(ctx.device) ?? NOTHING,
  }),
  command({
    modes: EXEC,
    path: [
      show,
      keyword('interfaces', 'Interface status and configuration'),
      iface('name', 'Interface name'),
    ],
    run: ({ name }, ctx) => showInterfaces(ctx.device, name) ?? ctx.reject(INVALID_INPUT),
  }),

  // Every config mode
  command({
    modes: CONFIG,
    path: [keyword('exit', 'Exit from configure mode')],
    to: (_a, from) => exitMode(from),
  }),
  command({ modes: CONFIG, path: [keyword('end', 'Exit from configure mode')], to: PRIV_EXEC }),

  // Global config
  command({
    modes: GLOBAL,
    path: [
      keyword('hostname', "Set system's network name"),
      word('name', "This system's network name"),
    ],
    run: ({ name }, ctx) => {
      const hostname = Hostname.safeParse(name);
      if (!hostname.success)
        return ctx.reject('% Hostname contains one or more illegal characters.');
      ctx.device.config.hostname = hostname.data;
      return NOTHING;
    },
    no: (_a, ctx) => {
      ctx.device.config.hostname =
        ctx.device.kind === 'router' ? DEFAULT_ROUTER_HOSTNAME : DEFAULT_SWITCH_HOSTNAME;
      return NOTHING;
    },
  }),
  command({
    modes: GLOBAL,
    path: [keyword('version', 'Version'), line('version', 'Version number')],
  }),
  ...(
    [
      [[], 'text'],
      [[unencrypted], 'text'],
      [[keyword('5', 'Specifies an ENCRYPTED secret will follow')], 'hash'],
    ] as const
  ).map(([type, kind]) =>
    command({
      modes: GLOBAL,
      path: [
        enableKw,
        keyword('secret', 'Assign the privileged level secret'),
        ...type,
        line('secret', 'The secret'),
      ],
      run: ({ secret }, ctx) => {
        if (kind === 'text') {
          ctx.device.config.enableSecret = hashSecret(secret);
          return NOTHING;
        }
        const hash = Md5CryptHash.safeParse(secret);
        if (!hash.success)
          return ctx.reject('ERROR: The secret you entered is not a valid encrypted secret.');
        ctx.device.config.enableSecret = hash.data;
        return NOTHING;
      },
      no: (_a, ctx) => {
        delete ctx.device.config.enableSecret;
        return NOTHING;
      },
    }),
  ),
  ...([[], [unencrypted], [type7]] as const).map((type) =>
    command({
      modes: GLOBAL,
      path: [
        enableKw,
        keyword('password', 'Assign the privileged level password'),
        ...type,
        line('password', 'The password'),
      ],
      run: ({ password }, ctx) =>
        setPassword(
          password,
          type[0] === type7,
          (p) => (ctx.device.config.enablePassword = p),
          ctx,
        ),
      no: (_a, ctx) => {
        delete ctx.device.config.enablePassword;
        return NOTHING;
      },
    }),
  ),
  command({
    modes: GLOBAL,
    path: [
      keyword('service', 'Modify use of network based services'),
      keyword('password-encryption', 'Encrypt system passwords'),
    ],
    run: (_a, ctx) => {
      ctx.device.config.servicePasswordEncryption = true;
      return NOTHING;
    },
    no: (_a, ctx) => {
      ctx.device.config.servicePasswordEncryption = false;
      return NOTHING;
    },
  }),
  command({
    modes: GLOBAL,
    path: [
      keyword('banner', 'Define a login banner'),
      keyword('motd', 'Set Message of the Day banner'),
      line('text', 'c banner-text c, where c is a delimiting character'),
    ],
    run: ({ text }, ctx) => startBanner(ctx, text),
    no: (_a, ctx) => {
      delete ctx.device.config.bannerMotd;
      return NOTHING;
    },
  }),
  command({
    modes: GLOBAL,
    path: [globalIp, keyword('domain-lookup', 'Enable IP Domain Name System hostname translation')],
    run: (_a, ctx) => {
      ctx.device.config.domainLookup = true;
      return NOTHING;
    },
    no: (_a, ctx) => {
      ctx.device.config.domainLookup = false;
      return NOTHING;
    },
  }),
  command({
    modes: GLOBAL,
    path: [interfaceKw, iface('name', 'Interface name')],
    to: ({ name }) => ({ kind: 'interface-config', interfaces: [name] }),
    run: ({ name }, ctx) => enterInterfaces(ctx, [name]),
    no: ({ name }, ctx) => {
      if (name === undefined) return ctx.reject('% Incomplete command.');
      if (!isVirtual(name)) return ctx.reject('% Removal of physical interfaces is not permitted');
      delete ctx.device.config.virtualInterfaces[name];
      return NOTHING;
    },
  }),
  command({
    modes: GLOBAL,
    path: [
      interfaceKw,
      keyword('range', 'interface range command'),
      ifaceRange('names', 'Interface range'),
    ],
    to: ({ names }) => ({ kind: 'interface-config', interfaces: names }),
    run: ({ names }, ctx) => enterInterfaces(ctx, names),
  }),
  command({
    modes: GLOBAL,
    path: [
      lineKw,
      keyword('console', 'Primary terminal line'),
      num('number', 0, 0, 'First Line number'),
    ],
    to: { kind: 'line-config', line: { kind: 'console' } },
  }),
  command({
    modes: GLOBAL,
    path: [
      lineKw,
      keyword('vty', 'Virtual terminal'),
      num('first', 0, VTY_LAST, 'First Line number'),
    ],
    to: ({ first }) => ({ kind: 'line-config', line: { kind: 'vty', first, last: first } }),
  }),
  command({
    modes: GLOBAL,
    path: [
      lineKw,
      keyword('vty', 'Virtual terminal'),
      num('first', 0, VTY_LAST, 'First Line number'),
      num('last', 1, VTY_LAST, 'Last Line number'),
    ],
    to: ({ first, last }) => ({ kind: 'line-config', line: { kind: 'vty', first, last } }),
    run: ({ first, last }, ctx) => (last < first ? ctx.reject('%Invalid line range') : NOTHING),
  }),

  // Interface config
  command({
    modes: IF,
    path: [
      interfaceIp,
      keyword('address', 'Set the IP address of an interface'),
      ipv4('ip', 'IP address'),
      mask('mask', 'IP subnet mask'),
    ],
    run: ({ ip, mask: prefix }, ctx, mode) =>
      eachInterface(ctx, mode, (target) => {
        if (target.kind !== 'routed') return INVALID_INPUT;
        const problem = addressProblem(ctx.device, target.id, ip, prefix);
        if (problem) return problem;
        target.config.ipv4 = { address: ip, prefixLength: prefix };
        return undefined;
      }),
    no: (_a, ctx, mode) =>
      eachInterface(ctx, mode, (target) => {
        if (target.kind !== 'routed') return INVALID_INPUT;
        delete target.config.ipv4;
        return undefined;
      }),
  }),
  command({
    modes: IF,
    path: [keyword('shutdown', 'Shutdown the selected interface')],
    run: (_a, ctx, mode) =>
      eachInterface(ctx, mode, (target) => void (target.config.shutdown = true)),
    no: (_a, ctx, mode) =>
      eachInterface(ctx, mode, (target) => void (target.config.shutdown = false)),
  }),
  command({
    modes: IF,
    path: [
      keyword('description', 'Interface specific description'),
      line('text', 'Up to 240 characters describing this interface'),
    ],
    run: ({ text }, ctx, mode) =>
      eachInterface(ctx, mode, (target) => void (target.config.description = text)),
    no: (_a, ctx, mode) =>
      eachInterface(ctx, mode, (target) => void delete target.config.description),
  }),
  command({
    modes: IF,
    path: [
      keyword('speed', 'Configure speed operation.'),
      choice('speed', {
        10: 'Force 10 Mbps operation',
        100: 'Force 100 Mbps operation',
        1000: 'Force 1000 Mbps operation',
        auto: 'Enable AUTO speed configuration',
      }),
    ],
    run: ({ speed }, ctx, mode) =>
      eachInterface(ctx, mode, (target) => {
        if (!isEthernet(target.port)) return INVALID_INPUT;
        if (speed === '1000' && target.port?.kind !== 'gigabitEthernet') return INVALID_INPUT;
        if (speed === 'auto') delete target.config.speed;
        else target.config.speed = Number(speed) as 10 | 100 | 1000;
        return undefined;
      }),
    no: (_a, ctx, mode) =>
      eachInterface(ctx, mode, (target) =>
        isEthernet(target.port) ? void delete target.config.speed : INVALID_INPUT,
      ),
  }),
  command({
    modes: IF,
    path: [
      keyword('duplex', 'Configure duplex operation.'),
      choice('duplex', {
        auto: 'Enable AUTO duplex configuration',
        full: 'Force full duplex operation',
        half: 'Force half-duplex operation',
      }),
    ],
    run: ({ duplex }, ctx, mode) =>
      eachInterface(ctx, mode, (target) => {
        if (!isEthernet(target.port)) return INVALID_INPUT;
        if (duplex === 'auto') delete target.config.duplex;
        else target.config.duplex = duplex;
        return undefined;
      }),
    no: (_a, ctx, mode) =>
      eachInterface(ctx, mode, (target) =>
        isEthernet(target.port) ? void delete target.config.duplex : INVALID_INPUT,
      ),
  }),

  // Line config
  ...([[], [unencrypted], [type7]] as const).map((type) =>
    command({
      modes: LINE,
      path: [keyword('password', 'Set a password'), ...type, line('password', 'The password')],
      run: ({ password }, ctx, mode) =>
        setPassword(
          password,
          type[0] === type7,
          (p) => eachLine(ctx, mode, (l) => (l.password = p)),
          ctx,
        ),
      no: (_a, ctx, mode) => eachLine(ctx, mode, (l) => delete l.password),
    }),
  ),
  command({
    modes: LINE,
    path: [keyword('login', 'Enable password checking')],
    run: (_a, ctx, mode) => eachLine(ctx, mode, (l) => (l.login = 'password')),
    no: (_a, ctx, mode) => eachLine(ctx, mode, (l) => (l.login = 'none')),
  }),
  command({
    modes: LINE,
    path: [
      keyword('login', 'Enable password checking'),
      keyword('local', 'Local password checking'),
    ],
    run: (_a, ctx, mode) => eachLine(ctx, mode, (l) => (l.login = 'local')),
  }),
  ...transportCommands(),
];

function transportCommands() {
  const transport = keyword('transport', 'Define transport protocols for line');
  const input = keyword(
    'input',
    'Define which protocols to use when connecting to the terminal server',
  );
  const first = choice('first', {
    all: 'All protocols',
    none: 'No protocols',
    ssh: 'TCP/IP SSH protocol',
    telnet: 'TCP/IP Telnet protocol',
  });
  const second = choice('second', { ssh: 'TCP/IP SSH protocol', telnet: 'TCP/IP Telnet protocol' });
  const set = (ctx: DeviceContext, mode: ModeOf<'line-config'>, words: readonly string[]) => {
    const all = words.includes('all');
    return eachLine(ctx, mode, (l) => {
      l.transportInput = {
        ssh: all || words.includes('ssh'),
        telnet: all || words.includes('telnet'),
      };
    });
  };
  const reset = (_a: unknown, ctx: DeviceContext, mode: ModeOf<'line-config'>) =>
    set(ctx, mode, ['all']);
  return [
    command({
      modes: LINE,
      path: [transport, input, first],
      run: (a, ctx, mode) => set(ctx, mode, [a.first]),
      no: reset,
    }),
    command({
      modes: LINE,
      path: [transport, input, first, second],
      run: (a, ctx, mode) =>
        a.first === 'all' || a.first === 'none'
          ? ctx.reject(INVALID_INPUT)
          : set(ctx, mode, [a.first, a.second]),
    }),
  ];
}

export const routerCommands = [
  ...commonCommands,
  routerCommand({
    modes: GLOBAL,
    path: [lineKw, keyword('aux', 'Auxiliary line'), num('number', 0, 0, 'First Line number')],
    to: { kind: 'line-config', line: { kind: 'aux' } },
  }),
  routerCommand({
    modes: IF,
    path: [
      keyword('clock', 'Configure serial interface clock'),
      keyword('rate', 'Configure serial interface clock speed'),
      num('rate', 300, 8000000, 'Choose clockrate from list above'),
    ],
    run: ({ rate }, ctx, mode) =>
      eachInterface(ctx, mode, (target) => {
        if (target.kind !== 'routed' || target.port?.kind !== 'serial') return INVALID_INPUT;
        if (!CLOCK_RATES.has(rate)) return '% Invalid clock rate';
        target.config.clockRate = rate;
        return undefined;
      }),
    no: (_a, ctx, mode) =>
      eachInterface(ctx, mode, (target) => {
        if (target.kind !== 'routed' || target.port?.kind !== 'serial') return INVALID_INPUT;
        delete target.config.clockRate;
        return undefined;
      }),
  }),
  ...routeCommands(),
];

function routeCommands() {
  const network = ipv4('network', 'Destination prefix');
  const prefix = mask('mask', 'Destination prefix mask');
  const nextHop = ipv4('nextHop', "Forwarding router's address");
  const exit = iface('exit', 'Exit interface');
  const distance = num('distance', 1, 255, 'Distance metric for this route');
  const no = (args: Parameters<typeof removeRoutes>[1], ctx: RouterContext) =>
    removeRoutes(ctx, args);
  return [
    routerCommand({
      modes: GLOBAL,
      path: [globalIp, routeKw, network, prefix, nextHop],
      run: (a, ctx) =>
        setRoute(ctx, a.network, a.mask, { kind: 'address', address: a.nextHop }, undefined),
      no,
    }),
    routerCommand({
      modes: GLOBAL,
      path: [globalIp, routeKw, network, prefix, nextHop, distance],
      run: (a, ctx) =>
        setRoute(ctx, a.network, a.mask, { kind: 'address', address: a.nextHop }, a.distance),
      no,
    }),
    routerCommand({
      modes: GLOBAL,
      path: [globalIp, routeKw, network, prefix, exit],
      run: (a, ctx) =>
        setRoute(ctx, a.network, a.mask, { kind: 'interface', interface: a.exit }, undefined),
      no,
    }),
    routerCommand({
      modes: GLOBAL,
      path: [globalIp, routeKw, network, prefix, exit, distance],
      run: (a, ctx) =>
        setRoute(ctx, a.network, a.mask, { kind: 'interface', interface: a.exit }, a.distance),
      no,
    }),
  ];
}

const DEFAULT_VLAN = VlanId.parse(1);

/** The name IOS gives a VLAN until `name` sets one: `default` for VLAN 1, `VLAN0010` for 10. */
const defaultVlanName = (vlan: VlanId) =>
  vlan === DEFAULT_VLAN ? 'default' : `VLAN${String(vlan).padStart(4, '0')}`;

/** `switchport access vlan` on a VLAN the switch lacks creates it, as IOS does. */
function ensureVlan(ctx: SwitchContext, vlan: VlanId): readonly string[] {
  if (vlan in ctx.device.config.vlans) return NOTHING;
  ctx.device.config.vlans[vlan] = { name: defaultVlanName(vlan) };
  return [`% Access VLAN does not exist. Creating vlan ${vlan}`];
}

const VLAN_NAME_MAX = 32;

function eachSwitchport(
  ctx: SwitchContext,
  mode: ModeOf<'interface-config'>,
  edit: (port: Draft<SwitchInterface>) => void,
) {
  return eachInterface(ctx, mode, (target) =>
    target.kind === 'switched' ? void edit(target.config) : INVALID_INPUT,
  );
}

const orUnset = (vlan: VlanId | undefined) => (vlan === DEFAULT_VLAN ? undefined : vlan);

function setAccessVlan(port: Draft<SwitchInterface>, vlan: VlanId) {
  if (port.switchport.mode === 'access') port.switchport.vlan = vlan;
  else if (vlan === DEFAULT_VLAN) delete port.switchport.accessVlan;
  else port.switchport.accessVlan = vlan;
}

function setNativeVlan(port: Draft<SwitchInterface>, vlan: VlanId) {
  if (port.switchport.mode === 'trunk') port.switchport.nativeVlan = vlan;
  else if (vlan === DEFAULT_VLAN) delete port.switchport.nativeVlan;
  else port.switchport.nativeVlan = vlan;
}

function setSwitchportMode(port: Draft<SwitchInterface>, mode: 'access' | 'trunk') {
  const current = port.switchport;
  if (current.mode === mode) return;
  if (current.mode === 'access') {
    const accessVlan = orUnset(current.vlan);
    port.switchport = {
      mode: 'trunk',
      nativeVlan: current.nativeVlan ?? DEFAULT_VLAN,
      ...(accessVlan && { accessVlan }),
    };
  } else {
    const nativeVlan = orUnset(current.nativeVlan);
    port.switchport = {
      mode: 'access',
      vlan: current.accessVlan ?? DEFAULT_VLAN,
      ...(nativeVlan && { nativeVlan }),
    };
  }
}

export const switchCommands = [
  ...commonCommands,
  switchCommand({
    modes: GLOBAL,
    path: [keyword('vlan', 'Vlan commands'), num('vlan', 1, 4094, 'ISL VLAN IDs 1-1005')],
    to: ({ vlan }) => ({ kind: 'vlan-config', vlan: VlanId.parse(vlan) }),
    run: ({ vlan }, ctx) => {
      const id = VlanId.parse(vlan);
      ctx.device.config.vlans[id] ??= { name: defaultVlanName(id) };
      return NOTHING;
    },
    no: ({ vlan }, ctx) => {
      if (vlan === undefined) return ctx.reject('% Incomplete command.');
      if (vlan === DEFAULT_VLAN) return ctx.reject('Default VLAN 1 may not be deleted.');
      delete ctx.device.config.vlans[VlanId.parse(vlan)];
      return NOTHING;
    },
  }),
  switchCommand({
    modes: VLAN,
    path: [keyword('name', 'Ascii name of the VLAN'), word('name', 'The ascii name for the VLAN')],
    run: ({ name }, ctx, mode) => {
      if (name.length > VLAN_NAME_MAX) return ctx.reject('% Name too long');
      ctx.device.config.vlans[mode.vlan] = { name };
      return NOTHING;
    },
    no: (_a, ctx, mode) => {
      ctx.device.config.vlans[mode.vlan] = { name: defaultVlanName(mode.vlan) };
      return NOTHING;
    },
  }),
  switchCommand({
    modes: GLOBAL,
    path: [
      globalIp,
      keyword('default-gateway', 'Specify default gateway (if not routing IP)'),
      ipv4('gateway', 'IP address of default gateway'),
    ],
    run: ({ gateway }, ctx) => {
      ctx.device.config.defaultGateway = gateway;
      return NOTHING;
    },
    no: (_a, ctx) => {
      delete ctx.device.config.defaultGateway;
      return NOTHING;
    },
  }),
  switchCommand({
    modes: IF,
    path: [
      switchport,
      keyword('mode', 'Set trunking mode of the interface'),
      choice('mode', {
        access: 'Set trunking mode to ACCESS unconditionally',
        trunk: 'Set trunking mode to TRUNK unconditionally',
      }),
    ],
    run: ({ mode: target }, ctx, mode) =>
      eachSwitchport(ctx, mode, (port) => setSwitchportMode(port, target)),
    no: (_a, ctx, mode) => eachSwitchport(ctx, mode, (port) => setSwitchportMode(port, 'access')),
  }),
  switchCommand({
    modes: IF,
    path: [
      switchport,
      keyword('access', 'Set access mode characteristics of the interface'),
      keyword('vlan', 'Set VLAN when interface is in access mode'),
      vlanNumber,
    ],
    run: ({ vlan }, ctx, mode) => {
      const id = VlanId.parse(vlan);
      eachSwitchport(ctx, mode, (port) => setAccessVlan(port, id));
      return ensureVlan(ctx, id);
    },
    no: (_a, ctx, mode) => eachSwitchport(ctx, mode, (port) => setAccessVlan(port, DEFAULT_VLAN)),
  }),
  switchCommand({
    modes: IF,
    path: [
      switchport,
      keyword('trunk', 'Set trunking characteristics of the interface'),
      keyword('native', 'Set trunking native characteristics when interface is in trunking mode'),
      keyword('vlan', 'Set native VLAN when interface is in trunking mode'),
      num('vlan', 1, 4094, 'VLAN ID of the native VLAN when this port is in trunking mode'),
    ],
    run: ({ vlan }, ctx, mode) =>
      eachSwitchport(ctx, mode, (port) => setNativeVlan(port, VlanId.parse(vlan))),
    no: (_a, ctx, mode) => eachSwitchport(ctx, mode, (port) => setNativeVlan(port, DEFAULT_VLAN)),
  }),
];
