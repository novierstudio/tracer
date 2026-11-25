import type { HelpError, HelpResult } from './parser';

/** IOS error text. `promptWidth` lines the caret up under the echoed input. */
export function formatError(error: HelpError, promptWidth: number): string[] {
  switch (error.kind) {
    case 'invalid':
      return [
        `${' '.repeat(promptWidth + error.column)}^`,
        "% Invalid input detected at '^' marker.",
      ];
    case 'ambiguous':
      return [`% Ambiguous command: "${error.input}"`];
    case 'incomplete':
      return ['% Incomplete command.'];
    case 'unrecognized':
      return ['% Unrecognized command'];
  }
}

/** IOS `?` output: aligned columns for options, one row for words. */
export function formatHelp(result: HelpResult, promptWidth: number): string[] {
  switch (result.kind) {
    case 'options': {
      const width = Math.max(...result.options.map((o) => o.name.length));
      return result.options.map((o) => `  ${o.name.padEnd(width)}  ${o.help}`.trimEnd());
    }
    case 'words':
      return [result.words.join('  ')];
    case 'error':
      return formatError(result.error, promptWidth);
  }
}
