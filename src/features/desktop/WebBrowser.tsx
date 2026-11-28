import {
  ArrowRightIcon,
  GlobeIcon,
  LoaderCircleIcon,
  RotateCwIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import type { DeviceId, Ipv4Address } from '@/model';
import { Button } from '@/ui/button';
import { cn } from '@/ui/cn';
import type { BrowseTarget, FetchEvent, FetchFailure, HostBackend, HttpResponse } from './backend';
import { describeFailure, formatUrl, loadingStatus, parseUrl } from './browser';
import { followIn, plainTextPage, sanitizePage } from './sanitize';

/** Where the browser is: a blank page, a load under way, or how the last one ended. */
type Load =
  | { kind: 'blank' }
  | { kind: 'invalid'; message: string }
  | { kind: 'loading'; target: BrowseTarget; step?: FetchEvent }
  | { kind: 'page'; target: BrowseTarget; address: Ipv4Address; response: HttpResponse }
  | { kind: 'failed'; target: BrowseTarget; failure: FetchFailure }
  | { kind: 'unavailable'; target: BrowseTarget; message: string };

type Settled = Exclude<Load, { kind: 'loading' }>;

// Each host's last address and page, so coming back to the browser finds them.
const visited = new Map<DeviceId, { url: string; load: Settled }>();

const isHtml = (response: HttpResponse) => /^\s*text\/html\b/i.test(response.contentType);

/** A host's Web Browser: an address bar, and the page from a simulated server, or why there is none. */
export function WebBrowser({ device, backend }: { device: DeviceId; backend: HostBackend }) {
  const [url, setUrl] = useState(() => visited.get(device)?.url ?? '');
  const [load, setLoad] = useState<Load>(() => visited.get(device)?.load ?? { kind: 'blank' });
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);

  const settle = (next: Settled, shown: string) => {
    visited.set(device, { url: shown, load: next });
    setLoad(next);
  };

  const go = (text: string) => {
    running.current?.abort();
    const parsed = parseUrl(text);
    if (!parsed.ok) return setLoad({ kind: 'invalid', message: parsed.error });
    const target = parsed.value;
    const shown = formatUrl(target);
    setUrl(shown);
    setLoad({ kind: 'loading', target });
    const controller = new AbortController();
    running.current = controller;
    const onEvent = (event: FetchEvent) => {
      if (event.kind === 'response') {
        settle({ kind: 'page', target, address: event.address, response: event.response }, shown);
      } else if (event.kind === 'failed') {
        settle({ kind: 'failed', target, failure: event.failure }, shown);
      } else {
        setLoad({ kind: 'loading', target, step: event });
      }
    };
    backend.browse(device, target, onEvent, controller.signal).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      settle({ kind: 'unavailable', target, message }, shown);
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    go(url);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        aria-label="Address bar"
        onSubmit={submit}
        className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1.5"
      >
        <div className="relative flex min-w-0 flex-1 items-center">
          <GlobeIcon
            aria-hidden="true"
            className="pointer-events-none absolute left-2 size-3.5 text-fg-3"
          />
          <input
            aria-label="URL"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="www.lab.local"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            inputMode="url"
            className="h-7 w-full min-w-0 rounded-full border border-line bg-surface-2/60 pr-2 pl-7 font-mono text-[0.6875rem] text-fg-1 transition-colors outline-none placeholder:text-fg-3/70 hover:border-line-strong focus-visible:border-accent focus-visible:bg-surface-1 focus-visible:ring-2 focus-visible:ring-accent/25"
          />
        </div>
        <Button type="submit" size="sm" variant="primary" aria-label="Go">
          Go
          <ArrowRightIcon />
        </Button>
      </form>
      <Status load={load} />
      <div className="min-h-0 flex-1 overflow-hidden">
        <View load={load} onRetry={() => go(url)} onNavigate={go} />
      </div>
    </div>
  );
}

