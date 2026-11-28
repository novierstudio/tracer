import { useSyncExternalStore } from 'react';
import type { DeviceId } from '@/model';
import type { Mail } from './backend';

const EMPTY: readonly Mail[] = [];

/**
 * The mail each host's Email app has received, newest last. It lives in memory only: it is not
 * saved with the lab, and reloading the page empties every inbox, as the server already gave the
 * mail up when POP3 fetched it.
 */
const inboxes = new Map<DeviceId, readonly Mail[]>();
const listeners = new Set<() => void>();

/** Adds mails `device` just received to its inbox. */
export function deliver(device: DeviceId, mails: readonly Mail[]) {
  if (mails.length === 0) return;
  inboxes.set(device, [...(inboxes.get(device) ?? EMPTY), ...mails]);
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The host's inbox, kept current. */
export const useInbox = (device: DeviceId): readonly Mail[] =>
  useSyncExternalStore(subscribe, () => inboxes.get(device) ?? EMPTY);
