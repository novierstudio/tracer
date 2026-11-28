import type { MacAddress, PortId } from '@/model';
import { bridgedPorts } from '@/model/wireless';
import type { ModuleContext, SimModule } from '../module';
import { BROADCAST_MAC } from '../pdu';

/** Where the bridge last heard each address, by MAC. */
export type BridgeState = { readonly macs: Map<MacAddress, PortId> };

const isGroup = (mac: MacAddress) => (parseInt(mac.slice(0, 2), 16) & 1) === 1;

/** The MACs the device answers to itself, as a home router's LAN does: never bridged. */
const ownMacs = (ctx: ModuleContext<BridgeState>) =>
  ctx.device.ports.flatMap((port) => (port.kind === 'serial' ? [] : [port.mac]));

/**
 * A learning bridge with no spanning tree, as in an access point and a home router's built-in
 * switch: it learns each sender's port and forwards a frame out of the port its destination was
 * heard on, flooding when it does not know, or for a broadcast. A radio is one port shared by every
 * client, so a frame from one client may go back out of the radio to another; the engine never
 * echoes it to the client that sent it. A frame for the device's own MAC is left to its IP stack.
 */
export const bridgeModule: SimModule<BridgeState> = {
  id: 'bridge',
  init: () => ({ macs: new Map() }),
  onFrame(ctx, port, frame) {
    if (frame.kind !== 'ethernet') return;
    const ports = bridgedPorts(ctx.device);
    if (!ports.includes(port)) return;
    if (!isGroup(frame.src)) ctx.state.macs.set(frame.src, port);
    if (ownMacs(ctx).includes(frame.dst)) return;
    const radio = (candidate: PortId) =>
      ctx.device.ports.some((p) => p.id === candidate && p.kind === 'wireless');
    const passes = (out: PortId) => (out !== port || radio(out)) && ctx.portUp(out);
    const known = frame.dst === BROADCAST_MAC ? undefined : ctx.state.macs.get(frame.dst);
    if (known !== undefined) {
      if (passes(known)) ctx.send(known, frame);
      return;
    }
    for (const out of ports) if (passes(out)) ctx.send(out, frame);
  },
  onLinkChange(ctx, port, up) {
    if (up) return;
    for (const [mac, at] of ctx.state.macs) if (at === port) ctx.state.macs.delete(mac);
  },
};
