import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useEffectEvent, useId, useRef } from 'react';
import { feed, initialState, reduce } from './discipline';
import { createDemoSession, type TerminalSession } from './session';

const FONT_FAMILY = '"JetBrains Mono Variable", ui-monospace, monospace';
const FONT_SIZE = 13;

interface Console {
  readonly term: Terminal;
  readonly fit: FitAddon;
  /** xterm renders into this element. It moves between mounts so scrollback survives. */
  readonly element: HTMLDivElement;
}

const consoles = new WeakMap<TerminalSession, Console>();

function themeFrom(element: Element): ITheme {
  const css = getComputedStyle(element);
  const token = (name: string) => css.getPropertyValue(name).trim();
  return {
    background: token('--surface-1'),
    foreground: token('--text-1'),
    cursor: token('--text-1'),
    cursorAccent: token('--surface-1'),
    selectionBackground: `${token('--accent')}4d`,
    scrollbarSliderBackground: `${token('--text-3')}1f`,
    scrollbarSliderHoverBackground: `${token('--text-3')}4d`,
    scrollbarSliderActiveBackground: `${token('--text-3')}66`,
  };
}

function connect(session: TerminalSession, parent: HTMLElement): Console {
  const element = document.createElement('div');
  element.style.height = '100%';
  parent.append(element);
  const term = new Terminal({
    fontFamily: FONT_FAMILY,
    fontSize: FONT_SIZE,
    lineHeight: 1.25,
    cursorBlink: true,
    screenReaderMode: true,
    scrollback: 5000,
    theme: themeFrom(parent),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  let state = initialState(term.cols, term.rows);
  term.onData((data) => {
    const step = feed(state, data, session);
    state = step.state;
    term.write(step.out);
  });
  term.onResize(({ cols, rows }) => {
    state = reduce(state, { kind: 'resize', cols, rows }, session).state;
  });
  // Keys the browser handles instead of xterm: Shift+Tab moves focus out of the terminal,
  // Ctrl+V pastes, and Ctrl+C copies a selection instead of abandoning the line.
  const forBrowser = (event: KeyboardEvent) =>
    (event.key === 'Tab' && event.shiftKey) ||
    (event.ctrlKey && event.key.toLowerCase() === 'v') ||
    (event.ctrlKey && event.key === 'c' && term.hasSelection());
  term.attachCustomKeyEventHandler((event) => !forBrowser(event));
  term.open(element);
  term.write(session.prompt);
  return { term, fit, element };
}

type XtermViewProps = { session: TerminalSession; autoFocus: boolean };

export function XtermView({ session, autoFocus }: XtermViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const hintId = useId();

  const onAttach = useEffectEvent((term: Terminal) => {
    term.textarea?.setAttribute('aria-describedby', hintId);
    if (autoFocus) term.focus();
  });

  useEffect(() => {
    const parent = host.current!;
    let detach: (() => void) | undefined;
    let cancelled = false;
    // xterm measures the cell size once, so the font must be ready first.
    void document.fonts.load(`${FONT_SIZE}px ${FONT_FAMILY}`).then(() => {
      if (cancelled) return;
      let view = consoles.get(session);
      if (view) parent.append(view.element);
      else consoles.set(session, (view = connect(session, parent)));
      const { term, fit, element } = view;

      const refit = () => {
        if (parent.clientWidth > 0 && parent.clientHeight > 0) fit.fit();
      };
      const applyTheme = () => {
        term.options.theme = themeFrom(parent);
      };
      refit();
      applyTheme();
      const resizes = new ResizeObserver(refit);
      resizes.observe(parent);
      const themes = new MutationObserver(applyTheme);
      themes.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      onAttach(term);

      detach = () => {
        resizes.disconnect();
        themes.disconnect();
        element.remove();
      };
    });
    return () => {
      cancelled = true;
      detach?.();
    };
  }, [session]);

  return (
    <div className="h-full min-h-0">
      <p id={hintId} className="sr-only">
        Tab completes a command and ? lists what can come next. Shift+Tab leaves the terminal.
      </p>
      <div ref={host} className="h-full" />
    </div>
  );
}

const demo = createDemoSession();

export default function DemoTerminal({ autoFocus }: { autoFocus: boolean }) {
  return <XtermView session={demo} autoFocus={autoFocus} />;
}
