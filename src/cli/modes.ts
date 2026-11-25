import type { InterfaceId } from '../model';

export type Mode =
  | { readonly kind: 'user-exec' }
  | { readonly kind: 'priv-exec' }
  | { readonly kind: 'global-config' }
  | { readonly kind: 'interface-config'; readonly interfaces: readonly InterfaceId[] }
  | { readonly kind: 'line-config'; readonly line: string }
  | { readonly kind: 'router-config'; readonly protocol: string };

export type ModeKind = Mode['kind'];
export type ModeOf<K extends ModeKind> = Extract<Mode, { kind: K }>;

export const USER_EXEC: ModeOf<'user-exec'> = { kind: 'user-exec' };
export const PRIV_EXEC: ModeOf<'priv-exec'> = { kind: 'priv-exec' };
export const GLOBAL_CONFIG: ModeOf<'global-config'> = { kind: 'global-config' };

interface ModeSpec<K extends ModeKind> {
  readonly suffix: (mode: ModeOf<K>) => string;
  /** Where `exit` leaves to. `exit` from an EXEC mode logs out, which starts a new user EXEC session. */
  readonly exit: Mode;
  /** Config modes accept `do`, and `end` or Ctrl+Z return them to privileged EXEC. */
  readonly config: boolean;
}

const MODES: { readonly [K in ModeKind]: ModeSpec<K> } = {
  'user-exec': { suffix: () => '>', exit: USER_EXEC, config: false },
  'priv-exec': { suffix: () => '#', exit: USER_EXEC, config: false },
  'global-config': { suffix: () => '(config)#', exit: PRIV_EXEC, config: true },
  'interface-config': {
    suffix: (mode) => (mode.interfaces.length > 1 ? '(config-if-range)#' : '(config-if)#'),
    exit: GLOBAL_CONFIG,
    config: true,
  },
  'line-config': { suffix: () => '(config-line)#', exit: GLOBAL_CONFIG, config: true },
  'router-config': { suffix: () => '(config-router)#', exit: GLOBAL_CONFIG, config: true },
};

export function prompt(hostname: string, mode: Mode): string {
  const suffix = MODES[mode.kind].suffix as (mode: Mode) => string;
  return hostname + suffix(mode);
}

export function isConfigMode(mode: Mode): boolean {
  return MODES[mode.kind].config;
}

export function exitMode(mode: Mode): Mode {
  return MODES[mode.kind].exit;
}

/** The mode after `end` or Ctrl+Z. */
export function endMode(mode: Mode): Mode {
  return isConfigMode(mode) ? PRIV_EXEC : mode;
}
