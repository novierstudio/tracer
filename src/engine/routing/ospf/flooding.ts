import {
  MAX_AGE,
  type Lsa,
  type LsaHeader,
  type OspfLinkStateAck,
  type OspfLinkStateRequest,
  type OspfLinkStateUpdate,
} from '../../pdu';
import { mismatch, setState } from './adjacency';
import type { OspfContext } from './context';
import { databaseOf, flood, originate, scopeOf } from './database';
import { armRetransmit, floodAudience, send, sendRequest } from './send';
import {
  aged,
  atLeast,
  compareInstances,
  headerOf,
  lsaKey,
  type Iface,
  type Neighbor,
  type Process,
} from './state';

export function onRequest(
  ctx: OspfContext,
  process: Process,
  iface: Iface,
  neighbor: Neighbor,
  request: OspfLinkStateRequest,
) {
  if (!atLeast(neighbor.state, 'exchange')) return;
  const database = databaseOf(process, iface.area);
  const lsas: Lsa[] = [];
  for (const key of request.requests) {
    const stored = database.get(lsaKey(key));
    if (!stored) {
      mismatch(ctx, process, iface, neighbor);
      return;
    }
    lsas.push(aged(stored, ctx.now));
  }
  send(ctx, process, iface, { type: 'lsu', lsas }, neighbor);
}

/**
 * RFC 2328's flooding procedure for each LSA in an update. A newer instance is installed, flooded
 * on and acknowledged. The same instance acknowledges one this router sent, or is acknowledged.
 * An older one gets this router's newer instance back. One of this router's own that comes back
 * newer, as after a reboot, is installed and then superseded or flushed by `originate`.
 */
export function onUpdate(
  ctx: OspfContext,
  process: Process,
  iface: Iface,
  neighbor: Neighbor,
  update: OspfLinkStateUpdate,
) {
  if (!atLeast(neighbor.state, 'exchange')) return;
  const database = databaseOf(process, iface.area);
  const acks: LsaHeader[] = [];
  let changed = false;
  for (const lsa of update.lsas) {
    const key = lsaKey(lsa);
    const stored = database.get(key);
    const current = stored && aged(stored, ctx.now);
    const order = current ? compareInstances(lsa, current) : 1;
    if (order > 0) {
      if (lsa.age >= MAX_AGE && !current) {
        acks.push(headerOf(lsa));
        continue;
      }
      changed = true;
      for (const other of process.interfaces.values()) {
        for (const peer of other.neighbors.values()) peer.unacked.delete(key);
      }
      const own = lsa.advertisingRouter === process.routerId;
      let back = false;
      // An external LSA floods on into every other area that takes them.
      for (const area of scopeOf(ctx, process, iface.area, lsa)) {
        databaseOf(process, area).set(key, { lsa, receivedAt: ctx.now });
        const sent = !own && flood(ctx, process, area, lsa, { iface, neighbor });
        back ||= sent && area === iface.area;
      }
      if (!back) acks.push(headerOf(lsa));
    } else if (order === 0) {
      if (!neighbor.unacked.delete(key)) acks.push(headerOf(lsa));
    } else if (current) {
      send(ctx, process, iface, { type: 'lsu', lsas: [current] }, neighbor);
    }
    const wanted = neighbor.requests.get(key);
    if (wanted && order >= 0 && compareInstances(lsa, wanted) >= 0) neighbor.requests.delete(key);
  }
  if (acks.length > 0)
    send(ctx, process, iface, { type: 'lsack', headers: acks }, floodAudience(iface));
  if (neighbor.state === 'loading' && neighbor.requests.size === 0) {
    setState(ctx, process, iface, neighbor, 'full', 'Loading Done');
    changed = true;
  }
  if (changed) originate(ctx, process);
}

export function onAck(neighbor: Neighbor, ack: OspfLinkStateAck) {
  for (const header of ack.headers) {
    const sent = neighbor.unacked.get(lsaKey(header));
    if (sent && compareInstances(header, sent) === 0) neighbor.unacked.delete(lsaKey(header));
  }
}

/** Sends again what the neighbour has not answered: the DBD while leading, requests, LSAs. */
export function retransmit(ctx: OspfContext, process: Process, iface: Iface, neighbor: Neighbor) {
  let pending = false;
  const leading =
    neighbor.state === 'exstart' || (neighbor.state === 'exchange' && neighbor.master);
  if (leading && neighbor.lastDbd) {
    send(ctx, process, iface, neighbor.lastDbd, neighbor);
    pending = true;
  }
  if (neighbor.state === 'loading' && neighbor.requests.size > 0) {
    sendRequest(ctx, process, iface, neighbor);
    pending = true;
  }
  if (atLeast(neighbor.state, 'exchange') && neighbor.unacked.size > 0) {
    send(ctx, process, iface, { type: 'lsu', lsas: [...neighbor.unacked.values()] }, neighbor);
    pending = true;
  }
  if (pending) armRetransmit(ctx, iface, neighbor);
}
