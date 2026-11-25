import {
  ArrowLeftIcon,
  CopyIcon,
  PlayIcon,
  PlusIcon,
  RadioIcon,
  SettingsIcon,
  TerminalIcon,
  Trash2Icon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ThemeMenu } from '@/app/ThemeMenu';
import { Button } from '@/ui/button';
import { cn } from '@/ui/cn';
import { Dialog, DialogClose, DialogContent, DialogTrigger, SheetContent } from '@/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Input } from '@/ui/input';
import { Kbd } from '@/ui/kbd';
import { Segmented } from '@/ui/segmented';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';
import { Tooltip } from '@/ui/tooltip';

const TOKEN_GROUPS: { title: string; tokens: string[] }[] = [
  { title: 'Surfaces', tokens: ['surface-0', 'surface-1', 'surface-2', 'surface-3'] },
  { title: 'Lines', tokens: ['line', 'line-strong', 'grid-dot'] },
  { title: 'Text', tokens: ['text-1', 'text-2', 'text-3'] },
  { title: 'Accent', tokens: ['accent', 'accent-fg', 'accent-text'] },
  { title: 'Status', tokens: ['ok', 'warn', 'err'] },
  {
    title: 'Protocols',
    tokens: [
      'proto-icmp',
      'proto-arp',
      'proto-dhcp',
      'proto-dns',
      'proto-tcp',
      'proto-stp',
      'proto-routing',
    ],
  },
];

const TYPE_SCALE = [
  { className: 'text-base font-semibold', name: 'base · 14px', sample: 'Panel title' },
  { className: 'text-sm', name: 'sm · 13px', sample: 'Default UI text' },
  { className: 'text-xs', name: 'xs · 12px', sample: 'Secondary labels and tabs' },
  { className: 'text-2xs uppercase tracking-wide', name: '2xs · 11px', sample: 'Section caps' },
  { className: 'font-mono text-xs', name: 'mono · 12px', sample: 'Router# show ip int br' },
];

const SPACING = [1, 2, 3, 4, 6, 8, 12];
const RADII = ['rounded-sm', 'rounded-md', 'rounded-lg', 'rounded-xl'];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-2xs font-semibold tracking-wide text-fg-3 uppercase">{title}</h2>
      {children}
    </section>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

