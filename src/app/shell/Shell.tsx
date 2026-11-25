import { MinimizeIcon } from 'lucide-react';
import { useCallback, useEffect, useEffectEvent, useState } from 'react';
import { Group, Panel, Separator, usePanelRef, type Layout } from 'react-resizable-panels';
import { Canvas } from '@/features/canvas/Canvas';
import { canvasEscape, canvasShortcuts, isCanvasTarget } from '@/features/canvas/controller';
import { appCommands } from '@/features/command/appCommands';
import { CommandPalette } from '@/features/command/CommandPalette';
import { useRegisterCommands } from '@/features/command/registry';
import { FileDialogs } from '@/features/files/FileDialogs';
import { fileSession } from '@/features/files/session';
import { InspectorPanel } from '@/features/inspector/InspectorPanel';
import { PalettePanel, type PaletteSection } from '@/features/palette/PalettePanel';
import { BottomPanel } from '@/features/simulation/BottomPanel';
import { Button } from '@/ui/button';
import { cn } from '@/ui/cn';
import { Dialog, SheetContent } from '@/ui/dialog';
import { editorStore } from '@/model/store';
import { Kbd } from '@/ui/kbd';
import { readJson, safeStorage } from '../storage';
import { useMediaQuery } from '../useMediaQuery';
import { HelpDialogs, type HelpDialog } from './HelpDialogs';
import { Rail } from './Rail';
import { formatShortcut, matchShortcut, SHORTCUTS, type ShortcutId } from './shortcuts';
import { StatusBar } from './StatusBar';
import { TopBar, type Mode } from './TopBar';

type SidePanel = 'palette' | 'inspector';

// At or above this width the side panels dock; below it they open as drawers.
const DOCKED_QUERY = '(min-width: 1280px)';
const BOTTOM_MIN_PX = 140;

function usePersistedLayout(id: string, panelIds: string[], fallback?: Layout) {
  const key = `tracer.layout.${id}`;
  const [defaultLayout] = useState(() => {
    const saved = readJson(key, (value): Layout | undefined => {
      if (typeof value !== 'object' || value === null) return undefined;
      const layout = value as Record<string, unknown>;
      const valid = panelIds.every((panel) => typeof layout[panel] === 'number');
      return valid ? (layout as Layout) : undefined;
    });
    return saved ?? fallback;
  });
  const onLayoutChanged = useCallback(
    (layout: Layout) => safeStorage.setItem(key, JSON.stringify(layout)),
    [key],
  );
  return { defaultLayout, onLayoutChanged };
}

type CollapsibleOptions = { initiallyCollapsed: boolean; minPx?: number; openSize?: string };

// The library owns panel sizes; this mirrors whether a panel is collapsed so the UI can show it.
// A panel that starts collapsed has no previous size, so the library expands it to its minimum;
// `openSize` gives it a roomier first size instead.
function useCollapsible({ initiallyCollapsed, minPx = 0, openSize }: CollapsibleOptions) {
  const ref = usePanelRef();
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  const expand = () => {
    const panel = ref.current;
    if (!panel?.isCollapsed()) return;
    panel.expand();
    if (openSize && panel.getSize().inPixels <= minPx + 1) panel.resize(openSize);
  };
  return {
    ref,
    collapsed,
    onResize: () => setCollapsed(ref.current?.isCollapsed() ?? false),
    expand,
    toggle: () => (ref.current?.isCollapsed() ? expand() : ref.current?.collapse()),
  };
}

function ResizeHandle({ orientation }: { orientation: 'horizontal' | 'vertical' }) {
  return (
    <Separator
      className={cn(
        'relative bg-line transition-colors duration-150 outline-none data-[separator=active]:bg-accent data-[separator=hover]:bg-accent focus-visible:bg-accent',
        orientation === 'horizontal' ? 'w-px' : 'h-px',
      )}
    />
  );
}

function isEditable(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  );
}

