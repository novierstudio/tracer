import {
  ChevronLeftIcon,
  FileTextIcon,
  GlobeIcon,
  NetworkIcon,
  MonitorCogIcon,
  PowerIcon,
  SquareTerminalIcon,
  WifiIcon,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import { formatShortcut } from '@/app/shell/shortcuts';
import { addressOf, gatewayOf } from '@/engine/l3/hostAddress';
import { HostAddressForm } from '@/features/inspector/HostAddressForm';
import { HostIpv6Form } from '@/features/inspector/HostIpv6Form';
import { formatCidr } from '@/features/inspector/ipv4';
import { useHostAddressing } from '@/features/simulation/hostAddresses';
import type { DeviceId } from '@/model';
import { useEditor } from '@/model/react';
import { editorStore } from '@/model/store';
import { Button } from '@/ui/button';
import { cn } from '@/ui/cn';
import { EmptyState } from '@/ui/empty-state';
import { Kbd } from '@/ui/kbd';
import { addressPort, configAddressing, nicConnected, type HostDevice } from './format';
import { HostPrompt } from './HostPrompt';
import { hostBackend } from './registry';
import { TerminalApp } from './TerminalApp';
import { TextEditor } from './TextEditor';
import { WebBrowser } from './WebBrowser';
import { WirelessApp } from './WirelessApp';

type App = 'ip' | 'prompt' | 'terminal' | 'browser' | 'wireless' | 'editor';

const APPS: Record<App, { title: string; blurb: string; icon: LucideIcon; tile: string }> = {
  ip: {
    title: 'IP Configuration',
    blurb: 'Address, mask, gateway and DNS',
    icon: NetworkIcon,
    tile: 'bg-accent text-accent-fg',
  },
  prompt: {
    title: 'Command Prompt',
    blurb: 'ping, tracert, ipconfig and arp',
    icon: SquareTerminalIcon,
    tile: 'bg-fg-1 text-surface-1',
  },
  terminal: {
    title: 'Terminal',
    blurb: 'A console over the console cable',
    icon: MonitorCogIcon,
    tile: 'bg-proto-tcp text-surface-1',
  },
  browser: {
    title: 'Web Browser',
    blurb: 'Open pages from HTTP servers',
    icon: GlobeIcon,
    tile: 'bg-proto-icmp text-surface-1',
  },
  wireless: {
    title: 'PC Wireless',
    blurb: 'Join a wireless network',
    icon: WifiIcon,
    tile: 'bg-proto-dhcp text-surface-1',
  },
  editor: {
    title: 'Text Editor',
    blurb: 'Write and edit files on this disk',
    icon: FileTextIcon,
    tile: 'bg-proto-arp text-surface-1',
  },
};

/** A server has no RS232 port, so no Terminal. */
const appsOf = (device: HostDevice) =>
  (Object.keys(APPS) as App[]).filter((id) => id !== 'terminal' || device.kind === 'pc');

// The app each host had open, so stepping between devices comes back to it.
const openApps = new Map<DeviceId, App>();

type Props = { device: HostDevice; focusPrompt: boolean };

/** A PC or server's desktop: its apps as tiles, and the open app with a way back. */
export function HostDesktop(props: Props) {
  return <Desktop key={props.device.id} {...props} />;
}

function Desktop({ device, focusPrompt }: Props) {
  const [app, setApp] = useState(() => openApps.get(device.id));
  const [openedNow, setOpenedNow] = useState(false);
  const open = (next: App | undefined) => {
    if (next) openApps.set(device.id, next);
    else openApps.delete(device.id);
    setApp(next);
    setOpenedNow(next !== undefined);
  };

  if (!device.powered) {
    return (
      <EmptyState icon={PowerIcon} title={`${device.config.hostname} is off`} className="pt-12">
        <p>Turn it on to use its desktop.</p>
        <Button
          size="sm"
          className="mt-3"
          onClick={() => editorStore.getState().setPowered({ device: device.id, powered: true })}
        >
          Turn on
        </Button>
      </EmptyState>
    );
  }

  if (!app) return <Home device={device} onOpen={open} />;

  const { title } = APPS[app];
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-1.5">
        <Button size="sm" variant="ghost" className="pl-1" onClick={() => open(undefined)}>
          <ChevronLeftIcon />
          Desktop
        </Button>
        <span aria-hidden="true" className="text-xs text-fg-3">
          /
        </span>
        <h3 className="ml-1 truncate text-xs font-medium text-fg-1">{title}</h3>
      </div>
      {app === 'ip' ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
          <h4 className="text-2xs font-medium text-fg-3">IPv4</h4>
          <HostAddressForm device={device} />
          <h4 className="border-t border-line pt-3 text-2xs font-medium text-fg-3">IPv6</h4>
          <HostIpv6Form device={device} ipv6Status={hostBackend.ipv6Status} />
        </div>
      ) : app === 'editor' ? (
        <TextEditor device={device} />
      ) : app === 'browser' ? (
        <WebBrowser device={device.id} backend={hostBackend} />
      ) : app === 'wireless' ? (
        <WirelessApp device={device} />
      ) : app === 'terminal' ? (
        <TerminalApp device={device.id} autoFocus={openedNow || focusPrompt} />
      ) : (
        <>
          <div className="min-h-0 flex-1 pt-2 pr-1 pb-2 pl-3">
            <HostPrompt device={device.id} autoFocus={openedNow || focusPrompt} />
          </div>
          <p className="flex shrink-0 items-center gap-1.5 border-t border-line px-3 py-1.5 text-2xs text-fg-3">
            <Kbd>{formatShortcut('toggleBottom')}</Kbd>
            <span className="truncate">opens a wider prompt in the bottom panel</span>
          </p>
        </>
      )}
    </div>
  );
}

