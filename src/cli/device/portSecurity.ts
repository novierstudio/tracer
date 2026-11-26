import type { Draft } from 'immer';
import type { Layer2Status, PortSecurityStatus } from '../../engine/api';
import {
  secureMaximum,
  violationOf,
  type MacAddress,
  type PortId,
  type PortSecurity,
  type PortSecurityViolation,
  type SwitchInterface,
} from '../../model';
import type { ModeOf } from '../modes';
import { ptShortName } from '../interfaces';
import { choice, iface, keyword, mac, num } from '../params';
import { defineCommand } from '../tree';
import { INVALID_INPUT, type SwitchContext, type SwitchDevice } from './context';
import { NO_ENGINE } from './showSwitching';

const switchCommand = defineCommand<SwitchContext>();

const EXEC = ['user-exec', 'priv-exec'] as const;
const GLOBAL = ['global-config'] as const;
const IF = ['interface-config'] as const;

const NOTHING: readonly string[] = [];

const show = keyword('show', 'Show running system information');
const switchport = keyword('switchport', 'Set switching mode characteristics');
const portSecurity = keyword('port-security', 'Security related command');
const macAddress = keyword('mac-address', 'Secure mac address');
const sticky = keyword('sticky', 'Configure dynamic secure addresses as sticky');
const address = mac('mac', '48 bit mac address');
const errdisable = keyword('errdisable', 'Error disable');
const recovery = keyword('recovery', 'Error disable recovery');

/** `aabb.ccdd.eeff` in Packet Tracer's upper case, as its port security output writes addresses. */
export const securityMac = (value: MacAddress) =>
  value.replace(/:/g, '').toUpperCase().match(/.{4}/g)!.join('.');

/**
 * Applies `edit` to the port security of each port of the mode. IOS takes port security only on a
 * port set to access or trunk, and rejects a dynamic one, a port at its factory setting, with a
 * line for each. Returns those lines, or the message from `edit` that refuses the command.
 */
function eachSecurePort(
  ctx: SwitchContext,
  mode: ModeOf<'interface-config'>,
  edit: (security: Draft<PortSecurity>, port: Draft<SwitchInterface>) => string | undefined,
): readonly string[] {
  const out: string[] = [];
  for (const id of mode.interfaces) {
    const port = ctx.device.config.interfaces[id as PortId];
    if (!port?.switchport) return ctx.reject(INVALID_INPUT);
    if (port.switchport.mode !== 'trunk' && !port.modeAccess) {
      out.push(`Command rejected: ${id} is a dynamic port.`);
      continue;
    }
    port.portSecurity ??= { enabled: false, addresses: [] };
    const problem = edit(port.portSecurity, port);
    if (problem) return ctx.reject(problem);
  }
  return out;
}

const addAddress = (value: MacAddress, isSticky: boolean) => (security: Draft<PortSecurity>) => {
  if (security.addresses.some((entry) => entry.mac === value)) return undefined;
  if (security.addresses.length >= secureMaximum(security)) {
    return 'Total secure mac-addresses on interface has reached maximum limit.';
  }
  security.addresses.push({ mac: value, sticky: isSticky });
  return undefined;
};

const removeAddress = (value: MacAddress) => (security: Draft<PortSecurity>) => {
  security.addresses = security.addresses.filter((entry) => entry.mac !== value);
  return undefined;
};

const VIOLATION_HELP: Record<PortSecurityViolation, string> = {
  protect: 'Security violation protect mode',
  restrict: 'Security violation restrict mode',
  shutdown: 'Security violation shutdown mode',
};

