import { createStore } from 'zustand/vanilla';
import type { Topology } from '@/model';
import { editorStore } from '@/model/store';
import type { ImageBackground, ImageFormat } from './exportImage';
import { downloadBlob, fileNameFor } from './fileAccess';
import type { FileProblem } from './importers';
import { fileSession } from './session';

/** A share link is the app URL with the lab in its hash. */
export const SHARE_PREFIX = '#t=';

/** Longer links still work in browsers, but chat apps and email clients may cut them off. */
export const LONG_LINK_CHARS = 8000;

const isShareHash = (hash: string) => hash.startsWith(SHARE_PREFIX);

// The codec loads on first use, so fflate stays out of the first load.
const loadCodec = () => import('./share');

export type SharingState = {
  /** A lab from a share link, waiting for the user to open it. */
  sharedLab: Topology | undefined;
  /** The export image dialog is open. */
  choosingImage: boolean;
  /** The length of the share link just copied, for the toast that says so. */
  copiedLength: number | undefined;
};

export const sharing = createStore<SharingState>()(() => ({
  sharedLab: undefined,
  choosingImage: false,
  copiedLength: undefined,
}));

const showProblem = (problem: FileProblem) => fileSession.state.setState({ problem });
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
const labName = () => editorStore.getState().topology.meta.name;

// Drops the share link from the address bar, so a reload opens the lab from Recent labs instead.
function clearShareHash() {
  if (!isShareHash(window.location.hash)) return;
  const { pathname, search } = window.location;
  window.history.replaceState(window.history.state, '', pathname + search);
}

/** Offers the lab in the address bar's share link, or explains why it can't be opened. */
export async function readShareLink() {
  const { hash } = window.location;
  if (!isShareHash(hash)) return;
  const decoded = (await loadCodec()).decodeLab(hash.slice(SHARE_PREFIX.length));
  if (decoded.ok) {
    sharing.setState({ sharedLab: decoded.value });
  } else {
    clearShareHash();
    showProblem(decoded.error);
  }
}

export async function openSharedLab() {
  const lab = sharing.getState().sharedLab;
  clearShareHash();
  sharing.setState({ sharedLab: undefined });
  if (lab) await fileSession.openLab(lab);
}

export function dismissSharedLab() {
  clearShareHash();
  sharing.setState({ sharedLab: undefined });
}

export async function copyShareLink() {
  const topology = editorStore.getState().topology;
  const { origin, pathname } = window.location;
  const url = loadCodec().then(
    ({ encodeLab }) => origin + pathname + SHARE_PREFIX + encodeLab(topology),
  );
  try {
    // Safari only copies during the click, so the clipboard gets a promise of the link rather than
    // waiting for the codec to load first.
    if (typeof ClipboardItem === 'function' && navigator.clipboard.write) {
      const blob = url.then((text) => new Blob([text], { type: 'text/plain' }));
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
    } else {
      await navigator.clipboard.writeText(await url);
    }
    sharing.setState({ copiedLength: (await url).length });
  } catch {
    showProblem({
      title: "Couldn't copy the share link",
      message: 'The browser did not allow it. Copy the link below instead.',
      detail: await url.catch(() => undefined),
    });
  }
}

export const dismissCopied = () => sharing.setState({ copiedLength: undefined });

export const chooseImage = (choosingImage: boolean) => sharing.setState({ choosingImage });

export async function exportImage(format: ImageFormat, background: ImageBackground) {
  const title = "Couldn't export the image";
  try {
    const { captureCanvas } = await import('./exportImage');
    const image = await captureCanvas(format, background);
    if (!image) {
      showProblem({ title, message: 'The lab is empty. Add a device or a note first.' });
      return;
    }
    downloadBlob(image, fileNameFor(labName(), `.${format}`));
  } catch (error) {
    showProblem({ title, message: describe(error) });
  }
}

export async function exportConfigs() {
  const { configArchive, configArchiveName } = await import('./exportConfig');
  const archive = configArchive(editorStore.getState().topology);
  if (!archive) {
    showProblem({
      title: 'No configs to export',
      message: 'Only routers and switches have a running-config, and this lab has neither.',
    });
    return;
  }
  downloadBlob(archive, configArchiveName(labName()));
}
