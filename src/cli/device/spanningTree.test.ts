import { describe, expect, it } from 'vitest';
import type { SpanningTreeVlan } from '../../engine/api';
import { ms } from '../../engine/core/time';
import { createEngine } from '../../engine/engine';
import { createSimService } from '../../engine/service';
import { STACKS } from '../../engine/stacks';
import { labBuilder, STP_CONVERGED } from '../../engine/testing';
import type { DeviceId, MacAddress, PortId, VlanId } from '../../model';
import type { SwitchDevice } from './context';
import { applyLines, withBlankConfig } from './session';
import { runningConfig } from './show';
import { showSpanningTree } from './showSpanningTree';
import { consoleOn, switchDevice } from './testing';

const ENTER = ['enable', 'configure terminal'];

const configured = (lines: readonly string[]) => {
  const c = consoleOn(switchDevice());
  const output = c.runAll([...ENTER, ...lines]);
  return { c, output, config: c.device.config };
};

/** Runs a show command and answers its spanning tree query, as a terminal does. */
function showWith(line: string, answer: readonly SpanningTreeVlan[]) {
  const c = consoleOn(switchDevice());
  c.runAll(['enable']);
  const { output, query } = c.session.run(c.device, line);
  if (query?.kind !== 'spanningTree') throw new Error(`${line} asked for ${query?.kind}`);
  return { live: query.render(answer), output };
}

const mac = (text: string) => text as MacAddress;
const port = (text: string) => text as PortId;

const VLAN1_ROOT: SpanningTreeVlan = {
  vlan: 1 as VlanId,
  root: { priority: 32769, mac: mac('02:00:00:00:00:11') },
  rootCost: 0,
  rootPort: undefined,
  bridge: { priority: 32769, mac: mac('02:00:00:00:00:11') },
  times: { hello: 2, maxAge: 8, forwardDelay: 2 },
  bridgeTimes: { hello: 2, maxAge: 8, forwardDelay: 2 },
  agingTime: 300,
  ports: [
    {
      port: port('FastEthernet0/1'),
      id: { priority: 128, number: 1 },
      role: 'designated',
      state: 'forwarding',
      cost: 19,
      edge: true,
    },
    {
      port: port('GigabitEthernet0/1'),
      id: { priority: 128, number: 25 },
      role: 'designated',
      state: 'listening',
      cost: 4,
      edge: false,
    },
  ],
};

const VLAN10_BLOCKING: SpanningTreeVlan = {
  vlan: 10 as VlanId,
  root: { priority: 24586, mac: mac('02:00:00:00:00:21') },
  rootCost: 4,
  rootPort: { port: port('GigabitEthernet0/1'), id: { priority: 128, number: 25 } },
  bridge: { priority: 32778, mac: mac('02:00:00:00:00:11') },
  // A root on the IOS timers that this bridge, set to fast, has not become.
  times: { hello: 2, maxAge: 20, forwardDelay: 15 },
  bridgeTimes: { hello: 2, maxAge: 8, forwardDelay: 2 },
  agingTime: 15,
  ports: [
    {
      port: port('GigabitEthernet0/1'),
      id: { priority: 128, number: 25 },
      role: 'root',
      state: 'forwarding',
      cost: 4,
      edge: false,
    },
    {
      port: port('GigabitEthernet0/2'),
      id: { priority: 128, number: 26 },
      role: 'alternate',
      state: 'blocking',
      cost: 4,
      edge: false,
    },
  ],
};

