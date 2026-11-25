import { MousePointer2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { DeviceId } from '@/model';
import { useEditor } from '@/model/react';
import { EmptyState } from '@/ui/empty-state';
import { AnnotationInspector } from './AnnotationInspector';
import { DeviceInspector, type DeviceTab } from './DeviceInspector';
import './devHandle';
import { LinkInspector } from './LinkInspector';
import { consoleRequests, takeConsoleRequest } from './requests';
import { SelectionInspector } from './SelectionInspector';
import { inspectorView } from './view';

export function InspectorPanel() {
  const topology = useEditor((state) => state.topology);
  const selection = useEditor((state) => state.selection);
  // A request to open a device's console may be what mounted this panel, so the first render
  // takes it up front; later ones arrive through the subscription.
  const [opened] = useState(takeConsoleRequest);
  // Kept across selections, so stepping through devices stays on the same tab.
  const [tab, setTab] = useState<DeviceTab>(opened ? 'console' : 'overview');
  // The CLI takes focus when someone picks its tab, not when the selection moves to a device.
  const [focusFor, setFocusFor] = useState<DeviceId | undefined>(opened?.device);
  useEffect(
    () =>
      consoleRequests.subscribe(() => {
        const request = takeConsoleRequest();
        if (!request) return;
        setTab('console');
        setFocusFor(request.device);
      }),
    [],
  );
  const view = inspectorView(topology, selection);

  return (
    <aside aria-label="Inspector" className="flex h-full flex-col bg-surface-1">
      <div className="flex h-10 shrink-0 items-center px-3">
        <h2 className="text-xs font-semibold text-fg-1">Inspector</h2>
      </div>
      {view.kind === 'device' && (
        <DeviceInspector
          device={view.device}
          topology={topology}
          tab={tab}
          onTabChange={(next) => {
            setTab(next);
            setFocusFor(next === 'console' ? view.device.id : undefined);
          }}
          focusConsole={focusFor === view.device.id}
        />
      )}
      {view.kind === 'link' && <LinkInspector link={view.link} topology={topology} />}
      {view.kind === 'annotation' && (
        <AnnotationInspector key={view.annotation.id} annotation={view.annotation} />
      )}
      {view.kind === 'multi' && (
        <SelectionInspector
          devices={view.devices}
          links={view.links}
          annotations={view.annotations}
          topology={topology}
        />
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
