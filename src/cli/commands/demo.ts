import type { InterfaceName } from '../interfaces';
import { exitMode, GLOBAL_CONFIG, PRIV_EXEC, USER_EXEC } from '../modes';
import {
  iface,
  ifaceRange,
  ipv4,
  keyword,
  mask,
  word,
  type Ipv4Address,
  type SubnetMask,
} from '../params';
import { buildTree, defineCommand } from '../tree';

export interface InterfaceAddress {
  readonly ip: Ipv4Address;
  readonly mask: SubnetMask;
}

/** What the demo commands read and change. A later issue implements it over DeviceConfig. */
export interface DemoContext {
  readonly hostname: string;
  setHostname(name: string): void;
  setAddress(name: InterfaceName, address: InterfaceAddress | undefined): void;
  setShutdown(name: InterfaceName, shutdown: boolean): void;
}

export const DEFAULT_HOSTNAME = 'Router';

const EXEC = ['user-exec', 'priv-exec'] as const;
const CONFIG = ['global-config', 'interface-config', 'line-config', 'router-config'] as const;

const command = defineCommand<DemoContext>();
const show = keyword('show', 'Show running system information');
const interfaceKw = keyword('interface', 'Select an interface to configure');
const ipKw = keyword('ip', 'Interface Internet Protocol config commands');
const address = keyword('address', 'Set the IP address of an interface');

export const demoCommands = [
  command({ modes: EXEC, path: [keyword('enable', 'Turn on privileged commands')], to: PRIV_EXEC }),
  command({
    modes: ['priv-exec'],
    path: [keyword('disable', 'Turn off privileged commands')],
    to: USER_EXEC,
  }),
  command({ modes: EXEC, path: [keyword('exit', 'Exit from the EXEC')], to: USER_EXEC }),
  command({
    modes: ['priv-exec'],
    path: [
      keyword('configure', 'Enter configuration mode'),
      keyword('terminal', 'Configure from the terminal'),
    ],
    to: GLOBAL_CONFIG,
  }),
  command({
    modes: EXEC,
    path: [show, keyword('version', 'System hardware and software status')],
    run: (_args, ctx) => [
      'Tracer IOS Software, Version 0.1 (demo)',
      `${ctx.hostname} uptime is 0 minutes`,
    ],
  }),
  command({
    modes: CONFIG,
    path: [keyword('exit', 'Exit from configure mode')],
    to: (_args, from) => exitMode(from),
  }),
  command({ modes: CONFIG, path: [keyword('end', 'Exit from configure mode')], to: PRIV_EXEC }),
  command({
    modes: ['global-config'],
    path: [
      keyword('hostname', "Set system's network name"),
      word('name', "This system's network name"),
    ],
    run: ({ name }, ctx) => {
      ctx.setHostname(name);
      return [];
    },
    no: (_args, ctx) => {
      ctx.setHostname(DEFAULT_HOSTNAME);
      return [];
    },
  }),
  command({
    modes: ['global-config'],
    path: [interfaceKw, iface('name', 'Interface name')],
    to: ({ name }) => ({ kind: 'interface-config', interfaces: [name] }),
  }),
  command({
    modes: ['global-config'],
    path: [
      interfaceKw,
      keyword('range', 'interface range command'),
      ifaceRange('names', 'Interface range'),
    ],
    to: ({ names }) => ({ kind: 'interface-config', interfaces: names }),
  }),
  command({
    modes: ['interface-config'],
    path: [ipKw, address, ipv4('ip', 'IP address'), mask('mask', 'IP subnet mask')],
    run: ({ ip, mask }, ctx, mode) => {
      for (const name of mode.interfaces) ctx.setAddress(name, { ip, mask });
      return [];
    },
    no: (_args, ctx, mode) => {
      for (const name of mode.interfaces) ctx.setAddress(name, undefined);
      return [];
    },
  }),
  command({
    modes: ['interface-config'],
    path: [keyword('shutdown', 'Shutdown the selected interface')],
    run: (_args, ctx, mode) => {
      for (const name of mode.interfaces) ctx.setShutdown(name, true);
      return [];
    },
    no: (_args, ctx, mode) => {
      for (const name of mode.interfaces) ctx.setShutdown(name, false);
      return [];
    },
  }),
];

export const demoTree = buildTree(demoCommands);
