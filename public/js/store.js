// On-device storage. The dataset in progress lives in IndexedDB so a phone
// discarding the tab loses nothing; small settings live in localStorage.
//
// Image bytes are stored as ArrayBuffers, never Blobs: WebKit aborts an
// IndexedDB transaction whose value contains a Blob (found the hard way in
// Patchbay, the sibling app).

const DB_NAME = "lora-dataset-builder";
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
        if (!db.objectStoreNames.contains("items")) db.createObjectStore("items", { keyPath: "id" });
        if (!db.objectStoreNames.contains("output")) db.createObjectStore("output");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

function run(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const st = tx.objectStore(store);
        let result;
        const r = fn(st);
        if (r) r.onsuccess = () => (result = r.result);
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("Storage transaction aborted."));
      })
  );
}

export const db = {
  getMeta: () => run("meta", "readonly", (s) => s.get("dataset")),
  putMeta: (meta) => run("meta", "readwrite", (s) => s.put(meta, "dataset")),
  allItems: () => run("items", "readonly", (s) => s.getAll()),
  putItem: (item) => run("items", "readwrite", (s) => s.put(item)),
  deleteItem: (id) => run("items", "readwrite", (s) => s.delete(id)),
  clearDataset: async () => {
    await run("items", "readwrite", (s) => s.clear());
    await run("meta", "readwrite", (s) => s.delete("dataset"));
  },
  getOutput: () => run("output", "readonly", (s) => s.get("lora")),
  putOutput: (rec) => run("output", "readwrite", (s) => s.put(rec, "lora")),
  clearOutput: () => run("output", "readwrite", (s) => s.delete("lora")),
};

// localStorage can throw (private browsing, blocked site data); a failed
// read or write costs only the convenience it was for.
export const prefs = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem("ldb." + key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      if (value === null || value === undefined) localStorage.removeItem("ldb." + key);
      else localStorage.setItem("ldb." + key, JSON.stringify(value));
    } catch {}
  },
};

// Asks the browser not to evict this site's storage under pressure. WebKit
// evicts best-effort storage after a stretch without use; persistent storage
// is exempt.
export function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch {}
}
