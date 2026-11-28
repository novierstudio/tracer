import { useEffect, useState } from 'react';
import { editorStore } from '@/model/store';
import { connectSimulation } from './controller';
import { exposeSimClient } from './devHandle';
import { trackHostAddresses } from './hostAddresses';
import { trackLinkStates } from './linkState';
import { trackServerFiles } from './serverFiles';
import { trackServerStatus } from './serverStatus';
import { trackStickyMacs } from './stickyMacs';
import { trackThingState } from './thingState';
import { trackWirelessStatus } from './wirelessStatus';
import { trackVlanDatabases } from './vlanDatabase';
import { consoles, trackSyslog } from '@/features/terminal/registry';

export type EngineState = 'starting' | 'ready' | 'failed';

/**
 * Starts the simulation worker, which then follows every edit to the editor's topology, feeds
 * its link states to the canvas link lights, and connects the timeline, event list and traffic
 * overlay. Mount it once: the status bar's EngineStatus does.
 */
export function useEngine(): EngineState {
  const [state, setState] = useState<EngineState>('starting');

  useEffect(() => {
    let active = true;
    let stopTracking: (() => void) | undefined;
    let stopAddresses: (() => void) | undefined;
    let stopServers: (() => void) | undefined;
    let stopSticky: (() => void) | undefined;
    let stopVlans: (() => void) | undefined;
    let stopFiles: (() => void) | undefined;
    let stopSyslog: (() => void) | undefined;
    let stopWireless: (() => void) | undefined;
    let stopThings: (() => void) | undefined;
    let disconnect: (() => void) | undefined;
    import('@/engine/client')
      .then(({ startEngine }) => startEngine(editorStore))
      .then(
        (client) => {
          if (!active) return;
          stopTracking = trackLinkStates(client);
          stopAddresses = trackHostAddresses(client, editorStore);
          stopServers = trackServerStatus(client, editorStore);
          stopSticky = trackStickyMacs(client, editorStore);
          stopVlans = trackVlanDatabases(client, editorStore);
          stopFiles = trackServerFiles(client, editorStore);
          stopSyslog = trackSyslog(client, consoles);
          stopWireless = trackWirelessStatus(client, editorStore);
          stopThings = trackThingState(client, editorStore);
          disconnect = connectSimulation(client);
          exposeSimClient(client);
          setState('ready');
        },
        (error: unknown) => {
          console.error('The simulation engine failed to start', error);
          if (active) setState('failed');
        },
      );
    return () => {
      active = false;
      stopTracking?.();
      stopAddresses?.();
      stopServers?.();
      stopSticky?.();
      stopVlans?.();
      stopFiles?.();
      stopSyslog?.();
      stopWireless?.();
      stopThings?.();
      disconnect?.();
    };
  }, []);

  return state;
}
