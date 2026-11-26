import type { DhcpBindingEntry } from '../../engine/api';
import { ipv4ToUint32, uint32ToIpv4, type DhcpPool } from '../../model';
import type { IosDevice } from './context';
import { BOOT } from './exec';
import { ciscoMac } from './show';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n: number) => String(n).padStart(2, '0');

/** A lease's end on the router's clock, as IOS writes it: `Mar 02 1993 12:00 AM`. */
function expiration(expiresAt: number | undefined): string {
  if (expiresAt === undefined) return 'Infinite';
  const time = new Date(BOOT + expiresAt);
  const hours = time.getUTCHours();
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return `${MONTHS[time.getUTCMonth()]} ${pad(time.getUTCDate())} ${time.getUTCFullYear()} ${pad(twelve)}:${pad(time.getUTCMinutes())} ${hours < 12 ? 'AM' : 'PM'}`;
}

const row = (cells: readonly string[]) =>
  [cells[0]!.padEnd(20), cells[1]!.padEnd(24), cells[2]!.padEnd(24), cells[3]].join('').trimEnd();

/** `show ip dhcp binding`: each lease in force, by address. Without a simulation, none. */
export function showIpDhcpBinding(bindings: readonly DhcpBindingEntry[] | undefined): string[] {
  return [
    'Bindings from all pools not associated with VRF:',
    row(['IP address', 'Client-ID/', 'Lease expiration', 'Type']),
    row(['', 'Hardware address/', '', '']),
    row(['', 'User name', '', '']),
    ...(bindings ?? []).map((binding) =>
      row([binding.address, ciscoMac(binding.mac), expiration(binding.expiresAt), 'Automatic']),
    ),
  ];
}

function poolBlock(name: string, pool: DhcpPool, leases: readonly DhcpBindingEntry[]): string[] {
  const head = [
    `Pool ${name} :`,
    ' Utilization mark (high/low)    : 100 / 0',
    ' Subnet size (first/next)       : 0 / 0',
  ];
  const { network } = pool;
  if (!network) {
    return [
      ...head,
      ' Total addresses                : 0',
      ' Leased addresses               : 0',
      ' Pending event                  : none',
      ' 0 subnet is currently in the pool :',
    ];
  }
  const base = ipv4ToUint32(network.address);
  const size = 2 ** (32 - network.prefixLength);
  const first = uint32ToIpv4(base + 1);
  const last = uint32ToIpv4(base + size - 2);
  // IOS's index walks up from the start of the range: show the address past the last one leased.
  const highest = Math.max(base, ...leases.map((lease) => ipv4ToUint32(lease.address)));
  return [
    ...head,
    ` Total addresses                : ${Math.max(size - 2, 0)}`,
    ` Leased addresses               : ${leases.length}`,
    ' Pending event                  : none',
    ' 1 subnet is currently in the pool :',
    ' Current index        IP address range                    Leased addresses',
    ` ${uint32ToIpv4(highest + 1).padEnd(21)}${first.padEnd(17)}- ${last.padEnd(18)}${leases.length}`,
  ];
}

/**
 * `show ip dhcp pool [name]`: each pool's size and how many of its addresses are leased. Without
 * a simulation, none are. Undefined for a pool the router does not have.
 */
export function showIpDhcpPool(
  bindings: readonly DhcpBindingEntry[] | undefined,
  device: IosDevice,
  only?: string,
): string[] | undefined {
  const pools = device.kind === 'router' ? (device.config.dhcp?.pools ?? {}) : {};
  if (only !== undefined && !(only in pools)) return undefined;
  const blocks = Object.entries(pools)
    .filter(([name]) => only === undefined || name === only)
    .map(([name, pool]) =>
      poolBlock(
        name,
        pool,
        (bindings ?? []).filter((binding) => binding.pool === name),
      ),
    );
  return blocks.flatMap((block, index) => (index === 0 ? block : ['', ...block]));
}
