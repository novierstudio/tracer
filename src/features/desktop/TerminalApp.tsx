import { CableIcon, PowerIcon } from 'lucide-react';
import { lazy, Suspense, useId, useState, type FormEvent } from 'react';
import { Select } from '@/features/inspector/config/controls';
import { appEngine, vtySessions } from '@/features/terminal/registry';
import { consolePeer, type DeviceId } from '@/model';
import { useEditor } from '@/model/react';
import { editorStore } from '@/model/store';
import { Button } from '@/ui/button';
import { EmptyState } from '@/ui/empty-state';
import { createConsoleCables, type ConsoleReach } from './consoleCable';

const XtermView = lazy(() => import('@/features/terminal/XtermView'));

const consoleCables = createConsoleCables(editorStore, appEngine, vtySessions);

/** A serial line's settings, as the Terminal Configuration dialog sets them. They change nothing. */
type LineSettings = {
  bitsPerSecond: string;
  dataBits: string;
  parity: string;
  stopBits: string;
  flowControl: string;
};

/** A Cisco console runs at 9600 8N1 with no flow control. */
const DEFAULTS: LineSettings = {
  bitsPerSecond: '9600',
  dataBits: '8',
  parity: 'None',
  stopBits: '1',
  flowControl: 'None',
};

const FIELDS: readonly { key: keyof LineSettings; label: string; options: readonly string[] }[] = [
  {
    key: 'bitsPerSecond',
    label: 'Bits Per Second',
    options: ['300', '1200', '2400', '4800', '9600', '19200', '38400', '57600', '115200'],
  },
  { key: 'dataBits', label: 'Data Bits', options: ['5', '6', '7', '8'] },
  { key: 'parity', label: 'Parity', options: ['None', 'Odd', 'Even', 'Space', 'Mark'] },
  { key: 'stopBits', label: 'Stop Bits', options: ['1', '1.5', '2'] },
  { key: 'flowControl', label: 'Flow Control', options: ['None', 'RTS/CTS', 'Xon/Xoff'] },
];

// Each PC's settings, and whether its Terminal is connected, so coming back finds them.
const settingsOf = new Map<DeviceId, LineSettings>();
const connected = new Set<DeviceId>();

const HINT =
  "A console session over the PC's console cable. Tab completes a command and ? lists what can come next. Shift+Tab leaves the terminal.";

/**
 * A PC's Terminal app: the Terminal Configuration dialog, then the CLI of the router or switch at
 * the far end of the console cable in its RS232 port.
 */
export function TerminalApp({ device, autoFocus }: { device: DeviceId; autoFocus: boolean }) {
  const [open, setOpen] = useState(() => connected.has(device));
  // Read again whenever the cable or the far device changes, so a new cable opens a new console.
  const peer = useEditor(({ topology }) => {
    const end = consolePeer(topology, device);
    const far = end && topology.devices[end.device];
    return far ? `${far.id} ${far.powered}` : '';
  });
  const close = () => {
    connected.delete(device);
    setOpen(false);
  };
  if (!open) {
    return (
      <Settings
        device={device}
        onConnect={() => {
          connected.add(device);
          setOpen(true);
        }}
      />
    );
  }
  return (
    <Session
      key={peer}
      reach={consoleCables.connect(device)}
      autoFocus={autoFocus}
      onBack={close}
    />
  );
}

function Session({
  reach,
  autoFocus,
  onBack,
}: {
  reach: ConsoleReach;
  autoFocus: boolean;
  onBack: () => void;
}) {
  if (reach.kind === 'open') {
    return (
      <div className="min-h-0 flex-1 pt-2 pr-1 pb-2 pl-3">
        <Suspense>
          <XtermView tty={reach.tty} autoFocus={autoFocus} hint={HINT} />
        </Suspense>
      </div>
    );
  }
  const back = (
    <Button size="sm" className="mt-3" onClick={onBack}>
      Back to settings
    </Button>
  );
  return reach.kind === 'no-cable' ? (
    <EmptyState icon={CableIcon} title="No console cable" className="pt-12">
      <p>
        Connect this PC&apos;s RS232 port to a router or switch&apos;s Console port with a console
        cable, then connect again.
      </p>
      {back}
    </EmptyState>
  ) : (
    <EmptyState icon={PowerIcon} title={`${reach.hostname} is off`} className="pt-12">
      <p>
        The console cable reaches {reach.hostname}, but it is powered off. Turn it on to connect.
      </p>
      {back}
    </EmptyState>
  );
}

function Settings({ device, onConnect }: { device: DeviceId; onConnect: () => void }) {
  const [settings, setSettings] = useState(() => settingsOf.get(device) ?? DEFAULTS);
  const id = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    settingsOf.set(device, settings);
    onConnect();
  };
  return (
    <form
      aria-label="Terminal configuration"
      onSubmit={submit}
      className="flex flex-col gap-3 px-3 py-3"
    >
      <fieldset className="flex flex-col gap-2.5 rounded-xl border border-line px-3 pt-1.5 pb-3">
        <legend className="px-1 text-2xs font-medium text-fg-3">Port Configuration</legend>
        {FIELDS.map(({ key, label, options }) => (
          <div key={key} className="grid grid-cols-[7.5rem_1fr] items-center gap-2">
            <label htmlFor={`${id}-${key}`} className="text-xs text-fg-2">
              {label}:
            </label>
            <Select
              id={`${id}-${key}`}
              value={settings[key]}
              onChange={(event) => setSettings({ ...settings, [key]: event.target.value })}
            >
              {options.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          </div>
        ))}
      </fieldset>
      <p className="text-2xs text-fg-3">
        The far end of this PC&apos;s console cable answers whatever the settings. A Cisco console
        runs at 9600 baud, 8 data bits, no parity, 1 stop bit.
      </p>
      <Button type="submit" size="sm" variant="primary" className="self-end">
        OK
      </Button>
    </form>
  );
}
