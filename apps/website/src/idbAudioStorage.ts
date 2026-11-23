import type { AudioStorage, RetainedRecording } from "./recordedAudio.ts";

/**
 * The browser's {@link AudioStorage}: one IndexedDB record per recording,
 * holding its PCM chunks as they were captured. The size cap and eviction
 * order are policy and live in `recordedAudio.ts`; this only stores what it
 * is told to and returns what it has.
 */

const DB_NAME = "vxbeamer";
const DB_VERSION = 1;
const STORE = "recordings";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function openDatabase(): Promise<IDBDatabase> {
  const opening = indexedDB.open(DB_NAME, DB_VERSION);
  opening.onupgradeneeded = () => {
    opening.result.createObjectStore(STORE, { keyPath: "referenceId" });
  };
  return request(opening);
}

/** The IndexedDB-backed store, or null where there is no IndexedDB (or it is blocked). */
export function createIdbAudioStorage(): AudioStorage | null {
  if (typeof indexedDB === "undefined") return null;

  let database: Promise<IDBDatabase> | null = null;
  const db = () => (database ??= openDatabase());

  async function write(work: (store: IDBObjectStore) => void): Promise<void> {
    const tx = (await db()).transaction(STORE, "readwrite");
    work(tx.objectStore(STORE));
    await done(tx);
  }

  return {
    async loadAll() {
      const tx = (await db()).transaction(STORE, "readonly");
      const all = await request<RetainedRecording[]>(tx.objectStore(STORE).getAll());
      return all.sort((a, b) => a.createdAt - b.createdAt);
    },
    save: (recording) => write((store) => void store.put(recording)),
    remove: (referenceIds) =>
      write((store) => {
        for (const referenceId of referenceIds) store.delete(referenceId);
      }),
    clear: () => write((store) => void store.clear()),
  };
}
