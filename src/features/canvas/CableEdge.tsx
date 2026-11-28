import { BaseEdge, useStore, type EdgeProps } from '@xyflow/react';
import { memo, useCallback } from 'react';
import type { LinkId } from '@/model';
import {
  hostnameLabelSize,
  type CableEdgeData,
  type CableFlowEdge,
  type DeviceNodeData,
  type WirelessFlowEdge,
} from './flow';
import { footprint, layoutCable, type Size, type Vec } from './geometry';
import { useLinkLights, type LinkLight } from './lights';

const PORT_LABEL_HEIGHT = 14;

const portLabelSize = (text: string): Size => ({
  width: text.length * 5.6 + 9,
  height: PORT_LABEL_HEIGHT,
});

/** The hostname data of a node, which only changes when its label does, not when it moves. */
function useNodeData(id: string): DeviceNodeData | undefined {
  return useStore(
    useCallback((state) => state.nodeLookup.get(id)?.data as DeviceNodeData | undefined, [id]),
  );
}

function Light({ at, state }: { at: Vec; state: LinkLight }) {
  if (state === 'down') {
    const d = 2.6;
    return (
      <g className="link-light" data-state={state}>
        <circle cx={at.x} cy={at.y} r={4.5} />
        <path d={`M${at.x - d},${at.y - d}l${2 * d},${2 * d}m0,${-2 * d}l${-2 * d},${2 * d}`} />
      </g>
    );
  }
  return <circle className="link-light" data-state={state} cx={at.x} cy={at.y} r={3.5} />;
}

function PortLabel({ at, text }: { at: Vec; text: string }) {
  const { width, height } = portLabelSize(text);
  return (
    <g className="port-label" transform={`translate(${at.x} ${at.y})`}>
      <rect x={-width / 2} y={-height / 2} width={width} height={height} rx={4} />
      <text textAnchor="middle" dominantBaseline="central">
        {text}
      </text>
    </g>
  );
}

export const CableEdge = memo(function CableEdge(props: EdgeProps<CableFlowEdge>) {
  const { id, source, target, sourceX, sourceY, targetX, targetY, interactionWidth } = props;
  const { cable, ports, bundle } = props.data as CableEdgeData;
  const sourceData = useNodeData(source);
  const targetData = useNodeData(target);
  const lights = useLinkLights(id as LinkId);
  if (!sourceData || !targetData) return null;

  const layout = layoutCable(
    {
      centre: { x: sourceX, y: sourceY },
      footprint: footprint(hostnameLabelSize(sourceData)),
      portLabel: portLabelSize(ports[0]),
    },
    {
      centre: { x: targetX, y: targetY },
      footprint: footprint(hostnameLabelSize(targetData)),
      portLabel: portLabelSize(ports[1]),
    },
    cable === 'serial',
  );

  return (
    <g className="cable" data-cable={cable} data-bundle={bundle}>
      <BaseEdge
        id={id}
        path={layout.path}
        className="cable-path"
        interactionWidth={interactionWidth ?? 16}
      />
      {layout.lights && cable !== 'console' && (
        <>
          <Light at={layout.lights[0]} state={lights.a} />
          <Light at={layout.lights[1]} state={lights.b} />
        </>
      )}
      {layout.labels && (
        <>
          <PortLabel at={layout.labels[0]} text={ports[0]} />
          <PortLabel at={layout.labels[1]} text={ports[1]} />
        </>
      )}
    </g>
  );
});

/**
 * A host's association with an access point or home router: a dotted line between the two tiles
 * with radio arcs at the host's end, drawn while the link is up, as Packet Tracer draws its waves.
 */
export const WirelessEdge = memo(function WirelessEdge(props: EdgeProps<WirelessFlowEdge>) {
  const { id, sourceX, sourceY, targetX, targetY } = props;
  const lights = useLinkLights(id as LinkId);
  if (lights.a === 'down') return null;
  const length = Math.hypot(targetX - sourceX, targetY - sourceY) || 1;
  const ux = (targetX - sourceX) / length;
  const uy = (targetY - sourceY) / length;
  const reach = Math.min(34, length / 2);
  const from = { x: sourceX + ux * reach, y: sourceY + uy * reach };
  const to = { x: targetX - ux * reach, y: targetY - uy * reach };
  const angle = (Math.atan2(uy, ux) * 180) / Math.PI;
  return (
    <g className="wireless" data-state={lights.a}>
      <path className="wireless-path" d={`M${from.x},${from.y}L${to.x},${to.y}`} />
      <g transform={`translate(${from.x} ${from.y}) rotate(${angle})`}>
        <path className="wireless-waves" d="M4,-4a6,6 0 0 1 0,8M8,-7a10,10 0 0 1 0,14" />
      </g>
    </g>
  );
});
