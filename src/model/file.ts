import { z } from 'zod';
import { err, ok, type Result } from './result';
import { TOPOLOGY_VERSION, Topology } from './topology';

export type TopologyFileError =
  | { kind: 'invalid-json'; message: string }
  | { kind: 'unsupported-version'; version: unknown; message: string }
  | { kind: 'invalid-topology'; message: string };

const MIGRATIONS: Record<number, (document: unknown) => unknown> = {};

export function parseTopology(input: unknown): Result<Topology, TopologyFileError> {
  const header = z.object({ version: z.int() }).safeParse(input);
  if (!header.success) {
    return err({
      kind: 'unsupported-version',
      version: undefined,
      message: 'This is not a Tracer topology: it has no version number',
    });
  }

  let { version } = header.data;
  let document = input;
  while (version < TOPOLOGY_VERSION) {
    const migrate = MIGRATIONS[version];
    if (!migrate) break;
    document = migrate(document);
    version += 1;
  }
  if (version !== TOPOLOGY_VERSION) {
    return err({
      kind: 'unsupported-version',
      version: header.data.version,
      message: `This topology is version ${header.data.version}, and this build of Tracer reads version ${TOPOLOGY_VERSION}`,
    });
  }

  const parsed = Topology.safeParse(document);
  if (!parsed.success) {
    return err({ kind: 'invalid-topology', message: z.prettifyError(parsed.error) });
  }
  return ok(parsed.data);
}

export function parseTopologyJson(text: string): Result<Topology, TopologyFileError> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return err({
      kind: 'invalid-json',
      message: `The file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  return parseTopology(data);
}

export function serializeTopology(topology: Topology): string {
  return JSON.stringify(topology, null, 2);
}
