import {
  ActivityIcon,
  ArrowRightIcon,
  BookmarkCheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleXIcon,
  EyeOffIcon,
  MinusIcon,
  NetworkIcon,
  ReplyIcon,
  RouteIcon,
  SearchIcon,
  Share2Icon,
  XIcon,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useState, type KeyboardEvent } from 'react';
import type { FrameEvent } from '@/engine/events';
import { shortPortName } from '@/features/canvas/cables';
import { useEditor } from '@/model/react';
import { Button } from '@/ui/button';
import { cn } from '@/ui/cn';
import { Tooltip } from '@/ui/tooltip';
import { simulation } from './controller';
import type { Decision } from './pdu/decision';
import { inspect, type PduView } from './pdu/inspect';
import type { Field, Layer, LayerId } from './pdu/layers';
import { PROTOCOLS, protocolOf, visibleFrames } from './protocols';
import { useSimulation } from './store';
import { formatTime } from './Timeline';

type Tone = 'accent' | 'ok' | 'err' | 'muted';

/** Each kind of decision's icon, its tone, and the layer where it happened. */
const DECISION_LOOK: Record<Decision['kind'], { icon: LucideIcon; tone: Tone; layer: LayerId[] }> =
  {
    lost: { icon: CircleXIcon, tone: 'err', layer: ['physical'] },
    'link-test': { icon: ActivityIcon, tone: 'muted', layer: ['hello'] },
    'spanning-tree': { icon: NetworkIcon, tone: 'accent', layer: ['bpdu'] },
    routed: { icon: ArrowRightIcon, tone: 'accent', layer: ['ipv4'] },
    switched: { icon: ArrowRightIcon, tone: 'accent', layer: ['dot1q', 'ethernet'] },
    flooded: { icon: Share2Icon, tone: 'accent', layer: ['dot1q', 'ethernet'] },
    replied: { icon: ReplyIcon, tone: 'accent', layer: ['icmp', 'arp'] },
    resolving: { icon: SearchIcon, tone: 'accent', layer: ['ipv4'] },
    learned: { icon: BookmarkCheckIcon, tone: 'accent', layer: ['arp'] },
    received: { icon: CircleCheckIcon, tone: 'ok', layer: ['icmp'] },
    dhcp: { icon: ReplyIcon, tone: 'accent', layer: ['dhcp'] },
    rip: { icon: RouteIcon, tone: 'accent', layer: ['rip'] },
    dropped: { icon: CircleXIcon, tone: 'err', layer: ['dhcp', 'ipv4', 'dot1q', 'ethernet'] },
    ignored: {
      icon: EyeOffIcon,
      tone: 'muted',
      layer: ['arp', 'dhcp', 'rip', 'ipv4', 'bpdu', 'ethernet'],
    },
    silent: { icon: MinusIcon, tone: 'muted', layer: [] },
  };

const TONE_CLASS: Record<Tone, string> = {
  accent: 'border-accent/25 bg-accent/8 [&_svg]:text-accent-text',
  ok: 'border-ok/30 bg-ok/8 [&_svg]:text-ok',
  err: 'border-err/30 bg-err/8 [&_svg]:text-err',
  muted: 'border-line bg-surface-2 [&_svg]:text-fg-3',
};

/** The layer to open first: where the device made its decision, else the innermost one. */
function firstLayer(view: PduView, decision: Decision | undefined): LayerId {
  const ids = view.layers.map((layer) => layer.id);
  const wanted = decision ? DECISION_LOOK[decision.kind].layer : [];
  return wanted.find((id) => ids.includes(id)) ?? ids.findLast((id) => id !== 'quoted')!;
}

const BYTES_PER_ROW = 8;

/** Which field and layer each byte belongs to. */
function byteOwners(layers: readonly Layer[], length: number) {
  const owners: { field: string; layer: LayerId }[] = new Array(length);
  for (const layer of layers) {
    for (const field of layer.fields) {
      if (!field.bytes) continue;
      for (let index = field.bytes[0]; index < field.bytes[1]; index++) {
        owners[index] = { field: field.id, layer: layer.id };
      }
    }
  }
  return owners;
}

