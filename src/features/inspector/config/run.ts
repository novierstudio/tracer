import { applyLines, toConfigUpdate, type IosDevice } from '@/cli';
import { describeTopologyError, err, ok, type DeviceId, type Result } from '@/model';
import { editorStore } from '@/model/store';
import type { IosLines } from './lines';

/**
 * Runs `lines` through the CLI from global config mode, the way a pasted config block runs.
 * Fails on the first line IOS refuses or does not understand, so a form never commits half an
 * edit, and never writes to the config any other way than the CLI does.
 */
export function runLines<D extends IosDevice>(
  device: D,
  lines: IosLines,
): Result<D['config'], string> {
  const { config, errors } = applyLines(device, lines);
  const [refused] = errors;
  if (refused) return err(refused.message.replace(/^%\s*/, ''));
  const unknown = config.unknownLines.slice(device.config.unknownLines.length);
  const last = unknown.at(-1);
  if (last !== undefined) return err(`IOS did not accept "${last.trim()}"`);
  return ok(config);
}

/** Runs `lines` on the device as the store has it now, and commits the result as one undo step. */
export function commitLines(id: DeviceId, lines: IosLines): Result<void, string> {
  const editor = editorStore.getState();
  const device = editor.topology.devices[id];
  if (device?.kind !== 'router' && device?.kind !== 'switch') return err('The device is gone');
  const result = runLines(device, lines);
  if (!result.ok) return result;
  if (result.value === device.config) return ok(undefined);
  const committed = editor.updateConfig(
    toConfigUpdate({ ...device, config: result.value } as IosDevice),
  );
  return committed.ok ? committed : err(describeTopologyError(committed.error));
}
