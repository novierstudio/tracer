import type { Device, MacAddress, PortId, PortSecurity, VlanId } from '@/model';
import { DEFAULT_ERRDISABLE_INTERVAL, secureMaximum, violationOf } from '@/model/l2';
import { ms, type SimTime } from '../core/time';
import type { DeviceContext } from '../module';
import type { ErrDisabledPort, PortSecurityStatus, SecureAddressEntry } from './status';

/**
 * Port security on access ports: a port takes frames from at most `maximum` source addresses,
 * the ones the config names and the first ones it hears. A frame from any other address is a
 * violation, which drops it (protect), drops and counts it (restrict) or err-disables the port
 * (shutdown). The switching module owns this state and checks every frame before it learns.
 */

type Switch = Extract<Device, { kind: 'switch' }>;

/** An address the port learned itself: dynamic, or sticky on its way into the config. */
type Learned = { readonly mac: MacAddress; readonly sticky: boolean; readonly at: SimTime };

type SecurePort = {
  readonly learned: Learned[];
  violations: number;
  lastSource: { readonly mac: MacAddress; readonly vlan: VlanId } | undefined;
};

export type SecurityState = {
  readonly ports: Map<PortId, SecurePort>;
  /** Err-disabled ports, and when recovery brings each back. */
  readonly errDisabled: Map<PortId, { readonly recoverAt: SimTime | undefined }>;
};

export const createSecurityState = (): SecurityState => ({
  ports: new Map(),
  errDisabled: new Map(),
});

const TIMER_PREFIX = 'psec';
const recoverKey = (port: PortId) => `${TIMER_PREFIX} recover ${port}`;

/** The port's port security while it is on and the port is an access port. */
function securityOf(device: Switch, port: PortId): PortSecurity | undefined {
  const config = device.config.interfaces[port];
  const security = config?.portSecurity;
  return security?.enabled && config?.switchport?.mode === 'access' ? security : undefined;
}

const short = (port: PortId) =>
  port.replace(/^FastEthernet/, 'Fa').replace(/^GigabitEthernet/, 'Gi');

/** `aabb.ccdd.eeff`, as IOS writes an address in its messages. */
const ciscoMac = (mac: MacAddress) => mac.replace(/:/g, '').match(/.{4}/g)!.join('.');

/** Learned addresses that have not aged out under `aging time`. Sticky ones never age. */
function fresh(security: PortSecurity, learned: Learned[], now: SimTime): Learned[] {
  const { agingTime } = security;
  if (agingTime === undefined) return learned;
  return learned.filter((entry) => entry.sticky || now - entry.at < agingTime * 60_000);
}

function portState(state: SecurityState, port: PortId): SecurePort {
  let secure = state.ports.get(port);
  if (!secure) {
    secure = { learned: [], violations: 0, lastSource: undefined };
    state.ports.set(port, secure);
  }
  return secure;
}

/** The addresses secure on a port: the config's, then those it learned and the config lacks. */
function secureAddresses(security: PortSecurity, secure: SecurePort | undefined, now: SimTime) {
  const configured = security.addresses.map((entry) => entry.mac);
  const learned = fresh(security, secure?.learned ?? [], now).filter(
    (entry) => !configured.includes(entry.mac),
  );
  return { configured, learned };
}

/** What the switch does with a frame from `mac` on a secure port. */
export type SecurityVerdict = 'forward' | 'drop' | 'err-disable';

/**
 * Checks a frame's source address on a secure port before the bridge learns it. A new address
 * within the maximum becomes secure: sticky ones go to the config through `learnSticky`.
 */
export function checkSource(
  ctx: DeviceContext,
  device: Switch,
  state: SecurityState,
  port: PortId,
  vlan: VlanId,
  mac: MacAddress,
): SecurityVerdict {
  const security = securityOf(device, port);
  if (!security) return 'forward';
  const secure = portState(state, port);
  secure.lastSource = { mac, vlan };
  const { configured, learned } = secureAddresses(security, secure, ctx.now);
  if (configured.includes(mac) || learned.some((entry) => entry.mac === mac)) return 'forward';

  // An address secure on another port in the VLAN is a violation here too.
  const elsewhere = [...state.ports.keys()].some((other) => {
    if (other === port) return false;
    const otherSecurity = securityOf(device, other);
    const otherVlan = device.config.interfaces[other]?.switchport;
    if (!otherSecurity || otherVlan?.mode !== 'access' || otherVlan.vlan !== vlan) return false;
    const found = secureAddresses(otherSecurity, state.ports.get(other), ctx.now);
    return found.configured.includes(mac) || found.learned.some((entry) => entry.mac === mac);
  });
  if (!elsewhere && configured.length + learned.length < secureMaximum(security)) {
    const sticky = security.sticky === true;
    secure.learned.splice(0, secure.learned.length, ...learned, { mac, sticky, at: ctx.now });
    if (sticky) ctx.learnSticky(port, mac);
    ctx.note(`${port} learned secure address ${mac}${sticky ? ' (sticky)' : ''}`);
    return 'forward';
  }
  return violate(ctx, device, state, port, mac, security);
}

const violationMessage = (port: PortId, mac: MacAddress) =>
  `%PORT_SECURITY-2-PSECURE_VIOLATION: Security violation occurred, caused by MAC address ${ciscoMac(mac)} on port ${port}.`;

