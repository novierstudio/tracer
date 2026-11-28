import { Ipv4Address } from '../../model';
import { keyword } from '../params';
import { defineCommand } from '../tree';
import type {
  ConfigFile,
  DeviceContext,
  IosDevice,
  Pending,
  SessionLine,
  TftpCopy,
  TftpCopyPending,
} from './context';
import type { EngineStream } from './query';
import { configuredMessage } from './servicesConfig';
import { runningConfig } from './show';

/** `copy` to and from a TFTP server, which asks where the file goes before it starts. */

const command = defineCommand<DeviceContext>();

const PRIV = ['priv-exec'] as const;

const copy = keyword('copy', 'Copy from one file to another');

const FROM: Readonly<Record<ConfigFile, string>> = {
  'running-config': 'Copy from current system configuration',
  'startup-config': 'Copy from startup configuration',
};
const TO: Readonly<Record<ConfigFile, string>> = {
  'running-config': 'Update (merge with) current system configuration',
  'startup-config': 'Copy to startup configuration',
};

const OFFLINE = ['% The simulation is not running, so there is no TFTP server to reach.'];
const NO_STARTUP = '%Error opening nvram:/startup-config (No such file or directory)';
const BAD_HOST = '%Error parsing filename (Bad IP address or host name)';

function start(ctx: DeviceContext, transfer: TftpCopy): readonly string[] {
  if (transfer.op === 'put' && transfer.from === 'startup-config') {
    if (!ctx.device.config.startupConfig) return ctx.reject(NO_STARTUP);
  }
  return ctx.ask({ kind: 'tftp-copy', copy: transfer, asking: 'host' });
}

const FILES: readonly ConfigFile[] = ['running-config', 'startup-config'];

export const copyCommands = FILES.flatMap((file) => [
  command({
    modes: PRIV,
    path: [copy, keyword(file, FROM[file]), keyword('tftp:', 'Copy to tftp: file system')],
    run: (_a, ctx) => start(ctx, { op: 'put', from: file }),
  }),
  command({
    modes: PRIV,
    path: [copy, keyword('tftp:', 'Copy from tftp: file system'), keyword(file, TO[file])],
    run: (_a, ctx) => start(ctx, { op: 'get', into: file }),
  }),
]);

/** A put's default file name: the hostname, case kept, then `-confg`. */
const defaultName = (device: IosDevice) => `${device.config.hostname}-confg`;

/** The question the copy is asking now, which the terminal shows as its prompt. */
export function copyPrompt(pending: TftpCopyPending, device: IosDevice): string {
  switch (pending.asking) {
    case 'host':
      return 'Address or name of remote host []? ';
    case 'source':
      return 'Source filename []? ';
    case 'destination':
      return pending.copy.op === 'put'
        ? `Destination filename [${defaultName(device)}]? `
        : `Destination filename [${pending.copy.into}]? `;
  }
}

/** What a put sends: the config as `show running-config` or `show startup-config` lists it. */
function contentOf(device: IosDevice, file: ConfigFile): string {
  const lines = file === 'running-config' ? runningConfig(device) : device.config.startupConfig;
  return (lines ?? []).join('\n');
}

export interface CopyStep {
  /** The next question, or undefined once the copy has started or given up. */
  readonly pending?: Pending;
  readonly output: readonly string[];
  /** The transfer, once every question has its answer. `output` is what prints offline. */
  readonly stream?: EngineStream;
}

/** Takes the answer to the copy's question: asks the next one, or starts the transfer. */
export function continueCopy(
  device: IosDevice,
  pending: TftpCopyPending,
  input: string,
  line: SessionLine,
): CopyStep {
  const answer = input.trim();
  const { copy } = pending;
  if (pending.asking === 'host') {
    const server = Ipv4Address.safeParse(answer).data;
    if (!server) return { output: [BAD_HOST] };
    const asking = copy.op === 'get' ? 'source' : 'destination';
    return { pending: { ...pending, asking, server }, output: [] };
  }
  const server = pending.server!;
  if (pending.asking === 'source') {
    if (!answer)
      return { output: [`%Error opening tftp://${server}/ (No such file or directory)`] };
    return { pending: { ...pending, asking: 'destination', source: answer }, output: [] };
  }
  if (copy.op === 'put') {
    const file = answer || defaultName(device);
    const content = contentOf(device, copy.from);
    return {
      output: OFFLINE,
      stream: { kind: 'tftp', request: { op: 'put', server, file, content }, file: copy.from },
    };
  }
  const log = copy.into === 'running-config' ? configuredMessage(line) : undefined;
  return {
    output: OFFLINE,
    stream: {
      kind: 'tftp',
      request: { op: 'get', server, file: pending.source! },
      file: copy.into,
      ...(log && { log }),
    },
  };
}
