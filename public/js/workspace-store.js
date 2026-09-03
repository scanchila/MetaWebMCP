const DATABASE_NAME = 'metawebmcp-workspace';
const DATABASE_VERSION = 1;
const STORE_NAME = 'workspace';
const CURRENT_WORKSPACE_KEY = 'current';

function transactionResult(database, mode, operation) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    let result;
    let settled = false;

    const fail = () => {
      if (settled) return;
      settled = true;
      reject(transaction.error || new Error('IndexedDB workspace transaction failed.'));
    };

    transaction.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    transaction.onerror = fail;
    transaction.onabort = fail;

    try {
      const request = operation(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => { result = request.result; };
    } catch (error) {
      settled = true;
      try { transaction.abort(); } catch { /* Transaction may already be inactive. */ }
      reject(error);
    }
  });
}

function openWorkspaceDatabase(indexedDb) {
  if (!indexedDb || typeof indexedDb.open !== 'function') {
    return Promise.reject(new Error('IndexedDB is not available in this browser.'));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDb.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(request.error || new Error('IndexedDB workspace could not be opened.'));
    request.onblocked = () => reject(new Error('IndexedDB workspace upgrade is blocked by another page.'));
  });
}

export function createWorkspaceStore(indexedDb = globalThis.indexedDB) {
  let databasePromise;
  const database = () => {
    databasePromise ||= openWorkspaceDatabase(indexedDb);
    return databasePromise;
  };

  return Object.freeze({
    async load() {
      return (await transactionResult(
        await database(),
        'readonly',
        (store) => store.get(CURRENT_WORKSPACE_KEY),
      )) || null;
    },

    async save(workspace) {
      if (!workspace || typeof workspace !== 'object' || Array.isArray(workspace)) {
        throw new Error('A serializable workspace record is required.');
      }
      await transactionResult(
        await database(),
        'readwrite',
        (store) => store.put(workspace, CURRENT_WORKSPACE_KEY),
      );
    },

    async clear() {
      await transactionResult(
        await database(),
        'readwrite',
        (store) => store.delete(CURRENT_WORKSPACE_KEY),
      );
    },
  });
}