describe('show spanning-tree', () => {
  it('prints each VLAN as IOS does, root bridge first', () => {
    const { live } = showWith('show spanning-tree', [VLAN1_ROOT, VLAN10_BLOCKING]);

    expect(live).toEqual([
      'VLAN0001',
      '  Spanning tree enabled protocol ieee',
      '  Root ID    Priority    32769',
      '             Address     0200.0000.0011',
      '             This bridge is the root',
      '             Hello Time  2 sec  Max Age 8 sec  Forward Delay 2 sec',
      '',
      '  Bridge ID  Priority    32769  (priority 32768 sys-id-ext 1)',
      '             Address     0200.0000.0011',
      '             Hello Time  2 sec  Max Age 8 sec  Forward Delay 2 sec',
      '             Aging Time  300 sec',
      '',
      'Interface        Role Sts Cost      Prio.Nbr Type',
      '---------------- ---- --- --------- -------- --------------------------------',
      'Fa0/1            Desg FWD 19        128.1    P2p Edge',
      'Gi0/1            Desg LIS 4         128.25   P2p',
      '',
      'VLAN0010',
      '  Spanning tree enabled protocol ieee',
      '  Root ID    Priority    24586',
      '             Address     0200.0000.0021',
      '             Cost        4',
      '             Port        25(GigabitEthernet0/1)',
      '             Hello Time  2 sec  Max Age 20 sec  Forward Delay 15 sec',
      '',
      '  Bridge ID  Priority    32778  (priority 32768 sys-id-ext 10)',
      '             Address     0200.0000.0011',
      '             Hello Time  2 sec  Max Age 8 sec  Forward Delay 2 sec',
      '             Aging Time  15 sec',
      '',
      'Interface        Role Sts Cost      Prio.Nbr Type',
      '---------------- ---- --- --------- -------- --------------------------------',
      'Gi0/1            Root FWD 4         128.25   P2p',
      'Gi0/2            Altn BLK 4         128.26   P2p',
    ]);
  });

  it('shows only the VLANs asked for, and says when none of them has a tree', () => {
    const trees = [VLAN1_ROOT, VLAN10_BLOCKING];

    expect(showWith('show spanning-tree vlan 10', trees).live[0]).toBe('VLAN0010');
    expect(showWith('show spanning-tree vlan 10', trees).live).not.toContain('VLAN0001');
    expect(showWith('show spanning-tree vlan 20,30', trees).live).toEqual([
      'Spanning tree instance(s) for vlan 20,30 does not exist.',
    ]);
    expect(showWith('show spanning-tree', []).live).toEqual(['No spanning tree instance exists.']);
  });

  it('says there is no live state without a simulation to ask', () => {
    expect(showWith('show spanning-tree', []).output).toEqual([
      '% The simulation is not running, so there is no live state to show.',
    ]);
  });

  it('reads a blocked port from a running triangle of switches', () => {
    const lab = labBuilder();
    const switches = ['SW1', 'SW2', 'SW3'].map((name) => lab.switch(name)) as [
      DeviceId,
      DeviceId,
      DeviceId,
    ];
    const [sw1, sw2, sw3] = switches;
    lab.connect(sw1, 'GigabitEthernet0/1', sw2, 'GigabitEthernet0/1');
    lab.connect(sw2, 'GigabitEthernet0/2', sw3, 'GigabitEthernet0/2');
    lab.connect(sw3, 'GigabitEthernet0/1', sw1, 'GigabitEthernet0/2');
    const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
    const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
    sim.load(lab.topology);
    engine.runUntil(STP_CONVERGED);

    const rows = switches.flatMap((id) => {
      const trees = sim.spanningTree(id);
      if (!trees.ok) throw new Error(trees.error);
      return showSpanningTree(trees.value).filter((line) => /^(Fa|Gi)\d/.test(line));
    });
    expect(rows.filter((line) => line.includes(' BLK '))).toEqual([
      expect.stringMatching(/^Gi0\/\d +Altn BLK 4 +128\.\d+ +P2p$/),
    ]);
    expect(rows.filter((line) => line.includes(' FWD '))).toHaveLength(5);
  });
});

describe('show spanning-tree timers', () => {
  it('prints the fast timers a running switch uses, and the IOS ones once the lab asks for them', () => {
    const lab = labBuilder();
    const sw1 = lab.switch('SW1');
    const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
    const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
    const pc = lab.host('pc', 'PC1');
    lab.connect(pc, 'FastEthernet0', sw1, 'FastEthernet0/1');
    sim.load(lab.topology);
    const timers = () => {
      const trees = sim.spanningTree(sw1);
      if (!trees.ok) throw new Error(trees.error);
      return showSpanningTree(trees.value).filter((line) => line.includes('Hello Time'));
    };

    expect(timers()).toEqual([
      '             Hello Time  2 sec  Max Age 8 sec  Forward Delay 2 sec',
      '             Hello Time  2 sec  Max Age 8 sec  Forward Delay 2 sec',
    ]);
    sim.applyPatch({ devices: {}, links: {}, settings: { stpTimers: 'ios' } });
    expect(timers()).toEqual([
      '             Hello Time  2 sec  Max Age 20 sec  Forward Delay 15 sec',
      '             Hello Time  2 sec  Max Age 20 sec  Forward Delay 15 sec',
    ]);
  });
});

