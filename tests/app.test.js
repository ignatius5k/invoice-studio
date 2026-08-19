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
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
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

async function findChromePath() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // Try the next common browser path.
    }
  }
  return undefined;
}

test("temporary guest mode opens the local workspace without showing login", async (context) => {
  const chromePath = await findChromePath();
  if (!chromePath) return context.skip("Set CHROME_PATH to run browser coverage");

  const server = await startServer();
  const address = server.address();
  const appUrl = `http://127.0.0.1:${address.port}/`;
  const profile = await mkdtemp(join(tmpdir(), "invoice-studio-guest-test-"));
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
  const response = await fetch(`http://127.0.0.1:${new URL(browserSocket).port}/json/list`);
  const pages = await response.json();
  const pageTarget = await waitFor(() => pages.find((candidate) => candidate.type === "page" && candidate.url === appUrl));
  const page = await connectCdp(pageTarget.webSocketDebuggerUrl);
  context.after(() => page.close());
  await page.send("Runtime.enable");
  await page.send("Page.enable");
  await waitFor(() => evaluate(page, "document.readyState === 'complete' && document.body.dataset.page === 'history'"));

  const state = JSON.parse(await evaluate(page, `JSON.stringify({
    guestMode: window.invoiceBackend.guestMode,
    authHidden: document.querySelector('#authPage').hidden,
    historyVisible: !document.querySelector('#invoiceListPage').hidden,
    accountLabel: document.querySelector('#accountEmail').textContent,
    signOutHidden: document.querySelector('#signOutButton').hidden,
    syncStatus: document.querySelector('#syncStatus').textContent,
    storageNote: document.querySelector('.history-storage-note').textContent
  })`));
  assert.deepEqual(state, {
    guestMode: true,
    authHidden: true,
    historyVisible: true,
    accountLabel: "Local guest",
    signOutHidden: true,
    syncStatus: "Saved on this device",
    storageNote: "Temporary guest mode: invoices and drafts stay in this browser and are not synced to another device.",
  });
});

