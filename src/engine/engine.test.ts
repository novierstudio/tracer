import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addLink,
  createLink,
  Hostname,
  renameDevice,
  updateConfig,
  type Device,
  type Link,
  type LinkSpec,
  type Topology,
} from '@/model';
import { buildLab, end, expectOk, port } from '@/model/testing';
import { ms, simTime } from './core/time';
import { createEngine, type Engine, type EngineOptions } from './engine';
import type { EventId, SimEvent } from './events';
import type { SimModule, Stacks } from './module';
import type { TopologyPatch } from './patch';
import { helloModule, listenerModule, stacksOf } from './testing';

function lab() {
  const base = buildLab();
  let topology = base.topology;
  const connect = (spec: LinkSpec): Link => {
    const link = createLink(spec, { ids: base.ids, topology });
    topology = expectOk(addLink(topology, link));
    return link;
  };
  const { pc, server, sw, r1, r2 } = base;
  const pcLink = connect({
    cable: 'straight',
    a: end(pc, 'FastEthernet0'),
    b: end(sw, 'FastEthernet0/1'),
  });
  const serverLink = connect({
    cable: 'straight',
    a: end(server, 'FastEthernet0'),
    b: end(sw, 'FastEthernet0/2'),
  });
  const routerLink = connect({
    cable: 'straight',
    a: end(r1, 'GigabitEthernet0/0'),
    b: end(sw, 'GigabitEthernet0/1'),
  });
  const serialLink = connect({
    cable: 'serial',
    a: end(r1, 'Serial0/0/0'),
    b: end(r2, 'Serial0/0/0'),
    dce: 'a',
  });
  return { ...base, topology, pcLink, serverLink, routerLink, serialLink };
}

function engineFor(stacks: Stacks, options: Partial<EngineOptions> = {}) {
  return createEngine({ seed: 7, stacks, linkDelay: ms(3), ...options });
}

const patch = (changes: Partial<TopologyPatch>): TopologyPatch => ({
  devices: {},
  links: {},
  ...changes,
});

const withPower = (device: Device, powered: boolean) =>
  patch({ devices: { [device.id]: { ...device, powered } } });

function enableRouterPorts(topology: Topology, router: Device): Topology {
  if (router.kind !== 'router') throw new Error(`${router.id} is not a router`);
  const interfaces = Object.fromEntries(
    Object.entries(router.config.interfaces).map(([name, config]) => [
      name,
      { ...config, shutdown: false },
    ]),
  );
  return expectOk(
    updateConfig(topology, {
      device: router.id,
      kind: 'router',
      config: { ...router.config, interfaces },
    }),
  );
}

const trace = (engine: Engine) => engine.log.since(0 as EventId);

const linkEvents = (events: SimEvent[]) =>
  events.flatMap((event) => (event.kind === 'link' ? [[event.link, event.up]] : []));

const frames = (events: SimEvent[]) =>
  events.flatMap((event) => (event.kind === 'frame' ? [event] : []));

const notes = (events: SimEvent[]) =>
  events.flatMap((event) => (event.kind === 'note' ? [[event.device, event.text]] : []));

describe('load', () => {
  it('brings up the links whose ends are powered and not shut down', () => {
    const { topology, pcLink, serverLink } = lab();
    const engine = engineFor(stacksOf({}));
    engine.load(topology);

    expect(engine.now).toBe(0);
    expect(linkEvents(trace(engine))).toEqual([
      [pcLink.id, true],
      [serverLink.id, true],
    ]);
  });

  it('boots the modules of powered devices only', () => {
    const { topology, pc, server, sw } = lab();
    const pcOff = {
      ...topology,
      devices: { ...topology.devices, [pc.id]: { ...pc, powered: false } },
    };
    const hello = helloModule();
    const engine = engineFor(stacksOf({ pc: [hello], server: [hello], switch: [listenerModule] }));
    engine.load(pcOff);

    const sent = frames(engine.runUntil(simTime(10)));
    expect(sent.map((event) => [event.from, event.to, event.outcome])).toEqual([
      [end(server, 'FastEthernet0'), end(sw, 'FastEthernet0/2'), 'delivered'],
    ]);
  });

  it('starts a new run each time, so loading twice replays the same trace', () => {
    const { topology } = lab();
    const engine = engineFor(stacksOf({ pc: [helloModule({ period: ms(10), jitter: ms(4) })] }));
    engine.load(topology);
    engine.runUntil(simTime(100));
    const first = trace(engine);

    engine.load(topology);
    expect(engine.now).toBe(0);
    engine.runUntil(simTime(100));
    expect(trace(engine)).toEqual(first);
  });
});

