const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createServer } = require("node:http");
const { mkdtemp, readFile, rm, stat } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { extname, join, normalize } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const ROOT = join(__dirname, "..");
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);
const TYPES = {
  ".css": "text/css",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

function startServer() {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://localhost").pathname;
      const relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
      const filePath = normalize(join(ROOT, relativePath));
      if (!filePath.startsWith(ROOT)) throw new Error("Invalid path");
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error("Not a file");
      response.setHeader("Content-Type", TYPES[extname(filePath)] || "application/octet-stream");
      response.end(await readFile(filePath));
    } catch {
      response.statusCode = 404;
      response.end("Not found");
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function connectCdp(url) {
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const callback = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) callback.reject(new Error(message.error.message));
    else callback.resolve(message.result);
  });
  return new Promise((resolve, reject) => {
    socket.addEventListener("error", reject, { once: true });
    socket.addEventListener("open", () => resolve({
      close: () => socket.close(),
      send(method, params = {}) {
        const id = ++nextId;
        socket.send(JSON.stringify({ id, method, params }));
        return new Promise((resolveCommand, rejectCommand) => {
          pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
        });
      },
    }), { once: true });
  });
}

async function waitFor(check, timeout = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for browser state");
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

test("invoice editor behavior, responsive layout, draft, print, and offline shell", async (context) => {
  let chromePath;
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await stat(candidate);
      chromePath = candidate;
      break;
    } catch {
      // Try the next common browser path.
    }
  }
  if (!chromePath) return context.skip("Set CHROME_PATH to run browser coverage");

  const server = await startServer();
  const address = server.address();
  const appUrl = `http://127.0.0.1:${address.port}/`;
  const profile = await mkdtemp(join(tmpdir(), "invoice-studio-test-"));
  const chrome = spawn(chromePath, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--disable-gpu",
    appUrl,
  ], { stdio: ["ignore", "ignore", "pipe"] });

  context.after(async () => {
    chrome.kill();
    server.close();
    await Promise.race([
      new Promise((resolve) => chrome.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
    await rm(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  });

  let debugOutput = "";
  chrome.stderr.setEncoding("utf8");
  chrome.stderr.on("data", (chunk) => { debugOutput += chunk; });
  const browserSocket = await waitFor(() => debugOutput.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1]);
  const browser = await connectCdp(browserSocket);
  context.after(() => browser.close());

  const targets = await browser.send("Target.getTargets");
  const target = await waitFor(() => targets.targetInfos.find((candidate) => candidate.type === "page" && candidate.url === appUrl));
  const response = await fetch(`http://127.0.0.1:${new URL(browserSocket).port}/json/list`);
  const pages = await response.json();
  const page = await connectCdp(pages.find((candidate) => candidate.id === target.targetId).webSocketDebuggerUrl);
  context.after(() => page.close());
  await page.send("Runtime.enable");
  await waitFor(() => evaluate(page, "document.readyState === 'complete' && document.querySelectorAll('.item-row').length === 1"));

  await evaluate(page, "localStorage.clear(); location.reload(); true");
  await waitFor(() => evaluate(page, "document.readyState === 'complete' && document.querySelectorAll('.item-row').length === 1"));
  const cleanDraft = await evaluate(page, `JSON.stringify({
    invoiceNumber: document.querySelector('#invoiceNumber').value,
    invoiceDate: document.querySelector('#invoiceDate').value,
    dueDate: document.querySelector('#dueDate').value,
    billTo: document.querySelector('#billTo').value,
    description: document.querySelector('[data-item-field="description"]').value,
    price: document.querySelector('[data-item-field="price"]').value
  })`);
  const initial = JSON.parse(cleanDraft);
  assert.match(initial.invoiceNumber, /^EHR-\d{8}-001$/);
  assert.match(initial.invoiceDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(initial.dueDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual({ billTo: initial.billTo, description: initial.description, price: initial.price }, { billTo: "", description: "", price: "" });

  for (const width of [320, 375, 390, 768, 1440]) {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const layout = await evaluate(page, `JSON.stringify({
      viewport: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      button: (() => { const r = document.querySelector('.remove-item').getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; })(),
      label: document.querySelector('.remove-item').getAttribute('aria-label')
    })`);
    const measured = JSON.parse(layout);
    assert.ok(measured.documentWidth <= measured.viewport, `${width}px layout must not overflow`);
    assert.ok(measured.button.left >= 0 && measured.button.right <= measured.viewport && measured.button.width <= 44.1);
    assert.equal(measured.label, "Remove item 1");
  }

  await evaluate(page, `(() => {
    for (let index = 0; index < 4; index += 1) document.querySelector('#addItemButton').click();
  })()`);
  assert.deepEqual(JSON.parse(await evaluate(page, `JSON.stringify({ rows: document.querySelectorAll('.item-row').length, disabled: document.querySelector('#addItemButton').disabled })`)), { rows: 5, disabled: true });

  await evaluate(page, `(() => {
    document.querySelectorAll('.remove-item')[1].click();
    const quantity = document.querySelector('[data-item-field="quantity"]');
    const price = document.querySelector('[data-item-field="price"]');
    quantity.value = '2.8'; quantity.dispatchEvent(new Event('input', { bubbles: true }));
    price.value = '10.50'; price.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const itemState = JSON.parse(await evaluate(page, `JSON.stringify({
    rows: document.querySelectorAll('.item-row').length,
    quantity: document.querySelector('[data-item-field="quantity"]').value,
    quantityValid: document.querySelector('[data-item-field="quantity"]').validity.valid,
    total: document.querySelector('#editorTotal').textContent,
    focused: document.activeElement.dataset.itemField,
    toast: document.querySelector('#toast').textContent
  })`));
  assert.deepEqual(itemState, { rows: 4, quantity: "2.8", quantityValid: false, total: "$29.40", focused: "description", toast: "Item 2 removed. 4 items remaining." });

  const blankArrowQuantity = await evaluate(page, `(() => {
    const quantity = document.querySelector('[data-item-field="quantity"]');
    quantity.value = '';
    quantity.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    return quantity.value;
  })()`);
  assert.equal(blankArrowQuantity, "1");

  const longDescriptionFits = await evaluate(page, `(() => {
    const description = document.querySelector('[data-item-field="description"]');
    description.value = 'X'.repeat(500);
    description.dispatchEvent(new Event('input', { bubbles: true }));
    return document.querySelector('#invoiceSheet').scrollWidth <= ${793.7 + 2};
  })()`);
  assert.equal(longDescriptionFits, true);

  await evaluate(page, `(() => {
    const billTo = document.querySelector('#billTo');
    const quantity = document.querySelector('[data-item-field="quantity"]');
    const description = document.querySelector('[data-item-field="description"]');
    billTo.value = 'Immediate reload customer';
    billTo.dispatchEvent(new Event('input', { bubbles: true }));
    quantity.value = '3'; quantity.dispatchEvent(new Event('input', { bubbles: true }));
    description.value = 'Service'; description.dispatchEvent(new Event('input', { bubbles: true }));
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    location.reload();
  })()`);
  await waitFor(() => evaluate(page, "document.readyState === 'complete' && document.querySelector('#billTo').value === 'Immediate reload customer'"));

  await new Promise((resolve) => setTimeout(resolve, 300));
  await evaluate(page, "location.reload(); true");
  await waitFor(() => evaluate(page, "document.readyState === 'complete' && document.querySelectorAll('.item-row').length === 4"));
  assert.equal(await evaluate(page, "document.querySelector('#editorTotal').textContent"), "$31.50");

  await evaluate(page, `(() => {
    window.confirm = () => true;
    document.querySelector('#clearDraftButton').click();
  })()`);
  assert.equal(await evaluate(page, "localStorage.getItem('invoice-studio-draft-v1')"), null);
  assert.match(await evaluate(page, "document.querySelector('#invoiceNumber').value"), /^EHR-\d{8}-\d{3,}$/);
  await evaluate(page, "window.dispatchEvent(new PageTransitionEvent('pagehide'))");
  assert.equal(await evaluate(page, "localStorage.getItem('invoice-studio-draft-v1')"), null);

  const newInvoiceProtection = JSON.parse(await evaluate(page, `(() => {
    const billTo = document.querySelector('#billTo');
    billTo.value = 'Keep me'; billTo.dispatchEvent(new Event('input', { bubbles: true }));
    const before = document.querySelector('#invoiceNumber').value;
    window.confirm = () => false;
    document.querySelector('#newInvoiceButton').click();
    const cancelled = { number: document.querySelector('#invoiceNumber').value, billTo: billTo.value };
    window.confirm = () => true;
    document.querySelector('#newInvoiceButton').click();
    return JSON.stringify({ before, cancelled, after: document.querySelector('#invoiceNumber').value, billToAfter: document.querySelector('#billTo').value });
  })()`));
  assert.deepEqual(newInvoiceProtection.cancelled, { number: newInvoiceProtection.before, billTo: "Keep me" });
  assert.notEqual(newInvoiceProtection.after, newInvoiceProtection.before);
  assert.equal(newInvoiceProtection.billToAfter, "");
  const followingInvoiceNumber = await evaluate(page, `(() => {
    document.querySelector('#newInvoiceButton').click();
    return document.querySelector('#invoiceNumber').value;
  })()`);
  assert.notEqual(followingInvoiceNumber, newInvoiceProtection.after);

  const validation = JSON.parse(await evaluate(page, `(() => {
    for (const id of ['invoiceNumber', 'invoiceDate', 'dueDate']) {
      const input = document.querySelector('#' + id); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    document.querySelector('#printButton').click();
    const invalid = [...document.querySelectorAll('[aria-invalid="true"]')];
    return JSON.stringify({ count: invalid.length, linked: invalid.every(input => input.getAttribute('aria-describedby').split(/\\s+/).some(id => document.getElementById(id)?.classList.contains('field-error'))) });
  })()`));
  assert.deepEqual(validation, { count: 6, linked: true });
  const repeatedValidation = JSON.parse(await evaluate(page, `(() => {
    const invoiceNumber = document.querySelector('#invoiceNumber');
    invoiceNumber.value = 'INV-1'; invoiceNumber.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#printButton').click();
    document.querySelector('#printButton').click();
    const ids = [...document.querySelectorAll('.field-error')].map(error => error.id);
    return JSON.stringify({ total: ids.length, unique: new Set(ids).size });
  })()`));
  assert.equal(repeatedValidation.total, repeatedValidation.unique);

  const overflowBlocked = JSON.parse(await evaluate(page, `(() => {
    const quantity = document.querySelector('[data-item-field="quantity"]');
    const price = document.querySelector('[data-item-field="price"]');
    quantity.value = '2'; quantity.dispatchEvent(new Event('input', { bubbles: true }));
    price.value = '1e308'; price.dispatchEvent(new Event('input', { bubbles: true }));
    window.__prints = 0; window.print = () => { window.__prints += 1; };
    document.querySelector('#printButton').click();
    return JSON.stringify({ prints: window.__prints, total: document.querySelector('#editorTotal').textContent, invalid: price.getAttribute('aria-invalid') });
  })()`));
  assert.deepEqual(overflowBlocked, { prints: 0, total: "$—", invalid: "true" });

  const printCount = await evaluate(page, `(() => {
    window.__prints = 0; window.print = () => { window.__prints += 1; };
    const values = { invoiceNumber: 'INV-1', invoiceDate: '2026-08-13', dueDate: '2026-08-20', billTo: 'Customer' };
    for (const [id, value] of Object.entries(values)) { const input = document.querySelector('#' + id); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }
    const description = document.querySelector('[data-item-field="description"]'); description.value = 'Service'; description.dispatchEvent(new Event('input', { bubbles: true }));
    const price = document.querySelector('[data-item-field="price"]'); price.value = '25'; price.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#printButton').click();
    return JSON.stringify({ prints: window.__prints, invalid: document.querySelectorAll('[aria-invalid="true"]').length });
  })()`);
  assert.deepEqual(JSON.parse(printCount), { prints: 1, invalid: 0 });

  const cacheReady = await waitFor(() => evaluate(page, "caches.keys().then(keys => keys.includes('invoice-studio-v12'))"));
  assert.equal(cacheReady, true);
  const workerSource = await readFile(join(ROOT, "sw.js"), "utf8");
  const handlers = {};
  const deletedCaches = [];
  const cacheKeys = ["invoice-studio-v1", "invoice-studio-v12", "unrelated-app-cache"];
  const workerContext = {
    URL,
    Response,
    caches: {
      keys: async () => cacheKeys,
      delete: async (key) => { deletedCaches.push(key); return true; },
    },
    self: {
      addEventListener: (name, handler) => { handlers[name] = handler; },
      clients: { claim: async () => {} },
      skipWaiting: () => {},
    },
  };
  vm.runInNewContext(workerSource, workerContext);
  let activation;
  handlers.activate({ waitUntil: (promise) => { activation = promise; } });
  await activation;
  assert.deepEqual(deletedCaches, ["invoice-studio-v1"]);

  if (!await evaluate(page, "Boolean(navigator.serviceWorker.controller)")) {
    await page.send("Page.reload", { ignoreCache: true });
    await waitFor(() => evaluate(page, "document.readyState === 'complete' && Boolean(navigator.serviceWorker.controller)"));
  }
  assert.equal(await evaluate(page, "Boolean(navigator.serviceWorker.controller)"), true);
  await page.send("Network.enable");
  await page.send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
    connectionType: "none",
  });
  await evaluate(page, "window.__offlineReloadMarker = 'before'");
  await new Promise((resolve) => server.close(resolve));
  await page.send("Page.reload", { ignoreCache: true });
  await waitFor(() => evaluate(page, "document.readyState === 'complete' && document.querySelector('#invoiceForm') !== null"), 8000);
  assert.equal(await evaluate(page, "typeof window.__offlineReloadMarker"), "undefined");
  await page.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
    connectionType: "none",
  });
});
