/**
 * Tiny persistence abstraction over `localStorage`.
 *
 * This app is entirely client side: it runs in the visitor's own browser and
 * every task belongs to that browser only. There is no server, no account and
 * nothing leaves the machine, so `localStorage` is the right store here.
 *
 * Everything is wrapped in try/catch because `localStorage` throws in a few
 * real situations: Safari private mode, disabled cookies/site data, and quota
 * exhaustion. In those cases we degrade to an in-memory fallback so the app
 * keeps working for the session instead of crashing.
 */

const memoryFallback = new Map<string, string>();

function getBackingStore(): Storage | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    // Touch the store: some browsers only throw on access.
    const probe = '__task_board_probe__';
    window.localStorage.setItem(probe, probe);
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

let cachedStore: Storage | null | undefined;

function store(): Storage | null {
  if (cachedStore === undefined) cachedStore = getBackingStore();
  return cachedStore;
}

/** True when we are persisting to real `localStorage` rather than memory. */
export function isPersistent(): boolean {
  return store() !== null;
}

function readRaw(key: string): string | null {
  const s = store();
  if (!s) return memoryFallback.get(key) ?? null;
  try {
    return s.getItem(key);
  } catch {
    return memoryFallback.get(key) ?? null;
  }
}

function writeRaw(key: string, value: string): void {
  const s = store();
  memoryFallback.set(key, value);
  if (!s) return;
  try {
    s.setItem(key, value);
  } catch {
    // Quota exceeded or storage revoked mid-session: keep the memory copy.
  }
}

/**
 * Read a JSON value, running it through `parse` so callers can validate and
 * migrate whatever happens to be on disk. Any malformed data resolves to
 * `fallback` rather than throwing.
 */
export function readJSON<T>(key: string, parse: (raw: unknown) => T | null, fallback: T): T {
  const raw = readRaw(key);
  if (raw === null) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    const value = parse(parsed);
    return value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

export function writeJSON(key: string, value: unknown): void {
  try {
    writeRaw(key, JSON.stringify(value));
  } catch {
    // Value contained something non-serialisable; nothing useful to persist.
  }
}

export const STORAGE_KEYS = {
  tasks: 'task-board:tasks:v1',
  theme: 'task-board:theme:v1',
  filters: 'task-board:filters:v1',
} as const;
