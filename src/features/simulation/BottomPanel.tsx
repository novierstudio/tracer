import { ChevronDownIcon, ListIcon, TerminalIcon } from 'lucide-react';
import { useState } from 'react';
import { DeviceTerminal } from '@/features/terminal/Terminal';
import type { DeviceId } from '@/model';
import { useEditor } from '@/model/react';
import type { EditorState } from '@/model/store';
import { Button } from '@/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';
import { Tooltip } from '@/ui/tooltip';

const emptyClass =
  'flex flex-col items-center justify-center gap-1 overflow-y-auto px-6 pb-4 text-center text-xs text-balance text-fg-2';

type Tab = 'events' | 'terminal';

// The shell unmounts this panel while it is collapsed; reopening it returns to the last tab.
let lastTab: Tab = 'events';

/** The one selected router or switch, whose console the Terminal tab shows. */
function consoleDevice({ topology, selection }: EditorState) {
  const [id, ...others] = selection.devices;
  if (!id || others.length > 0 || selection.links.length > 0) return undefined;
  const device = topology.devices[id];
  return device?.kind === 'router' || device?.kind === 'switch' ? device : undefined;
}

type BottomPanelProps = { onCollapse: () => void; collapseShortcut: string };

export function BottomPanel({ onCollapse, collapseShortcut }: BottomPanelProps) {
  const [tab, setTab] = useState(lastTab);
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
              {device.config.hostname} console
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
        <TabsContent value="events" className={emptyClass}>
          <p className="font-medium text-fg-1">No events yet</p>
          <p>In Simulation mode, every frame a packet sends shows up here, hop by hop.</p>
        </TabsContent>
        {device ? (
          <TabsContent value="terminal" className="pr-1 pb-2 pl-3">
            <DeviceTerminal device={device.id} autoFocus={focusFor === device.id} />
          </TabsContent>
        ) : (
          <TabsContent value="terminal" className={emptyClass}>
            <p className="font-medium text-fg-1">Select a router or switch</p>
            <p>Its IOS console opens here, and in the CLI tab of the inspector.</p>
          </TabsContent>
        )}
      </Tabs>
    </section>
  );
}
