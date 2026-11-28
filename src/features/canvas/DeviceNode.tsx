import { Handle, Position, useStore, type NodeProps } from '@xyflow/react';
import { memo, useState, type KeyboardEvent } from 'react';
import { DeviceSprite } from '@/devices/icons';
import { addressOf } from '@/engine/l3/hostAddress';
import { useHostAddressing } from '@/features/simulation/hostAddresses';
import type { DeviceId } from '@/model';
import { cableTool, useCableTool, type CableStep } from './cableTool';
import { useCanvasUi } from './canvasUi';
import { DeviceHoverCard } from './DeviceHoverCard';
import { finishEditing, stopEditing } from './edit';
import { CENTRE_HANDLE, QUICK_BANDS, QUICK_TARGET, type DeviceFlowNode } from './flow';
import { LABEL_GAP } from './geometry';

type CableRole = 'source' | 'target' | undefined;

function cableRole(step: CableStep | null, device: DeviceId): CableRole {
  if (!step) return undefined;
  if (step.at === 'source-port') return step.device === device ? 'source' : undefined;
  if (step.at === 'source') return undefined;
  if (step.source.device === device) return 'source';
  return step.at === 'target-port' && step.device === device ? 'target' : undefined;
}

// Edges attach to the centre handles. They are only anchors, so they are invisible and take no input.
const anchorClass =
  '!pointer-events-none !top-1/2 !left-1/2 !size-0 !min-h-0 !min-w-0 !border-0 !opacity-0';

function RenameField({ hostname }: { hostname: string }) {
  const [value, setValue] = useState(hostname);
  const save = () => {
    const problem = finishEditing(value);
    if (problem) cableTool.getState().notify(problem);
  };
  // Enter saves and Esc cancels. Either way focus goes back to the canvas, which blurs the field.
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    event.preventDefault();
    const canvas = event.currentTarget.closest<HTMLElement>('[aria-label="Canvas"]');
    if (event.key === 'Escape') stopEditing();
    canvas?.focus({ preventScroll: true });
  };
  return (
    <input
      aria-label="Hostname"
      autoFocus
      value={value}
      spellCheck={false}
      onChange={(event) => setValue(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={save}
      onKeyDown={onKeyDown}
      style={{ width: `${Math.max(value.length, 6) + 2}ch` }}
      className="nodrag nopan pointer-events-auto rounded-[4px] bg-surface-1 px-1 py-px text-center text-xs leading-4 font-semibold text-fg-1 shadow-xs ring-2 ring-accent outline-none"
    />
  );
}

export const DeviceNode = memo(function DeviceNode({
  id,
  data,
  dragging,
}: NodeProps<DeviceFlowNode>) {
  const role = useCableTool((state) => cableRole(state.step, id as DeviceId));
  const cabling = useCableTool((state) => state.step !== null);
  const renaming = useCanvasUi(
    (state) => state.edit?.kind === 'rename' && state.edit.device === id,
  );
  const connecting = useStore((state) => state.connection.inProgress);
  const leased = useHostAddressing(id as DeviceId);
  const address = data.dhcp ? leased && addressOf(leased)?.address : data.address;
  return (
    <div className="device-node relative size-12" data-powered={data.powered || undefined}>
      <Handle
        {...CENTRE_HANDLE}
        type="source"
        position={Position.Top}
        isConnectable={false}
        className={anchorClass}
      />
      <Handle
        {...CENTRE_HANDLE}
        type="target"
        position={Position.Top}
        isConnectable={false}
        className={anchorClass}
      />
      <DeviceHoverCard
        device={id as DeviceId}
        disabled={dragging || connecting || cabling || renaming}
      >
        <div className="device-tile relative size-12" data-cable-role={role}>
          {/* A little larger than the tile: a sprite's art never reaches its corners. */}
          <DeviceSprite
            name={data.icon}
            className="pointer-events-none absolute -top-1 -left-1 size-14 max-w-none"
          />
        </div>
      </DeviceHoverCard>
      <Handle
        id={QUICK_TARGET.id}
        type="target"
        position={QUICK_TARGET.position}
        isConnectableStart={false}
        className="quick-target"
      />
      {QUICK_BANDS.map((band) => (
        <Handle
          key={band.id}
          id={band.id}
          type="source"
          position={band.position}
          isConnectableEnd={false}
          title="Drag to another device to connect"
          className="quick-band"
        />
      ))}
      <span
        aria-hidden
        className="device-ports pointer-events-none absolute -top-2 left-[calc(100%-10px)] rounded-full border border-line bg-surface-1 px-1.5 text-[10px] leading-4 font-medium whitespace-nowrap text-fg-2 tabular-nums shadow-xs"
      >
        {data.freePorts}/{data.totalPorts} free
      </span>
      {/* Zero width, so the label centres on the tile without a transform to composite. */}
      <div
        className="pointer-events-none absolute top-full left-1/2 flex w-0 flex-col items-center whitespace-nowrap"
        style={{ marginTop: LABEL_GAP }}
      >
        {renaming ? (
          <RenameField hostname={data.hostname} />
        ) : (
          <span className="device-hostname rounded-[4px] bg-surface-0/85 px-1 py-px text-xs leading-4 font-semibold text-fg-1">
            {data.hostname}
          </span>
        )}
        {address && (
          <span className="device-address rounded-[3px] bg-surface-0/85 px-0.5 font-mono text-[10px] leading-[14px] text-fg-3">
            {address}
          </span>
        )}
      </div>
    </div>
  );
});
