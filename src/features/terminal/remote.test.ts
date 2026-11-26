// @vitest-environment node
import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { applyLines, type IosDevice } from '@/cli';
import { ms } from '@/engine/core/time';
import { createEngine } from '@/engine/engine';
import { diffTopology } from '@/engine/patch';
import { createSimService } from '@/engine/service';
import { STACKS } from '@/engine/stacks';
import { labBuilder } from '@/engine/testing';
import { createIdSource, type DeviceId } from '@/model';
import { createEditorStore } from '@/model/store';
import { createConsoleRegistry } from './registry';
import { createVtyRegistry } from './remote';
import type { SimLink } from './session';
import type { Tty } from './tty';

const SIZE = { cols: 100, rows: 300 };

async function rows(tty: Tty): Promise<string[]> {
  const term = new Terminal({ ...SIZE, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(tty.transcript, resolve));
  const buffer = term.buffer.active;
  const lines = Array.from({ length: buffer.length }, (_, y) =>
    buffer.getLine(y)!.translateToString(true).trimEnd(),
  );
  return lines.slice(0, buffer.baseY + buffer.cursorY + 1);
}

const VTY = ['line vty 0 15', ' password cisco', ' login'];

/**
 * R1 Gi0/0 10.0.12.1 to R2 Gi0/0 10.0.12.2, and R2 Gi0/1 10.0.23.2 to R3 Gi0/0 10.0.23.3. R2 takes
 * Telnet with the line password cisco; R3 takes SSH only, for the local user admin.
 */
function lab() {
  const build = labBuilder();
  const r1 = build.router('R1', { 'GigabitEthernet0/0': '10.0.12.1/24' });
  const r2 = build.router('R2', {
    'GigabitEthernet0/0': '10.0.12.2/24',
    'GigabitEthernet0/1': '10.0.23.2/24',
  });
  const r3 = build.router('R3', { 'GigabitEthernet0/0': '10.0.23.3/24' });
  const configure = (id: DeviceId, lines: readonly string[]) =>
    build.edit(id, (device) => {
      const { config, errors } = applyLines(device as IosDevice, lines);
      if (errors.length > 0) throw new Error(JSON.stringify(errors));
      return { ...device, config } as typeof device;
    });
  configure(r2, VTY);
  configure(r3, [
    'ip domain-name lab.local',
    'crypto key generate rsa general-keys modulus 1024',
    'ip ssh version 2',
    'username admin privilege 15 secret class',
    'line vty 0 4',
    ' transport input ssh',
    ' login local',
    'line vty 5 15',
    ' transport input none',
  ]);
  build.connect(r1, 'GigabitEthernet0/0', r2, 'GigabitEthernet0/0');
  build.connect(r2, 'GigabitEthernet0/1', r3, 'GigabitEthernet0/0');

  const store = createEditorStore({ topology: build.topology, ids: createIdSource(4) });
  const engine = createEngine({ seed: 1, stacks: STACKS, linkDelay: ms(1) });
  const sim = createSimService({ engine, frames: { now: () => 0, request: () => {} } });
  let synced = build.topology;
  sim.load(synced);
  store.subscribe(({ topology }) => {
    const patch = diffTopology(synced, topology);
    synced = topology;
    if (patch) sim.applyPatch(patch);
  });
  const link = {
    portStates: async (device: DeviceId) => sim.portStates(device),
    now: () => engine.now,
    openTerminal: async (...args: Parameters<typeof sim.openTerminal>) => sim.openTerminal(...args),
    terminalSend: async (handle: never, text: string) => sim.terminalSend(handle, text),
    terminalClose: async (handle: never, server: DeviceId | undefined) =>
      sim.terminalClose(handle, server),
  } as unknown as SimLink;
  const vty = createVtyRegistry();
  const consoles = createConsoleRegistry(store, async () => link, vty);

  /** Types a line and runs the simulation until the console shows a prompt again. */
  const type = async (tty: Tty, line: string) => {
    const before = tty.transcript.length;
    tty.input(`${line}\r`, SIZE);
    for (let i = 0; i < 5000; i++) {
      const added = tty.transcript.slice(before);
      if (/(?:[>#]|Password: |Username: )$/.test(added) && added.includes('\r\n')) return;
      if (engine.nextTime() !== undefined) engine.step();
      await new Promise(setImmediate);
    }
  };
  return { consoles, r1, r2, r3, vty, engine, type };
}

describe('Telnet and SSH between routers', () => {
  it('hops R1 to R2 by Telnet and on to R3 by SSH, and exit returns hop by hop', async () => {
    const { consoles, r1, r2, r3, vty, type } = lab();
    const tty = consoles.get(r1)!;

    await type(tty, 'telnet 10.0.12.2');
    await type(tty, 'cisco');
    expect(await rows(tty)).toEqual([
      'R1>telnet 10.0.12.2',
      'Trying 10.0.12.2 ...Open',
      '',
      'User Access Verification',
      '',
      'Password:',
      'R2>',
    ]);
    expect(vty.list(r2)).toEqual([{ line: 0, protocol: 'telnet', peer: '10.0.12.1' }]);

    await type(tty, 'ssh -l admin 10.0.23.3');
    await type(tty, 'class');
    await type(tty, 'show users');
    expect((await rows(tty)).slice(6)).toEqual([
      'R2>ssh -l admin 10.0.23.3',
      '',
      'Password:',
      'R3#show users',
      '    Line       User       Host(s)              Idle       Location',
      '*  2 vty 0     admin      idle                 00:00:00 10.0.23.2',
      '',
      '  Interface    User               Mode         Idle     Peer Address',
      '',
      'R3#',
    ]);

    await type(tty, 'exit');
    expect((await rows(tty)).slice(-3)).toEqual([
      '',
      '[Connection to 10.0.23.3 closed by foreign host]',
      'R2>',
    ]);
    expect(vty.list(r3)).toEqual([]);
    await type(tty, 'exit');
    expect((await rows(tty)).slice(-3)).toEqual([
      '',
      '[Connection to 10.0.12.2 closed by foreign host]',
      'R1>',
    ]);
    expect(vty.list(r2)).toEqual([]);
  });

  it('refuses Telnet to a router that takes SSH only, and SSH to one with no keys', async () => {
    const { consoles, r2, type } = lab();
    const tty = consoles.get(r2)!;
    await type(tty, 'telnet 10.0.23.3');
    await type(tty, 'ssh -l admin 10.0.12.1');
    expect(await rows(tty)).toEqual([
      'R2>telnet 10.0.23.3',
      'Trying 10.0.23.3 ...',
      '% Connection refused by remote host',
      'R2>ssh -l admin 10.0.12.1',
      '% Connection refused by remote host',
      'R2>',
    ]);
  });

  it('hangs up after three wrong passwords, and on a line with no password', async () => {
    const { consoles, r1, r2, type } = lab();
    const tty = consoles.get(r1)!;
    await type(tty, 'telnet 10.0.12.2');
    for (const guess of ['a', 'b', 'c']) await type(tty, guess);
    expect((await rows(tty)).slice(-5)).toEqual([
      'Password:',
      '% Bad passwords',
      '',
      '[Connection to 10.0.12.2 closed by foreign host]',
      'R1>',
    ]);

    // R1's vty lines keep the factory `login` with no password.
    const r2tty = consoles.get(r2)!;
    await type(r2tty, 'telnet 10.0.12.1');
    expect(await rows(r2tty)).toEqual([
      'R2>telnet 10.0.12.1',
      'Trying 10.0.12.1 ...Open',
      '',
      'Password required, but none set',
      '',
      '[Connection to 10.0.12.1 closed by foreign host]',
      'R2>',
    ]);
  });
});
