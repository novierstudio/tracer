import { Trash2Icon } from 'lucide-react';
import { Switch } from 'radix-ui';
import { useId, useState, type ReactNode } from 'react';
import type { HostAddressing } from '@/engine/api';
import { HostDesktop } from '@/features/desktop/HostDesktop';
import { hostBackend } from '@/features/desktop/registry';
import { useHostAddressing } from '@/features/simulation/hostAddresses';
import { DeviceTerminal } from '@/features/terminal/Terminal';
import type { Device, Topology } from '@/model';
import { editorStore } from '@/model/store';
import { Button } from '@/ui/button';
import { cn } from '@/ui/cn';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';
import { Tooltip } from '@/ui/tooltip';
import { deleteItems } from './actions';
import { IosConfigTab } from './config/ConfigTab';
import { HostAddressForm } from './HostAddressForm';
import { HostIpv6Form } from './HostIpv6Form';
import { HostnameField } from './HostnameField';
import { InterfacesTab } from './InterfacesTab';
import { ServicesTab } from './ServicesTab';
import { formatCidr } from './ipv4';
import { DeviceTile, Facts, Mono, PeerButton, STATE_LABELS, Section, StateDot } from './parts';
import {
  describeModel,
  KIND_LABELS,
  PORT_KIND_NAMES,
  portRows,
  shortPortName,
  type PortRow,
} from './view';

export const DEVICE_TABS = ['overview', 'interfaces', 'config', 'services', 'console'] as const;
export type DeviceTab = (typeof DEVICE_TABS)[number];

type Props = {
  device: Device;
  topology: Topology;
  tab: DeviceTab;
  onTabChange: (tab: DeviceTab) => void;
  /** Focus the CLI when it mounts: someone just picked its tab. */
  focusConsole: boolean;
};

/** Routers and switches get an IOS CLI; end hosts get a desktop, as in the UI/UX doc. */
const isHost = (device: Device) => device.kind === 'pc' || device.kind === 'server';
const hasConsole = (device: Device) =>
  isHost(device) || device.kind === 'router' || device.kind === 'switch';

export function DeviceInspector({ device, topology, tab, onTabChange, focusConsole }: Props) {
  const rows = portRows(topology, device);
  const host = isHost(device);
  // Only a server has services, and a hub has no console; a tab kept from another device falls
  // back to Config.
  const shown =
    (tab === 'services' && device.kind !== 'server') || (tab === 'console' && !hasConsole(device))
      ? 'config'
      : tab;
  return (
    <Tabs
      value={shown}
      onValueChange={(value) => onTabChange(value as DeviceTab)}
      className="flex min-h-0 flex-1 flex-col"
    >
      <DeviceHeader key={device.id} device={device} />
      <TabsList aria-label="Device views" className="shrink-0 border-b border-line px-2 pb-2">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="interfaces">Interfaces</TabsTrigger>
        <TabsTrigger value="config">Config</TabsTrigger>
        {device.kind === 'server' && <TabsTrigger value="services">Services</TabsTrigger>}
        {hasConsole(device) && (
          <TabsTrigger value="console">{host ? 'Desktop' : 'CLI'}</TabsTrigger>
        )}
      </TabsList>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <TabsContent value="overview">
          <Overview device={device} rows={rows} />
        </TabsContent>
        <TabsContent value="interfaces" className="pb-3">
          <InterfacesTab device={device} topology={topology} />
        </TabsContent>
        <TabsContent value="config">
          <ConfigTab device={device} rows={rows} />
        </TabsContent>
        {device.kind === 'server' && (
          <TabsContent value="services">
            <ServicesTab key={device.id} device={device} />
          </TabsContent>
        )}
        {!hasConsole(device) ? null : host ? (
          <TabsContent value="console" className="h-full">
            <HostDesktop device={device} focusPrompt={focusConsole} />
          </TabsContent>
        ) : (
          <TabsContent value="console" className="h-full pt-2 pr-1 pb-2 pl-3">
            <DeviceTerminal device={device.id} autoFocus={focusConsole} />
          </TabsContent>
        )}
      </div>
    </Tabs>
  );
}

function DeviceHeader({ device }: { device: Device }) {
  const model = describeModel(device);
  const [hostnameError, setHostnameError] = useState<string | null>(null);
  const errorId = useId();
  return (
    <header className="flex shrink-0 flex-col gap-2 px-3 pt-1 pb-3">
      <div className="flex items-start gap-3">
        <DeviceTile device={device} className="mt-0.5 size-10" />
        <div className="flex min-w-0 flex-1 flex-col">
          <HostnameField
            device={device}
            error={hostnameError}
            errorId={errorId}
            onError={setHostnameError}
          />
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-fg-2">
            <span className="truncate">{model.name}</span>
            <span aria-hidden="true" className="text-fg-3">
              ·
            </span>
            <PowerSwitch device={device} />
          </p>
        </div>
        <Tooltip label="Delete device">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Delete device"
            onClick={() => deleteItems([device.id], [])}
          >
            <Trash2Icon />
          </Button>
        </Tooltip>
      </div>
      {hostnameError && (
        <p
          id={errorId}
          role="alert"
          className="rounded-md border border-err/30 bg-err/8 px-2 py-1.5 text-2xs text-err"
        >
          {hostnameError}
        </p>
      )}
    </header>
  );
}

