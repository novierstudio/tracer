// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { err, ok, serializeTopology } from '@/model';
import { buildLab } from '@/model/testing';
import { findImporter, importFile, IMPORTERS, type Importer } from './importers';

const pkt: Importer = {
  description: 'Packet Tracer',
  extensions: ['.pkt'],
  accept: { 'application/octet-stream': ['.pkt'] },
  read: async () => err('not yet'),
};
const anyJson: Importer = { ...pkt, description: 'JSON', extensions: ['.json'] };
const tracer: Importer = { ...pkt, description: 'Tracer', extensions: ['.tracer.json'] };

describe('importer registry', () => {
  it('picks the importer by file extension, ignoring case', () => {
    const registry = [tracer, pkt];
    expect(findImporter('lab.tracer.json', registry)).toBe(tracer);
    expect(findImporter('EIGRP Lab.PKT', registry)).toBe(pkt);
    expect(findImporter('notes.txt', registry)).toBeUndefined();
  });

  it('prefers the longest matching extension whatever the registry order', () => {
    expect(findImporter('lab.tracer.json', [anyJson, tracer])).toBe(tracer);
    expect(findImporter('data.json', [anyJson, tracer])).toBe(anyJson);
  });

  it('hands the file to the chosen importer', async () => {
    const custom: Importer = { ...pkt, read: async () => ok(buildLab().topology) };
    const result = await importFile(new File(['x'], 'a.pkt'), [tracer, custom]);
    expect(result.ok).toBe(true);
  });

  it('reads native files with the built-in registry', async () => {
    const { topology } = buildLab();
    const file = new File([serializeTopology(topology)], 'lab.tracer.json');
    expect(await importFile(file, IMPORTERS)).toEqual(ok(topology));
  });

  it('rejects a file no importer reads', async () => {
    const result = await importFile(new File(['x'], 'photo.png'), IMPORTERS);
    expect(result.ok).toBe(false);
  });
});