describe('a hello frame', () => {
  it('reaches the peer port after the link delay and is logged with its outcome', () => {
    const { topology, pc, sw, pcLink } = lab();
    const engine = engineFor(stacksOf({ pc: [helloModule()], switch: [listenerModule] }));
    engine.load(topology);

    expect(engine.step()).toEqual([]);
    expect(engine.now).toBe(0);
    expect(engine.nextTime()).toBe(3);

    expect(engine.step()).toEqual([
      {
        id: expect.any(Number),
        kind: 'frame',
        time: 3,
        sentAt: 0,
        link: pcLink.id,
        from: end(pc, 'FastEthernet0'),
        to: end(sw, 'FastEthernet0/1'),
        frame: { kind: 'hello', origin: pc.id, seq: 1 },
        outcome: 'delivered',
      },
      {
        id: expect.any(Number),
        kind: 'note',
        time: 3,
        device: sw.id,
        module: 'listener',
        text: `hello 1 from ${pc.id} on FastEthernet0/1`,
      },
    ]);
    expect(engine.now).toBe(3);
    expect(engine.nextTime()).toBeUndefined();
    expect(engine.step()).toEqual([]);
    expect(engine.now).toBe(3);
  });

  it('takes the configured link delay', () => {
    const engine = engineFor(stacksOf({ pc: [helloModule()] }), { linkDelay: ms(0.25) });
    engine.load(lab().topology);

    expect(frames(engine.runUntil(simTime(1))).map((event) => event.time)).toEqual([0.25]);
  });
});

describe('runUntil', () => {
  it('runs events up to and including the time, then moves the clock there', () => {
    const engine = engineFor(stacksOf({ pc: [helloModule()], switch: [listenerModule] }));
    engine.load(lab().topology);

    expect(engine.runUntil(simTime(2.5))).toEqual([]);
    expect(engine.now).toBe(2.5);
    expect(engine.nextTime()).toBe(3);

    expect(engine.runUntil(simTime(3)).map((event) => event.kind)).toEqual(['frame', 'note']);
    expect(engine.now).toBe(3);
  });

  it('never moves the clock backwards', () => {
    const engine = engineFor(stacksOf({}));
    engine.load(lab().topology);
    engine.runUntil(simTime(50));

    expect(engine.runUntil(simTime(10))).toEqual([]);
    expect(engine.now).toBe(50);
  });

  it('runs events that other events schedule for the same time, in the order scheduled', () => {
    const { topology, pc, server, sw, r1 } = lab();
    const hello = helloModule();
    const engine = engineFor(stacksOf({ switch: [hello], pc: [hello] }), { linkDelay: ms(0) });
    engine.load(topology);

    const sent = frames(engine.runUntil(simTime(0)));
    expect(sent.map((event) => [event.from.device, event.to.device, event.outcome])).toEqual([
      [sw.id, r1.id, 'link-down'],
      [sw.id, pc.id, 'delivered'],
      [sw.id, server.id, 'delivered'],
      [pc.id, sw.id, 'delivered'],
    ]);
    expect(sent.every((event) => event.time === 0)).toBe(true);
  });
});

