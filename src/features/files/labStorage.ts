import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export type LabId = string & { readonly __brand: 'LabId' };

export const newLabId = () => crypto.randomUUID() as LabId;

export type LabSummary = { id: LabId; name: string; updatedAt: string; deviceCount: number };

// `topology` is whatever was written, possibly by an older or newer build. Readers parse it with
// the model's file parser before trusting it.
export type LabRecord = LabSummary & { topology: unknown };

interface LabDb extends DBSchema {
  labs: { key: LabId; value: LabRecord; indexes: { updatedAt: string } };
  session: { key: 'current'; value: LabId };
}

const DB_NAME = 'tracer';

export type LabStorage = {
  // Writes the lab and makes it the one to restore on the next start.
  put(record: LabRecord): Promise<void>;
  setCurrent(id: LabId): Promise<void>;
  get(id: LabId): Promise<LabRecord | undefined>;
  getCurrentId(): Promise<LabId | undefined>;
  recent(limit: number): Promise<LabSummary[]>;
};

function wrap(db: IDBPDatabase<LabDb>): LabStorage {
  return {
    async put(record) {
      const tx = db.transaction(['labs', 'session'], 'readwrite');
      await Promise.all([
        tx.objectStore('labs').put(record),
        tx.objectStore('session').put(record.id, 'current'),
        tx.done,
      ]);
    },
    async setCurrent(id) {
      await db.put('session', id, 'current');
    },
    get: (id) => db.get('labs', id),
    getCurrentId: () => db.get('session', 'current'),
    async recent(limit) {
      const summaries: LabSummary[] = [];
      let cursor = await db.transaction('labs').store.index('updatedAt').openCursor(null, 'prev');
      while (cursor && summaries.length < limit) {
        const { id, name, updatedAt, deviceCount } = cursor.value;
        summaries.push({ id, name, updatedAt, deviceCount });
        cursor = await cursor.continue();
      }
      return summaries;
    },
  };
}

// Rejects where IndexedDB is missing or blocked (some private modes); callers run without it.
export async function openLabStorage(): Promise<LabStorage> {
  const db = await openDB<LabDb>(DB_NAME, 1, {
    upgrade(db) {
      db.createObjectStore('labs', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt');
      db.createObjectStore('session');
    },
  });
  return wrap(db);
}

let persistence: Promise<boolean> | undefined;

/**
 * Asks the browser to keep the site's storage when the disk runs low, and Safari not to clear it
 * after seven days without a visit. Chrome and Safari decide silently; Firefox asks the user, so
 * it is asked once, after a lab has been saved. The answer only lowers the risk of losing labs:
 * the app saves the same either way.
 */
export function requestPersistentStorage(): Promise<boolean> {
  persistence ??= (async () => {
    try {
      const storage = navigator.storage;
      if (!storage?.persist) return false;
      return (await storage.persisted()) || (await storage.persist());
    } catch {
      return false;
    }
  })();
  return persistence;
}
