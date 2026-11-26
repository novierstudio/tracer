import { describe, expect, it } from 'vitest';
import type { CdpNeighbor, Layer2Status, LldpNeighbor } from '../../engine/api';
import { after, ms } from '../../engine/core/time';
import { createEngine } from '../../engine/engine';
import { createSimService } from '../../engine/service';
import { STACKS } from '../../engine/stacks';
import { labBuilder, trunk } from '../../engine/testing';
import {
  IOS_SOFTWARE,
  updateConfig,
  type DeviceId,
  type Ipv4Address,
  type MacAddress,
  type PortId,
  type Topology,
} from '../../model';
import { expectOk } from '../../model/testing';
import type { IosDevice } from './context';
import { applyLines, toConfigUpdate } from './session';
import { runningConfig } from './show';
import { consoleOn, router, switchDevice } from './testing';

const ENTER = ['enable', 'configure terminal'];

const port = (name: string) => name as PortId;

const neighbor = (fields: Partial<CdpNeighbor> & Pick<CdpNeighbor, 'deviceId'>): CdpNeighbor => ({
  localPort: port('GigabitEthernet0/0'),
  holdtime: 164,
  capabilities: ['router'],
  platform: 'router-2g2s',
  portId: 'GigabitEthernet0/1',
  addresses: [],
  software: IOS_SOFTWARE,
  version: 2,
  duplex: 'full',
  ...fields,
});

const lldpNeighbor = (fields: Partial<LldpNeighbor> & Pick<LldpNeighbor, 'systemName'>) => ({
  chassisId: '00:01:97:27:a4:63' as MacAddress,
  localPort: port('GigabitEthernet0/0'),
  holdtime: 90,
  ttl: 120,
  portId: 'GigabitEthernet0/1',
  systemDescription: IOS_SOFTWARE,
  capabilities: ['router' as const],
  ...fields,
});

function layer2(fields: Partial<Pick<Layer2Status, 'cdp' | 'lldp' | 'ports'>>): Layer2Status {
  return {
    cdp: { enabled: true, timer: 60, holdtime: 180, interfaces: [], neighbors: [] },
    lldp: { enabled: true, timer: 30, holdtime: 120, neighbors: [] },
    etherchannels: [],
    portSecurity: [],
    errDisabled: [],
    ports: {},
    clock: 0 as never,
    ...fields,
  };
}

/** Runs a show command and answers its layer 2 query, as a terminal does with the simulation. */
function showWith(c: ReturnType<typeof consoleOn>, line: string, answer: Layer2Status) {
  const { output, query } = c.session.run(c.device, line);
  if (query?.kind !== 'layer2') throw new Error(`${line} asked for ${query?.kind}`);
  return { live: query.render(answer), output };
}

const cli = (device: IosDevice = router(), lines: readonly string[] = []) => {
  const c = consoleOn(device);
  c.runAll([...ENTER, ...lines, 'end']);
  return c;
};

/** Each line with its columns marked, so a failing test shows where a column moved. */
const LEGEND = [
  'Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge',
  '                  S - Switch, H - Host, I - IGMP, r - Repeater, P - Phone',
  'Device ID    Local Intrfce   Holdtme    Capability   Platform    Port ID',
];

