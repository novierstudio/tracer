import { MousePointer2Icon } from 'lucide-react';
import { EmptyState } from '@/ui/empty-state';

export function InspectorPanel() {
  return (
    <aside aria-label="Inspector" className="flex h-full flex-col bg-surface-1">
      <div className="flex h-10 shrink-0 items-center px-3">
        <h2 className="text-xs font-semibold text-fg-1">Inspector</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pt-12">
        <EmptyState icon={MousePointer2Icon} title="Nothing selected">
          Select a device or link on the canvas to see its interfaces, configuration and CLI here.
        </EmptyState>
      </div>
    </aside>
  );
}
