// No runtime imports: the simulation worker uses these, and must not pull in zod.
import type { Device, IotConfig, ThingKind } from './topology';

/**
 * One thing an IoT device shows on its server's page. An actuator, such as a lamp's status, takes
 * orders from the server. A sensor, such as a motion detector's, changes only on the device, as
 * Packet Tracer's Alt-click does, and the server reads it.
 */
export type ThingAttribute = {
  readonly key: string;
  readonly label: string;
  /** Its states, the first one the device ships in. */
  readonly values: readonly string[];
  readonly role: 'actuator' | 'sensor';
};

export type ThingType = { readonly label: string; readonly attributes: readonly ThingAttribute[] };

const onOff = (label = 'Status'): ThingAttribute => ({
  key: 'status',
  label,
  values: ['off', 'on'],
  role: 'actuator',
});

/** Each kind of thing, with what its server's page shows and controls, as Packet Tracer's. */
export const THING_TYPES: Readonly<Record<ThingKind, ThingType>> = {
  lamp: {
    label: 'Lamp',
    attributes: [
      { key: 'status', label: 'Status', values: ['off', 'dim', 'on'], role: 'actuator' },
    ],
  },
  fan: {
    label: 'Ceiling fan',
    attributes: [
      { key: 'status', label: 'Status', values: ['off', 'low', 'high'], role: 'actuator' },
    ],
  },
  door: {
    label: 'Door',
    attributes: [
      { key: 'open', label: 'Open', values: ['closed', 'open'], role: 'sensor' },
      { key: 'lock', label: 'Lock', values: ['unlocked', 'locked'], role: 'actuator' },
    ],
  },
  window: {
    label: 'Window',
    attributes: [{ key: 'open', label: 'Open', values: ['closed', 'open'], role: 'actuator' }],
  },
  motion: {
    label: 'Motion detector',
    attributes: [{ key: 'motion', label: 'Motion', values: ['no', 'yes'], role: 'sensor' }],
  },
  smoke: {
    label: 'Smoke detector',
    attributes: [{ key: 'alarm', label: 'Alarm', values: ['off', 'on'], role: 'sensor' }],
  },
  siren: { label: 'Siren', attributes: [onOff()] },
  thermostat: {
    label: 'Thermostat',
    attributes: [
      {
        key: 'mode',
        label: 'Mode',
        values: ['off', 'cooling', 'heating', 'auto'],
        role: 'actuator',
      },
    ],
  },
  webcam: { label: 'Webcam', attributes: [onOff()] },
  mcu: { label: 'MCU board', attributes: [onOff()] },
  sbc: { label: 'SBC board', attributes: [onOff()] },
  thing: { label: 'Thing', attributes: [onOff()] },
};

/** A thing's state with every attribute set: what its config says, else the first value. */
export function thingState(config: IotConfig): Record<string, string> {
  return Object.fromEntries(
    THING_TYPES[config.thing].attributes.map((attribute) => {
      const value = config.state[attribute.key];
      return [
        attribute.key,
        value !== undefined && attribute.values.includes(value) ? value : attribute.values[0]!,
      ];
    }),
  );
}

/** A thing as it ships: registered nowhere, every attribute in its first state. */
export const factoryIot = (thing: ThingKind): IotConfig => ({
  thing,
  server: { mode: 'none' },
  state: {},
});

/** The host's IoT settings, when it is an IoT thing. */
export const iotOf = (device: Device): IotConfig | undefined =>
  device.kind === 'pc' ? device.config.iot : undefined;

/** The model id of Packet Tracer's DLC100 Home Gateway, a home router that runs an IoT server. */
export const HOME_GATEWAY_MODEL = 'home-gateway';

/** The account a Home Gateway's IoT page signs in with, as Packet Tracer's: admin, admin. */
export const GATEWAY_ACCOUNT = { username: 'admin', password: 'admin' } as const;

/** Whether the device runs an IoT registration server: a Home Gateway, or a server with IoT on. */
export function runsIotServer(device: Device): boolean {
  if (device.kind === 'wirelessRouter') return device.model === HOME_GATEWAY_MODEL;
  return device.kind === 'server' && device.config.services?.iot?.enabled === true;
}