describe('show cdp neighbors', () => {
  it('lines each neighbour up under the column heads, as Packet Tracer does', () => {
    const status = layer2({
      cdp: {
        enabled: true,
        timer: 60,
        holdtime: 180,
        interfaces: [],
        neighbors: [
          neighbor({
            deviceId: 'Switch',
            localPort: port('GigabitEthernet0/0'),
            holdtime: 175,
            capabilities: ['switch'],
            platform: '2960',
            portId: 'GigabitEthernet0/1',
          }),
          neighbor({
            deviceId: 'R2',
            localPort: port('Serial0/0/0'),
            holdtime: 5,
            portId: 'Serial0/0/1',
            platform: 'C2900',
          }),
          neighbor({
            deviceId: 'sw-br-floor3',
            localPort: port('FastEthernet0/24'),
            holdtime: 164,
            capabilities: ['switch'],
            platform: '2960',
            portId: 'FastEthernet0/24',
          }),
          neighbor({
            deviceId: 'Branch-Edge',
            capabilities: ['router', 'switch'],
            platform: 'switch-l3-24',
            portId: 'GigabitEthernet0/2',
          }),
        ],
      },
    });

    const { live } = showWith(cli(), 'show cdp neighbors', status);

    expect(live).toEqual([
      ...LEGEND,
      'Switch       Gig 0/0          175            S       2960        Gig 0/1',
      'R2           Ser 0/0/0          5            R       C2900       Ser 0/0/1',
      'sw-br-floor3',
      '             Fas 0/24         164            S       2960        Fas 0/24',
      'Branch-Edge  Gig 0/0          164            R S     switch-l3-24 Gig 0/2',
    ]);
    // The columns of the header, measured from Packet Tracer.
    const header = LEGEND[2]!;
    expect(
      ['Local Intrfce', 'Holdtme', 'Capability', 'Platform', 'Port ID'].map((h) =>
        header.indexOf(h),
      ),
    ).toEqual([13, 29, 40, 53, 65]);
  });

  it('prints only the legend with no simulation to ask', () => {
    const { output } = showWith(cli(), 'show cdp neighbors', layer2({}));
    expect(output).toEqual(LEGEND);
  });

  it('says CDP is not enabled after no cdp run, for every show cdp command', () => {
    const c = cli(router(), ['no cdp run']);
    expect(c.run('show cdp')).toEqual(['% CDP is not enabled']);
    for (const line of [
      'show cdp neighbors',
      'show cdp neighbors detail',
      'show cdp interface',
      'show cdp entry *',
    ]) {
      expect(showWith(c, line, layer2({})).live).toEqual(['% CDP is not enabled']);
    }
  });
});

describe('show cdp neighbors detail and show cdp entry', () => {
  const status = layer2({
    cdp: {
      enabled: true,
      timer: 60,
      holdtime: 180,
      interfaces: [],
      neighbors: [
        neighbor({
          deviceId: 'Branch-Firewall',
          localPort: port('GigabitEthernet0/1'),
          holdtime: 158,
          addresses: ['192.168.4.129' as Ipv4Address],
        }),
        neighbor({
          deviceId: 'sw-br-floor3',
          localPort: port('FastEthernet0/24'),
          holdtime: 158,
          capabilities: ['switch'],
          platform: 'switch-24',
          portId: 'FastEthernet0/24',
        }),
      ],
    },
  });

  const FIREWALL = [
    '',
    'Device ID: Branch-Firewall',
    'Entry address(es): ',
    '  IP address : 192.168.4.129',
    'Platform: router-2g2s, Capabilities: Router',
    'Interface: GigabitEthernet0/1, Port ID (outgoing port): GigabitEthernet0/1',
    'Holdtime: 158',
    '',
    'Version :',
    'Tracer IOS Software, Version 15.1, RELEASE SOFTWARE',
    '',
    'advertisement version: 2',
    'Duplex: full',
  ];
  const FLOOR3 = [
    '',
    'Device ID: sw-br-floor3',
    'Entry address(es): ',
    'Platform: switch-24, Capabilities: Switch',
    'Interface: FastEthernet0/24, Port ID (outgoing port): FastEthernet0/24',
    'Holdtime: 158',
    '',
    'Version :',
    'Tracer IOS Software, Version 15.1, RELEASE SOFTWARE',
    '',
    'advertisement version: 2',
    'Duplex: full',
  ];

  it('prints a block per neighbour, separated by a rule', () => {
    const { live } = showWith(cli(), 'show cdp neighbors detail', status);
    expect(live).toEqual([...FIREWALL, '---------------------------', ...FLOOR3]);
  });

  it('prints one neighbour by name, or all of them for *', () => {
    const c = cli();
    expect(showWith(c, 'show cdp entry sw-br-floor3', status).live).toEqual(FLOOR3);
    expect(showWith(c, 'show cdp entry *', status).live).toEqual(
      showWith(c, 'show cdp neighbors detail', status).live,
    );
    expect(showWith(c, 'show cdp entry nobody', status).live).toEqual([]);
  });
});

