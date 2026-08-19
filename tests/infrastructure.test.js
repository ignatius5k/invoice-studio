"use strict";

const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = join(__dirname, "..");
const SCOPE = "https://example.test/invoice-studio/";

async function loadWorker(initialFetch = async () => new Response("network")) {
  const source = await readFile(join(ROOT, "sw.js"), "utf8");
  const handlers = {};
  const stores = new Map();
  const deletedCaches = [];
  const cachePuts = [];
  const cacheAdditions = [];
  let skipWaitingCalls = 0;
  let clientsClaimed = 0;
  let fetchImplementation = initialFetch;

  function requestKey(request) {
    return typeof request === "string" ? new URL(request, SCOPE).href : request.url;
  }

  function cacheFor(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return {
      async addAll(entries) {
        cacheAdditions.push(...entries);
      },
      async match(request) {
        return store.get(requestKey(request));
      },
      async put(request, response) {
        const key = requestKey(request);
        cachePuts.push({ cacheName: name, key });
        store.set(key, response);
      },
    };
  }

  const context = {
    URL,
    Response,
    caches: {
      async open(name) {
        return cacheFor(name);
      },
      async keys() {
        return [...stores.keys()];
      },
      async delete(name) {
        deletedCaches.push(name);
        return stores.delete(name);
      },
    },
    fetch: (...args) => fetchImplementation(...args),
    self: {
      location: new URL(SCOPE),
      registration: { scope: SCOPE, active: {} },
      clients: { claim: async () => { clientsClaimed += 1; } },
      skipWaiting: () => { skipWaitingCalls += 1; },
      addEventListener(name, handler) {
        handlers[name] = handler;
      },
    },
  };
  vm.runInNewContext(source, context);

  return {
    handlers,
    stores,
    deletedCaches,
    cachePuts,
    cacheAdditions,
    setFetch(nextFetch) {
      fetchImplementation = nextFetch;
    },
    get skipWaitingCalls() {
      return skipWaitingCalls;
    },
    get clientsClaimed() {
      return clientsClaimed;
    },
  };
}

function dispatchFetch(handler, request) {
  const lifetime = [];
  let responsePromise;
  handler({
    request,
    respondWith(value) {
      responsePromise = Promise.resolve(value);
    },
    waitUntil(value) {
      lifetime.push(Promise.resolve(value));
    },
  });
  return {
    lifetime,
    response: () => responsePromise,
  };
}

test("service-worker updates wait for an explicit activation request", async () => {
  const worker = await loadWorker();
  let installation;
  worker.handlers.install({ waitUntil(value) { installation = value; } });
  await installation;
  assert.equal(worker.skipWaitingCalls, 0);
  assert.ok(worker.cacheAdditions.includes("./index.html"));

  worker.handlers.message({ data: { type: "SKIP_WAITING" } });
  assert.equal(worker.skipWaitingCalls, 1);
});

test("activation removes only previous Invoice Studio caches", async () => {
  const worker = await loadWorker();
  worker.stores.set("invoice-studio-v1", new Map());
  worker.stores.set("invoice-studio-v27", new Map());
  worker.stores.set("invoice-studio-v28", new Map());
  worker.stores.set("invoice-studio-v29", new Map());
  worker.stores.set("unrelated-cache", new Map());
  let activation;
  worker.handlers.activate({ waitUntil(value) { activation = value; } });
  await activation;
  assert.deepEqual(worker.deletedCaches, ["invoice-studio-v1", "invoice-studio-v27", "invoice-studio-v28"]);
  assert.equal(worker.clientsClaimed, 1);
  assert.equal(worker.stores.has("unrelated-cache"), true);
});

test("query-string navigations are network-only and never cached", async () => {
  const worker = await loadWorker(async () => new Response("callback"));
  const event = dispatchFetch(worker.handlers.fetch, {
    method: "GET",
    mode: "navigate",
    url: `${SCOPE}?code=authentication-code`,
  });
  assert.equal(await (await event.response()).text(), "callback");
  assert.equal(event.lifetime.length, 0);
  assert.deepEqual(worker.cachePuts, []);
});

