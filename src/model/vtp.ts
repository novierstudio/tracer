// No runtime imports beyond md5: the simulation worker uses these, and must not pull in zod.
import { md5 } from './md5';
import type { SwitchConfig, VtpConfig, VtpMode } from './topology';

type VtpFields = Pick<SwitchConfig, 'vtp' | 'vlans'>;

export const vtpMode = (config: Pick<SwitchConfig, 'vtp'>): VtpMode => config.vtp?.mode ?? 'server';

export const vtpRevision = (config: Pick<SwitchConfig, 'vtp'>): number =>
  config.vtp?.revision ?? 0;

export const vtpVersion = (config: Pick<SwitchConfig, 'vtp'>): 1 | 2 => config.vtp?.version ?? 1;

/** VLANs 1002 to 1005, the FDDI and Token Ring defaults every switch has and VTP never changes. */
export const RESERVED_VLANS = [1002, 1003, 1004, 1005] as const;

/** Seconds between the summary advertisements a VTP server or client sends unprompted. */
export const VTP_SUMMARY_INTERVAL = 300;

/** What a VTP update carries, and what a switch that takes it stores in its VLAN database. */
export type VlanDatabase = {
  readonly domain: string;
  readonly revision: number;
  readonly version: 1 | 2;
  readonly vlans: SwitchConfig['vlans'];
};

/** The config with `database` as its VLANs and revision, as a switch stores a VTP update it takes. */
export function withVlanDatabase(config: SwitchConfig, database: VlanDatabase): SwitchConfig {
  const vtp: VtpConfig = {
    ...config.vtp,
    domain: database.domain,
    revision: database.revision,
    ...(database.version === 2 ? { version: 2 } : {}),
  };
  if (database.version === 1) delete vtp.version;
  return { ...config, vlans: database.vlans, vtp };
}

/**
 * The VTP settings after one change to the switch's VLANs: a server counts it in its revision,
 * which is what tells the rest of the domain to take its VLANs. Client and transparent switches
 * keep their revision.
 */
export function afterVlanChange(config: Pick<SwitchConfig, 'vtp'>): VtpConfig | undefined {
  if (vtpMode(config) !== 'server') return config.vtp;
  return { ...config.vtp, revision: vtpRevision(config) + 1 };
}

const utf8 = (text: string) => new TextEncoder().encode(text);

/**
 * The MD5 digest a summary advertisement carries: of the password, the domain, the revision and
 * the VLANs. Switches whose passwords differ compute different digests for the same VLANs, so
 * neither takes the other's updates.
 */
export function vtpDigest(config: VtpFields): Uint8Array {
  const vlans = Object.entries(config.vlans)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([id, vlan]) => `${id}=${vlan.name}`);
  const secret = config.vtp?.password ?? '';
  const text = [secret, config.vtp?.domain ?? '', vtpRevision(config), ...vlans, secret];
  return md5(utf8(text.join('\n')));
}
