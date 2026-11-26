import type { Ipv4Address, MacAddress } from '@/model';
import type { SimTime } from '../../core/time';
import { compareAddresses } from '../../l3/ipv4';
import type { LsaHeader, OspfDatabaseDescription, OspfHello } from '../../pdu';
import { seconds, STATE_NAMES, timersOf, type OspfContext } from './context';
import { databaseOf, originate, summary } from './database';
import { elect } from './election';
import { send, sendDbd, sendRequest } from './send';
import {
  aged,
  atLeast,
  compareInstances,
  lsaKey,
  NO_ROUTER,
  timerKey,
  type Iface,
  type Neighbor,
  type Process,
} from './state';
import type { OspfNeighborState } from './status';

export function setState(
  ctx: OspfContext,
  process: Process,
  iface: Iface,
  neighbor: Neighbor,
  state: OspfNeighborState,
  reason: string,
) {
  const before = neighbor.state;
  neighbor.state = state;
  if (state === 'full' || before === 'full') {
    ctx.note(
      `%OSPF-5-ADJCHG: Process ${process.id}, Nbr ${neighbor.routerId} on ${iface.name} from ${STATE_NAMES[before]} to ${STATE_NAMES[state]}, ${reason}`,
    );
  }
}

/** Forgets what an adjacency was exchanging, as it falls back to 2-Way or starts over. */
export function resetAdjacency(ctx: OspfContext, iface: Iface, neighbor: Neighbor) {
  neighbor.requests.clear();
  neighbor.unacked.clear();
  neighbor.lastDbd = undefined;
  neighbor.summarySent = false;
  ctx.clearTimer(timerKey({ kind: 'rxmt', iface: iface.name, neighbor: neighbor.routerId }));
}

/** ExStart: claim to lead with an empty DBD, and see who the neighbour says leads. */
function startExchange(ctx: OspfContext, process: Process, iface: Iface, neighbor: Neighbor) {
  resetAdjacency(ctx, iface, neighbor);
  setState(ctx, process, iface, neighbor, 'exstart', 'Negotiation');
  neighbor.master = true;
  neighbor.ddSequence = 1 + Math.floor(ctx.random() * 0x7ffffffe);
  sendDbd(ctx, process, iface, neighbor, { init: true, more: true, master: true }, []);
}

export function dropNeighbor(
  ctx: OspfContext,
  process: Process,
  iface: Iface,
  neighbor: Neighbor,
  reason: string,
) {
  setState(ctx, process, iface, neighbor, 'down', `Neighbor Down: ${reason}`);
  iface.neighbors.delete(neighbor.routerId);
  ctx.clearTimer(timerKey({ kind: 'dead', iface: iface.name, neighbor: neighbor.routerId }));
  ctx.clearTimer(timerKey({ kind: 'rxmt', iface: iface.name, neighbor: neighbor.routerId }));
}

/** On a multi-access network only the DR and BDR form adjacencies with everyone. */
const wantsAdjacency = (iface: Iface, neighbor: Neighbor) =>
  iface.type === 'point-to-point' ||
  (iface.state !== 'waiting' &&
    (iface.state === 'dr' ||
      iface.state === 'backup' ||
      neighbor.address === iface.dr ||
      neighbor.address === iface.bdr));

/** Elects the DR and BDR again, then starts or tears down adjacencies to match. */
export function electDr(ctx: OspfContext, process: Process, iface: Iface) {
  if (iface.type !== 'broadcast' || iface.state === 'waiting') return;
  const { dr, bdr } = elect(process.routerId, iface);
  const own = iface.ip.cidr.address;
  iface.dr = dr;
  iface.bdr = bdr;
  iface.state = dr === own ? 'dr' : bdr === own ? 'backup' : 'drother';
  for (const neighbor of iface.neighbors.values()) {
    if (!atLeast(neighbor.state, '2way')) continue;
    const wanted = wantsAdjacency(iface, neighbor);
    if (wanted && neighbor.state === '2way') startExchange(ctx, process, iface, neighbor);
    if (!wanted && atLeast(neighbor.state, 'exstart')) {
      resetAdjacency(ctx, iface, neighbor);
      setState(ctx, process, iface, neighbor, '2way', 'Adjacency no longer needed');
    }
  }
}

