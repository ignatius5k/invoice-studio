const STORAGE_KEY = "invoice-studio-draft-v1";
const SEQUENCE_KEY = "invoice-studio-sequence-v1";
const HISTORY_KEY = "invoice-studio-history-v1";
const PAPER_WIDTH = 793.7;
const PAPER_HEIGHT = 1122.52;
const MAX_QUANTITY = 9999;
const MAX_PRICE = 999999999.99;

const form = document.querySelector("#invoiceForm");
const itemsEditor = document.querySelector("#itemsEditor");
const previewItems = document.querySelector("#previewItems");
const previewStage = document.querySelector("#previewStage");
const paperScaleWrap = document.querySelector("#paperScaleWrap");
const invoiceSheet = document.querySelector("#invoiceSheet");
const saveStatus = document.querySelector("#saveStatus");
const toast = document.querySelector("#toast");
const installButton = document.querySelector("#installButton");
const offlineBanner = document.querySelector("#offlineBanner");
const outputDialog = document.querySelector("#outputDialog");
const outputFileName = document.querySelector("#outputFileName");
const savePdfButton = document.querySelector("#savePdfButton");
const savePdfButtonLabel = document.querySelector("#savePdfButtonLabel");
const printNowButton = document.querySelector("#printNowButton");
const closeOutputDialogButton = document.querySelector("#closeOutputDialogButton");
const cancelOutputDialogButton = document.querySelector("#cancelOutputDialogButton");
const fitPreviewButton = document.querySelector("#fitPreviewButton");
const actualSizePreviewButton = document.querySelector("#actualSizePreviewButton");
const backToEditorButton = document.querySelector("#backToEditorButton");
const invoiceListPage = document.querySelector("#invoiceListPage");
const editorPage = document.querySelector("#editorPage");
const invoiceListButton = document.querySelector("#invoiceListButton");
const newInvoiceButton = document.querySelector("#newInvoiceButton");
const printButton = document.querySelector("#printButton");
const editorTitle = document.querySelector("#editorTitle");
const invoiceHistoryList = document.querySelector("#invoiceHistoryList");
const historyEmptyState = document.querySelector("#historyEmptyState");
const historyNoResults = document.querySelector("#historyNoResults");
const invoiceCount = document.querySelector("#invoiceCount");
const invoiceSearch = document.querySelector("#invoiceSearch");
const invoiceSearchField = document.querySelector("#invoiceSearchField");
const historyNewInvoiceButton = document.querySelector("#historyNewInvoiceButton");
const draftNotice = document.querySelector("#draftNotice");
const draftNoticeSummary = document.querySelector("#draftNoticeSummary");

let state = loadDraft() ?? createInvoiceDraft();
let invoiceHistory = loadInvoiceHistory();
let saveTimer;
let toastTimer;
let installPrompt;
let draftPersistenceEnabled = true;
let draftChanged = false;
let outputBusy = false;
let outputDialogTrigger;
let currentPage = "history";
let historyQuery = "";
let previewScaleMode = "fit";

function normalizeInvoiceData(value) {
  if (!value || !Array.isArray(value.items) || value.items.length === 0) return null;
  const invoiceNumber = String(value.invoiceNumber || "").slice(0, 120);
  const savedPdfFileName = String(value.pdfFileName || "").trim();
  return {
    historyId: typeof value.historyId === "string" ? value.historyId : undefined,
    draftDirty: Boolean(value.draftDirty),
    invoiceNumber,
    pdfFileName: savedPdfFileName || invoiceNumber || "invoice",
    pdfFileNameCustomized: Boolean(savedPdfFileName && savedPdfFileName !== invoiceNumber),
    invoiceDate: String(value.invoiceDate || ""),
    dueDate: String(value.dueDate || ""),
    billTo: String(value.billTo || ""),
    items: value.items.slice(0, 5).map((item, index) => ({
      id: String(item?.id || `item-${Date.now()}-${index}`),
      quantity: normalizeQuantity(item?.quantity),
      description: String(item?.description || ""),
      price: Number(item?.price) === 0 && !String(item?.description || "").trim() ? "" : item?.price ?? "",
    })),
  };
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalizeInvoiceData(JSON.parse(raw));
  } catch {
    return null;
  }
}

function loadInvoiceHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    const seen = new Set();
    return parsed
      .map((record) => {
        const id = typeof record?.id === "string" ? record.id : "";
        const invoice = normalizeInvoiceData(record?.invoice);
        if (!id || seen.has(id) || !invoice) return null;
        seen.add(id);
        invoice.historyId = id;
        return {
          id,
          createdAt: String(record.createdAt || record.updatedAt || ""),
          updatedAt: String(record.updatedAt || record.createdAt || ""),
          invoice,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

function normalizeQuantity(value) {
  const quantity = Number(value);
  if (!Number.isFinite(quantity)) return 1;
  return Math.max(1, Math.round(quantity));
}

function createInvoiceDraft() {
  const today = new Date();
  const due = new Date(today);
  due.setDate(due.getDate() + 7);
  const invoiceNumber = nextInvoiceNumber(today);
  return {
    draftDirty: false,
    invoiceNumber,
    pdfFileName: invoiceNumber,
    pdfFileNameCustomized: false,
    invoiceDate: isoDate(today),
    dueDate: isoDate(due),
    billTo: "",
    items: [{ id: `item-${Date.now()}`, quantity: 1, description: "", price: "" }],
  };
}

function nextInvoiceNumber(date) {
  const compactDate = isoDate(date).replaceAll("-", "");
  let sequence = 1;
  try {
    const saved = JSON.parse(localStorage.getItem(SEQUENCE_KEY) || "null");
    if (saved?.date === compactDate && Number.isInteger(saved.sequence)) sequence = saved.sequence + 1;
    localStorage.setItem(SEQUENCE_KEY, JSON.stringify({ date: compactDate, sequence }));
  } catch {
    sequence = Date.now() % 1000000;
  }
  return `EHR-${compactDate}-${String(sequence).padStart(3, "0")}`;
}

function saveDraft(markChanged = true) {
  clearTimeout(saveTimer);
  draftPersistenceEnabled = true;
  if (markChanged) {
    draftChanged = true;
    state.draftDirty = true;
  }
  saveStatus.textContent = "Saving...";
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      const time = new Intl.DateTimeFormat("en-SG", { hour: "numeric", minute: "2-digit" }).format(new Date());
      saveStatus.textContent = `Saved ${time}`;
    } catch {
      saveStatus.textContent = "Could not save on this device";
    }
  }, 220);
}

function persistDraftImmediately() {
  if (!draftPersistenceEnabled) return;
  clearTimeout(saveTimer);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // The visible save status already reports storage failures during normal editing.
  }
}

function formatDate(value) {
  if (!value) return "";
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value;
  return new Intl.DateTimeFormat("en-SG", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(year, month - 1, day));
}

function formatAmount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : "-";
}

function safePdfFileName(value, fallback) {
  const withoutExtension = String(value || "").trim().replace(/\.pdf$/i, "");
  const cleaned = withoutExtension
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 120);
  const fallbackName = String(fallback || "invoice")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .slice(0, 120);
  return cleaned || fallbackName || "invoice";
}

function invoiceTotal() {
  return invoiceTotalFor(state);
}

function invoiceTotalFor(invoice) {
  return invoice.items.reduce((total, item) => total + (Number(item.quantity) || 0) * (Number(item.price) || 0), 0);
}

function formatHistoryAmount(value) {
  return new Intl.NumberFormat("en-SG", { style: "currency", currency: "SGD" }).format(value);
}

function cloneInvoice(invoice) {
  return {
    historyId: invoice.historyId,
    draftDirty: Boolean(invoice.draftDirty),
    invoiceNumber: invoice.invoiceNumber,
    pdfFileName: invoice.pdfFileName,
    pdfFileNameCustomized: invoice.pdfFileNameCustomized,
    invoiceDate: invoice.invoiceDate,
    dueDate: invoice.dueDate,
    billTo: invoice.billTo,
    items: invoice.items.map((item) => ({ ...item })),
  };
}

function invoiceFingerprint(invoice) {
  return JSON.stringify({
    invoiceNumber: invoice.invoiceNumber,
    pdfFileName: invoice.pdfFileName,
    invoiceDate: invoice.invoiceDate,
    dueDate: invoice.dueDate,
    billTo: invoice.billTo,
    items: invoice.items.map(({ quantity, description, price }) => ({ quantity, description, price })),
  });
}

function hasUnsavedDraft() {
  if (state.historyId) {
    const savedRecord = invoiceHistory.find((record) => record.id === state.historyId);
    return !savedRecord || invoiceFingerprint(savedRecord.invoice) !== invoiceFingerprint(state);
  }
  return Boolean(state.draftDirty || hasEnteredContent());
}

