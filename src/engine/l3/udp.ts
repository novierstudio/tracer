import type { Ipv4Packet, UdpDatagram, UdpPayload } from '../pdu';
import { UDP_PORT } from '../pdu';
import { deliverAppUdp } from './appRouter';
import type { IpContext } from './context';
import { onDhcpServerPort } from './dhcpServer';
import { onDnsResponse } from './dnsResolver';
import { onDnsQuery } from './dnsServer';
import type { IpInterface } from './interfaces';

export const udp = (srcPort: number, dstPort: number, payload: UdpPayload): UdpDatagram => ({
  kind: 'udp',
  srcPort,
  dstPort,
  payload,
});

/**
 * A datagram for this device, by the port it is for. `arrival` is the interface it came in on,
 * absent for one the device sent itself. A DHCP host takes its replies on port 68 before IP sees
 * them, since it may have no address yet. RIP's port 520 drops here: RIP runs in a module of its
 * own, which reads its datagrams from the frames it sees.
 */
export function deliverUdp(
  ctx: IpContext,
  packet: Ipv4Packet,
  datagram: UdpDatagram,
  arrival: IpInterface | undefined,
) {
  switch (datagram.dstPort) {
    case UDP_PORT.dhcpServer:
      if (datagram.payload.kind === 'dhcp')
        onDhcpServerPort(ctx, packet, datagram.payload, arrival);
      return;
    case UDP_PORT.dns:
      if (datagram.payload.kind === 'dns') onDnsQuery(ctx, packet, datagram, datagram.payload);
      return;
    default:
      if (deliverAppUdp(ctx, packet, datagram)) return;
      // A DNS response comes back to the port its query went from.
      if (datagram.payload.kind === 'dns') onDnsResponse(ctx, datagram.dstPort, datagram.payload);
      return;
  }
}
