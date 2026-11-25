import { strToU8, zipSync } from 'fflate';
import { runningConfig, type IosDevice } from '@/cli';
import type { Device, Topology } from '@/model';
import { fileNameFor } from './fileAccess';

export type ConfigFile = { name: string; text: string };

const isIos = (device: Device): device is IosDevice =>
  device.kind === 'router' || device.kind === 'switch';

/** One `<hostname>.txt` per router and switch, holding its `show running-config`, by hostname. */
export function runningConfigFiles(topology: Topology): ConfigFile[] {
  const devices = Object.values(topology.devices)
    .filter(isIos)
    .sort((a, b) => a.config.hostname.localeCompare(b.config.hostname));
  const taken = new Map<string, number>();
  return devices.map((device) => {
    const base = fileNameFor(device.config.hostname, '');
    const count = (taken.get(base.toLowerCase()) ?? 0) + 1;
    taken.set(base.toLowerCase(), count);
    const name = count === 1 ? `${base}.txt` : `${base} (${count}).txt`;
    return { name, text: `${runningConfig(device).join('\n')}\n` };
  });
}

/** A zip of every router and switch running-config, or undefined when the lab has none. */
export function configArchive(topology: Topology): Blob | undefined {
  const files = runningConfigFiles(topology);
  if (files.length === 0) return undefined;
  const zip = zipSync(Object.fromEntries(files.map(({ name, text }) => [name, strToU8(text)])));
  return new Blob([zip], { type: 'application/zip' });
}

export const configArchiveName = (labName: string) => fileNameFor(labName, ' configs.zip');
