import { LockIcon, WifiIcon } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { findDeviceModel, WIRELESS_NIC } from '@/devices/catalog';
import {
  associations,
  PortId,
  radioOf,
  WirelessSecurity,
  type Device,
  type DeviceId,
  type PortSpec,
  type WirelessRadio,
} from '@/model';
import { useEditor } from '@/model/react';
import { editorStore } from '@/model/store';
import { Button } from '@/ui/button';
import { cn } from '@/ui/cn';
import { addressPort, type HostDevice } from './format';

type Network = { device: DeviceId; name: string; radio: WirelessRadio };

/** The card a host goes back to: its model's Ethernet port, or FastEthernet0. */
function wiredCard(device: HostDevice): PortSpec {
  const port = findDeviceModel(device.model)?.ports.find((spec) => spec.kind !== 'wireless');
  return port ?? { kind: 'fastEthernet', id: PortId.parse('FastEthernet0') };
}

/** Every radio on a powered device, by SSID: the networks a PC Wireless app lists. */
function networksOf(devices: Record<DeviceId, Device>): Network[] {
  return Object.values(devices).flatMap((device) => {
    const offered = device.powered ? radioOf(device) : undefined;
    return offered
      ? [{ device: device.id, name: device.config.hostname, radio: offered.radio }]
      : [];
  });
}

const SECURITY_LABELS: Record<WirelessSecurity['mode'], string> = {
  none: 'Open',
  'wpa2-psk': 'WPA2 Personal',
};

/**
 * Packet Tracer's PC Wireless app: the link the wireless card has, and the networks in range to
 * join with their key. A host with an Ethernet card gets the choice to swap in a wireless one, as
 * its Physical tab offers.
 */
export function WirelessApp({ device }: { device: HostDevice }) {
  const port = addressPort(device);
  const devices = useEditor((state) => state.topology.devices);
  const swap = (spec: PortSpec) =>
    editorStore.getState().swapNic({ device: device.id, port: spec });

  if (port?.kind !== 'wireless') {
    return (
      <div className="flex flex-col gap-3 px-3 py-3 text-xs text-fg-2">
        <p>
          {device.config.hostname} has a wired card{port ? ` (${port.id})` : ''}. Swap in a wireless
          card to join a wireless network. A cable in the wired port comes out.
        </p>
        <Button size="sm" className="self-start" onClick={() => swap(WIRELESS_NIC)}>
          Install a wireless card
        </Button>
      </div>
    );
  }

  const association = associations(Object.values(devices)).find(
    (link) => link.a.device === device.id,
  );
  const ap = association && devices[association.b.device];
  const profile = device.config.wireless;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
      <section aria-label="Link information" className="flex flex-col gap-1 text-xs">
        <h4 className="text-2xs font-medium text-fg-3">Link information</h4>
        {ap && profile ? (
          <p role="status" className="text-fg-1">
            Associated with <span className="font-medium">{profile.ssid}</span> on{' '}
            {ap.config.hostname}
          </p>
        ) : (
          <p role="status" className="text-fg-2">
            {profile
              ? `Not associated: no access point offers ${profile.ssid} with that key.`
              : 'Not associated with any network.'}
          </p>
        )}
        {profile && (
          <Button
            size="sm"
            variant="ghost"
            className="self-start"
            onClick={() =>
              editorStore.getState().updateConfig({
                device: device.id,
                kind: device.kind,
                config: { ...device.config, wireless: undefined },
              })
            }
          >
            Disconnect
          </Button>
        )}
      </section>
      <section aria-label="Networks" className="flex flex-col gap-1.5 border-t border-line pt-3">
        <h4 className="text-2xs font-medium text-fg-3">Networks in range</h4>
        <NetworkList device={device} networks={networksOf(devices)} />
      </section>
      <div className="border-t border-line pt-3">
        <Button size="sm" variant="ghost" onClick={() => swap(wiredCard(device))}>
          Swap back to a wired card
        </Button>
      </div>
    </div>
  );
}

function NetworkList({ device, networks }: { device: HostDevice; networks: Network[] }) {
  const [picked, setPicked] = useState<string>();
  if (networks.length === 0) {
    return <p className="text-xs text-fg-3">No wireless networks in range.</p>;
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {networks.map((network) => {
        const key = `${network.device}`;
        const { ssid, security, channel } = network.radio;
        return (
          <li key={key} className="rounded-lg border border-line bg-surface-1">
            <button
              type="button"
              aria-expanded={picked === key}
              onClick={() => setPicked(picked === key ? undefined : key)}
              className="flex w-full cursor-default items-center gap-2 px-2.5 py-2 text-left hover:bg-surface-2"
            >
              <WifiIcon aria-hidden className="size-4 text-fg-2" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-fg-1">{ssid}</span>
                <span className="block text-2xs text-fg-3">
                  {SECURITY_LABELS[security.mode]} · channel {channel} · {network.name}
                </span>
              </span>
              {security.mode !== 'none' && <LockIcon aria-hidden className="size-3.5 text-fg-3" />}
            </button>
            {picked === key && (
              <JoinForm device={device} network={network} onDone={() => setPicked(undefined)} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Joins a network: its SSID, and with WPA2 the passphrase typed here, become the card's profile. */
function JoinForm({
  device,
  network,
  onDone,
}: {
  device: HostDevice;
  network: Network;
  onDone: () => void;
}) {
  const id = useId();
  const secured = network.radio.security.mode === 'wpa2-psk';
  const [key, setKey] = useState('');
  const [error, setError] = useState<string>();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const security = WirelessSecurity.safeParse(
      secured ? { mode: 'wpa2-psk', passphrase: key } : { mode: 'none' },
    );
    if (!security.success) {
      setError(security.error.issues[0]?.message ?? 'Invalid key');
      return;
    }
    const wireless = { ssid: network.radio.ssid, security: security.data };
    editorStore.getState().updateConfig({
      device: device.id,
      kind: device.kind,
      config: { ...device.config, wireless },
    });
    onDone();
  };
  return (
    <form
      aria-label={`Join ${network.radio.ssid}`}
      onSubmit={submit}
      className="flex flex-col gap-2 border-t border-line px-2.5 py-2"
    >
      {secured && (
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-key`} className="text-2xs text-fg-3">
            Pre-shared key
          </label>
          <input
            id={`${id}-key`}
            type="password"
            value={key}
            autoFocus
            autoComplete="off"
            aria-invalid={error !== undefined}
            onChange={(event) => {
              setKey(event.target.value);
              setError(undefined);
            }}
            className={cn(
              'h-7 rounded-md border border-line bg-surface-1 px-2 font-mono text-[0.6875rem] text-fg-1 outline-none focus-visible:border-accent',
              error && 'border-err/70',
            )}
          />
          {error && <p className="text-2xs text-err">{error}</p>}
        </div>
      )}
      <Button size="sm" variant="primary" type="submit" className="self-end">
        Connect
      </Button>
    </form>
  );
}
