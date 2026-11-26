import { describe, expect, it } from 'vitest';
import { applyLines, toConfigUpdate, type IosDevice } from '@/cli';
import { updateConfig, type ServerServices } from '@/model';
import { expectOk } from '@/model/testing';
import type {
  AccessList,
  AclAddress,
  AclPort,
  DeviceId,
  ExtendedAclEntry,
  RouterConfig,
  StandardAclEntry,
} from '@/model';
import type { FetchEvent, PingEvent } from '../api';
import { after, ms } from '../core/time';
import { createEngine } from '../engine';
import type { FrameEvent, SimEvent } from '../events';
import { createSimService } from '../service';
import { STACKS } from '../stacks';
import { ip, labBuilder, routedLab, STP_CONVERGED } from '../testing';
import { ACL_PROTOCOL, firstMatch, type Flow } from './acl';
import { ipModule } from './ip';
import { originate } from './output';
import { udp } from './udp';

const any: AclAddress = { address: ip('0.0.0.0'), wildcard: ip('255.255.255.255') };
const host = (address: string): AclAddress => ({ address: ip(address), wildcard: ip('0.0.0.0') });
const net = (address: string, wildcard: string): AclAddress => ({
  address: ip(address),
  wildcard: ip(wildcard),
});

const standard = (...entries: StandardAclEntry[]): AccessList => ({ type: 'standard', entries });
const extended = (...entries: ExtendedAclEntry[]): AccessList => ({ type: 'extended', entries });
const permit = (source: AclAddress): StandardAclEntry => ({
  kind: 'rule',
  action: 'permit',
  source,
});
const deny = (source: AclAddress): StandardAclEntry => ({ kind: 'rule', action: 'deny', source });

const rule = (
  action: 'permit' | 'deny',
  protocol: 'ip' | 'icmp' | 'tcp' | 'udp',
  source: AclAddress,
  destination: AclAddress,
  extra: { destinationPort?: AclPort; sourcePort?: AclPort; icmpType?: 'echo' | 'echo-reply' } = {},
): ExtendedAclEntry => ({ kind: 'rule', action, protocol, source, destination, ...extra });

const flow = (src: string, dst: string, extra: Partial<Flow> = {}): Flow => ({
  protocol: ACL_PROTOCOL.icmp,
  icmpType: 'echo-request',
  src: ip(src),
  dst: ip(dst),
  ...extra,
});
const tcp = (src: string, dst: string, dstPort: number): Flow =>
  flow(src, dst, { protocol: ACL_PROTOCOL.tcp, icmpType: undefined, srcPort: 49152, dstPort });
const udpFlow = (src: string, dst: string, dstPort: number): Flow =>
  flow(src, dst, { protocol: ACL_PROTOCOL.udp, icmpType: undefined, srcPort: 49152, dstPort });