function Tokens() {
  return (
    <div className="flex flex-col gap-4">
      {TOKEN_GROUPS.map((group) => (
        <div key={group.title} className="flex flex-col gap-2">
          <h3 className="text-xs font-medium text-fg-2">{group.title}</h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2">
            {group.tokens.map((token) => (
              <div key={token} className="flex items-center gap-2">
                <span
                  className="size-8 shrink-0 rounded-md border border-line"
                  style={{ background: `var(--${token})` }}
                />
                <code className="truncate font-mono text-2xs text-fg-2">--{token}</code>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Components() {
  const [mode, setMode] = useState<'realtime' | 'simulation'>('realtime');
  return (
    <div className="flex flex-col gap-6">
      <Section title="Button">
        <Row>
          <Button variant="primary">Primary</Button>
          <Button>Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button disabled>Disabled</Button>
        </Row>
        <Row>
          <Button size="sm">
            <PlusIcon />
            Small
          </Button>
          <Button size="icon" aria-label="Settings">
            <SettingsIcon />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Copy">
            <CopyIcon />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Pressed" aria-pressed>
            <TerminalIcon />
          </Button>
        </Row>
      </Section>
      <Section title="Input and Kbd">
        <Input placeholder="Search devices…" aria-label="Example input" />
        <Row>
          <Kbd>⌘</Kbd>
          <Kbd>K</Kbd>
          <Kbd>[</Kbd>
          <Kbd>F</Kbd>
        </Row>
      </Section>
      <Section title="Segmented">
        <Segmented
          label="Example mode"
          value={mode}
          onValueChange={setMode}
          className="self-start"
          options={[
            { value: 'realtime', label: 'Realtime', icon: <RadioIcon /> },
            {
              value: 'simulation',
              label: 'Simulation',
              icon: <PlayIcon />,
              activeClassName: 'data-[state=on]:text-warn',
            },
          ]}
        />
      </Section>
      <Section title="Tabs">
        <Tabs defaultValue="events" className="flex flex-col gap-2">
          <TabsList>
            <TabsTrigger value="events">Events</TabsTrigger>
            <TabsTrigger value="terminal">Terminal</TabsTrigger>
          </TabsList>
          <TabsContent value="events" className="text-fg-2">
            Event list content.
          </TabsContent>
          <TabsContent value="terminal" className="font-mono text-xs text-fg-2">
            Router&gt;
          </TabsContent>
        </Tabs>
      </Section>
      <Section title="Overlays">
        <Row>
          <Tooltip label="Toggle inspector" shortcut="]">
            <Button>Tooltip</Button>
          </Tooltip>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button>Menu</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>Device</DropdownMenuLabel>
              <DropdownMenuItem>
                <CopyIcon />
                Duplicate
                <DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
              </DropdownMenuItem>
              <DropdownMenuItem disabled>
                <TerminalIcon />
                Open CLI
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-err data-[highlighted]:text-err [&_svg]:text-err">
                <Trash2Icon />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Dialog>
            <DialogTrigger asChild>
              <Button>Dialog</Button>
            </DialogTrigger>
            <DialogContent title="Delete device?" description="This removes R1 and its 3 links.">
              <div className="flex justify-end gap-2">
                <DialogClose asChild>
                  <Button>Cancel</Button>
                </DialogClose>
                <DialogClose asChild>
                  <Button variant="primary">Delete</Button>
                </DialogClose>
              </div>
            </DialogContent>
          </Dialog>
          <Dialog>
            <DialogTrigger asChild>
              <Button>Sheet</Button>
            </DialogTrigger>
            <SheetContent title="Example sheet" side="right">
              <p className="p-4 pt-12 text-fg-2">Side panels open like this on narrow screens.</p>
            </SheetContent>
          </Dialog>
        </Row>
      </Section>
    </div>
  );
}

function Foundations() {
  return (
    <div className="flex flex-col gap-6">
      <Section title="Colour tokens">
        <Tokens />
      </Section>
      <Section title="Type">
        <div className="flex flex-col gap-2">
          {TYPE_SCALE.map((t) => (
            <div key={t.name} className="flex items-baseline gap-4">
              <code className="w-24 shrink-0 font-mono text-2xs text-fg-3">{t.name}</code>
              <span className={cn('text-fg-1', t.className)}>{t.sample}</span>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Spacing · 4px grid">
        <div className="flex flex-col gap-1.5">
          {SPACING.map((step) => (
            <div key={step} className="flex items-center gap-4">
              <code className="w-24 shrink-0 font-mono text-2xs text-fg-3">
                {step} · {step * 4}px
              </code>
              <span className="h-2 rounded-sm bg-accent" style={{ width: step * 4 }} />
            </div>
          ))}
        </div>
      </Section>
      <Section title="Radius">
        <Row>
          {RADII.map((radius) => (
            <div key={radius} className="flex flex-col items-center gap-1">
              <span className={cn('size-12 border border-line-strong bg-surface-2', radius)} />
              <code className="font-mono text-2xs text-fg-3">{radius.replace('rounded-', '')}</code>
            </div>
          ))}
        </Row>
      </Section>
    </div>
  );
}

function ThemePane({ theme }: { theme: 'light' | 'dark' }) {
  return (
    <div
      className={cn(
        theme,
        'flex min-w-0 flex-col gap-8 rounded-xl border border-line bg-surface-1 p-4 text-fg-1 sm:p-6',
      )}
      data-testid={`gallery-${theme}`}
    >
      <p className="text-xs font-medium text-fg-2 capitalize">{theme} theme</p>
      <Foundations />
      <Components />
    </div>
  );
}

export default function UiGallery() {
  return (
    <div className="min-h-full bg-surface-0">
      <header className="sticky top-0 z-10 flex h-12 items-center gap-2 border-b border-line bg-surface-1/90 px-3 backdrop-blur">
        <Button asChild variant="ghost" size="sm">
          <a href="#/">
            <ArrowLeftIcon />
            Back to app
          </a>
        </Button>
        <h1 className="text-sm font-semibold">Design system</h1>
        <div className="ml-auto">
          <ThemeMenu />
        </div>
      </header>
      <main className="mx-auto grid max-w-7xl gap-4 p-4 xl:grid-cols-2">
        <ThemePane theme="light" />
        <ThemePane theme="dark" />
      </main>
    </div>
  );
}
