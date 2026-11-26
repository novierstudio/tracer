// @vitest-environment node
import { Terminal } from '@xterm/headless';
import { describe, expect, it, vi } from 'vitest';
import { buildOffice } from '@/features/inspector/testing';
import type { Lease } from '@/engine/api';
import type { SimTime } from '@/engine/core/time';
import {
  Ipv4Address,
  Ipv6Address,
  type DeviceId,
  type MacAddress,
  type PrefixLength,
} from '@/model';
import type {
  DhcpOutcome,
  DnsLookup,
  HostAddressing,
  HostBackend,
  Ipv6Status,
  PingReply,
  TraceProbe,
} from './backend';
import { formatReply, isHostDevice, type HostDevice } from './format';
import { hostShell } from './shell';
import { createHostTty, PROMPT } from './tty';

const SIZE = { cols: 80, rows: 24 };
const UP = '\x1b[A';
const ip = (text: string) => Ipv4Address.parse(text);
const ip6 = (text: string) => Ipv6Address.parse(text);

/** What the simulation says about a host it knows no IPv6 for. */
const NO_IPV6: Ipv6Status = {
  routing: false,
  interfaces: [],
  routes: [],
  neighbors: [],
  ports: {},
};

const reply = (timeMs: number): PingReply => ({
  kind: 'reply',
  seq: 1,
  from: ip('192.168.1.1'),
  bytes: 32,
  timeMs,
  ttl: 255,
});

type ScriptOptions = { trace: readonly TraceProbe[]; hang: boolean; learned: number };

type PromptOptions = {
  edit?: (device: HostDevice) => HostDevice;
  connected?: boolean;
  wallClock?: () => number;
};

/**
 * Answers each echo request from `script` in turn, a tick apart; after the script, it hangs. A
 * traceroute plays `trace` the same way, then is done or, with `hang`, waits for Ctrl+C. The ARP
 * cache holds `learned` entries.
 */
function scripted(
  script: readonly PingReply[],
  { trace = [], hang = false, learned = 0 }: Partial<ScriptOptions> = {},
) {
  const calls: { device: DeviceId; target: string; count: number }[] = [];
  const cleared: (string | undefined)[] = [];
  const signals: AbortSignal[] = [];
  const backend: HostBackend = {
    async ping(device, target, { count }, onReply, signal) {
      calls.push({ device, target, count });
      signals.push(signal);
      for (let sent = 0; sent < count; sent++) {
        const next = script[sent];
        if (!next) return new Promise<void>(() => {});
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (signal.aborted) return;
        onReply(next);
      }
    },
    async traceroute(_device, _target, _options, onProbe, signal) {
      signals.push(signal);
      for (const probe of trace) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (signal.aborted) return;
        onProbe(probe);
      }
      if (hang) return new Promise<void>(() => {});
    },
    arpTable: async () => [],
    clearArp: async (_device, address) => {
      cleared.push(address);
      return address ? Math.min(learned, 1) : learned;
    },
    hostIp: async () => ({ addressing: { kind: 'unassigned' }, now: 0 }),
    ipv6Status: async () => NO_IPV6,
    renewDhcp: async () => ({ kind: 'failed' }),
    releaseDhcp: async () => {},
    nslookup: async () => ({ kind: 'no-server' }),
    browse: async () => {},
  };
  return { backend, calls, cleared, signals };
}

/** PC1's prompt in the office lab, drawn by a real terminal. `edit` changes PC1 first. */
async function prompt(
  backend: HostBackend,
  { edit = (device) => device, connected = true, wallClock }: PromptOptions = {},
) {
  const { pc } = buildOffice();
  if (!isHostDevice(pc)) throw new Error('PC1 is not a host');
  const device = edit(pc);
  const tty = createHostTty(
    hostShell({ host: () => ({ device, connected }), backend, ...(wallClock && { wallClock }) }),
  );
  const term = new Terminal({ ...SIZE, allowProposedApi: true });
  const written: Promise<void>[] = [];
  const write = (data: string) => {
    written.push(new Promise((resolve) => term.write(data, resolve)));
  };
  write(tty.transcript);
  tty.subscribe(write);
  const screen = async () => {
    await Promise.all(written);
    const buffer = term.buffer.active;
    const rows = Array.from({ length: buffer.length }, (_, y) =>
      buffer.getLine(y)!.translateToString(true).trimEnd(),
    );
    return rows.slice(0, buffer.baseY + buffer.cursorY + 1);
  };
  const idle = () => vi.waitFor(async () => expect((await screen()).at(-1)).toBe(PROMPT));
  return {
    tty,
    screen,
    idle,
    type: (data: string) => tty.input(data, SIZE),
    async run(line: string) {
      tty.input(`${line}\r`, SIZE);
      await idle();
      const rows = await screen();
      return rows.slice(rows.lastIndexOf(`${PROMPT}${line}`) + 1, -1);
    },
  };
}

