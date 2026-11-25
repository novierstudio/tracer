import { WaypointsIcon } from 'lucide-react';
import { Button } from '@/ui/button';
import { Tooltip } from '@/ui/tooltip';
import { simulation } from './controller';
import { useSimulation } from './store';

/** The top bar's "Show traffic" switch for the packets drawn on the canvas. */
export function ShowTrafficToggle() {
  const on = useSimulation((state) => state.showTraffic);
  return (
    <Tooltip label={on ? 'Hide traffic' : 'Show traffic'}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Show traffic"
        aria-pressed={on}
        onClick={() => simulation.setShowTraffic(!on)}
      >
        <WaypointsIcon />
      </Button>
    </Tooltip>
  );
}