export const portSecurityCommands = [
  switchCommand({
    modes: IF,
    path: [switchport, portSecurity],
    run: (_a, ctx, mode) => eachSecurePort(ctx, mode, (security) => void (security.enabled = true)),
    no: (_a, ctx, mode) => eachSecurePort(ctx, mode, (security) => void (security.enabled = false)),
  }),
  switchCommand({
    modes: IF,
    path: [
      switchport,
      portSecurity,
      keyword('maximum', 'Max secure addresses'),
      num('maximum', 1, 132, 'Maximum addresses'),
    ],
    run: ({ maximum }, ctx, mode) =>
      eachSecurePort(ctx, mode, (security) => {
        if (maximum === 1) delete security.maximum;
        else security.maximum = maximum;
        return undefined;
      }),
    no: (_a, ctx, mode) => eachSecurePort(ctx, mode, (security) => void delete security.maximum),
  }),
  switchCommand({
    modes: IF,
    path: [
      switchport,
      portSecurity,
      keyword('violation', 'Security violation mode'),
      choice('violation', VIOLATION_HELP),
    ],
    run: ({ violation }, ctx, mode) =>
      eachSecurePort(ctx, mode, (security) => {
        if (violation === 'shutdown') delete security.violation;
        else security.violation = violation;
        return undefined;
      }),
    no: (_a, ctx, mode) => eachSecurePort(ctx, mode, (security) => void delete security.violation),
  }),
  switchCommand({
    modes: IF,
    path: [switchport, portSecurity, macAddress, address],
    run: ({ mac: value }, ctx, mode) => eachSecurePort(ctx, mode, addAddress(value, false)),
    no: ({ mac: value }, ctx, mode) =>
      value ? eachSecurePort(ctx, mode, removeAddress(value)) : ctx.reject(INVALID_INPUT),
  }),
  switchCommand({
    modes: IF,
    path: [switchport, portSecurity, macAddress, sticky],
    run: (_a, ctx, mode) => eachSecurePort(ctx, mode, (security) => void (security.sticky = true)),
    // Sticky addresses go with it, as IOS turns them back into dynamic ones.
    no: (_a, ctx, mode) =>
      eachSecurePort(ctx, mode, (security) => {
        delete security.sticky;
        security.addresses = security.addresses.filter((entry) => !entry.sticky);
        return undefined;
      }),
  }),
  switchCommand({
    modes: IF,
    path: [switchport, portSecurity, macAddress, sticky, address],
    run: ({ mac: value }, ctx, mode) => eachSecurePort(ctx, mode, addAddress(value, true)),
    no: ({ mac: value }, ctx, mode) =>
      value ? eachSecurePort(ctx, mode, removeAddress(value)) : ctx.reject(INVALID_INPUT),
  }),
  switchCommand({
    modes: IF,
    path: [
      switchport,
      portSecurity,
      keyword('aging', 'Port-security aging commands'),
      keyword('time', 'Port-security aging time'),
      num('minutes', 1, 1440, 'Aging time in minutes. Enter a value between 1 and 1440'),
    ],
    run: ({ minutes }, ctx, mode) =>
      eachSecurePort(ctx, mode, (security) => void (security.agingTime = minutes)),
    no: (_a, ctx, mode) => eachSecurePort(ctx, mode, (security) => void delete security.agingTime),
  }),
  switchCommand({
    modes: GLOBAL,
    path: [
      errdisable,
      recovery,
      keyword('cause', 'Enable error disable recovery for application'),
      choice('cause', {
        'psecure-violation': 'Enable timer to recover from psecure violation error',
      }),
    ],
    run: (_a, ctx) => {
      ctx.device.config.errdisableRecovery = {
        ...ctx.device.config.errdisableRecovery,
        psecureViolation: true,
      };
      return NOTHING;
    },
    no: (_a, ctx) => {
      const recovery = ctx.device.config.errdisableRecovery;
      if (recovery) delete recovery.psecureViolation;
      if (recovery && recovery.interval === undefined) delete ctx.device.config.errdisableRecovery;
      return NOTHING;
    },
  }),
  switchCommand({
    modes: GLOBAL,
    path: [
      errdisable,
      recovery,
      keyword('interval', 'Error disable recovery timer value'),
      num('interval', 30, 86400, 'timer-interval(sec)'),
    ],
    run: ({ interval }, ctx) => {
      const rest = { ...ctx.device.config.errdisableRecovery };
      if (interval === 300) delete rest.interval;
      else rest.interval = interval;
      if (rest.psecureViolation || rest.interval !== undefined) {
        ctx.device.config.errdisableRecovery = rest;
      } else delete ctx.device.config.errdisableRecovery;
      return NOTHING;
    },
    no: (_a, ctx) => {
      const recovery = ctx.device.config.errdisableRecovery;
      if (recovery) delete recovery.interval;
      if (recovery && !recovery.psecureViolation) delete ctx.device.config.errdisableRecovery;
      return NOTHING;
    },
  }),
  switchCommand({
    modes: EXEC,
    path: [show, portSecurity],
    run: (_a, ctx) => ctx.query('layer2', (status) => showPortSecurity(status)),
  }),
  switchCommand({
    modes: EXEC,
    path: [show, portSecurity, keyword('address', 'Show secure address')],
    run: (_a, ctx) => ctx.query('layer2', (status) => showPortSecurityAddress(status)),
  }),
  switchCommand({
    modes: EXEC,
    path: [
      show,
      portSecurity,
      keyword('interface', 'Show secure interface'),
      iface('name', 'Interface name'),
    ],
    run: ({ name }, ctx) => {
      const port = ctx.device.config.interfaces[name as PortId];
      if (!port?.switchport) return ctx.reject(INVALID_INPUT);
      return ctx.query('layer2', (status, device) =>
        showPortSecurityInterface(status, device, name as PortId),
      );
    },
  }),
];

