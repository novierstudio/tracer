// Remote management: local usernames, SSH keys and settings, and the EXEC commands that open,
// list and end Telnet and SSH sessions.
import { produce, type Draft } from 'immer';
import {
  DEFAULT_ROUTER_HOSTNAME,
  DEFAULT_SWITCH_HOSTNAME,
  Md5CryptHash,
  sshEnabled,
  Username,
  type LocalUser,
  type RouterConfig,
  type SwitchConfig,
} from '../../model';
import { ipv4, keyword, line, num, word, type Segment } from '../params';
import { decodeType7, encodeType7, hashSecret, verifySecret } from '../passwords';
import { defineCommand } from '../tree';
import type { DeviceContext, IosDevice, IosDraft, Pending, SessionLine } from './context';
import type { VtySession } from './query';

const EXEC = ['user-exec', 'priv-exec'] as const;
const GLOBAL = ['global-config'] as const;
const NOTHING: readonly string[] = [];

const command = defineCommand<DeviceContext>();
const show = keyword('show', 'Show running system information');
const globalIp = keyword('ip', 'Global IP configuration subcommands');
const ipSsh = keyword('ssh', 'Configure ssh options');

type IosConfig = RouterConfig | SwitchConfig;

export const DEFAULT_SSH_TIMEOUT = 120;
export const DEFAULT_SSH_RETRIES = 3;
const DEFAULT_MODULUS = 512;
const MODULUS = { min: 360, max: 2048 } as const;

/** Whether `password` logs `user` in. */
export function verifyUser(user: LocalUser | undefined, password: string): boolean {
  if (!user) return false;
  const { credential } = user;
  return credential.kind === 'secret'
    ? verifySecret(password, credential.hash)
    : credential.text === password;
}

// --- username ---------------------------------------------------------------------------------

const usernameKw = keyword('username', 'Establish User Name Authentication');
const userName = word('name', 'User name');
const privilege = [
  keyword('privilege', 'Set user privilege level'),
  num('level', 0, 15, 'User privilege level'),
] as const;

function setUser(ctx: DeviceContext, name: string, user: LocalUser): readonly string[] {
  const parsed = Username.safeParse(name);
  if (!parsed.success) return ctx.reject('% Invalid username');
  const users = (ctx.device.config.users ??= {});
  const existing = users[parsed.data];
  if (existing && existing.credential.kind !== user.credential.kind) {
    return ctx.reject('ERROR: Can not have both a user password and a user secret.');
  }
  users[parsed.data] = user;
  return NOTHING;
}

const withLevel = (level: number | undefined) =>
  level === undefined || level === 1 ? {} : { privilege: level };

