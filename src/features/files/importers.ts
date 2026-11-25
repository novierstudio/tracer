import type { PktStage } from '@/importers/pkt/mapper';
import type { ImportReport } from '@/importers/pkt/report';
import { err, parseTopologyJson, type Result, type Topology } from '@/model';
import { packetTracer } from './pktImporter';

/** What the import dialog shows while a file is read. */
export type ImportStage = 'reading' | PktStage;

/** A blocking error, shown in a dialog. `detail` is technical text, shown verbatim. */
export type FileProblem = { title: string; message: string; detail?: string };

/** A report means the user reviews what was imported before the lab opens. */
export type ImportedLab = { topology: Topology; report?: ImportReport };

export type ImportContext = {
  onStage?: (stage: ImportStage) => void;
  signal?: AbortSignal;
};

export type Importer = {
  description: string;
  // Lower-case file name endings this importer reads. The longest match across importers wins,
  // so `.tracer.json` can coexist with a broader `.json`.
  extensions: readonly string[];
  // MIME type to extensions, for the browser's file picker.
  accept: Record<string, readonly string[]>;
  read(file: File, context: ImportContext): Promise<Result<ImportedLab, FileProblem>>;
};

const tracerJson: Importer = {
  description: 'Tracer lab',
  extensions: ['.tracer.json', '.json'],
  accept: { 'application/json': ['.json'] },
  async read(file) {
    const result = parseTopologyJson(await file.text());
    if (result.ok) return { ok: true, value: { topology: result.value } };
    return err({
      title: `Couldn't open ${file.name}`,
      message: "It isn't a Tracer lab that this version can read.",
      detail: result.error.message,
    });
  },
};

// A new format plugs in by adding an entry here.
export const IMPORTERS: readonly Importer[] = [tracerJson, packetTracer];

export function findImporter(
  fileName: string,
  importers: readonly Importer[] = IMPORTERS,
): Importer | undefined {
  const name = fileName.toLowerCase();
  let best: { importer: Importer; length: number } | undefined;
  for (const importer of importers) {
    for (const extension of importer.extensions) {
      if (name.endsWith(extension) && extension.length > (best?.length ?? 0)) {
        best = { importer, length: extension.length };
      }
    }
  }
  return best?.importer;
}

const anyOf = new Intl.ListFormat('en', { type: 'disjunction' });

export async function importFile(
  file: File,
  context: ImportContext = {},
  importers: readonly Importer[] = IMPORTERS,
): Promise<Result<ImportedLab, FileProblem>> {
  const title = `Couldn't open ${file.name}`;
  const importer = findImporter(file.name, importers);
  if (!importer) {
    const known = anyOf.format(importers.flatMap((i) => i.extensions));
    return err({ title, message: `Tracer can't open this kind of file. Choose a ${known} file.` });
  }
  try {
    return await importer.read(file, context);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return err({ title, message: 'The file could not be read.', detail });
  }
}

export const acceptAttribute = (importers: readonly Importer[] = IMPORTERS) =>
  importers.flatMap((i) => [...i.extensions, ...Object.keys(i.accept)]).join(',');

export const pickerTypes = (importers: readonly Importer[] = IMPORTERS) =>
  importers.map(({ description, accept }) => ({ description, accept }));
