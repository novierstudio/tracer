import type { AnnotationId, Device, DeviceId, Ipv4Cidr, LinkId, PortId } from '@/model';
import { editorStore } from '@/model/store';

/** One undo step, even when devices, links and annotations all go. */
export function deleteItems(
  devices: readonly DeviceId[],
  links: readonly LinkId[],
  annotations: readonly AnnotationId[] = [],
) {
  const editor = editorStore.getState();
  editor.beginGesture();
  if (links.length > 0) editor.removeLinks(links);
  if (devices.length > 0) editor.removeDevices(devices);
  if (annotations.length > 0) editor.removeAnnotations(annotations);
  editor.endGesture();
}

export function selectDevice(device: DeviceId) {
  editorStore.getState().select({ devices: [device], links: [] });
}

function editInterface<I>(interfaces: Record<PortId, I>, port: PortId, edit: (current: I) => I) {
  const current = interfaces[port];
  return current === undefined ? interfaces : { ...interfaces, [port]: edit(current) };
}

/** `shutdown` / `no shutdown` on a router or switch port. */
export function setShutdown(device: Device, port: PortId, shutdown: boolean) {
  const { updateConfig } = editorStore.getState();
  if (device.kind === 'router') {
    const interfaces = editInterface(device.config.interfaces, port, (i) => ({ ...i, shutdown }));
    updateConfig({ device: device.id, kind: 'router', config: { ...device.config, interfaces } });
  } else if (device.kind === 'switch') {
    const interfaces = editInterface(device.config.interfaces, port, (i) => ({ ...i, shutdown }));
    updateConfig({ device: device.id, kind: 'switch', config: { ...device.config, interfaces } });
  }
}

/** `ip address` / `no ip address` on a router port. */
export function setRouterAddress(device: Device, port: PortId, ipv4: Ipv4Cidr | undefined) {
  if (device.kind !== 'router') return;
  const interfaces = editInterface(device.config.interfaces, port, (current) => {
    const next = { ...current, ipv4 };
    if (!ipv4) delete next.ipv4;
    return next;
  });
  editorStore
    .getState()
    .updateConfig({ device: device.id, kind: 'router', config: { ...device.config, interfaces } });
}
