import { describe, expect, it } from 'vitest';
import type { Frame } from '@/engine/frame';
import type { TcpPayload } from '@/engine/tcp';
import { describeFrame, protocolOf } from './protocols';

/** One segment from a client to a router's port, carrying `payload`. */
function segment(dstPort: number, payload: TcpPayload): Frame {
  return {
    kind: 'hdlc',
    payload: {
      kind: 'ipv4',
      src: '10.0.0.10' as never,
      dst: '10.0.0.1' as never,
      ttl: 128,
      id: 1,
      payload: {
        kind: 'tcp',
        srcPort: 50000,
        dstPort,
        seq: 1,
        ack: 1,
        flags: { syn: false, ack: true, fin: false, rst: false, psh: true },
        window: 65535,
        payload,
      },
    },
  };
}

describe('Telnet and SSH in the event list', () => {
  it('shows what Telnet carries, and only the size of what SSH carries', () => {
    const telnet = segment(23, { kind: 'telnet', text: 'enable' });
    const ssh = segment(22, { kind: 'ssh', bytes: 36 });
    expect(protocolOf(telnet)).toBe('telnet');
    expect(protocolOf(ssh)).toBe('ssh');
    expect(describeFrame({ frame: telnet, outcome: 'delivered' })).toBe('Telnet: enable');
    expect(describeFrame({ frame: ssh, outcome: 'delivered' })).toBe('SSH: encrypted, 36 bytes');
  });
});