export function Shell() {
  const docked = useMediaQuery(DOCKED_QUERY);
  const [mode, setMode] = useState<Mode>('realtime');
  const [focus, setFocus] = useState(false);
  const [drawer, setDrawer] = useState<SidePanel | null>(null);
  const [section, setSection] = useState<PaletteSection>('devices');
  const [help, setHelp] = useState<HelpDialog | null>(null);
  const [commandsOpen, setCommandsOpen] = useState(false);

  const sideLayout = usePersistedLayout('side', ['palette', 'workspace', 'inspector']);
  const bottomLayout = usePersistedLayout('bottom', ['canvas', 'bottom'], {
    canvas: 100,
    bottom: 0,
  });
  const palette = useCollapsible({ initiallyCollapsed: sideLayout.defaultLayout?.palette === 0 });
  const inspector = useCollapsible({
    initiallyCollapsed: sideLayout.defaultLayout?.inspector === 0,
  });
  const bottom = useCollapsible({
    initiallyCollapsed: bottomLayout.defaultLayout?.bottom === 0,
    minPx: BOTTOM_MIN_PX,
    openSize: '35%',
  });
  const docks = { palette, inspector };

  const isOpen = (side: SidePanel) => (docked ? !docks[side].collapsed : drawer === side);
  const openSide = (side: SidePanel) => (docked ? docks[side].expand() : setDrawer(side));
  const toggleSide = (side: SidePanel) =>
    docked ? docks[side].toggle() : setDrawer((open) => (open === side ? null : side));

  const changeMode = (next: Mode) => {
    setMode(next);
    if (next === 'simulation') bottom.expand();
  };

  const selectSection = (next: PaletteSection) => {
    if (isOpen('palette') && section === next) return toggleSide('palette');
    setSection(next);
    openSide('palette');
  };

  const runShortcut = (id: ShortcutId) => {
    const panelAction = (show: () => void, toggle: () => void) => () => {
      if (!focus) return toggle();
      setFocus(false);
      show();
    };
    const actions: Record<ShortcutId, () => void> = {
      ...canvasShortcuts,
      commandPalette: () => setCommandsOpen((open) => !open),
      undo: () => editorStore.getState().undo(),
      redo: () => editorStore.getState().redo(),
      save: () => void fileSession.save(),
      saveAs: () => void fileSession.saveAs(),
      open: () => void fileSession.open(),
      togglePalette: panelAction(
        () => openSide('palette'),
        () => toggleSide('palette'),
      ),
      toggleInspector: panelAction(
        () => openSide('inspector'),
        () => toggleSide('inspector'),
      ),
      toggleBottom: panelAction(bottom.expand, bottom.toggle),
      focusMode: () => setFocus((on) => !on),
      toggleMode: () => changeMode(mode === 'realtime' ? 'simulation' : 'realtime'),
      showShortcuts: () => setHelp('shortcuts'),
    };
    actions[id]();
  };

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    const id = matchShortcut(event);
    const typing = isEditable(event.target) && !(id && SHORTCUTS[id].inTextFields);
    if (event.defaultPrevented || typing) return;
    if (event.key === 'Escape' && canvasEscape()) return event.preventDefault();
    if (focus && event.key === 'Escape') return setFocus(false);
    if (!id || (SHORTCUTS[id].canvasOnly && !isCanvasTarget(event.target))) return;
    event.preventDefault();
    runShortcut(id);
  });

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useRegisterCommands(appCommands({ mode, runShortcut, openHelp: setHelp }));

  const workspace = (
    <Group
      orientation="vertical"
      id="bottom"
      className="min-w-0 flex-1"
      defaultLayout={bottomLayout.defaultLayout}
      onLayoutChanged={bottomLayout.onLayoutChanged}
    >
      <Panel id="canvas" minSize={160}>
        <Canvas fullscreen={focus}>
          {focus && (
            <Button size="sm" className="shadow-pop" onClick={() => setFocus(false)}>
              <MinimizeIcon />
              Exit focus mode
              <Kbd className="-mr-1">{formatShortcut('focusMode')}</Kbd>
            </Button>
          )}
        </Canvas>
      </Panel>
      <ResizeHandle orientation="vertical" />
      <Panel
        id="bottom"
        panelRef={bottom.ref}
        onResize={bottom.onResize}
        collapsible
        minSize={BOTTOM_MIN_PX}
        inert={focus}
      >
        {!bottom.collapsed && (
          <BottomPanel
            onCollapse={bottom.toggle}
            collapseShortcut={formatShortcut('toggleBottom')}
          />
        )}
      </Panel>
    </Group>
  );

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <div inert={focus} className="contents">
        <TopBar
          mode={mode}
          onModeChange={changeMode}
          onOpenHelp={setHelp}
          onOpenCommands={() => setCommandsOpen(true)}
          panels={{
            palette: {
              id: 'togglePalette',
              open: isOpen('palette'),
              onToggle: () => toggleSide('palette'),
            },
            bottom: { id: 'toggleBottom', open: !bottom.collapsed, onToggle: bottom.toggle },
            inspector: {
              id: 'toggleInspector',
              open: isOpen('inspector'),
              onToggle: () => toggleSide('inspector'),
            },
          }}
        />
      </div>
      <div className="flex min-h-0 flex-1">
        <Rail active={isOpen('palette') ? section : null} onSelect={selectSection} inert={focus} />
        {docked ? (
          <Group
            id="side"
            className="min-w-0 flex-1"
            defaultLayout={sideLayout.defaultLayout}
            onLayoutChanged={sideLayout.onLayoutChanged}
          >
            <Panel
              id="palette"
              panelRef={palette.ref}
              onResize={palette.onResize}
              collapsible
              minSize={200}
              maxSize={360}
              defaultSize={248}
              groupResizeBehavior="preserve-pixel-size"
              inert={focus}
            >
              {!palette.collapsed && <PalettePanel section={section} />}
            </Panel>
            <ResizeHandle orientation="horizontal" />
            <Panel id="workspace" minSize={400} className="flex">
              {workspace}
            </Panel>
            <ResizeHandle orientation="horizontal" />
            <Panel
              id="inspector"
              panelRef={inspector.ref}
              onResize={inspector.onResize}
              collapsible
              minSize={260}
              maxSize={440}
              defaultSize={300}
              groupResizeBehavior="preserve-pixel-size"
              inert={focus}
            >
              {!inspector.collapsed && <InspectorPanel />}
            </Panel>
          </Group>
        ) : (
          workspace
        )}
      </div>
      <StatusBar mode={mode} onOpenHelp={setHelp} inert={focus} />

      {!docked && (
        <>
          <Dialog
            open={drawer === 'palette'}
            onOpenChange={(open) => setDrawer(open ? 'palette' : null)}
          >
            <SheetContent title="Device palette" side="left">
              <PalettePanel section={section} />
            </SheetContent>
          </Dialog>
          <Dialog
            open={drawer === 'inspector'}
            onOpenChange={(open) => setDrawer(open ? 'inspector' : null)}
          >
            <SheetContent title="Inspector" side="right">
              <InspectorPanel />
            </SheetContent>
          </Dialog>
        </>
      )}
      <HelpDialogs open={help} onOpenChange={setHelp} />
      <CommandPalette open={commandsOpen} onOpenChange={setCommandsOpen} />
      <FileDialogs />
    </div>
  );
}
