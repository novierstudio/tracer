// No runtime imports: the simulation worker uses these, and must not pull in zod.
import type { PortId, SubinterfaceId, Switchport, VlanRange } from './topology';
import type { VlanId } from './values';

export const MAX_VLAN = 4094 as VlanId;

/** `switchport trunk allowed vlan all`, spelled out. A switchport stores it as no list at all. */
export const ALL_VLANS: readonly VlanRange[] = [{ first: 1 as VlanId, last: MAX_VLAN }];

/** Sorts ranges and merges the ones that overlap or touch. */
export function normalizeVlans(ranges: readonly VlanRange[]): VlanRange[] {
  const sorted = [...ranges].sort((a, b) => a.first - b.first);
  const merged: VlanRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.first <= last.last + 1) {
      merged[merged.length - 1] = {
        first: last.first,
        last: Math.max(last.last, range.last) as VlanId,
      };
    } else {
      merged.push(range);
    }
  }
  return merged;
}

export function addVlans(to: readonly VlanRange[], more: readonly VlanRange[]): VlanRange[] {
  return normalizeVlans([...to, ...more]);
}

export function removeVlans(from: readonly VlanRange[], drop: readonly VlanRange[]): VlanRange[] {
  let kept = normalizeVlans(from);
  for (const cut of drop) {
    kept = kept.flatMap((range): VlanRange[] => {
      if (cut.last < range.first || cut.first > range.last) return [range];
      return [
        ...(range.first < cut.first
          ? [{ first: range.first, last: (cut.first - 1) as VlanId }]
          : []),
        ...(cut.last < range.last ? [{ first: (cut.last + 1) as VlanId, last: range.last }] : []),
      ];
    });
  }
  return kept;
}

/** An allowed list of `undefined` means every VLAN. */
export function vlanAllowed(allowed: readonly VlanRange[] | undefined, vlan: VlanId): boolean {
  return (
    allowed === undefined || allowed.some((range) => range.first <= vlan && vlan <= range.last)
  );
}

/** Whether a switchport forwards frames of `vlan`: its access VLAN, or a VLAN its trunk allows. */
export function carriesVlan(switchport: Switchport, vlan: VlanId): boolean {
  return switchport.mode === 'access'
    ? switchport.vlan === vlan
    : vlanAllowed(switchport.allowedVlans, vlan);
}

/**
 * The list as IOS prints it: `1-4094`, `1,10,20-30` or `none`. Two neighbours stay apart, as in
 * `10,11`; three or more become a range.
 */
export function formatVlans(ranges: readonly VlanRange[] | undefined): string {
  const list = ranges ?? ALL_VLANS;
  if (list.length === 0) return 'none';
  return list
    .map(({ first, last }) =>
      first === last ? `${first}` : last === first + 1 ? `${first},${last}` : `${first}-${last}`,
    )
    .join(',');
}

/** The Ethernet port a subinterface rides on: GigabitEthernet0/0 for GigabitEthernet0/0.10. */
export function parentPort(id: SubinterfaceId): PortId {
  return id.slice(0, id.lastIndexOf('.')) as PortId;
}