/** The line under the address bar: what the load is doing, or what came back. */
function Status({ load }: { load: Load }) {
  let text: string | undefined;
  if (load.kind === 'loading') text = loadingStatus(load.step, load.target);
  else if (load.kind === 'page') {
    const { status, reason } = load.response;
    text = `HTTP ${status} ${reason} from ${load.address}`;
  }
  const error = load.kind === 'page' && load.response.status >= 400;
  return (
    <p
      role="status"
      aria-label="Page status"
      className={cn(
        'flex h-6 shrink-0 items-center gap-1.5 border-b border-line bg-surface-2/40 px-2.5 text-2xs text-fg-3',
        !text && 'sr-only',
      )}
    >
      {load.kind === 'loading' && (
        <LoaderCircleIcon
          aria-hidden="true"
          className="size-3 animate-spin text-accent motion-reduce:animate-none"
        />
      )}
      {load.kind === 'page' && (
        <span
          aria-hidden="true"
          className={cn('size-1.5 rounded-full', error ? 'bg-warn' : 'bg-ok')}
        />
      )}
      <span className="truncate font-mono">{text}</span>
    </p>
  );
}

function View({
  load,
  onRetry,
  onNavigate,
}: {
  load: Load;
  onRetry: () => void;
  onNavigate: (url: string) => void;
}) {
  switch (load.kind) {
    case 'blank':
      return (
        <Message icon={GlobeIcon} title="Web Browser">
          Type a server’s name or IP address above, such as www.lab.local, and press Enter.
        </Message>
      );
    case 'loading':
      return null;
    case 'invalid':
      return (
        <Message icon={TriangleAlertIcon} title="Can’t open that address" alert>
          {load.message}
        </Message>
      );
    case 'unavailable':
      return (
        <Message icon={TriangleAlertIcon} title="The page could not load" alert>
          {load.message}
        </Message>
      );
    case 'failed': {
      const { title, detail } = describeFailure(load.failure);
      return (
        <Message icon={TriangleAlertIcon} title={title} alert onRetry={onRetry}>
          {detail}
        </Message>
      );
    }
    case 'page':
      return (
        <Page response={load.response} base={formatUrl(load.target)} onNavigate={onNavigate} />
      );
  }
}

/**
 * The server's page, sanitized, in a frame that runs no scripts and reaches no real network. Its
 * links and forms load their pages from the simulated network, as `followIn` follows them.
 */
function Page({
  response,
  base,
  onNavigate,
}: {
  response: HttpResponse;
  base: string;
  onNavigate: (url: string) => void;
}) {
  const page = useMemo(
    () => (isHtml(response) ? sanitizePage(response.body) : plainTextPage(response.body)),
    [response],
  );
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);
  return (
    <iframe
      title="Page"
      // Same origin lets the browser follow links in the frame; with no allow-scripts, the page
      // still runs nothing.
      sandbox="allow-same-origin"
      onLoad={(event) => {
        stop.current?.();
        const doc = event.currentTarget.contentDocument;
        stop.current = doc ? followIn(doc, base, onNavigate) : null;
      }}
      srcDoc={page}
      referrerPolicy="no-referrer"
      className="block size-full border-0 bg-white"
    />
  );
}

function Message({
  icon: Icon,
  title,
  alert = false,
  onRetry,
  children,
}: {
  icon: typeof GlobeIcon;
  title: string;
  alert?: boolean;
  onRetry?: () => void;
  children: string;
}) {
  return (
    <div
      role={alert ? 'alert' : undefined}
      className="flex flex-col items-center gap-3 px-6 py-10 text-center text-balance"
    >
      <span
        aria-hidden="true"
        className={cn(
          'flex size-10 items-center justify-center rounded-lg border',
          alert ? 'border-err/30 bg-err/8 text-err' : 'border-line bg-surface-2 text-fg-2',
        )}
      >
        <Icon className="size-5" strokeWidth={1.75} />
      </span>
      <div className="flex max-w-72 flex-col gap-1">
        <h4 className="text-sm font-medium text-fg-1">{title}</h4>
        <p className="text-xs text-fg-2">{children}</p>
      </div>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          <RotateCwIcon />
          Try again
        </Button>
      )}
    </div>
  );
}