describe('when a link is down', () => {
  it('drops a frame sent toward a powered-off device', () => {
    const { topology, pc, sw, pcLink } = lab();
    const engine = engineFor(stacksOf({ pc: [helloModule()], switch: [listenerModule] }));
    engine.load(topology);
    engine.applyPatch(withPower(sw, false));

    const events = engine.runUntil(simTime(10));
    expect(frames(events)).toMatchObject([
      { link: pcLink.id, time: 0, sentAt: 0, from: end(pc, 'FastEthernet0'), outcome: 'link-down' },
    ]);
    expect(notes(events)).toEqual([]);
  });

  it('drops a frame on a shut-down port, and delivers once the port is enabled', () => {
    const { topology, r1, sw, routerLink, serialLink } = lab();
    const engine = engineFor(
      stacksOf({ router: [helloModule({ period: ms(10) })], switch: [listenerModule] }),
    );
    engine.load(topology);

    const shut = frames(engine.runUntil(simTime(5)));
    expect(shut.map((event) => [event.link, event.outcome])).toEqual([
      [routerLink.id, 'link-down'],
      [serialLink.id, 'link-down'],
      [serialLink.id, 'link-down'],
    ]);

    const mark = engine.log.lastId;
    const enabled = enableRouterPorts(topology, r1).devices[r1.id]!;
    engine.applyPatch(patch({ devices: { [r1.id]: enabled } }));
    const changes = engine.log.since(mark);
    expect(linkEvents(changes)).toEqual([[routerLink.id, true]]);
    expect(notes(changes)).toEqual([
      [r1.id, 'GigabitEthernet0/0 up'],
      [sw.id, 'GigabitEthernet0/1 up'],
      [r1.id, 'config changed'],
    ]);

    const overRouterLink = frames(engine.runUntil(simTime(13))).filter(
      (event) => event.link === routerLink.id,
    );
    expect(overRouterLink).toMatchObject([{ sentAt: 10, time: 13, outcome: 'delivered' }]);
  });

  it('takes a link down when a port at either end is shut down, and up when it is enabled', () => {
    const { topology, sw, pcLink } = lab();
    if (sw.kind !== 'switch') throw new Error('SW1 is not a switch');
    const engine = engineFor(stacksOf({}));
    engine.load(topology);
    const withFa01 = (shutdown: boolean) => {
      const fa01 = port('FastEthernet0/1');
      const interfaces = {
        ...sw.config.interfaces,
        [fa01]: { ...sw.config.interfaces[fa01]!, shutdown },
      };
      return patch({ devices: { [sw.id]: { ...sw, config: { ...sw.config, interfaces } } } });
    };
    const mark = engine.log.lastId;

    engine.applyPatch(withFa01(true));
    engine.applyPatch(withFa01(false));

    expect(linkEvents(engine.log.since(mark))).toEqual([
      [pcLink.id, false],
      [pcLink.id, true],
    ]);
  });

  it('keeps a link down when its cable does not fit the ports', () => {
    const { topology, pcLink } = lab();
    const engine = engineFor(stacksOf({}));
    const serialOnCopper: Link = { ...pcLink, cable: 'serial', dce: 'a' };
    engine.load({ ...topology, links: { ...topology.links, [pcLink.id]: serialOnCopper } });

    expect(linkEvents(trace(engine)).filter(([link]) => link === pcLink.id)).toEqual([]);
  });

  it('drops a frame in flight when its link is deleted', () => {
    const { topology, pc, sw, pcLink } = lab();
    const engine = engineFor(stacksOf({ pc: [helloModule()], switch: [listenerModule] }));
    engine.load(topology);
    engine.step();

    const mark = engine.log.lastId;
    engine.applyPatch(patch({ links: { [pcLink.id]: null } }));
    expect(linkEvents(engine.log.since(mark))).toEqual([[pcLink.id, false]]);
    expect(notes(engine.log.since(mark))).toEqual([
      [pc.id, 'FastEthernet0 down'],
      [sw.id, 'FastEthernet0/1 down'],
    ]);

    const events = engine.step();
    expect(frames(events)).toMatchObject([{ link: pcLink.id, time: 3, outcome: 'link-down' }]);
    expect(notes(events)).toEqual([]);
  });

  it('drops a frame in flight when the link flaps, even if it is back up on arrival', () => {
    const { topology, sw } = lab();
    const engine = engineFor(stacksOf({ pc: [helloModule()], switch: [listenerModule] }));
    engine.load(topology);
    engine.step();

    engine.applyPatch(withPower(sw, false));
    engine.applyPatch(withPower(sw, true));
    const events = engine.runUntil(simTime(3));

    expect(frames(events).map((event) => event.outcome)).toEqual(['link-down']);
    expect(notes(events)).toEqual([]);
  });
});