describe('the Command Prompt', () => {
  it('greets with the prompt', async () => {
    const { screen } = await prompt(scripted([]).backend);
    expect(await screen()).toEqual([
      'Tracer Command Prompt',
      'Type help to see the commands.',
      '',
      PROMPT,
    ]);
  });

  it('streams each reply, then the summary', async () => {
    const { backend, calls } = scripted([reply(1), reply(0), reply(0), reply(0)]);
    const { run } = await prompt(backend);
    expect(await run('ping 192.168.1.1')).toEqual([
      '',
      'Pinging 192.168.1.1 with 32 bytes of data:',
      '',
      'Reply from 192.168.1.1: bytes=32 time=1ms TTL=255',
      'Reply from 192.168.1.1: bytes=32 time<1ms TTL=255',
      'Reply from 192.168.1.1: bytes=32 time<1ms TTL=255',
      'Reply from 192.168.1.1: bytes=32 time<1ms TTL=255',
      '',
      'Ping statistics for 192.168.1.1:',
      '    Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),',
      'Approximate round trip times in milli-seconds:',
      '    Minimum = 0ms, Maximum = 1ms, Average = 0ms',
      '',
    ]);
    expect(calls).toEqual([{ device: 'dev_PC1', target: '192.168.1.1', count: 4 }]);
  });

  it('shows timeouts and unreachable answers as they come', async () => {
    const unreachable: PingReply = {
      kind: 'unreachable',
      seq: 2,
      from: ip('192.168.1.10'),
      code: 'host',
    };
    const { run } = await prompt(scripted([{ kind: 'timeout', seq: 1 }, unreachable]).backend);
    expect(await run('ping 192.168.1.99 -n 2')).toEqual([
      '',
      'Pinging 192.168.1.99 with 32 bytes of data:',
      '',
      'Request timed out.',
      'Reply from 192.168.1.10: Destination host unreachable.',
      '',
      'Ping statistics for 192.168.1.99:',
      '    Packets: Sent = 2, Received = 0, Lost = 2 (100% loss),',
      '',
    ]);
  });

  it('shows no prompt and ignores typing while a ping runs', async () => {
    const { screen, type } = await prompt(scripted([reply(1)]).backend);
    type('ping -n 50 192.168.1.1\r');
    await vi.waitFor(async () => expect(await screen()).toContain(formatReply(reply(1))));
    type('ipconfig\r');
    const rows = await screen();
    expect(rows.at(-1)).toBe('');
    expect(rows.join('\n')).not.toContain('ipconfig');
  });

  it('stops a running ping on Ctrl+C with the summary so far', async () => {
    const { screen, type, idle } = await prompt(scripted([reply(1), reply(0)]).backend);
    type('ping -n 50 192.168.1.1\r');
    await vi.waitFor(async () =>
      expect((await screen()).filter((r) => r.startsWith('Reply'))).toHaveLength(2),
    );
    type('\x03');
    await idle();
    expect((await screen()).slice(-9)).toEqual([
      '',
      'Ping statistics for 192.168.1.1:',
      '    Packets: Sent = 2, Received = 2, Lost = 0 (0% loss),',
      'Approximate round trip times in milli-seconds:',
      '    Minimum = 0ms, Maximum = 1ms, Average = 0ms',
      'Control-C',
      '^C',
      '',
      PROMPT,
    ]);
  });

  it('pings until Ctrl+C with -t, then stops the ping and prints the summary', async () => {
    const { backend, calls, signals } = scripted([reply(1), reply(0), reply(0)]);
    const { screen, type, idle } = await prompt(backend);
    type('ping -t 192.168.1.1\r');
    await vi.waitFor(async () =>
      expect((await screen()).filter((r) => r.startsWith('Reply'))).toHaveLength(3),
    );
    type('\x03');
    await idle();
    expect(calls).toEqual([{ device: 'dev_PC1', target: '192.168.1.1', count: Infinity }]);
    expect(signals.map((signal) => signal.aborted)).toEqual([true]);
    expect((await screen()).slice(-9, -5)).toEqual([
      '',
      'Ping statistics for 192.168.1.1:',
      '    Packets: Sent = 3, Received = 3, Lost = 0 (0% loss),',
      'Approximate round trip times in milli-seconds:',
    ]);
  });

  it('traces the route a column at a time, in Windows format', async () => {
    const hop = (n: number, from: string, times: (number | undefined)[]): TraceProbe[] =>
      times.map((timeMs, i) =>
        timeMs === undefined
          ? { kind: 'timeout', hop: n, probe: i + 1 }
          : { kind: 'ttl-expired', hop: n, probe: i + 1, from: ip(from), timeMs },
      );
    const trace: TraceProbe[] = [
      ...hop(1, '192.168.1.1', [0, 0, 1]),
      ...hop(2, '10.0.0.2', [undefined, undefined, undefined]),
      ...hop(3, '10.0.0.6', [12, undefined, 8]),
      ...[1, 2, 3].map((probe): TraceProbe => ({
        kind: 'reply',
        hop: 4,
        probe,
        from: ip('192.168.2.10'),
        timeMs: 16,
        ttl: 125,
      })),
    ];
    const { run } = await prompt(scripted([], { trace }).backend);
    expect(await run('tracert 192.168.2.10')).toEqual([
      '',
      'Tracing route to 192.168.2.10 over a maximum of 30 hops',
      '',
      '  1    <1 ms    <1 ms     1 ms  192.168.1.1',
      '  2     *        *        *     Request timed out.',
      '  3    12 ms     *        8 ms  10.0.0.6',
      '  4    16 ms    16 ms    16 ms  192.168.2.10',
      '',
      'Trace complete.',
      '',
    ]);
  });

  it("ends a trace at a router's Destination Unreachable report", async () => {
    const trace: TraceProbe[] = [
      { kind: 'ttl-expired', hop: 1, probe: 1, from: ip('192.168.1.1'), timeMs: 0 },
      { kind: 'ttl-expired', hop: 1, probe: 2, from: ip('192.168.1.1'), timeMs: 0 },
      { kind: 'ttl-expired', hop: 1, probe: 3, from: ip('192.168.1.1'), timeMs: 0 },
      {
        kind: 'unreachable',
        hop: 2,
        probe: 1,
        from: ip('192.168.1.1'),
        code: 'network',
        timeMs: 0,
      },
    ];
    const { run } = await prompt(scripted([], { trace }).backend);
    expect((await run('tracert -h 5 10.99.0.1')).slice(1, -3)).toEqual([
      'Tracing route to 10.99.0.1 over a maximum of 5 hops',
      '',
      '  1    <1 ms    <1 ms    <1 ms  192.168.1.1',
      '  2  192.168.1.1  reports: Destination net unreachable.',
    ]);
  });

  it('stops a trace on Ctrl+C mid-line', async () => {
    const trace: TraceProbe[] = [{ kind: 'timeout', hop: 1, probe: 1 }];
    const { backend, signals } = scripted([], { trace, hang: true });
    const { screen, type, idle } = await prompt(backend);
    type('tracert 10.99.0.1\r');
    await vi.waitFor(async () => expect((await screen()).at(-1)).toBe('  1     *'));
    type('\x03');
    await idle();
    expect(signals.map((signal) => signal.aborted)).toEqual([true]);
    expect((await screen()).slice(-4)).toEqual(['  1     *', '^C', '', PROMPT]);
  });

  it('clears the ARP cache, or one address in it, with arp -d', async () => {
    const { backend, cleared } = scripted([], { learned: 2 });
    const { run } = await prompt(backend);
    expect(await run('arp -d')).toEqual(['']);
    expect(await run('arp -d 192.168.1.1')).toEqual(['']);
    expect(cleared).toEqual([undefined, '192.168.1.1']);

    const { run: runEmpty } = await prompt(scripted([]).backend);
    expect(await runEmpty('arp -d 192.168.1.1')).toEqual([
      'The ARP entry deletion failed: Element not found.',
      '',
    ]);
  });

  it('recalls earlier lines with Up', async () => {
    const { run, type, screen, tty } = await prompt(scripted([]).backend);
    await run('help');
    await run('ipconfig');
    type(UP + UP);
    expect((await screen()).at(-1)).toBe(`${PROMPT}help`);
    expect(tty.history).toEqual(['help', 'ipconfig']);
  });

  it('prints ipconfig from the host config', async () => {
    const { run } = await prompt(scripted([]).backend);
    expect(await run('ipconfig')).toContain('   IPv4 Address. . . . . . . . . . . : 192.168.1.10');
  });

  it('clears the screen and the replay with cls', async () => {
    const { run, type, screen, idle, tty } = await prompt(scripted([]).backend);
    await run('help');
    type('cls\r');
    await idle();
    expect(await screen()).toEqual([PROMPT]);
    expect(tty.transcript).toBe(PROMPT);
  });

  it('prints what the backend cannot do', async () => {
    const failing: HostBackend = {
      ping: () => Promise.reject(new Error('PING: no engine')),
      traceroute: () => Promise.reject(new Error('TRACERT: no engine')),
      arpTable: () => Promise.reject(new Error('ARP: no engine')),
      clearArp: async () => 0,
      hostIp: () => Promise.reject(new Error('IPCONFIG: no engine')),
      ipv6Status: () => Promise.reject(new Error('IPV6CONFIG: no engine')),
      renewDhcp: () => Promise.reject(new Error('IPCONFIG: no engine')),
      releaseDhcp: () => Promise.reject(new Error('IPCONFIG: no engine')),
      nslookup: () => Promise.reject(new Error("*** Can't look up www.lab.local: no engine")),
      browse: () => Promise.reject(new Error('no engine')),
    };
    const { run } = await prompt(failing);
    expect(await run('arp -a')).toEqual(['ARP: no engine', '']);
    expect(await run('ping 192.168.1.1')).toEqual([
      '',
      'Pinging 192.168.1.1 with 32 bytes of data:',
      '',
      'PING: no engine',
      '',
    ]);
  });

  it('says why a command did not parse', async () => {
    const { run } = await prompt(scripted([]).backend);
    expect(await run('show ip route')).toEqual(['Invalid Command.', '']);
  });
});