function violate(
  ctx: DeviceContext,
  device: Switch,
  state: SecurityState,
  port: PortId,
  mac: MacAddress,
  security: PortSecurity,
): SecurityVerdict {
  const secure = portState(state, port);
  switch (violationOf(security)) {
    case 'protect':
      ctx.note(`${port} dropped a frame from ${mac}: port security protects the port`);
      return 'drop';
    case 'restrict':
      secure.violations += 1;
      ctx.note(`${port} dropped a frame from ${mac}: a port security violation`);
      ctx.syslog(violationMessage(port, mac));
      return 'drop';
    case 'shutdown': {
      secure.violations += 1;
      const recovery = device.config.errdisableRecovery;
      const interval = recovery?.psecureViolation
        ? (recovery.interval ?? DEFAULT_ERRDISABLE_INTERVAL)
        : undefined;
      const recoverAt =
        interval === undefined ? undefined : ((ctx.now + interval * 1000) as SimTime);
      state.errDisabled.set(port, { recoverAt });
      if (interval !== undefined) ctx.setTimer(recoverKey(port), ms(interval * 1000));
      forgetDynamic(state, port);
      ctx.note(`${port} is err-disabled: a port security violation by ${mac}`);
      ctx.syslog(
        `%PM-4-ERR_DISABLE: psecure-violation error detected on ${short(port)}, putting ${short(port)} in err-disable state`,
      );
      ctx.syslog(violationMessage(port, mac));
      return 'err-disable';
    }
  }
}

/** A port's link went down: it forgets the dynamic addresses it learned, as IOS does. */
export function forgetDynamic(state: SecurityState, port: PortId) {
  const secure = state.ports.get(port);
  if (!secure) return;
  const kept = secure.learned.filter((entry) => entry.sticky);
  secure.learned.splice(0, secure.learned.length, ...kept);
}

/**
 * Brings port security in line with the config. A port shut down leaves err-disable, as
 * `shutdown` then `no shutdown` recovers it on IOS. A port without port security forgets what it
 * learned, and learned sticky addresses the config now holds are the config's. Returns whether
 * an err-disabled port came back.
 */
export function syncSecurity(ctx: DeviceContext, device: Switch, state: SecurityState): boolean {
  let recovered = false;
  for (const port of [...state.errDisabled.keys()]) {
    if (device.config.interfaces[port]?.shutdown !== false) {
      state.errDisabled.delete(port);
      ctx.clearTimer(recoverKey(port));
      recovered = true;
    }
  }
  for (const [port, secure] of state.ports) {
    const security = securityOf(device, port);
    if (!security) {
      state.ports.delete(port);
      continue;
    }
    const configured = security.addresses.map((entry) => entry.mac);
    const learned = secure.learned.filter(
      (entry) => !configured.includes(entry.mac) && (entry.sticky ? security.sticky : true),
    );
    secure.learned.splice(0, secure.learned.length, ...learned);
  }
  return recovered;
}

/** Runs port security's recovery timer. Returns whether it was one, so links need a look. */
export function onSecurityTimer(ctx: DeviceContext, state: SecurityState, key: string): boolean {
  const [prefix, , port] = key.split(' ') as [string, string, PortId];
  if (prefix !== TIMER_PREFIX || !state.errDisabled.delete(port)) return false;
  ctx.syslog(
    `%PM-4-ERR_RECOVER: Attempting to recover from psecure-violation err-disable state on ${short(port)}`,
  );
  return true;
}

export const isErrDisabled = (state: SecurityState, port: PortId) => state.errDisabled.has(port);

/** Every secure port, in hardware order, as `show port-security` reports them. */
export function portSecurityStatus(
  ctx: DeviceContext,
  device: Switch,
  state: SecurityState,
): PortSecurityStatus[] {
  return device.ports.flatMap((hardware): PortSecurityStatus[] => {
    const port = hardware.id;
    const security = securityOf(device, port);
    const vlan = device.config.interfaces[port]?.switchport;
    if (!security || vlan?.mode !== 'access') return [];
    const secure = state.ports.get(port);
    const configuredEntries = security.addresses.map(({ mac, sticky }): SecureAddressEntry => ({
      port,
      vlan: vlan.vlan,
      mac,
      type: sticky ? 'sticky' : 'static',
    }));
    const { learned } = secureAddresses(security, secure, ctx.now);
    const learnedEntries = learned.map(({ mac, sticky, at }): SecureAddressEntry => {
      const age = security.agingTime;
      const remaining =
        age === undefined || sticky ? undefined : Math.ceil(age - (ctx.now - at) / 60_000);
      return {
        port,
        vlan: vlan.vlan,
        mac,
        type: sticky ? 'sticky' : 'dynamic',
        ...(remaining !== undefined && { remainingAge: remaining }),
      };
    });
    return [
      {
        port,
        state: state.errDisabled.has(port)
          ? 'secure-shutdown'
          : ctx.portUp(port)
            ? 'secure-up'
            : 'secure-down',
        maximum: secureMaximum(security),
        violation: violationOf(security),
        violations: secure?.violations ?? 0,
        ...(secure?.lastSource && { lastSource: secure.lastSource }),
        addresses: [...configuredEntries, ...learnedEntries],
      },
    ];
  });
}

export function errDisabledPorts(state: SecurityState): ErrDisabledPort[] {
  return [...state.errDisabled].map(([port, { recoverAt }]) => ({
    port,
    cause: 'psecure-violation',
    ...(recoverAt !== undefined && { recoverAt }),
  }));
}