describe('matching an access list', () => {
  it('compares only the bits where the wildcard has a 0', () => {
    const lan = standard(permit(net('192.168.1.0', '0.0.0.255')));
    expect(firstMatch(lan, flow('192.168.1.77', '8.8.8.8'))).toBe(0);
    expect(firstMatch(lan, flow('192.168.2.77', '8.8.8.8'))).toBeUndefined();

    // A wildcard need not be contiguous: 0.0.254.255 matches every odd third octet.
    const odd = standard(permit(net('10.0.1.0', '0.0.254.255')));
    expect(firstMatch(odd, flow('10.0.3.5', '8.8.8.8'))).toBe(0);
    expect(firstMatch(odd, flow('10.0.2.5', '8.8.8.8'))).toBeUndefined();
  });

  it('stops at the first entry that matches, skipping remarks', () => {
    const list = standard(
      { kind: 'remark', text: 'keep .5 out' },
      deny(host('192.168.1.5')),
      permit(net('192.168.1.0', '0.0.0.255')),
    );
    expect(firstMatch(list, flow('192.168.1.5', '8.8.8.8'))).toBe(1);
    expect(firstMatch(list, flow('192.168.1.6', '8.8.8.8'))).toBe(2);
  });

  it('matches nothing past the last entry: the implicit deny', () => {
    expect(firstMatch(standard(deny(host('10.0.0.1'))), flow('10.0.0.2', '8.8.8.8'))).toBe(
      undefined,
    );
    expect(firstMatch(standard(), flow('10.0.0.2', '8.8.8.8'))).toBeUndefined();
  });

  it('matches a TCP port rule only on TCP from the listed subnets', () => {
    const list = extended(
      rule('deny', 'tcp', net('10.1.0.0', '0.0.0.255'), net('10.2.0.0', '0.0.0.255'), {
        destinationPort: { op: 'eq', port: 80 },
      }),
      rule('permit', 'ip', any, any),
    );
    expect(firstMatch(list, tcp('10.1.0.5', '10.2.0.9', 80))).toBe(0);
    expect(firstMatch(list, tcp('10.1.0.5', '10.2.0.9', 443))).toBe(1);
    expect(firstMatch(list, flow('10.1.0.5', '10.2.0.9'))).toBe(1);
    // UDP to port 80 is not TCP, so the deny does not apply.
    expect(firstMatch(list, udpFlow('10.1.0.5', '10.2.0.9', 80))).toBe(1);
    // Nor does it apply to other subnets.
    expect(firstMatch(list, tcp('10.3.0.5', '10.2.0.9', 80))).toBe(1);
  });

  it.each<[AclPort, number, boolean]>([
    [{ op: 'eq', port: 53 }, 53, true],
    [{ op: 'eq', port: 53 }, 54, false],
    [{ op: 'neq', port: 53 }, 54, true],
    [{ op: 'neq', port: 53 }, 53, false],
    [{ op: 'gt', port: 1023 }, 1024, true],
    [{ op: 'gt', port: 1023 }, 1023, false],
    [{ op: 'lt', port: 1024 }, 1023, true],
    [{ op: 'lt', port: 1024 }, 1024, false],
    [{ op: 'range', first: 20, last: 21 }, 20, true],
    [{ op: 'range', first: 20, last: 21 }, 21, true],
    [{ op: 'range', first: 20, last: 21 }, 22, false],
  ])('matches destination port %o against %i: %s', (destinationPort, port, matches) => {
    const list = extended(rule('permit', 'udp', any, any, { destinationPort }));
    expect(firstMatch(list, udpFlow('10.0.0.1', '10.0.0.2', port)) === 0).toBe(matches);
  });

  it('matches source ports, which only TCP and UDP carry', () => {
    const list = extended(
      rule('permit', 'ip', any, any, { sourcePort: { op: 'eq', port: 49152 } }),
    );
    expect(firstMatch(list, udpFlow('10.0.0.1', '10.0.0.2', 80))).toBe(0);
    expect(firstMatch(list, flow('10.0.0.1', '10.0.0.2'))).toBeUndefined();
  });

  it('tells ICMP messages apart by type', () => {
    const list = extended(rule('permit', 'icmp', any, any, { icmpType: 'echo-reply' }));
    expect(firstMatch(list, flow('10.0.0.1', '10.0.0.2', { icmpType: 'echo-reply' }))).toBe(0);
    expect(firstMatch(list, flow('10.0.0.1', '10.0.0.2'))).toBeUndefined();
  });
});

/** routedLab with R1's config edited: PC1 192.168.1.10, R1, PC2 192.168.2.10. */
function filteredLab(edit: (config: RouterConfig) => RouterConfig) {
  const { lab, pc1, pc2, r1 } = routedLab();
  lab.edit(r1, (device) =>
    device.kind === 'router' ? { ...device, config: edit(device.config) } : device,
  );
  const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
  const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
  sim.load(lab.topology);
  engine.runUntil(STP_CONVERGED);

  const ping = (from: DeviceId, target: string) => {
    const events: PingEvent[] = [];
    sim.ping(from, ip(target), { count: 4, timeoutMs: 1000 }, (event) => events.push(event));
    while (!events.some((event) => event.kind === 'summary')) engine.step();
    return events;
  };
  /** Sends one UDP datagram from PC1 to PC2's `port` and runs until the network is quiet. */
  const sendUdp = (port: number) => {
    const mark = engine.log.lastId;
    engine.withModule(pc1, ipModule, (ctx) =>
      originate(
        ctx,
        ip('192.168.2.10'),
        udp(49152, port, { kind: 'rip', command: 'request', version: 2 }),
      ),
    );
    engine.runUntil(after(engine.now, ms(2000)));
    return engine.log.since(mark);
  };
  const hits = () =>
    engine.withModule(r1, ipModule, (ctx) => Object.fromEntries(ctx.state.aclHits));
  return { engine, ping, sendUdp, hits, pc1, pc2, r1 };
}

const withAcl =
  (
    name: string,
    list: AccessList,
    port: 'GigabitEthernet0/0' | 'GigabitEthernet0/1',
    direction: 'in' | 'out',
  ) =>
  (config: RouterConfig): RouterConfig => ({
    ...config,
    accessLists: { [name]: list },
    interfaces: {
      ...config.interfaces,
      [port]: {
        ...config.interfaces[port as never]!,
        [direction === 'in' ? 'accessGroupIn' : 'accessGroupOut']: name,
      },
    },
  });

