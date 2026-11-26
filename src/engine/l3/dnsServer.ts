import { serverServices } from '@/model/defaults';
import { DNS_TTL, type DnsMessage, type DnsResponse } from '../dns';
import { UDP_PORT, type Ipv4Packet, type UdpDatagram } from '../pdu';
import type { IpContext } from './context';
import { originate } from './output';
import { udp } from './udp';

/**
 * A DNS message arrived on port 53. A server whose DNS service is on answers a query from its
 * A records: every record for the name, or NXDOMAIN when it has none. Anything else drops it.
 */
export function onDnsQuery(
  ctx: IpContext,
  packet: Ipv4Packet,
  datagram: UdpDatagram,
  message: DnsMessage,
) {
  if (message.type !== 'query' || ctx.device.kind !== 'server') return;
  const { dns } = serverServices(ctx.device.config);
  if (!dns.enabled) return;
  const answers = dns.records
    .filter((record) => record.name === message.name)
    .map((record) => ({ name: record.name, address: record.address, ttl: DNS_TTL }));
  const response: DnsResponse = {
    kind: 'dns',
    type: 'response',
    id: message.id,
    name: message.name,
    rcode: answers.length > 0 ? 'no-error' : 'name-error',
    answers,
  };
  originate(ctx, packet.src, udp(UDP_PORT.dns, datagram.srcPort, response), { src: packet.dst });
}
