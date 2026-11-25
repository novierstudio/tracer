import type { HostBackend } from './backend';

const notYet = (what: string) => () =>
  Promise.reject(new Error(`${what}: the simulation engine cannot do this yet.`));

/**
 * The Command Prompt's backend in the app: the simulation worker's ping, ARP table and ARP clear
 * through `startEngine`'s client, once `SimAPI` has them (NOV-206). Until then each call says so.
 */
export const engineBackend: HostBackend = {
  ping: notYet('PING'),
  arpTable: notYet('ARP'),
  clearArp: notYet('ARP'),
};
