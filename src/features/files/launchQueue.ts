import { fileSession } from './session';

// The File Handling API, Chromium-only and missing from lib.dom: the installed app is launched with
// the files the user opened with it.
type LaunchQueueWindow = {
  launchQueue?: {
    setConsumer(consumer: (params: { files: readonly FileSystemFileHandle[] }) => void): void;
  };
};

/** Opens a lab file the user opened with the installed app, such as a double-clicked `.pkt`. */
export function openLaunchedFiles() {
  (window as unknown as LaunchQueueWindow).launchQueue?.setConsumer(async ({ files: [handle] }) => {
    if (handle) await fileSession.openFile(await handle.getFile(), handle);
  });
}
