import { useEngine, type EngineState } from './useEngine';

const LABEL: Record<EngineState, string> = {
  starting: 'Starting engine…',
  ready: 'Engine ready',
  failed: 'Engine failed to start',
};

export function EngineStatus() {
  const state = useEngine();
  return (
    <span role="status" className="max-sm:hidden">
      {LABEL[state]}
    </span>
  );
}