const blockWeb = extended(
  rule('deny', 'udp', net('192.168.1.0', '0.0.0.255'), net('192.168.2.0', '0.0.0.255'), {
    destinationPort: { op: 'eq', port: 80 },
  }),
  rule('deny', 'tcp', net('192.168.1.0', '0.0.0.255'), net('192.168.2.0', '0.0.0.255'), {
    destinationPort: { op: 'eq', port: 80 },
  }),
  rule('permit', 'ip', any, any),
);

/** The UDP datagrams that reached `device`. */
const udpAt = (events: readonly SimEvent[], device: DeviceId) =>
  events.filter(
    (event) =>
      event.kind === 'frame' &&
      event.to.device === device &&
      event.frame.kind === 'ethernet' &&
      event.frame.payload.kind === 'ipv4' &&
      event.frame.payload.payload.kind === 'udp',
  );

describe('an access group in a running network', () => {
  it('drops what an inbound list denies, tells the sender, and lets ping through', () => {
    const { ping, sendUdp, hits, pc1, pc2 } = filteredLab(
      withAcl('101', blockWeb, 'GigabitEthernet0/0', 'in'),
    );

    expect(ping(pc1, '192.168.2.10').find((e) => e.kind === 'summary')).toMatchObject({
      sent: 4,
      received: 4,
    });

    const events = sendUdp(80);
    const notes = events.filter((e) => e.kind === 'note').map((e) => e.text);
    expect(notes).toContain(
      'Dropped a packet for 192.168.2.10 from 192.168.1.10: access list 101 denied it in on GigabitEthernet0/0',
    );
    // Nothing reached PC2, and PC1 heard why.
    expect(udpAt(events, pc2)).toEqual([]);
    const toPc1 = (events as FrameEvent[]).filter((e) => e.kind === 'frame' && e.to.device === pc1);
    expect(toPc1.map((e) => e.frame)).toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({
          payload: expect.objectContaining({
            type: 'destination-unreachable',
            code: 'admin-prohibited',
          }),
        }),
      }),
    );
    // Four echo requests matched the permit; the replies came in on Gi0/1, which has no list.
    expect(hits()).toEqual({ ok: true, value: { '101': [1, 0, 4] } });
  });

  it('filters outbound after routing, and lets other ports through', () => {
    const { sendUdp, hits, pc2 } = filteredLab(
      withAcl('101', blockWeb, 'GigabitEthernet0/1', 'out'),
    );

    expect(udpAt(sendUdp(80), pc2)).toEqual([]);
    expect(hits()).toEqual({ ok: true, value: { '101': [1] } });

    expect(udpAt(sendUdp(443), pc2)).toHaveLength(1);
    expect(hits()).toEqual({ ok: true, value: { '101': [1, 0, 1] } });
  });

  it('lets everything through when the access group names a list that does not exist', () => {
    const { ping, pc1 } = filteredLab((config) => ({
      ...withAcl('101', blockWeb, 'GigabitEthernet0/0', 'in')(config),
      accessLists: {},
    }));
    expect(ping(pc1, '192.168.2.10').find((e) => e.kind === 'summary')).toMatchObject({
      received: 4,
    });
  });

  it('denies a ping by the implicit deny, which counts no hit', () => {
    const onlyUdp = extended(rule('permit', 'udp', any, any));
    const { ping, hits, pc1 } = filteredLab(withAcl('110', onlyUdp, 'GigabitEthernet0/0', 'in'));

    const events = ping(pc1, '192.168.2.10');
    expect(events.filter((e) => e.kind === 'unreachable')).toHaveLength(4);
    expect(events.find((e) => e.kind === 'summary')).toMatchObject({ received: 0 });
    expect(hits()).toEqual({ ok: true, value: {} });
  });
});

const WEB: ServerServices = {
  dns: { enabled: false, records: [] },
  http: { enabled: true, indexHtml: '<h1>Web</h1>' },
};

/**
 * PC1 192.168.1.10 and a web server 192.168.2.10, each behind its own port of `gateway`: router
 * R1 with SW1 and SW2 between, or multilayer switch MLS routing between VLANs 10 and 20. The
 * gateway is configured by typing `lines`.
 */
