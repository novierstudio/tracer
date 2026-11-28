import {
  DEFAULT_HOME_GATEWAY,
  DEFAULT_RADIO,
  factoryIot,
  HOME_GATEWAY_MODEL,
  PortId,
  type PortKind,
  type PortSpec,
  type ThingKind,
} from '@/model';
import type { DeviceModel } from '../catalog';
import { numbered, radio } from '../ports';

/**
 * Packet Tracer's wireless controller family, access points by band, the Home Gateway, the cell
 * tower and its central office, and the IoT things a home or board lab uses.
 */

const port = (kind: PortKind, name: string): PortSpec => ({ kind, id: PortId.parse(name) });

/** An access point's ports, as Packet Tracer's AccessPoint-PT: Port 0 is Ethernet, Port 1 the radio. */
const AP_PORTS = [...numbered(1), radio('Port1')];

/** A lightweight AP's Gigabit uplink and its 2.4 GHz and 5 GHz radios. */
const LAP_PORTS = [
  port('gigabitEthernet', 'GigabitEthernet0'),
  radio('Dot11Radio0'),
  radio('Dot11Radio1'),
];

const gigabit = (count: number) =>
  Array.from({ length: count }, (_, i) => port('gigabitEthernet', `GigabitEthernet${i + 1}`));

const coaxial = (name: string): PortSpec => ({ ...port('fastEthernet', name), coaxial: true });

/** A 3G/4G radio, as a cell tower's or a smartphone's. A host with one joins the nearest tower. */
export const CELLULAR_NIC: PortSpec = { ...radio('Cell1'), cellular: true };

/** An IoT thing: one Ethernet port, an address by DHCP, and the IoT settings of its kind. */
function thing<const I extends string>(
  id: I,
  name: string,
  kind: ThingKind,
  category: 'home' | 'components',
  hostnamePrefix: string,
): DeviceModel & { readonly id: I } {
  return {
    id,
    name,
    category,
    kind: 'pc',
    hostnamePrefix,
    icon: `iot-${kind}`,
    ports: [port('fastEthernet', 'FastEthernet0')],
    config: { ipv4: { mode: 'dhcp' }, iot: factoryIot(kind) },
  };
}

export const WIRELESS_IOT_MODELS = [
  {
    id: 'access-point-a',
    name: 'AccessPoint-PT-A',
    category: 'wireless',
    kind: 'accessPoint',
    hostnamePrefix: 'AccessPoint',
    icon: 'access-point',
    ports: AP_PORTS,
    wifi: { band: '5 GHz', standards: ['802.11a'] },
    config: { radio: { ...DEFAULT_RADIO, channel: 36 } },
  },
  {
    id: 'access-point-n',
    name: 'AccessPoint-PT-N',
    category: 'wireless',
    kind: 'accessPoint',
    hostnamePrefix: 'AccessPoint',
    icon: 'access-point',
    ports: AP_PORTS,
    wifi: { band: '2.4 GHz', standards: ['802.11b', '802.11g', '802.11n'] },
  },
  {
    id: 'access-point-ac',
    name: 'AccessPoint-PT-AC',
    category: 'wireless',
    kind: 'accessPoint',
    hostnamePrefix: 'AccessPoint',
    icon: 'access-point',
    ports: AP_PORTS,
    wifi: { band: '5 GHz', standards: ['802.11a', '802.11n', '802.11ac'] },
    config: { radio: { ...DEFAULT_RADIO, channel: 36 } },
  },
  {
    id: 'lap-pt',
    name: 'LAP-PT',
    category: 'wireless',
    kind: 'lightweightAp',
    hostnamePrefix: 'LAP',
    icon: 'lightweight-ap',
    ports: LAP_PORTS,
    wifi: {
      band: '2.4/5 GHz',
      standards: ['802.11a', '802.11b', '802.11g', '802.11n', '802.11ac'],
    },
  },
  {
    id: 'lap-3702i',
    name: '3702i',
    category: 'wireless',
    kind: 'lightweightAp',
    hostnamePrefix: 'LAP',
    icon: 'lightweight-ap',
    ports: LAP_PORTS,
    wifi: {
      band: '2.4/5 GHz',
      standards: ['802.11a', '802.11b', '802.11g', '802.11n', '802.11ac'],
    },
  },
  {
    id: 'wlc-pt',
    name: 'WLC-PT',
    category: 'wireless',
    kind: 'wlc',
    hostnamePrefix: 'WLC',
    icon: 'wlc',
    ports: gigabit(1),
  },
  {
    id: 'wlc-2504',
    name: 'WLC-2504',
    category: 'wireless',
    kind: 'wlc',
    hostnamePrefix: 'WLC',
    icon: 'wlc',
    ports: gigabit(4),
  },
  {
    id: HOME_GATEWAY_MODEL,
    name: 'DLC100',
    category: 'home',
    kind: 'wirelessRouter',
    hostnamePrefix: 'HomeGateway',
    icon: 'home-gateway',
    // As the WRT300N it is built like: the Internet port, four LAN ports and the radio.
    ports: [
      port('fastEthernet', 'Internet'),
      ...[1, 2, 3, 4].map((n) => port('fastEthernet', `Ethernet${n}`)),
      radio('Wireless'),
    ],
    wifi: { band: '2.4 GHz', standards: ['802.11b', '802.11g', '802.11n'] },
    config: DEFAULT_HOME_GATEWAY,
  },
  {
    id: 'cell-tower',
    name: 'Cell-Tower',
    category: 'wan-emulation',
    kind: 'cellTower',
    hostnamePrefix: 'CellTower',
    icon: 'cell-tower',
    ports: [coaxial('Coaxial0'), { ...radio('Cell0'), cellular: true }],
  },
  {
    id: 'central-office',
    name: 'Central-Office-Server',
    category: 'wan-emulation',
    kind: 'centralOffice',
    hostnamePrefix: 'CentralOfficeServer',
    icon: 'central-office',
    ports: [
      port('fastEthernet', 'Backbone'),
      ...Array.from({ length: 6 }, (_, i) => coaxial(`Coaxial${i}`)),
    ],
  },
  thing('iot-lamp', 'Lamp', 'lamp', 'home', 'Lamp'),
  thing('iot-fan', 'Ceiling Fan', 'fan', 'home', 'Fan'),
  thing('iot-door', 'Door', 'door', 'home', 'Door'),
  thing('iot-window', 'Window', 'window', 'home', 'Window'),
  thing('iot-motion', 'Motion Detector', 'motion', 'home', 'MotionDetector'),
  thing('iot-smoke', 'Smoke Detector', 'smoke', 'home', 'SmokeDetector'),
  thing('iot-siren', 'Siren', 'siren', 'home', 'Siren'),
  thing('iot-thermostat', 'Thermostat', 'thermostat', 'home', 'Thermostat'),
  thing('iot-webcam', 'Webcam', 'webcam', 'home', 'Webcam'),
  thing('iot-mcu', 'MCU-PT', 'mcu', 'components', 'MCU'),
  thing('iot-sbc', 'SBC-PT', 'sbc', 'components', 'SBC'),
  thing('iot-thing', 'Thing', 'thing', 'components', 'Thing'),
] as const satisfies readonly DeviceModel[];
