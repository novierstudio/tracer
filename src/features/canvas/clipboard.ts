import { nextHostname } from '@/devices/create';
import type {
  Annotation,
  AnnotationId,
  Device,
  DeviceId,
  Elements,
  IdSource,
  Link,
  MacAddress,
  Point,
  Port,
  Topology,
} from '@/model';
import { annotationCentre } from './annotations';

/** Copied elements, kept as they were so a later paste does not depend on the lab still having them. */
export type Fragment = { devices: Device[]; links: Link[]; annotations: Annotation[] };

/** The selected devices and annotations, plus every link whose two ends are both copied. */
export function copyFragment(
  topology: Topology,
  {
    devices,
    annotations: annotationIds,
  }: { devices: readonly DeviceId[]; annotations: readonly AnnotationId[] },
): Fragment | undefined {
  const copied = devices.flatMap((id) => topology.devices[id] ?? []);
  const ids = new Set(copied.map((device) => device.id));
  const links = Object.values(topology.links).filter(
    (link) => ids.has(link.a.device) && ids.has(link.b.device),
  );
  const annotations = annotationIds.flatMap((id) => topology.annotations[id] ?? []);
  if (copied.length === 0 && annotations.length === 0) return undefined;
  return { devices: copied, links, annotations };
}

/** Where the fragment's elements sit, as the middle of the box around their centres. */
export function fragmentCentre(fragment: Fragment): Point {
  const points = [
    ...fragment.devices.map((device) => device.position),
    ...fragment.annotations.map(annotationCentre),
  ];
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

// Names keep their stem and take the lowest free number, as placing a new device does, so a copy
// of PC1 in a lab with PC0 and PC1 is PC2. The stem is cut short so the number always fits.
const MAX_STEM = 58;

// A hostname starts with a letter, so the stem is never empty.
const stem = (device: Device) => device.config.hostname.replace(/\d+$/, '').slice(0, MAX_STEM);

/**
 * The fragment as fresh elements for `addElements`: new ids, MACs and hostnames, every position
 * moved by `offset`, and links rewired to the copies.
 */
export function pasteElements(
  topology: Topology,
  fragment: Fragment,
  { ids, offset }: { ids: IdSource; offset: Point },
): Required<Elements> & { devices: Device[]; annotations: Annotation[] } {
  const move = (p: Point): Point => ({ x: p.x + offset.x, y: p.y + offset.y });
  const fresh = <T extends string>(next: () => T, taken: (id: T) => boolean) => {
    let id = next();
    while (taken(id)) id = next();
    return id;
  };

  const names = Object.values(topology.devices).map((device) => device.config.hostname);
  const macs = new Set<MacAddress>(
    Object.values(topology.devices).flatMap((device) =>
      device.ports.flatMap((port) => (port.kind === 'serial' ? [] : [port.mac])),
    ),
  );
  const newIds = new Set<string>();
  const remap = new Map<DeviceId, DeviceId>();

  const devices = fragment.devices.map((device): Device => {
    const id = fresh(ids.deviceId, (c) => c in topology.devices || newIds.has(c));
    newIds.add(id);
    remap.set(device.id, id);
    const hostname = nextHostname(stem(device), names);
    names.push(hostname);
    const ports = device.ports.map((port): Port => {
      if (port.kind === 'serial') return port;
      const mac = fresh(ids.macAddress, (c) => macs.has(c));
      macs.add(mac);
      return { ...port, mac };
    });
    // The spread keeps the kind and its config together, which TypeScript cannot follow.
    return {
      ...device,
      id,
      position: move(device.position),
      ports,
      config: { ...device.config, hostname },
    } as Device;
  });

  const links = fragment.links.map((link): Link => {
    const id = fresh(ids.linkId, (c) => c in topology.links || newIds.has(c));
    newIds.add(id);
    const a = { ...link.a, device: remap.get(link.a.device) ?? link.a.device };
    const b = { ...link.b, device: remap.get(link.b.device) ?? link.b.device };
    return { ...link, id, a, b };
  });

  const annotations = fragment.annotations.map((annotation): Annotation => {
    const id = fresh(ids.annotationId, (c) => c in topology.annotations || newIds.has(c));
    newIds.add(id);
    return { ...annotation, id, position: move(annotation.position) };
  });

  return { devices, links, annotations };
}
