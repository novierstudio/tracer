import { useStore } from '@xyflow/react';
import {
  CableIcon,
  CircleAlertIcon,
  MinusIcon,
  MousePointer2Icon,
  PlusIcon,
  ScanIcon,
  StickyNoteIcon,
  TagIcon,
  WorkflowIcon,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { formatShortcut, type ShortcutId } from '@/app/shell/shortcuts';
import { useEditor } from '@/model/react';
import type { Cable, DeviceId } from '@/model';
import { Button } from '@/ui/button';
import { Kbd } from '@/ui/kbd';
import { Segmented } from '@/ui/segmented';
import { Tooltip } from '@/ui/tooltip';
import { CABLE_CHOICES, shortPortName, type CableChoice } from './cables';
import { cableTool, useCableTool, type CableStep } from './cableTool';
import { ALIGN_EDGES } from './arrange';
import {
  addNote,
  ALIGN_LABELS,
  autoLayoutAndFit,
  DISTRIBUTE_LABELS,
  fitView,
  togglePortLabels,
  usePortLabels,
  viewCentre,
  zoomBy,
  zoomToActualSize,
} from './controller';
import { align, distribute } from './edit';

type ToolButtonProps = {
  label: string;
  icon: LucideIcon;
  shortcut?: ShortcutId;
  pressed?: boolean;
  disabled?: boolean;
  side?: 'top' | 'bottom';
  onClick: () => void;
};

function ToolButton({
  label,
  icon: Icon,
  shortcut,
  pressed,
  disabled,
  side = 'top',
  onClick,
}: ToolButtonProps) {
  return (
    <Tooltip label={label} shortcut={shortcut && formatShortcut(shortcut)} side={side}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
      >
        <Icon />
      </Button>
    </Tooltip>
  );
}

const SWATCH: Record<Cable, string> = {
  straight: 'M1 5h18',
  crossover: 'M1 5h18',
  serial: 'M1 5h6l2-4 2 8 2-4h6',
};

/** A short sample of how each cable type is drawn on the canvas. */
function CableSwatch({ cable }: { cable: CableChoice }) {
  return (
    <svg viewBox="0 0 20 10" className="!h-2.5 !w-5" aria-hidden data-cable={cable}>
      {cable === 'auto' ? (
        <>
          <path d="M1 5h7" className="cable-swatch" />
          <path d="M12 5h7" className="cable-swatch" strokeDasharray="2.5 2" />
          <circle cx="10" cy="5" r="1.5" fill="currentColor" />
        </>
      ) : (
        <path d={SWATCH[cable]} className="cable-swatch" />
      )}
    </svg>
  );
}

const CABLE_TOOLBAR_LABELS: Record<CableChoice, string> = {
  auto: 'Auto',
  straight: 'Straight',
  crossover: 'Crossover',
  serial: 'Serial',
};

const CABLE_OPTIONS = CABLE_CHOICES.map((cable) => ({
  value: cable,
  label: CABLE_TOOLBAR_LABELS[cable],
  icon: <CableSwatch cable={cable} />,
}));

const Divider = () => <span aria-hidden className="mx-1 h-5 w-px bg-line" />;

/** Align and distribute, shown while two or more devices are selected. */
function ArrangeButtons({ count }: { count: number }) {
  return (
    <div role="group" aria-label="Arrange" className="flex animate-fade-in items-center gap-0.5">
      {ALIGN_EDGES.map((edge) => (
        <ToolButton
          key={edge}
          side="bottom"
          label={ALIGN_LABELS[edge].title}
          icon={ALIGN_LABELS[edge].icon}
          onClick={() => align(edge)}
        />
      ))}
      <Divider />
      {(['horizontal', 'vertical'] as const).map((axis) => (
        <ToolButton
          key={axis}
          side="bottom"
          label={
            count < 3
              ? `${DISTRIBUTE_LABELS[axis].title} (select 3 or more)`
              : DISTRIBUTE_LABELS[axis].title
          }
          icon={DISTRIBUTE_LABELS[axis].icon}
          disabled={count < 3}
          onClick={() => distribute(axis)}
        />
      ))}
    </div>
  );
}

export function Toolbar() {
  const cabling = useCableTool((state) => state.step !== null);
  const cable = useCableTool((state) => state.cable);
  const selected = useEditor((state) => state.selection.devices.length);
  const devices = useEditor((state) => Object.keys(state.topology.devices).length);
  return (
    <div
      role="toolbar"
      aria-label="Canvas tools"
      className="flex items-center gap-0.5 rounded-lg border border-line bg-surface-1 p-1 shadow-pop"
    >
      <ToolButton
        label="Select"
        icon={MousePointer2Icon}
        shortcut="selectTool"
        pressed={!cabling}
        onClick={() => cableTool.getState().exit()}
      />
      <ToolButton
        label="Cable"
        icon={CableIcon}
        shortcut="cableTool"
        pressed={cabling}
        onClick={() => cableTool.getState().toggle()}
      />
      <ToolButton
        label="Note"
        icon={StickyNoteIcon}
        shortcut="addNote"
        onClick={() => addNote(viewCentre())}
      />
      <Divider />
      <ToolButton
        label="Auto-layout"
        icon={WorkflowIcon}
        disabled={devices < 2}
        onClick={autoLayoutAndFit}
      />
      {!cabling && selected >= 2 && (
        <>
          <Divider />
          <ArrangeButtons count={selected} />
        </>
      )}
      {cabling && (
        <>
          <Divider />
          <Segmented
            label="Cable type"
            value={cable}
            onValueChange={(next) => cableTool.getState().chooseCable(next)}
            options={CABLE_OPTIONS}
            className="h-7"
          />
        </>
      )}
    </div>
  );
}

export function ZoomControls() {
  const zoom = useStore((state) => state.transform[2]);
  const portLabels = usePortLabels();
  return (
    <div
      role="toolbar"
      aria-label="Zoom"
      className="flex items-center gap-0.5 rounded-lg border border-line bg-surface-1 p-0.5 shadow-pop"
    >
      <ToolButton
        label="Zoom out"
        icon={MinusIcon}
        shortcut="zoomOut"
        onClick={() => zoomBy('out')}
      />
      <Tooltip label="Zoom to 100%" side="top">
        <button
          type="button"
          aria-label={`Zoom to 100%, now ${Math.round(zoom * 100)}%`}
          onClick={zoomToActualSize}
          className="h-7 w-11 cursor-default rounded-md text-2xs font-medium text-fg-2 tabular-nums transition-colors hover:bg-surface-2 hover:text-fg-1"
        >
          {Math.round(zoom * 100)}%
        </button>
      </Tooltip>
      <ToolButton label="Zoom in" icon={PlusIcon} shortcut="zoomIn" onClick={() => zoomBy('in')} />
      <span aria-hidden className="mx-0.5 h-4 w-px bg-line" />
      <ToolButton label="Fit view" icon={ScanIcon} shortcut="fitView" onClick={fitView} />
      <ToolButton
        label="Port labels"
        icon={TagIcon}
        pressed={portLabels}
        onClick={togglePortLabels}
      />
    </div>
  );
}

function useHostname(device: DeviceId | undefined): string {
  return useEditor((state) => (device && state.topology.devices[device]?.config.hostname) || '');
}

function hintFor(step: CableStep, source: string, target: string): ReactNode {
  switch (step.at) {
    case 'source':
      return 'Click a device to plug in the first end';
    case 'source-port':
      return `Choose a port on ${source}`;
    case 'target':
      return (
        <>
          Click the device to connect{' '}
          <span className="font-medium text-fg-1">
            {source} {shortPortName(step.source.port)}
          </span>{' '}
          to
        </>
      );
    case 'target-port':
      return `Choose a port on ${target}`;
  }
}

const NOTICE_MS = 4500;

function NoticeToast() {
  const notice = useCableTool((state) => state.notice);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => cableTool.getState().clearNotice(notice.id), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);
  return (
    <div role="alert" className="contents">
      {notice && (
        <p
          key={notice.id}
          className="flex max-w-md animate-fade-in items-start gap-2 rounded-lg border border-err/30 bg-surface-1 px-3 py-2 text-xs text-fg-1 shadow-pop"
        >
          <CircleAlertIcon className="mt-px size-4 shrink-0 text-err" aria-hidden />
          {notice.message}
        </p>
      )}
    </div>
  );
}

export function ToolHint() {
  const step = useCableTool((state) => state.step);
  const sourceDevice =
    step?.at === 'source-port'
      ? step.device
      : step && 'source' in step
        ? step.source.device
        : undefined;
  const source = useHostname(sourceDevice);
  const target = useHostname(step?.at === 'target-port' ? step.device : undefined);
  return (
    <>
      <NoticeToast />
      {step && (
        <p
          aria-live="polite"
          className="flex animate-fade-in items-center gap-2 rounded-full border border-line bg-surface-1 py-1 pr-1.5 pl-3 text-xs text-fg-2 shadow-pop"
        >
          <CableIcon className="size-3.5 shrink-0 text-accent-text" aria-hidden />
          <span>{hintFor(step, source, target)}</span>
          <span className="flex items-center gap-1 pl-1 text-fg-3">
            <Kbd>Esc</Kbd>
            {step.at === 'source' ? 'to finish' : 'to cancel'}
          </span>
        </p>
      )}
    </>
  );
}
