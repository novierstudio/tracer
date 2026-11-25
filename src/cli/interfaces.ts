export type InterfaceName = string & { readonly __brand: 'InterfaceName' };

export interface InterfaceType {
  readonly name: string;
  readonly help: string;
}

export const INTERFACE_TYPES: readonly InterfaceType[] = [
  { name: 'Ethernet', help: 'IEEE 802.3' },
  { name: 'FastEthernet', help: 'FastEthernet IEEE 802.3' },
  { name: 'GigabitEthernet', help: 'GigabitEthernet IEEE 802.3z' },
  { name: 'Loopback', help: 'Loopback interface' },
  { name: 'Serial', help: 'Serial' },
  { name: 'Vlan', help: 'Catalyst Vlans' },
];

const MAX_RANGE = 256;
const SINGLE = /^([a-z]+)\s*(\d+(?:\/\d+)*)$/i;
const RANGE = /^([a-z]+)\s*(\d+(?:\/\d+)*)(?:\s*-\s*(\d+))?$/i;

export function resolveInterfaceType(prefix: string): InterfaceType | undefined {
  const p = prefix.toLowerCase();
  if (p === '') return undefined;
  const exact = INTERFACE_TYPES.find((t) => t.name.toLowerCase() === p);
  if (exact) return exact;
  const matches = INTERFACE_TYPES.filter((t) => t.name.toLowerCase().startsWith(p));
  return matches.length === 1 ? matches[0] : undefined;
}

function canonicalPort(port: string): string {
  return port.split('/').map(Number).join('/');
}

/** `g0/0`, `gi 0/0` and `GigabitEthernet0/0` all become `GigabitEthernet0/0`. */
export function normalizeInterface(text: string): InterfaceName | undefined {
  const [, prefix = '', port = ''] = SINGLE.exec(text.trim()) ?? [];
  const type = resolveInterfaceType(prefix);
  return type && port ? ((type.name + canonicalPort(port)) as InterfaceName) : undefined;
}

/** `f0/1 - 3` becomes FastEthernet0/1, 0/2 and 0/3. The range varies the last number. */
export function expandInterfaceRange(text: string): readonly InterfaceName[] | undefined {
  const [, prefix = '', rawPort = '', end] = RANGE.exec(text.trim()) ?? [];
  const type = resolveInterfaceType(prefix);
  if (!type || !rawPort) return undefined;
  const port = canonicalPort(rawPort);
  if (end === undefined) return [(type.name + port) as InterfaceName];
  const slash = port.lastIndexOf('/');
  const head = port.slice(0, slash + 1);
  const from = Number(port.slice(slash + 1));
  const to = Number(end);
  if (to < from || to - from >= MAX_RANGE) return undefined;
  return Array.from(
    { length: to - from + 1 },
    (_, k) => `${type.name}${head}${from + k}` as InterfaceName,
  );
}
