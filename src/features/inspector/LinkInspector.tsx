import { CableIcon, Trash2Icon } from 'lucide-react';
import { setLinkCable, type Cable, type Endpoint, type Link, type Topology } from '@/model';
import { editorStore } from '@/model/store';
import { Button } from '@/ui/button';
import { Segmented } from '@/ui/segmented';
import { deleteItems, selectDevice } from './actions';
import { formatCidr } from './ipv4';
import { DeviceTile, Mono, STATE_LABELS, Section, StateDot } from './parts';
import { CABLE_LABELS, describeModel, linkState, portRows, shortPortName } from './view';

export function LinkInspector({ link, topology }: { link: Link; topology: Topology }) {
  const state = linkState(topology, link);
  const ends = [
    {
      label: 'End A',
      end: link.a,
      role: link.cable === 'serial' ? (link.dce === 'a' ? 'DCE' : 'DTE') : undefined,
    },
    {
      label: 'End B',
      end: link.b,
      role: link.cable === 'serial' ? (link.dce === 'b' ? 'DCE' : 'DTE') : undefined,
    },
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="flex items-center gap-3 px-3 pt-1 pb-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-[11px] border border-line-strong bg-surface-2 text-fg-1">
          <CableIcon className="size-5" strokeWidth={1.75} />
        </span>
        <div className="flex min-w-0 flex-col">
          <h3 className="truncate text-base font-semibold text-fg-1">{CABLE_LABELS[link.cable]}</h3>
          <p className="flex items-center gap-1.5 text-xs text-fg-2">
            <StateDot state={state} />
            Link {STATE_LABELS[state].toLowerCase()}
          </p>
        </div>
      </header>
      <CableSection link={link} topology={topology} />
      <Section title="Endpoints" className="border-t border-line">
        <ul className="flex flex-col gap-2">
          {ends.map(({ label, end, role }) => (
            <EndpointCard key={label} label={label} end={end} role={role} topology={topology} />
          ))}
        </ul>
      </Section>
      <div className="border-t border-line px-3 py-3">
        <Button size="sm" onClick={() => deleteItems([], [link.id])}>
          <Trash2Icon />
          Delete link
        </Button>
      </div>
    </div>
  );
}

const CABLE_CHOICES: Record<Cable, string> = {
  straight: 'Straight-through',
  crossover: 'Crossover',
  serial: 'Serial',
  console: 'Console',
};

/** The cables both ports take, as the model judges them, and the DCE end of a serial cable. */
function CableSection({ link, topology }: { link: Link; topology: Topology }) {
  const fits = (Object.keys(CABLE_CHOICES) as Cable[]).filter(
    (cable) => setLinkCable(topology, { link: link.id, cable }).ok,
  );
  const hostname = (end: Endpoint) => topology.devices[end.device]?.config.hostname ?? '?';
  const { setLinkCable: change } = editorStore.getState();
  return (
    <Section title="Cable" className="border-t border-line">
      {fits.length > 1 && (
        <Segmented
          label="Cable type"
          value={link.cable}
          onValueChange={(cable) => change({ link: link.id, cable })}
          options={fits.map((cable) => ({ value: cable, label: CABLE_CHOICES[cable] }))}
          className="self-start"
        />
      )}
      {link.cable === 'serial' && (
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-fg-3">DCE end (sets the clock)</span>
          <Segmented
            label="DCE end"
            value={link.dce}
            onValueChange={(dce) => change({ link: link.id, cable: 'serial', dce })}
            options={[
              { value: 'a', label: hostname(link.a) },
              { value: 'b', label: hostname(link.b) },
            ]}
          />
        </div>
      )}
    </Section>
  );
}

function EndpointCard({
  label,
  end,
  role,
  topology,
}: {
  label: string;
  end: Endpoint;
  role: string | undefined;
  topology: Topology;
}) {
  const device = topology.devices[end.device];
  if (!device) return null;
  const row = portRows(topology, device).find((candidate) => candidate.id === end.port);
  const address = row && row.layer !== 'switched' && row.ipv4 ? formatCidr(row.ipv4) : undefined;
  return (
    <li>
      <button
        type="button"
        onClick={() => selectDevice(device.id)}
        aria-label={`${label}: ${device.config.hostname} ${end.port}`}
        className="flex w-full cursor-default items-center gap-2.5 rounded-lg border border-line bg-surface-1 p-2 text-left transition-colors duration-150 hover:border-line-strong hover:bg-surface-2"
      >
        <DeviceTile device={device} className="size-8" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate text-xs font-medium text-fg-1">{device.config.hostname}</span>
            <span className="truncate text-2xs text-fg-3">{describeModel(device).name}</span>
          </span>
          <span className="flex min-w-0 items-center gap-2 text-fg-2">
            <Mono>{shortPortName(end.port)}</Mono>
            {address && <Mono className="truncate text-fg-3">{address}</Mono>}
            {row?.admin === 'down' && <span className="text-2xs text-err">shut down</span>}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-2xs text-fg-3">{label}</span>
          {role && (
            <span className="rounded-sm bg-surface-3 px-1 font-mono text-[0.5625rem] text-fg-2">
              {role}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}
