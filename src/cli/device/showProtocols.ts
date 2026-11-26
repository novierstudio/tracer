import type { OspfStatus, RipStatus, RoutingProtocols } from '../../engine/api';
import type { OspfConfig, RipConfig } from '../../model';
import type { IosDevice } from './context';
import { NO_ENGINE, routeAge } from './showRouting';

/** What RIP sends and accepts: v1 and either version without `version`, else only the one set. */
function versionControl(rip: RipConfig) {
  switch (rip.version) {
    case undefined:
      return { summary: 'send version 1, receive any version', send: '1', receive: '1 2' };
    case 1:
      return { summary: 'send version 1, receive version 1', send: '1', receive: '1' };
    case 2:
      return { summary: 'send version 2, receive version 2', send: '2', receive: '2' };
  }
}

function ospfSection(ospf: OspfConfig, status: OspfStatus): string[] {
  const areas = new Set(status.interfaces.map((entry) => entry.area)).size;
  return [
    `Routing Protocol is "ospf ${ospf.processId}"`,
    '  Outgoing update filter list for all interfaces is not set',
    '  Incoming update filter list for all interfaces is not set',
    `  Router ID ${status.routerId ?? '0.0.0.0'}`,
    `  Number of areas in this router is ${areas}. ${areas} normal 0 stub 0 nssa`,
    '  Maximum path: 4',
    '  Routing for Networks:',
    ...ospf.networks.map(
      ({ address, wildcard, area }) => `    ${address} ${wildcard} area ${area}`,
    ),
    ...(ospf.passiveInterfaces.length > 0
      ? ['  Passive Interface(s):', ...ospf.passiveInterfaces.map((id) => `    ${id}`)]
      : []),
    '  Routing Information Sources:',
    '    Gateway         Distance      Last Update',
    ...status.sources.map(
      ({ routerId, lastUpdateMs }) =>
        `    ${routerId.padEnd(16)}${'110'.padStart(8)}      ${routeAge(lastUpdateMs)}`,
    ),
    '  Distance: (default is 110)',
  ];
}

function ripSection(rip: RipConfig, status: RipStatus): string[] {
  const { timers } = status;
  const version = versionControl(rip);
  const nextDue = Math.ceil(status.nextUpdateMs / 1000);
  return [
    'Routing Protocol is "rip"',
    '  Outgoing update filter list for all interfaces is not set',
    '  Incoming update filter list for all interfaces is not set',
    `  Sending updates every ${timers.update} seconds, next due in ${nextDue} seconds`,
    `  Invalid after ${timers.invalid} seconds, hold down ${timers.holddown}, flushed after ${timers.flush}`,
    '  Redistributing: rip',
    `  Default version control: ${version.summary}`,
    '    Interface             Send  Recv  Triggered RIP  Key-chain',
    ...status.interfaces.map((id) =>
      `    ${id.padEnd(22)}${version.send.padEnd(6)}${version.receive}`.trimEnd(),
    ),
    `  Automatic network summarization is ${rip.autoSummary ? '' : 'not '}in effect`,
    '  Maximum path: 4',
    '  Routing for Networks:',
    ...rip.networks.map((network) => `    ${network}`),
    ...(rip.passiveInterfaces.length > 0
      ? ['  Passive Interface(s):', ...rip.passiveInterfaces.map((id) => `    ${id}`)]
      : []),
    '  Routing Information Sources:',
    '    Gateway         Distance      Last Update',
    ...status.sources.map(
      ({ gateway, lastUpdateMs }) =>
        `    ${gateway.padEnd(16)}${'120'.padStart(8)}      ${routeAge(lastUpdateMs)}`,
    ),
    '  Distance: (default is 120)',
  ];
}

/**
 * `show ip protocols`: each routing protocol the router runs, from its config and the simulation's
 * view of the running process. Nothing when no protocol is configured.
 */
export function showIpProtocols(
  protocols: RoutingProtocols | undefined,
  device: IosDevice,
): readonly string[] {
  if (!protocols) return NO_ENGINE;
  if (device.kind !== 'router') return [];
  const { ospf, rip } = device.config;
  const sections = [
    ospf && protocols.ospf ? ospfSection(ospf, protocols.ospf) : undefined,
    rip && protocols.rip ? ripSection(rip, protocols.rip) : undefined,
  ].filter((section) => section !== undefined);
  return sections.flatMap((section, i) => (i === 0 ? section : ['', ...section]));
}