function usernameCommands() {
  const secret = keyword('secret', 'Specify the secret for the user');
  const password = keyword('password', 'Specify the password for the user');
  const forms = [[], privilege] as const;
  return [
    command({
      modes: GLOBAL,
      path: [usernameKw, userName],
      run: (_a, ctx) => ctx.reject('% Incomplete command.'),
      no: ({ name }, ctx) => {
        const users = ctx.device.config.users;
        if (name !== undefined && users) delete users[name];
        if (users && Object.keys(users).length === 0) delete ctx.device.config.users;
        return NOTHING;
      },
    }),
    ...forms.flatMap((level) => [
      ...(
        [
          [[], 'text'],
          [[keyword('0', 'Specifies an UNENCRYPTED secret will follow')], 'text'],
          [[keyword('5', 'Specifies a HIDDEN secret will follow')], 'hash'],
        ] as const
      ).map(([type, kind]) =>
        command({
          modes: GLOBAL,
          path: [
            usernameKw,
            userName,
            ...level,
            secret,
            ...type,
            line('secret', 'The UNENCRYPTED (cleartext) user secret'),
          ] as readonly Segment[],
          run: (args, ctx) => {
            const { name, level, secret } = args as {
              name: string;
              level?: number;
              secret: string;
            };
            if (kind === 'text') {
              const hash = hashSecret(secret);
              return setUser(ctx, name, {
                ...withLevel(level),
                credential: { kind: 'secret', hash },
              });
            }
            const hash = Md5CryptHash.safeParse(secret);
            if (!hash.success) {
              return ctx.reject('ERROR: The secret you entered is not a valid encrypted secret.');
            }
            return setUser(ctx, name, {
              ...withLevel(level),
              credential: { kind: 'secret', hash: hash.data },
            });
          },
        }),
      ),
      ...(
        [
          [[], false],
          [[keyword('0', 'Specifies an UNENCRYPTED password will follow')], false],
          [[keyword('7', 'Specifies a HIDDEN password will follow')], true],
        ] as const
      ).map(([type, hidden]) =>
        command({
          modes: GLOBAL,
          path: [
            usernameKw,
            userName,
            ...level,
            password,
            ...type,
            line('password', 'The UNENCRYPTED (cleartext) user password'),
          ] as readonly Segment[],
          run: (args, ctx) => {
            const { name, level, password } = args as {
              name: string;
              level?: number;
              password: string;
            };
            const text = hidden ? decodeType7(password) : password;
            if (text === undefined) return ctx.reject('Invalid encrypted password');
            return setUser(ctx, name, {
              ...withLevel(level),
              credential: { kind: 'password', text },
            });
          },
        }),
      ),
    ]),
  ];
}

// --- RSA keys ---------------------------------------------------------------------------------

const keyName = (config: IosConfig) => `${config.hostname}.${config.domainName}`;

const sshVersionText = (config: IosConfig) =>
  config.sshVersion === 2 ? '2.0' : config.sshVersion === 1 ? '1.5' : '1.99';

/** Makes the keys and says so, as IOS does once it has the modulus. */
function generateKeys(device: IosDraft, modulus: number): readonly string[] {
  const wasEnabled = sshEnabled(device.config);
  device.config.rsaModulus = modulus;
  return [
    `% Generating ${modulus} bit RSA keys, keys will be non-exportable...[OK]`,
    ...(!wasEnabled && sshEnabled(device.config)
      ? ['', `%SSH-5-ENABLED: SSH ${sshVersionText(device.config)} has been enabled`]
      : []),
  ];
}

const MODULUS_QUESTION = [
  `Choose the size of the key modulus in the range of ${MODULUS.min} to ${MODULUS.max} for your`,
  '  General Purpose Keys. Choosing a key modulus greater than 512 may take',
  '  a few minutes.',
  '',
];

/** After the name is settled: generate now with a modulus from the command, or ask for one. */
function keysOrAsk(ctx: DeviceContext, modulus: number | undefined): readonly string[] {
  if (modulus === undefined) return [...MODULUS_QUESTION, ...ctx.ask({ kind: 'rsa-modulus' })];
  return [`% The key modulus size is ${modulus} bits`, ...generateKeys(ctx.device, modulus)];
}

function startKeys(ctx: DeviceContext, modulus: number | undefined): readonly string[] {
  const { config } = ctx.device;
  const factory = ctx.device.kind === 'router' ? DEFAULT_ROUTER_HOSTNAME : DEFAULT_SWITCH_HOSTNAME;
  if (config.hostname === factory) {
    return ctx.reject(`% Please define a hostname other than ${factory}.`);
  }
  if (config.domainName === undefined) return ctx.reject('% Please define a domain-name first.');
  if (config.rsaModulus !== undefined) {
    return [
      `% You already have RSA keys defined named ${keyName(config)} .`,
      ...ctx.ask(
        modulus === undefined ? { kind: 'rsa-replace' } : { kind: 'rsa-replace', modulus },
      ),
    ];
  }
  return [`The name for the keys will be: ${keyName(config)}`, ...keysOrAsk(ctx, modulus)];
}