/**
 * The network already has a BDR, or a DR without one, so there is no need to wait out the Wait
 * timer: once every neighbour heard is 2-Way, the election sees all of them and keeps the
 * sitting DR and BDR, rather than a newcomer electing itself from what little it has heard.
 */
function backupSeen(iface: Iface): boolean {
  const neighbors = [...iface.neighbors.values()];
  return (
    neighbors.every((neighbor) => atLeast(neighbor.state, '2way')) &&
    neighbors.some(
      ({ address, dr, bdr }) => bdr === address || (dr === address && bdr === NO_ROUTER),
    )
  );
}

/** The wait is over, or the network already has its DR and BDR: elect. */
export function endWait(ctx: OspfContext, process: Process, iface: Iface) {
  ctx.clearTimer(timerKey({ kind: 'wait', iface: iface.name }));
  iface.state = 'drother';
  electDr(ctx, process, iface);
}

export function onHello(
  ctx: OspfContext,
  process: Process,
  iface: Iface,
  hello: OspfHello,
  src: Ipv4Address,
  mac: MacAddress | undefined,
) {
  const { hello: interval, dead } = timersOf(ctx);
  if (hello.helloInterval !== interval || hello.deadInterval !== dead) {
    ctx.note(`OSPF: hello from ${hello.routerId} on ${iface.name} has other hello or dead timers`);
    return;
  }
  if (iface.type === 'broadcast' && hello.networkMask !== iface.ip.cidr.prefixLength) {
    ctx.note(`OSPF: hello from ${hello.routerId} on ${iface.name} has another network mask`);
    return;
  }
  let neighbor = iface.neighbors.get(hello.routerId);
  let changed = false;
  if (!neighbor) {
    neighbor = {
      routerId: hello.routerId,
      address: src,
      mac,
      priority: hello.priority,
      dr: hello.dr,
      bdr: hello.bdr,
      state: 'init',
      deadAt: ctx.now,
      master: false,
      ddSequence: 0,
      lastDbd: undefined,
      summarySent: false,
      requests: new Map(),
      unacked: new Map(),
    };
    iface.neighbors.set(hello.routerId, neighbor);
  } else {
    // A new priority, or a neighbour that starts or stops claiming DR or BDR, reruns the election.
    changed =
      neighbor.priority !== hello.priority ||
      (neighbor.dr === neighbor.address) !== (hello.dr === src) ||
      (neighbor.bdr === neighbor.address) !== (hello.bdr === src);
    neighbor.address = src;
    neighbor.mac = mac ?? neighbor.mac;
    neighbor.priority = hello.priority;
    neighbor.dr = hello.dr;
    neighbor.bdr = hello.bdr;
  }
  neighbor.deadAt = (ctx.now + seconds(dead)) as SimTime;
  ctx.setTimer(
    timerKey({ kind: 'dead', iface: iface.name, neighbor: hello.routerId }),
    seconds(dead),
  );

  const seesUs = hello.neighbors.includes(process.routerId);
  if (seesUs && neighbor.state === 'init') {
    setState(ctx, process, iface, neighbor, '2way', '2-Way Received');
    changed = true;
    if (iface.type === 'point-to-point') startExchange(ctx, process, iface, neighbor);
  } else if (!seesUs && atLeast(neighbor.state, '2way')) {
    resetAdjacency(ctx, iface, neighbor);
    setState(ctx, process, iface, neighbor, 'init', '1-Way Received');
    changed = true;
  }

  if (iface.state === 'waiting' && backupSeen(iface)) endWait(ctx, process, iface);
  else if (changed) electDr(ctx, process, iface);
  originate(ctx, process);
}

/** Notes which LSAs the neighbour has that this router lacks or holds an older instance of. */
function listWanted(
  ctx: OspfContext,
  process: Process,
  iface: Iface,
  neighbor: Neighbor,
  headers: readonly LsaHeader[],
) {
  const database = databaseOf(process, iface.area);
  for (const header of headers) {
    const stored = database.get(lsaKey(header));
    if (!stored || compareInstances(header, aged(stored, ctx.now)) > 0) {
      neighbor.requests.set(lsaKey(header), header);
    }
  }
}

