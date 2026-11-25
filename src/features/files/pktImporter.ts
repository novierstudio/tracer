import type { PktImportError } from '@/importers/pkt/mapper';
import { err } from '@/model';
import { importPktInWorker } from '@/workers/importClient';
import type { FileProblem, Importer } from './importers';

/** "EIGRP Lab 1.pkt" opens as "EIGRP Lab 1". */
export function labNameFromFile(fileName: string): string {
  return fileName.replace(/\.[^.]*$/, '').trim() || fileName;
}

export function describePktError(error: PktImportError, fileName: string): FileProblem {
  if (error.kind === 'invalid-xml') {
    return {
      title: 'This file is damaged',
      message: `“${fileName}” opened as a Packet Tracer file, but its contents are broken. Try saving it again from Packet Tracer.`,
      detail: error.message,
    };
  }
  if (error.kind === 'not-packet-tracer') {
    return {
      title: 'Unsupported Packet Tracer version',
      message: `“${fileName}” opened, but it isn't laid out like the Packet Tracer 5.2 to 9.0 files that Tracer reads.`,
    };
  }
  const decrypt = error.error;
  if (decrypt.kind === 'bad-zlib') {
    return {
      title: 'This file is damaged',
      message: `“${fileName}” is a Packet Tracer file, but part of it is corrupt, so it can't be opened. Try saving it again from Packet Tracer.`,
      detail: decrypt.message,
    };
  }
  return {
    title: 'Not a Packet Tracer file',
    message: `Tracer couldn't decrypt “${fileName}”. It isn't a file saved by Cisco Packet Tracer, or it was damaged or cut short on the way.`,
  };
}

export const packetTracer: Importer = {
  description: 'Packet Tracer file',
  extensions: ['.pkt', '.pka'],
  accept: { 'application/x-packet-tracer': ['.pkt', '.pka'] },
  async read(file, { onStage = () => {}, signal }) {
    onStage('reading');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await importPktInWorker(bytes, {
      name: labNameFromFile(file.name),
      onStage,
      signal,
    });
    return result.ok ? result : err(describePktError(result.error, file.name));
  },
};