function cryptoCommands() {
  const generate = [
    keyword('crypto', 'Encryption module'),
    keyword('key', 'Long term key operations'),
    keyword('generate', 'Generate new keys'),
    keyword('rsa', 'Generate RSA keys'),
  ] as const;
  const general = keyword(
    'general-keys',
    'Generate a general purpose RSA key pair for signing and encryption',
  );
  const modulus = [
    keyword('modulus', 'Provide number of modulus bits on the command line'),
    num('bits', MODULUS.min, MODULUS.max, 'size of RSA modulus (in bits)'),
  ] as const;
  return [[], [general]].flatMap((kind) => [
    command({
      modes: GLOBAL,
      path: [...generate, ...kind],
      run: (_a, ctx) => startKeys(ctx, undefined),
    }),
    command({
      modes: GLOBAL,
      path: [...generate, ...kind, ...modulus] as readonly Segment[],
      run: (args, ctx) => startKeys(ctx, (args as { bits: number }).bits),
    }),
  ]);
}

/** The prompt while a key generation waits on an answer. */
export function rsaPrompt(pending: Extract<Pending, { kind: 'rsa-replace' | 'rsa-modulus' }>) {
  return pending.kind === 'rsa-replace'
    ? '% Do you really want to replace them? [yes/no]: '
    : `How many bits in the modulus [${DEFAULT_MODULUS}]: `;
}

/** The answer to a key generation's question. */
export function continueKeys<D extends IosDevice>(
  device: D,
  pending: Extract<Pending, { kind: 'rsa-replace' | 'rsa-modulus' }>,
  answer: string,
): { device: D; output: readonly string[]; pending?: Pending } {
  const text = answer.trim().toLowerCase();
  if (pending.kind === 'rsa-replace') {
    if (!'yes'.startsWith(text) || text === '') return { device, output: NOTHING };
    const named = [`The name for the keys will be: ${keyName(device.config)}`];
    if (pending.modulus === undefined) {
      return { device, output: [...named, ...MODULUS_QUESTION], pending: { kind: 'rsa-modulus' } };
    }
    return withKeys(device, pending.modulus, [
      ...named,
      `% The key modulus size is ${pending.modulus} bits`,
    ]);
  }
  const bits = text === '' ? DEFAULT_MODULUS : /^\d+$/.test(text) ? Number(text) : NaN;
  if (!(bits >= MODULUS.min && bits <= MODULUS.max)) {
    return {
      device,
      output: [`% Key modulus size must be between ${MODULUS.min} and ${MODULUS.max} bits.`],
      pending,
    };
  }
  return withKeys(device, bits, []);
}

function withKeys<D extends IosDevice>(device: D, bits: number, before: readonly string[]) {
  let output: readonly string[] = NOTHING;
  const next = produce(device, (draft: Draft<D>) => void (output = generateKeys(draft, bits)));
  return { device: next, output: [...before, ...output] };
}

// --- SSH and domain settings ------------------------------------------------------------------

function settingCommands() {
  return [
    command({
      modes: GLOBAL,
      path: [
        globalIp,
        keyword('domain-name', 'Define the default domain name'),
        word('name', 'Default domain name'),
      ],
      run: ({ name }, ctx) => {
        ctx.device.config.domainName = name;
        return NOTHING;
      },
      no: (_a, ctx) => {
        delete ctx.device.config.domainName;
        return NOTHING;
      },
    }),
    command({
      modes: GLOBAL,
      path: [
        globalIp,
        ipSsh,
        keyword('version', 'Specify protocol version to be supported'),
        num('version', 1, 2, 'Protocol version'),
      ],
      run: ({ version }, ctx) => {
        const { config } = ctx.device;
        if (
          version === 2 &&
          config.rsaModulus !== undefined &&
          !sshEnabled({ ...config, sshVersion: 2 })
        ) {
          return ctx.reject('Please create RSA keys (of atleast 768 bits size) to enable SSH v2.');
        }
        config.sshVersion = version as 1 | 2;
        return NOTHING;
      },
      no: (_a, ctx) => {
        delete ctx.device.config.sshVersion;
        return NOTHING;
      },
    }),
    command({
      modes: GLOBAL,
      path: [
        globalIp,
        ipSsh,
        keyword('time-out', 'Specify SSH time-out interval'),
        num('seconds', 1, 120, 'SSH time-out interval (secs)'),
      ],
      run: ({ seconds }, ctx) => {
        ctx.device.config.sshTimeout = seconds;
        return NOTHING;
      },
      no: (_a, ctx) => {
        delete ctx.device.config.sshTimeout;
        return NOTHING;
      },
    }),
    command({
      modes: GLOBAL,
      path: [
        globalIp,
        ipSsh,
        keyword('authentication-retries', 'Specify number of authentication retries'),
        num('retries', 0, 5, 'Number of authentication retries'),
      ],
      run: ({ retries }, ctx) => {
        ctx.device.config.sshRetries = retries;
        return NOTHING;
      },
      no: (_a, ctx) => {
        delete ctx.device.config.sshRetries;
        return NOTHING;
      },
    }),
  ];
}

