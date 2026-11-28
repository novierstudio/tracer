import { serverServices } from '@/model/defaults';
import { APP_PORT, SYSLOG_FACILITY, type SyslogMessage } from '../apps';
import { ms } from '../core/time';
import type { Ipv4Packet, UdpDatagram } from '../pdu';
import { clockOf } from './appState';
import { timerKey, type IpContext } from './context';
import { originate } from './output';
import { udp } from './udp';

/** The level `logging trap` sends up to unless the config says otherwise: 6, informational. */
export const DEFAULT_TRAP = 6;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/**
 * IOS's log timestamp, `service timestamps log datetime msec`: `*Mar  1 00:02:13.142`. The `*`
 * says the clock was never set.
 */
export function logTimestamp(time: number, synced: boolean): string {
  const date = new Date(time);
  const day = String(date.getUTCDate()).padStart(2, ' ');
  const clock = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}`;
  return `${synced ? '' : '*'}${MONTHS[date.getUTCMonth()]} ${day} ${clock}`;
}

/** The severity in a message's `%FACILITY-N-MNEMONIC` tag, or informational without one. */
export function severityOf(text: string): number {
  const level = /^%[A-Z0-9_]+-(\d)-/.exec(text)?.[1];
  return level === undefined ? DEFAULT_TRAP : Number(level);
}

const sendKey = timerKey({ kind: 'app', name: 'syslog' });

/**
 * The device logged a console message. A router or switch with `logging host`s queues it for
 * them when its severity is within `logging trap`, and sends it on the next tick, once whatever
 * logged it has settled.
 */
export function onConsoleMessage(ctx: IpContext, text: string) {
  const { device } = ctx;
  if (device.kind !== 'router' && device.kind !== 'switch') return;
  if (!device.config.loggingHosts?.length) return;
  if (severityOf(text) > (device.config.loggingTrap ?? DEFAULT_TRAP)) return;
  ctx.state.apps.syslogQueue.push(text);
  ctx.setTimer(sendKey, ms(0));
}

/** Sends every queued message to every logging host, stamped with the device's clock. */
export function onSyslogTimer(ctx: IpContext) {
  const { device } = ctx;
  const queued = ctx.state.apps.syslogQueue.splice(0);
  if (device.kind !== 'router' && device.kind !== 'switch') return;
  const { time, synced } = clockOf(ctx);
  for (const text of queued) {
    const message: SyslogMessage = {
      kind: 'syslog',
      facility: SYSLOG_FACILITY,
      severity: severityOf(text),
      text: `${logTimestamp(time, synced)}: ${text}`,
    };
    for (const host of device.config.loggingHosts ?? []) {
      originate(ctx, host, udp(APP_PORT.syslog, APP_PORT.syslog, message));
    }
  }
}

/** A syslog message on port 514. A server with syslog on logs it, with the address it came from. */
export function onSyslogMessage(ctx: IpContext, packet: Ipv4Packet, datagram: UdpDatagram) {
  const message = datagram.payload;
  if (message.kind !== 'syslog' || ctx.device.kind !== 'server') return;
  if (!serverServices(ctx.device.config).syslog.enabled) return;
  const split = message.text.indexOf(': %');
  ctx.state.apps.syslog.push(
    split < 0
      ? { time: '', host: packet.src, message: message.text }
      : {
          time: message.text.slice(0, split),
          host: packet.src,
          message: message.text.slice(split + 2),
        },
  );
}
