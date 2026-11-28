import type { RouterConfig, SwitchConfig } from '../../model';
import type { SessionLine } from './context';

/** `logging trap` levels by severity, 0 to 7, with the help IOS gives each. */
export const TRAP_LEVELS = [
  ['emergencies', 'System is unusable                (severity=0)'],
  ['alerts', 'Immediate action needed           (severity=1)'],
  ['critical', 'Critical conditions               (severity=2)'],
  ['errors', 'Error conditions                  (severity=3)'],
  ['warnings', 'Warning conditions                (severity=4)'],
  ['notifications', 'Normal but significant conditions (severity=5)'],
  ['informational', 'Informational messages            (severity=6)'],
  ['debugging', 'Debugging messages                (severity=7)'],
] as const;

export type TrapName = (typeof TRAP_LEVELS)[number][0];

/** The level `logging trap` has when the config does not set it: informational. */
export const DEFAULT_TRAP_LEVEL = 6;

type IosConfig = RouterConfig | SwitchConfig;

/**
 * `logging trap` when it is not informational, then each logging host. Packet Tracer writes a host
 * as `logging <ip>`, whichever form set it.
 */
export function loggingLines(config: IosConfig): string[] {
  const trap = config.loggingTrap;
  return [
    ...(trap === undefined ? [] : [`logging trap ${TRAP_LEVELS[trap]![0]}`]),
    ...(config.loggingHosts ?? []).map((host) => `logging ${host}`),
  ];
}

/** `ntp server` lines, in the order entered. IOS writes them after the `line` blocks. */
export const ntpLines = (config: IosConfig): string[] =>
  (config.ntpServers ?? []).map((server) => `ntp server ${server}`);

/** What IOS logs when a session leaves config mode, naming the line it ran on. */
export const configuredMessage = (line: SessionLine): string =>
  `%SYS-5-CONFIG_I: Configured from console by ${line.kind === 'console' ? 'console' : `vty${line.index} (${line.peer})`}`;
