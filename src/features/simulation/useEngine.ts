import { useEffect, useState } from 'react';
import { editorStore } from '@/model/store';
import { exposeSimClient } from './devHandle';
import { trackLinkStates } from './linkState';

export type EngineState = 'starting' | 'ready' | 'failed';

/**
 * Starts the simulation worker, which then follows every edit to the editor's topology, and feeds
 * its link states to the canvas link lights. Mount it once: the status bar's EngineStatus does.
 */
export function useEngine(): EngineState {
  const [state, setState] = useState<EngineState>('starting');

  useEffect(() => {
    let active = true;
    let stopTracking: (() => void) | undefined;
    import('@/engine/client')
      .then(({ startEngine }) => startEngine(editorStore))
      .then(
        (client) => {
          if (!active) return;
          stopTracking = trackLinkStates(client);
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
    };
  }, []);

  return state;
}
