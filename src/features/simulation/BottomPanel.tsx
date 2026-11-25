import { ChevronDownIcon, ListIcon, TerminalIcon } from 'lucide-react';
import { Button } from '@/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';
import { Tooltip } from '@/ui/tooltip';

const emptyClass =
  'flex flex-col items-center justify-center gap-1 overflow-y-auto px-6 pb-4 text-center text-xs text-balance text-fg-2';

type BottomPanelProps = { onCollapse: () => void; collapseShortcut: string };

export function BottomPanel({ onCollapse, collapseShortcut }: BottomPanelProps) {
  return (
    <section aria-label="Bottom panel" className="flex h-full flex-col bg-surface-1">
      <Tabs defaultValue="events" className="flex min-h-0 flex-1 flex-col">
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
          <Tooltip label="Hide bottom panel" shortcut={collapseShortcut}>
            <Button
              variant="ghost"
              size="icon-sm"
              className="ml-auto"
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
        <TabsContent value="terminal" className={emptyClass}>
          <p className="font-medium text-fg-1">No terminal open</p>
          <p>Open a router or switch CLI and pop it out here for a wider terminal.</p>
        </TabsContent>
      </Tabs>
    </section>
  );
}
