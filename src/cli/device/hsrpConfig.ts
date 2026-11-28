import type { HsrpGroup } from '../../model';

/** The interface's HSRP lines in its running-config block, as IOS orders them. */
export function standbyLines(config: {
  standbyVersion?: 2;
  standby?: Partial<Record<number, HsrpGroup>>;
}): string[] {
  const lines = config.standbyVersion === 2 ? [' standby version 2'] : [];
  const groups = Object.entries(config.standby ?? {}).sort(([a], [b]) => Number(a) - Number(b));
  for (const [number, group] of groups) {
    if (!group) continue;
    const prefix = number === '0' ? ' standby' : ` standby ${number}`;
    if (group.ip) lines.push(`${prefix} ip ${group.ip}`);
    if (group.timers) lines.push(`${prefix} timers ${group.timers.hello} ${group.timers.hold}`);
    if (group.priority !== undefined) lines.push(`${prefix} priority ${group.priority}`);
    if (group.preempt) lines.push(`${prefix} preempt`);
    for (const track of group.track ?? []) {
      const decrement = track.decrement === undefined ? '' : ` ${track.decrement}`;
      lines.push(`${prefix} track ${track.interface}${decrement}`);
    }
  }
  return lines;
}
