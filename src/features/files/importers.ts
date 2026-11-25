import { err, parseTopologyJson, type Result, type Topology } from '@/model';

export type Importer = {
  description: string;
  // Lower-case file name endings this importer reads. The longest match across importers wins,
  // so `.tracer.json` can coexist with a broader `.json`.
  extensions: readonly string[];
  // MIME type to extensions, for the browser's file picker.
  accept: Record<string, readonly string[]>;
  read(file: Blob): Promise<Result<Topology, string>>;
};

const tracerJson: Importer = {
  description: 'Tracer lab',
  extensions: ['.tracer.json', '.json'],
  accept: { 'application/json': ['.json'] },
  async read(file) {
    const result = parseTopologyJson(await file.text());
    return result.ok ? result : err(result.error.message);
  },
};

// A new format (such as `.pkt`) plugs in by adding an entry here.
export const IMPORTERS: readonly Importer[] = [tracerJson];

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

export async function importFile(
  file: File,
  importers: readonly Importer[] = IMPORTERS,
): Promise<Result<Topology, string>> {
  const importer = findImporter(file.name, importers);
  if (!importer) {
    const known = importers.map((i) => i.extensions[0]).join(', ');
    return err(`Tracer can't open this kind of file. Choose a ${known} file.`);
  }
  try {
    return await importer.read(file);
  } catch (error) {
    return err(`The file could not be read: ${error instanceof Error ? error.message : error}`);
  }
}

export const acceptAttribute = (importers: readonly Importer[] = IMPORTERS) =>
  importers.flatMap((i) => [...i.extensions, ...Object.keys(i.accept)]).join(',');

export const pickerTypes = (importers: readonly Importer[] = IMPORTERS) =>
  importers.map(({ description, accept }) => ({ description, accept }));
