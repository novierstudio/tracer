import { describe, expect, it } from 'vitest';
import { DnsRecord, type Device, type DeviceId, type ServerServices, type Topology } from '@/model';
import { DEFAULT_INDEX_HTML } from '@/model/defaults';
import type { BrowseTarget, DnsLookup, FetchEvent } from '../api';
import { ms } from '../core/time';
import type { DnsMessage } from '../dns';
import { createEngine } from '../engine';
import type { FrameEvent, SimEvent } from '../events';
import { byteLength, httpText } from '../http';
import { createSimService } from '../service';
import { STACKS } from '../stacks';
import type { TcpSegment } from '../tcp';
import { cidr, ip, labBuilder } from '../testing';

const PAGE = '<html><body><h1>Lab web</h1></body></html>';

const SERVICES: ServerServices = {
  dns: {
    enabled: true,
    records: [DnsRecord.parse({ name: 'www.lab.local', address: '192.168.1.20' })],
  },
  http: { enabled: true, indexHtml: PAGE },
};

const withServices =
  (services: ServerServices | undefined) =>
  (device: Device): Device =>
    device.kind === 'server' ? { ...device, config: { ...device.config, services } } : device;

/** PC1 192.168.1.10, asking DNS of Server1 192.168.1.20, cabled straight to it. */
/** `null` leaves the server's services unset, or PC1 with no DNS server. */
function webLab({
  services = SERVICES as ServerServices | null,
  dns = '192.168.1.20' as string | null,
} = {}) {
  const lab = labBuilder();
  const pc = lab.host('pc', 'PC1', '192.168.1.10/24');
  const server = lab.host('server', 'Server1', '192.168.1.20/24');
  lab.edit(server, withServices(services ?? undefined));
  lab.edit(pc, (device) =>
    device.kind === 'pc'
      ? {
          ...device,
          config: {
            ...device.config,
            ipv4: {
              mode: 'static',
              address: cidr('192.168.1.10/24'),
              dns: dns ? ip(dns) : undefined,
            },
          },
        }
      : device,
  );
  lab.connect(pc, 'FastEthernet0', server, 'FastEthernet0');
  return { topology: lab.topology, pc, server };
}

function simulate(topology: Topology, seed = 1) {
  const engine = createEngine({ seed, stacks: STACKS, linkDelay: ms(1) });
  const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
  sim.load(topology);
  const settle = () => {
    while (engine.nextTime() !== undefined && engine.now < 60_000) engine.step();
  };
  const browse = (device: DeviceId, target: BrowseTarget) => {
    const events: FetchEvent[] = [];
    const started = sim.browse(device, target, (event) => events.push(event));
    if (!started.ok) throw new Error(started.error);
    settle();
    return events;
  };
  const resolve = (device: DeviceId, name: string, server?: string) => {
    const heard: DnsLookup[] = [];
    const started = sim.resolve(device, name, server ? ip(server) : undefined, (lookup) =>
      heard.push(lookup),
    );
    if (!started.ok) throw new Error(started.error);
    settle();
    return heard;
  };
  return { engine, sim, browse, resolve };
}

const url = (host: string, path = '/', port = 80): BrowseTarget => ({ host, port, path });

const packetOf = ({ frame }: FrameEvent) =>
  frame.kind === 'ethernet' && frame.payload.kind === 'ipv4' ? frame.payload : undefined;

const frames = (events: readonly SimEvent[]) =>
  events.filter((event): event is FrameEvent => event.kind === 'frame');

/** Each TCP segment on the wire, in order, with who sent it. */
function segments(events: readonly SimEvent[], server: DeviceId) {
  return frames(events).flatMap((event) => {
    const payload = packetOf(event)?.payload;
    return payload?.kind === 'tcp'
      ? [{ from: event.from.device === server ? 'server' : 'client', segment: payload }]
      : [];
  });
}

const dnsMessages = (events: readonly SimEvent[]): DnsMessage[] =>
  frames(events).flatMap((event) => {
    const payload = packetOf(event)?.payload;
    return payload?.kind === 'udp' && payload.payload.kind === 'dns' ? [payload.payload] : [];
  });

const flagNames = ({ flags }: TcpSegment) =>
  (['syn', 'fin', 'rst', 'psh', 'ack'] as const).filter((flag) => flags[flag]).join('+');

const dataLength = (segment: TcpSegment) =>
  segment.payload?.kind === 'http' ? byteLength(httpText(segment.payload)) : 0;

/** What the protocol a frame carries shows as: the layer a student steps through. */
function protocol(event: FrameEvent): string {
  const packet = packetOf(event);
  if (!packet) return event.frame.kind === 'ethernet' ? event.frame.payload.kind : 'other';
  const { payload } = packet;
  if (payload.kind === 'udp') return payload.payload.kind;
  if (payload.kind === 'tcp') return payload.payload ? 'http' : 'tcp';
  return payload.kind;
}