function historyRecordId() {
  if (typeof crypto.randomUUID === "function") return `invoice-${crypto.randomUUID()}`;
  return `invoice-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function saveCurrentInvoiceToHistory() {
  const now = new Date().toISOString();
  const id = state.historyId || historyRecordId();
  const existingRecord = invoiceHistory.find((record) => record.id === id);
  const savedInvoice = cloneInvoice({ ...state, historyId: id, draftDirty: false });
  const savedRecord = {
    id,
    createdAt: existingRecord?.createdAt || now,
    updatedAt: now,
    invoice: savedInvoice,
  };
  const nextHistory = [savedRecord, ...invoiceHistory.filter((record) => record.id !== id)];

  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(nextHistory));
  } catch {
    saveStatus.textContent = "Could not save invoice history on this device";
    showToast("The invoice could not be added to history on this device.");
    return false;
  }

  state.historyId = id;
  state.draftDirty = false;
  invoiceHistory = nextHistory;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // The history record is the authoritative saved copy; draft persistence is best effort.
  }
  draftChanged = false;
  saveStatus.textContent = existingRecord ? "Invoice changes saved" : "Invoice saved to history";
  renderInvoiceHistory();
  return true;
}

function createHistoryMeta(label, value) {
  const wrapper = document.createElement("div");
  const term = document.createElement("dt");
  const description = document.createElement("dd");
  term.textContent = label;
  description.textContent = value;
  wrapper.append(term, description);
  return wrapper;
}

function renderInvoiceHistory() {
  const query = historyQuery.trim().toLocaleLowerCase("en-SG");
  const visibleRecords = invoiceHistory.filter((record) => {
    if (!query) return true;
    return `${record.invoice.invoiceNumber} ${record.invoice.billTo}`.toLocaleLowerCase("en-SG").includes(query);
  });

  invoiceHistoryList.replaceChildren();
  visibleRecords.forEach((record) => {
    const invoice = record.invoice;
    const article = document.createElement("article");
    article.className = "invoice-record";
    article.dataset.invoiceId = record.id;

    const identity = document.createElement("div");
    const number = document.createElement("h3");
    const customer = document.createElement("p");
    number.className = "invoice-number";
    number.id = `invoice-title-${record.id}`;
    number.textContent = invoice.invoiceNumber || "Untitled invoice";
    article.setAttribute("aria-labelledby", number.id);
    customer.className = "invoice-customer";
    customer.textContent = invoice.billTo.trim() || "No customer name";
    identity.append(number, customer);

    const meta = document.createElement("dl");
    meta.className = "invoice-record-meta";
    meta.append(
      createHistoryMeta("Invoice date", formatDate(invoice.invoiceDate) || "-"),
      createHistoryMeta("Items", String(invoice.items.length)),
      createHistoryMeta("Total", formatHistoryAmount(invoiceTotalFor(invoice))),
    );

    const actions = document.createElement("div");
    actions.className = "invoice-record-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "button button-secondary";
    edit.dataset.editInvoice = record.id;
    edit.textContent = "Edit";
    edit.setAttribute("aria-label", `Edit invoice ${invoice.invoiceNumber}`);
    const duplicate = document.createElement("button");
    duplicate.type = "button";
    duplicate.className = "button button-secondary";
    duplicate.dataset.duplicateInvoice = record.id;
    duplicate.textContent = "Duplicate";
    duplicate.setAttribute("aria-label", `Duplicate invoice ${invoice.invoiceNumber}`);
    actions.append(edit, duplicate);

    article.append(identity, meta, actions);
    invoiceHistoryList.append(article);
  });

  const total = invoiceHistory.length;
  invoiceCount.textContent = query
    ? `${visibleRecords.length} of ${total} ${total === 1 ? "invoice" : "invoices"}`
    : `${total} ${total === 1 ? "invoice" : "invoices"}`;
  invoiceSearchField.hidden = total < 2;
  historyNewInvoiceButton.hidden = total === 0;
  historyEmptyState.hidden = total !== 0;
  historyNoResults.hidden = total === 0 || visibleRecords.length !== 0;

  const showDraft = hasUnsavedDraft();
  draftNotice.hidden = !showDraft;
  if (showDraft) {
    const customer = state.billTo.trim() || "Untitled invoice";
    draftNoticeSummary.textContent = `${state.invoiceNumber} for ${customer}, ${formatHistoryAmount(invoiceTotal())}`;
  }
}

function clearValidationErrors() {
  form.querySelectorAll('[aria-invalid="true"]').forEach(clearFieldError);
}

function showEditorPage(mode = "new", focusEditor = true) {
  currentPage = "editor";
  document.body.dataset.page = "editor";
  invoiceListPage.hidden = true;
  editorPage.hidden = false;
  invoiceListButton.hidden = false;
  newInvoiceButton.hidden = false;
  printButton.hidden = false;
  editorTitle.textContent = mode === "edit" ? "Edit invoice" : mode === "duplicate" ? "Review duplicated invoice" : "Create an invoice";
  document.title = state.invoiceNumber ? `${state.invoiceNumber} | Invoice Studio` : "Invoice Studio";
  window.scrollTo({ top: 0 });
  requestAnimationFrame(() => {
    updatePreviewScale();
    if (focusEditor) document.querySelector(mode === "edit" ? "#invoiceNumber" : "#billTo")?.focus();
  });
}

function showInvoiceList(focusHeading = true) {
  persistDraftImmediately();
  currentPage = "history";
  document.body.dataset.page = "history";
  editorPage.hidden = true;
  invoiceListPage.hidden = false;
  invoiceListButton.hidden = true;
  newInvoiceButton.hidden = true;
  printButton.hidden = true;
  document.title = "Invoices | Invoice Studio";
  renderInvoiceHistory();
  window.scrollTo({ top: 0 });
  if (focusHeading) document.querySelector("#invoiceListTitle")?.focus({ preventScroll: true });
}

function canReplaceCurrentDraft(message) {
  return !hasUnsavedDraft() || window.confirm(message);
}

function editSavedInvoice(id) {
  const record = invoiceHistory.find((candidate) => candidate.id === id);
  if (!record || !canReplaceCurrentDraft("Open this invoice and replace your unsaved draft?")) return;
  clearTimeout(saveTimer);
  clearValidationErrors();
  state = cloneInvoice(record.invoice);
  state.historyId = record.id;
  draftChanged = false;
  draftPersistenceEnabled = true;
  fillForm();
  persistDraftImmediately();
  saveStatus.textContent = "Saved invoice loaded";
  showEditorPage("edit");
}

function duplicateSavedInvoice(id) {
  const record = invoiceHistory.find((candidate) => candidate.id === id);
  if (!record || !canReplaceCurrentDraft("Duplicate this invoice and replace your unsaved draft?")) return;
  clearTimeout(saveTimer);
  clearValidationErrors();
  const freshInvoice = createInvoiceDraft();
  state = {
    ...cloneInvoice(record.invoice),
    historyId: undefined,
    draftDirty: true,
    invoiceNumber: freshInvoice.invoiceNumber,
    pdfFileName: freshInvoice.invoiceNumber,
    pdfFileNameCustomized: false,
    invoiceDate: freshInvoice.invoiceDate,
    dueDate: freshInvoice.dueDate,
    items: record.invoice.items.map((item, index) => ({
      ...item,
      id: `item-${Date.now()}-${index}-${Math.random().toString(16).slice(2)}`,
    })),
  };
  draftChanged = true;
  draftPersistenceEnabled = true;
  fillForm();
  persistDraftImmediately();
  saveStatus.textContent = "Duplicate ready. Not yet saved.";
  showEditorPage("duplicate");
}

function setText(selector, value) {
  document.querySelector(selector).textContent = value;
}

function fillForm() {
  for (const input of form.querySelectorAll("[data-field]")) {
    input.value = state[input.dataset.field] ?? "";
  }
  renderItemsEditor();
  renderPreview();
}

function createField(className, label, input, id) {
  const wrapper = document.createElement("div");
  wrapper.className = className;
  const visibleLabel = document.createElement("label");
  input.id = id;
  visibleLabel.className = "mobile-field-label";
  visibleLabel.htmlFor = input.id;
  visibleLabel.textContent = label;
  wrapper.append(visibleLabel, input);
  return wrapper;
}

function stripBoldMarkers(value) {
  return String(value || "").replaceAll("**", "");
}

function updateDescriptionValidity(input) {
  input.setCustomValidity(stripBoldMarkers(input.value).trim() ? "" : "Enter an item description.");
}

function toggleBoldFormatting(input) {
  const start = input.selectionStart;
  const end = input.selectionEnd;
  const value = input.value;
  const selected = value.slice(start, end);
  let nextValue;
  let nextStart;
  let nextEnd;

  if (start === end) {
    nextValue = `${value.slice(0, start)}****${value.slice(end)}`;
    nextStart = start + 2;
    nextEnd = nextStart;
  } else if (value.slice(start - 2, start) === "**" && value.slice(end, end + 2) === "**") {
    nextValue = `${value.slice(0, start - 2)}${selected}${value.slice(end + 2)}`;
    nextStart = start - 2;
    nextEnd = end - 2;
  } else if (selected.startsWith("**") && selected.endsWith("**") && selected.length > 4) {
    const unwrapped = selected.slice(2, -2);
    nextValue = `${value.slice(0, start)}${unwrapped}${value.slice(end)}`;
    nextStart = start;
    nextEnd = start + unwrapped.length;
  } else {
    nextValue = `${value.slice(0, start)}**${selected}**${value.slice(end)}`;
    nextStart = start + 2;
    nextEnd = end + 2;
  }

  input.value = nextValue;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.setSelectionRange(nextStart, nextEnd);
}

function renderFormattedDescription(container, value) {
  container.replaceChildren();
  let cursor = 0;

  while (cursor < value.length) {
    const opening = value.indexOf("**", cursor);
    if (opening === -1) {
      container.append(document.createTextNode(value.slice(cursor)));
      break;
    }
    const closing = value.indexOf("**", opening + 2);
    if (closing === -1) {
      container.append(document.createTextNode(value.slice(cursor)));
      break;
    }
    if (opening > cursor) container.append(document.createTextNode(value.slice(cursor, opening)));
    const strong = document.createElement("strong");
    strong.textContent = value.slice(opening + 2, closing);
    container.append(strong);
    cursor = closing + 2;
  }
}

function renderItemsEditor() {
  itemsEditor.replaceChildren();

  state.items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "item-row";
    row.dataset.itemId = item.id;

    const quantity = document.createElement("input");
    quantity.type = "number";
    quantity.min = "1";
    quantity.max = String(MAX_QUANTITY);
    quantity.step = "1";
    quantity.inputMode = "numeric";
    quantity.value = item.quantity;
    quantity.required = true;
    quantity.dataset.itemField = "quantity";
    quantity.setAttribute("aria-label", `Quantity for item ${index + 1}`);
    quantity.addEventListener("keydown", (event) => {
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        const direction = event.key === "ArrowUp" ? 1 : -1;
        const current = quantity.value === "" ? 0 : normalizeQuantity(quantity.value);
        quantity.value = Math.max(1, current + direction);
        quantity.dispatchEvent(new Event("input", { bubbles: true }));
        return;
      }
      if ([".", ",", "e", "E", "+", "-"].includes(event.key)) event.preventDefault();
    });

    const description = document.createElement("textarea");
    description.rows = 2;
    description.value = item.description;
    description.required = true;
    description.dataset.itemField = "description";
    description.setAttribute("aria-label", `Description for item ${index + 1}`);
    description.setAttribute("aria-describedby", "itemFormattingHelp");
    description.setAttribute("aria-keyshortcuts", "Control+B Meta+B");
    updateDescriptionValidity(description);
    description.addEventListener("keydown", (event) => {
      if (event.key.toLowerCase() === "b" && (event.ctrlKey || event.metaKey) && !event.altKey) {
        event.preventDefault();
        toggleBoldFormatting(description);
      }
    });

    const price = document.createElement("input");
    price.type = "number";
    price.min = "0";
    price.max = String(MAX_PRICE);
    price.step = "0.01";
    price.inputMode = "decimal";
    price.value = item.price;
    price.required = true;
    price.dataset.itemField = "price";
    price.setAttribute("aria-label", `Unit price for item ${index + 1}`);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-item";
    remove.dataset.removeItem = item.id;
    remove.disabled = state.items.length === 1;
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove item ${index + 1}`);
    remove.title = remove.disabled ? "At least one item is required" : `Remove item ${index + 1}`;

    const descriptionField = createField("mobile-field description-field", `Item ${index + 1}`, description, `description-${item.id}`);
    const bold = document.createElement("button");
    bold.type = "button";
    bold.className = "item-format-button";
    bold.textContent = "Bold";
    bold.setAttribute("aria-label", `Bold selected text in item ${index + 1}`);
    bold.addEventListener("click", () => {
      toggleBoldFormatting(description);
      description.focus();
    });
    descriptionField.append(bold);

    row.append(
      createField("mobile-field", "Quantity", quantity, `quantity-${item.id}`),
      descriptionField,
      createField("mobile-field", "Unit price (SGD)", price, `price-${item.id}`),
      remove,
    );
    itemsEditor.append(row);
  });

  const addItemButton = document.querySelector("#addItemButton");
  const isAtItemLimit = state.items.length >= 5;
  addItemButton.disabled = isAtItemLimit;
  addItemButton.title = isAtItemLimit ? "Maximum of 5 items reached" : "";
}

