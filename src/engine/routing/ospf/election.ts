import type { Ipv4Address } from '@/model';
import { compareAddresses } from '../../l3/ipv4';
import { atLeast, NO_ROUTER, type Iface } from './state';

/** A router that may become DR or BDR, with what it declares in its hellos. */
type Candidate = {
  readonly routerId: Ipv4Address;
  readonly address: Ipv4Address;
  readonly priority: number;
  readonly dr: Ipv4Address;
  readonly bdr: Ipv4Address;
};

/** The highest priority wins, then the highest router ID. */
const best = (candidates: readonly Candidate[]) =>
  candidates.reduce<Candidate | undefined>(
    (winner, candidate) =>
      !winner ||
      candidate.priority > winner.priority ||
      (candidate.priority === winner.priority &&
        compareAddresses(candidate.routerId, winner.routerId) > 0)
        ? candidate
        : winner,
    undefined,
  );

const declaresDr = (candidate: Candidate) => candidate.dr === candidate.address;

/** The BDR: of those not claiming DR, one that claims BDR, else any of them. */
function backup(pool: readonly Candidate[]) {
  const eligible = pool.filter((candidate) => !declaresDr(candidate));
  const claiming = eligible.filter((candidate) => candidate.bdr === candidate.address);
  return best(claiming.length > 0 ? claiming : eligible);
}

/**
 * Steps 2 and 3 of the election. The DR is the best router that claims DR. When none does, the
 * BDR steps up, and the BDR is chosen again from the rest, which is where every router's next
 * election would land once it heard the new DR claim the role.
 */
function choose(pool: readonly Candidate[]) {
  let bdr = backup(pool);
  let dr = best(pool.filter(declaresDr));
  if (!dr) {
    dr = bdr;
    bdr = backup(pool.filter((candidate) => candidate !== dr));
  }
  return { dr: dr?.address ?? NO_ROUTER, bdr: bdr?.address ?? NO_ROUTER };
}

/**
 * RFC 2328's DR and BDR election on a multi-access interface, as this router sees it: among
 * itself and its neighbours in 2-Way or beyond, priority 0 never stands. A sitting DR or BDR
 * keeps its role against a better newcomer, because routers vote for who claims a role first.
 */
export function elect(routerId: Ipv4Address, iface: Iface): { dr: Ipv4Address; bdr: Ipv4Address } {
  const own = iface.ip.cidr.address;
  const neighbors = [...iface.neighbors.values()]
    .filter((neighbor) => atLeast(neighbor.state, '2way') && neighbor.priority > 0)
    .map(({ routerId, address, priority, dr, bdr }) => ({ routerId, address, priority, dr, bdr }));
  const pool = (dr: Ipv4Address, bdr: Ipv4Address): Candidate[] =>
    iface.priority > 0
      ? [{ routerId, address: own, priority: iface.priority, dr, bdr }, ...neighbors]
      : neighbors;
  const role = ({ dr, bdr }: { dr: Ipv4Address; bdr: Ipv4Address }) =>
    dr === own ? 'dr' : bdr === own ? 'bdr' : 'other';

  const first = choose(pool(iface.dr, iface.bdr));
  // Step 4, for a router that lost a role: it elects again no longer claiming it. One that gained
  // a role keeps the first result, which already chose the rest around it.
  const before = role(iface);
  const lost = before !== 'other' && role(first) !== before;
  return lost ? choose(pool(first.dr, first.bdr)) : first;
}