describe('TCP', () => {
  it('opens with a 3-way handshake, carries the request and response, and closes with FINs', () => {
    const { topology, pc, server } = webLab();
    const { engine, browse } = simulate(topology);

    browse(pc, url('192.168.1.20'));

    const wire = segments(engine.log.since(0 as never), server);
    expect(wire.map(({ from, segment }) => `${from} ${flagNames(segment)}`)).toEqual([
      'client syn',
      'server syn+ack',
      'client ack',
      'client psh+ack',
      'server psh+ack',
      'server fin+ack',
      'client ack',
      'client fin+ack',
      'server ack',
    ]);
    const [syn, synAck, ack, get, ok, serverFin, okAck, clientFin, lastAck] = wire.map(
      ({ segment }) => segment,
    ) as TcpSegment[] as [TcpSegment, ...TcpSegment[]] & TcpSegment[];
    const plus = (seq: number, n: number) => (seq + n) >>> 0;
    // The SYN and the FIN each take one sequence number; data takes one per byte.
    expect(synAck!.ack).toBe(plus(syn.seq, 1));
    expect([ack!.seq, ack!.ack]).toEqual([plus(syn.seq, 1), plus(synAck!.seq, 1)]);
    expect(get!.seq).toBe(plus(syn.seq, 1));
    expect(ok!.seq).toBe(plus(synAck!.seq, 1));
    expect(ok!.ack).toBe(plus(get!.seq, dataLength(get!)));
    expect(serverFin!.seq).toBe(plus(ok!.seq, dataLength(ok!)));
    expect(okAck!.ack).toBe(serverFin!.seq);
    expect(clientFin!.ack).toBe(plus(serverFin!.seq, 1));
    expect(lastAck!.ack).toBe(plus(clientFin!.seq, 1));
    expect(syn.srcPort).toBeGreaterThanOrEqual(49152);
    expect(syn.dstPort).toBe(80);
    expect(wire.every(({ segment }) => segment.window > 0)).toBe(true);
  });

  it('answers a SYN to a closed port with a reset, and the browser hears the refusal', () => {
    const { topology, pc, server } = webLab();
    const { engine, browse } = simulate(topology);

    const events = browse(pc, url('192.168.1.20', '/', 8080));

    const wire = segments(engine.log.since(0 as never), server);
    expect(wire.map(({ from, segment }) => `${from} ${flagNames(segment)}`)).toEqual([
      'client syn',
      'server rst+ack',
    ]);
    expect(wire[1]!.segment.ack).toBe((wire[0]!.segment.seq + 1) >>> 0);
    expect(events.at(-1)).toEqual({
      kind: 'failed',
      failure: { kind: 'refused', address: ip('192.168.1.20'), port: 8080 },
    });
  });

  it('refuses port 80 on a server whose HTTP service is off', () => {
    const off = { ...SERVICES, http: { ...SERVICES.http, enabled: false } };
    const { topology, pc } = webLab({ services: off });
    const { browse } = simulate(topology);

    expect(browse(pc, url('192.168.1.20')).at(-1)).toMatchObject({
      kind: 'failed',
      failure: { kind: 'refused' },
    });
  });

  it('times out a connection to an address nobody answers for', () => {
    const { topology, pc } = webLab();
    const { browse } = simulate(topology);

    expect(browse(pc, url('192.168.1.99')).at(-1)).toEqual({
      kind: 'failed',
      failure: { kind: 'timeout', address: ip('192.168.1.99') },
    });
  });

  it('draws its ports and sequence numbers from the run’s seed', () => {
    const run = (seed: number) => {
      const { topology, pc, server } = webLab();
      const { engine, browse } = simulate(topology, seed);
      browse(pc, url('192.168.1.20'));
      return segments(engine.log.since(0 as never), server)[0]!.segment;
    };
    expect(run(7)).toEqual(run(7));
    expect(run(7).seq).not.toBe(run(8).seq);
  });

  it('replays the same connection after a step back, and the browser hears it once', () => {
    const { topology, pc } = webLab();
    const engine = createEngine({ seed: 3, stacks: STACKS, linkDelay: ms(1) });
    const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
    sim.load(topology);
    sim.setMode('simulation');
    const heard: FetchEvent[] = [];
    sim.browse(pc, url('www.lab.local'), (event) => heard.push(event));
    const run = () => {
      const logged: string[] = [];
      for (let step = 0; step < 30; step++) {
        for (const event of frames(sim.step())) logged.push(JSON.stringify(event.frame));
      }
      return logged;
    };

    const first = run();
    while (sim.stepBack());
    const again = run();

    expect(first.length).toBeGreaterThan(10);
    expect(again).toEqual(first);
    expect(heard.filter((event) => event.kind === 'response')).toHaveLength(1);
  });
});