function Home({ device, onOpen }: { device: HostDevice; onOpen: (app: App) => void }) {
  return (
    <div className="flex flex-col gap-3 px-3 py-3">
      <NetworkCard device={device} />
      <ul aria-label="Apps" className="grid grid-cols-2 gap-2">
        {appsOf(device).map((id) => {
          const { title, blurb, icon: Icon, tile } = APPS[id];
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => onOpen(id)}
                className="group flex h-full w-full cursor-default flex-col items-start gap-3 rounded-xl border border-line bg-surface-1 p-3 text-left transition-colors duration-150 hover:border-line-strong hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:outline-none"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex size-9 items-center justify-center rounded-[10px] shadow-xs transition-transform duration-150 group-hover:scale-105 motion-reduce:transition-none',
                    tile,
                  )}
                >
                  <Icon className="size-[18px]" strokeWidth={2} />
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className="text-xs font-medium text-fg-1">{title}</span>
                  <span className="text-2xs text-fg-3">{blurb}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** What a student checks first: is it plugged in, and what address does it have. */
function NetworkCard({ device }: { device: HostDevice }) {
  const port = addressPort(device);
  const connected = useEditor(({ topology }) => nicConnected(topology, device));
  const radio = port?.kind === 'wireless';
  const { ipv4 } = device.config;
  const leased = useHostAddressing(device.id);
  // A DHCP host's address is whatever the simulation says it got.
  const live = ipv4.mode === 'dhcp' ? leased : configAddressing(device);
  const address = live && addressOf(live);
  const gateway = live && gatewayOf(live);
  const placeholder = ipv4.mode === 'dhcp' ? 'Waiting for DHCP' : 'No IP address';
  return (
    <section
      aria-label="Network"
      className="flex flex-col gap-1.5 rounded-xl border border-line bg-surface-2/60 px-3 py-2.5"
    >
      <p className="flex items-center gap-1.5 text-2xs text-fg-2">
        <span
          aria-hidden="true"
          className={cn(
            'size-2 rounded-full',
            connected ? 'bg-ok' : 'border-[1.5px] border-fg-3 bg-transparent',
          )}
        />
        {connected ? (radio ? 'Associated' : 'Connected') : radio ? 'Not associated' : 'No cable'}
        {port && <span className="font-mono text-fg-3">{port.id}</span>}
      </p>
      <p className="font-mono text-sm text-fg-1 tabular-nums">
        {address ? formatCidr(address) : placeholder}
        {ipv4.mode === 'dhcp' && address && (
          <span className="ml-1.5 font-sans text-2xs text-fg-3">
            {live?.kind === 'autoconfigured' ? 'APIPA' : 'DHCP'}
          </span>
        )}
      </p>
      <p className="text-2xs text-fg-3">
        {gateway ? (
          <>
            Gateway <span className="font-mono text-fg-2">{gateway}</span>
          </>
        ) : (
          'No default gateway'
        )}
      </p>
    </section>
  );
}
