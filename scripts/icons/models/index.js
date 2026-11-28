// Every sprite's model, by its DeviceIconName in src/devices/catalog.ts.
import { MODELS as endpoints } from './endpoints.js';
import { MODELS as iot } from './iot.js';
import { MODELS as network } from './network.js';
import { MODELS as wan } from './wan.js';
import { MODELS as wireless } from './wireless.js';

export const MODELS = { ...network, ...wireless, ...wan, ...endpoints, ...iot };
