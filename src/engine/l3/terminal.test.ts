import { describe, expect, it } from 'vitest';
import type { Device, DeviceId, LineConfig, RemoteProtocol, Topology } from '@/model';
import type { TerminalEvent } from '../api';
import { ms } from '../core/time';
import { createEngine } from '../engine';
import type { FrameEvent, SimEvent } from '../events';
import { createSimService } from '../service';
import { STACKS } from '../stacks';
import type { TcpSegment } from '../tcp';
import { ip, labBuilder } from '../testing';

type IosEdit = (config: Extract<Device, { kind: 'router' }>['config']) => void;

/** PC1 192.168.1.10 cabled to R1's Gi0/0 at 192.168.1.1. `edit` changes R1's config. */
function lab(edit: IosEdit = () => {}) {
  const builder = labBuilder();
  const pc = builder.host('pc', 'PC1', '192.168.1.10/24', '192.168.1.1');
  const router = builder.router('R1', { 'GigabitEthernet0/0': '192.168.1.1/24' });
  builder.edit(router, (device) => {
    if (device.kind !== 'router') return device;
    const config = structuredClone(device.config);
    edit(config);
    return { ...device, config };
  });
  builder.connect(pc, 'FastEthernet0', router, 'GigabitEthernet0/0');
  return { topology: builder.topology, pc, router };
}

const everyVty =
  (change: Partial<LineConfig>): IosEdit =>
  (config) => {
    config.lines.vty = config.lines.vty.map((line) => ({ ...line, ...change }));
  };

function simulate(topology: Topology) {
  const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
  const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
  sim.load(topology);
  const settle = (until = 60_000) => {
    while (engine.nextTime() !== undefined && engine.nextTime()! <= until) engine.step();
  };
  const open = (device: DeviceId, protocol: RemoteProtocol, target = '192.168.1.1') => {
    const events: TerminalEvent[] = [];
    const handle = sim.openTerminal(device, ip(target), protocol, (event) => events.push(event));
    if (!handle.ok) throw new Error(handle.error);
    settle(engine.now + 10_000);
    return { handle: handle.value, events };
  };
  return { engine, sim, settle, open };
}

/** The TCP segments on the wire, in order, as `from serverPort flags [line]`. */
function wire(events: readonly SimEvent[], router: DeviceId) {
  return events
    .filter((event): event is FrameEvent => event.kind === 'frame' && event.outcome === 'delivered')
    .flatMap((event) => {
      const { frame } = event;
      const packet = frame.kind === 'ethernet' && frame.payload.kind === 'ipv4' && frame.payload;
      if (!packet || packet.payload.kind !== 'tcp') return [];
      const segment: TcpSegment = packet.payload;
      const flags = (['syn', 'fin', 'rst', 'psh', 'ack'] as const).filter((f) => segment.flags[f]);
      const from = event.from.device === router ? 'R1' : 'PC1';
      const data = segment.payload?.kind === 'telnet' ? ` ${segment.payload.text}` : '';
      const port = Math.min(segment.srcPort, segment.dstPort);
      return [`${from} ${port} ${flags.join('+')}${data}`];
    });
}

describe('Telnet and SSH connections', () => {
  it('opens Telnet to port 23, carries each line, and closes from the router end', () => {
    const { topology, pc, router } = lab();
    const { engine, sim, settle, open } = simulate(topology);

    const { handle, events } = open(pc, 'telnet');
    expect(events).toEqual([{ kind: 'open', local: ip('192.168.1.10') }]);
    sim.terminalSend(handle, 'show users');
    settle(engine.now + 1000);
    sim.terminalClose(handle, router);
    settle(engine.now + 1000);

    expect(wire(engine.log.since(0 as never), router)).toEqual([
      'PC1 23 syn',
      'R1 23 syn+ack',
      'PC1 23 ack',
      'PC1 23 psh+ack show users',
      'R1 23 ack',
      'R1 23 fin+ack',
      'PC1 23 fin+ack',
      'R1 23 ack',
    ]);
    expect(events.at(-1)).toEqual({ kind: 'closed' });
  });

  it('keeps an idle session open past the TCP timeout', () => {
    const { topology, pc } = lab();
    const { engine, settle, open } = simulate(topology);
    const { events } = open(pc, 'telnet');
    settle(engine.now + 60_000);
    expect(events).toEqual([{ kind: 'open', local: ip('192.168.1.10') }]);
  });

  it('refuses Telnet when no vty line takes it, and SSH until the router has keys', () => {
    const sshOnly = lab(everyVty({ transportInput: { ssh: true, telnet: false } }));
    expect(simulate(sshOnly.topology).open(sshOnly.pc, 'telnet').events).toEqual([
      { kind: 'failed', why: 'refused' },
    ]);
    expect(simulate(sshOnly.topology).open(sshOnly.pc, 'ssh').events).toEqual([
      { kind: 'failed', why: 'refused' },
    ]);

    const keyed = lab((config) => {
      everyVty({ transportInput: { ssh: true, telnet: false } })(config);
      config.rsaModulus = 1024;
    });
    expect(simulate(keyed.topology).open(keyed.pc, 'ssh').events).toEqual([
      { kind: 'open', local: ip('192.168.1.10') },
    ]);
  });

  it('gives each session its own vty line and refuses once all are taken', () => {
    const one = lab((config) => {
      config.lines.vty = config.lines.vty.map((line, n) => ({
        ...line,
        transportInput: { ssh: false, telnet: n === 0 },
      }));
    });
    const { open } = simulate(one.topology);
    expect(open(one.pc, 'telnet').events).toEqual([{ kind: 'open', local: ip('192.168.1.10') }]);
    expect(open(one.pc, 'telnet').events).toEqual([{ kind: 'failed', why: 'refused' }]);
  });

  it('times out a host that does not answer, and a PC refuses Telnet', () => {
    const { topology, pc, router } = lab();
    const { open } = simulate(topology);
    expect(open(pc, 'telnet', '192.168.1.99').events).toEqual([{ kind: 'failed', why: 'timeout' }]);
    expect(open(router, 'telnet', '192.168.1.10').events).toEqual([
      { kind: 'failed', why: 'refused' },
    ]);
  });

  it('sends SSH lines as ciphertext of a block length', () => {
    const { topology, pc } = lab((config) => void (config.rsaModulus = 1024));
    const { engine, sim, settle, open } = simulate(topology);
    const { handle } = open(pc, 'ssh');
    sim.terminalSend(handle, 'enable');
    settle(engine.now + 1000);
    const data = engine.log
      .since(0 as never)
      .flatMap((event) =>
        event.kind === 'frame' &&
        event.frame.kind === 'ethernet' &&
        event.frame.payload.kind === 'ipv4' &&
        event.frame.payload.payload.kind === 'tcp' &&
        event.frame.payload.payload.payload
          ? [event.frame.payload.payload.payload]
          : [],
      );
    expect(data[0]).toEqual({ kind: 'ssh', bytes: 36 });
  });
});
