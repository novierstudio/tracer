import type { DeviceId, StoredFile } from '@/model';
import { hostFiles } from '@/model/defaults';
import type { EditorStore } from '@/model/store';
import { isHostDevice } from './format';

/** A file's size as its disk counts it: UTF-8 bytes. */
export const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** `files` with `file` in it, in place of any file of the same name. */
export function withFile(files: readonly StoredFile[], file: StoredFile): StoredFile[] {
  const index = files.findIndex((candidate) => candidate.name === file.name);
  if (index < 0) return [...files, file];
  return files.map((candidate, at) => (at === index ? file : candidate));
}

/**
 * Writes `file` to a PC or server's disk as one undo step, replacing any file of that name. The
 * error words why the store refused it, such as a bad file name.
 */
export function saveHostFile(store: EditorStore, id: DeviceId, file: StoredFile) {
  const device = store.getState().topology.devices[id];
  if (!isHostDevice(device)) return;
  return store.getState().updateConfig({
    device: id,
    kind: device.kind,
    config: { ...device.config, files: withFile(hostFiles(device.config), file) },
  });
}

/** `dir` at the Command Prompt: the disk's files and their total size. */
export function formatDir(files: readonly StoredFile[]): string[] {
  const sizes = files.map((file) => byteLength(file.content));
  const total = sizes.reduce((sum, size) => sum + size, 0);
  return [
    '',
    'Volume in drive C has no label.',
    'Volume Serial Number is 5E12-4AF3',
    'Directory of C:\\',
    '',
    ...files.map(
      (file, at) => `01/01/2026  12:00 AM    ${String(sizes[at]).padStart(14)} ${file.name}`,
    ),
    `${String(files.length).padStart(16)} File(s)${String(total).padStart(15)} bytes`,
    '',
  ];
}
