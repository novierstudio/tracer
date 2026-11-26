import { SlidersHorizontalIcon } from 'lucide-react';
import { createStore, useStore } from 'zustand';
import { useRegisterCommands, type Command } from '@/features/command/registry';
import { OSPF_TIMERS, RIP_TIMERS } from '@/engine/routing/timers';
import { labSettings, type RoutingTimers, type StpTimers } from '@/model';
import { useEditor } from '@/model/react';
import { editorStore } from '@/model/store';
import { Dialog, DialogContent } from '@/ui/dialog';
import { DropdownMenuItem } from '@/ui/dropdown-menu';
import { Segmented } from '@/ui/segmented';

const dialog = createStore<{ open: boolean }>()(() => ({ open: false }));

const setOpen = (open: boolean) => dialog.setState({ open });

const TITLE = 'Lab settings…';

const STP_OPTIONS = [
  { value: 'fast', label: 'Fast (default)' },
  { value: 'ios', label: 'Real IOS (30 s)' },
] as const satisfies readonly { value: StpTimers; label: string }[];

const STP_EXPLANATION: Record<StpTimers, string> = {
  fast: 'New switch ports listen for 2 s and learn for 2 s, so a lab pings within seconds.',
  ios: 'Hello 2 s, forward delay 15 s, max age 20 s: a new port forwards after 30 s, as on a real switch.',
};

const ROUTING_OPTIONS = [
  { value: 'fast', label: 'Fast (default)' },
  { value: 'ios', label: 'Real IOS (30 s updates)' },
] as const satisfies readonly { value: RoutingTimers; label: string }[];

const { fast, ios } = RIP_TIMERS;
const ospf = OSPF_TIMERS;

const ROUTING_EXPLANATION: Record<RoutingTimers, string> = {
  fast: `RIP sends updates every ${fast.update} s and drops a silent route after ${fast.invalid} s, so a lab converges in seconds. OSPF says hello every ${ospf.fast.hello} s and declares a silent neighbour dead after ${ospf.fast.dead} s.`,
  ios: `RIP sends updates every ${ios.update} s; a silent route is invalid after ${ios.invalid} s, held down ${ios.holddown} s and flushed after ${ios.flush} s, as on a real router. OSPF hello ${ospf.ios.hello} s, dead ${ospf.ios.dead} s.`,
};

const COMMANDS: readonly Command[] = [
  {
    id: 'lab.settings',
    title: TITLE,
    group: 'File',
    keywords: [
      'preferences',
      'options',
      'spanning tree',
      'stp',
      'rip',
      'ospf',
      'routing',
      'timers',
      'convergence',
    ],
    icon: SlidersHorizontalIcon,
    run: () => setOpen(true),
  },
];

/** The app menu's entry for the dialog. */
export function LabSettingsMenuItem() {
  return (
    <DropdownMenuItem onSelect={() => setOpen(true)}>
      <SlidersHorizontalIcon />
      {TITLE}
    </DropdownMenuItem>
  );
}

/** Settings that belong to the lab and travel with its file, not to any one device. */
export function LabSettingsDialog() {
  const open = useStore(dialog, (state) => state.open);
  const { stpTimers, routingTimers } = useEditor((state) => labSettings(state.topology));
  useRegisterCommands(COMMANDS);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title="Lab settings" description="Saved with this lab.">
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Spanning tree timers</h3>
          <Segmented
            label="Spanning tree timers"
            value={stpTimers}
            onValueChange={(next) => editorStore.getState().updateLabSettings({ stpTimers: next })}
            options={STP_OPTIONS}
            className="self-start"
          />
          <p className="text-sm text-fg-2">{STP_EXPLANATION[stpTimers]}</p>
        </section>
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Routing protocol timers</h3>
          <Segmented
            label="Routing protocol timers"
            value={routingTimers}
            onValueChange={(next) =>
              editorStore.getState().updateLabSettings({ routingTimers: next })
            }
            options={ROUTING_OPTIONS}
            className="self-start"
          />
          <p className="text-sm text-fg-2">{ROUTING_EXPLANATION[routingTimers]}</p>
        </section>
      </DialogContent>
    </Dialog>
  );
}
