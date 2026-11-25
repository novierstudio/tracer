export type { IosDevice, Pending, RouterDevice, SwitchDevice } from './device/context';
export {
  applyLines,
  createDeviceSession,
  openConsole,
  toConfigUpdate,
  withBlankConfig,
  type ApplyResult,
  type Console,
  type DeviceSession,
  type LineError,
  type SessionResult,
  type SessionState,
} from './device/session';
export { CLOCK_RATES } from './device/commands';
export {
  answerQuery,
  openStream,
  type EngineAnswers,
  type EngineQuery,
  type EngineQueryKind,
  type EngineSource,
  type EngineStream,
  type OutputStream,
  type PortStates,
  type StreamSource,
} from './device/query';
export { runningConfig, UNSUPPORTED_MARKER } from './device/show';
export { formatError, formatHelp } from './format';
export { expandInterfaceRange, INTERFACE_TYPES, normalizeInterface } from './interfaces';
export {
  endMode,
  exitMode,
  GLOBAL_CONFIG,
  isConfigMode,
  PRIV_EXEC,
  prompt,
  USER_EXEC,
  type LineRef,
  type Mode,
  type ModeKind,
  type ModeOf,
} from './modes';
export {
  choice,
  iface,
  ifaceRange,
  ipv4,
  keyword,
  line,
  mask,
  num,
  word,
  type HelpEntry,
} from './params';
export {
  complete,
  help,
  parse,
  type CliError,
  type CompleteResult,
  type HelpError,
  type HelpResult,
  type ParsedCommand,
  type ParseResult,
} from './parser';
export { buildTree, defineCommand, type ArgsOf, type Command, type CommandTree } from './tree';