function PowerSwitch({ device }: { device: Device }) {
  return (
    <label className="inline-flex shrink-0 items-center gap-1.5">
      <Switch.Root
        aria-label="Power"
        checked={device.powered}
        onCheckedChange={(powered) =>
          editorStore.getState().setPowered({ device: device.id, powered })
        }
        className="relative inline-flex h-4 w-7 shrink-0 cursor-default items-center rounded-full bg-surface-3 transition-colors duration-150 data-[state=checked]:bg-ok/80"
      >
        <Switch.Thumb className="block size-3 translate-x-0.5 rounded-full bg-surface-1 shadow-xs transition-transform duration-150 data-[state=checked]:translate-x-3.5" />
      </Switch.Root>
      <span aria-hidden="true">{device.powered ? 'On' : 'Off'}</span>
    </label>
  );
}

function Overview({ device, rows }: { device: Device; rows: PortRow[] }) {
  const connected = rows.filter((row) => row.peer);
  const leased = useHostAddressing(device.id);
  return (
    <>
      <Section title="Device">
        <Facts
          rows={[
            ['Kind', KIND_LABELS[device.kind].one],
            ['Model', describeModel(device).name],
            ['Ports', `${connected.length} of ${rows.length} connected`],
            ...hostAddressFacts(device, leased),
          ]}
        />
      </Section>
      <Section title="Port map" aside={<PortLegend />} className="border-t border-line">
        <PortMap rows={rows} />
      </Section>
      <Section title="Connections" className="border-t border-line">
        {connected.length === 0 ? (
          <p className="text-xs text-fg-3">No cables yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {connected.map((row) => (
              <li key={row.id} className="grid grid-cols-[4.75rem_1fr] items-center gap-2">
                <span className="flex items-center gap-2">
                  <StateDot state={row.state} />
                  <Mono>{shortPortName(row.id)}</Mono>
                </span>
                {row.peer && <PeerButton device={row.peer.device} port={row.peer.port} />}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

/** A host's address and gateway. A DHCP host's come from the simulation's `leased`. */
function hostAddressFacts(
  device: Device,
  leased: HostAddressing | undefined,
): [string, ReactNode][] {
  if (device.kind !== 'pc' && device.kind !== 'server') return [];
  const { ipv4 } = device.config;
  const notSet = <span className="text-fg-3">Not set</span>;
  if (ipv4.mode === 'dhcp') {
    if (leased?.kind !== 'leased' && leased?.kind !== 'autoconfigured') {
      return [['IP address', <span className="text-fg-3">DHCP, none yet</span>]];
    }
    const source = leased.kind === 'leased' ? 'DHCP' : 'APIPA';
    return [
      [
        'IP address',
        <span>
          <Mono>{formatCidr(leased.address)}</Mono> <span className="text-fg-3">{source}</span>
        </span>,
      ],
      [
        'Gateway',
        leased.kind === 'leased' && leased.gateway ? <Mono>{leased.gateway}</Mono> : notSet,
      ],
    ];
  }
  return [
    ['IP address', ipv4.address ? <Mono>{formatCidr(ipv4.address)}</Mono> : notSet],
    ['Gateway', ipv4.gateway ? <Mono>{ipv4.gateway}</Mono> : notSet],
  ];
}

/** A faceplate: one tile per port, grouped by port type, numbered like the hardware. */
function PortMap({ rows }: { rows: PortRow[] }) {
  const groups = new Map<PortRow['kind'], PortRow[]>();
  for (const row of rows) groups.set(row.kind, [...(groups.get(row.kind) ?? []), row]);
  return (
    <div className="flex flex-col gap-2.5">
      {[...groups].map(([kind, ports]) => (
        <div key={kind} className="flex flex-col gap-1">
          <p className="text-2xs text-fg-3">{PORT_KIND_NAMES[kind]}</p>
          <ul aria-label={`${PORT_KIND_NAMES[kind]} ports`} className="flex flex-wrap gap-1">
            {ports.map((row) => {
              const peer = row.peer
                ? `${row.peer.device.config.hostname} ${shortPortName(row.peer.port)}, `
                : '';
              const label = `${shortPortName(row.id)}: ${peer}${STATE_LABELS[row.state].toLowerCase()}`;
              return (
                <li
                  key={row.id}
                  title={label}
                  className={cn(
                    'flex size-6 items-center justify-center rounded-[5px] border font-mono text-[0.625rem] tabular-nums',
                    row.state === 'up' && 'border-ok/45 bg-ok/15 text-fg-1',
                    row.state === 'down' && 'border-err/50 bg-err/10 text-fg-1',
                    row.state === 'free' && 'border-line bg-surface-2 text-fg-3',
                  )}
                >
                  <span aria-hidden="true">{row.id.split('/').at(-1)?.replace(/^\D+/, '')}</span>
                  <span className="sr-only">{label}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function PortLegend() {
  return (
    <span className="flex items-center gap-2.5 text-2xs text-fg-3" aria-hidden="true">
      {(['up', 'down', 'free'] as const).map((state) => (
        <span key={state} className="flex items-center gap-1">
          <StateDot state={state} />
          {STATE_LABELS[state]}
        </span>
      ))}
    </span>
  );
}

function ConfigTab({ device, rows }: { device: Device; rows: PortRow[] }) {
  if (device.kind === 'router' || device.kind === 'switch') {
    return <IosConfigTab key={device.id} device={device} rows={rows} />;
  }
  if (device.kind === 'hub') {
    return (
      <Section title="Hub">
        <p className="text-xs text-fg-2">
          A hub has nothing to configure. It repeats every frame out of every other port, and its
          ports share one segment, so two frames that reach it at once collide.
        </p>
      </Section>
    );
  }
  return (
    <>
      <Section title="IP configuration">
        <HostAddressForm key={device.id} device={device} />
      </Section>
      <Section title="IPv6 configuration">
        <HostIpv6Form key={device.id} device={device} ipv6Status={hostBackend.ipv6Status} />
      </Section>
    </>
  );
}