test("only named-cache shell requests are cached and used offline", async () => {
  const shellUrl = `${SCOPE}app.js?v=29`;
  const worker = await loadWorker(async () => new Response("fresh shell"));
  const onlineEvent = dispatchFetch(worker.handlers.fetch, {
    method: "GET",
    mode: "same-origin",
    url: shellUrl,
  });
  assert.equal(await (await onlineEvent.response()).text(), "fresh shell");
  await Promise.all(onlineEvent.lifetime);
  assert.deepEqual(worker.cachePuts, [{ cacheName: "invoice-studio-v29", key: shellUrl }]);

  worker.setFetch(async () => { throw new Error("offline"); });
  const offlineEvent = dispatchFetch(worker.handlers.fetch, {
    method: "GET",
    mode: "same-origin",
    url: shellUrl,
  });
  assert.equal(await (await offlineEvent.response()).text(), "fresh shell");

  const unknownEvent = dispatchFetch(worker.handlers.fetch, {
    method: "GET",
    mode: "same-origin",
    url: `${SCOPE}not-in-shell.json`,
  });
  assert.equal(unknownEvent.response(), undefined);
});

test("temporary guest mode skips Auth and persists revision-safe local invoices and drafts", async () => {
  const source = await readFile(join(ROOT, "backend.js"), "utf8");
  const values = new Map();
  const localStorage = {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
  };
  const window = {
    INVOICE_STUDIO_FEATURES: { temporaryGuestMode: true },
    localStorage,
  };
  vm.runInNewContext(source, { window });
  const backend = window.invoiceBackend;

  assert.equal(backend.configured, true);
  assert.equal(backend.guestMode, true);
  assert.equal((await backend.getSession()).user.id, "local-guest");

  const invoice = {
    invoiceNumber: "EHR-20260819-001",
    pdfFileName: "EHR-20260819-001",
    invoiceDate: "2026-08-19",
    dueDate: "2026-08-26",
    billTo: "Guest customer",
    items: [{ id: "item-1", quantity: 1, description: "Market space", price: 100 }],
  };
  const saved = await backend.saveInvoice("local-guest", {
    id: "invoice-1",
    createdAt: "2026-08-19T00:00:00.000Z",
    invoice,
  });
  assert.equal(saved.revision, 1);
  const updated = await backend.saveInvoice("local-guest", {
    ...saved,
    invoice: { ...saved.invoice, billTo: "Updated customer" },
  });
  assert.equal(updated.revision, 2);
  await assert.rejects(
    backend.saveInvoice("local-guest", saved),
    (error) => error.code === "INVOICE_REVISION_CONFLICT",
  );
  const page = await backend.listInvoices("local-guest", { query: "updated" });
  assert.equal(page.total, 1);
  assert.equal(page.records[0].invoice.billTo, "Updated customer");

  const firstDraft = await backend.saveDraft("local-guest", invoice);
  assert.equal(firstDraft.revision, 1);
  const loadedDraft = await backend.loadDraft("local-guest");
  assert.equal(loadedDraft.invoice.invoiceNumber, invoice.invoiceNumber);
  const secondDraft = await backend.saveDraft("local-guest", { ...invoice, billTo: "Draft update" }, undefined, 1);
  assert.equal(secondDraft.revision, 2);
  await assert.rejects(
    backend.saveDraft("local-guest", invoice, undefined, 1),
    (error) => error.code === "DRAFT_REVISION_CONFLICT",
  );
  await backend.deleteDraft("local-guest", undefined, 2);
  assert.equal(await backend.loadDraft("local-guest"), null);

  const invoiceNumber = await backend.nextInvoiceNumber("2026-08-19");
  assert.equal(invoiceNumber, "EHR-20260819-002");
});
