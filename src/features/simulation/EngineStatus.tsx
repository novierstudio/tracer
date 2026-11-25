import { useEffect, useState } from 'react';
import { editorStore } from '@/model/store';

type EngineState = 'starting' | 'ready' | 'failed';

const LABEL: Record<EngineState, string> = {
  starting: 'Starting engine…',
  ready: 'Engine ready',
  failed: 'Engine failed to start',
};

export function EngineStatus() {
  const [state, setState] = useState<EngineState>('starting');

  useEffect(() => {
    let active = true;
    import('@/engine/client')
      .then(({ startEngine }) => startEngine(editorStore))
      .then(
        () => active && setState('ready'),
        (error: unknown) => {
          console.error('The simulation engine failed to start', error);
          if (active) setState('failed');
        },
      );
    return () => {
      active = false;
    };
  }, []);

  return (
    <span role="status" className="max-sm:hidden">
      {LABEL[state]}
    </span>
  );
}