/** Both sides have listed their databases: request what is missing, or the adjacency is FULL. */
function exchangeDone(ctx: OspfContext, process: Process, iface: Iface, neighbor: Neighbor) {
  if (neighbor.requests.size === 0) {
    setState(ctx, process, iface, neighbor, 'full', 'Exchange Done');
    if (neighbor.unacked.size === 0) {
      ctx.clearTimer(timerKey({ kind: 'rxmt', iface: iface.name, neighbor: neighbor.routerId }));
    }
    originate(ctx, process);
    return;
  }
  setState(ctx, process, iface, neighbor, 'loading', 'Exchange Done');
  sendRequest(ctx, process, iface, neighbor);
}

export function mismatch(ctx: OspfContext, process: Process, iface: Iface, neighbor: Neighbor) {
  ctx.note(
    `OSPF: ${neighbor.routerId} on ${iface.name} is out of step, starting the exchange again`,
  );
  startExchange(ctx, process, iface, neighbor);
  originate(ctx, process);
}

/** The slave answers each DBD with its own: its database the first time, then empty ones. */
function answerAsSlave(
  ctx: OspfContext,
  process: Process,
  iface: Iface,
  neighbor: Neighbor,
  dbd: OspfDatabaseDescription,
) {
  const headers = neighbor.summarySent ? [] : summary(ctx, process, iface.area);
  neighbor.summarySent = true;
  sendDbd(ctx, process, iface, neighbor, { init: false, more: false, master: false }, headers);
  if (!dbd.more) exchangeDone(ctx, process, iface, neighbor);
}

/**
 * The database exchange. In ExStart the router with the higher router ID leads: it sends the
 * sequence numbers, and the other answers each with the same number. Every DBD lists headers;
 * Tracer's fit in one, so each side sends More only on its first, empty DBD.
 */
export function onDbd(
  ctx: OspfContext,
  process: Process,
  iface: Iface,
  neighbor: Neighbor,
  dbd: OspfDatabaseDescription,
) {
  const resend = () => neighbor.lastDbd && send(ctx, process, iface, neighbor.lastDbd, neighbor);
  switch (neighbor.state) {
    case 'down':
    case 'init':
    case '2way':
      return;
    case 'exstart': {
      const higher = compareAddresses(dbd.routerId, process.routerId) > 0;
      if (dbd.init && dbd.more && dbd.master && dbd.headers.length === 0 && higher) {
        neighbor.master = false;
        neighbor.ddSequence = dbd.sequence;
        setState(ctx, process, iface, neighbor, 'exchange', 'Negotiation Done');
        answerAsSlave(ctx, process, iface, neighbor, dbd);
      } else if (!dbd.init && !dbd.master && dbd.sequence === neighbor.ddSequence && !higher) {
        setState(ctx, process, iface, neighbor, 'exchange', 'Negotiation Done');
        listWanted(ctx, process, iface, neighbor, dbd.headers);
        neighbor.ddSequence += 1;
        neighbor.summarySent = true;
        const headers = summary(ctx, process, iface.area);
        sendDbd(ctx, process, iface, neighbor, { init: false, more: false, master: true }, headers);
      }
      return;
    }
    case 'exchange':
      if (neighbor.master) {
        if (dbd.sequence === neighbor.ddSequence - 1 && !dbd.master) return;
        if (dbd.master || dbd.init || dbd.sequence !== neighbor.ddSequence) {
          mismatch(ctx, process, iface, neighbor);
          return;
        }
        listWanted(ctx, process, iface, neighbor, dbd.headers);
        if (!neighbor.lastDbd?.more && !dbd.more) {
          exchangeDone(ctx, process, iface, neighbor);
          return;
        }
        neighbor.ddSequence += 1;
        sendDbd(ctx, process, iface, neighbor, { init: false, more: false, master: true }, []);
        return;
      }
      if (dbd.sequence === neighbor.ddSequence) {
        resend();
        return;
      }
      if (!dbd.master || dbd.init || dbd.sequence !== neighbor.ddSequence + 1) {
        mismatch(ctx, process, iface, neighbor);
        return;
      }
      neighbor.ddSequence = dbd.sequence;
      listWanted(ctx, process, iface, neighbor, dbd.headers);
      answerAsSlave(ctx, process, iface, neighbor, dbd);
      return;
    case 'loading':
    case 'full':
      if (dbd.init) mismatch(ctx, process, iface, neighbor);
      else if (!neighbor.master && dbd.master && dbd.sequence === neighbor.ddSequence) resend();
      return;
  }
}
