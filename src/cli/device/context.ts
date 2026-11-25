import type { Draft } from 'immer';
import type { Device } from '../../model';
import type { EngineQueryKind, Render } from './query';

export type IosDevice = Extract<Device, { kind: 'router' | 'switch' }>;
export type RouterDevice = Extract<Device, { kind: 'router' }>;
export type SwitchDevice = Extract<Device, { kind: 'switch' }>;

/** Input a command waits for before it finishes. */
export type Pending =
  /** `banner motd #` without the closing `#`: later lines are banner text. */
  | { readonly kind: 'banner'; readonly delimiter: string; readonly text: string }
  /** `enable` on a device with an enable secret or password. */
  | { readonly kind: 'enable-password'; readonly attempts: number }
  /** Opening the console when its line has `login` and a password. */
  | { readonly kind: 'login'; readonly attempts: number };

export type IosDraft = Draft<RouterDevice> | Draft<SwitchDevice>;

/** What a command handler gets. The session commits its edits to `device.config` as one step. */
export interface DeviceContext {
  readonly device: IosDraft;
  /** Refuses the command. Its edits are dropped and the mode does not change. */
  reject(message: string): readonly string[];
  /** Holds the mode and reads the next lines as `pending` input. Returns the lines to print. */
  ask(pending: Pending): readonly string[];
  /**
   * Marks the command as a show command that reads live simulation state of `kind`. Returns the
   * config-only output, `render(undefined)`, for the handler to return.
   */
  query<K extends EngineQueryKind>(kind: K, render: Render<K>): readonly string[];
}

export interface RouterContext extends DeviceContext {
  readonly device: Draft<RouterDevice>;
}

export interface SwitchContext extends DeviceContext {
  readonly device: Draft<SwitchDevice>;
  query<K extends EngineQueryKind>(kind: K, render: Render<K, SwitchDevice>): readonly string[];
}

export const INVALID_INPUT = "% Invalid input detected at '^' marker.";
