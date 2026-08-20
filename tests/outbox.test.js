"use strict";

const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const ROOT = join(__dirname, "..");

class EventSource {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(name, callback, options = {}) {
    const listeners = this.listeners.get(name) || [];
    listeners.push({ callback, once: Boolean(options.once) });
    this.listeners.set(name, listeners);
  }

  dispatch(name) {
    const listeners = this.listeners.get(name) || [];
    this.listeners.set(name, listeners.filter((listener) => !listener.once));
    listeners.forEach((listener) => listener.callback({ target: this }));
  }
}

function createIndexedDb() {
  const stores = new Map();
  const database = {
    objectStoreNames: { contains: (name) => stores.has(name) },
    createObjectStore(name) {
      stores.set(name, new Map());
    },
    addEventListener() {},
    close() {},
    transaction(name) {
      const transaction = new EventSource();
      transaction.error = null;
      transaction.objectStore = () => {
        const values = stores.get(name);
        const makeRequest = (action) => {
          const request = new EventSource();
          queueMicrotask(() => {
            try {
              request.result = action();
              request.dispatch("success");
            } catch (error) {
              request.error = error;
              request.dispatch("error");
            }
          });
          return request;
        };
        return {
          get(key) {
            return makeRequest(() => structuredClone(values.get(key)));
          },
          put(value) {
            const request = makeRequest(() => {
              values.set(value.userId, structuredClone(value));
              return value.userId;
            });
            return request;
          },
          delete(key) {
            return makeRequest(() => values.delete(key));
          },
        };
      };
      setTimeout(() => transaction.dispatch("complete"), 5);
      return transaction;
    },
  };

  return {
    open() {
      const request = new EventSource();
      queueMicrotask(() => {
        request.result = database;
        request.dispatch("upgradeneeded");
        request.dispatch("success");
      });
      return request;
    },
  };
}

async function loadOutbox(indexedDb = createIndexedDb()) {
  const source = await readFile(join(ROOT, "outbox.js"), "utf8");
  const window = {};
  vm.runInNewContext(source, {
    window,
    indexedDB: indexedDb,
    crypto: webcrypto,
    Date,
    Math,
    Promise,
    structuredClone,
    setTimeout,
  });
  return window.invoiceDraftOutbox;
}

test("draft outbox keeps the newest per-user operation until matching removal", async () => {
  const indexedDb = createIndexedDb();
  const outbox = await loadOutbox(indexedDb);
  const first = await outbox.putSave("user-1", { invoiceNumber: "INV-1" }, 2);
  const second = await outbox.putSave("user-1", { invoiceNumber: "INV-2" }, 2);
  await outbox.putDelete("user-2", 4);

  const recoveredOutbox = await loadOutbox(indexedDb);
  assert.equal((await recoveredOutbox.get("user-1")).invoice.invoiceNumber, "INV-2");
  assert.equal(await outbox.remove("user-1", first.operationId), false);
  assert.equal(await outbox.has("user-1"), true);
  assert.equal((await outbox.get("user-2")).type, "delete");
  assert.equal(await outbox.remove("user-1", second.operationId), true);
  assert.equal(await outbox.has("user-1"), false);
});

test("draft outbox persists retry metadata and can rebase after an explicit conflict choice", async () => {
  const outbox = await loadOutbox();
  const operation = await outbox.putSave("user-1", { invoiceNumber: "INV-3" });
  await outbox.markRetry("user-1", operation.operationId, 3, 12345, "offline");
  const retry = await outbox.get("user-1");
  assert.deepEqual(
    { attempts: retry.attempts, nextAttemptAt: retry.nextAttemptAt, lastError: retry.lastError },
    { attempts: 3, nextAttemptAt: 12345, lastError: "offline" },
  );

  await outbox.rebase("user-1", operation.operationId, 9);
  const rebased = await outbox.get("user-1");
  assert.deepEqual(
    { expectedRevision: rebased.expectedRevision, attempts: rebased.attempts, nextAttemptAt: rebased.nextAttemptAt },
    { expectedRevision: 9, attempts: 0, nextAttemptAt: 0 },
  );
});

test("draft outbox keeps a session fallback when IndexedDB is unavailable", async () => {
  const outbox = await loadOutbox({
    open() {
      throw new Error("IndexedDB denied");
    },
  });
  const operation = await outbox.putSave("user-1", { invoiceNumber: "INV-FALLBACK" });
  assert.equal(operation.storage, "memory");
  assert.equal((await outbox.get("user-1")).storage, "memory");
  assert.equal((await outbox.get("user-1")).operationId, operation.operationId);
  assert.equal(await outbox.has("user-1"), true);
  assert.equal(await outbox.remove("user-1", operation.operationId), true);
  assert.equal(await outbox.has("user-1"), false);
});
