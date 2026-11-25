// localStorage can throw (private mode, blocked site data) or be missing; the app must still run.
export const safeStorage = {
  getItem(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Not persisting is acceptable.
    }
  },
};

export function readJson<T>(key: string, parse: (value: unknown) => T | undefined): T | undefined {
  const raw = safeStorage.getItem(key);
  if (raw === null) return undefined;
  try {
    return parse(JSON.parse(raw));
  } catch {
    return undefined;
  }
}
