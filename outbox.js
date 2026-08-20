(function initializeInvoiceDraftOutbox() {
  "use strict";

  const DATABASE_NAME = "invoice-studio-reliability-v1";
  const DATABASE_VERSION = 1;
  const STORE_NAME = "draft-outbox";
  let databasePromise;
  const memoryFallback = new Map();

  function operationId() {
    if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error || new Error("IndexedDB request failed.")), { once: true });
    });
  }

  function transactionComplete(transaction) {
    return new Promise((resolve, reject) => {
      transaction.addEventListener("complete", resolve, { once: true });
      transaction.addEventListener("abort", () => reject(transaction.error || new Error("IndexedDB transaction was aborted.")), { once: true });
      transaction.addEventListener("error", () => reject(transaction.error || new Error("IndexedDB transaction failed.")), { once: true });
    });
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.addEventListener("upgradeneeded", () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME, { keyPath: "userId" });
        }
      });
      request.addEventListener("success", () => {
        const database = request.result;
        database.addEventListener("versionchange", () => database.close());
        resolve(database);
      }, { once: true });
      request.addEventListener("error", () => {
        databasePromise = undefined;
        reject(request.error || new Error("IndexedDB could not be opened."));
      }, { once: true });
      request.addEventListener("blocked", () => {
        databasePromise = undefined;
        reject(new Error("IndexedDB upgrade is blocked by another tab."));
      }, { once: true });
    });
    return databasePromise;
  }

  async function read(userId) {
    if (!userId) return null;
    try {
      const database = await openDatabase();
      const transaction = database.transaction(STORE_NAME, "readonly");
      const value = await requestResult(transaction.objectStore(STORE_NAME).get(userId));
      await transactionComplete(transaction);
      return value || memoryFallback.get(userId) || null;
    } catch {
      return memoryFallback.get(userId) || null;
    }
  }

  async function write(operation) {
    const memoryOperation = { ...operation, storage: "memory" };
    memoryFallback.set(operation.userId, memoryOperation);
    try {
      const database = await openDatabase();
      const transaction = database.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(operation);
      await transactionComplete(transaction);
      memoryFallback.delete(operation.userId);
      return { ...operation, storage: "indexeddb" };
    } catch {
      // The in-memory copy still lets the local backend flush this operation
      // when IndexedDB is blocked or unavailable for the current session.
      return memoryOperation;
    }
  }

  function operationFor(userId, type, invoice, expectedRevision) {
    return {
      userId,
      operationId: operationId(),
      type,
      invoice: invoice || null,
      expectedRevision: Number.isInteger(expectedRevision) ? expectedRevision : null,
      createdAt: new Date().toISOString(),
      attempts: 0,
      nextAttemptAt: 0,
      lastError: "",
    };
  }

  function putSave(userId, invoice, expectedRevision) {
    if (!userId || !invoice) return Promise.reject(new Error("A user and draft are required."));
    return write(operationFor(userId, "save", invoice, expectedRevision));
  }

  function putDelete(userId, expectedRevision) {
    if (!userId) return Promise.reject(new Error("A user is required."));
    return write(operationFor(userId, "delete", null, expectedRevision));
  }

  async function updateMatching(userId, expectedOperationId, updater) {
    const memoryValue = memoryFallback.get(userId) || null;
    let database;
    let transaction;
    let store;
    let storedValue = null;
    try {
      database = await openDatabase();
      transaction = database.transaction(STORE_NAME, "readwrite");
      store = transaction.objectStore(STORE_NAME);
      storedValue = await requestResult(store.get(userId));
    } catch {}
    const current = storedValue || memoryValue;
    let updated = null;
    if (current && (!expectedOperationId || current.operationId === expectedOperationId)) {
      updated = updater(current) || current;
      memoryFallback.set(userId, updated);
      store?.put(updated);
    }
    if (transaction) {
      try {
        await transactionComplete(transaction);
        if (updated) memoryFallback.delete(userId);
      } catch {}
    }
    return updated;
  }

  function markRetry(userId, expectedOperationId, attempts, nextAttemptAt, errorMessage) {
    return updateMatching(userId, expectedOperationId, (operation) => ({
      ...operation,
      attempts,
      nextAttemptAt,
      lastError: String(errorMessage || "").slice(0, 500),
    }));
  }

  function rebase(userId, expectedOperationId, expectedRevision) {
    return updateMatching(userId, expectedOperationId, (operation) => ({
      ...operation,
      expectedRevision: Number.isInteger(expectedRevision) ? expectedRevision : null,
      attempts: 0,
      nextAttemptAt: 0,
      lastError: "",
    }));
  }

  async function remove(userId, expectedOperationId) {
    let database;
    let transaction;
    let store;
    let storedValue = null;
    try {
      database = await openDatabase();
      transaction = database.transaction(STORE_NAME, "readwrite");
      store = transaction.objectStore(STORE_NAME);
      storedValue = await requestResult(store.get(userId));
    } catch {}
    const current = storedValue || memoryFallback.get(userId) || null;
    const removed = Boolean(current && (!expectedOperationId || current.operationId === expectedOperationId));
    if (removed) {
      memoryFallback.delete(userId);
      store?.delete(userId);
    }
    if (transaction) {
      try {
        await transactionComplete(transaction);
      } catch {}
    }
    return removed;
  }

  async function has(userId) {
    return Boolean(await read(userId));
  }

  window.invoiceDraftOutbox = Object.freeze({
    get: read,
    has,
    putSave,
    putDelete,
    markRetry,
    rebase,
    remove,
  });
}());
