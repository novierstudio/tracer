// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encryptPkt } from '@/importers/pkt/codec';
import { err, ok, serializeTopology } from '@/model';
import { buildLab } from '@/model/testing';
import {
  acceptAttribute,
  findImporter,
  importFile,
  type ImportStage,
  type Importer,
} from './importers';
import { describePktError, labNameFromFile, packetTracer } from './pktImporter';

const fake: Importer = {
  description: 'Fake',
  extensions: ['.fake'],
  accept: { 'application/x-fake': ['.fake'] },
  read: async () => err({ title: 'no', message: 'not yet' }),
};
const anyJson: Importer = { ...fake, description: 'JSON', extensions: ['.json'] };
const tracer: Importer = { ...fake, description: 'Tracer', extensions: ['.tracer.json'] };

const fixture = (name: string) =>
  new File(
    [readFileSync(new URL(`../../importers/pkt/__fixtures__/${name}`, import.meta.url))],
    name,
  );

describe('importer registry', () => {
  it('picks the importer by file extension, ignoring case', () => {
    const registry = [tracer, fake];
    expect(findImporter('lab.tracer.json', registry)).toBe(tracer);
    expect(findImporter('Lab.FAKE', registry)).toBe(fake);
    expect(findImporter('notes.txt', registry)).toBeUndefined();
  });

  it('prefers the longest matching extension whatever the registry order', () => {
    expect(findImporter('lab.tracer.json', [anyJson, tracer])).toBe(tracer);
    expect(findImporter('data.json', [anyJson, tracer])).toBe(anyJson);
  });

  it('reads Packet Tracer networks and activities', () => {
    expect(findImporter('EIGRP Lab.pkt')).toBe(packetTracer);
    expect(findImporter('Activity 1.1.PKA')).toBe(packetTracer);
    expect(acceptAttribute().split(',')).toEqual(expect.arrayContaining(['.pkt', '.pka']));
  });

  it('hands the file to the chosen importer', async () => {
    const custom: Importer = { ...fake, read: async () => ok({ topology: buildLab().topology }) };
    const result = await importFile(new File(['x'], 'a.fake'), {}, [tracer, custom]);
    expect(result.ok).toBe(true);
  });

  it('reads native files with the built-in registry', async () => {
    const { topology } = buildLab();
    const file = new File([serializeTopology(topology)], 'lab.tracer.json');
    expect(await importFile(file)).toEqual(ok({ topology }));
  });

  it('rejects a file no importer reads and names the ones it does', async () => {
    const result = await importFile(new File(['x'], 'photo.png'));
    expect(result).toEqual(
      err({
        title: "Couldn't open photo.png",
        message: expect.stringContaining('.tracer.json, .json, .pkt, or .pka'),
      }),
    );
  });
});

describe('Packet Tracer importer', () => {
  it('imports a .pkt with its report, named after the file, announcing each stage', async () => {
    const stages: ImportStage[] = [];
    const result = await importFile(fixture('pt8.2-vtp-lab.pkt'), {
      onStage: (stage) => stages.push(stage),
    });
    if (!result.ok) throw new Error(result.error.message);
    const { topology, report } = result.value;
    expect(topology.meta.name).toBe('pt8.2-vtp-lab');
    expect(Object.values(topology.devices).map((d) => d.kind)).toEqual([
      'switch',
      'switch',
      'switch',
    ]);
    expect(report).toMatchObject({
      ptVersion: '8.2.2.0400',
      devices: { imported: 3, skipped: 1 },
    });
    expect(stages).toEqual(['reading', 'decrypting', 'decompressing', 'mapping']);
  });

  it('explains that a random file is not a Packet Tracer file', async () => {
    const result = await importFile(new File([new Uint8Array(512).fill(42)], 'notes.pkt'));
    expect(!result.ok && result.error.title).toBe('Not a Packet Tracer file');
  });

  it('tells a damaged file from an unsupported version', async () => {
    const xml = (body: string) => new File([encryptPkt(body).slice()], 'lab.pkt');
    const damaged = await importFile(xml('<PACKETTRACER5><<<'));
    expect(!damaged.ok && damaged.error.title).toBe('This file is damaged');
    const unknown = await importFile(xml('<PACKETTRACER9><VERSION>12.0</VERSION></PACKETTRACER9>'));
    expect(!unknown.ok && unknown.error.title).toBe('Unsupported Packet Tracer version');
  });

  it.each([
    [
      { kind: 'decrypt-failed', error: { kind: 'too-short', length: 3 } },
      'Not a Packet Tracer file',
    ],
    [{ kind: 'decrypt-failed', error: { kind: 'bad-tag' } }, 'Not a Packet Tracer file'],
    [
      { kind: 'decrypt-failed', error: { kind: 'bad-zlib', format: 'modern', message: 'x' } },
      'This file is damaged',
    ],
    [{ kind: 'invalid-xml', message: 'x' }, 'This file is damaged'],
    [{ kind: 'not-packet-tracer' }, 'Unsupported Packet Tracer version'],
  ] as const)('describes %j as “%s”', (error, title) => {
    expect(describePktError(error, 'lab.pkt').title).toBe(title);
  });

  it('names the lab after the file', () => {
    expect(labNameFromFile('EIGRP Lab 1 - initial lab.pkt')).toBe('EIGRP Lab 1 - initial lab');
    expect(labNameFromFile('Activity 1.1.pka')).toBe('Activity 1.1');
    expect(labNameFromFile('.pkt')).toBe('.pkt');
  });
});
