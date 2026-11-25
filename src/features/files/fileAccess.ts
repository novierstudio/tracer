import { acceptAttribute, pickerTypes } from './importers';

// The File System Access API is Chromium-only and missing from lib.dom.
type PickerType = { description: string; accept: Record<string, readonly string[]> };
type FileAccessWindow = {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: PickerType[];
  }) => Promise<FileSystemFileHandle>;
  showOpenFilePicker?: (options: { types: PickerType[] }) => Promise<FileSystemFileHandle[]>;
};

const fileAccess = () => window as unknown as FileAccessWindow;

export const NATIVE_EXTENSION = '.tracer.json';
const SAVE_TYPES: PickerType[] = [
  { description: 'Tracer lab', accept: { 'application/json': [NATIVE_EXTENSION] } },
];

export const isAbort = (error: unknown) =>
  error instanceof DOMException && error.name === 'AbortError';

/** A file name from the lab name, with the characters file systems refuse replaced. */
export function fileNameFor(labName: string, extension = NATIVE_EXTENSION): string {
  const base = labName
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return `${base || 'Untitled lab'}${extension}`;
}

export async function writeToHandle(handle: FileSystemFileHandle, text: string) {
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
}

// Undefined when the browser has no save picker. Throws an AbortError if the user cancels.
export async function pickSaveHandle(suggestedName: string) {
  return fileAccess().showSaveFilePicker?.({ suggestedName, types: SAVE_TYPES });
}

export function download(text: string, fileName: string) {
  downloadBlob(new Blob([text], { type: 'application/json' }), fileName);
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export type PickedFile = { file: File; handle?: FileSystemFileHandle };

// Resolves undefined when the user cancels.
export async function pickOpenFile(): Promise<PickedFile | undefined> {
  const access = fileAccess();
  if (access.showOpenFilePicker) {
    try {
      const [handle] = await access.showOpenFilePicker({ types: pickerTypes() });
      return handle && { file: await handle.getFile(), handle };
    } catch (error) {
      if (isAbort(error)) return undefined;
      throw error;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = acceptAttribute();
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      resolve(file && { file });
    });
    input.addEventListener('cancel', () => resolve(undefined));
    input.click();
  });
}
