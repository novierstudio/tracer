import { useEffect, useState } from 'react';
import { editorStore } from '@/model/store';
import { connectSimulation } from './controller';
import { exposeSimClient } from './devHandle';
import { trackHostAddresses } from './hostAddresses';
import { trackLinkStates } from './linkState';
import { trackStickyMacs } from './stickyMacs';
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
    let stopSticky: (() => void) | undefined;
    let stopSyslog: (() => void) | undefined;
    let disconnect: (() => void) | undefined;
    import('@/engine/client')
      .then(({ startEngine }) => startEngine(editorStore))
      .then(
        (client) => {
          if (!active) return;
          stopTracking = trackLinkStates(client);
          stopAddresses = trackHostAddresses(client, editorStore);
          stopSticky = trackStickyMacs(client, editorStore);
          stopSyslog = trackSyslog(client, consoles);
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
      stopSticky?.();
      stopSyslog?.();
      disconnect?.();
    };
  }, []);

  return state;
}