describe('DHCP in the Command Prompt', () => {
  const asDhcp = (device: HostDevice): HostDevice => ({
    ...device,
    config: { ...device.config, ipv4: { mode: 'dhcp' } },
  });
  const lease: Lease = {
    address: { address: ip('192.168.1.11'), prefixLength: 24 as PrefixLength },
    gateway: ip('192.168.1.1'),
    dns: [ip('8.8.8.8'), ip('8.8.4.4')],
    server: ip('192.168.1.1'),
    via: '02:00:00:00:00:01' as MacAddress,
    obtainedAt: 5_000 as SimTime,
    expiresAt: (5_000 + 86_400_000) as SimTime,
  };
  const LEASE: HostAddressing = { kind: 'leased', ...lease };

  /** A backend whose host holds `addressing`, read at simulated time 65 s. */
  function dhcpBackend(addressing: HostAddressing, renewal?: DhcpOutcome | 'hang') {
    let current = addressing;
    const released = vi.fn(async () => {
      current = { kind: 'unassigned' };
    });
    const backend: HostBackend = {
      ...scripted([]).backend,
      hostIp: async () => ({ addressing: current, now: 65_000 }),
      renewDhcp: () =>
        renewal === 'hang'
          ? new Promise(() => {})
          : Promise.resolve(renewal ?? { kind: 'bound', lease }),
      releaseDhcp: released,
    };
    return { backend, released };
  }

  it('shows the leased address, and its lease, server and DNS servers with /all', async () => {
    // The simulation reads 65 s at wall-clock 9:42:07 AM, so the lease came at 9:41:07 AM.
    const wall = new Date(2026, 10, 26, 9, 42, 7).getTime();
    const { run } = await prompt(dhcpBackend(LEASE).backend, {
      edit: asDhcp,
      wallClock: () => wall,
    });
    expect(await run('ipconfig')).toEqual([
      '',
      'Ethernet adapter FastEthernet0:',
      '',
      '   Connection-specific DNS Suffix  . :',
      `   Link-local IPv6 Address . . . . . : ${PC1_LINK_LOCAL}`,
      '   IPv6 Address. . . . . . . . . . . : ::',
      '   IPv4 Address. . . . . . . . . . . : 192.168.1.11',
      '   Subnet Mask . . . . . . . . . . . : 255.255.255.0',
      '   Default Gateway . . . . . . . . . : ::',
      '                                       192.168.1.1',
      '',
    ]);
    const all = await run('ipconfig /all');
    expect(all).toContain('   DHCP Enabled. . . . . . . . . . . : Yes');
    expect(all.slice(-9)).toEqual([
      '   Subnet Mask . . . . . . . . . . . : 255.255.255.0',
      '   Lease Obtained. . . . . . . . . . : Thursday, November 26, 2026 9:41:07 AM',
      '   Lease Expires . . . . . . . . . . : Friday, November 27, 2026 9:41:07 AM',
      '   Default Gateway . . . . . . . . . : ::',
      '                                       192.168.1.1',
      '   DHCP Server . . . . . . . . . . . : 192.168.1.1',
      '   DNS Servers . . . . . . . . . . . : 8.8.8.8',
      '                                       8.8.4.4',
      '',
    ]);
  });

  it('shows a self-assigned address as Windows does', async () => {
    const addressing: HostAddressing = {
      kind: 'autoconfigured',
      address: { address: ip('169.254.12.34'), prefixLength: 16 as PrefixLength },
    };
    const { run } = await prompt(dhcpBackend(addressing).backend, { edit: asDhcp });
    expect(await run('ipconfig')).toEqual([
      '',
      'Ethernet adapter FastEthernet0:',
      '',
      '   Connection-specific DNS Suffix  . :',
      `   Link-local IPv6 Address . . . . . : ${PC1_LINK_LOCAL}`,
      '   IPv6 Address. . . . . . . . . . . : ::',
      '   Autoconfiguration IPv4 Address. . : 169.254.12.34',
      '   Subnet Mask . . . . . . . . . . . : 255.255.0.0',
      '   Default Gateway . . . . . . . . . : ::',
      '                                       0.0.0.0',
      '',
    ]);
  });

  it('releases the lease and shows the adapter without an address', async () => {
    const { backend, released } = dhcpBackend(LEASE);
    const { run } = await prompt(backend, { edit: asDhcp });
    expect(await run('ipconfig /release')).toContain(
      '   IPv4 Address. . . . . . . . . . . : 0.0.0.0',
    );
    expect(released).toHaveBeenCalledOnce();
  });

  it('renews the lease and shows it, or says the server could not be reached', async () => {
    const renewed = await prompt(dhcpBackend(LEASE).backend, { edit: asDhcp });
    expect(await renewed.run('ipconfig /renew')).toContain(
      '   IPv4 Address. . . . . . . . . . . : 192.168.1.11',
    );
    const failed = await prompt(dhcpBackend(LEASE, { kind: 'failed' }).backend, { edit: asDhcp });
    // The terminal wraps the message at 80 columns.
    expect((await failed.run('ipconfig /renew')).join('')).toBe(
      'An error occurred while renewing interface FastEthernet0 : unable to contact your DHCP server. Request has timed out.',
    );
  });

  it('gives the prompt back on Ctrl+C while a renewal waits', async () => {
    const { type, idle, screen } = await prompt(dhcpBackend(LEASE, 'hang').backend, {
      edit: asDhcp,
    });
    type('ipconfig /renew\r');
    type('\x03');
    await idle();
    expect((await screen()).slice(-4)).toEqual([`${PROMPT}ipconfig /renew`, '^C', '', PROMPT]);
  });

  it('refuses /release and /renew on a static adapter or with no cable', async () => {
    const statik = await prompt(scripted([]).backend);
    expect((await statik.run('ipconfig /renew')).join('')).toBe(
      'The operation failed as no adapter is in the state permissible for this operation.',
    );
    const unplugged = await prompt(dhcpBackend(LEASE).backend, { edit: asDhcp, connected: false });
    expect((await unplugged.run('ipconfig /release')).join('')).toBe(
      'No operation can be performed on FastEthernet0 while it has its media disconnected.',
    );
  });

  it('pings from its leased address', async () => {
    const { backend } = dhcpBackend(LEASE);
    const pinged = scripted([reply(1)]);
    const { run } = await prompt({ ...backend, ping: pinged.backend.ping }, { edit: asDhcp });
    const lines = await run('ping -n 1 192.168.1.1');
    expect(lines).toContain('Reply from 192.168.1.1: bytes=32 time=1ms TTL=255');
  });
});

