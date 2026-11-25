import { Handle, Position, type NodeProps } from '@xyflow/react';
import { memo } from 'react';
import { DeviceIcon } from '@/devices/icons';
import type { DeviceId } from '@/model';
import { useCableTool, type CableStep } from './cableTool';
import type { DeviceFlowNode } from './flow';
import { LABEL_GAP } from './geometry';

type CableRole = 'source' | 'target' | undefined;

function cableRole(step: CableStep | null, device: DeviceId): CableRole {
  if (!step) return undefined;
  if (step.at === 'source-port') return step.device === device ? 'source' : undefined;
  if (step.at === 'source') return undefined;
  if (step.source.device === device) return 'source';
  return step.at === 'target-port' && step.device === device ? 'target' : undefined;
}

// Edges attach here. The handle is only an anchor, so it is invisible and takes no input.
const handleClass =
  '!pointer-events-none !top-1/2 !left-1/2 !size-0 !min-h-0 !min-w-0 !border-0 !opacity-0';

export const DeviceNode = memo(function DeviceNode({ id, data }: NodeProps<DeviceFlowNode>) {
  const role = useCableTool((state) => cableRole(state.step, id as DeviceId));
  return (
    <div className="device-node relative size-12" data-powered={data.powered || undefined}>
      <Handle type="source" position={Position.Top} isConnectable={false} className={handleClass} />
      <Handle type="target" position={Position.Top} isConnectable={false} className={handleClass} />
      <div className="device-tile size-12" data-cable-role={role}>
        <DeviceIcon name={data.icon} className="size-12 text-fg-1" />
      </div>
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
        <span className="device-hostname rounded-[4px] bg-surface-0/85 px-1 py-px text-xs leading-4 font-semibold text-fg-1">
          {data.hostname}
        </span>
        {data.address && (
          <span className="device-address rounded-[3px] bg-surface-0/85 px-0.5 font-mono text-[10px] leading-[14px] text-fg-3">
            {data.address}
          </span>
        )}
      </div>
    </div>
  );
});
