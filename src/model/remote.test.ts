// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { addLink } from './commands';
import { LinkId } from './ids';
import { consolePeer, sshEnabled, vtyLineFor } from './remote';
import { end, buildLab } from './testing';
import { factoryRouterLines, RouterConfig, Topology, type LineConfig } from './topology';

const consoleLink = (id: string, a: ReturnType<typeof end>, b: ReturnType<typeof end>) => ({
  id: LinkId.parse(`lnk_${id}`),
  cable: 'console' as const,
  a,
  b,
});

describe('console cables', () => {
  it("joins a PC's RS232 port to a router's Console port, and the file reads back", () => {
    const { topology, pc, r1 } = buildLab();
    const result = addLink(topology, consoleLink('c1', end(pc, 'RS232'), end(r1, 'Console')));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const saved = JSON.parse(JSON.stringify(result.value));
    expect(Topology.parse(saved).links).toEqual(result.value.links);
    expect(consolePeer(result.value, pc.id)).toEqual(end(r1, 'Console'));
    expect(consolePeer(result.value, r1.id)).toEqual(end(pc, 'RS232'));
  });

  it('refuses two Console ports, a network port, and a server, which has no RS232 port', () => {
    const { topology, pc, r1, sw, server } = buildLab();
    const refused = [
      consoleLink('c1', end(sw, 'Console'), end(r1, 'Console')),
      consoleLink('c2', end(pc, 'RS232'), end(r1, 'GigabitEthernet0/0')),
      consoleLink('c3', end(server, 'RS232'), end(r1, 'Console')),
    ];
    expect(refused.map((link) => addLink(topology, link))).toMatchObject([
      { ok: false, error: { kind: 'cable-mismatch' } },
      { ok: false, error: { kind: 'cable-mismatch' } },
      { ok: false, error: { kind: 'port-not-found' } },
    ]);
  });

  it('leaves the PC unconnected until a console cable is in', () => {
    const { topology, pc } = buildLab();
    expect(consolePeer(topology, pc.id)).toBeUndefined();
  });
});

describe('vty lines', () => {
  const lines = (edit: (line: LineConfig, n: number) => LineConfig) =>
    factoryRouterLines().vty.map(edit);

  it('takes the lowest free line whose transport input lets the protocol in', () => {
    const sshOnly = lines((line, n) =>
      n < 5 ? { ...line, transportInput: { ssh: true, telnet: false } } : line,
    );
    expect(vtyLineFor(sshOnly, 'ssh', new Set())).toBe(0);
    expect(vtyLineFor(sshOnly, 'ssh', new Set([0, 1]))).toBe(2);
    // Lines 5 to 15 still take Telnet, as on IOS when only `line vty 0 4` was changed.
    expect(vtyLineFor(sshOnly, 'telnet', new Set())).toBe(5);
  });

  it('refuses when no line takes the protocol', () => {
    const none = lines((line) => ({ ...line, transportInput: { ssh: false, telnet: false } }));
    expect(vtyLineFor(none, 'telnet', new Set())).toBeUndefined();
  });

  it('runs SSH once RSA keys exist, and version 2 only with keys of 768 bits or more', () => {
    const config = RouterConfig.parse({ hostname: 'R1', interfaces: {}, unknownLines: [] });
    expect(sshEnabled(config)).toBe(false);
    expect(sshEnabled({ ...config, rsaModulus: 512 })).toBe(true);
    expect(sshEnabled({ ...config, rsaModulus: 512, sshVersion: 2 })).toBe(false);
    expect(sshEnabled({ ...config, rsaModulus: 1024, sshVersion: 2 })).toBe(true);
  });
});
