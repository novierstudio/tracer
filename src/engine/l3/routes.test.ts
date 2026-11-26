import { describe, expect, it } from 'vitest';
import type { PingEvent } from '../api';
import { ms } from '../core/time';
import { createEngine } from '../engine';
import type { SimModule } from '../module';
import { createSimService } from '../service';
import { cidr, ip, labBuilder, stacksOf, staticRoute } from '../testing';
import { ipModule } from './ip';
import { ipInterfaces } from './interfaces';
import { routingTable, type LearnedRoute } from './routes';

const learned = (
  source: LearnedRoute['source'],
  prefix: string,
  via: string,
  metric: number,
  iface = 'GigabitEthernet0/1',
): LearnedRoute => ({
  source,
  prefix: cidr(prefix),
  distance: source === 'rip' ? 120 : 110,
  metric,
  via: ip(via),
  interface: iface as LearnedRoute['interface'],
  ageMs: 0,
});

/** R1 with Gi0/0 on 10.0.1.0/24, Gi0/1 on 10.0.12.0/24 and Gi0/2 on 10.0.13.0/24, all up. */
function r1(staticRoutes = [] as ReturnType<typeof staticRoute>[]) {
  const lab = labBuilder();
  const id = lab.router(
    'R1',
    {
      'GigabitEthernet0/0': '10.0.1.1/24',
      'GigabitEthernet0/1': '10.0.12.1/24',
      'GigabitEthernet0/2': '10.0.13.1/24',
    },
    staticRoutes,
  );
  const device = lab.device(id);
  return { device, interfaces: ipInterfaces(device, () => true, undefined) };
}

const toward = (routes: ReturnType<typeof routingTable>, prefix: string) =>
  routes.filter((route) => `${route.prefix.address}/${route.prefix.prefixLength}` === prefix);

describe('routingTable', () => {
  it('installs the source with the lowest administrative distance: static, then OSPF, then RIP', () => {
    const { device, interfaces } = r1([staticRoute('192.168.9.0/24', '10.0.13.3')]);
    const offers = [
      learned('rip', '192.168.9.0/24', '10.0.12.2', 1),
      learned('ospf', '192.168.9.0/24', '10.0.12.2', 20),
      learned('rip', '192.168.8.0/24', '10.0.12.2', 1),
      learned('ospf', '192.168.8.0/24', '10.0.12.2', 20),
      learned('rip', '192.168.7.0/24', '10.0.12.2', 1),
    ];

    const table = routingTable(device, interfaces, undefined, offers);

    expect(toward(table, '192.168.9.0/24')).toMatchObject([{ source: 'static', distance: 1 }]);
    expect(toward(table, '192.168.8.0/24')).toMatchObject([{ source: 'ospf', metric: 20 }]);
    expect(toward(table, '192.168.7.0/24')).toMatchObject([{ source: 'rip', metric: 1 }]);
  });

  it('keeps the lowest metric, with up to four equal paths ordered by next hop', () => {
    const { device, interfaces } = r1();
    const offers = [
      learned('ospf', '192.168.9.0/24', '10.0.13.3', 2, 'GigabitEthernet0/2'),
      learned('ospf', '192.168.9.0/24', '10.0.12.2', 2),
      learned('ospf', '192.168.9.0/24', '10.0.12.9', 3),
    ];

    const table = routingTable(device, interfaces, undefined, offers);

    expect(toward(table, '192.168.9.0/24').map((route) => 'via' in route && route.via)).toEqual([
      '10.0.12.2',
      '10.0.13.3',
    ]);
  });

  it('installs a floating static route only once the route in front of it is gone', () => {
    const floating = { ...staticRoute('192.168.9.0/24', '10.0.13.3'), distance: 200 };
    const { device, interfaces } = r1([floating]);
    const ospf = learned('ospf', '192.168.9.0/24', '10.0.12.2', 2);

    expect(
      toward(routingTable(device, interfaces, undefined, [ospf]), '192.168.9.0/24'),
    ).toMatchObject([{ source: 'ospf' }]);
    expect(toward(routingTable(device, interfaces, undefined, []), '192.168.9.0/24')).toMatchObject(
      [{ source: 'static', distance: 200 }],
    );
  });

  it('drops a learned route out of an interface that is down', () => {
    const { device } = r1();
    const up = ipInterfaces(device, (port) => port !== 'GigabitEthernet0/1', undefined);

    const table = routingTable(device, up, undefined, [
      learned('rip', '192.168.9.0/24', '10.0.12.2', 1),
    ]);

    expect(toward(table, '192.168.9.0/24')).toEqual([]);
  });
});

/** Offers fixed routes on every device whose hostname is a key, as a routing protocol would. */
const offering = (routes: Record<string, LearnedRoute[]>): SimModule<null> => ({
  id: 'offering',
  init: () => null,
  routes: (ctx) => routes[ctx.device.config.hostname] ?? [],
});

describe('forwarding through learned routes', () => {
  it('reaches a network only a module offers a route to', () => {
    const lab = labBuilder();
    const pc1 = lab.host('pc', 'PC1', '192.168.1.10/24', '192.168.1.1');
    const pc2 = lab.host('pc', 'PC2', '192.168.2.10/24', '192.168.2.1');
    const a = lab.router('R1', {
      'GigabitEthernet0/0': '192.168.1.1/24',
      'GigabitEthernet0/1': '10.0.12.1/30',
    });
    const b = lab.router('R2', {
      'GigabitEthernet0/0': '192.168.2.1/24',
      'GigabitEthernet0/1': '10.0.12.2/30',
    });
    lab.connect(pc1, 'FastEthernet0', a, 'GigabitEthernet0/0');
    lab.connect(a, 'GigabitEthernet0/1', b, 'GigabitEthernet0/1');
    lab.connect(b, 'GigabitEthernet0/0', pc2, 'FastEthernet0');
    const module = offering({
      R1: [learned('ospf', '192.168.2.0/24', '10.0.12.2', 2)],
      R2: [learned('rip', '192.168.1.0/24', '10.0.12.1', 1)],
    });
    const engine = createEngine({
      seed: 1,
      stacks: stacksOf({ router: [ipModule, module], pc: [ipModule] }),
      linkDelay: ms(1),
    });
    const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
    sim.load(lab.topology);

    const events: PingEvent[] = [];
    const options = { count: 2, timeoutMs: 1000 };
    sim.ping(pc1, ip('192.168.2.10'), options, (event) => events.push(event));
    while (!events.some((event) => event.kind === 'summary') && engine.nextTime() !== undefined) {
      engine.step();
    }

    expect(events.at(-1)).toMatchObject({ kind: 'summary', sent: 2, received: 2 });
    const routes = sim.routes(a);
    expect(routes.ok && toward(routes.value, '192.168.2.0/24')).toMatchObject([
      { source: 'ospf', via: '10.0.12.2', interface: 'GigabitEthernet0/1' },
    ]);
  });
});
