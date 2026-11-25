import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate';
import { err, ok, parseTopology, type Result, type Topology } from '@/model';
import type { FileProblem } from './importers';

// A share link carries the lab itself, deflated and base64url-encoded, so it needs no server.

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function encodeLab(topology: Topology): string {
  return toBase64Url(deflateSync(strToU8(JSON.stringify(topology)), { level: 9 }));
}

const damaged = (message: string, detail?: string): FileProblem => ({
  title: "Couldn't open the shared lab",
  message: `${message} Ask for the link again, or for the lab's .tracer.json file.`,
  detail,
});

export function decodeLab(data: string): Result<Topology, FileProblem> {
  if (!data.trim()) return err(damaged('The link has no lab in it.'));
  let json: unknown;
  try {
    json = JSON.parse(strFromU8(inflateSync(fromBase64Url(data.trim()))));
  } catch {
    return err(damaged('The link is incomplete or damaged, perhaps cut off when it was copied.'));
  }
  const parsed = parseTopology(json);
  if (!parsed.ok) return err(damaged('The lab in the link is not valid.', parsed.error.message));
  return ok(parsed.value);
}