describe('show cdp and show cdp interface', () => {
  it('gives the timers, the default ones or those the config sets', () => {
    expect(cli().run('show cdp')).toEqual([
      'Global CDP information:',
      '    Sending CDP packets every 60 seconds',
      '    Sending a holdtime value of 180 seconds',
      '    Sending CDPv2 advertisements is enabled',
    ]);
    expect(cli(router(), ['cdp timer 30', 'cdp holdtime 90']).run('show cdp')).toEqual([
      'Global CDP information:',
      '    Sending CDP packets every 30 seconds',
      '    Sending a holdtime value of 90 seconds',
      '    Sending CDPv2 advertisements is enabled',
    ]);
  });

  it('lists each port CDP runs on with its state, leaving out no cdp enable', () => {
    const c = cli(router(), ['interface g0/0', 'no shutdown', 'interface s0/0/1', 'no cdp enable']);
    const ports = { [port('GigabitEthernet0/0')]: true };

    expect(showWith(c, 'show cdp interface', layer2({ ports })).live).toEqual([
      'GigabitEthernet0/0 is up, line protocol is up',
      '  Sending CDP packets every 60 seconds',
      '  Holdtime is 180 seconds',
      'GigabitEthernet0/1 is administratively down, line protocol is down',
      '  Sending CDP packets every 60 seconds',
      '  Holdtime is 180 seconds',
      'Serial0/0/0 is administratively down, line protocol is down',
      '  Sending CDP packets every 60 seconds',
      '  Holdtime is 180 seconds',
    ]);
    expect(showWith(c, 'show cdp interface g0/0', layer2({})).live).toEqual([
      'GigabitEthernet0/0 is down, line protocol is down',
      '  Sending CDP packets every 60 seconds',
      '  Holdtime is 180 seconds',
    ]);
    expect(showWith(c, 'show cdp interface s0/0/1', layer2({})).live).toEqual([]);
  });
});

