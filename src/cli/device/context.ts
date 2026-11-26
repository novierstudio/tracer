import type { Draft } from 'immer';
import type { Device, Ipv4Address, RemoteProtocol } from '../../model';
import type { EngineQueryKind, EngineStream, Render } from './query';

export type IosDevice = Extract<Device, { kind: 'router' | 'switch' }>;
export type RouterDevice = Extract<Device, { kind: 'router' }>;
export type SwitchDevice = Extract<Device, { kind: 'switch' }>;

/** Input a command waits for before it finishes. */
export type Pending =
  /** `banner motd #` without the closing `#`: later lines are banner text. */
  | { readonly kind: 'banner'; readonly delimiter: string; readonly text: string }
  /** `enable` on a device with an enable secret or password. */
  | { readonly kind: 'enable-password'; readonly attempts: number }
  /**
   * A login's password: the line's, or with `login local` the account's, once `user` is known.
   * `attempts` counts the failures so far.
   */
  | { readonly kind: 'login'; readonly attempts: number; readonly user?: string }
  /** A `login local` line asking who is logging in. */
  | { readonly kind: 'username'; readonly attempts: number }
  /** `crypto key generate rsa` on a device that has keys: replace them? */
  | { readonly kind: 'rsa-replace'; readonly modulus?: number }
  /** `crypto key generate rsa` without `modulus`: how many bits. */
  | { readonly kind: 'rsa-modulus' };

/** The terminal line a session runs on: the console, or a vty line Telnet or SSH opened. */
export type SessionLine =
  | { readonly kind: 'console' }
  | {
      readonly kind: 'vty';
      /** 0 to 15, as in `line vty 0 15`. */
      readonly index: number;
      readonly protocol: RemoteProtocol;
      /** The address the session came from. */
      readonly peer: Ipv4Address;
      /** For SSH, the user named with `-l`. */
      readonly user?: string;
    };

export const CONSOLE_LINE: SessionLine = { kind: 'console' };

/** `telnet` or `ssh`: a session to open from this device to another. */
export type RemoteRequest = {
  readonly protocol: RemoteProtocol;
  readonly target: Ipv4Address;
  /** `ssh -l user`. */
  readonly user?: string;
};

export type IosDraft = Draft<RouterDevice> | Draft<SwitchDevice>;

/** What a command handler gets. The session commits its edits to `device.config` as one step. */
export interface DeviceContext {
  readonly device: IosDraft;
  /** The lines typed in this kind of mode, EXEC or config, oldest first, ending with this one. */
  readonly history: readonly string[];
  /** The line this session runs on. */
  readonly line: SessionLine;
  /** Refuses the command. Its edits are dropped and the mode does not change. */
  reject(message: string): readonly string[];
  /** Holds the mode and reads the next lines as `pending` input. Returns the lines to print. */
  ask(pending: Pending): readonly string[];
  /**
   * Marks the command as a show command that reads live simulation state of `kind`. Returns the
   * config-only output, `render(undefined)`, for the handler to return.
   */
  query<K extends EngineQueryKind>(kind: K, render: Render<K>): readonly string[];
  /**
   * Marks the command as one whose output streams from the simulation, such as `ping`. The
   * handler returns what to print when there is no simulation.
   */
  stream(stream: EngineStream): void;
  /** Asks the terminal to open a Telnet or SSH session from this device. */
  connect(request: RemoteRequest): void;
  /** Ends this session, as `exit` on a vty line does: the far end closes the connection. */
  disconnect(): void;
}

export interface RouterContext extends DeviceContext {
  readonly device: Draft<RouterDevice>;
}

export interface SwitchContext extends DeviceContext {
  readonly device: Draft<SwitchDevice>;
  query<K extends EngineQueryKind>(kind: K, render: Render<K, SwitchDevice>): readonly string[];
}

export const INVALID_INPUT = "% Invalid input detected at '^' marker.";