/** PC1's link-local address, from its MAC fe:a8:41:78:49:8f by EUI-64. */
const PC1_LINK_LOCAL = 'FE80::FCA8:41FF:FE78:498F';

describe('IPv6 in the Command Prompt', () => {
  const withIpv6 =
    (ipv6: HostDevice['config']['ipv6'], ipv4: HostDevice['config']['ipv4'] = { mode: 'static' }) =>
    (device: HostDevice): HostDevice => ({ ...device, config: { ...device.config, ipv4, ipv6 } });
  const SLAAC: Ipv6Status = {
    ...NO_IPV6,
    interfaces: [
      {
        name: 'FastEthernet0' as Ipv6Status['interfaces'][number]['name'],
        up: true,
        linkLocal: ip6('fe80::fca8:41ff:fe78:498f'),
        addresses: [
          {
            address: ip6('2001:db8:1:0:fca8:41ff:fe78:498f'),
            prefixLength: 64,
            origin: 'autoconfig',
          },
        ],
        groups: [],
      },
    ],
    gateway: ip6('fe80::1'),
  };

  it('pings an IPv6 address from a host with no IPv4 address', async () => {
    const answer: PingReply = {
      kind: 'reply',
      seq: 1,
      from: ip6('2001:db8:1::1'),
      bytes: 32,
      timeMs: 0,
      ttl: 255,
    };
    const { backend, calls } = scripted([answer]);
    const { run } = await prompt(backend, { edit: withIpv6(undefined) });
    expect(await run('ping -n 1 2001:DB8:1::1')).toEqual([
      '',
      'Pinging 2001:db8:1::1 with 32 bytes of data:',
      '',
      'Reply from 2001:DB8:1::1: bytes=32 time<1ms TTL=255',
      '',
      'Ping statistics for 2001:DB8:1::1:',
      '    Packets: Sent = 1, Received = 1, Lost = 0 (0% loss),',
      'Approximate round trip times in milli-seconds:',
      '    Minimum = 0ms, Maximum = 0ms, Average = 0ms',
      '',
    ]);
    expect(calls).toEqual([{ device: 'dev_PC1', target: '2001:db8:1::1', count: 1 }]);
    expect(await run('ping 192.168.1.1')).toEqual(['PING: transmit failed. General failure.', '']);
  });

  it('traces to an IPv6 address from a host with no IPv4 address', async () => {
    const trace: TraceProbe[] = [1, 2, 3].map((probe) => ({
      kind: 'reply',
      hop: 1,
      probe,
      from: ip6('2001:db8:1::1'),
      timeMs: 0,
      ttl: 255,
    }));
    const { run } = await prompt(scripted([], { trace }).backend, { edit: withIpv6(undefined) });
    expect((await run('tracert 2001:db8:1::1')).slice(1, 4)).toEqual([
      'Tracing route to 2001:db8:1::1 over a maximum of 30 hops',
      '',
      '  1    <1 ms    <1 ms    <1 ms  2001:DB8:1::1',
    ]);
  });

  it('shows a SLAAC host’s address and gateway as the simulation reports them', async () => {
    const backend = { ...scripted([]).backend, ipv6Status: async () => SLAAC };
    const { run } = await prompt(backend, { edit: withIpv6({ mode: 'auto' }) });
    expect(await run('ipv6config')).toEqual([
      '',
      'Ethernet adapter FastEthernet0:',
      '',
      '   Connection-specific DNS Suffix  . :',
      `   Link-local IPv6 Address . . . . . : ${PC1_LINK_LOCAL}`,
      '   IPv6 Address. . . . . . . . . . . : 2001:DB8:1:0:FCA8:41FF:FE78:498F/64',
      '   Default Gateway . . . . . . . . . : FE80::1',
      '',
    ]);
    expect(await run('ipconfig')).toContain(
      '   IPv6 Address. . . . . . . . . . . : 2001:DB8:1:0:FCA8:41FF:FE78:498F',
    );
  });

  it('shows a SLAAC host’s link-local address alone when the simulation cannot say', async () => {
    const backend: HostBackend = {
      ...scripted([]).backend,
      ipv6Status: () => Promise.reject(new Error('IPV6CONFIG: no engine')),
    };
    const { run } = await prompt(backend, { edit: withIpv6({ mode: 'auto' }) });
    expect((await run('ipv6config')).slice(-4)).toEqual([
      `   Link-local IPv6 Address . . . . . : ${PC1_LINK_LOCAL}`,
      '   IPv6 Address. . . . . . . . . . . : ::',
      '   Default Gateway . . . . . . . . . : ::',
      '',
    ]);
  });

  it('shows a static host’s IPv6 from its config, with /all', async () => {
    const ipv6 = {
      mode: 'static' as const,
      address: { address: ip6('2001:db8:1::10'), prefixLength: 64 },
      gateway: ip6('fe80::1'),
    };
    const { run } = await prompt(scripted([]).backend, { edit: withIpv6(ipv6) });
    expect((await run('ipv6config /all')).slice(-6)).toEqual([
      '   Physical Address. . . . . . . . . : FE-A8-41-78-49-8F',
      `   Link-local IPv6 Address . . . . . : ${PC1_LINK_LOCAL}`,
      '   IPv6 Address. . . . . . . . . . . : 2001:DB8:1::10/64',
      '   Default Gateway . . . . . . . . . : FE80::1',
      '   DNS Servers . . . . . . . . . . . : ::',
      '',
    ]);
  });
});

