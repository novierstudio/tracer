import { useState } from 'react';
import type { DeviceModel } from '@/devices/catalog';
import {
  BAY_LABELS,
  compatibleModules,
  findModule,
  installedModules,
  portsWithModules,
  slotPorts,
  storedModules,
  type ModuleId,
  type Slot,
} from '@/devices/modules';
import { describeTopologyError, type Device } from '@/model';
import { editorStore } from '@/model/store';
import { Select } from './config/controls';
import { Section } from './parts';
import { shortPortName } from './view';

const EMPTY = '';

/** Packet Tracer's Physical tab: the device's module slots, which change only with the power off. */
export function PhysicalTab({ device, model }: { device: Device; model: DeviceModel }) {
  const [error, setError] = useState<string | null>(null);
  const modules = installedModules(device, model);

  const fit = (slot: Slot, module: ModuleId | undefined) => {
    const next = { ...modules, [slot.id]: module };
    const result = editorStore.getState().setModules({
      device: device.id,
      modules: storedModules(next),
      ports: portsWithModules(device, model, next),
    });
    setError(result.ok ? null : describeTopologyError(result.error));
  };

  return (
    <Section title="Modules">
      <p className="text-2xs text-balance text-fg-3">
        {device.powered
          ? 'Turn the power off to add or remove a module. A cable on a removed port comes out.'
          : 'The power is off. Add or remove modules, then turn it back on.'}
      </p>
      <ul aria-label="Slots" className="flex flex-col gap-2">
        {(model.slots ?? []).map((slot) => {
          const installed = modules[slot.id];
          const ports = slotPorts(slot, installed);
          return (
            <li key={slot.id} className="flex flex-col gap-1">
              <div className="flex items-center gap-2 text-xs">
                <span className="w-24 shrink-0 text-fg-2">
                  Slot {slot.id} <span className="text-fg-3">{BAY_LABELS[slot.bay]}</span>
                </span>
                <Select
                  aria-label={`Slot ${slot.id}`}
                  value={installed ?? EMPTY}
                  disabled={device.powered}
                  onChange={(event) =>
                    fit(slot, (event.target.value || undefined) as ModuleId | undefined)
                  }
                  className="min-w-0 flex-1 disabled:opacity-60"
                >
                  <option value={EMPTY}>Empty</option>
                  {compatibleModules(slot).map((module) => (
                    <option key={module.id} value={module.id} title={module.description}>
                      {module.id}
                    </option>
                  ))}
                </Select>
              </div>
              {installed && (
                <p className="pl-26 text-2xs text-fg-3">
                  {findModule(installed)?.description}
                  {ports.length > 0 &&
                    `: ${ports.map((port) => shortPortName(port.id)).join(', ')}`}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p
          role="alert"
          className="rounded-md border border-err/30 bg-err/8 px-2 py-1.5 text-2xs text-err"
        >
          {error}
        </p>
      )}
    </Section>
  );
}