// --- EXEC: telnet, ssh, logout and the show commands --------------------------------------------

const remoteHost = ipv4('target', 'IP address or hostname of a remote system');

function sessionCommands() {
  const ssh = keyword('ssh', 'Open a secure shell client connection');
  const login = [keyword('-l', 'Log in using this user name'), word('user', 'Login name')] as const;
  const version = [
    keyword('-v', 'Specify SSH Protocol Version'),
    num('version', 1, 2, 'Protocol version'),
  ] as const;
  return [
    command({
      modes: EXEC,
      path: [keyword('telnet', 'Open a telnet connection'), remoteHost],
      run: ({ target }, ctx) => {
        ctx.connect({ protocol: 'telnet', target });
        return NOTHING;
      },
    }),
    ...[[], version].map((v) =>
      command({
        modes: EXEC,
        path: [ssh, ...v, ...login, remoteHost] as readonly Segment[],
        run: (args, ctx) => {
          const { target, user } = args as { target: never; user: string };
          ctx.connect({ protocol: 'ssh', target, user });
          return NOTHING;
        },
      }),
    ),
    command({
      modes: EXEC,
      path: [keyword('logout', 'Exit from the EXEC')],
      run: (_a, ctx) => {
        if (ctx.line.kind === 'vty') ctx.disconnect();
        return NOTHING;
      },
    }),
    command({
      modes: EXEC,
      path: [show, keyword('users', 'Display information about terminal lines')],
      run: (_a, ctx) => {
        const own = ctx.line;
        return ctx.query('sessions', (sessions, device) => showUsers(device, own, sessions ?? []));
      },
    }),
    command({
      modes: EXEC,
      path: [show, keyword('ssh', 'Status of SSH server connections')],
      run: (_a, ctx) => {
        const own = ctx.line;
        return ctx.query('sessions', (sessions, device) =>
          showSsh(device, withOwn(own, sessions ?? [])),
        );
      },
    }),
    command({
      modes: EXEC,
      path: [show, keyword('ip', 'IP information'), keyword('ssh', 'Information on SSH')],
      run: (_a, ctx) => showIpSsh(ctx.device.config),
    }),
  ];
}

export const remoteCommands = [
  ...usernameCommands(),
  ...cryptoCommands(),
  ...settingCommands(),
  ...sessionCommands(),
];

// --- show output ------------------------------------------------------------------------------

/** IOS numbers lines absolutely: the console is 0, a router's aux 1, and the vty lines follow. */
const firstVty = (device: IosDevice) => (device.kind === 'router' ? 2 : 1);

/** The sessions the simulation reports, with this session's own vty line among them. */
function withOwn(own: SessionLine, sessions: readonly VtySession[]): readonly VtySession[] {
  if (own.kind !== 'vty' || sessions.some((session) => session.line === own.index)) return sessions;
  const { index, protocol, peer, user } = own;
  return [...sessions, { line: index, protocol, peer, ...(user !== undefined && { user }) }].sort(
    (a, b) => a.line - b.line,
  );
}

