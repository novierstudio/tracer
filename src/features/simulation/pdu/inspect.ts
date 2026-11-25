import type { FrameEvent, SentFrame } from '@/engine/events';
import type { Frame } from '@/engine/frame';
import { shortPortName } from '@/features/canvas/cables';
import { linkAt, type Cable, type Endpoint, type PortId, type Topology } from '@/model';
import { decide, describeDecision, type Decision } from './decision';
import { dissect, type Dissection, type Field, type Layer } from './layers';

/**
 * One frame as the inspector shows it: as it arrived at the device, or as the device sent it on.
 * Each view adds the physical layer, which depends on where the frame was, to its dissection.
 */
export type PduView = {
  readonly key: string;
  readonly label: string;
  readonly direction: 'in' | 'out';
  readonly layers: readonly Layer[];
  readonly bytes: Uint8Array;
  /** The fields a device changed on the way out, by id, with the value they arrived with. */
  readonly changed: ReadonlyMap<string, string>;
};

export type Inspection = {
  readonly device: string;
  readonly decision: Decision | undefined;
  readonly sentence: string | undefined;
  readonly views: readonly PduView[];
};

const CABLES: Record<Cable, { name: string; explain: string }> = {
  straight: {
    name: 'Copper straight-through',
    explain: 'Joins unlike devices, such as a PC and a switch, or a switch and a router.',
  },
  crossover: {
    name: 'Copper crossover',
    explain: 'Joins like devices, such as two switches or a PC and a router.',
  },
  serial: {
    name: 'Serial',
    explain: 'A WAN link between two routers. The DCE end sets the clock rate.',
  },
};

function physicalLayer(
  topology: Topology,
  here: Endpoint,
  direction: 'in' | 'out',
  lost: boolean,
): Layer {
  const name = (end: Endpoint) => topology.devices[end.device]?.config.hostname ?? end.device;
  const link = linkAt(topology, here);
  const peer =
    link && (link.a.device === here.device && link.a.port === here.port ? link.b : link.a);
  const fields: Field[] = [
    {
      id: 'physical.port',
      label: direction === 'in' ? 'Arrived on' : 'Leaves by',
      value: `${name(here)} ${here.port}`,
      explain:
        direction === 'in'
          ? 'The port where the signal came in. A switch remembers it with the source MAC.'
          : 'The port the device chose for the next hop.',
    },
  ];
  if (peer) {
    fields.push({
      id: 'physical.peer',
      label: direction === 'in' ? 'From' : 'Toward',
      value: `${name(peer)} ${peer.port}`,
      explain: 'The port at the other end of the cable.',
    });
  }
  if (link) {
    fields.push({
      id: 'physical.cable',
      label: 'Cable',
      value: CABLES[link.cable].name,
      explain: CABLES[link.cable].explain,
    });
  }
  fields.push({
    id: 'physical.link',
    label: 'Link',
    value: lost ? 'Down' : 'Up',
    explain: lost
      ? 'The link was down, so the bits never made it across.'
      : 'Both ends are on and connected, so the bits cross as a signal on the wire.',
  });
  return {
    id: 'physical',
    osi: 1,
    name: 'Physical',
    summary: `${name(here)} ${here.port}${peer ? ` ${direction === 'in' ? '←' : '→'} ${name(peer)}` : ''}`,
    fields,
  };
}

function changedFields(before: Dissection, after: Dissection): Map<string, string> {
  const arrived = new Map(
    before.layers.flatMap((layer) => layer.fields.map((f) => [f.id, f.value])),
  );
  const changed = new Map<string, string>();
  for (const field of after.layers.flatMap((layer) => layer.fields)) {
    const was = arrived.get(field.id);
    if (was !== undefined && was !== field.value) changed.set(field.id, was);
  }
  return changed;
}

/** Copies that are the same frame out of several ports, such as a flood, share one view. */
function groupSent(sent: readonly SentFrame[]) {
  const groups = new Map<string, { frame: Frame; ports: PortId[] }>();
  for (const { port, frame } of sent) {
    const key = JSON.stringify(frame);
    const group = groups.get(key);
    if (group) group.ports.push(port);
    else groups.set(key, { frame, ports: [port] });
  }
  return [...groups.values()];
}

/** Everything the inspector shows for one frame event, against the topology as it is now. */
export function inspect(event: FrameEvent, topology: Topology): Inspection {
  const target = topology.devices[event.to.device];
  const device = target?.config.hostname ?? event.to.device;
  const decision = decide(event, target);
  const arrived = dissect(event.frame);
  const lost = event.outcome === 'link-down';
  const views: PduView[] = [
    {
      key: 'in',
      label: lost ? 'Lost' : `At ${device}`,
      direction: 'in',
      layers: [physicalLayer(topology, event.to, 'in', lost), ...arrived.layers],
      bytes: arrived.bytes,
      changed: new Map(),
    },
  ];
  for (const { frame, ports } of groupSent(event.sent ?? [])) {
    const left = dissect(frame);
    const first = ports[0]!;
    views.push({
      key: `out ${ports.join(' ')} ${views.length}`,
      label: `Out ${shortPortName(first)}${ports.length > 1 ? ` +${ports.length - 1}` : ''}`,
      direction: 'out',
      layers: [
        physicalLayer(topology, { device: event.to.device, port: first }, 'out', false),
        ...left.layers,
      ],
      bytes: left.bytes,
      changed: changedFields(arrived, left),
    });
  }
  return {
    device,
    decision,
    sentence: decision && describeDecision(decision, device),
    views,
  };
}
