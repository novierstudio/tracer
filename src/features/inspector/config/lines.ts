import {
  formatSubnetMask,
  VTY_LINE_COUNT,
  type InterfaceId,
  type Ipv4Address,
  type Ipv4Cidr,
  type LineConfig,
  type StaticRoute,
  type Switchport,
  type VlanId,
} from '@/model';

/**
 * IOS config lines, as typed at `(config)#`. A form builds them, the CLI runs them, and the
 * IOS preview shows them, so what a student reads is exactly what changed the device.
 */
export type IosLines = readonly string[];

export const hostnameLines = (hostname: string): IosLines => [`hostname ${hostname}`];

const BANNER_DELIMITERS = ['^C', '#', '%', '$', '@', '&', '~'];

/** `banner motd ^C...^C`, with a delimiter the text does not contain. Empty text removes it. */
export function bannerLines(text: string): IosLines {
  if (text === '') return ['no banner motd'];
  const delimiter = BANNER_DELIMITERS.find((d) => !text.includes(d)) ?? '^C';
  const rows = text.split('\n');
  if (rows.length === 1) return [`banner motd ${delimiter}${text}${delimiter}`];
  return [`banner motd ${delimiter}${rows[0]}`, ...rows.slice(1, -1), `${rows.at(-1)}${delimiter}`];
}

export const enableSecretLines = (secret: string | undefined): IosLines =>
  secret === undefined ? ['no enable secret'] : [`enable secret ${secret}`];

const negate = (on: boolean, command: string) => (on ? command : `no ${command}`);

export const passwordEncryptionLines = (on: boolean): IosLines => [
  negate(on, 'service password-encryption'),
];

export const domainLookupLines = (on: boolean): IosLines => [negate(on, 'ip domain-lookup')];

export const defaultGatewayLines = (gateway: Ipv4Address | undefined): IosLines =>
  gateway === undefined ? ['no ip default-gateway'] : [`ip default-gateway ${gateway}`];

/** The interface settings a form edits. Absent speed or duplex means auto. */
export type InterfaceSettings = {
  shutdown: boolean;
  description?: string;
  ipv4?: Ipv4Cidr;
  speed?: 10 | 100 | 1000;
  duplex?: 'full' | 'half';
  clockRate?: number;
};

const sameCidr = (a: Ipv4Cidr | undefined, b: Ipv4Cidr | undefined) =>
  a?.address === b?.address && a?.prefixLength === b?.prefixLength;

const block = (header: string, body: readonly string[]): IosLines =>
  body.length === 0 ? [] : [header, ...body];

/** Only the settings that differ, so the preview teaches one command per change. */
export function interfaceLines(
  id: InterfaceId,
  before: InterfaceSettings,
  after: InterfaceSettings,
): IosLines {
  const body: string[] = [];
  if (after.description !== before.description) {
    body.push(
      after.description === undefined ? ' no description' : ` description ${after.description}`,
    );
  }
  if (!sameCidr(after.ipv4, before.ipv4)) {
    body.push(
      after.ipv4
        ? ` ip address ${after.ipv4.address} ${formatSubnetMask(after.ipv4.prefixLength)}`
        : ' no ip address',
    );
  }
  if (after.speed !== before.speed) body.push(` speed ${after.speed ?? 'auto'}`);
  if (after.duplex !== before.duplex) body.push(` duplex ${after.duplex ?? 'auto'}`);
  if (after.clockRate !== before.clockRate) {
    body.push(after.clockRate ? ` clock rate ${after.clockRate}` : ' no clock rate');
  }
  if (after.shutdown !== before.shutdown) body.push(after.shutdown ? ' shutdown' : ' no shutdown');
  return block(`interface ${id}`, body);
}

/** A port's membership as the form shows it: the access VLAN, or the trunk's native VLAN. */
export type PortMembership = { mode: Switchport['mode']; vlan: VlanId };

export function membershipOf(switchport: Switchport): PortMembership {
  return switchport.mode === 'access'
    ? { mode: 'access', vlan: switchport.vlan }
    : { mode: 'trunk', vlan: switchport.nativeVlan };
}

export function switchportLines(
  id: InterfaceId,
  before: Switchport,
  after: PortMembership,
): IosLines {
  const body: string[] = [];
  if (after.mode !== before.mode) body.push(` switchport mode ${after.mode}`);
  // Switching mode restores the VLAN that mode last had, as IOS does.
  if (after.mode === 'access') {
    const current = before.mode === 'access' ? before.vlan : (before.accessVlan ?? 1);
    if (after.vlan !== current) body.push(` switchport access vlan ${after.vlan}`);
  } else {
    const current = before.nativeVlan ?? 1;
    if (after.vlan !== current) body.push(` switchport trunk native vlan ${after.vlan}`);
  }
  return block(`interface ${id}`, body);
}

export function routeLine({ prefix, nextHop }: Pick<StaticRoute, 'prefix' | 'nextHop'>): string {
  const via = nextHop.kind === 'address' ? nextHop.address : nextHop.interface;
  return `ip route ${prefix.address} ${formatSubnetMask(prefix.prefixLength)} ${via}`;
}

export const addRouteLines = (route: Pick<StaticRoute, 'prefix' | 'nextHop'>): IosLines => [
  routeLine(route),
];

export const removeRouteLines = (route: StaticRoute): IosLines => [`no ${routeLine(route)}`];

export const vlanLines = (vlan: VlanId, name: string | undefined): IosLines => [
  `vlan ${vlan}`,
  ...(name === undefined ? [] : [` name ${name}`]),
];

export const removeVlanLines = (vlan: VlanId): IosLines => [`no vlan ${vlan}`];

export type LineName = 'console' | 'vty';

const LINE_HEADERS: Record<LineName, string> = {
  console: 'line console 0',
  vty: `line vty 0 ${VTY_LINE_COUNT - 1}`,
};

const LOGIN_LINES: Record<LineConfig['login'], string> = {
  none: ' no login',
  password: ' login',
  local: ' login local',
};

export type Transport = 'all' | 'ssh' | 'telnet' | 'none';

export function transportOf({ ssh, telnet }: LineConfig['transportInput']): Transport {
  if (ssh && telnet) return 'all';
  return ssh ? 'ssh' : telnet ? 'telnet' : 'none';
}

export function lineLines(name: LineName, before: LineConfig, after: LineConfig): IosLines {
  const body: string[] = [];
  if (after.password !== before.password) {
    body.push(after.password === undefined ? ' no password' : ` password ${after.password}`);
  }
  if (after.login !== before.login) body.push(LOGIN_LINES[after.login]);
  const transport = transportOf(after.transportInput);
  if (transport !== transportOf(before.transportInput)) {
    body.push(` transport input ${transport}`);
  }
  return block(LINE_HEADERS[name], body);
}