describe('LLDP show commands', () => {
  const status = layer2({
    lldp: {
      enabled: true,
      timer: 30,
      holdtime: 120,
      neighbors: [
        lldpNeighbor({ systemName: 'RBO-Edge' }),
        lldpNeighbor({
          systemName: 'sw-rbo1',
          chassisId: '00:d0:ba:a8:8e:19' as MacAddress,
          localPort: port('GigabitEthernet0/1'),
          capabilities: ['switch'],
          holdtime: 100,
          vlan: 10 as never,
        }),
      ],
    },
  });

  it('says LLDP is not enabled until lldp run', () => {
    const c = cli();
    expect(c.run('show lldp')).toEqual(['% LLDP is not enabled']);
    expect(showWith(c, 'show lldp neighbors', status).live).toEqual(['% LLDP is not enabled']);
    expect(showWith(c, 'show lldp neighbors detail', status).live).toEqual([
      '% LLDP is not enabled',
    ]);
  });

  it('gives its timers once it runs', () => {
    expect(cli(router(), ['lldp run']).run('show lldp')).toEqual([
      '',
      'Global LLDP Information:',
      '    Status: ACTIVE',
      '    LLDP advertisements are sent every 30 seconds',
      '    LLDP hold time advertised is 120 seconds',
      '    LLDP interface reinitialisation delay is 2 seconds',
    ]);
  });

  it('lines each neighbour up under the column heads', () => {
    const c = cli(router(), ['lldp run']);
    const { live, output } = showWith(c, 'show lldp neighbors', status);

    const head = [
      'Capability codes:',
      '    (R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device',
      '    (W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other',
      'Device ID           Local Intf     Hold-time  Capability      Port ID',
    ];
    expect(live).toEqual([
      ...head,
      'RBO-Edge            Gig0/0         120        R               Gig0/1',
      'sw-rbo1             Gig0/1         120        B               Gig0/1',
      '',
      'Total entries displayed: 2',
    ]);
    expect(output).toEqual([...head, '', 'Total entries displayed: 0']);
  });

  it('prints a block per neighbour in detail, each opened by a rule', () => {
    const c = cli(router(), ['lldp run']);
    const rule = '------------------------------------------------';

    expect(showWith(c, 'show lldp neighbors detail', status).live).toEqual([
      rule,
      'Chassis id: 0001.9727.A463',
      'Port id: Gig0/1',
      'Port Description: GigabitEthernet0/1',
      'System Name: RBO-Edge',
      'System Description:',
      'Tracer IOS Software, Version 15.1, RELEASE SOFTWARE',
      'Time remaining: 90 seconds',
      'System Capabilities: R',
      'Enabled Capabilities: R',
      'Management Addresses - not advertised',
      'Auto Negotiation - supported, enabled',
      'Physical media capabilities:',
      '    1000baseT(FD)',
      'Media Attachment Unit type: 10',
      'Vlan ID: 1',
      rule,
      'Chassis id: 00D0.BAA8.8E19',
      'Port id: Gig0/1',
      'Port Description: GigabitEthernet0/1',
      'System Name: sw-rbo1',
      'System Description:',
      'Tracer IOS Software, Version 15.1, RELEASE SOFTWARE',
      'Time remaining: 100 seconds',
      'System Capabilities: B',
      'Enabled Capabilities: B',
      'Management Addresses - not advertised',
      'Auto Negotiation - supported, enabled',
      'Physical media capabilities:',
      '    100baseT(HD)',
      '    100baseT(FD)',
      '    1000baseT(FD)',
      'Media Attachment Unit type: 10',
      'Vlan ID: 10',
      '',
      'Total entries displayed: 2',
    ]);
  });
});

