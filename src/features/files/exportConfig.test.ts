import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildLab } from '@/model/testing';
import { configArchive, configArchiveName, runningConfigFiles } from './exportConfig';

describe('config export', () => {
  it("holds each router and switch's running-config, and no hosts", () => {
    const { topology } = buildLab();
    const files = runningConfigFiles(topology);
    expect(files.map((file) => file.name)).toEqual(['R1.txt', 'R2.txt', 'SW1.txt']);
    const r1 = files[0]!.text.split('\n');
    expect(r1).toContain('hostname R1');
    expect(r1).toContain('interface GigabitEthernet0/0');
    expect(r1).toContain('interface Serial0/0/0');
    expect(r1.at(-2)).toBe('end');
    expect(files[2]!.text).toContain('interface Vlan1\n no ip address');
  });

  it('zips the configs under the lab name', async () => {
    const { topology } = buildLab();
    const zip = configArchive(topology)!;
    const entries = unzipSync(new Uint8Array(await zip.arrayBuffer()));
    expect(Object.keys(entries)).toEqual(['R1.txt', 'R2.txt', 'SW1.txt']);
    expect(strFromU8(entries['R2.txt']!)).toContain('hostname R2');
    expect(configArchiveName('CCNA 1: Lab 4')).toBe('CCNA 1- Lab 4 configs.zip');
  });

  it('gives devices that share a hostname their own files', () => {
    const { topology, r1, r2 } = buildLab();
    const r2Renamed = { ...r2, config: { ...r2.config, hostname: r1.config.hostname } };
    const names = runningConfigFiles({
      ...topology,
      devices: { ...topology.devices, [r2.id]: r2Renamed },
    }).map((file) => file.name);
    expect(names).toEqual(['R1.txt', 'R1 (2).txt', 'SW1.txt']);
  });

  it('has nothing to export for a lab of hosts', () => {
    const { topology, pc } = buildLab();
    expect(configArchive({ ...topology, devices: { [pc.id]: pc } })).toBeUndefined();
  });
});