describe('spanning-tree config', () => {
  it('sets a VLAN priority and prints it in the running-config', () => {
    const { config, c } = configured(['spanning-tree vlan 1 priority 4096']);

    expect(config.stpPriorities).toEqual({ 1: 4096 });
    expect(runningConfig(c.device)).toContain('spanning-tree vlan 1 priority 4096');
  });

  it('refuses a priority that is not a multiple of 4096', () => {
    const { output, config } = configured(['spanning-tree vlan 1 priority 1000']);

    expect(output).toContain('% Bridge Priority must be in increments of 4096.');
    expect(config.stpPriorities).toBeUndefined();
  });

  it('makes the switch primary or secondary root with the IOS priorities', () => {
    const { config, c } = configured([
      'spanning-tree vlan 1,10 root primary',
      'spanning-tree vlan 20 root secondary',
    ]);

    expect(config.stpPriorities).toEqual({ 1: 24576, 10: 24576, 20: 28672 });
    expect(runningConfig(c.device)).toEqual(
      expect.arrayContaining([
        'spanning-tree vlan 1,10 priority 24576',
        'spanning-tree vlan 20 priority 28672',
      ]),
    );
  });

  it('goes back to the default priority with `no`, which leaves nothing in the config', () => {
    const { config } = configured([
      'spanning-tree vlan 1 priority 8192',
      'spanning-tree vlan 10 root primary',
      'no spanning-tree vlan 1 priority',
      'no spanning-tree vlan 10 root',
      'spanning-tree vlan 20 priority 32768',
    ]);

    expect(config.stpPriorities).toBeUndefined();
  });

  it('accepts PVST+ as the mode and the extended system ID, and nothing else', () => {
    const { output, config } = configured([
      'spanning-tree mode pvst',
      'spanning-tree extend system-id',
      'spanning-tree mode rapid-pvst',
    ]);

    expect(output).toContain("% Invalid input detected at '^' marker.");
    expect(config).toEqual(switchDevice().config);
  });

  it('turns PortFast on with the IOS warning, and off again', () => {
    const { output, config, c } = configured([
      'interface range f0/1 - 2',
      'spanning-tree portfast',
    ]);

    expect(output).toEqual([
      'Enter configuration commands, one per line.  End with CNTL/Z.',
      '%Warning: portfast should only be enabled on ports connected to a single',
      ' host. Connecting hubs, concentrators, switches, bridges, etc... to this',
      ' interface  when portfast is enabled, can cause temporary bridging loops.',
      ' Use with CAUTION',
      '',
      '%Portfast has been configured on FastEthernet0/1 but will only',
      ' have effect when the interface is in a non-trunking mode.',
      '%Portfast has been configured on FastEthernet0/2 but will only',
      ' have effect when the interface is in a non-trunking mode.',
    ]);
    expect(config.interfaces[port('FastEthernet0/1')]?.portfast).toBe(true);
    expect(runningConfig(c.device)).toEqual(
      expect.arrayContaining(['interface FastEthernet0/2', ' spanning-tree portfast']),
    );

    c.run('no spanning-tree portfast');
    expect(c.device.config.interfaces[port('FastEthernet0/1')]?.portfast).toBeUndefined();
  });

  it('sets and clears a port cost', () => {
    const { config, c } = configured(['interface g0/1', 'spanning-tree cost 100']);

    expect(config.interfaces[port('GigabitEthernet0/1')]?.stpCost).toBe(100);
    expect(runningConfig(c.device)).toContain(' spanning-tree cost 100');

    c.run('no spanning-tree cost');
    expect(c.device.config.interfaces[port('GigabitEthernet0/1')]?.stpCost).toBeUndefined();
  });

  it('refuses port settings on a VLAN interface', () => {
    const { c } = configured(['interface vlan 1']);
    expect(c.prompt).toBe('Switch(config-if)#');

    expect(c.run('spanning-tree portfast')).toEqual(["% Invalid input detected at '^' marker."]);
    expect(c.run('spanning-tree cost 5')).toEqual(["% Invalid input detected at '^' marker."]);
  });

  it('rebuilds every spanning tree setting from the running-config', () => {
    const { c } = configured([
      'spanning-tree vlan 1 priority 4096',
      'spanning-tree vlan 10,20 root secondary',
      'interface f0/1',
      'spanning-tree portfast',
      'spanning-tree cost 7',
      'interface g0/2',
      'shutdown',
      'spanning-tree cost 200000000',
    ]);
    const device: SwitchDevice = c.device;

    const { config, errors } = applyLines(withBlankConfig(device), runningConfig(device));

    expect(errors).toEqual([]);
    expect(config).toEqual(device.config);
    expect(runningConfig({ ...device, config })).toEqual(runningConfig(device));
  });
});
