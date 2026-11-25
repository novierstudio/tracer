import { MailIcon, PauseIcon, PlayIcon, StepBackIcon, StepForwardIcon } from 'lucide-react';
import { useMemo } from 'react';
import { useEditor } from '@/model/react';
import { Button } from '@/ui/button';
import { cn } from '@/ui/cn';
import { Segmented } from '@/ui/segmented';
import { Tooltip } from '@/ui/tooltip';
import { simulation } from './controller';
import { PROTOCOL_IDS, PROTOCOLS, protocolOf, type ProtocolId } from './protocols';
import { PLAY_SPEEDS, useSimulation, type PduStatus, type PlaySpeed } from './store';

const SPEED_OPTIONS = PLAY_SPEEDS.map((speed) => ({
  value: String(speed) as `${PlaySpeed}`,
  label: `${speed}×`,
}));

/** Simulated time, as Packet Tracer's event list shows it: seconds to the millisecond. */
export const formatTime = (ms: number) => `${(ms / 1000).toFixed(3)} s`;

function Transport() {
  const playing = useSimulation((state) => state.playing);
  const canStepBack = useSimulation((state) => state.canStepBack);
  const speed = useSimulation((state) => state.speed);
  return (
    <div className="flex items-center gap-1">
      <Tooltip label="Step back" shortcut="←">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Step back"
          disabled={!canStepBack}
          onClick={simulation.stepBack}
        >
          <StepBackIcon />
        </Button>
      </Tooltip>
      <Tooltip label={playing ? 'Pause' : 'Play'} shortcut="Space">
        <Button
          variant={playing ? 'secondary' : 'primary'}
          size="icon-sm"
          aria-label={playing ? 'Pause' : 'Play'}
          onClick={simulation.togglePlay}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </Button>
      </Tooltip>
      <Tooltip label="Step forward" shortcut="→">
        <Button variant="ghost" size="icon-sm" aria-label="Step forward" onClick={simulation.step}>
          <StepForwardIcon />
        </Button>
      </Tooltip>
      <Segmented
        label="Play speed"
        value={String(speed) as `${PlaySpeed}`}
        onValueChange={(value) => simulation.setSpeed(Number(value) as PlaySpeed)}
        options={SPEED_OPTIONS}
        className="ml-1 h-7 [&>button]:px-1.5 [&>button]:tabular-nums"
      />
    </div>
  );
}

function Clock() {
  const now = useSimulation((state) => state.now);
  return (
    <p className="text-xs whitespace-nowrap text-fg-2 tabular-nums max-md:hidden">
      <span className="text-fg-3">Time </span>
      {formatTime(now)}
    </p>
  );
}

/** One chip per protocol seen so far. A chip that is off hides its events and their packets. */
function ProtocolFilters() {
  const frames = useSimulation((state) => state.frames);
  const hidden = useSimulation((state) => state.hidden);
  const counts = useMemo(() => {
    const seen = new Map<ProtocolId, number>();
    for (const event of frames) {
      const protocol = protocolOf(event.frame);
      seen.set(protocol, (seen.get(protocol) ?? 0) + 1);
    }
    return seen;
  }, [frames]);
  const shown = PROTOCOL_IDS.filter((id) => counts.has(id) || hidden.includes(id));
  if (shown.length === 0) return null;
  return (
    <div role="group" aria-label="Protocol filters" className="flex items-center gap-1">
      {shown.map((id) => {
        const on = !hidden.includes(id);
        return (
          <button
            key={id}
            type="button"
            aria-pressed={on}
            onClick={() => simulation.toggleProtocol(id)}
            className={cn(
              'inline-flex h-6 cursor-default items-center gap-1.5 rounded-full border px-2 text-2xs font-semibold transition-colors duration-150 select-none',
              on
                ? 'border-line-strong bg-surface-1 text-fg-1 hover:bg-surface-2'
                : 'border-dashed border-line-strong bg-transparent text-fg-3 hover:text-fg-2',
            )}
          >
            <span
              aria-hidden
              className={cn('size-2 rounded-full', !on && 'opacity-40')}
              style={{ background: `var(${PROTOCOLS[id].token})` }}
            />
            {PROTOCOLS[id].label}
            <span className="font-medium text-fg-3 tabular-nums">{counts.get(id) ?? 0}</span>
          </button>
        );
      })}
    </div>
  );
}

const STATUS_CLASS: Record<PduStatus, string> = {
  'in flight': 'text-fg-2',
  successful: 'text-ok',
  failed: 'text-err',
};

function PduTool() {
  const active = useSimulation((state) => state.pdu.step !== 'off');
  const last = useSimulation((state) => state.pdus.at(-1));
  const devices = useEditor((state) => state.topology.devices);
  const name = (id: string) => devices[id as keyof typeof devices]?.config.hostname ?? id;
  return (
    <div className="flex min-w-0 items-center gap-2">
      {last && (
        <p
          role="status"
          aria-label="Last PDU"
          className="truncate text-2xs whitespace-nowrap text-fg-3 max-lg:hidden"
        >
          {name(last.source)} → {name(last.destination)}{' '}
          <span className={cn('font-medium', STATUS_CLASS[last.status])}>{last.status}</span>
        </p>
      )}
      <Tooltip label="Click a source device, then a destination, to queue a ping">
        <Button
          variant="secondary"
          size="sm"
          aria-pressed={active}
          onClick={active ? simulation.cancelPdu : simulation.startPdu}
          className="aria-pressed:border-accent aria-pressed:text-accent-text"
        >
          <MailIcon />
          Add simple PDU
        </Button>
      </Tooltip>
    </div>
  );
}

/** The bottom panel's Simulation toolbar: transport, speed, clock, filters and the PDU tool. */
export function Timeline() {
  return (
    <div
      role="toolbar"
      aria-label="Simulation timeline"
      className="flex h-10 shrink-0 items-center gap-3 border-y border-line px-2"
    >
      <Transport />
      <Clock />
      <div className="ml-auto flex min-w-0 items-center gap-3">
        <ProtocolFilters />
        <PduTool />
      </div>
    </div>
  );
}
