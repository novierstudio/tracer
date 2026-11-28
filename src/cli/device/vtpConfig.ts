import { vtpMode, type SwitchConfig } from '../../model';

/** VTP's running-config lines. Kept apart from the commands so the running-config needs no CLI tree. */

/** In transparent mode the running-config holds VTP's lines, since vlan.dat does not count. */
export function vtpConfigLines(config: SwitchConfig): string[] {
  if (vtpMode(config) !== 'transparent') return [];
  const domain = config.vtp?.domain;
  return [...(domain === undefined ? [] : [`vtp domain ${domain}`]), 'vtp mode transparent', '!'];
}

/** A transparent switch's VLANs, after its spanning tree lines. VLAN 1 is never listed. */
export function transparentVlanLines(config: SwitchConfig): string[] {
  if (vtpMode(config) !== 'transparent') return [];
  return Object.entries(config.vlans)
    .map(([id, vlan]) => ({ id: Number(id), name: vlan.name }))
    .filter(({ id }) => id !== 1)
    .sort((a, b) => a.id - b.id)
    .flatMap(({ id, name }) => [
      `vlan ${id}`,
      ...(name === `VLAN${String(id).padStart(4, '0')}` ? [] : [` name ${name}`]),
      '!',
    ]);
}
