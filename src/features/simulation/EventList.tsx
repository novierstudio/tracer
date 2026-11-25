import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { FrameEvent } from '@/engine/events';
import { useEditor } from '@/model/react';
import { cn } from '@/ui/cn';
import { simulation } from './controller';
import { describeFrame, PROTOCOLS, protocolOf, visibleFrames } from './protocols';
import { useSimulation } from './store';
import { formatTime } from './Timeline';

const ROW = 28;
const OVERSCAN = 8;
const COLUMNS =
  'grid grid-cols-[5.5rem_minmax(5rem,8rem)_minmax(5rem,8rem)_4.5rem_minmax(0,1fr)] gap-3';

function ProtocolTag({ event }: { event: FrameEvent }) {
  const { label, token } = PROTOCOLS[protocolOf(event.frame)];
  return (
    <span className="inline-flex items-center gap-1.5 font-semibold text-fg-1">
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{ background: `var(${token})` }}
      />
      {label}
    </span>
  );
}

/**
 * Every frame since Simulation mode began, one row each, rendered only where the list scrolls
 * to. Rows at the current instant are marked, and the list keeps them in view as steps move.
 */
export function EventList() {
  const frames = useSimulation((state) => state.frames);
  const hidden = useSimulation((state) => state.hidden);
  const now = useSimulation((state) => state.now);
  const selected = useSimulation((state) => state.selected);
  const devices = useEditor((state) => state.topology.devices);
  const rows = useMemo(() => visibleFrames(frames, hidden), [frames, hidden]);
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 0 });

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setView({ top: element.scrollTop, height: element.clientHeight });
    const sizes = new ResizeObserver(measure);
    sizes.observe(element);
    measure();
    return () => sizes.disconnect();
  }, []);

  // Follow the current instant: its last row stays in view after each step, either way.
  const lastCurrent = useMemo(() => {
    for (let index = rows.length - 1; index >= 0; index--) {
      if (rows[index]!.time === now) return index;
      if (rows[index]!.time < now) break;
    }
    return -1;
  }, [rows, now]);
  useEffect(() => {
    const element = scroller.current;
    if (!element || lastCurrent < 0) return;
    const top = lastCurrent * ROW;
    if (top < element.scrollTop || top + ROW > element.scrollTop + element.clientHeight) {
      element.scrollTop = Math.max(0, top - element.clientHeight + ROW * 2);
    }
  }, [lastCurrent]);

  const name = (id: string) => devices[id as keyof typeof devices]?.config.hostname ?? id;
  const first = Math.max(0, Math.floor(view.top / ROW) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((view.top + view.height) / ROW) + OVERSCAN);
  const selectedIndex = rows.findIndex((event) => event.id === selected);

  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0 || rows.length === 0) return;
    event.preventDefault();
    const from = selectedIndex < 0 ? (step > 0 ? -1 : rows.length) : selectedIndex;
    const next = rows[Math.min(rows.length - 1, Math.max(0, from + step))]!;
    simulation.select(next.id);
    const element = scroller.current;
    const index = rows.indexOf(next);
    if (
      element &&
      (index * ROW < element.scrollTop ||
        (index + 1) * ROW > element.scrollTop + element.clientHeight)
    ) {
      element.scrollTop = index * ROW - element.clientHeight / 2;
    }
  };

  return (
    <div
      role="grid"
      aria-label="Events"
      aria-rowcount={rows.length + 1}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="flex min-h-0 flex-1 flex-col text-xs outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-inset"
    >
      <div
        role="row"
        aria-rowindex={1}
        className={cn(
          COLUMNS,
          'h-7 shrink-0 items-center border-b border-line px-3 text-2xs font-medium text-fg-3',
        )}
      >
        <span role="columnheader">Time</span>
        <span role="columnheader">Last device</span>
        <span role="columnheader">At device</span>
        <span role="columnheader">Type</span>
        <span role="columnheader">Info</span>
      </div>
      <div
        ref={scroller}
        role="rowgroup"
        onScroll={(event) =>
          setView({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })
        }
        className="relative min-h-0 flex-1 overflow-y-auto"
      >
        <div style={{ height: rows.length * ROW }}>
          {rows.slice(first, last).map((event, offset) => {
            const index = first + offset;
            const current = event.time === now;
            const isSelected = event.id === selected;
            return (
              <div
                key={event.id}
                role="row"
                aria-rowindex={index + 2}
                aria-selected={isSelected}
                data-current={current || undefined}
                onClick={() => simulation.select(event.id)}
                style={{ transform: `translateY(${index * ROW}px)`, height: ROW }}
                className={cn(
                  COLUMNS,
                  'absolute inset-x-0 top-0 cursor-default items-center border-l-2 border-transparent px-3 text-fg-2 select-none hover:bg-surface-2',
                  current && 'border-l-warn bg-warn/8 text-fg-1',
                  isSelected && 'bg-accent/14 text-fg-1 hover:bg-accent/18',
                  event.outcome === 'link-down' && 'text-err',
                )}
              >
                <span role="gridcell" className="text-fg-3 tabular-nums">
                  {formatTime(event.time)}
                </span>
                <span role="gridcell" className="truncate font-medium">
                  {name(event.from.device)}
                </span>
                <span role="gridcell" className="truncate font-medium">
                  {name(event.to.device)}
                </span>
                <span role="gridcell">
                  <ProtocolTag event={event} />
                </span>
                <span
                  role="gridcell"
                  className="truncate tabular-nums"
                  title={describeFrame(event)}
                >
                  {describeFrame(event)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