describe('applyPatch', () => {
  it('stops a device that powers off and boots it fresh when it powers on', () => {
    const { topology, pc, sw, pcLink } = lab();
    const engine = engineFor(
      stacksOf({ pc: [helloModule({ period: ms(10) })], switch: [listenerModule] }),
    );
    engine.load(topology);
    engine.runUntil(simTime(25));
    const mark = engine.log.lastId;

    engine.applyPatch(withPower(pc, false));
    expect(engine.runUntil(simTime(100))).toEqual([]);
    engine.applyPatch(withPower(pc, true));
    engine.runUntil(simTime(103));

    const events = engine.log.since(mark);
    expect(linkEvents(events)).toEqual([
      [pcLink.id, false],
      [pcLink.id, true],
    ]);
    expect(notes(events)).toEqual([
      [sw.id, 'FastEthernet0/1 down'],
      [sw.id, 'FastEthernet0/1 up'],
      [sw.id, `hello 1 from ${pc.id} on FastEthernet0/1`],
    ]);
  });

  it('updates every link in a patch before telling modules about any of them', () => {
    const { topology, pc, server, sw, serverLink } = lab();
    const relay: SimModule<null> = {
      id: 'relay',
      init: () => null,
      onLinkChange: (ctx, from, up) => {
        if (up && from === port('FastEthernet0/1')) {
          ctx.send(port('FastEthernet0/2'), { kind: 'hello', origin: sw.id, seq: 1 });
        }
      },
    };
    const off = (device: Device) => ({ ...device, powered: false });
    const engine = engineFor(stacksOf({ switch: [relay], server: [listenerModule] }));
    engine.load({
      ...topology,
      devices: { ...topology.devices, [pc.id]: off(pc), [server.id]: off(server) },
    });

    engine.applyPatch(patch({ devices: { [pc.id]: pc, [server.id]: server } }));

    expect(frames(engine.runUntil(simTime(10)))).toMatchObject([
      { link: serverLink.id, outcome: 'delivered' },
    ]);
  });

  it('tells the modules of a running device that its config changed', () => {
    const { topology, sw } = lab();
    const engine = engineFor(stacksOf({ switch: [listenerModule] }));
    engine.load(topology);
    const mark = engine.log.lastId;

    const renamed = expectOk(
      renameDevice(topology, { device: sw.id, hostname: Hostname.parse('Core') }),
    );
    engine.applyPatch(patch({ devices: { [sw.id]: renamed.devices[sw.id]! } }));

    expect(notes(engine.log.since(mark))).toEqual([[sw.id, 'config changed']]);
  });

  it('reaches the same link state however many times a patch is applied', () => {
    const { topology, sw, pcLink, serverLink } = lab();
    const engine = engineFor(stacksOf({}));
    engine.load(topology);
    const mark = engine.log.lastId;

    const switchOff = withPower(sw, false);
    engine.applyPatch(switchOff);
    engine.applyPatch(switchOff);
    const samePcLink = patch({ links: { [pcLink.id]: pcLink } });
    engine.applyPatch(samePcLink);
    engine.applyPatch(samePcLink);

    expect(linkEvents(engine.log.since(mark))).toEqual([
      [pcLink.id, false],
      [serverLink.id, false],
    ]);
  });

  it('boots a device that is added and brings up its new link', () => {
    const { topology, server, serverLink, pcLink } = lab();
    const devices = { ...topology.devices };
    delete devices[server.id];
    const links = { ...topology.links };
    delete links[serverLink.id];
    const engine = engineFor(stacksOf({ server: [helloModule()] }));
    engine.load({ ...topology, devices, links });
    expect(engine.nextTime()).toBeUndefined();

    engine.applyPatch(
      patch({ devices: { [server.id]: server }, links: { [serverLink.id]: serverLink } }),
    );
    const sent = frames(engine.runUntil(simTime(5)));

    expect(linkEvents(trace(engine))).toEqual([
      [pcLink.id, true],
      [serverLink.id, true],
    ]);
    expect(sent.map((event) => [event.from, event.outcome])).toEqual([
      [end(server, 'FastEthernet0'), 'delivered'],
    ]);
  });
});

describe('module timers', () => {
  it('fire once per key: setting a key again replaces it, and clearing it cancels it', () => {
    const { topology, pc } = lab();
    const timers: SimModule<null> = {
      id: 'timers',
      init: (ctx) => {
        ctx.setTimer('retry', ms(5));
        ctx.setTimer('retry', ms(8));
        ctx.setTimer('expire', ms(1));
        ctx.clearTimer('expire');
        ctx.setTimer('tick', ms(2));
        return null;
      },
      onTimer: (ctx, key) => ctx.note(`${key} at ${ctx.now}`),
    };
    const engine = engineFor(stacksOf({ pc: [timers] }));
    engine.load(topology);

    expect(notes(engine.runUntil(simTime(20)))).toEqual([
      [pc.id, 'tick at 2'],
      [pc.id, 'retry at 8'],
    ]);
  });
});

