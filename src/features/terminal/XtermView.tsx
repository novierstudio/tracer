import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useEffectEvent, useId, useRef } from 'react';
import type { Tty } from './tty';

const FONT_FAMILY = '"JetBrains Mono Variable", ui-monospace, monospace';
const FONT_SIZE = 13;

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

/** A fresh xterm on `tty`: it replays the transcript, then types into and shows the tty. */
function connect(tty: Tty, parent: HTMLElement) {
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
  term.onData((data) => tty.input(data, { cols: term.cols, rows: term.rows }));
  // Keys the browser handles instead of xterm: Shift+Tab moves focus out of the terminal,
  // Ctrl+V pastes, and Ctrl+C copies a selection instead of abandoning the line.
  const forBrowser = (event: KeyboardEvent) =>
    (event.key === 'Tab' && event.shiftKey) ||
    (event.ctrlKey && event.key.toLowerCase() === 'v') ||
    (event.ctrlKey && event.key === 'c' && term.hasSelection());
  // xterm sends nothing for Ctrl+Shift+6, the IOS escape sequence; Ctrl+^ is 0x1e.
  const isEscape = (event: KeyboardEvent) =>
    event.type === 'keydown' && event.ctrlKey && event.shiftKey && event.code === 'Digit6';
  term.attachCustomKeyEventHandler((event) => {
    if (isEscape(event)) {
      tty.input('\x1e', { cols: term.cols, rows: term.rows });
      return false;
    }
    return !forBrowser(event);
  });
  term.open(parent);
  return { term, fit };
}

const IOS_HINT =
  'Tab completes a command and ? lists what can come next. Shift+Tab leaves the terminal.';

/** `hint` tells a screen reader how the terminal's keys work. */
type XtermViewProps = { tty: Tty; autoFocus: boolean; hint?: string };

export default function XtermView({ tty, autoFocus, hint = IOS_HINT }: XtermViewProps) {
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
      const { term, fit } = connect(tty, parent);

      const refit = () => {
        if (parent.clientWidth > 0 && parent.clientHeight > 0) fit.fit();
      };
      const applyTheme = () => {
        term.options.theme = themeFrom(parent);
      };
      refit();
      applyTheme();
      term.write(tty.transcript);
      const unsubscribe = tty.subscribe((out) => term.write(out));
      const resizes = new ResizeObserver(refit);
      resizes.observe(parent);
      const themes = new MutationObserver(applyTheme);
      themes.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      onAttach(term);

      detach = () => {
        unsubscribe();
        resizes.disconnect();
        themes.disconnect();
        term.dispose();
      };
    });
    return () => {
      cancelled = true;
      detach?.();
    };
  }, [tty]);

  return (
    <div className="h-full min-h-0">
      <p id={hintId} className="sr-only">
        {hint}
      </p>
      <div ref={host} className="h-full" />
    </div>
  );
}
