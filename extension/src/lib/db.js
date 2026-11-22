// Small IndexedDB wrapper.
//
//   kv     — key/value (settings-like state, CryptoKeys, cursors)
//   model  — per-collection "last synced" state, keyed [coll, id]
//   hist   — archive of history synced from other devices, for search
//
// IndexedDB can store non-extractable CryptoKeys, which chrome.storage cannot.

const DB_NAME = 'helium-sync';
const DB_VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('model')) {
        const m = db.createObjectStore('model', { keyPath: ['c', 'id'] });
        m.createIndex('c', 'c');
      }
      if (!db.objectStoreNames.contains('hist')) {
        const h = db.createObjectStore('hist', { keyPath: 'id' });
        h.createIndex('v', 'v');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbp = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbp = null;
      reject(req.error);
    };
  });
  return dbp;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

function result(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function kvGet(key) {
  const db = await open();
  return result(db.transaction('kv').objectStore('kv').get(key));
}

export async function kvSet(key, value) {
  const db = await open();
  const tx = db.transaction('kv', 'readwrite');
  tx.objectStore('kv').put(value, key);
  return done(tx);
}

export async function kvDelete(key) {
  const db = await open();
  const tx = db.transaction('kv', 'readwrite');
  tx.objectStore('kv').delete(key);
  return done(tx);
}

/** Loads all model entries of a collection into a Map(id -> entry). */
export async function modelLoad(coll) {
  const db = await open();
  const all = await result(db.transaction('model').objectStore('model').index('c').getAll(coll));
  return new Map(all.map((e) => [e.id, e]));
}

/** Applies puts (entries with c and id) and deletes (ids) in one transaction. */
export async function modelWrite(coll, puts, deletes = []) {
  if (!puts.length && !deletes.length) return;
  const db = await open();
  const tx = db.transaction('model', 'readwrite');
  const st = tx.objectStore('model');
  for (const e of puts) st.put({ ...e, c: coll });
  for (const id of deletes) st.delete([coll, id]);
  return done(tx);
}

export async function modelClear(coll) {
  const db = await open();
  const tx = db.transaction('model', 'readwrite');
  const st = tx.objectStore('model');
  const keys = await result(st.index('c').getAllKeys(coll));
  for (const k of keys) st.delete(k);
  return done(tx);
}

export async function histPut(entries) {
  if (!entries.length) return;
  const db = await open();
  const tx = db.transaction('hist', 'readwrite');
  const st = tx.objectStore('hist');
  for (const e of entries) st.put(e);
  return done(tx);
}

export async function histDelete(ids) {
  if (!ids.length) return;
  const db = await open();
  const tx = db.transaction('hist', 'readwrite');
  const st = tx.objectStore('hist');
  for (const id of ids) st.delete(id);
  return done(tx);
}

/** Newest-first scan of the history archive with an optional text filter. */
export async function histSearch(text, limit = 200) {
  const db = await open();
  const needle = (text || '').toLowerCase();
  const out = [];
  return new Promise((resolve, reject) => {
    const req = db.transaction('hist').objectStore('hist').index('v').openCursor(null, 'prev');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur || out.length >= limit) return resolve(out);
      const e = cur.value;
      if (!needle || e.u.toLowerCase().includes(needle) || (e.t || '').toLowerCase().includes(needle)) out.push(e);
      cur.continue();
    };
  });
}

export async function histClear(before = Infinity) {
  const db = await open();
  const tx = db.transaction('hist', 'readwrite');
  const st = tx.objectStore('hist');
  if (before === Infinity) st.clear();
  else st.index('v').openCursor(IDBKeyRange.upperBound(before)).onsuccess = (ev) => {
    const cur = ev.target.result;
    if (cur) {
      cur.delete();
      cur.continue();
    }
  };
  return done(tx);
}

/** Deletes everything (sign-out). */
export async function wipe() {
  const db = await open();
  const tx = db.transaction(['kv', 'model', 'hist'], 'readwrite');
  for (const s of ['kv', 'model', 'hist']) tx.objectStore(s).clear();
  return done(tx);
}
