const STORAGE_KEY = "invoice-studio-draft-v1";
const SEQUENCE_KEY = "invoice-studio-sequence-v1";
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

let state = loadDraft() ?? createInvoiceDraft();
let saveTimer;
let toastTimer;
let installPrompt;
let draftPersistenceEnabled = true;
let draftChanged = false;

function loadDraft() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.items) || parsed.items.length === 0) return null;
    parsed.items = parsed.items.slice(0, 5).map((item) => ({
      ...item,
      quantity: normalizeQuantity(item.quantity),
      price: Number(item.price) === 0 && !String(item.description || "").trim() ? "" : item.price,
    }));
    return parsed;
  } catch {
    return null;
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
  return {
    invoiceNumber: nextInvoiceNumber(today),
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
  if (markChanged) draftChanged = true;
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
  return Number.isFinite(numeric) ? numeric.toFixed(2) : "—";
}

function invoiceTotal() {
  return state.items.reduce((total, item) => total + (Number(item.quantity) || 0) * (Number(item.price) || 0), 0);
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

function createField(className, label, input) {
  const wrapper = document.createElement("div");
  wrapper.className = className;
  wrapper.dataset.label = label;
  wrapper.append(input);
  return wrapper;
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
    quantity.value = normalizeQuantity(item.quantity);
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

    row.append(
      createField("mobile-field", "Quantity", quantity),
      createField("mobile-field", "Item", description),
      createField("mobile-field", "Price", price),
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
    description.textContent = item.description || "";
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
  state[field] = event.target.value;
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
  if ((draftChanged || hasEnteredContent()) && !window.confirm("Start a new invoice and replace the current draft?")) return;
  state = createInvoiceDraft();
  draftChanged = false;
  fillForm();
  saveDraft(false);
  document.querySelector("#billTo").focus();
  showToast("New invoice ready.");
}

function clearSavedDraft() {
  if (!window.confirm("Clear the saved invoice draft from this browser?")) return;
  clearTimeout(saveTimer);
  localStorage.removeItem(STORAGE_KEY);
  state = createInvoiceDraft();
  draftChanged = false;
  draftPersistenceEnabled = false;
  fillForm();
  saveStatus.textContent = "Saved draft cleared";
  showToast("Saved draft cleared from this browser.");
}

function hasEnteredContent() {
  return Boolean(
    state.billTo?.trim()
    || state.items.length > 1
    || state.items.some((item) => item.description?.trim() || item.price !== ""),
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
  return messages[input.dataset.field || input.dataset.itemField] || "Complete this field.";
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
  invalidInputs.forEach(showFieldError);
  return invalidInputs;
}

function printInvoice() {
  const invalidInputs = validateForm();
  if (invalidInputs.length) {
    showToast("Complete the highlighted fields before printing.");
    invalidInputs[0].focus();
    return;
  }
  if (!Number.isFinite(invoiceTotal())) {
    showToast("The invoice total is too large. Reduce a quantity or price before printing.");
    return;
  }
  if (invoiceSheet.scrollHeight > PAPER_HEIGHT + 2 || invoiceSheet.scrollWidth > PAPER_WIDTH + 2) {
    showToast("This invoice is too long for the one-page template. Shorten an item or remove a row.");
    return;
  }
  document.title = `${state.invoiceNumber || "invoice"}.pdf`;
  window.print();
  window.setTimeout(() => {
    document.title = "Invoice Studio";
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
  const scale = Math.min(1, availableWidth / PAPER_WIDTH);
  invoiceSheet.style.transform = `scale(${scale})`;
  paperScaleWrap.style.width = `${PAPER_WIDTH * scale}px`;
  paperScaleWrap.style.height = `${PAPER_HEIGHT * scale}px`;
}

function updateConnectionStatus() {
  offlineBanner.hidden = navigator.onLine;
}

form.addEventListener("input", handleFieldInput);
form.addEventListener("input", (event) => {
  if (event.target.matches("[required]") && event.target.validity.valid) clearFieldError(event.target);
});
itemsEditor.addEventListener("input", handleItemInput);
itemsEditor.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove-item]");
  if (button) removeItem(button.dataset.removeItem);
});
document.querySelector("#addItemButton").addEventListener("click", addItem);
document.querySelector("#newInvoiceButton").addEventListener("click", newInvoice);
document.querySelector("#mobileNewInvoiceButton").addEventListener("click", newInvoice);
document.querySelector("#clearDraftButton").addEventListener("click", clearSavedDraft);
document.querySelector("#printButton").addEventListener("click", printInvoice);
document.querySelector("#mobilePrintButton").addEventListener("click", printInvoice);

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