describe('withModule', () => {
  const counter: SimModule<{ hits: number }> = {
    id: 'counter',
    init: () => ({ hits: 0 }),
    onStop: (ctx) => ctx.note(`stopped after ${ctx.state.hits}`),
  };

  it("runs against the module's own state and sends as the device, at the current time", () => {
    const { topology, pc, sw, pcLink } = lab();
    const engine = engineFor(stacksOf({ pc: [counter], switch: [listenerModule] }));
    engine.load(topology);
    engine.runUntil(simTime(10));

    const hits = engine.withModule(pc.id, counter, (ctx) => {
      ctx.send(port('FastEthernet0'), { kind: 'hello', origin: pc.id, seq: 1 });
      return ++ctx.state.hits;
    });

    expect(hits).toEqual({ ok: true, value: 1 });
    expect(engine.withModule(pc.id, counter, (ctx) => ctx.state.hits)).toEqual({
      ok: true,
      value: 1,
    });
    expect(frames(engine.runUntil(simTime(20)))).toMatchObject([
      { link: pcLink.id, sentAt: 10, to: end(sw, 'FastEthernet0/1'), outcome: 'delivered' },
    ]);
  });

  it('says why a device cannot run the module', () => {
    const { topology, pc, server, sw } = lab();
    const engine = engineFor(stacksOf({ pc: [counter], server: [counter] }));
    engine.load(topology);
    engine.applyPatch(withPower(server, false));
    const run = (id: Device['id']) => engine.withModule(id, counter, () => 'ran');

    expect(run(pc.id)).toEqual({ ok: true, value: 'ran' });
    expect(run(server.id)).toEqual({ ok: false, error: 'powered-off' });
    expect(run(sw.id)).toEqual({ ok: false, error: 'unsupported' });
    expect(run('dev_missing' as Device['id'])).toEqual({ ok: false, error: 'unknown-device' });
  });

  it('lets a module settle its work when its device powers off', () => {
    const { topology, pc } = lab();
    const engine = engineFor(stacksOf({ pc: [counter] }));
    engine.load(topology);
    engine.withModule(pc.id, counter, (ctx) => (ctx.state.hits = 2));

    engine.applyPatch(withPower(pc, false));
    expect(notes(trace(engine))).toEqual([[pc.id, 'stopped after 2']]);
  });
});

describe('a port with no cable', () => {
  it('sends nothing, while the same device still sends on its cabled port', () => {
    const { topology, r2 } = lab();
    const engine = engineFor(stacksOf({ router: [helloModule()] }));
    engine.load(enableRouterPorts(topology, r2));

    const fromR2 = frames(engine.runUntil(simTime(10))).filter(
      (event) => event.from.device === r2.id,
    );
    expect(fromR2.map((event) => event.from.port)).toEqual([port('Serial0/0/0')]);
  });
});

describe('determinism', () => {
  afterEach(() => vi.restoreAllMocks());

  function run(seed: number) {
    const { topology, r1, r2 } = lab();
    const hello = helloModule({ period: ms(10), jitter: ms(5) });
    const engine = createEngine({
      seed,
      stacks: stacksOf({
        router: [hello],
        switch: [hello, listenerModule],
        pc: [hello],
        server: [hello],
      }),
      linkDelay: ms(1),
    });
    engine.load(enableRouterPorts(enableRouterPorts(topology, r1), r2));
    engine.runUntil(simTime(500));
    return trace(engine);
  }

  it('gives the same trace for the same topology, seed and inputs', () => {
    const clocks = [vi.spyOn(Math, 'random'), vi.spyOn(Date, 'now'), vi.spyOn(performance, 'now')];

    const first = run(1);
    const second = run(1);

    expect(frames(first).length).toBeGreaterThan(200);
    expect(second).toEqual(first);
    for (const clock of clocks) expect(clock).not.toHaveBeenCalled();
  });

  it('gives a different trace for a different seed', () => {
    expect(run(2)).not.toEqual(run(1));
  });
});