describe('DNS', () => {
  it('resolves a name with the host’s DNS server, as nslookup does', () => {
    const { topology, pc } = webLab();
    const { resolve } = simulate(topology);

    expect(resolve(pc, 'WWW.Lab.Local')).toEqual([
      {
        kind: 'answer',
        server: ip('192.168.1.20'),
        name: 'www.lab.local',
        address: ip('192.168.1.20'),
      },
    ]);
  });

  it('answers NXDOMAIN for a name the server has no record of', () => {
    const { topology, pc } = webLab();
    const { engine, resolve } = simulate(topology);

    expect(resolve(pc, 'mail.lab.local')).toEqual([
      { kind: 'not-found', server: ip('192.168.1.20'), name: 'mail.lab.local' },
    ]);
    expect(dnsMessages(engine.log.since(0 as never)).at(-1)).toMatchObject({
      type: 'response',
      rcode: 'name-error',
      answers: [],
    });
  });

  it('times out when the server’s DNS service is off', () => {
    const off = { ...SERVICES, dns: { ...SERVICES.dns, enabled: false } };
    const { topology, pc } = webLab({ services: off });
    const { engine, resolve } = simulate(topology);

    expect(resolve(pc, 'www.lab.local')).toEqual([{ kind: 'timeout', server: ip('192.168.1.20') }]);
    expect(dnsMessages(engine.log.since(0 as never)).map((message) => message.type)).toEqual([
      'query',
    ]);
  });

  it('says there is no server to ask when the host has none configured', () => {
    const { topology, pc } = webLab({ dns: null });
    const { resolve } = simulate(topology);

    expect(resolve(pc, 'www.lab.local')).toEqual([{ kind: 'no-server' }]);
  });

  it('asks the server named on the command line instead of the configured one', () => {
    const { topology, pc } = webLab({ dns: '192.168.1.99' });
    const { resolve } = simulate(topology);

    expect(resolve(pc, 'www.lab.local', '192.168.1.20')).toMatchObject([
      { kind: 'answer', address: ip('192.168.1.20') },
    ]);
  });
});

describe('HTTP', () => {
  it('browses by name: DNS first, then TCP, then HTTP, and the page arrives whole', () => {
    const { topology, pc } = webLab();
    const { engine, browse } = simulate(topology);

    const events = browse(pc, url('www.lab.local'));

    expect(events).toEqual([
      { kind: 'resolving', name: 'www.lab.local', server: ip('192.168.1.20') },
      { kind: 'connecting', address: ip('192.168.1.20'), port: 80 },
      {
        kind: 'response',
        address: ip('192.168.1.20'),
        response: {
          kind: 'http',
          type: 'response',
          status: 200,
          reason: 'OK',
          contentType: 'text/html',
          body: PAGE,
        },
      },
    ]);
    const order = frames(engine.log.since(0 as never))
      .map(protocol)
      .filter((name) => name !== 'arp');
    const firstOf = (name: string) => order.indexOf(name);
    expect(firstOf('dns')).toBeGreaterThanOrEqual(0);
    expect(firstOf('dns')).toBeLessThan(firstOf('tcp'));
    expect(firstOf('tcp')).toBeLessThan(firstOf('http'));
  });

  it('serves the default page on a server whose services were never set', () => {
    const { topology, pc } = webLab({ services: null });
    const { browse } = simulate(topology);

    expect(browse(pc, url('192.168.1.20', '/index.html')).at(-1)).toMatchObject({
      kind: 'response',
      response: { status: 200, body: DEFAULT_INDEX_HTML },
    });
  });

  it('answers a path it has no page for with 404', () => {
    const { topology, pc } = webLab();
    const { browse } = simulate(topology);

    expect(browse(pc, url('www.lab.local', '/missing.html')).at(-1)).toMatchObject({
      kind: 'response',
      response: { status: 404, reason: 'Not Found' },
    });
  });

  it('fails a load whose name does not resolve, without opening a connection', () => {
    const { topology, pc, server } = webLab();
    const { engine, browse } = simulate(topology);

    expect(browse(pc, url('nowhere.lab.local')).at(-1)).toEqual({
      kind: 'failed',
      failure: { kind: 'name-not-found', name: 'nowhere.lab.local', server: ip('192.168.1.20') },
    });
    expect(segments(engine.log.since(0 as never), server)).toEqual([]);
  });

  it('cancels a load when the host powers off', () => {
    const { topology, pc } = webLab();
    const { engine, sim } = simulate(topology);
    const heard: FetchEvent[] = [];
    sim.browse(pc, url('www.lab.local'), (event) => heard.push(event));
    engine.step();

    sim.load({
      ...topology,
      devices: { ...topology.devices, [pc]: { ...topology.devices[pc]!, powered: false } },
    });

    expect(heard.at(-1)).toEqual({ kind: 'failed', failure: { kind: 'cancelled' } });
  });
});
