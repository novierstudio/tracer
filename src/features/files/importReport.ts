// Turns an ImportReport into what the import report dialog lists: counts, then groups of details.
import type { ImportReport, LinkDropReason, PtLinkEnd } from '@/importers/pkt/report';
import type { Cable, DeviceId, DeviceKind, Topology } from '@/model';

export type ReportItem = {
  readonly label: string;
  /** Config lines, listed verbatim under the label. */
  readonly lines?: readonly string[];
};

export type ReportGroupId =
  | 'skipped-devices'
  | 'dropped-links'
  | 'renamed'
  | 'approximated'
  | 'skipped-settings'
  | 'config-kept';

export type ReportGroup = {
  readonly id: ReportGroupId;
  readonly title: string;
  readonly hint: string;
  /** Devices, links, lines or changes, whichever the group lists. */
  readonly count: number;
  readonly items: readonly ReportItem[];
};

export type ReportSummary = {
  readonly devices: ImportReport['devices'];
  readonly links: ImportReport['links'];
  readonly configLinesKept: number;
  /** Only groups with something in them, in the order of GROUPS. */
  readonly groups: readonly ReportGroup[];
};

const GROUPS: readonly { id: ReportGroupId; title: string; hint: string }[] = [
  {
    id: 'skipped-devices',
    title: 'Skipped devices',
    hint: 'Tracer has no device of these types yet, so they were left out.',
  },
  {
    id: 'dropped-links',
    title: 'Dropped links',
    hint: 'These cables could not be connected in Tracer.',
  },
  {
    id: 'renamed',
    title: 'Renamed hostnames',
    hint: 'Hostnames must be unique and cannot contain spaces.',
  },
  {
    id: 'approximated',
    title: 'Approximations',
    hint: 'Imported as the closest thing Tracer has.',
  },
  {
    id: 'skipped-settings',
    title: 'Skipped ports and settings',
    hint: 'Ports Tracer has no kind for, and values that did not parse.',
  },
  {
    id: 'config-kept',
    title: 'Config lines kept as-is',
    hint: "Tracer didn't recognize these running-config lines. They stay on the device unchanged.",
  },
];

const KIND_NAME: Record<DeviceKind, string> = {
  router: 'router',
  switch: 'switch',
  pc: 'PC',
  server: 'server',
  hub: 'hub',
  accessPoint: 'access point',
  wirelessRouter: 'wireless router',
  lightweightAp: 'lightweight AP',
  wlc: 'wireless LAN controller',
  cellTower: 'cell tower',
  centralOffice: 'central office server',
};

const CABLE_NAME: Record<Cable, string> = {
  straight: 'straight-through',
  crossover: 'crossover',
  fiber: 'fiber',
  coaxial: 'coaxial',
  serial: 'serial',
  console: 'console',
};

const FIELD_NAME = { ipv4: 'IPv4 address', gateway: 'gateway', dns: 'DNS server' } as const;

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** "Switch0 FastEthernet0/1", or just the device when the file names no port. */
const at = (device: string, port: string) => [device, port].filter(Boolean).join(' ');

const endName = (end: PtLinkEnd) => at(end.device, end.port);

function dropReason(reason: LinkDropReason): string {
  switch (reason.kind) {
    case 'device-not-found':
      return 'its device is missing from the file';
    case 'device-skipped':
      return 'a device on it was skipped';
    case 'port-not-imported':
      return 'a port on it was not imported';
    case 'invalid':
      if (reason.error.kind === 'port-in-use') return 'the port already has a cable';
      if (reason.error.kind === 'cable-mismatch') {
        return `a ${CABLE_NAME[reason.error.cable]} cable does not fit these ports`;
      }
      return 'the link is not valid';
  }
}

export function summarizeReport(report: ImportReport, topology: Topology): ReportSummary {
  const name = (id: DeviceId) => topology.devices[id]?.config.hostname ?? id;
  const buckets = new Map<ReportGroupId, { count: number; items: ReportItem[] }>(
    GROUPS.map(({ id }) => [id, { count: 0, items: [] }]),
  );
  const add = (id: ReportGroupId, item: ReportItem, count = 1) => {
    const bucket = buckets.get(id)!;
    bucket.items.push(item);
    bucket.count += count;
  };

  // Several entries fold into one line each: skipped devices by type, generated MACs by device.
  const skippedByType = new Map<string, string[]>();
  const macsByDevice = new Map<DeviceId, number>();
  let configLinesKept = 0;

  for (const entry of report.entries) {
    switch (entry.kind) {
      case 'device-skipped': {
        const names = skippedByType.get(entry.ptType) ?? [];
        names.push(entry.name);
        skippedByType.set(entry.ptType, names);
        break;
      }
      case 'link-dropped':
        add('dropped-links', {
          label: `${endName(entry.from)} ↔ ${endName(entry.to)}: ${dropReason(entry.reason)}`,
        });
        break;
      case 'hostname-changed':
        add('renamed', { label: `${entry.name} → ${entry.hostname}` });
        break;
      case 'device-approximated':
        add('approximated', {
          label: `${name(entry.device)}: ${entry.ptType} imported as a ${KIND_NAME[entry.as]}`,
        });
        break;
      case 'port-names-guessed':
        add('approximated', {
          label: `${name(entry.device)}: ports named from their slots, as the config did not name them`,
        });
        break;
      case 'mac-generated':
        macsByDevice.set(entry.device, (macsByDevice.get(entry.device) ?? 0) + 1);
        break;
      case 'cable-approximated': {
        const link = topology.links[entry.link];
        const ends = link
          ? `${at(name(link.a.device), link.a.port)} ↔ ${at(name(link.b.device), link.b.port)}`
          : entry.link;
        add('approximated', {
          label: `${ends}: ${entry.ptCable} cable imported as ${CABLE_NAME[entry.cable]}`,
        });
        break;
      }
      case 'port-skipped':
        add('skipped-settings', {
          label: `${at(name(entry.device), entry.port)}: ${entry.ptType} port`,
        });
        break;
      case 'value-ignored':
        add('skipped-settings', {
          label: `${name(entry.device)}: ${FIELD_NAME[entry.field]} “${entry.value}” is not valid`,
        });
        break;
      case 'config-kept':
        configLinesKept += entry.lines.length;
        add(
          'config-kept',
          {
            label: `${name(entry.device)} · ${plural(entry.lines.length, 'line')}`,
            lines: entry.lines,
          },
          entry.lines.length,
        );
        break;
      default: {
        const exhaustive: never = entry;
        return exhaustive;
      }
    }
  }

  for (const [type, names] of skippedByType) {
    add('skipped-devices', { label: `${type}: ${names.join(', ')}` }, names.length);
  }
  for (const [device, count] of macsByDevice) {
    add('approximated', {
      label: `${name(device)}: generated MAC addresses for ${plural(count, 'port')}`,
    });
  }

  const groups = GROUPS.flatMap((group) => {
    const { count, items } = buckets.get(group.id)!;
    return items.length > 0 ? [{ ...group, count, items }] : [];
  });
  return { devices: report.devices, links: report.links, configLinesKept, groups };
}
