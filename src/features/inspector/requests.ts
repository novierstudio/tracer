import { createStore } from 'zustand/vanilla';
import type { DeviceId } from '@/model';
import { editorStore } from '@/model/store';

/** A request from outside the inspector to show a device's CLI or Desktop tab. */
type ConsoleRequest = { device: DeviceId } | null;

// Kept until the inspector takes it, since the inspector may be collapsed (unmounted) when asked.
export const consoleRequests = createStore<{ request: ConsoleRequest }>(() => ({ request: null }));

/** Selects the device and asks the shell to open the inspector on its CLI or Desktop tab. */
export function openDeviceConsole(device: DeviceId) {
  editorStore.getState().select({ devices: [device], links: [] });
  consoleRequests.setState({ request: { device } });
}

/** The inspector calls this once it has switched tabs. */
export function takeConsoleRequest(): ConsoleRequest {
  const { request } = consoleRequests.getState();
  if (request) consoleRequests.setState({ request: null });
  return request;
}
