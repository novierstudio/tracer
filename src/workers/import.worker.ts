// Imports Packet Tracer files off the main thread. Load it through `importClient.ts`.
import { expose } from 'comlink';
import { importPkt, type PktStage } from '@/importers/pkt/mapper';

const api = {
  importPkt: (bytes: Uint8Array, name: string, onStage: (stage: PktStage) => void) =>
    importPkt(bytes, { name, onStage }),
};

export type ImportWorkerApi = typeof api;

expose(api);
