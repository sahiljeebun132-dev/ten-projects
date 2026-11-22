// Your recordings, kept in this browser (IndexedDB): the audio, the pitch line and the numbers of
// each take worth hearing again. Nothing here is uploaded. After every save the library prunes
// itself (progress.js decides what stays), so it never grows without bound.
import { planPrune } from './progress.js';

const DB_NAME = 'aria-takes';
const STORE = 'takes';

let opening = null;

function db() {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('This browser can’t keep recordings.'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('key', 'key');
    };
    req.onsuccess = () => {
      const handle = req.result;
      handle.onversionchange = () => {
        handle.close();
        opening = null;
      };
      resolve(handle);
    };
    req.onerror = () => reject(req.error || new Error('Recordings are unavailable.'));
    req.onblocked = () => reject(new Error('Recordings are busy in another tab.'));
  });
  opening.catch(() => {
    opening = null;
  });
  return opening;
}

/** Run one request in a transaction; resolves with its result once the transaction commits. */
async function run(mode, fn) {
  const handle = await db();
  return new Promise((resolve, reject) => {
    const tx = handle.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    let value;
    if (req) req.onsuccess = () => (value = req.result);
    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error || new Error('Recording storage failed.'));
    tx.onabort = () => reject(tx.error || new Error('Recording storage failed (is the disk full?).'));
  });
}

/** Every kept take, oldest first. */
export async function listTakes() {
  const all = (await run('readonly', (s) => s.getAll())) || [];
  return all.sort((a, b) => a.at - b.at);
}

/** Kept takes of one exercise or song, oldest first. */
export async function takesFor(key) {
  const all = (await run('readonly', (s) => s.index('key').getAll(key))) || [];
  return all.sort((a, b) => a.at - b.at);
}

export function getTake(id) {
  return run('readonly', (s) => s.get(id));
}

export function deleteTake(id) {
  return run('readwrite', (s) => s.delete(id));
}

export async function setStarred(id, starred) {
  const rec = await getTake(id);
  if (!rec) return null;
  rec.starred = Boolean(starred);
  await run('readwrite', (s) => s.put(rec));
  return rec;
}

export function clearTakes() {
  return run('readwrite', (s) => s.clear());
}

/** Delete what the library no longer needs. Returns how many recordings went. */
export async function prune(now = Date.now()) {
  const all = await listTakes();
  const doomed = planPrune(
    all.map((t) => ({ id: t.id, key: t.key, at: t.at, stats: { score: t.stats?.score ?? 0 }, bytes: t.bytes || 0, starred: t.starred })),
    {},
    now,
  );
  if (doomed.length) await run('readwrite', (s) => doomed.forEach((id) => s.delete(id)));
  return doomed.length;
}

/** Keep a take (see progress.js takeRecord), then prune. Resolves to the saved record. */
export async function saveTake(rec, audio = null) {
  const full = { ...rec, audio: audio || null, mime: audio?.type || null, bytes: audio?.size || 0 };
  await run('readwrite', (s) => s.put(full));
  await prune().catch(() => 0);
  return full;
}

/** How much the library holds: { count, bytes }. */
export async function usage() {
  const all = await listTakes();
  return { count: all.length, bytes: all.reduce((n, t) => n + (t.bytes || 0), 0) };
}