function LayerList({
  view,
  selected,
  onSelect,
}: {
  view: PduView;
  selected: LayerId;
  onSelect: (id: LayerId) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Layers"
      aria-orientation="vertical"
      className="flex w-44 shrink-0 flex-col gap-px overflow-y-auto border-r border-line p-1"
    >
      {view.layers.map((layer) => {
        const changed = layer.fields.some((field) => view.changed.has(field.id));
        const active = layer.id === selected;
        return (
          <button
            key={layer.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(layer.id)}
            className={cn(
              'group flex cursor-default items-start gap-2 rounded-md px-2 py-1 text-left transition-colors duration-150 outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent/40',
              active && 'bg-surface-2 shadow-[inset_2px_0_0_var(--accent)]',
            )}
          >
            <span
              className={cn(
                'mt-px shrink-0 rounded-[4px] px-1 font-mono text-[10px] leading-4 font-semibold',
                active ? 'bg-accent text-accent-fg' : 'bg-surface-3 text-fg-2',
              )}
            >
              L{layer.osi}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-xs font-medium text-fg-1">
                <span className="truncate">{layer.name}</span>
                {changed && (
                  <span
                    aria-label="changed"
                    title="Changed on the way out"
                    className="size-1.5 shrink-0 rounded-full bg-warn"
                  />
                )}
              </span>
              <span className="block truncate text-2xs text-fg-3 tabular-nums">
                {layer.summary}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function FieldRow({
  field,
  was,
  hovered,
  onHover,
}: {
  field: Field;
  was: string | undefined;
  hovered: boolean;
  onHover: (id: string | undefined) => void;
}) {
  return (
    <div
      role="row"
      data-field={field.id}
      onPointerEnter={() => onHover(field.id)}
      onPointerLeave={() => onHover(undefined)}
      className={cn(
        'grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 rounded-md px-2 py-1 transition-colors duration-150',
        hovered && 'bg-accent/10',
      )}
    >
      <span role="rowheader" className="pt-px text-xs text-fg-2">
        {field.label}
      </span>
      <span role="cell" className="min-w-0">
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span
            className={cn(
              'font-mono text-xs font-medium break-all text-fg-1',
              was !== undefined && 'text-warn',
            )}
          >
            {field.value}
          </span>
          {was !== undefined && (
            <span className="rounded-sm bg-warn/12 px-1 font-mono text-2xs text-warn">
              was {was}
            </span>
          )}
        </span>
        <span className="mt-0.5 block text-2xs text-pretty text-fg-3">{field.explain}</span>
      </span>
    </div>
  );
}

function HexView({
  view,
  layer,
  hovered,
  onHover,
  onPick,
}: {
  view: PduView;
  layer: LayerId;
  hovered: string | undefined;
  onHover: (id: string | undefined) => void;
  onPick: (layer: LayerId, field: string) => void;
}) {
  const owners = useMemo(() => byteOwners(view.layers, view.bytes.length), [view]);
  if (view.bytes.length === 0) {
    return (
      <p className="p-3 text-2xs text-fg-3">
        This frame is Tracer’s own link test, so it has no bytes on the wire.
      </p>
    );
  }
  const rows = Math.ceil(view.bytes.length / BYTES_PER_ROW);
  return (
    <div
      aria-label={`${view.bytes.length} bytes`}
      className="grid content-start gap-y-0.5 p-2 font-mono text-[11px] leading-[18px]"
      onPointerLeave={() => onHover(undefined)}
    >
      <p className="mb-1 pl-10 font-sans text-2xs text-fg-3">
        {view.bytes.length} bytes on the wire
      </p>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex gap-2">
          <span className="w-8 shrink-0 text-right text-fg-3/70 select-none">
            {(row * BYTES_PER_ROW).toString(16).padStart(4, '0')}
          </span>
          <span className="flex">
            {Array.from(
              view.bytes.subarray(row * BYTES_PER_ROW, (row + 1) * BYTES_PER_ROW),
              (byte, column) => {
                const index = row * BYTES_PER_ROW + column;
                const owner = owners[index];
                const lit = owner && owner.field === hovered;
                const ownLayer = owner?.layer === layer;
                const changed = owner && view.changed.has(owner.field);
                return (
                  <span
                    key={column}
                    data-byte={index}
                    onPointerEnter={() => owner && onHover(owner.field)}
                    onClick={() => owner && onPick(owner.layer, owner.field)}
                    className={cn(
                      'w-[22px] cursor-default rounded-[3px] text-center transition-colors duration-100',
                      ownLayer ? 'text-fg-1' : 'text-fg-3/60',
                      changed && 'text-warn',
                      lit && 'bg-accent text-accent-fg',
                    )}
                  >
                    {byte.toString(16).padStart(2, '0')}
                  </span>
                );
              },
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function headline(view: PduView) {
  const inner = view.layers.filter((layer) => layer.id !== 'quoted' && layer.id !== 'physical');
  return inner.at(-1)?.summary ?? '';
}

/**
 * Everything about one frame: what the device did with it in a sentence, its layers from the
 * physical port up, each field explained, and its bytes, as it arrived and as it left.
 */
export function PduInspector({ event }: { event: FrameEvent }) {
  const topology = useEditor((state) => state.topology);
  const inspection = useMemo(() => inspect(event, topology), [event, topology]);
  const [viewKey, setViewKey] = useState('in');
  const view =
    inspection.views.find((candidate) => candidate.key === viewKey) ?? inspection.views[0]!;
  const [layerChoice, setLayerChoice] = useState<LayerId>();
  const layerId =
    layerChoice && view.layers.some((layer) => layer.id === layerChoice)
      ? layerChoice
      : firstLayer(view, inspection.decision);
  const layer = view.layers.find((candidate) => candidate.id === layerId)!;
  const [hovered, setHovered] = useState<string>();

  const protocol = PROTOCOLS[protocolOf(event.frame)];
  const name = (id: string) =>
    topology.devices[id as keyof typeof topology.devices]?.config.hostname ?? id;
  const look = inspection.decision ? DECISION_LOOK[inspection.decision.kind] : undefined;
  const Icon = look?.icon ?? MinusIcon;

  // The events the list shows, so the inspector can walk them when the list is hidden.
  const frames = useSimulation((state) => state.frames);
  const hidden = useSimulation((state) => state.hidden);
  const rows = useMemo(() => visibleFrames(frames, hidden), [frames, hidden]);
  const index = rows.indexOf(event);
  const previous = index > 0 ? rows[index - 1] : undefined;
  const next = index >= 0 ? rows[index + 1] : undefined;

  const bytes = (
    <HexView
      view={view}
      layer={layerId}
      hovered={hovered}
      onHover={setHovered}
      onPick={(next, field) => {
        setLayerChoice(next);
        setHovered(field);
      }}
    />
  );

  const onKeyDown = (keyboard: KeyboardEvent) => {
    if (keyboard.key !== 'Escape') return;
    keyboard.stopPropagation();
    simulation.select(undefined);
  };

  return (
    <aside
      aria-label="PDU inspector"
      onKeyDown={onKeyDown}
      className="@container flex min-h-0 min-w-0 flex-1 animate-fade-in flex-col bg-surface-1"
    >
      <header className="flex h-10 shrink-0 items-center gap-2.5 border-b border-line pr-1.5 pl-3">
        <span
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-2xs font-semibold"
          style={{
            background: `color-mix(in oklab, var(${protocol.token}) 16%, transparent)`,
            color: `var(${protocol.token})`,
          }}
        >
          <span aria-hidden className="size-1.5 rounded-full bg-current" />
          {protocol.label}
        </span>
        <h2 className="min-w-0 flex-1 truncate text-xs text-fg-3 tabular-nums">
          <span className="font-semibold text-fg-1">{headline(view)}</span>
          <span className="ml-2">
            {name(event.from.device)} {shortPortName(event.from.port)} → {name(event.to.device)}{' '}
            {shortPortName(event.to.port)} · {formatTime(event.time)}
          </span>
        </h2>
        {inspection.views.length > 1 && (
          <div
            role="tablist"
            aria-label="Frame"
            className="flex h-7 shrink-0 items-center gap-0.5 rounded-md bg-surface-2 p-0.5"
          >
            {inspection.views.map((candidate) => (
              <button
                key={candidate.key}
                type="button"
                role="tab"
                aria-selected={candidate.key === view.key}
                onClick={() => setViewKey(candidate.key)}
                className={cn(
                  'inline-flex h-full cursor-default items-center gap-1 rounded-[5px] px-2 text-2xs font-medium text-fg-2 transition-colors duration-150 outline-none hover:text-fg-1 focus-visible:ring-2 focus-visible:ring-accent/40',
                  candidate.key === view.key && 'bg-surface-1 text-fg-1 shadow-xs',
                )}
              >
                {candidate.direction === 'out' && <ArrowRightIcon className="size-3" />}
                {candidate.label}
              </button>
            ))}
          </div>
        )}
        <div className="flex shrink-0 items-center">
          <Tooltip label="Previous event">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Previous event"
              disabled={!previous}
              onClick={() => previous && simulation.select(previous.id)}
            >
              <ChevronLeftIcon />
            </Button>
          </Tooltip>
          <Tooltip label="Next event">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Next event"
              disabled={!next}
              onClick={() => next && simulation.select(next.id)}
            >
              <ChevronRightIcon />
            </Button>
          </Tooltip>
        </div>
        <Tooltip label="Close inspector" shortcut="Esc">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close inspector"
            onClick={() => simulation.select(undefined)}
          >
            <XIcon />
          </Button>
        </Tooltip>
      </header>

      {inspection.sentence && (
        <p
          role="status"
          aria-label="What the device did"
          className={cn(
            'flex shrink-0 items-start gap-2 border-b px-3 py-1.5 text-xs text-pretty text-fg-1 [&_svg]:mt-px [&_svg]:size-3.5 [&_svg]:shrink-0',
            TONE_CLASS[look?.tone ?? 'muted'],
          )}
        >
          <Icon aria-hidden />
          {inspection.sentence}
        </p>
      )}

      <div className="flex min-h-0 flex-1">
        <LayerList
          view={view}
          selected={layerId}
          onSelect={(id) => {
            setLayerChoice(id);
            setHovered(undefined);
          }}
        />
        {/* The bytes sit beside the fields when there is room, and under them when not. */}
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div role="table" aria-label={`${layer.name} fields`} className="p-1.5">
            {layer.fields.map((field) => (
              <FieldRow
                key={field.id}
                field={field}
                was={view.changed.get(field.id)}
                hovered={hovered === field.id}
                onHover={setHovered}
              />
            ))}
          </div>
          <div className="border-t border-line @[46rem]:hidden">{bytes}</div>
        </div>
        <div className="hidden w-[15rem] shrink-0 overflow-y-auto border-l border-line @[46rem]:block">
          {bytes}
        </div>
      </div>
    </aside>
  );
}
