// @vitest-environment node
import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { createIdSource } from '@/model';
import { createEditorStore } from '@/model/store';
import { buildLab } from '@/model/testing';
import { createConsoleRegistry } from './registry';
import { createTty, TRANSCRIPT_LIMIT } from './tty';

const SIZE = { cols: 80, rows: 24 };

/** The rows a terminal shows after writing `transcript`, as a view replaying it would. */
async function rows(transcript: string): Promise<string[]> {
  const term = new Terminal({ ...SIZE, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(transcript, resolve));
  const buffer = term.buffer.active;
  const lines = Array.from({ length: buffer.length }, (_, y) =>
    buffer.getLine(y)!.translateToString(true).trimEnd(),
  );
  return lines.slice(0, buffer.baseY + buffer.cursorY + 1);
}

function setup() {
  const lab = buildLab();
  const store = createEditorStore({ topology: lab.topology, ids: createIdSource(3) });
  return { ...lab, store, consoles: createConsoleRegistry(store) };
}

describe('console registry', () => {
  it('keeps each device its own console across selection changes', async () => {
    const { store, consoles, r1, sw } = setup();
    store.getState().select({ devices: [r1.id], links: [] });
    consoles.get(r1.id)!.input('en\r', SIZE);

    store.getState().select({ devices: [sw.id], links: [] });
    consoles.get(sw.id)!.input('en\r', SIZE);
    store.getState().select({ devices: [r1.id], links: [] });

    const console = consoles.get(r1.id)!;
    expect(await rows(console.transcript)).toEqual(['R1>en', 'R1#']);
    expect(console.history).toEqual(['en']);
    expect(await rows(consoles.get(sw.id)!.transcript)).toEqual(['SW1>en', 'SW1#']);
  });

  it('drops a console when its device is deleted, and opens a fresh one after undo', () => {
    const { store, consoles, r1 } = setup();
    const before = consoles.get(r1.id)!;
    before.input('en\r', SIZE);

    store.getState().removeDevices([r1.id]);
    expect(consoles.get(r1.id)).toBeUndefined();

    store.getState().undo();
    const after = consoles.get(r1.id)!;
    expect(after).not.toBe(before);
    expect(after.transcript).toBe('R1>');
  });

  it('opens no console on a PC or server', () => {
    const { consoles, pc, server } = setup();
    expect(consoles.get(pc.id)).toBeUndefined();
    expect(consoles.get(server.id)).toBeUndefined();
  });

  it('commits a config line to the store as one undo step', () => {
    const { store, consoles, r1 } = setup();
    consoles.get(r1.id)!.input('en\rconf t\rhostname EDGE\rend\r', SIZE);

    expect(store.getState().topology.devices[r1.id]?.config.hostname).toBe('EDGE');
    store.getState().undo();
    expect(store.getState().topology.devices[r1.id]?.config.hostname).toBe('R1');
  });

  it('asks for the console password and never prints it', async () => {
    const { store, consoles, r1 } = setup();
    consoles.get(r1.id)!.input('en\rconf t\rline con 0\rpassword s3cret\rlogin\rend\r', SIZE);
    store.getState().removeDevices([r1.id]);
    store.getState().undo();

    const console = consoles.get(r1.id)!;
    const greeting = ['', 'User Access Verification', ''];
    expect(await rows(console.transcript)).toEqual([...greeting, 'Password:']);
    console.input('s3cret\r', SIZE);
    expect(await rows(console.transcript)).toEqual([...greeting, 'Password:', 'R1>']);
    expect(console.transcript).not.toContain('s3cret');
    expect(console.history).toEqual([]);
  });
});

describe('tty', () => {
  it('sends new output to every view, and a late view replays the transcript', async () => {
    const { r1, consoles } = setup();
    const tty = consoles.get(r1.id)!;
    const first: string[] = [];
    const stop = tty.subscribe((out) => first.push(out));
    tty.input('en', SIZE);
    stop();
    tty.input('\r', SIZE);

    expect(first.join('')).toBe('en');
    expect(await rows(tty.transcript)).toEqual(['R1>en', 'R1#']);
  });

  it('keeps the transcript under its limit, cut at a line break', () => {
    const session = {
      prompt: '> ',
      masked: false,
      run: () => ['x'.repeat(1000)],
      help: () => [],
      complete: () => ({ line: undefined, candidates: [] }),
      end: () => [],
    };
    const tty = createTty(session);
    for (let i = 0; i < 600; i++) tty.input('\r', { cols: 2000, rows: 2000 });
    expect(tty.transcript.length).toBeLessThanOrEqual(TRANSCRIPT_LIMIT);
    expect(tty.transcript).toMatch(/^(x|> )/);
  });
});