function renderPreview() {
  setText("#previewInvoiceNumber", state.invoiceNumber || "");
  setText("#previewInvoiceDate", formatDate(state.invoiceDate));
  setText("#previewDueDate", formatDate(state.dueDate));
  setText("#previewBillTo", state.billTo || "");

  previewItems.replaceChildren();
  state.items.forEach((item, index) => {
    const row = document.createElement("tr");
    const number = document.createElement("td");
    const description = document.createElement("td");
    const symbol = document.createElement("td");
    const amount = document.createElement("td");
    number.textContent = String(index + 1);
    renderFormattedDescription(description, item.description || "");
    symbol.textContent = "$";
    symbol.className = "amount-symbol";
    amount.textContent = formatAmount((Number(item.quantity) || 0) * (Number(item.price) || 0));
    amount.className = "amount-value";
    row.append(number, description, symbol, amount);
    previewItems.append(row);
  });

  const total = invoiceTotal();
  setText("#previewTotal", formatAmount(total));
  setText("#editorTotal", `$${formatAmount(total)}`);
}

function handleFieldInput(event) {
  const field = event.target.dataset.field;
  if (!field) return;
  if (field === "invoiceNumber") {
    const selectionStart = event.target.selectionStart;
    const selectionEnd = event.target.selectionEnd;
    event.target.value = event.target.value.toLocaleUpperCase("en-SG");
    if (selectionStart !== null && selectionEnd !== null) {
      event.target.setSelectionRange(selectionStart, selectionEnd);
    }
  }
  state[field] = event.target.value;
  if (field === "pdfFileName") {
    state.pdfFileNameCustomized = Boolean(event.target.value.trim() && event.target.value !== state.invoiceNumber);
  }
  if (field === "invoiceNumber" && !state.pdfFileNameCustomized) {
    state.pdfFileName = event.target.value;
    document.querySelector("#pdfFileName").value = event.target.value;
  }
  renderPreview();
  saveDraft();
}