test("invoice editor behavior, responsive layout, draft, print, and offline shell", async (context) => {
  const chromePath = await findChromePath();
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
  await page.send("Page.enable");
  const backendMock = await readFile(join(ROOT, "tests", "browser-backend-mock.js"), "utf8");
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: backendMock });
  await evaluate(page, "localStorage.clear(); true");
  await page.send("Page.reload", { ignoreCache: true });
  await waitFor(() => evaluate(page, "document.readyState === 'complete' && document.body.dataset.page === 'history' && document.querySelectorAll('.item-row').length === 1"), 8000);

  await evaluate(page, "localStorage.clear(); location.reload(); true");
  await waitFor(() => evaluate(page, "document.readyState === 'complete' && document.body.dataset.page === 'history' && document.querySelectorAll('.item-row').length === 1"), 8000);
  const landingState = JSON.parse(await evaluate(page, `JSON.stringify({
    page: document.body.dataset.page,
    historyVisible: !document.querySelector('#invoiceListPage').hidden,
    editorHidden: document.querySelector('#editorPage').hidden,
    emptyState: !document.querySelector('#historyEmptyState').hidden,
    count: document.querySelector('#invoiceCount').textContent,
    createActions: ['newInvoiceButton', 'historyNewInvoiceButton', 'emptyStateNewInvoiceButton']
      .filter(id => document.getElementById(id).getClientRects().length > 0).length
  })`));
  assert.deepEqual(landingState, { page: "history", historyVisible: true, editorHidden: true, emptyState: true, count: "0 invoices", createActions: 1 });
  for (const width of [320, 390, 700, 1000, 1440]) {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    const historyLayout = JSON.parse(await evaluate(page, `JSON.stringify({
      viewport: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      page: (() => { const rect = document.querySelector('#invoiceListPage').getBoundingClientRect(); return { left: rect.left, right: rect.right }; })(),
      empty: (() => { const rect = document.querySelector('#historyEmptyState').getBoundingClientRect(); return { left: rect.left, right: rect.right }; })()
    })`));
    assert.ok(historyLayout.documentWidth <= historyLayout.viewport, `${width}px history must not overflow`);
    assert.ok(historyLayout.page.left >= 0 && historyLayout.page.right <= historyLayout.viewport, `${width}px history page bounds`);
    assert.ok(historyLayout.empty.left >= 0 && historyLayout.empty.right <= historyLayout.viewport, `${width}px empty state bounds`);
  }
  await evaluate(page, "document.querySelector('#historyNewInvoiceButton').click(); true");
  await waitFor(() => evaluate(page, "document.body.dataset.page === 'editor' && !document.querySelector('#editorPage').hidden"));
  const backNavigation = JSON.parse(await evaluate(page, `JSON.stringify({
    label: document.querySelector('#invoiceListButton').textContent,
    afterInstall: Boolean(document.querySelector('#installButton').compareDocumentPosition(document.querySelector('#invoiceListButton')) & Node.DOCUMENT_POSITION_FOLLOWING)
  })`));
  assert.deepEqual(backNavigation, { label: "Back", afterInstall: true });
  const cleanDraft = await evaluate(page, `JSON.stringify({
    invoiceNumber: document.querySelector('#invoiceNumber').value,
    pdfFileName: document.querySelector('#pdfFileName').value,
    invoiceDate: document.querySelector('#invoiceDate').value,
    dueDate: document.querySelector('#dueDate').value,
    billTo: document.querySelector('#billTo').value,
    description: document.querySelector('[data-item-field="description"]').value,
    price: document.querySelector('[data-item-field="price"]').value
  })`);
  const initial = JSON.parse(cleanDraft);
  assert.match(initial.invoiceNumber, /^EHR-\d{8}-001$/);
  assert.equal(initial.pdfFileName, initial.invoiceNumber);
  assert.match(initial.invoiceDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(initial.dueDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual({ billTo: initial.billTo, description: initial.description, price: initial.price }, { billTo: "", description: "", price: "" });

  const semantics = JSON.parse(await evaluate(page, `JSON.stringify({
    legends: [...document.querySelectorAll('fieldset')].map(fieldset => ({
      direct: [...fieldset.children].filter(child => child.tagName === 'LEGEND').length,
      first: fieldset.firstElementChild?.tagName,
      text: fieldset.querySelector(':scope > legend')?.textContent.trim(),
      plain: [...fieldset.querySelector(':scope > legend')?.childNodes || []].every(node => node.nodeType === Node.TEXT_NODE)
    })),
    productsName: document.querySelector('.items-section > legend')?.textContent,
    itemColumns: [...document.querySelectorAll('.item-column-labels span')].map(label => label.textContent),
    detachedCurrencyLabels: document.querySelectorAll('.currency-label').length,
    addHelp: document.querySelector('#addItemButton').getAttribute('aria-describedby'),
    addHelpText: document.querySelector('#itemLimitHelp').textContent,
    totalAtomic: document.querySelector('.editor-total').getAttribute('aria-atomic'),
    placeholders: document.querySelectorAll('[placeholder]').length
  })`));
  assert.ok(semantics.legends.every((legend) => legend.direct === 1 && legend.first === "LEGEND" && legend.plain));
  assert.equal(semantics.productsName, "Products / services");
  assert.deepEqual(semantics.itemColumns, ["Qty", "Item", "Unit price (SGD)", ""]);
  assert.equal(semantics.detachedCurrencyLabels, 0);
  assert.equal(semantics.addHelp, "itemLimitHelp");
  assert.match(semantics.addHelpText, /up to 5 items/i);
  assert.equal(semantics.totalAtomic, "true");
  assert.equal(semantics.placeholders, 0);

  const invoiceAlignment = JSON.parse(await evaluate(page, `(() => {
    const topSymbol = document.querySelector('#previewItems .amount-symbol').getBoundingClientRect();
    const totalSymbol = document.querySelector('.invoice-table tfoot td:first-of-type').getBoundingClientRect();
    const topValue = document.querySelector('#previewItems .amount-value').getBoundingClientRect();
    const totalValue = document.querySelector('#previewTotal').getBoundingClientRect();
    const totalLabel = document.querySelector('.invoice-table tfoot th').getBoundingClientRect();
    const logo = document.querySelector('.invoice-logo').getBoundingClientRect();
    const table = document.querySelector('.invoice-table').getBoundingClientRect();
    return JSON.stringify({
      symbolCenterDifference: Math.abs((topSymbol.left + topSymbol.width / 2) - (totalSymbol.left + totalSymbol.width / 2)),
      valueRightDifference: Math.abs(topValue.right - totalValue.right),
      totalLabelGap: totalSymbol.left - totalLabel.right,
      logoRightDifference: Math.abs(logo.right - table.right)
    });
  })()`));
  assert.ok(invoiceAlignment.symbolCenterDifference < 0.5);
  assert.ok(invoiceAlignment.valueRightDifference < 0.5);
  assert.ok(invoiceAlignment.totalLabelGap < 0.5);
  assert.ok(invoiceAlignment.logoRightDifference < 0.5);

  const filenameBehavior = JSON.parse(await evaluate(page, `(() => {
    const number = document.querySelector('#invoiceNumber');
    const filename = document.querySelector('#pdfFileName');
    number.value = 'inv-sync-1'; number.dispatchEvent(new Event('input', { bubbles: true }));
    const synced = filename.value;
    filename.value = 'Client custom'; filename.dispatchEvent(new Event('input', { bubbles: true }));
    number.value = 'inv-sync-2'; number.dispatchEvent(new Event('input', { bubbles: true }));
    return JSON.stringify({ number: number.value, synced, customized: filename.value, autocapitalize: number.autocapitalize, spellcheck: number.spellcheck });
  })()`));
  assert.deepEqual(filenameBehavior, { number: "INV-SYNC-2", synced: "INV-SYNC-1", customized: "Client custom", autocapitalize: "characters", spellcheck: false });

  for (const width of [320, 375, 390, 700, 701, 1024, 1080, 1081, 1200, 1201, 1280, 1440]) {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width < 500 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const layout = await evaluate(page, `JSON.stringify({
      viewport: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      button: (() => { const r = document.querySelector('.remove-item').getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; })(),
      label: document.querySelector('.remove-item').getAttribute('aria-label'),
      workspaceColumns: getComputedStyle(document.querySelector('.workspace')).gridTemplateColumns.split(' ').length,
      editorWidth: document.querySelector('.editor-panel').getBoundingClientRect().width,
      headingDirection: getComputedStyle(document.querySelector('.panel-heading')).flexDirection,
      headingGap: parseFloat(getComputedStyle(document.querySelector('.panel-heading')).rowGap),
      previewJumpVisible: getComputedStyle(document.querySelector('#mobileViewPreviewButton')).display !== 'none',
      mobileActionsVisible: getComputedStyle(document.querySelector('.mobile-output-action')).display !== 'none',
      mobileLabels: [...document.querySelectorAll('.mobile-field-label')].map(label => ({
        text: label.textContent,
        visible: getComputedStyle(label).display !== 'none',
        target: document.getElementById(label.htmlFor)?.dataset.itemField
      })),
      mobileItemGeometry: (() => {
        const fields = [...document.querySelectorAll('.item-row .mobile-field')].map(field => field.getBoundingClientRect());
        const removeButton = document.querySelector('.remove-item');
        const remove = removeButton.getBoundingClientRect();
        return { quantityTop: fields[0].top, descriptionTop: fields[1].top, priceTop: fields[2].top, removeTop: remove.top, removeVisible: removeButton.getClientRects().length > 0 };
      })(),
      columnLabelGeometry: (() => {
        const labels = document.querySelector('.item-column-labels');
        const rect = labels.getBoundingClientRect();
        const section = document.querySelector('.items-section').getBoundingClientRect();
        const labelLefts = [...labels.children].map(label => label.getBoundingClientRect().left);
        const fieldLefts = [...document.querySelectorAll('.item-row > *')].map(field => field.getBoundingClientRect().left);
        return { width: rect.width, left: rect.left, right: rect.right, sectionLeft: section.left, sectionRight: section.right, labelLefts, fieldLefts };
      })(),
      itemInside: (() => {
        const section = document.querySelector('.items-section').getBoundingClientRect();
        return [...document.querySelectorAll('.item-row')].every(row => {
          const rect = row.getBoundingClientRect();
          return rect.left >= section.left - 1 && rect.right <= section.right + 1;
        });
      })()
    })`);
    const measured = JSON.parse(layout);
    assert.ok(measured.documentWidth <= measured.viewport, `${width}px layout must not overflow`);
    if (measured.button.width > 0) assert.ok(measured.button.left >= 0 && measured.button.right <= measured.viewport && measured.button.width <= 44.1);
    assert.equal(measured.label, "Remove item 1");
    assert.equal(measured.workspaceColumns, width <= 1200 ? 1 : 2, `${width}px workspace column count`);
    assert.equal(measured.previewJumpVisible, width <= 1200, `${width}px preview jump visibility`);
    assert.equal(measured.mobileActionsVisible, width <= 767, `${width}px mobile output visibility`);
    if (width <= 1200) {
      assert.ok(measured.editorWidth <= 720.1, `${width}px editor should remain constrained`);
      assert.equal(measured.headingDirection, "column", `${width}px save status should group with heading`);
      assert.ok(measured.headingGap <= 8.1, `${width}px heading/save gap should remain close`);
    } else {
      assert.ok(measured.editorWidth >= 460, `${width}px split editor should remain usable`);
    }
    assert.equal(measured.itemInside, true, `${width}px item row must remain inside its section`);
    assert.deepEqual(measured.mobileLabels.map((label) => label.text), ["Quantity", "Item 1", "Unit price (SGD)"]);
    assert.ok(measured.mobileLabels.every((label) => label.target));
    assert.ok(measured.mobileLabels.every((label) => label.visible === (width <= 700)));
    if (width <= 700) {
      assert.ok(Math.abs(measured.mobileItemGeometry.quantityTop - measured.mobileItemGeometry.priceTop) < 1);
      assert.ok(measured.mobileItemGeometry.descriptionTop > measured.mobileItemGeometry.quantityTop);
      assert.equal(measured.mobileItemGeometry.removeVisible, false);
    } else {
      assert.ok(measured.columnLabelGeometry.width > 0, `${width}px item column labels need usable width`);
      assert.ok(measured.columnLabelGeometry.left >= measured.columnLabelGeometry.sectionLeft - 1);
      assert.ok(measured.columnLabelGeometry.right <= measured.columnLabelGeometry.sectionRight + 1);
      measured.columnLabelGeometry.labelLefts.forEach((left, index) => {
        assert.ok(Math.abs(left - measured.columnLabelGeometry.fieldLefts[index]) < 1, `${width}px item label ${index + 1} alignment`);
      });
    }
  }

  await page.send("Emulation.setDeviceMetricsOverride", { width: 701, height: 900, deviceScaleFactor: 1, mobile: false });
  const narrowHeader = JSON.parse(await evaluate(page, `(() => {
    const install = document.querySelector('#installButton');
    install.hidden = false;
    const header = document.querySelector('.app-header');
    const result = {
      fits: header.scrollWidth <= header.clientWidth,
      height: header.getBoundingClientRect().height,
      subtitleVisible: document.querySelector('.brand-subtitle').getClientRects().length > 0,
      desktopSaveVisible: document.querySelector('#printButton').getClientRects().length > 0,
      mobileSaveVisible: document.querySelector('#mobilePrintButton').getClientRects().length > 0
    };
    install.hidden = true;
    return JSON.stringify(result);
  })()`));
  assert.deepEqual(narrowHeader, { fits: true, height: 72, subtitleVisible: false, desktopSaveVisible: false, mobileSaveVisible: true });

  await page.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 640, deviceScaleFactor: 1, mobile: true });
  const previewClickStart = JSON.parse(await evaluate(page, `(() => {
    const button = document.querySelector('#mobileViewPreviewButton');
    button.scrollIntoView({ block: 'center' });
    window.__prints = 0;
    window.print = () => { window.__prints += 1; };
    const rect = button.getBoundingClientRect();
    return JSON.stringify({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, scrollY });
  })()`));
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: previewClickStart.x, y: previewClickStart.y, button: "left", clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: previewClickStart.x, y: previewClickStart.y, button: "left", clickCount: 1 });
  await waitFor(() => evaluate(page, `document.activeElement.id === 'preview-panel' && Math.abs(scrollY - ${previewClickStart.scrollY}) > 1 && document.querySelector('#preview-panel').getBoundingClientRect().top < innerHeight`));
  const previewNavigation = JSON.parse(await evaluate(page, `JSON.stringify({
    scrollY,
    prints: window.__prints,
    focused: document.activeElement.id,
    targetTop: document.querySelector('#preview-panel').getBoundingClientRect().top,
    targetVisible: (() => { const rect = document.querySelector('#preview-panel').getBoundingClientRect(); return rect.top < innerHeight && rect.bottom > 72; })(),
    outlineWidth: getComputedStyle(document.querySelector('#preview-panel')).outlineWidth,
    scrollMarginTop: getComputedStyle(document.querySelector('#preview-panel')).scrollMarginTop
  })`));
  assert.equal(previewNavigation.prints, 0);
  assert.equal(previewNavigation.focused, "preview-panel");
  assert.equal(previewNavigation.targetVisible, true);
  assert.ok(Math.abs(previewNavigation.scrollY - previewClickStart.scrollY) > 1);
  assert.equal(previewNavigation.outlineWidth, "3px");
  assert.equal(previewNavigation.scrollMarginTop, "72px");

  const previewInspection = JSON.parse(await evaluate(page, `(() => {
    const actual = document.querySelector('#actualSizePreviewButton');
    actual.click();
    const actualState = {
      transform: document.querySelector('#invoiceSheet').style.transform,
      pressed: actual.getAttribute('aria-pressed'),
      overflows: document.querySelector('#previewStage').scrollWidth > document.querySelector('#previewStage').clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      viewport: innerWidth
    };
    document.querySelector('#fitPreviewButton').click();
    const fitState = {
      transform: document.querySelector('#invoiceSheet').style.transform,
      pressed: document.querySelector('#fitPreviewButton').getAttribute('aria-pressed')
    };
    document.querySelector('#backToEditorButton').click();
    return JSON.stringify({ actualState, fitState, focused: document.activeElement.id });
  })()`));
  assert.equal(previewInspection.actualState.transform, "scale(1)");
  assert.equal(previewInspection.actualState.pressed, "true");
  assert.equal(previewInspection.actualState.overflows, true);
  assert.ok(previewInspection.actualState.documentWidth <= previewInspection.actualState.viewport);
  assert.notEqual(previewInspection.fitState.transform, "scale(1)");
  assert.equal(previewInspection.fitState.pressed, "true");
  assert.equal(previewInspection.focused, "editorTitle");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  await evaluate(page, `(() => {
    for (let index = 0; index < 4; index += 1) document.querySelector('#addItemButton').click();
  })()`);
  assert.deepEqual(JSON.parse(await evaluate(page, `JSON.stringify({ rows: document.querySelectorAll('.item-row').length, disabled: document.querySelector('#addItemButton').disabled, describedBy: document.querySelector('#addItemButton').getAttribute('aria-describedby') })`)), { rows: 5, disabled: true, describedBy: "itemLimitHelp" });

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

  const blankQuantityRerender = JSON.parse(await evaluate(page, `(() => {
    const quantity = document.querySelector('[data-item-field="quantity"]');
    quantity.value = '';
    quantity.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#addItemButton').click();
    document.querySelectorAll('.remove-item')[document.querySelectorAll('.remove-item').length - 1].click();
    const rerendered = document.querySelector('[data-item-field="quantity"]');
    document.querySelector('#printButton').click();
    const result = {
      value: rerendered.value,
      valid: rerendered.validity.valid,
      invalid: rerendered.getAttribute('aria-invalid'),
      total: document.querySelector('#editorTotal').textContent,
      dialogOpen: document.querySelector('#outputDialog').open
    };
    rerendered.value = '1';
    rerendered.dispatchEvent(new Event('input', { bubbles: true }));
    return JSON.stringify(result);
  })()`));
  assert.deepEqual(blankQuantityRerender, { value: "", valid: false, invalid: "true", total: "$0.00", dialogOpen: false });

  const longDescriptionFits = await evaluate(page, `(() => {
    const description = document.querySelector('[data-item-field="description"]');
    description.value = 'X'.repeat(500);
    description.dispatchEvent(new Event('input', { bubbles: true }));
    return document.querySelector('#invoiceSheet').scrollWidth <= ${793.7 + 2};
  })()`);
  assert.equal(longDescriptionFits, true);

  const multilineDescription = JSON.parse(await evaluate(page, `(() => {
    const description = document.querySelector('[data-item-field="description"]');
    description.value = 'First line\\nSecond line';
    description.dispatchEvent(new Event('input', { bubbles: true }));
    description.setSelectionRange(11, 22);
    description.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true }));
    const preview = document.querySelector('#previewItems td:nth-child(2)');
    return JSON.stringify({
      editorValue: description.value,
      text: preview.textContent,
      boldText: preview.querySelector('strong')?.textContent,
      shortcuts: description.getAttribute('aria-keyshortcuts'),
      whiteSpace: getComputedStyle(preview).whiteSpace,
      height: preview.scrollHeight
    });
  })()`));
  assert.equal(multilineDescription.editorValue, "First line\n**Second line**");
  assert.equal(multilineDescription.text, "First line\nSecond line");
  assert.equal(multilineDescription.boldText, "Second line");
  assert.equal(multilineDescription.shortcuts, "Control+B Meta+B");
  assert.equal(multilineDescription.whiteSpace, "pre-wrap");
  assert.ok(multilineDescription.height > 20, "two-line preview should be taller than one line");

  await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 760, deviceScaleFactor: 1, mobile: true });
  const touchBoldFormatting = JSON.parse(await evaluate(page, `(() => {
    const description = document.querySelector('[data-item-field="description"]');
    description.value = 'Touch selected text';
    description.dispatchEvent(new Event('input', { bubbles: true }));
    description.setSelectionRange(6, 14);
    document.querySelector('.item-format-button').click();
    return JSON.stringify({
      value: description.value,
      boldText: document.querySelector('#previewItems td:nth-child(2) strong')?.textContent,
      buttonVisible: document.querySelector('.item-format-button').getClientRects().length > 0,
      desktopHelpVisible: document.querySelector('.desktop-formatting-help').getClientRects().length > 0,
      mobileHelpVisible: document.querySelector('.mobile-formatting-help').getClientRects().length > 0
    });
  })()`));
  assert.deepEqual(touchBoldFormatting, { value: "Touch **selected** text", boldText: "selected", buttonVisible: true, desktopHelpVisible: false, mobileHelpVisible: true });
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

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
  await evaluate(page, "document.querySelector('#continueDraftButton').click(); true");
  assert.equal(await evaluate(page, "document.querySelector('#editorTotal').textContent"), "$31.50");
  const persistedCustomFilename = JSON.parse(await evaluate(page, `(() => {
    const filename = document.querySelector('#pdfFileName');
    const before = filename.value;
    const number = document.querySelector('#invoiceNumber');
    number.value = 'INV-AFTER-RELOAD'; number.dispatchEvent(new Event('input', { bubbles: true }));
    return JSON.stringify({ before, after: filename.value });
  })()`));
  assert.deepEqual(persistedCustomFilename, { before: "Client custom", after: "Client custom" });
  await evaluate(page, `(() => {
    const filename = document.querySelector('#pdfFileName');
    filename.value = ''; filename.dispatchEvent(new Event('input', { bubbles: true }));
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    location.reload();
  })()`);
  await waitFor(() => evaluate(page, "document.readyState === 'complete' && document.querySelector('#pdfFileName').value === document.querySelector('#invoiceNumber').value"));
  await evaluate(page, "document.querySelector('#continueDraftButton').click(); true");
  const clearedFilenameBehavior = JSON.parse(await evaluate(page, `(() => {
    const number = document.querySelector('#invoiceNumber');
    const filename = document.querySelector('#pdfFileName');
    const reset = filename.value;
    number.value = 'INV-CLEAR-SYNC'; number.dispatchEvent(new Event('input', { bubbles: true }));
    return JSON.stringify({ reset, numberBefore: 'INV-AFTER-RELOAD', synced: filename.value });
  })()`));
  assert.deepEqual(clearedFilenameBehavior, { reset: "INV-AFTER-RELOAD", numberBefore: "INV-AFTER-RELOAD", synced: "INV-CLEAR-SYNC" });

  await evaluate(page, `(async () => {
    window.confirm = () => true;
    const before = document.querySelector('#invoiceNumber').value;
    document.querySelector('#clearDraftButton').click();
    while (document.querySelector('#invoiceNumber').value === before) await new Promise(resolve => setTimeout(resolve, 0));
  })()`);
  assert.equal(await evaluate(page, "localStorage.getItem('test-supabase-draft')"), null);
  assert.match(await evaluate(page, "document.querySelector('#invoiceNumber').value"), /^EHR-\d{8}-\d{3,}$/);
  await evaluate(page, "window.dispatchEvent(new PageTransitionEvent('pagehide'))");
  assert.equal(await evaluate(page, "localStorage.getItem('test-supabase-draft')"), null);

  const metadataOnlyProtection = JSON.parse(await evaluate(page, `(async () => {
    const number = document.querySelector('#invoiceNumber');
    number.value = 'metadata-only';
    number.dispatchEvent(new Event('input', { bubbles: true }));
    let confirmations = 0;
    window.confirm = () => { confirmations += 1; return false; };
    document.querySelector('#newInvoiceButton').click();
    const result = { confirmations, number: number.value };
    window.confirm = () => true;
    document.querySelector('#newInvoiceButton').click();
    while (number.value === 'METADATA-ONLY') await new Promise(resolve => setTimeout(resolve, 0));
    return JSON.stringify(result);
  })()`));
  assert.deepEqual(metadataOnlyProtection, { confirmations: 1, number: "METADATA-ONLY" });

  const newInvoiceProtection = JSON.parse(await evaluate(page, `(async () => {
    const billTo = document.querySelector('#billTo');
    billTo.value = 'Keep me'; billTo.dispatchEvent(new Event('input', { bubbles: true }));
    const before = document.querySelector('#invoiceNumber').value;
    window.confirm = () => false;
    document.querySelector('#newInvoiceButton').click();
    const cancelled = { number: document.querySelector('#invoiceNumber').value, billTo: billTo.value };
    window.confirm = () => true;
    document.querySelector('#newInvoiceButton').click();
    while (document.querySelector('#invoiceNumber').value === before) await new Promise(resolve => setTimeout(resolve, 0));
    return JSON.stringify({ before, cancelled, after: document.querySelector('#invoiceNumber').value, pdfAfter: document.querySelector('#pdfFileName').value, billToAfter: document.querySelector('#billTo').value });
  })()`));
  assert.deepEqual(newInvoiceProtection.cancelled, { number: newInvoiceProtection.before, billTo: "Keep me" });
  assert.notEqual(newInvoiceProtection.after, newInvoiceProtection.before);
  assert.equal(newInvoiceProtection.pdfAfter, newInvoiceProtection.after);
  assert.equal(newInvoiceProtection.billToAfter, "");
  const followingInvoiceNumber = await evaluate(page, `(async () => {
    const before = document.querySelector('#invoiceNumber').value;
    document.querySelector('#newInvoiceButton').click();
    while (document.querySelector('#invoiceNumber').value === before) await new Promise(resolve => setTimeout(resolve, 0));
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
  const requiredDateRecovery = JSON.parse(await evaluate(page, `(() => {
    const invoiceDate = document.querySelector('#invoiceDate');
    const dueDate = document.querySelector('#dueDate');
    invoiceDate.value = '2026-08-20'; invoiceDate.dispatchEvent(new Event('input', { bubbles: true }));
    const afterInvoiceDate = {
      invoiceInvalid: invoiceDate.hasAttribute('aria-invalid'),
      invoiceError: Boolean(document.querySelector('#error-invoiceDate')),
      dueInvalid: dueDate.hasAttribute('aria-invalid'),
      dueError: Boolean(document.querySelector('#error-dueDate'))
    };
    dueDate.value = '2026-08-27'; dueDate.dispatchEvent(new Event('input', { bubbles: true }));
    const afterDueDate = {
      invoiceInvalid: invoiceDate.hasAttribute('aria-invalid'),
      invoiceError: Boolean(document.querySelector('#error-invoiceDate')),
      dueInvalid: dueDate.hasAttribute('aria-invalid'),
      dueError: Boolean(document.querySelector('#error-dueDate'))
    };
    return JSON.stringify({ afterInvoiceDate, afterDueDate });
  })()`));
  assert.deepEqual(requiredDateRecovery, {
    afterInvoiceDate: { invoiceInvalid: false, invoiceError: false, dueInvalid: true, dueError: true },
    afterDueDate: { invoiceInvalid: false, invoiceError: false, dueInvalid: false, dueError: false },
  });
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
  assert.deepEqual(overflowBlocked, { prints: 0, total: "$-", invalid: "true" });

  const printCount = await evaluate(page, `(async () => {
    window.__prints = 0; window.__printedTitle = ''; window.print = () => { window.__prints += 1; window.__printedTitle = document.title; };
    const values = { invoiceNumber: 'INV-1', pdfFileName: 'August / Brew Invoice.pdf', invoiceDate: '2026-08-20', dueDate: '2026-08-13', billTo: 'Customer' };
    for (const [id, value] of Object.entries(values)) { const input = document.querySelector('#' + id); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); }
    const description = document.querySelector('[data-item-field="description"]'); description.value = 'Service'; description.dispatchEvent(new Event('input', { bubbles: true }));
    const price = document.querySelector('[data-item-field="price"]'); price.value = '25'; price.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#printButton').click();
    const invoiceDate = document.querySelector('#invoiceDate');
    const dueDate = document.querySelector('#dueDate');
    const rejected = { prints: window.__prints, focused: document.activeElement.id, message: document.querySelector('#error-dueDate')?.textContent, describedBy: dueDate.getAttribute('aria-describedby') };
    invoiceDate.value = ''; invoiceDate.dispatchEvent(new Event('input', { bubbles: true }));
    const clearedInvoiceDate = { invalid: dueDate.hasAttribute('aria-invalid'), errorExists: Boolean(document.querySelector('#error-dueDate')), describedBy: dueDate.getAttribute('aria-describedby') };
    invoiceDate.value = '2026-08-20'; invoiceDate.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#printButton').click();
    dueDate.value = ''; dueDate.dispatchEvent(new Event('input', { bubbles: true }));
    const clearedDueDate = { invalid: dueDate.hasAttribute('aria-invalid'), errorExists: Boolean(document.querySelector('#error-dueDate')), describedBy: dueDate.getAttribute('aria-describedby') };
    dueDate.value = '2026-08-27'; dueDate.dispatchEvent(new Event('input', { bubbles: true }));
    const recovered = { invalid: dueDate.hasAttribute('aria-invalid'), errorExists: Boolean(document.querySelector('#error-dueDate')) };
    document.querySelector('#printButton').click();
    while (!document.querySelector('#outputDialog').open) await new Promise(resolve => setTimeout(resolve, 0));
    const dialog = {
      open: document.querySelector('#outputDialog').open,
      title: document.querySelector('#outputDialogTitle').textContent,
      closeLabel: document.querySelector('#cancelOutputDialogButton').textContent,
      fileName: document.querySelector('#outputFileName').textContent,
      printsBeforeChoice: window.__prints
    };
    document.querySelector('#printNowButton').click();
    return JSON.stringify({ rejected, clearedInvoiceDate, clearedDueDate, recovered, dialog, prints: window.__prints, printedTitle: window.__printedTitle, focused: document.activeElement.id, invalid: document.querySelectorAll('[aria-invalid="true"]').length });
  })()`);
  assert.deepEqual(JSON.parse(printCount), {
    rejected: { prints: 0, focused: "dueDate", message: "Due date cannot be earlier than the invoice date.", describedBy: "error-dueDate" },
    clearedInvoiceDate: { invalid: false, errorExists: false, describedBy: null },
    clearedDueDate: { invalid: false, errorExists: false, describedBy: null },
    recovered: { invalid: false, errorExists: false },
    dialog: { open: true, title: "Invoice saved", closeLabel: "Done", fileName: "August - Brew Invoice.pdf", printsBeforeChoice: 0 },
    prints: 1,
    printedTitle: "August - Brew Invoice.pdf",
    focused: "printButton",
    invalid: 0,
  });

  assert.equal(await evaluate(page, "typeof window.html2pdf"), "undefined");
  assert.equal(await evaluate(page, "document.querySelector('script[data-pdf-library]') === null"), true);
  await page.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 640, deviceScaleFactor: 1, mobile: true });
  const mobileDialog = JSON.parse(await evaluate(page, `(async () => {
    document.querySelector('#mobilePrintButton').click();
    const dialog = document.querySelector('#outputDialog');
    while (!dialog.open) await new Promise(resolve => setTimeout(resolve, 0));
    const rect = dialog.getBoundingClientRect();
    const optionHeights = [...dialog.querySelectorAll('.output-option')].map(option => option.getBoundingClientRect().height);
    const result = {
      open: dialog.open,
      left: rect.left,
      right: rect.right,
      viewport: innerWidth,
      fileName: document.querySelector('#outputFileName').textContent,
      optionHeights
    };
    document.querySelector('#cancelOutputDialogButton').click();
    return JSON.stringify(result);
  })()`));
  assert.equal(mobileDialog.open, true);
  assert.ok(mobileDialog.left >= 0);
  assert.ok(mobileDialog.right <= mobileDialog.viewport);
  assert.equal(mobileDialog.fileName, "August - Brew Invoice.pdf");
  mobileDialog.optionHeights.forEach((height) => assert.ok(height >= 76));
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  await browser.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: profile, eventsEnabled: true });
  const downloadedPdfPath = join(profile, "August - Brew Invoice.pdf");
  await evaluate(page, `(() => {
    document.querySelector('#printButton').click();
    return true;
  })()`);
  await waitFor(() => evaluate(page, "document.querySelector('#outputDialog').open"));
  await evaluate(page, "document.querySelector('#savePdfButton').click(); true");
  await waitFor(() => evaluate(page, "typeof window.html2pdf === 'function'"));
  assert.equal(
    await evaluate(page, "document.querySelector('script[data-pdf-library=\"html2pdf\"]')?.getAttribute('src')"),
    "./vendor/html2pdf.bundle.min.js?v=29",
  );
  await waitFor(async () => {
    try {
      return (await stat(downloadedPdfPath)).size > 20000;
    } catch {
      return false;
    }
  }, 20000);
  const generatedPdf = await readFile(downloadedPdfPath);
  assert.equal(generatedPdf.subarray(0, 4).toString(), "%PDF");
  assert.equal((generatedPdf.toString("latin1").match(/\/Type \/Page\b/g) || []).length, 1);
  await waitFor(() => evaluate(page, "document.querySelector('#outputDialog').open === false"));

  const pdfDownload = JSON.parse(await evaluate(page, `(async () => {
    const captured = {};
    const worker = {
      set(options) { captured.options = options; return this; },
      from(element) { captured.element = { id: element.id, transform: element.style.transform, width: element.style.width }; return this; },
      toPdf() { captured.toPdf = true; return this; },
      get(key) { captured.get = key; return this; },
      then(callback) {
        callback({ setProperties(properties) { captured.properties = properties; } });
        return this;
      },
      save() { captured.saved = true; return Promise.resolve(); }
    };
    window.html2pdf = () => worker;
    document.querySelector('#printButton').click();
    while (!document.querySelector('#outputDialog').open) await new Promise(resolve => setTimeout(resolve, 0));
    const openBeforeSave = document.querySelector('#outputDialog').open;
    document.querySelector('#savePdfButton').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    return JSON.stringify({
      openBeforeSave,
      openAfterSave: document.querySelector('#outputDialog').open,
      fileName: captured.options.filename,
      format: captured.options.jsPDF.format,
      title: captured.properties.title,
      creator: captured.properties.creator,
      element: captured.element,
      saved: captured.saved,
      busy: document.querySelector('#outputDialog').getAttribute('aria-busy'),
      focused: document.activeElement.id,
      toast: document.querySelector('#toast').textContent
    });
  })()`));
  assert.deepEqual(pdfDownload, {
    openBeforeSave: true,
    openAfterSave: false,
    fileName: "August - Brew Invoice.pdf",
    format: "a4",
    title: "August - Brew Invoice",
    creator: "Eng Hoon Residences Invoice Studio",
    element: { id: "", transform: "none", width: "793px" },
    saved: true,
    busy: "false",
    focused: "printButton",
    toast: "August - Brew Invoice.pdf saved.",
  });

  const historyBehavior = JSON.parse(await evaluate(page, `(async () => {
    document.querySelector('#invoiceListButton').click();
    const initial = {
      page: document.body.dataset.page,
      count: document.querySelectorAll('.invoice-record').length,
      number: document.querySelector('.invoice-number')?.textContent,
      customer: document.querySelector('.invoice-customer')?.textContent,
      total: document.querySelector('.invoice-record-meta div:last-child dd')?.textContent,
      semanticLabel: document.querySelector('.invoice-record')?.getAttribute('aria-labelledby'),
      titleTag: document.querySelector('.invoice-number')?.tagName,
      createActions: ['newInvoiceButton', 'historyNewInvoiceButton', 'emptyStateNewInvoiceButton']
        .filter(id => document.getElementById(id).getClientRects().length > 0).length
    };

    document.querySelector('[data-edit-invoice]').click();
    const editedCustomer = document.querySelector('#billTo');
    editedCustomer.value = 'Updated Customer';
    editedCustomer.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#printButton').click();
    while (!document.querySelector('#outputDialog').open) await new Promise(resolve => setTimeout(resolve, 0));
    document.querySelector('#cancelOutputDialogButton').click();
    document.querySelector('#invoiceListButton').click();
    const afterEdit = {
      count: document.querySelectorAll('.invoice-record').length,
      customer: document.querySelector('.invoice-customer')?.textContent
    };

    const sourceNumber = document.querySelector('.invoice-number').textContent;
    document.querySelector('[data-duplicate-invoice]').click();
    while (document.querySelector('#editorTitle').textContent !== 'Review duplicated invoice') await new Promise(resolve => setTimeout(resolve, 0));
    const duplicate = {
      number: document.querySelector('#invoiceNumber').value,
      customer: document.querySelector('#billTo').value,
      title: document.querySelector('#editorTitle').textContent
    };
    document.querySelector('#printButton').click();
    while (!document.querySelector('#outputDialog').open) await new Promise(resolve => setTimeout(resolve, 0));
    document.querySelector('#cancelOutputDialogButton').click();
    document.querySelector('#invoiceListButton').click();
    const afterDuplicate = {
      count: document.querySelectorAll('.invoice-record').length,
      numbers: [...document.querySelectorAll('.invoice-number')].map(element => element.textContent)
    };
    return JSON.stringify({ initial, afterEdit, sourceNumber, duplicate, afterDuplicate });
  })()`));
  assert.equal(historyBehavior.initial.page, "history");
  assert.equal(historyBehavior.initial.count, 1);
  assert.equal(historyBehavior.initial.number, "INV-1");
  assert.equal(historyBehavior.initial.customer, "Customer");
  assert.equal(historyBehavior.initial.total, "$50.00");
  assert.equal(historyBehavior.initial.titleTag, "H3");
  assert.ok(historyBehavior.initial.semanticLabel);
  assert.equal(historyBehavior.initial.createActions, 1);
  assert.deepEqual(historyBehavior.afterEdit, { count: 1, customer: "Updated Customer" });
  assert.notEqual(historyBehavior.duplicate.number, historyBehavior.sourceNumber);
  assert.equal(historyBehavior.duplicate.customer, "Updated Customer");
  assert.equal(historyBehavior.duplicate.title, "Review duplicated invoice");
  assert.equal(historyBehavior.afterDuplicate.count, 2);
  assert.ok(historyBehavior.afterDuplicate.numbers.includes(historyBehavior.sourceNumber));
  assert.ok(historyBehavior.afterDuplicate.numbers.includes(historyBehavior.duplicate.number));

  const deleteDraftBehavior = JSON.parse(await evaluate(page, `(async () => {
    const savedCount = document.querySelectorAll('.invoice-record').length;
    document.querySelector('[data-edit-invoice]').click();
    const customer = document.querySelector('#billTo');
    customer.value = 'Unsaved customer change';
    customer.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#invoiceListButton').click();
    while (localStorage.getItem('test-supabase-draft') === null) await new Promise(resolve => setTimeout(resolve, 0));
    const noticeBefore = !document.querySelector('#draftNotice').hidden;
    const actionsAdjacent = document.querySelector('#continueDraftButton').parentElement === document.querySelector('#deleteDraftButton').parentElement;
    let confirmations = 0;
    window.confirm = () => { confirmations += 1; return false; };
    document.querySelector('#deleteDraftButton').click();
    const afterCancel = {
      noticeVisible: !document.querySelector('#draftNotice').hidden,
      draftStored: localStorage.getItem('test-supabase-draft') !== null
    };
    window.confirm = () => { confirmations += 1; return true; };
    document.querySelector('#deleteDraftButton').click();
    while (!document.querySelector('#draftNotice').hidden) await new Promise(resolve => setTimeout(resolve, 0));
    return JSON.stringify({
      savedCount,
      noticeBefore,
      actionsAdjacent,
      confirmations,
      afterCancel,
      noticeAfter: !document.querySelector('#draftNotice').hidden,
      draftStoredAfter: localStorage.getItem('test-supabase-draft') !== null,
      historyCountAfter: document.querySelectorAll('.invoice-record').length,
      toast: document.querySelector('#toast').textContent
    });
  })()`));
  assert.deepEqual(deleteDraftBehavior, {
    savedCount: 2,
    noticeBefore: true,
    actionsAdjacent: true,
    confirmations: 2,
    afterCancel: { noticeVisible: true, draftStored: true },
    noticeAfter: false,
    draftStoredAfter: false,
    historyCountAfter: 2,
    toast: "Unsaved draft deleted."
  });

  await evaluate(page, `(() => {
    localStorage.setItem('test-original-invoices', localStorage.getItem('test-supabase-invoices'));
    const records = Array.from({ length: 31 }, (_, index) => ({
      id: 'pagination-' + String(index).padStart(2, '0'),
      revision: 1,
      createdAt: new Date(Date.UTC(2026, 6, index + 1)).toISOString(),
      updatedAt: new Date(Date.UTC(2026, 6, index + 1)).toISOString(),
      invoice: {
        invoiceNumber: 'EHR-PAGE-' + String(index + 1).padStart(3, '0'),
        pdfFileName: 'EHR-PAGE-' + String(index + 1).padStart(3, '0'),
        invoiceDate: '2026-07-01',
        dueDate: '2026-07-08',
        billTo: index === 7 ? 'Needle Customer' : 'Pagination Customer ' + index,
        items: [{ id: 'item-' + index, quantity: 1, description: 'Market space', price: '25' }]
      }
    }));
    localStorage.setItem('test-supabase-invoices', JSON.stringify(records));
    location.reload();
  })()`);
  await waitFor(() => evaluate(page, "document.body.dataset.page === 'history' && document.querySelectorAll('.invoice-record').length === 25 && !document.querySelector('#loadMoreInvoicesButton').hidden"));
  await evaluate(page, "document.querySelector('#loadMoreInvoicesButton').click(); true");
  await waitFor(() => evaluate(page, "document.querySelectorAll('.invoice-record').length === 31 && document.querySelector('#loadMoreInvoicesButton').hidden"));
  await evaluate(page, `(() => {
    const search = document.querySelector('#invoiceSearch');
    search.value = 'Needle Customer';
    search.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(() => evaluate(page, "document.querySelectorAll('.invoice-record').length === 1 && document.querySelector('#invoiceCount').textContent === '1 of 1 invoice'"));
  const paginationBehavior = JSON.parse(await evaluate(page, `JSON.stringify({
    onlyCustomer: document.querySelector('.invoice-customer').textContent,
    calls: window.__BROWSER_BACKEND_MOCK__.controls.listCalls,
    loadingHidden: document.querySelector('#historyLoadingState').hidden,
    errorHidden: document.querySelector('#historyErrorState').hidden
  })`));
  assert.equal(paginationBehavior.onlyCustomer, "Needle Customer");
  assert.equal(paginationBehavior.loadingHidden, true);
  assert.equal(paginationBehavior.errorHidden, true);
  assert.ok(paginationBehavior.calls.some((call) => call.limit === 25 && call.cursor));
  assert.ok(paginationBehavior.calls.some((call) => call.query === "Needle Customer"));
  await evaluate(page, `(() => {
    localStorage.setItem('test-supabase-invoices', localStorage.getItem('test-original-invoices'));
    localStorage.removeItem('test-original-invoices');
    location.reload();
  })()`);
  await waitFor(() => evaluate(page, "document.body.dataset.page === 'history' && document.querySelectorAll('.invoice-record').length === 2"));

  await page.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 760, deviceScaleFactor: 1, mobile: true });
  const mobileHistoryLayout = JSON.parse(await evaluate(page, `JSON.stringify({
    viewport: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    datesFit: [...document.querySelectorAll('.invoice-record-meta div:first-child dd')].every(date => date.scrollWidth <= date.clientWidth),
    records: [...document.querySelectorAll('.invoice-record')].map(record => {
      const rect = record.getBoundingClientRect();
      return { left: rect.left, right: rect.right, actionWidths: [...record.querySelectorAll('.button')].map(button => button.getBoundingClientRect().width) };
    })
  })`));
  assert.ok(mobileHistoryLayout.documentWidth <= mobileHistoryLayout.viewport);
  assert.equal(mobileHistoryLayout.datesFit, true);
  assert.ok(mobileHistoryLayout.records.every(record => record.left >= 0 && record.right <= mobileHistoryLayout.viewport));
  assert.ok(mobileHistoryLayout.records.every(record => record.actionWidths.every(width => width >= 44)));
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  const blockedSignOut = JSON.parse(await evaluate(page, `(async () => {
    const operation = await window.invoiceDraftOutbox.putSave('test-user-1', {
      invoiceNumber: 'EHR-RECOVERY-001',
      billTo: 'Recovered customer'
    });
    document.querySelector('#signOutButton').click();
    while (!document.querySelector('#toast').textContent.includes('has not synced')) await new Promise(resolve => setTimeout(resolve, 0));
    const result = {
      page: document.body.dataset.page,
      status: document.querySelector('#syncStatus').textContent,
      signOutCalls: window.__BROWSER_BACKEND_MOCK__.controls.signOutCalls,
      pending: await window.invoiceDraftOutbox.has('test-user-1')
    };
    await window.invoiceDraftOutbox.remove('test-user-1', operation.operationId);
    return JSON.stringify(result);
  })()`));
  assert.deepEqual(blockedSignOut, {
    page: "history",
    status: "Sync this draft before signing out",
    signOutCalls: 0,
    pending: true,
  });

  await evaluate(page, "document.querySelector('#signOutButton').click(); true");
  await waitFor(() => evaluate(page, "document.body.dataset.page === 'auth' && !document.querySelector('#authPage').hidden"));
  const signedOutState = JSON.parse(await evaluate(page, `JSON.stringify({
    title: document.querySelector('#authTitle').textContent,
    historyHidden: document.querySelector('#invoiceListPage').hidden,
    accountHidden: document.querySelector('#accountControls').hidden,
    remoteInvoices: JSON.parse(localStorage.getItem('test-supabase-invoices') || '[]').length,
    passwordMinimum: document.querySelector('#authPassword').minLength,
    emailValue: document.querySelector('#authEmail').value,
    passwordValue: document.querySelector('#authPassword').value,
    recoveryPasswordValue: document.querySelector('#recoveryPassword').value,
    recoveryConfirmValue: document.querySelector('#recoveryPasswordConfirm').value,
    billToValue: document.querySelector('#billTo').value,
    previewBillTo: document.querySelector('#previewBillTo').textContent,
    renderedHistoryRecords: document.querySelectorAll('.invoice-record').length
  })`));
  assert.deepEqual(signedOutState, {
    title: "Sign in",
    historyHidden: true,
    accountHidden: true,
    remoteInvoices: 2,
    passwordMinimum: 6,
    emailValue: "",
    passwordValue: "",
    recoveryPasswordValue: "",
    recoveryConfirmValue: "",
    billToValue: "",
    previewBillTo: "",
    renderedHistoryRecords: 0,
  });

  await evaluate(page, `(() => {
    document.querySelector('#authEmail').value = 'pending-owner@example.com';
    document.querySelector('#authPassword').value = 'secure-pass-123';
    window.__BROWSER_BACKEND_MOCK__.controls.nextSignInError = {
      code: 'email_not_confirmed',
      status: 400,
      message: 'Email not confirmed'
    };
    document.querySelector('#authForm').requestSubmit();
  })()`);
  await waitFor(() => evaluate(page, "document.querySelector('#authMessage').textContent.includes('Confirm your email before signing in')"));

  await evaluate(page, `(() => {
    document.querySelector('#authPassword').value = 'secure-pass-123';
    window.__BROWSER_BACKEND_MOCK__.controls.nextSignUpError = {
      code: 'over_email_send_rate_limit',
      status: 429,
      message: 'For security purposes, you can only request this after 42 seconds.'
    };
    document.querySelector('#createAccountButton').click();
  })()`);
  await waitFor(() => evaluate(page, "document.querySelector('#authMessage').textContent.includes('Wait 42 seconds')"));
  assert.deepEqual(JSON.parse(await evaluate(page, `JSON.stringify({
    createDisabled: document.querySelector('#createAccountButton').disabled,
    resetDisabled: document.querySelector('#forgotPasswordButton').disabled,
    signUpCalls: window.__BROWSER_BACKEND_MOCK__.controls.signUpCalls
  })`)), { createDisabled: true, resetDisabled: true, signUpCalls: 1 });

  await evaluate(page, `(() => {
    const email = document.querySelector('#authEmail');
    email.value = 'new-owner@example.com';
    email.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#authPassword').value = 'secure-pass-123';
    document.querySelector('#createAccountButton').click();
  })()`);
  await waitFor(() => evaluate(page, "document.querySelector('#authMessage').textContent.includes('Check your email')"));
  assert.deepEqual(JSON.parse(await evaluate(page, `JSON.stringify({
    createDisabled: document.querySelector('#createAccountButton').disabled,
    resetDisabled: document.querySelector('#forgotPasswordButton').disabled,
    signUpCalls: window.__BROWSER_BACKEND_MOCK__.controls.signUpCalls
  })`)), { createDisabled: true, resetDisabled: true, signUpCalls: 2 });

  await evaluate(page, `(() => {
    const email = document.querySelector('#authEmail');
    email.value = 'recovery-owner@example.com';
    email.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await evaluate(page, "document.querySelector('#forgotPasswordButton').click(); true");
  await waitFor(() => evaluate(page, "document.querySelector('#authMessage').textContent.includes('reset link')"));

  await evaluate(page, `(() => {
    const email = document.querySelector('#authEmail');
    email.value = 'quota-test@example.com';
    email.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#authPassword').value = 'secure-pass-123';
    window.__BROWSER_BACKEND_MOCK__.controls.nextSignUpError = {
      code: 'over_email_send_rate_limit',
      status: 429,
      message: 'email rate limit exceeded'
    };
    document.querySelector('#createAccountButton').click();
  })()`);
  await waitFor(() => evaluate(page, "document.querySelector('#authMessage').textContent.includes('applies across all email addresses')"));
  const sharedQuotaState = JSON.parse(await evaluate(page, `(() => {
    const email = document.querySelector('#authEmail');
    email.value = 'another-address@example.com';
    email.dispatchEvent(new Event('input', { bubbles: true }));
    return JSON.stringify({
      createDisabled: document.querySelector('#createAccountButton').disabled,
      resetDisabled: document.querySelector('#forgotPasswordButton').disabled,
      signInDisabled: document.querySelector('#signInButton').disabled
    });
  })()`));
  assert.deepEqual(sharedQuotaState, { createDisabled: true, resetDisabled: true, signInDisabled: false });

  await evaluate(page, `(() => {
    const email = document.querySelector('#authEmail');
    email.value = 'new-owner@example.com';
    email.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#authPassword').value = 'secure-pass-123';
    document.querySelector('#authForm').requestSubmit();
  })()`);
  await waitFor(() => evaluate(page, "document.body.dataset.page === 'history' && document.querySelectorAll('.invoice-record').length === 2"));
  assert.equal(await evaluate(page, "document.querySelector('#accountEmail').textContent"), "new-owner@example.com");

  await evaluate(page, "window.__BROWSER_BACKEND_MOCK__.emitPasswordRecovery(); true");
  await waitFor(() => evaluate(page, "!document.querySelector('#passwordRecoveryForm').hidden"));
  await evaluate(page, `(() => {
    document.querySelector('#recoveryPassword').value = 'replacement-pass-123';
    document.querySelector('#recoveryPasswordConfirm').value = 'replacement-pass-123';
    document.querySelector('#passwordRecoveryForm').requestSubmit();
  })()`);
  await waitFor(() => evaluate(page, "document.body.dataset.page === 'history' && document.querySelector('#passwordRecoveryForm').hidden"));

  await evaluate(page, `(() => {
    const invoice = {
      draftDirty: false,
      invoiceNumber: 'EHR-20260819-099',
      pdfFileName: 'EHR-20260819-099',
      pdfFileNameCustomized: false,
      invoiceDate: '2026-08-19',
      dueDate: '2026-08-26',
      billTo: 'Migrated Customer',
      items: [{ id: 'legacy-item', quantity: 1, description: 'Migrated service', price: 88 }]
    };
    localStorage.setItem('invoice-studio-history-v1', JSON.stringify([{ id: 'legacy-record', createdAt: '2026-08-19T01:00:00.000Z', updatedAt: '2026-08-19T01:00:00.000Z', invoice }]));
    localStorage.setItem('invoice-studio-draft-v1', JSON.stringify({ ...invoice, historyId: undefined, draftDirty: true, invoiceNumber: 'EHR-20260819-100', billTo: 'Migrated Draft' }));
    localStorage.setItem('invoice-studio-sequence-v1', JSON.stringify({ date: '20260819', sequence: 100 }));
    location.reload();
  })()`);
  await waitFor(() => evaluate(page, "document.querySelector('#legacyMigrationDialog').open"));
  const migrationConsent = JSON.parse(await evaluate(page, `JSON.stringify({
    summary: document.querySelector('#legacyMigrationSummary').textContent,
    destination: document.querySelector('#legacyMigrationDestination').textContent,
    choices: [
      'moveLegacyDataButton', 'exportLegacyDataButton', 'discardLegacyDataButton', 'cancelLegacyMigrationButton'
    ].map(id => document.getElementById(id).textContent),
    legacyStillLocal: localStorage.getItem('invoice-studio-history-v1') !== null
      && localStorage.getItem('invoice-studio-draft-v1') !== null
  })`));
  assert.deepEqual(migrationConsent, {
    summary: "1 saved invoice and 1 draft",
    destination: "owner@example.com",
    choices: ["Move to this account", "Export a backup", "Discard local copy", "Cancel sign-in"],
    legacyStillLocal: true,
  });
  await evaluate(page, "document.querySelector('#exportLegacyDataButton').click(); true");
  await waitFor(() => evaluate(page, "document.querySelector('#legacyMigrationMessage').textContent.includes('Backup downloaded')"));
  assert.equal(await evaluate(page, "localStorage.getItem('invoice-studio-history-v1') !== null"), true);
  await evaluate(page, "document.querySelector('#moveLegacyDataButton').click(); true");
  await waitFor(() => evaluate(page, "document.body.dataset.page === 'history' && document.querySelectorAll('.invoice-record').length === 3 && !document.querySelector('#draftNotice').hidden"));
  const migrationState = JSON.parse(await evaluate(page, `JSON.stringify({
    legacyHistoryRemoved: localStorage.getItem('invoice-studio-history-v1') === null,
    legacyDraftRemoved: localStorage.getItem('invoice-studio-draft-v1') === null,
    legacySequenceRemoved: localStorage.getItem('invoice-studio-sequence-v1') === null,
    remoteCount: JSON.parse(localStorage.getItem('test-supabase-invoices') || '[]').length,
    draftSummary: document.querySelector('#draftNoticeSummary').textContent,
    toast: document.querySelector('#toast').textContent
  })`));
  assert.deepEqual(migrationState, {
    legacyHistoryRemoved: true,
    legacyDraftRemoved: true,
    legacySequenceRemoved: true,
    remoteCount: 3,
    draftSummary: "EHR-20260819-100 for Migrated Draft, $88.00",
    toast: "Existing browser invoices were moved to your account."
  });

  const optimisticConflictCodes = JSON.parse(await evaluate(page, `(async () => {
    const { records } = await window.invoiceBackend.listInvoices('test-user-1');
    const staleInvoice = records[0];
    await window.invoiceBackend.saveInvoice('test-user-1', { ...staleInvoice, invoice: { ...staleInvoice.invoice, billTo: 'Other session' } });
    let invoiceCode = '';
    try {
      await window.invoiceBackend.saveInvoice('test-user-1', { ...staleInvoice, invoice: { ...staleInvoice.invoice, billTo: 'Stale session' } });
    } catch (error) {
      invoiceCode = error.code;
    }

    const staleDraft = await window.invoiceBackend.loadDraft('test-user-1');
    await window.invoiceBackend.saveDraft('test-user-1', staleDraft.invoice, undefined, staleDraft.revision);
    let draftCode = '';
    try {
      await window.invoiceBackend.saveDraft('test-user-1', staleDraft.invoice, undefined, staleDraft.revision);
    } catch (error) {
      draftCode = error.code;
    }
    return JSON.stringify({ invoiceCode, draftCode });
  })()`));
  assert.deepEqual(optimisticConflictCodes, {
    invoiceCode: "INVOICE_REVISION_CONFLICT",
    draftCode: "DRAFT_REVISION_CONFLICT",
  });

  const migrationSql = await readFile(join(ROOT, "supabase/migrations/20260819084659_invoice_studio.sql"), "utf8");
  assert.match(migrationSql, /alter table public\.invoices enable row level security;/);
  assert.match(migrationSql, /alter table public\.invoice_drafts enable row level security;/);
  assert.match(migrationSql, /alter table public\.invoice_revisions enable row level security;/);
  assert.match(migrationSql, /to authenticated\s+using \(\(select auth\.uid\(\)\) = user_id\);/);
  assert.match(migrationSql, /revoke all on table public\.invoices from anon, authenticated;/);
  assert.match(migrationSql, /revoke all on table public\.invoice_counters from anon, authenticated;/);
  assert.match(migrationSql, /create or replace function public\.next_invoice_number[\s\S]+security definer\s+set search_path = ''/);
  assert.match(migrationSql, /create or replace function public\.invoice_items_are_valid[\s\S]+octet_length\(p_items::text\) > 16000/);
  assert.match(migrationSql, /create or replace function public\.invoice_draft_is_valid[\s\S]+octet_length\(p_invoice::text\) > 24000/);
  assert.match(migrationSql, /revision integer not null default 1/);
  assert.match(migrationSql, /constraint invoices_user_invoice_number_key unique \(user_id, invoice_number\)/);
  assert.match(migrationSql, /create table public\.invoice_revisions/);
  assert.match(migrationSql, /INVOICE_REVISION_CONFLICT/);
  assert.match(migrationSql, /maximum 2000 invoices per account/);
  assert.match(migrationSql, /create or replace function public\.list_invoices_page/);
  assert.match(migrationSql, /list_invoices_page[\s\S]+security invoker\s+set search_path = ''/);
  assert.match(migrationSql, /grant execute on function public\.list_invoices_page[\s\S]+to authenticated;/);
  const backendSource = await readFile(join(ROOT, "backend.js"), "utf8");
  assert.match(backendSource, /\.eq\("revision", expectedRevision\)/);
  assert.match(backendSource, /error\.code = "INVOICE_REVISION_CONFLICT"/);

  const cacheReady = await waitFor(() => evaluate(page, "caches.keys().then(keys => keys.includes('invoice-studio-v29'))"));
  assert.equal(cacheReady, true);
  const workerSource = await readFile(join(ROOT, "sw.js"), "utf8");
  const handlers = {};
  const deletedCaches = [];
  const cacheKeys = ["invoice-studio-v1", "invoice-studio-v27", "invoice-studio-v28", "invoice-studio-v29", "unrelated-app-cache"];
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
  assert.deepEqual(deletedCaches, ["invoice-studio-v1", "invoice-studio-v27", "invoice-studio-v28"]);

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
  assert.equal(await evaluate(page, "typeof window.html2pdf"), "undefined");
  assert.equal(await evaluate(page, "document.querySelector('script[data-pdf-library]') === null"), true);
  await page.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
    connectionType: "none",
  });
});