function userRow(mark: boolean, number: number, name: string, user: string, location: string) {
  const head = `${mark ? '*' : ' '}${String(number).padStart(3)} ${name.padEnd(10)}`;
  return `${head}${user.padEnd(11)}${'idle'.padEnd(21)}00:00:00 ${location}`.trimEnd();
}

export function showUsers(
  device: IosDevice,
  own: SessionLine,
  sessions: readonly VtySession[],
): readonly string[] {
  const rows = withOwn(own, sessions).map((session) =>
    userRow(
      own.kind === 'vty' && own.index === session.line,
      firstVty(device) + session.line,
      `vty ${session.line}`,
      session.user ?? '',
      session.peer,
    ),
  );
  return [
    '    Line       User       Host(s)              Idle       Location',
    ...(own.kind === 'console' ? [userRow(true, 0, 'con 0', '', '')] : []),
    ...rows,
    '',
    '  Interface    User               Mode         Idle     Peer Address',
    '',
  ];
}

export function showSsh(device: IosDevice, sessions: readonly VtySession[]): readonly string[] {
  const ssh = sessions.filter((session) => session.protocol === 'ssh');
  const v1 = device.config.sshVersion === 1;
  const none = (version: 1 | 2) => `%No SSHv${version} server connections running.`;
  if (ssh.length === 0) return [none(2), none(1)];
  const row = (cells: readonly string[]) =>
    [
      cells[0]!.padEnd(11),
      cells[1]!.padEnd(8),
      cells[2]!.padEnd(5),
      cells[3]!.padEnd(12),
      cells[4]!.padEnd(13),
      cells[5]!.padEnd(22),
      cells[6],
    ].join('');
  return [
    row(['Connection', 'Version', 'Mode', 'Encryption', 'Hmac', 'State', 'Username']),
    ...ssh.flatMap((session) =>
      (['IN', 'OUT'] as const).map((mode) =>
        row([
          String(session.line),
          v1 ? '1.5' : '2.0',
          mode,
          'aes256-cbc',
          'hmac-sha1',
          'Session started',
          session.user ?? '',
        ]).trimEnd(),
      ),
    ),
    none(v1 ? 2 : 1),
  ];
}

export function showIpSsh(config: IosConfig): readonly string[] {
  const enabled = sshEnabled(config);
  return [
    `SSH ${enabled ? 'Enabled' : 'Disabled'} - version ${sshVersionText(config)}`,
    ...(enabled
      ? []
      : ['%Please create RSA keys to enable SSH (and of atleast 768 bits for SSH v2).']),
    `Authentication timeout: ${config.sshTimeout ?? DEFAULT_SSH_TIMEOUT} secs; Authentication retries: ${config.sshRetries ?? DEFAULT_SSH_RETRIES}`,
  ];
}

// --- running-config ---------------------------------------------------------------------------

/** `username` lines, as IOS writes them after the enable secret. */
export function usernameLines(config: IosConfig): string[] {
  return Object.entries(config.users ?? {}).map(([name, user]) => {
    const level = user.privilege === undefined ? '' : ` privilege ${user.privilege}`;
    const { credential } = user;
    if (credential.kind === 'secret') return `username ${name}${level} secret 5 ${credential.hash}`;
    const shown = config.servicePasswordEncryption
      ? `7 ${encodeType7(credential.text)}`
      : `0 ${credential.text}`;
    return `username ${name}${level} password ${shown}`;
  });
}

/** `ip ssh` settings that differ from the defaults. */
export function sshLines(config: IosConfig): string[] {
  return [
    ...(config.sshVersion === undefined ? [] : [`ip ssh version ${config.sshVersion}`]),
    ...(config.sshTimeout === undefined ? [] : [`ip ssh time-out ${config.sshTimeout}`]),
    ...(config.sshRetries === undefined
      ? []
      : [`ip ssh authentication-retries ${config.sshRetries}`]),
  ];
}