describe('CDP and LLDP config', () => {
  const LINES = [
    'cdp timer 30',
    'cdp holdtime 90',
    'no cdp run',
    'lldp run',
    'interface g0/0',
    'no cdp enable',
    'no lldp transmit',
    'no lldp receive',
  ];

  it('keeps what differs from IOS defaults, and replays from its running-config', () => {
    const c = cli(router(), LINES);
    const { config } = c.device;

    expect(config).toMatchObject({ cdpTimer: 30, cdpHoldtime: 90, cdpRun: false, lldpRun: true });
    expect(config.interfaces[port('GigabitEthernet0/0')]).toMatchObject({
      cdpEnable: false,
      lldpTransmit: false,
      lldpReceive: false,
    });
    const lines = runningConfig(c.device);
    expect(lines).toEqual(expect.arrayContaining(['cdp timer 30', 'no cdp run', 'lldp run']));
    const replayed = applyLines(router(), lines);
    expect(replayed.errors).toEqual([]);
    expect(replayed.config).toEqual(config);
  });

  it('goes back to the defaults with the no forms, and with the default values', () => {
    const c = cli(router(), [
      ...LINES,
      'cdp timer 60',
      'no cdp holdtime',
      'cdp run',
      'no lldp run',
      'interface g0/0',
      'cdp enable',
      'lldp transmit',
      'lldp receive',
    ]);

    expect(c.device.config).toEqual(router().config);
  });

  it('refuses the interface commands on a VLAN interface', () => {
    const c = consoleOn(switchDevice());
    expect(c.runAll([...ENTER, 'interface vlan 1', 'no cdp enable'])).toContain(
      "% Invalid input detected at '^' marker.",
    );
  });

  it('offers the commands with ? as IOS does', () => {
    const c = consoleOn(router());
    c.runAll(ENTER);
    const help = (line: string) => c.session.help(c.device, line);

    expect(help('cdp ')).toEqual([
      '  holdtime  Specify the holdtime (in sec) to be sent in packets',
      '  run       Enable CDP',
      '  timer     Specify the rate at which CDP packets are sent (in sec)',
    ]);
    expect(help('cdp timer ')).toEqual(['  <5-254>  Rate at which CDP packets are sent (in  sec)']);
    expect(help('cdp holdtime ')).toEqual([
      '  <10-255>  Length  of time  (in sec) that receiver must keep this packet',
    ]);
    expect(help('lldp ')).toEqual(['  run  Enable LLDP']);
    expect(help('')).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^ {2}cdp +Global CDP configuration subcommands$/),
        expect.stringMatching(/^ {2}lldp +Global LLDP configuration subcommands$/),
      ]),
    );
    c.run('interface g0/0');
    expect(help('cdp ')).toEqual(['  enable  Enable CDP on interface']);
    expect(help('lldp ')).toEqual([
      '  receive   Enable LLDP reception on interface',
      '  transmit  Enable LLDP transmission on interface',
    ]);
    c.run('end');
    expect(help('show cdp ')).toEqual(
      expect.arrayContaining([
        '  entry      Information for specific neighbor entry',
        '  interface  CDP interface status and configuration',
        '  neighbors  CDP neighbor entries',
      ]),
    );
    expect(help('show cdp neighbors ')).toEqual(
      expect.arrayContaining(['  detail  Show detailed information']),
    );
    expect(help('show cdp entry ')).toEqual([
      '  *     all CDP neighbor entries',
      '  WORD  Name of CDP neighbor entry',
    ]);
    expect(help('show ')).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^ {2}cdp +CDP information$/),
        expect.stringMatching(/^ {2}lldp +LLDP information$/),
      ]),
    );
  });
});

describe('the show commands on a running lab', () => {
  /** R1's Gi0/0 to SW1's Gi0/1, with LLDP on both, run until both have advertised. */
  function lab() {
    const build = labBuilder();
    const r1 = build.router('R1', { 'GigabitEthernet0/0': '192.168.1.1/24' });
    const sw1 = build.switch('SW1', { 'GigabitEthernet0/1': trunk() });
    build.connect(r1, 'GigabitEthernet0/0', sw1, 'GigabitEthernet0/1');
    let topology: Topology = build.topology;
    for (const id of [r1, sw1]) {
      const device = topology.devices[id] as IosDevice;
      const { config } = applyLines(device, ['lldp run']);
      topology = expectOk(
        updateConfig(topology, toConfigUpdate({ ...device, config } as IosDevice)),
      );
    }
    const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
    const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
    sim.load(topology);
    engine.runUntil(after(engine.now, ms(31_000)));
    const show = (id: DeviceId, line: string) => {
      const c = consoleOn(topology.devices[id] as IosDevice);
      c.run('enable');
      return showWith(c, line, expectOk(sim.layer2Status(id))).live;
    };
    return { r1, sw1, show };
  }

  it('shows each end of the cable to the other', () => {
    const { r1, sw1, show } = lab();

    // The last advertisement arrived at 30.001 s, so its 180 s have barely begun at 31 s.
    expect(show(r1, 'show cdp neighbors').slice(3)).toEqual([
      'SW1          Gig 0/0          180            S       switch      Gig 0/1',
    ]);
    expect(show(sw1, 'show cdp neighbors').slice(3)).toEqual([
      'R1           Gig 0/1          180            R       router      Gig 0/0',
    ]);
    expect(show(sw1, 'show lldp neighbors').slice(4)).toEqual([
      'R1                  Gig0/1         120        R               Gig0/0',
      '',
      'Total entries displayed: 1',
    ]);
    expect(show(sw1, 'show cdp entry R1')).toContain('  IP address : 192.168.1.1');
  });
});