const ACTION: Record<PortSecurityViolation, string> = {
  protect: 'Protect',
  restrict: 'Restrict',
  shutdown: 'Shutdown',
};

/** `show port-security`: each secure port's limit, addresses, violations and action. */
export function showPortSecurity(status: Layer2Status | undefined): readonly string[] {
  if (!status) return NO_ENGINE;
  return [
    'Secure Port MaxSecureAddr CurrentAddr SecurityViolation Security Action',
    '               (Count)       (Count)        (Count)',
    '-'.repeat(68),
    ...status.portSecurity.map(
      (port) =>
        ptShortName(port.port).padStart(13) +
        String(port.maximum).padStart(9) +
        String(port.addresses.length).padStart(11) +
        String(port.violations).padStart(18) +
        ' '.repeat(9) +
        ACTION[port.violation],
    ),
    '-'.repeat(70),
  ];
}

const ADDRESS_TYPE = {
  static: 'SecureConfigured',
  sticky: 'SecureSticky',
  dynamic: 'SecureDynamic',
};

/** `show port-security address`: every secure address, by port. */
export function showPortSecurityAddress(status: Layer2Status | undefined): readonly string[] {
  if (!status) return NO_ENGINE;
  const rule = '-'.repeat(77);
  const entries = status.portSecurity.flatMap((port) => port.addresses);
  const extra = status.portSecurity.reduce(
    (sum, port) => sum + Math.max(0, port.addresses.length - 1),
    0,
  );
  return [
    '               Secure Mac Address Table',
    rule,
    'Vlan    Mac Address       Type                          Ports   Remaining Age',
    '                                                                   (mins)',
    '----    -----------       ----                          -----   -------------',
    ...entries.map(
      (entry) =>
        `${String(entry.vlan).padStart(4)}    ${securityMac(entry.mac)}    ${ADDRESS_TYPE[entry.type].padEnd(30)}${ptShortName(entry.port).padEnd(13)}${entry.remainingAge === undefined ? '-' : String(entry.remainingAge)}`,
    ),
    rule,
    `Total Addresses in System (excluding one mac per port)     : ${extra}`,
    'Max Addresses limit in System (excluding one mac per port) : 1024',
  ];
}

const STATE: Record<PortSecurityStatus['state'], string> = {
  'secure-up': 'Secure-up',
  'secure-down': 'Secure-down',
  'secure-shutdown': 'Secure-shutdown',
};

/** `show port-security interface X`: one port's settings, addresses and violations. */
export function showPortSecurityInterface(
  status: Layer2Status | undefined,
  device: SwitchDevice,
  port: PortId,
): readonly string[] {
  if (!status) return NO_ENGINE;
  const security = device.config.interfaces[port]?.portSecurity ?? {
    enabled: false,
    addresses: [],
  };
  const live = status.portSecurity.find((entry) => entry.port === port);
  const count = (type: string) =>
    live?.addresses.filter((entry) => entry.type === type).length ?? 0;
  const last = live?.lastSource;
  const field = (name: string, value: string | number) => `${name.padEnd(27)}: ${value}`;
  return [
    field('Port Security', live ? 'Enabled' : 'Disabled'),
    field('Port Status', live ? STATE[live.state] : 'Secure-down'),
    field('Violation Mode', ACTION[violationOf(security)]),
    field('Aging Time', `${security.agingTime ?? 0} mins`),
    field('Aging Type', 'Absolute'),
    field('SecureStatic Address Aging', 'Disabled'),
    field('Maximum MAC Addresses', secureMaximum(security)),
    field('Total MAC Addresses', live?.addresses.length ?? 0),
    field('Configured MAC Addresses', count('static')),
    field('Sticky MAC Addresses', count('sticky')),
    field(
      'Last Source Address:Vlan',
      last ? `${securityMac(last.mac)}:${last.vlan}` : '0000.0000.0000:0',
    ),
    field('Security Violation Count', live?.violations ?? 0),
  ];
}
