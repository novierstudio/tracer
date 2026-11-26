import type { SimModule } from './module';

/**
 * A hub: a multiport repeater. Every frame that arrives goes out of every other port whose link is
 * up, unchanged; the hub learns nothing and reads no address. Its ports share one half-duplex
 * segment, so in Simulation mode two frames that reach it at the same instant collide and both
 * are lost, as Packet Tracer shows. The engine judges that before the hub hears either frame.
 */
export const hubModule: SimModule<null> = {
  id: 'hub',
  sharedMedium: true,
  init: () => null,
  onFrame(ctx, port, frame) {
    for (const out of ctx.device.ports) {
      if (out.id !== port && ctx.portUp(out.id)) ctx.send(out.id, frame);
    }
  },
};
