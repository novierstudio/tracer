import type { Cable, DeviceId, DeviceKind, Hostname, LinkId, PortId, TopologyError } from '@/model';

/** One end of a Packet Tracer link, named as in the file. */
export type PtLinkEnd = {
  /** The device's canvas label, or the raw reference when no device has it. */
  readonly device: string;
  readonly port: string;
};

export type LinkDropReason =
  | { readonly kind: 'device-not-found' }
  | { readonly kind: 'device-skipped' }
  | { readonly kind: 'port-not-imported' }
  | { readonly kind: 'invalid'; readonly error: TopologyError };

export type ReportEntry =
  /** A device type Tracer has no kind for yet, such as Printer or AccessPoint. */
  | {
      readonly kind: 'device-skipped';
      readonly name: string;
      readonly ptType: string;
      readonly model: string;
    }
  /** A device imported as the nearest kind, such as a MultiLayerSwitch as a switch. */
  | {
      readonly kind: 'device-approximated';
      readonly device: DeviceId;
      readonly ptType: string;
      readonly as: DeviceKind;
    }
  /** The canvas label was not a valid IOS hostname, or another device already had it. */
  | {
      readonly kind: 'hostname-changed';
      readonly device: DeviceId;
      readonly name: string;
      readonly hostname: Hostname;
    }
  /** A port Tracer has no kind for, such as a wireless or console port. */
  | {
      readonly kind: 'port-skipped';
      readonly device: DeviceId;
      readonly port: string;
      readonly ptType: string;
    }
  /** A fiber port imported as copper. */
  | {
      readonly kind: 'port-approximated';
      readonly device: DeviceId;
      readonly port: PortId;
      readonly ptType: string;
    }
  /** The running-config did not name the ports, so they were named from their slots. */
  | { readonly kind: 'port-names-guessed'; readonly device: DeviceId }
  /** The port had no valid MAC address, so it got a generated one. */
  | { readonly kind: 'mac-generated'; readonly device: DeviceId; readonly port: PortId }
  /** An address or mask that does not parse. */
  | {
      readonly kind: 'value-ignored';
      readonly device: DeviceId;
      readonly field: 'ipv4' | 'gateway' | 'dns';
      readonly value: string;
    }
  | {
      readonly kind: 'link-dropped';
      readonly from: PtLinkEnd;
      readonly to: PtLinkEnd;
      readonly reason: LinkDropReason;
    }
  /** A cable type Tracer does not know, replaced by the one that fits the ports. */
  | {
      readonly kind: 'cable-approximated';
      readonly link: LinkId;
      readonly ptCable: string;
      readonly cable: Cable;
    }
  /** Running-config lines that the config replay did not understand, kept as unknown lines. */
  | { readonly kind: 'config-kept'; readonly device: DeviceId; readonly lines: readonly string[] };

export type ImportOutcome = 'imported' | 'approximated' | 'skipped';

export const ENTRY_OUTCOME: { readonly [K in ReportEntry['kind']]: ImportOutcome } = {
  'device-skipped': 'skipped',
  'device-approximated': 'approximated',
  'hostname-changed': 'approximated',
  'port-skipped': 'skipped',
  'port-approximated': 'approximated',
  'port-names-guessed': 'approximated',
  'mac-generated': 'approximated',
  'value-ignored': 'skipped',
  'link-dropped': 'skipped',
  'cable-approximated': 'approximated',
  'config-kept': 'imported',
};

export type ImportReport = {
  /** The Packet Tracer version that saved the file, such as 8.2.2.0400. */
  readonly ptVersion: string;
  /** A .pka activity. Only the user's network was read, never the answer network or grading. */
  readonly activity: boolean;
  readonly devices: { readonly imported: number; readonly skipped: number };
  readonly links: { readonly imported: number; readonly dropped: number };
  readonly entries: readonly ReportEntry[];
};
