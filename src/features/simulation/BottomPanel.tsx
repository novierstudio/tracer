import { ChevronDownIcon, ListIcon, MailIcon, PlayIcon, TerminalIcon } from 'lucide-react';
import { useState } from 'react';
import { formatShortcut } from '@/app/shell/shortcuts';
import { HostPrompt } from '@/features/desktop/HostPrompt';
import { DeviceTerminal } from '@/features/terminal/Terminal';
import type { DeviceId } from '@/model';
import { useEditor } from '@/model/react';
import type { EditorState } from '@/model/store';
import { Button } from '@/ui/button';
import { cn } from '@/ui/cn';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';
import { Tooltip } from '@/ui/tooltip';
import { simulation } from './controller';
import { EventList } from './EventList';
import { PduInspector } from './PduInspector';
import { selectedFrame, useSimulation } from './store';
import { Timeline } from './Timeline';

const emptyClass =
  'flex flex-col items-center justify-center gap-1 overflow-y-auto px-6 pb-4 text-center text-xs text-balance text-fg-2';

type Tab = 'events' | 'terminal';

// The shell unmounts this panel while it is collapsed; reopening it returns to the last tab.
let lastTab: Tab = 'events';

/** The one selected device, whose console or Command Prompt the Terminal tab shows. */
function consoleDevice({ topology, selection }: EditorState) {
  const [id, ...others] = selection.devices;
  if (!id || others.length > 0 || selection.links.length > 0) return undefined;
  return topology.devices[id];
}

type BottomPanelProps = { onCollapse: () => void; collapseShortcut: string };

function SimulationEvents() {
  const empty = useSimulation((state) => state.frames.length === 0);
  const selected = useSimulation(selectedFrame);
  return (
    <>
      <Timeline />
      {empty ? (
        <div className={cn(emptyClass, 'flex-1')}>
          <p className="font-medium text-fg-1">No packets yet</p>
          <p>
            Add a simple PDU, or ping from a device, then step forward with → or press Play. Each
            hop shows up here and moves on the canvas.
          </p>
          <Button size="sm" className="mt-2" onClick={simulation.startPdu}>
            <MailIcon />
            Add simple PDU
          </Button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div
            className={cn(
              'flex min-h-0 flex-col',
              selected
                ? 'w-[32%] max-w-[30rem] min-w-[18rem] shrink-0 border-r border-line'
                : 'flex-1',
            )}
          >
            <EventList />
          </div>
          {selected && <PduInspector key={selected.id} event={selected} />}
        </div>
      )}
    </>
  );
}

function RealtimeEvents() {
  return (
    <div className={cn(emptyClass, 'flex-1')}>
      <p className="font-medium text-fg-1">Events are captured in Simulation mode</p>
      <p>
        Simulation pauses the network so you can step through every frame, hop by hop, and step
        back. Switch with {formatShortcut('toggleMode')}.
      </p>
      <Button size="sm" className="mt-2" onClick={() => simulation.setMode('simulation')}>
        <PlayIcon />
        Switch to Simulation
      </Button>
    </div>
  );
}

export function BottomPanel({ onCollapse, collapseShortcut }: BottomPanelProps) {
  const [tab, setTab] = useState(lastTab);
  const mode = useSimulation((state) => state.mode);
  const device = useEditor(consoleDevice);
  // Focus follows the terminal only when someone picks its tab, not when the panel reopens or
  // the selection changes.
  const [focusFor, setFocusFor] = useState<DeviceId>();

  const selectTab = (next: string) => {
    lastTab = next === 'terminal' ? 'terminal' : 'events';
    setTab(lastTab);
    setFocusFor(lastTab === 'terminal' ? device?.id : undefined);
  };

  return (
    <section aria-label="Bottom panel" className="flex h-full flex-col bg-surface-1">
      <Tabs
        value={tab}
        onValueChange={selectTab}
        activationMode="manual"
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex h-10 shrink-0 items-center gap-2 px-2">
          <TabsList>
            <TabsTrigger value="events">
              <ListIcon />
              Events
            </TabsTrigger>
            <TabsTrigger value="terminal">
              <TerminalIcon />
              Terminal
            </TabsTrigger>
          </TabsList>
          {tab === 'terminal' && device && (
            <p className="ml-1 min-w-0 truncate text-xs text-fg-3">
              {device.config.hostname}{' '}
              {device.kind === 'pc' || device.kind === 'server' ? 'Command Prompt' : 'console'}
            </p>
          )}
          <Tooltip label="Hide bottom panel" shortcut={collapseShortcut}>
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto shrink-0"
              aria-label="Hide bottom panel"
              onClick={onCollapse}
            >
              <ChevronDownIcon />
            </Button>
          </Tooltip>
        </div>
        <TabsContent value="events" className="flex flex-col">
          {mode === 'simulation' ? <SimulationEvents /> : <RealtimeEvents />}
        </TabsContent>
        {device ? (
          <TabsContent value="terminal" className="pr-1 pb-2 pl-3">
            {device.kind === 'pc' || device.kind === 'server' ? (
              <HostPrompt device={device.id} autoFocus={focusFor === device.id} />
            ) : (
              <DeviceTerminal device={device.id} autoFocus={focusFor === device.id} />
            )}
          </TabsContent>
        ) : (
          <TabsContent value="terminal" className={emptyClass}>
            <p className="font-medium text-fg-1">Select a device</p>
            <p>A router or switch console, or a PC&apos;s Command Prompt, opens here.</p>
          </TabsContent>
        )}
      </Tabs>
    </section>
  );
}
