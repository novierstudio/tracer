import {
  createDevice as buildDevice,
  createIdSource,
  emptyTopology,
  Hostname,
  type Device,
  type DeviceId,
  type DeviceSpec,
  type Point,
} from '@/model';
import { deviceModel, type DeviceModelId } from './catalog';
import { modelPorts, storedModules } from './modules';

/** Packet Tracer style: the lowest free `Router0`, `Router1`, … Names compare case-insensitively. */
export function nextHostname(prefix: string, existingNames: Iterable<string>): Hostname {
  const taken = new Set(Array.from(existingNames, (name) => name.toLowerCase()));
  let n = 0;
  while (taken.has(`${prefix}${n}`.toLowerCase())) n++;
  return Hostname.parse(`${prefix}${n}`);
}

/** What `EditorState.addDevice` takes. The store assigns the id and MACs. */
export function deviceSpec(
  modelId: DeviceModelId,
  { position, existingNames }: { position: Point; existingNames: Iterable<string> },
): DeviceSpec {
  const model = deviceModel(modelId);
  return {
    kind: model.kind,
    model: model.id,
    hostname: nextHostname(model.hostnamePrefix, existingNames),
    position,
    ports: modelPorts(model),
    ...(model.slots && { modules: storedModules(model.modules ?? {}) }),
    ...(model.config && { config: model.config }),
  } as DeviceSpec;
}

/** A complete device outside the store, for importers and tests. Same seed, same MACs. */
export function createDevice(
  modelId: DeviceModelId,
  {
    id,
    position,
    existingNames,
    macSeed,
  }: { id: DeviceId; position: Point; existingNames: Iterable<string>; macSeed: number },
): Device {
  const ids = { ...createIdSource(macSeed), deviceId: () => id };
  const topology = emptyTopology({ name: '', now: new Date(0) });
  return buildDevice(deviceSpec(modelId, { position, existingNames }), { ids, topology });
}
