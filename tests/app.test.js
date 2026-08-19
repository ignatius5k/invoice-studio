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
    beforeInstall: Boolean(document.querySelector('#invoiceListButton').compareDocumentPosition(document.querySelector('#installButton')) & Node.DOCUMENT_POSITION_FOLLOWING)
  })`));
  assert.deepEqual(backNavigation, { label: "Back", beforeInstall: true });
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
      height: preview.getBoundingClientRect().height
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

  await evaluate(page, `(() => {
    window.confirm = () => true;
    document.querySelector('#clearDraftButton').click();
  })()`);
  assert.equal(await evaluate(page, "localStorage.getItem('invoice-studio-draft-v1')"), null);
  assert.match(await evaluate(page, "document.querySelector('#invoiceNumber').value"), /^EHR-\d{8}-\d{3,}$/);
  await evaluate(page, "window.dispatchEvent(new PageTransitionEvent('pagehide'))");
  assert.equal(await evaluate(page, "localStorage.getItem('invoice-studio-draft-v1')"), null);

  const metadataOnlyProtection = JSON.parse(await evaluate(page, `(() => {
    const number = document.querySelector('#invoiceNumber');
    number.value = 'metadata-only';
    number.dispatchEvent(new Event('input', { bubbles: true }));
    let confirmations = 0;
    window.confirm = () => { confirmations += 1; return false; };
    document.querySelector('#newInvoiceButton').click();
    const result = { confirmations, number: number.value };
    window.confirm = () => true;
    document.querySelector('#newInvoiceButton').click();
    return JSON.stringify(result);
  })()`));
  assert.deepEqual(metadataOnlyProtection, { confirmations: 1, number: "METADATA-ONLY" });

  const newInvoiceProtection = JSON.parse(await evaluate(page, `(() => {
    const billTo = document.querySelector('#billTo');
    billTo.value = 'Keep me'; billTo.dispatchEvent(new Event('input', { bubbles: true }));
    const before = document.querySelector('#invoiceNumber').value;
    window.confirm = () => false;
    document.querySelector('#newInvoiceButton').click();
    const cancelled = { number: document.querySelector('#invoiceNumber').value, billTo: billTo.value };
    window.confirm = () => true;
    document.querySelector('#newInvoiceButton').click();
    return JSON.stringify({ before, cancelled, after: document.querySelector('#invoiceNumber').value, pdfAfter: document.querySelector('#pdfFileName').value, billToAfter: document.querySelector('#billTo').value });
  })()`));
  assert.deepEqual(newInvoiceProtection.cancelled, { number: newInvoiceProtection.before, billTo: "Keep me" });
  assert.notEqual(newInvoiceProtection.after, newInvoiceProtection.before);
  assert.equal(newInvoiceProtection.pdfAfter, newInvoiceProtection.after);
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

  const printCount = await evaluate(page, `(() => {
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

  assert.equal(await evaluate(page, "typeof window.html2pdf"), "function");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 640, deviceScaleFactor: 1, mobile: true });
  const mobileDialog = JSON.parse(await evaluate(page, `(() => {
    document.querySelector('#mobilePrintButton').click();
    const dialog = document.querySelector('#outputDialog');
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
    document.querySelector('#savePdfButton').click();
    return true;
  })()`);
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

  const historyBehavior = JSON.parse(await evaluate(page, `(() => {
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
    document.querySelector('#cancelOutputDialogButton').click();
    document.querySelector('#invoiceListButton').click();
    const afterEdit = {
      count: document.querySelectorAll('.invoice-record').length,
      customer: document.querySelector('.invoice-customer')?.textContent
    };

    const sourceNumber = document.querySelector('.invoice-number').textContent;
    document.querySelector('[data-duplicate-invoice]').click();
    const duplicate = {
      number: document.querySelector('#invoiceNumber').value,
      customer: document.querySelector('#billTo').value,
      title: document.querySelector('#editorTitle').textContent
    };
    document.querySelector('#printButton').click();
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

  const deleteDraftBehavior = JSON.parse(await evaluate(page, `(() => {
    const savedCount = document.querySelectorAll('.invoice-record').length;
    document.querySelector('[data-edit-invoice]').click();
    const customer = document.querySelector('#billTo');
    customer.value = 'Unsaved customer change';
    customer.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#invoiceListButton').click();
    const noticeBefore = !document.querySelector('#draftNotice').hidden;
    const actionsAdjacent = document.querySelector('#continueDraftButton').parentElement === document.querySelector('#deleteDraftButton').parentElement;
    let confirmations = 0;
    window.confirm = () => { confirmations += 1; return false; };
    document.querySelector('#deleteDraftButton').click();
    const afterCancel = {
      noticeVisible: !document.querySelector('#draftNotice').hidden,
      draftStored: localStorage.getItem('invoice-studio-draft-v1') !== null
    };
    window.confirm = () => { confirmations += 1; return true; };
    document.querySelector('#deleteDraftButton').click();
    return JSON.stringify({
      savedCount,
      noticeBefore,
      actionsAdjacent,
      confirmations,
      afterCancel,
      noticeAfter: !document.querySelector('#draftNotice').hidden,
      draftStoredAfter: localStorage.getItem('invoice-studio-draft-v1') !== null,
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

  const cacheReady = await waitFor(() => evaluate(page, "caches.keys().then(keys => keys.includes('invoice-studio-v25'))"));
  assert.equal(cacheReady, true);
  const workerSource = await readFile(join(ROOT, "sw.js"), "utf8");
  const handlers = {};
  const deletedCaches = [];
  const cacheKeys = ["invoice-studio-v1", "invoice-studio-v25", "unrelated-app-cache"];
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
  assert.equal(await evaluate(page, "typeof window.html2pdf"), "function");
  await page.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
    connectionType: "none",
  });
});
