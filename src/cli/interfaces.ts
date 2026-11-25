import { INTERFACE_TYPES as TYPE_NAMES, InterfaceId, type InterfaceType } from '../model';

export interface InterfaceTypeHelp {
  readonly name: InterfaceType;
  readonly help: string;
}

const HELP: Record<InterfaceType, string> = {
  Loopback: 'Loopback interface',
  FastEthernet: 'FastEthernet IEEE 802.3',
  GigabitEthernet: 'GigabitEthernet IEEE 802.3z',
  Serial: 'Serial',
  Vlan: 'Catalyst Vlans',
};

export const INTERFACE_TYPES: readonly InterfaceTypeHelp[] = TYPE_NAMES.map((name) => ({
  name,
  help: HELP[name],
}));

const MAX_RANGE = 256;
const SINGLE = /^([a-z]+)\s*(\d+(?:\/\d+)*)$/i;
const RANGE = /^([a-z]+)\s*(\d+(?:\/\d+)*)(?:\s*-\s*(\d+))?$/i;

export function resolveInterfaceType(prefix: string): InterfaceTypeHelp | undefined {
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

function toInterfaceId(type: InterfaceTypeHelp, port: string): InterfaceId | undefined {
  const parsed = InterfaceId.safeParse(type.name + port);
  return parsed.success ? parsed.data : undefined;
}

/** `g0/0`, `gi 0/0` and `GigabitEthernet0/0` all become `GigabitEthernet0/0`. */
export function normalizeInterface(text: string): InterfaceId | undefined {
  const [, prefix = '', port = ''] = SINGLE.exec(text.trim()) ?? [];
  const type = resolveInterfaceType(prefix);
  return type && port ? toInterfaceId(type, canonicalPort(port)) : undefined;
}

/** `f0/1 - 3` becomes FastEthernet0/1, 0/2 and 0/3. The range varies the last number. */
export function expandInterfaceRange(text: string): readonly InterfaceId[] | undefined {
  const [, prefix = '', rawPort = '', end] = RANGE.exec(text.trim()) ?? [];
  const type = resolveInterfaceType(prefix);
  if (!type || !rawPort) return undefined;
  const port = canonicalPort(rawPort);
  if (end === undefined) {
    const single = toInterfaceId(type, port);
    return single && [single];
  }
  const slash = port.lastIndexOf('/');
  const head = port.slice(0, slash + 1);
  const from = Number(port.slice(slash + 1));
  const to = Number(end);
  if (to < from || to - from >= MAX_RANGE) return undefined;
  const names: InterfaceId[] = [];
  for (let n = from; n <= to; n++) {
    const name = toInterfaceId(type, `${head}${n}`);
    if (!name) return undefined;
    names.push(name);
  }
  return names;
}