describe('nslookup in the Command Prompt', () => {
  const SERVER = ip('192.168.1.20');

  /** A backend that answers every lookup with `answer`, or never answers. */
  function dns(answer: DnsLookup | 'hang') {
    const asked: { name: string; server: string | undefined }[] = [];
    const backend: HostBackend = {
      ...scripted([]).backend,
      nslookup: (_device, name, server) => {
        asked.push({ name, server });
        return answer === 'hang' ? new Promise(() => {}) : Promise.resolve(answer);
      },
    };
    return { backend, asked };
  }

  it('prints the server and the answer as Windows does', async () => {
    const { backend, asked } = dns({
      kind: 'answer',
      server: SERVER,
      name: 'www.lab.local',
      address: SERVER,
    });
    const { run } = await prompt(backend);
    expect(await run('nslookup WWW.lab.local')).toEqual([
      'Server:  UnKnown',
      'Address:  192.168.1.20',
      '',
      'Name:    www.lab.local',
      'Address:  192.168.1.20',
      '',
    ]);
    expect(await run('nslookup www.lab.local 10.0.0.53')).toContain('Name:    www.lab.local');
    expect(asked).toEqual([
      { name: 'www.lab.local', server: undefined },
      { name: 'www.lab.local', server: '10.0.0.53' },
    ]);
  });

  it('says when the name does not exist, the server is silent or there is none', async () => {
    const missing = await prompt(
      dns({ kind: 'not-found', server: SERVER, name: 'www.x.local' }).backend,
    );
    expect((await missing.run('nslookup www.x.local')).slice(3)).toEqual([
      "*** UnKnown can't find www.x.local: Non-existent domain",
      '',
    ]);
    const silent = await prompt(dns({ kind: 'timeout', server: SERVER }).backend);
    expect((await silent.run('nslookup www.lab.local')).slice(3)).toEqual([
      'DNS request timed out.',
      '    timeout was 2 seconds.',
      '*** Request to UnKnown timed-out',
      '',
    ]);
    const none = await prompt(dns({ kind: 'no-server' }).backend);
    expect(await none.run('nslookup www.lab.local')).toEqual([
      '*** Default servers are not available',
      '',
    ]);
    const cancelled = await prompt(dns({ kind: 'cancelled' }).backend);
    expect(await cancelled.run('nslookup www.lab.local')).toEqual(['*** Request cancelled', '']);
  });

  it('gives the prompt back on Ctrl+C while a lookup waits', async () => {
    const { type, idle, screen } = await prompt(dns('hang').backend);
    type('nslookup www.lab.local\r');
    type('\x03');
    await idle();
    expect((await screen()).slice(-4)).toEqual([
      `${PROMPT}nslookup www.lab.local`,
      '^C',
      '',
      PROMPT,
    ]);
  });
});
