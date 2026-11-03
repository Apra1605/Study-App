const DB_NAME = 'studyspace-document-library';
const DB_VERSION = 2;
let dbPromise;

function openDb() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('This browser does not support IndexedDB, which is needed to checkpoint large presentations.'));
  if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('sources')) db.createObjectStore('sources', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('slides')) {
        const slides = db.createObjectStore('slides', { keyPath: 'key' });
        slides.createIndex('documentId', 'documentId', { unique: false });
      }
      if (!db.objectStoreNames.contains('analysis')) {
        const analysis = db.createObjectStore('analysis', { keyPath: 'key' });
        analysis.createIndex('documentId', 'documentId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open the local document cache.'));
    request.onblocked = () => reject(new Error('Close other Studyspace tabs to finish updating the local document cache.'));
  });
  return dbPromise;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Local document storage failed.'));
  });
}

async function transaction(storeName, mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    try { result = action(store); } catch (error) { reject(error); return; }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('Local document storage failed.'));
    tx.onabort = () => reject(tx.error || new Error('Local document storage was interrupted.'));
  });
}

export async function putJob(job) { await transaction('jobs', 'readwrite', store => store.put(job)); return job; }
export async function getJob(id) { return requestResult((await openDb()).transaction('jobs').objectStore('jobs').get(id)); }
export async function listJobs() { return requestResult((await openDb()).transaction('jobs').objectStore('jobs').getAll()); }
export async function putSource(id, blob) { await transaction('sources', 'readwrite', store => store.put({ id, blob })); }
export async function getSource(id) { return requestResult((await openDb()).transaction('sources').objectStore('sources').get(id)); }
export async function deleteSource(id) { await transaction('sources', 'readwrite', store => store.delete(id)); }
export async function putSlides(documentId, items) {
  await transaction('slides', 'readwrite', store => {
    for (const slide of items) store.put({ ...slide, documentId, key: `${documentId}:${String(slide.slideNumber).padStart(5, '0')}` });
  });
}
export async function getSlides(documentId) {
  const db = await openDb();
  return requestResult(db.transaction('slides').objectStore('slides').index('documentId').getAll(documentId));
}
export async function putAnalysis(documentId, item) {
  await transaction('analysis', 'readwrite', store => store.put({ ...item, documentId, key: `${documentId}:${String(item.batchIndex).padStart(5, '0')}` }));
}
export async function getAnalysis(documentId) {
  const db = await openDb();
  return requestResult(db.transaction('analysis').objectStore('analysis').index('documentId').getAll(documentId));
}
export async function deleteDocumentCache(documentId) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['jobs', 'sources', 'slides', 'analysis'], 'readwrite');
    tx.objectStore('jobs').delete(documentId);
    tx.objectStore('sources').delete(documentId);
    for (const storeName of ['slides', 'analysis']) {
      const store = tx.objectStore(storeName), cursor = store.index('documentId').openCursor(IDBKeyRange.only(documentId));
      cursor.onsuccess = () => { const item = cursor.result; if (item) { item.delete(); item.continue(); } };
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('Could not clear the local document cache.'));
  });
}

export async function deleteLegacyDocumentCache(localKey) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['jobs', 'slides', 'analysis'], 'readwrite');
    tx.objectStore('jobs').delete(localKey);
    for (const storeName of ['slides', 'analysis']) {
      const store = tx.objectStore(storeName);
      const cursor = store.index('documentId').openCursor(IDBKeyRange.only(localKey));
      cursor.onsuccess = () => { const item = cursor.result; if (item) { item.delete(); item.continue(); } };
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error || new Error('Could not remove migrated local presentation data.'));
    tx.onabort = () => reject(tx.error || new Error('Could not remove migrated local presentation data.'));
  });
}
