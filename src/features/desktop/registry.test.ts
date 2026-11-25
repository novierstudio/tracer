// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { buildOffice } from '@/features/inspector/testing';
import { createIdSource } from '@/model';
import { createEditorStore } from '@/model/store';
import type { HostBackend } from './backend';
import { createHostPromptRegistry } from './registry';
import { PROMPT } from './tty';

const SIZE = { cols: 80, rows: 24 };

function setup() {
  const lab = buildOffice();
  const store = createEditorStore({ topology: lab.topology, ids: createIdSource(3) });
  const aborted = vi.fn();
  const backend: HostBackend = {
    ping: (_device, _target, _options, _onReply, signal) =>
      new Promise<void>(() => signal.addEventListener('abort', aborted)),
    arpTable: async () => [],
    clearArp: async () => {},
  };
  return { ...lab, store, aborted, prompts: createHostPromptRegistry(store, backend) };
}

describe('host prompt registry', () => {
  it('keeps each host its own prompt across selection changes', async () => {
    const { store, prompts, pc, server } = setup();
    store.getState().select({ devices: [pc.id], links: [] });
    prompts.get(pc.id)!.input('ipconfig\r', SIZE);
    store.getState().select({ devices: [server.id], links: [] });
    prompts.get(server.id)!.input('help\r', SIZE);
    store.getState().select({ devices: [pc.id], links: [] });

    const tty = prompts.get(pc.id)!;
    await vi.waitFor(() => expect(tty.transcript.endsWith(PROMPT)).toBe(true));
    expect(tty.transcript).toContain('192.168.1.10');
    expect(tty.transcript).not.toContain('Available commands');
    expect(tty.history).toEqual(['ipconfig']);
  });

  it('opens no prompt for a router or switch', () => {
    const { prompts, r1, sw } = setup();
    expect(prompts.get(r1.id)).toBeUndefined();
    expect(prompts.get(sw.id)).toBeUndefined();
  });

  it('stops a running ping and drops the prompt when the host is deleted', async () => {
    const { store, prompts, pc, aborted } = setup();
    const tty = prompts.get(pc.id)!;
    tty.input('ping -n 50 192.168.1.1\r', SIZE);
    await vi.waitFor(() => expect(tty.transcript).toContain('Pinging'));
    store.getState().removeDevices([pc.id]);
    expect(aborted).toHaveBeenCalled();
    expect(prompts.get(pc.id)).toBeUndefined();
  });
});