function handleItemInput(event) {
  const field = event.target.dataset.itemField;
  if (!field) return;
  const row = event.target.closest(".item-row");
  const item = state.items.find((candidate) => candidate.id === row?.dataset.itemId);
  if (!item) return;
  if (field === "quantity") {
    item.quantity = event.target.value === "" ? "" : Number(event.target.value);
  } else if (field === "price") {
    item.price = event.target.value === "" ? "" : Number(event.target.value);
  } else {
    item.description = event.target.value;
    updateDescriptionValidity(event.target);
  }
  renderPreview();
  saveDraft();
}

function addItem() {
  if (state.items.length >= 5) {
    showToast("The exact one-page template supports up to 5 items.");
    return;
  }
  const item = {
    id: `item-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    quantity: 1,
    description: "",
    price: "",
  };
  state.items.push(item);
  renderItemsEditor();
  renderPreview();
  saveDraft();
  const input = itemsEditor.querySelector(`[data-item-id="${item.id}"] textarea`);
  input?.focus();
}

function removeItem(id) {
  if (state.items.length === 1) return;
  const removedIndex = state.items.findIndex((item) => item.id === id);
  state.items = state.items.filter((item) => item.id !== id);
  renderItemsEditor();
  renderPreview();
  saveDraft();
  const focusIndex = Math.min(removedIndex, state.items.length - 1);
  itemsEditor.querySelectorAll('[data-item-field="description"]')[focusIndex]?.focus();
  showToast(`Item ${removedIndex + 1} removed. ${state.items.length} ${state.items.length === 1 ? "item" : "items"} remaining.`);
}

function isoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function newInvoice() {
  const canUseCurrentBlankDraft = currentPage === "history" && !state.historyId && !hasUnsavedDraft();
  if (canUseCurrentBlankDraft) {
    saveStatus.textContent = "Draft ready";
    showEditorPage("new");
    return;
  }
  if (!canReplaceCurrentDraft("Start a new invoice and replace the current unsaved draft?")) return;
  clearValidationErrors();
  state = createInvoiceDraft();
  draftChanged = false;
  draftPersistenceEnabled = true;
  fillForm();
  saveDraft(false);
  showEditorPage("new");
  showToast("New invoice ready.");
}

function clearSavedDraft() {
  if (!window.confirm("Clear the saved invoice draft from this browser?")) return;
  resetDraft();
  saveStatus.textContent = "Saved draft cleared";
  showToast("Saved draft cleared from this browser.");
}

function resetDraft() {
  clearTimeout(saveTimer);
  localStorage.removeItem(STORAGE_KEY);
  state = createInvoiceDraft();
  draftChanged = false;
  draftPersistenceEnabled = false;
  clearValidationErrors();
  fillForm();
}

function deleteUnsavedDraft() {
  if (!window.confirm("Delete this unsaved draft? This cannot be undone.")) return;
  resetDraft();
  renderInvoiceHistory();
  saveStatus.textContent = "Draft deleted";
  showToast("Unsaved draft deleted.");
}

function hasEnteredContent() {
  return Boolean(
    state.billTo?.trim()
    || state.items.length > 1
    || state.items.some((item) => stripBoldMarkers(item.description).trim() || item.price !== ""),
  );
}

function fieldErrorMessage(input) {
  const messages = {
    invoiceNumber: "Enter an invoice number.",
    invoiceDate: "Choose an invoice date.",
    dueDate: "Choose a due date.",
    billTo: "Enter a customer or company name.",
    quantity: "Enter a whole-number quantity of at least 1.",
    description: "Enter an item description.",
    price: "Enter a price of 0 or more.",
  };
  if (input.dataset.field === "dueDate" && hasInvalidDateOrder()) {
    return "Due date cannot be earlier than the invoice date.";
  }
  return messages[input.dataset.field || input.dataset.itemField] || "Complete this field.";
}

function hasInvalidDateOrder() {
  return Boolean(state.invoiceDate && state.dueDate && state.dueDate < state.invoiceDate);
}

function showFieldError(input) {
  const itemId = input.closest(".item-row")?.dataset.itemId;
  const key = input.dataset.field || `${itemId}-${input.dataset.itemField}`;
  const errorId = `error-${key}`;
  let error = document.getElementById(errorId);
  if (!error) {
    error = document.createElement("p");
    error.id = errorId;
    error.className = "field-error";
    input.parentElement.append(error);
  }
  error.textContent = fieldErrorMessage(input);
  error.dataset.validation = input.dataset.field === "dueDate" && hasInvalidDateOrder() ? "date-order" : "field";
  input.setAttribute("aria-invalid", "true");
  const describedBy = new Set((input.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
  describedBy.add(errorId);
  input.setAttribute("aria-describedby", [...describedBy].join(" "));
}

function clearFieldError(input) {
  const describedBy = (input.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
  const errorIds = describedBy.filter((id) => id.startsWith("error-"));
  errorIds.forEach((id) => document.getElementById(id)?.remove());
  const remaining = describedBy.filter((id) => !errorIds.includes(id));
  if (remaining.length) input.setAttribute("aria-describedby", remaining.join(" "));
  else input.removeAttribute("aria-describedby");
  input.removeAttribute("aria-invalid");
}

function validateForm() {
  form.querySelectorAll('[aria-invalid="true"]').forEach(clearFieldError);
  const invalidInputs = [...form.querySelectorAll("[required]")].filter((input) => !input.validity.valid);
  const dueDate = document.querySelector("#dueDate");
  if (hasInvalidDateOrder() && !invalidInputs.includes(dueDate)) invalidInputs.push(dueDate);
  invalidInputs.forEach(showFieldError);
  return invalidInputs;
}

function viewPreview() {
  const previewPanel = document.querySelector("#preview-panel");
  previewPanel.scrollIntoView({ behavior: "smooth", block: "start" });
  previewPanel.focus({ preventScroll: true });
}

function viewEditor() {
  document.querySelector("#editorTitle").scrollIntoView({ behavior: "smooth", block: "start" });
  document.querySelector("#editorTitle").focus({ preventScroll: true });
}

function invoiceIsReady(action) {
  const invalidInputs = validateForm();
  if (invalidInputs.length) {
    showToast(`Complete the highlighted fields before ${action}.`);
    invalidInputs[0].focus();
    return false;
  }
  if (!Number.isFinite(invoiceTotal())) {
    showToast(`The invoice total is too large. Reduce a quantity or price before ${action}.`);
    return false;
  }
  if (invoiceSheet.scrollHeight > PAPER_HEIGHT + 2 || invoiceSheet.scrollWidth > PAPER_WIDTH + 2) {
    showToast("This invoice is too long for the one-page template. Shorten an item or remove a row.");
    return false;
  }
  return true;
}

function openOutputDialog(event) {
  if (!invoiceIsReady("saving or printing")) return;
  if (!saveCurrentInvoiceToHistory()) return;
  outputDialogTrigger = event.currentTarget;
  outputFileName.textContent = `${safePdfFileName(state.pdfFileName, state.invoiceNumber)}.pdf`;
  outputDialog.showModal();
}

function closeOutputDialog() {
  if (outputBusy) return;
  dismissOutputDialog();
}

function dismissOutputDialog() {
  outputDialog.close();
  if (outputDialogTrigger?.isConnected) outputDialogTrigger.focus();
  outputDialogTrigger = undefined;
}

function setOutputBusy(isBusy) {
  outputBusy = isBusy;
  savePdfButton.disabled = isBusy;
  printNowButton.disabled = isBusy;
  closeOutputDialogButton.disabled = isBusy;
  cancelOutputDialogButton.disabled = isBusy;
  savePdfButtonLabel.textContent = isBusy ? "Creating PDF..." : "Save as PDF";
  outputDialog.setAttribute("aria-busy", String(isBusy));
}

async function downloadInvoicePdf() {
  if (!invoiceIsReady("saving")) {
    dismissOutputDialog();
    return;
  }
  if (typeof window.html2pdf !== "function") {
    showToast("PDF saving is unavailable. Reload the app and try again.");
    return;
  }

  const pdfBaseName = safePdfFileName(state.pdfFileName, state.invoiceNumber);
  const pdfFileName = `${pdfBaseName}.pdf`;
  const exportSheet = invoiceSheet.cloneNode(true);
  exportSheet.removeAttribute("id");
  exportSheet.style.width = `${Math.floor(PAPER_WIDTH)}px`;
  exportSheet.style.minHeight = `${Math.floor(PAPER_HEIGHT) - 1}px`;
  exportSheet.style.margin = "0";
  exportSheet.style.boxShadow = "none";
  exportSheet.style.transform = "none";

  setOutputBusy(true);
  try {
    const worker = window
      .html2pdf()
      .set({
        margin: 0,
        filename: pdfFileName,
        image: { type: "jpeg", quality: 0.98 },
        html2canvas: { backgroundColor: "#ffffff", scale: 2, useCORS: true },
        jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      })
      .from(exportSheet)
      .toPdf();
    await worker
      .get("pdf")
      .then((pdf) => {
        pdf.setProperties({
          title: pdfBaseName,
          subject: `Invoice ${state.invoiceNumber}`,
          author: "Eng Hoon Residences",
          creator: "Eng Hoon Residences Invoice Studio",
        });
      })
      .save();
    dismissOutputDialog();
    showToast(`${pdfFileName} saved.`);
  } catch {
    showToast("The PDF could not be created. Try again or use Print.");
  } finally {
    setOutputBusy(false);
  }
}

function printInvoice() {
  if (!invoiceIsReady("printing")) {
    dismissOutputDialog();
    return;
  }
  dismissOutputDialog();
  const previousTitle = document.title;
  document.title = `${safePdfFileName(state.pdfFileName, state.invoiceNumber)}.pdf`;
  window.print();
  window.setTimeout(() => {
    document.title = previousTitle;
  }, 500);
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 3200);
}

function updatePreviewScale() {
  const stageStyles = window.getComputedStyle(previewStage);
  const horizontalPadding = Number.parseFloat(stageStyles.paddingLeft) + Number.parseFloat(stageStyles.paddingRight);
  const availableWidth = Math.max(1, previewStage.clientWidth - horizontalPadding);
  const scale = previewScaleMode === "actual" ? 1 : Math.min(1, availableWidth / PAPER_WIDTH);
  invoiceSheet.style.transform = `scale(${scale})`;
  paperScaleWrap.style.width = `${PAPER_WIDTH * scale}px`;
  paperScaleWrap.style.height = `${PAPER_HEIGHT * scale}px`;
}

function setPreviewScaleMode(mode) {
  previewScaleMode = mode;
  fitPreviewButton.setAttribute("aria-pressed", String(mode === "fit"));
  actualSizePreviewButton.setAttribute("aria-pressed", String(mode === "actual"));
  updatePreviewScale();
}

function updateConnectionStatus() {
  offlineBanner.hidden = navigator.onLine;
}

form.addEventListener("input", handleFieldInput);
form.addEventListener("input", (event) => {
  if (event.target.matches("[required]") && event.target.validity.valid) clearFieldError(event.target);
  if (event.target.id === "invoiceDate" || event.target.id === "dueDate") {
    const dueDate = document.querySelector("#dueDate");
    const dueDateError = document.querySelector("#error-dueDate");
    if (!state.invoiceDate || !state.dueDate) {
      if (dueDateError?.dataset.validation === "date-order") clearFieldError(dueDate);
      return;
    }
    if (hasInvalidDateOrder()) {
      if (dueDate.getAttribute("aria-invalid") === "true") showFieldError(dueDate);
      return;
    }
    if (dueDateError?.dataset.validation === "date-order") clearFieldError(dueDate);
  }
});
itemsEditor.addEventListener("input", handleItemInput);
itemsEditor.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-item]");
  if (button) removeItem(button.dataset.removeItem);
});
document.querySelector("#addItemButton").addEventListener("click", addItem);
newInvoiceButton.addEventListener("click", newInvoice);
document.querySelector("#mobileNewInvoiceButton").addEventListener("click", newInvoice);
historyNewInvoiceButton.addEventListener("click", newInvoice);
document.querySelector("#emptyStateNewInvoiceButton").addEventListener("click", newInvoice);
document.querySelector("#continueDraftButton").addEventListener("click", () => {
  const mode = state.historyId ? "edit" : "new";
  fillForm();
  saveStatus.textContent = "Draft restored";
  showEditorPage(mode);
});
document.querySelector("#deleteDraftButton").addEventListener("click", deleteUnsavedDraft);
invoiceListButton.addEventListener("click", () => showInvoiceList());
invoiceHistoryList.addEventListener("click", (event) => {
  const editButton = event.target.closest("[data-edit-invoice]");
  if (editButton) {
    editSavedInvoice(editButton.dataset.editInvoice);
    return;
  }
  const duplicateButton = event.target.closest("[data-duplicate-invoice]");
  if (duplicateButton) duplicateSavedInvoice(duplicateButton.dataset.duplicateInvoice);
});
invoiceSearch.addEventListener("input", () => {
  historyQuery = invoiceSearch.value;
  renderInvoiceHistory();
});
document.querySelector("#clearDraftButton").addEventListener("click", clearSavedDraft);
printButton.addEventListener("click", openOutputDialog);
document.querySelector("#mobilePrintButton").addEventListener("click", openOutputDialog);
document.querySelector("#mobileViewPreviewButton").addEventListener("click", viewPreview);
fitPreviewButton.addEventListener("click", () => setPreviewScaleMode("fit"));
actualSizePreviewButton.addEventListener("click", () => setPreviewScaleMode("actual"));
backToEditorButton.addEventListener("click", viewEditor);
savePdfButton.addEventListener("click", downloadInvoicePdf);
printNowButton.addEventListener("click", printInvoice);
closeOutputDialogButton.addEventListener("click", closeOutputDialog);
cancelOutputDialogButton.addEventListener("click", closeOutputDialog);
outputDialog.addEventListener("cancel", (event) => {
  if (outputBusy) event.preventDefault();
});
outputDialog.addEventListener("click", (event) => {
  if (event.target === outputDialog) closeOutputDialog();
});
outputDialog.addEventListener("close", () => {
  if (outputDialogTrigger?.isConnected) outputDialogTrigger.focus();
  outputDialogTrigger = undefined;
});

window.addEventListener("online", updateConnectionStatus);
window.addEventListener("offline", updateConnectionStatus);
window.addEventListener("pagehide", persistDraftImmediately);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") persistDraftImmediately();
});
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  installPrompt = event;
  installButton.hidden = false;
});
window.addEventListener("appinstalled", () => {
  installButton.hidden = true;
  installPrompt = undefined;
  showToast("Invoice Studio installed.");
});

installButton.addEventListener("click", async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = undefined;
  installButton.hidden = true;
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      showToast("Offline setup could not be completed.");
    });
  });
}

const previewObserver = new ResizeObserver(updatePreviewScale);
previewObserver.observe(previewStage);
window.addEventListener("beforeprint", () => {
  invoiceSheet.style.transform = "none";
});
window.addEventListener("afterprint", updatePreviewScale);

fillForm();
updateConnectionStatus();
updatePreviewScale();
showInvoiceList(false);
