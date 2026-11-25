import { PortId } from '@/model';

const PORT_TYPES = ['FastEthernet', 'GigabitEthernet', 'Serial'] as const;
const NAME = /^([a-z]+)\s*(\d+(?:\/\d+)*)$/i;

/** `g0/0`, `Gi 0/0` and `gigabitethernet0/00` all become `GigabitEthernet0/0`. */
export function normalizePortName(text: string): PortId | undefined {
  const [, prefix = '', numbers = ''] = NAME.exec(text.trim()) ?? [];
  const lower = prefix.toLowerCase();
  const types = PORT_TYPES.filter((type) => type.toLowerCase().startsWith(lower));
  const [type] = types;
  if (types.length !== 1 || !type) return undefined;
  return PortId.parse(type + numbers.split('/').map(Number).join('/'));
}
