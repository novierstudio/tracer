import { MousePointer2Icon } from 'lucide-react';
import { useState } from 'react';
import { useEditor } from '@/model/react';
import { EmptyState } from '@/ui/empty-state';
import { DeviceInspector, type DeviceTab } from './DeviceInspector';
import './devHandle';
import { LinkInspector } from './LinkInspector';
import { SelectionInspector } from './SelectionInspector';
import { inspectorView } from './view';

export function InspectorPanel() {
  const topology = useEditor((state) => state.topology);
  const selection = useEditor((state) => state.selection);
  // Kept across selections, so stepping through devices stays on the same tab.
  const [tab, setTab] = useState<DeviceTab>('overview');
  const view = inspectorView(topology, selection);

  return (
    <aside aria-label="Inspector" className="flex h-full flex-col bg-surface-1">
      <div className="flex h-10 shrink-0 items-center px-3">
        <h2 className="text-xs font-semibold text-fg-1">Inspector</h2>
      </div>
      {view.kind === 'device' && (
        <DeviceInspector device={view.device} topology={topology} tab={tab} onTabChange={setTab} />
      )}
      {view.kind === 'link' && <LinkInspector link={view.link} topology={topology} />}
      {view.kind === 'multi' && (
        <SelectionInspector devices={view.devices} links={view.links} topology={topology} />
      )}
      {view.kind === 'empty' && (
        <div className="min-h-0 flex-1 overflow-y-auto pt-12">
          <EmptyState icon={MousePointer2Icon} title="Nothing selected">
            Select a device or link on the canvas to see its interfaces, configuration and CLI here.
          </EmptyState>
        </div>
      )}
    </aside>
  );
}
