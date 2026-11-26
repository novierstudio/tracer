import { z } from 'zod';
import { copperCable, copperWorks } from './cabling';
import { err, ok, type Result } from './result';
import {
  TOPOLOGY_VERSION,
  Topology,
  type DeviceKind,
  type PortId,
  type PortKind,
} from './topology';

export type TopologyFileError =
  | { kind: 'invalid-json'; message: string }
  | { kind: 'unsupported-version'; version: unknown; message: string }
  | { kind: 'invalid-topology'; message: string };

type RawEnd = { device?: unknown; port?: unknown };
type RawLink = { cable?: unknown; a?: RawEnd; b?: RawEnd };
type RawDocument = {
  devices?: Record<
    string,
    { kind?: unknown; ports?: { id?: unknown; kind?: unknown }[] } | undefined
  >;
  links?: Record<string, RawLink | undefined>;
};

/**
 * Version 1 ran auto-MDIX on every port, so a copper link worked on either cable. One that would
 * not work now moves to the right cable, so the lab runs as it did. Anything malformed is left
 * for the schema to report.
 */
function endAutoMdix(document: unknown): unknown {
  const { devices = {}, links = {} } = (document ?? {}) as RawDocument;
  const end = (raw: RawEnd | undefined) => {
    const device = typeof raw?.device === 'string' ? devices[raw.device] : undefined;
    const portKind = device?.ports?.find((port) => port.id === raw?.port)?.kind;
    return typeof device?.kind === 'string' && typeof portKind === 'string'
      ? {
          kind: device.kind as DeviceKind,
          port: raw!.port as PortId,
          portKind: portKind as PortKind,
        }
      : undefined;
  };
  const migrated = Object.fromEntries(
    Object.entries(links).map(([id, link]) => {
      if (link?.cable !== 'straight' && link?.cable !== 'crossover') return [id, link];
      const a = end(link.a);
      const b = end(link.b);
      if (!a || !b || copperWorks(link.cable, a, b)) return [id, link];
      return [id, { ...link, cable: copperCable(a, b) }];
    }),
  );
  return { ...(document as object), version: 2, links: migrated };
}

const MIGRATIONS: Record<number, (document: unknown) => unknown> = { 1: endAutoMdix };

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