function webLab(gateway: 'router' | 'multilayer', lines: readonly string[]) {
  const lab = labBuilder();
  const pc = lab.host('pc', 'PC1', '192.168.1.10/24', '192.168.1.1');
  const web = lab.host('server', 'Web', '192.168.2.10/24', '192.168.2.1');
  lab.edit(web, (device) =>
    device.kind === 'server' ? { ...device, config: { ...device.config, services: WEB } } : device,
  );
  let id: DeviceId;
  if (gateway === 'router') {
    const sw1 = lab.switch('SW1');
    const sw2 = lab.switch('SW2');
    id = lab.router('R1', {
      'GigabitEthernet0/0': '192.168.1.1/24',
      'GigabitEthernet0/1': '192.168.2.1/24',
    });
    lab.connect(pc, 'FastEthernet0', sw1, 'FastEthernet0/1');
    lab.connect(sw1, 'GigabitEthernet0/1', id, 'GigabitEthernet0/0');
    lab.connect(id, 'GigabitEthernet0/1', sw2, 'GigabitEthernet0/1');
    lab.connect(web, 'FastEthernet0', sw2, 'FastEthernet0/1');
  } else {
    id = lab.switch('MLS', {}, 'switch-l3-24');
    lab.connect(pc, 'FastEthernet0', id, 'FastEthernet0/1');
    lab.connect(web, 'FastEthernet0', id, 'FastEthernet0/2');
  }
  const device = lab.topology.devices[id] as IosDevice;
  const { config, errors } = applyLines(device, lines);
  expect(errors).toEqual([]);
  expect(config.unknownLines).toEqual([]);
  const topology = expectOk(
    updateConfig(lab.topology, toConfigUpdate({ ...device, config } as IosDevice)),
  );

  const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
  const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
  sim.load(topology);
  engine.runUntil(STP_CONVERGED);
  /** PC1 loads http://192.168.2.10/ and runs until the load ends. Returns how it ended. */
  const browse = () => {
    const events: FetchEvent[] = [];
    expectOk(sim.browse(pc, { host: '192.168.2.10', port: 80, path: '/' }, (e) => events.push(e)));
    while (!events.some((e) => e.kind === 'response' || e.kind === 'failed')) engine.step();
    return events.at(-1)!;
  };
  const ping = () => {
    const events: PingEvent[] = [];
    expectOk(
      sim.ping(pc, ip('192.168.2.10'), { count: 4, timeoutMs: 1000 }, (e) => events.push(e)),
    );
    while (!events.some((e) => e.kind === 'summary')) engine.step();
    return events.find((e) => e.kind === 'summary');
  };
  const hits = () =>
    expectOk(engine.withModule(id, ipModule, (ctx) => Object.fromEntries(ctx.state.aclHits)));
  return { engine, browse, ping, hits };
}

const NO_WEB = [
  'access-list 101 deny tcp 192.168.1.0 0.0.0.255 192.168.2.0 0.0.0.255 eq www',
  'access-list 101 permit ip any any',
];

describe('an extended list that blocks HTTP between two subnets', () => {
  const R1 = [
    'interface GigabitEthernet0/0',
    ' ip address 192.168.1.1 255.255.255.0',
    ' no shutdown',
    'interface GigabitEthernet0/1',
    ' ip address 192.168.2.1 255.255.255.0',
    ' no shutdown',
  ];

  it('loads the page across the router while no list is applied', () => {
    const { browse } = webLab('router', [...R1, ...NO_WEB]);
    expect(browse()).toMatchObject({ kind: 'response', response: { status: 200 } });
  });

  it('stops PC1 browsing to the server, but lets its pings through', () => {
    const { browse, ping, hits, engine } = webLab('router', [
      ...R1,
      ...NO_WEB,
      'interface GigabitEthernet0/0',
      ' ip access-group 101 in',
    ]);
    const mark = engine.log.lastId;

    expect(browse()).toMatchObject({ kind: 'failed' });
    const notes = engine.log.since(mark).flatMap((e) => (e.kind === 'note' ? [e.text] : []));
    expect(notes).toContain(
      'Dropped a packet for 192.168.2.10 from 192.168.1.10: access list 101 denied it in on GigabitEthernet0/0',
    );
    expect(ping()).toMatchObject({ sent: 4, received: 4 });
    // The SYN matched the deny; the four echo requests matched the permit.
    expect(hits()).toEqual({ '101': [1, 4] });
  });

  it('does the same on a multilayer switch routing between VLANs', () => {
    const { browse, ping } = webLab('multilayer', [
      'ip routing',
      'vlan 10',
      'vlan 20',
      'interface FastEthernet0/1',
      ' switchport access vlan 10',
      'interface FastEthernet0/2',
      ' switchport access vlan 20',
      'interface Vlan10',
      ' ip address 192.168.1.1 255.255.255.0',
      ' ip access-group 101 in',
      'interface Vlan20',
      ' ip address 192.168.2.1 255.255.255.0',
      ...NO_WEB,
    ]);
    expect(browse()).toMatchObject({ kind: 'failed' });
    expect(ping()).toMatchObject({ received: 4 });
  });
});
