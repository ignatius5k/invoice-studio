const STORAGE_KEY = "invoice-studio-draft-v1";
const SEQUENCE_KEY = "invoice-studio-sequence-v1";
const HISTORY_KEY = "invoice-studio-history-v1";
const PAPER_WIDTH = 793.7;
const PAPER_HEIGHT = 1122.52;
const MAX_QUANTITY = 9999;
const MAX_PRICE = 999999999.99;
const MAX_ITEM_DESCRIPTION_LENGTH = 1000;
const MAX_BILL_TO_LENGTH = 2000;
const HISTORY_PAGE_SIZE = 25;
const DRAFT_RETRY_MAX_DELAY = 30000;
const PDF_LIBRARY_URL = "./vendor/html2pdf.bundle.min.js?v=27";
const backend = window.invoiceBackend;
const draftOutbox = window.invoiceDraftOutbox;

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
const historySection = document.querySelector("#historySection");
const historyLoadingState = document.querySelector("#historyLoadingState");
const historyErrorState = document.querySelector("#historyErrorState");
const retryHistoryButton = document.querySelector("#retryHistoryButton");
const loadMoreInvoicesButton = document.querySelector("#loadMoreInvoicesButton");
const draftNotice = document.querySelector("#draftNotice");
const draftNoticeSummary = document.querySelector("#draftNoticeSummary");
const authPage = document.querySelector("#authPage");
const authConfigurationState = document.querySelector("#authConfigurationState");
const authSignInState = document.querySelector("#authSignInState");
const authForm = document.querySelector("#authForm");
const authEmail = document.querySelector("#authEmail");
const authPassword = document.querySelector("#authPassword");
const authMessage = document.querySelector("#authMessage");
const createAccountButton = document.querySelector("#createAccountButton");
const forgotPasswordButton = document.querySelector("#forgotPasswordButton");
const passwordRecoveryForm = document.querySelector("#passwordRecoveryForm");
const recoveryPassword = document.querySelector("#recoveryPassword");
const recoveryPasswordConfirm = document.querySelector("#recoveryPasswordConfirm");
const accountControls = document.querySelector("#accountControls");
const accountEmail = document.querySelector("#accountEmail");
const syncStatus = document.querySelector("#syncStatus");
const signOutButton = document.querySelector("#signOutButton");
const legacyMigrationDialog = document.querySelector("#legacyMigrationDialog");
const legacyMigrationSummary = document.querySelector("#legacyMigrationSummary");
const legacyMigrationDestination = document.querySelector("#legacyMigrationDestination");
const legacyMigrationMessage = document.querySelector("#legacyMigrationMessage");
const moveLegacyDataButton = document.querySelector("#moveLegacyDataButton");
const exportLegacyDataButton = document.querySelector("#exportLegacyDataButton");
const discardLegacyDataButton = document.querySelector("#discardLegacyDataButton");
const cancelLegacyMigrationButton = document.querySelector("#cancelLegacyMigrationButton");
const draftConflictDialog = document.querySelector("#draftConflictDialog");
const localDraftConflictSummary = document.querySelector("#localDraftConflictSummary");
const cloudDraftConflictSummary = document.querySelector("#cloudDraftConflictSummary");
const keepLocalDraftButton = document.querySelector("#keepLocalDraftButton");
const keepCloudDraftButton = document.querySelector("#keepCloudDraftButton");

let state = createInvoiceDraft();
let invoiceHistory = [];
let saveTimer;
let toastTimer;
let installPrompt;
let draftPersistenceEnabled = true;
let draftChanged = false;
let outputBusy = false;
let outputDialogTrigger;
let currentPage = "history";
let historyQuery = "";
let historyNextCursor;
let historyTotal = 0;
let historyLoading = false;
let historyLoadError = false;
let historyRequestVersion = 0;
let historySearchTimer;
let previewScaleMode = "fit";
let currentUser;
let workspaceLoading = false;
let draftWriteQueue = Promise.resolve();
let outboxWriteQueue = Promise.resolve();
let draftSaveVersion = 0;
let draftRevision;
let draftWriteAbortController = new AbortController();
let sessionEpoch = 0;
let pendingLegacyMigration;
let resolveLegacyMigration;
let draftRetryTimer;
let draftSyncPromise;
let draftConflictOperation;
let draftConflictRemote;
let resolveDraftConflictChoice;
let pdfLibraryPromise;
let authBusy = false;
let pendingAuthEmailRequest = "";
let pendingAuthEmailRequestUntil = 0;
let authEmailRequestsBlockedUntil = 0;

function normalizeInvoiceData(value) {
  if (!value || !Array.isArray(value.items) || value.items.length === 0) return null;
  const invoiceNumber = String(value.invoiceNumber || "").toLocaleUpperCase("en-SG").slice(0, 120);
  const savedPdfFileName = String(value.pdfFileName || "").trim().slice(0, 120);
  return {
    historyId: typeof value.historyId === "string" ? value.historyId.slice(0, 160) : undefined,
    draftDirty: Boolean(value.draftDirty),
    invoiceNumber,
    pdfFileName: savedPdfFileName || invoiceNumber || "invoice",
    pdfFileNameCustomized: Boolean(savedPdfFileName && savedPdfFileName !== invoiceNumber),
    invoiceDate: String(value.invoiceDate || ""),
    dueDate: String(value.dueDate || ""),
    billTo: String(value.billTo || "").slice(0, MAX_BILL_TO_LENGTH),
    items: value.items.slice(0, 5).map((item, index) => ({
      id: String(item?.id || `item-${Date.now()}-${index}`).slice(0, 160),
      quantity: normalizeDraftQuantity(item?.quantity),
      description: String(item?.description || "").slice(0, MAX_ITEM_DESCRIPTION_LENGTH),
      price: normalizeDraftPrice(item?.price),
    })),
  };
}

function normalizeDraftQuantity(value) {
  if (value === "" || value === null || value === undefined) return "";
  const quantity = Number(value);
  return Number.isFinite(quantity) ? quantity : "";
}

function normalizeDraftPrice(value) {
  if (value === "" || value === null || value === undefined) return "";
  const price = Number(value);
  return Number.isFinite(price) ? price : "";
}

function loadLegacyDraft() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return normalizeInvoiceData(JSON.parse(raw));
  } catch {
    return null;
  }
}

function loadLegacyInvoiceHistory() {
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

function setAuthMessage(message = "", stateName = "") {
  authMessage.textContent = message;
  if (stateName) authMessage.dataset.state = stateName;
  else authMessage.removeAttribute("data-state");
}

function normalizeAuthEmail(value) {
  return String(value || "").trim().toLocaleLowerCase("en-SG");
}

function updateAuthEmailActions() {
  if (authBusy) return;
  if (authEmailRequestsBlockedUntil <= Date.now()) authEmailRequestsBlockedUntil = 0;
  if (pendingAuthEmailRequestUntil <= Date.now()) {
    pendingAuthEmailRequest = "";
    pendingAuthEmailRequestUntil = 0;
  }
  const emailRequestPending = authEmailRequestsBlockedUntil > Date.now() || Boolean(
    pendingAuthEmailRequest && normalizeAuthEmail(authEmail.value) === pendingAuthEmailRequest,
  );
  createAccountButton.disabled = emailRequestPending;
  forgotPasswordButton.disabled = emailRequestPending;
}

function markAuthEmailRequested(email, retrySeconds = 60) {
  pendingAuthEmailRequest = normalizeAuthEmail(email);
  pendingAuthEmailRequestUntil = Date.now() + Math.max(1, retrySeconds) * 1000;
  window.setTimeout(updateAuthEmailActions, Math.max(1, retrySeconds) * 1000);
  updateAuthEmailActions();
}

function blockAuthEmailRequests(retrySeconds = 3600) {
  authEmailRequestsBlockedUntil = Date.now() + Math.max(1, retrySeconds) * 1000;
  window.setTimeout(updateAuthEmailActions, Math.max(1, retrySeconds) * 1000);
  updateAuthEmailActions();
}

function authEmailRetrySeconds(error) {
  return Number(String(error?.message || "").match(/after\s+(\d+)\s+seconds?/i)?.[1]) || 0;
}

function authFailureMessage(error, action) {
  const code = String(error?.code || "");
  if (code === "email_not_confirmed") {
    return "Confirm your email before signing in. Use the newest confirmation email, then return here.";
  }
  if (code === "over_email_send_rate_limit") {
    const retrySeconds = authEmailRetrySeconds(error);
    return retrySeconds
      ? `A confirmation or reset email was requested too recently. Wait ${retrySeconds} seconds and use the newest email.`
      : "This app's shared Supabase email limit has been reached. It applies across all email addresses. Use the newest email already received, or try again after the hourly allowance resets.";
  }
  if (Number(error?.status) === 429 || code === "over_request_rate_limit") {
    return action === "sign-in"
      ? "Too many sign-in attempts were made. Wait a few minutes before trying again."
      : "Too many requests were made. Wait a few minutes before trying again.";
  }
  if (code === "invalid_credentials") {
    return "The email or password is incorrect.";
  }
  return error?.message || (action === "sign-in"
    ? "Sign-in failed. Check your email and password."
    : "The authentication request could not be completed.");
}

function setAuthBusy(isBusy) {
  authBusy = isBusy;
  for (const button of authPage.querySelectorAll("button")) button.disabled = isBusy;
  authPage.setAttribute("aria-busy", String(isBusy));
  if (!isBusy) updateAuthEmailActions();
}

function neutralizeDraftWrites() {
  clearTimeout(saveTimer);
  clearTimeout(draftRetryTimer);
  draftSaveVersion += 1;
  sessionEpoch += 1;
  draftPersistenceEnabled = false;
  draftChanged = false;
  draftRevision = undefined;
  draftWriteAbortController.abort();
  draftWriteAbortController = new AbortController();
  draftWriteQueue = Promise.resolve();
  draftSyncPromise = undefined;
}

function clearCredentialInputs() {
  authEmail.value = "";
  authPassword.value = "";
  recoveryPassword.value = "";
  recoveryPasswordConfirm.value = "";
  recoveryPasswordConfirm.setCustomValidity("");
}

function finishLegacyMigrationPrompt(action) {
  const resolve = resolveLegacyMigration;
  resolveLegacyMigration = undefined;
  pendingLegacyMigration = undefined;
  if (legacyMigrationDialog.open) legacyMigrationDialog.close();
  if (resolve) resolve(action);
}

function clearSensitiveWorkspace() {
  neutralizeDraftWrites();
  invoiceHistory = [];
  historyNextCursor = undefined;
  historyTotal = 0;
  historyLoading = false;
  historyLoadError = false;
  historyRequestVersion += 1;
  historyQuery = "";
  invoiceSearch.value = "";
  state = createInvoiceDraft();
  state.draftDirty = false;
  currentPage = "history";
  clearValidationErrors();
  fillForm();
  renderInvoiceHistory();
  outputFileName.textContent = "";
  accountEmail.textContent = "";
  setDraftSyncStatus("synced", "All changes synced");
  if (outputDialog.open) outputDialog.close();
  if (draftConflictDialog.open) draftConflictDialog.close();
  resolveDraftConflictChoice?.("signed-out");
  resolveDraftConflictChoice = undefined;
  draftConflictOperation = undefined;
  draftConflictRemote = undefined;
  finishLegacyMigrationPrompt("signed-out");
  clearCredentialInputs();
}

function hideWorkspace() {
  invoiceListPage.hidden = true;
  editorPage.hidden = true;
  invoiceListButton.hidden = true;
  newInvoiceButton.hidden = true;
  printButton.hidden = true;
}

function showSignedOutPage() {
  currentUser = undefined;
  clearSensitiveWorkspace();
  hideWorkspace();
  accountControls.hidden = true;
  authPage.hidden = false;
  authConfigurationState.hidden = true;
  authSignInState.hidden = false;
  passwordRecoveryForm.hidden = true;
  authPage.setAttribute("aria-labelledby", "authTitle");
  document.body.dataset.page = "auth";
  document.title = "Sign in | Invoice Studio";
  setAuthMessage();
  authEmail.focus({ preventScroll: true });
}

function showConfigurationPage() {
  currentUser = undefined;
  clearSensitiveWorkspace();
  hideWorkspace();
  accountControls.hidden = true;
  authPage.hidden = false;
  authConfigurationState.hidden = false;
  authSignInState.hidden = true;
  passwordRecoveryForm.hidden = true;
  authPage.setAttribute("aria-labelledby", "configurationTitle");
  document.body.dataset.page = "auth";
  document.title = "Connect Supabase | Invoice Studio";
  setAuthMessage();
}

function showPasswordRecoveryPage() {
  hideWorkspace();
  authPage.hidden = false;
  authConfigurationState.hidden = true;
  authSignInState.hidden = true;
  passwordRecoveryForm.hidden = false;
  authPage.setAttribute("aria-labelledby", "recoveryTitle");
  document.body.dataset.page = "auth";
  document.title = "Set a new password | Invoice Studio";
  setAuthMessage();
  recoveryPassword.focus({ preventScroll: true });
}

function legacyStorageData() {
  const hasLegacyDraft = localStorage.getItem(STORAGE_KEY) !== null;
  const hasLegacyHistory = localStorage.getItem(HISTORY_KEY) !== null;
  const hasLegacySequence = localStorage.getItem(SEQUENCE_KEY) !== null;
  return {
    present: hasLegacyDraft || hasLegacyHistory || hasLegacySequence,
    draft: loadLegacyDraft(),
    records: loadLegacyInvoiceHistory(),
  };
}

function clearLegacyStorage() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(HISTORY_KEY);
  localStorage.removeItem(SEQUENCE_KEY);
}

function legacyExportValue(key) {
  const raw = localStorage.getItem(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { unreadableRawValue: raw };
  }
}

function exportLegacyBrowserData() {
  const backup = {
    exportedAt: new Date().toISOString(),
    source: "Eng Hoon Residences Invoice Studio browser storage",
    history: legacyExportValue(HISTORY_KEY),
    draft: legacyExportValue(STORAGE_KEY),
    sequence: legacyExportValue(SEQUENCE_KEY),
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `invoice-studio-local-backup-${isoDate(new Date())}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  legacyMigrationMessage.textContent = "Backup downloaded. Choose whether to move, discard, or keep the local data.";
}

function setLegacyMigrationBusy(isBusy) {
  for (const button of legacyMigrationDialog.querySelectorAll("button")) button.disabled = isBusy;
  legacyMigrationDialog.setAttribute("aria-busy", String(isBusy));
}

function promptForLegacyMigration(session) {
  const legacy = legacyStorageData();
  if (!legacy.present) return Promise.resolve("none");

  pendingLegacyMigration = { ...legacy, userId: session.user.id };
  const invoiceCount = legacy.records.length;
  const parts = [`${invoiceCount} saved ${invoiceCount === 1 ? "invoice" : "invoices"}`];
  if (legacy.draft) parts.push("1 draft");
  if (invoiceCount === 0 && !legacy.draft) parts.push("unreadable local data");
  legacyMigrationSummary.textContent = parts.join(" and ");
  legacyMigrationDestination.textContent = session.user.email || "this signed-in account";
  legacyMigrationMessage.textContent = "Nothing has been moved yet.";
  legacyMigrationMessage.removeAttribute("data-state");
  setLegacyMigrationBusy(false);
  moveLegacyDataButton.disabled = invoiceCount === 0 && !legacy.draft;
  legacyMigrationDialog.showModal();
  return new Promise((resolve) => {
    resolveLegacyMigration = resolve;
  });
}

async function moveLegacyBrowserData() {
  if (!pendingLegacyMigration) return;
  setLegacyMigrationBusy(true);
  legacyMigrationMessage.textContent = "Moving the selected local data...";
  try {
    await backend.migrateLocalData(
      pendingLegacyMigration.userId,
      pendingLegacyMigration.records,
      pendingLegacyMigration.draft,
    );
    clearLegacyStorage();
    finishLegacyMigrationPrompt("moved");
  } catch (error) {
    setLegacyMigrationBusy(false);
    legacyMigrationMessage.textContent = error?.message || "The local data could not be moved. It is still stored in this browser.";
    legacyMigrationMessage.dataset.state = "error";
  }
}

function discardLegacyBrowserData() {
  clearLegacyStorage();
  finishLegacyMigrationPrompt("discarded");
}

async function cancelLegacyMigration() {
  finishLegacyMigrationPrompt("cancelled");
}

function setDraftSyncStatus(stateName, message) {
  syncStatus.textContent = message;
  syncStatus.dataset.state = stateName;
}

function draftSummary(invoice, fallback = "No cloud draft") {
  if (!invoice) return fallback;
  const customer = String(invoice.billTo || "").trim() || "Untitled invoice";
  return `${invoice.invoiceNumber || "Draft"} for ${customer}`;
}

function promptForDraftConflict(operation, remoteDraftRecord) {
  draftConflictOperation = operation;
  draftConflictRemote = remoteDraftRecord;
  localDraftConflictSummary.textContent = operation.type === "delete"
    ? "Delete the cloud draft"
    : draftSummary(operation.invoice);
  cloudDraftConflictSummary.textContent = draftSummary(remoteDraftRecord?.invoice);
  setDraftSyncStatus("conflict", "Draft sync needs your choice");
  if (!draftConflictDialog.open) draftConflictDialog.showModal();
  return new Promise((resolve) => {
    resolveDraftConflictChoice = resolve;
  });
}

function finishDraftConflictChoice(choice) {
  const resolve = resolveDraftConflictChoice;
  resolveDraftConflictChoice = undefined;
  if (draftConflictDialog.open) draftConflictDialog.close();
  if (resolve) resolve(choice);
}

function retryDelay(attempts) {
  return Math.min(DRAFT_RETRY_MAX_DELAY, 1000 * (2 ** Math.min(Math.max(0, attempts - 1), 5)));
}

function scheduleDraftRetry(delay) {
  clearTimeout(draftRetryTimer);
  if (!currentUser) return;
  draftRetryTimer = window.setTimeout(() => flushDraftOutbox(), Math.max(0, delay));
}

function stageDraftSave() {
  if (!draftPersistenceEnabled || !currentUser) return Promise.resolve(null);
  const userId = currentUser.id;
  const snapshot = cloneInvoice(state);
  const expectedRevision = draftRevision;
  outboxWriteQueue = outboxWriteQueue
    .catch(() => {})
    .then(() => draftOutbox.putSave(userId, snapshot, expectedRevision))
    .then((operation) => {
      if (currentUser?.id === userId) setDraftSyncStatus("waiting", "Saved on this device. Waiting to sync");
      return operation;
    })
    .catch((error) => {
      if (currentUser?.id === userId) setDraftSyncStatus("error", "Draft could not be saved on this device");
      throw error;
    });
  return outboxWriteQueue;
}

function stageDraftDelete() {
  if (!currentUser) return Promise.resolve(null);
  const userId = currentUser.id;
  const expectedRevision = draftRevision;
  outboxWriteQueue = outboxWriteQueue
    .catch(() => {})
    .then(() => draftOutbox.putDelete(userId, expectedRevision))
    .then((operation) => {
      if (currentUser?.id === userId) setDraftSyncStatus("waiting", "Draft deletion waiting to sync");
      return operation;
    });
  return outboxWriteQueue;
}

async function applyDraftConflictChoice(operation, remoteDraftRecord, choice) {
  const userId = operation.userId;
  if (choice === "local") {
    const rebased = await draftOutbox.rebase(userId, operation.operationId, remoteDraftRecord?.revision);
    if (rebased?.type === "save") {
      state = normalizeInvoiceData(rebased.invoice) || state;
      draftChanged = Boolean(state.draftDirty);
      draftPersistenceEnabled = true;
      fillForm();
      renderInvoiceHistory();
    }
    draftRevision = remoteDraftRecord?.revision;
    setDraftSyncStatus("waiting", "Saved on this device. Waiting to sync");
    scheduleDraftRetry(0);
    return;
  }

  await draftOutbox.remove(userId, operation.operationId);
  draftRevision = remoteDraftRecord?.revision;
  if (remoteDraftRecord?.invoice) {
    state = normalizeInvoiceData(remoteDraftRecord.invoice) || state;
    draftChanged = Boolean(state.draftDirty);
    draftPersistenceEnabled = true;
  } else {
    state = await createCloudInvoiceDraft();
    state.draftDirty = false;
    draftChanged = false;
    draftPersistenceEnabled = false;
  }
  fillForm();
  renderInvoiceHistory();
  setDraftSyncStatus("synced", "All changes synced");
}

async function handleDraftConflict(operation) {
  if (!currentUser || currentUser.id !== operation.userId) return;
  let remoteDraftRecord;
  try {
    remoteDraftRecord = await backend.loadDraft(operation.userId);
  } catch {
    const attempts = Number(operation.attempts || 0) + 1;
    const delay = retryDelay(attempts);
    await draftOutbox.markRetry(operation.userId, operation.operationId, attempts, Date.now() + delay, "Could not load cloud draft.");
    setDraftSyncStatus("error", "Draft safe on this device. Sync retrying");
    scheduleDraftRetry(delay);
    return;
  }
  const choice = await promptForDraftConflict(operation, remoteDraftRecord);
  if (choice === "signed-out") return;
  await applyDraftConflictChoice(operation, remoteDraftRecord, choice);
}

async function runDraftOutboxSync(force = false) {
  if (!currentUser) return true;
  const userId = currentUser.id;
  await outboxWriteQueue.catch(() => {});
  const operation = await draftOutbox.get(userId);
  if (!operation) {
    setDraftSyncStatus("synced", "All changes synced");
    return true;
  }
  if (!navigator.onLine) {
    setDraftSyncStatus("waiting", "Saved on this device. Waiting to sync");
    return false;
  }
  if (!force && operation.nextAttemptAt > Date.now()) {
    setDraftSyncStatus("waiting", "Draft safe on this device. Sync retrying");
    scheduleDraftRetry(operation.nextAttemptAt - Date.now());
    return false;
  }

  setDraftSyncStatus("syncing", operation.type === "delete" ? "Deleting cloud draft..." : "Syncing draft...");
  const expectedRevision = Number.isInteger(operation.expectedRevision) ? operation.expectedRevision : undefined;
  try {
    const result = operation.type === "delete"
      ? await backend.deleteDraft(userId, undefined, expectedRevision)
      : await backend.saveDraft(userId, operation.invoice, undefined, expectedRevision);
    const nextRevision = operation.type === "delete" ? undefined : result?.revision;
    await draftOutbox.remove(userId, operation.operationId);
    const newerOperation = await draftOutbox.get(userId);
    if (newerOperation && newerOperation.operationId !== operation.operationId) {
      await draftOutbox.rebase(userId, newerOperation.operationId, nextRevision);
      scheduleDraftRetry(0);
      setDraftSyncStatus("waiting", "Saved on this device. Waiting to sync");
    } else {
      draftRevision = nextRevision;
      const time = new Intl.DateTimeFormat("en-SG", { hour: "numeric", minute: "2-digit" }).format(new Date());
      setDraftSyncStatus("synced", `Synced ${time}`);
      saveStatus.textContent = `Saved ${time}`;
    }
    return true;
  } catch (error) {
    if (error?.code === "DRAFT_REVISION_CONFLICT") {
      await handleDraftConflict(operation);
      return false;
    }
    const attempts = Number(operation.attempts || 0) + 1;
    const delay = retryDelay(attempts);
    await draftOutbox.markRetry(userId, operation.operationId, attempts, Date.now() + delay, error?.message);
    setDraftSyncStatus("error", "Draft safe on this device. Sync retrying");
    saveStatus.textContent = "Saved on this device";
    scheduleDraftRetry(delay);
    return false;
  }
}

function flushDraftOutbox(options = {}) {
  if (draftSyncPromise) return draftSyncPromise;
  draftSyncPromise = runDraftOutboxSync(Boolean(options.force))
    .finally(() => {
      draftSyncPromise = undefined;
    });
  return draftSyncPromise;
}

async function reconcileDraftOutbox(userId, remoteDraftRecord) {
  const operation = await draftOutbox.get(userId);
  if (!operation) return remoteDraftRecord;

  if (operation.type === "delete") {
    if (!remoteDraftRecord) {
      await draftOutbox.remove(userId, operation.operationId);
      setDraftSyncStatus("synced", "All changes synced");
      return null;
    }
    if (operation.expectedRevision === remoteDraftRecord.revision) {
      draftRevision = remoteDraftRecord.revision;
      setDraftSyncStatus("waiting", "Draft deletion waiting to sync");
      scheduleDraftRetry(0);
      return null;
    }
  } else {
    const localInvoice = normalizeInvoiceData(operation.invoice);
    const remoteInvoice = normalizeInvoiceData(remoteDraftRecord?.invoice);
    if (remoteDraftRecord && localInvoice && remoteInvoice && invoiceFingerprint(localInvoice) === invoiceFingerprint(remoteInvoice)) {
      await draftOutbox.remove(userId, operation.operationId);
      setDraftSyncStatus("synced", "All changes synced");
      return remoteDraftRecord;
    }
    const expectedRevision = Number.isInteger(operation.expectedRevision) ? operation.expectedRevision : undefined;
    if ((!remoteDraftRecord && expectedRevision === undefined)
      || (remoteDraftRecord && expectedRevision === remoteDraftRecord.revision)) {
      setDraftSyncStatus("waiting", "Draft restored from this device. Waiting to sync");
      scheduleDraftRetry(0);
      return { invoice: localInvoice, revision: remoteDraftRecord?.revision };
    }
  }

  const choice = await promptForDraftConflict(operation, remoteDraftRecord);
  if (choice === "signed-out") return remoteDraftRecord;
  if (choice === "cloud") {
    await draftOutbox.remove(userId, operation.operationId);
    setDraftSyncStatus("synced", "All changes synced");
    return remoteDraftRecord;
  }
  await draftOutbox.rebase(userId, operation.operationId, remoteDraftRecord?.revision);
  setDraftSyncStatus("waiting", "Saved on this device. Waiting to sync");
  scheduleDraftRetry(0);
  return operation.type === "save"
    ? { invoice: normalizeInvoiceData(operation.invoice), revision: remoteDraftRecord?.revision }
    : null;
}

function normalizeHistoryRecords(records) {
  return records
    .map((record) => {
      const invoice = normalizeInvoiceData(record.invoice);
      if (!invoice) return null;
      invoice.historyId = record.id;
      return { ...record, invoice };
    })
    .filter(Boolean);
}

function setHistoryLoading(isLoading) {
  historyLoading = isLoading;
  historySection.setAttribute("aria-busy", String(isLoading));
  historyLoadingState.hidden = !isLoading;
  loadMoreInvoicesButton.disabled = isLoading;
}

async function loadInvoiceHistory(options = {}) {
  if (!currentUser || historyLoading) return false;
  const reset = Boolean(options.reset);
  const requestVersion = reset ? ++historyRequestVersion : historyRequestVersion;
  const cursor = reset ? null : historyNextCursor;
  if (reset) {
    historyLoadError = false;
    historyErrorState.hidden = true;
    historyNextCursor = undefined;
    historyTotal = 0;
    invoiceHistory = [];
    renderInvoiceHistory();
  }
  setHistoryLoading(true);
  renderInvoiceHistory();
  try {
    const page = await backend.listInvoices(currentUser.id, {
      limit: HISTORY_PAGE_SIZE,
      cursor,
      query: historyQuery,
    });
    if (requestVersion !== historyRequestVersion) return false;
    const records = normalizeHistoryRecords(page.records || []);
    const knownIds = new Set(invoiceHistory.map((record) => record.id));
    invoiceHistory = reset
      ? records
      : [...invoiceHistory, ...records.filter((record) => !knownIds.has(record.id))];
    historyNextCursor = page.nextCursor || undefined;
    historyTotal = Number.isFinite(Number(page.total)) ? Number(page.total) : invoiceHistory.length;
    historyLoadError = false;
    return true;
  } catch {
    if (requestVersion === historyRequestVersion) historyLoadError = true;
    return false;
  } finally {
    if (requestVersion === historyRequestVersion) {
      setHistoryLoading(false);
      renderInvoiceHistory();
    }
  }
}

async function loadAuthenticatedWorkspace(session) {
  if (!session?.user || workspaceLoading) return;
  if (currentUser?.id === session.user.id && !invoiceListPage.hidden) return;
  workspaceLoading = true;
  if (currentUser?.id && currentUser.id !== session.user.id) neutralizeDraftWrites();
  currentUser = session.user;
  accountEmail.textContent = session.user.email || "Signed in";
  accountControls.hidden = false;
  authPage.hidden = false;
  setAuthMessage("Loading your invoices...");

  try {
    const migrationAction = await promptForLegacyMigration(session);
    if (migrationAction === "cancelled") {
      await backend.signOut();
      return;
    }
    if (migrationAction === "signed-out") return;
    const [historyPage, remoteDraftRecord] = await Promise.all([
      backend.listInvoices(currentUser.id, { limit: HISTORY_PAGE_SIZE, query: "" }),
      backend.loadDraft(currentUser.id),
    ]);
    invoiceHistory = normalizeHistoryRecords(historyPage.records || []);
    historyNextCursor = historyPage.nextCursor || undefined;
    historyTotal = Number.isFinite(Number(historyPage.total)) ? Number(historyPage.total) : invoiceHistory.length;
    historyLoadError = false;
    const reconciledDraftRecord = await reconcileDraftOutbox(currentUser.id, remoteDraftRecord);
    state = normalizeInvoiceData(reconciledDraftRecord?.invoice) || await createCloudInvoiceDraft();
    draftRevision = Number.isInteger(reconciledDraftRecord?.revision) ? reconciledDraftRecord.revision : undefined;
    draftChanged = Boolean(state.draftDirty);
    draftPersistenceEnabled = Boolean(reconciledDraftRecord);
    clearValidationErrors();
    fillForm();
    passwordRecoveryForm.hidden = true;
    authPage.hidden = true;
    showInvoiceList(false);
    flushDraftOutbox();
    if (migrationAction === "moved") showToast("Existing browser invoices were moved to your account.");
    if (migrationAction === "discarded") showToast("Local browser data was discarded without moving it.");
  } catch (error) {
    try {
      await backend.signOut();
    } catch {}
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    showSignedOutPage();
    setAuthMessage(error?.message || "Your account data could not be loaded. Try again.", "error");
  } finally {
    workspaceLoading = false;
  }
}

async function handleSignIn(event) {
  event.preventDefault();
  if (!authForm.reportValidity()) return;
  const email = authEmail.value.trim();
  const password = authPassword.value;
  authPassword.value = "";
  setAuthBusy(true);
  setAuthMessage("Signing in...");
  try {
    const { session } = await backend.signIn(email, password);
    if (session) await loadAuthenticatedWorkspace(session);
  } catch (error) {
    setAuthMessage(authFailureMessage(error, "sign-in"), "error");
  } finally {
    setAuthBusy(false);
  }
}

async function handleCreateAccount() {
  if (!authForm.reportValidity()) return;
  const email = authEmail.value.trim();
  const password = authPassword.value;
  authPassword.value = "";
  setAuthBusy(true);
  setAuthMessage("Creating your account...");
  try {
    const { session } = await backend.signUp(email, password);
    if (session) {
      await loadAuthenticatedWorkspace(session);
    } else {
      markAuthEmailRequested(email);
      setAuthMessage("Check your email to confirm the account, then return here to sign in.");
    }
  } catch (error) {
    if (error?.code === "over_email_send_rate_limit") {
      const retrySeconds = authEmailRetrySeconds(error);
      if (retrySeconds) markAuthEmailRequested(email, retrySeconds);
      else blockAuthEmailRequests();
    }
    setAuthMessage(authFailureMessage(error, "sign-up"), "error");
  } finally {
    setAuthBusy(false);
  }
}

async function handlePasswordReset() {
  if (!authEmail.reportValidity()) return;
  setAuthBusy(true);
  setAuthMessage("Sending a password reset link...");
  const email = authEmail.value.trim();
  try {
    await backend.sendPasswordReset(email);
    markAuthEmailRequested(email);
    setAuthMessage("If that email has an account, a password reset link is on its way.");
  } catch (error) {
    if (error?.code === "over_email_send_rate_limit") {
      const retrySeconds = authEmailRetrySeconds(error);
      if (retrySeconds) markAuthEmailRequested(email, retrySeconds);
      else blockAuthEmailRequests();
    }
    setAuthMessage(authFailureMessage(error, "password-reset"), "error");
  } finally {
    setAuthBusy(false);
  }
}

async function handlePasswordRecovery(event) {
  event.preventDefault();
  if (!passwordRecoveryForm.reportValidity()) return;
  if (recoveryPassword.value !== recoveryPasswordConfirm.value) {
    recoveryPasswordConfirm.setCustomValidity("Passwords must match.");
    recoveryPasswordConfirm.reportValidity();
    return;
  }
  recoveryPasswordConfirm.setCustomValidity("");
  const password = recoveryPassword.value;
  recoveryPassword.value = "";
  recoveryPasswordConfirm.value = "";
  setAuthBusy(true);
  setAuthMessage("Updating your password...");
  try {
    await backend.updatePassword(password);
    const session = await backend.getSession();
    setAuthMessage("Password updated.");
    await loadAuthenticatedWorkspace(session);
  } catch (error) {
    setAuthMessage(error?.message || "The password could not be updated.", "error");
  } finally {
    setAuthBusy(false);
  }
}

async function handleSignOut() {
  signOutButton.disabled = true;
  try {
    await persistDraftImmediately();
    await outboxWriteQueue.catch(() => {});
    if (currentUser && await draftOutbox.has(currentUser.id)) {
      setDraftSyncStatus("error", "Sync this draft before signing out");
      showToast("This draft is saved on this device but has not synced. Reconnect and wait for sync before signing out.");
      return;
    }
    await backend.signOut();
    showSignedOutPage();
  } catch (error) {
    showToast(error?.message || "Sign-out failed. Try again.");
  } finally {
    signOutButton.disabled = false;
  }
}

async function initializeApplication() {
  if (!backend?.configured) {
    showConfigurationPage();
    return;
  }

  backend.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") {
      currentUser = session?.user;
      showPasswordRecoveryPage();
      return;
    }
    if (event === "SIGNED_OUT") {
      showSignedOutPage();
      return;
    }
    if (session && (event === "SIGNED_IN" || event === "INITIAL_SESSION")) {
      loadAuthenticatedWorkspace(session);
    }
  });

  try {
    const session = await backend.getSession();
    if (session) await loadAuthenticatedWorkspace(session);
    else showSignedOutPage();
  } catch (error) {
    showSignedOutPage();
    setAuthMessage(error?.message || "Authentication is unavailable. Try again.", "error");
  }
}

function normalizeQuantity(value) {
  const quantity = Number(value);
  if (!Number.isFinite(quantity)) return 1;
  return Math.min(MAX_QUANTITY, Math.max(1, Math.round(quantity)));
}

function createInvoiceDraft(invoiceNumberOverride) {
  const today = new Date();
  const due = new Date(today);
  due.setDate(due.getDate() + 7);
  const compactDate = isoDate(today).replaceAll("-", "");
  const invoiceNumber = invoiceNumberOverride || `EHR-${compactDate}-001`;
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

async function createCloudInvoiceDraft() {
  if (!currentUser) throw new Error("Sign in before creating an invoice.");
  const today = isoDate(new Date());
  const invoiceNumber = await backend.nextInvoiceNumber(today);
  return createInvoiceDraft(invoiceNumber);
}

function saveDraft(markChanged = true) {
  clearTimeout(saveTimer);
  draftPersistenceEnabled = true;
  if (markChanged) {
    draftChanged = true;
    state.draftDirty = true;
  }
  if (!currentUser) return;
  saveStatus.textContent = "Saving on this device...";
  stageDraftSave().catch(() => {
    saveStatus.textContent = "Could not save draft on this device";
  });
  saveTimer = window.setTimeout(() => flushDraftOutbox(), 350);
}

async function persistDraftImmediately() {
  if (!draftPersistenceEnabled || !currentUser) return true;
  clearTimeout(saveTimer);
  try {
    await stageDraftSave();
  } catch {
    return false;
  }
  return flushDraftOutbox({ force: true });
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

async function deleteCloudDraft() {
  clearTimeout(saveTimer);
  if (!currentUser) return true;
  const userId = currentUser.id;
  await stageDraftDelete();
  await flushDraftOutbox({ force: true });
  if (await draftOutbox.has(userId)) throw new Error("Draft deletion is waiting to sync.");
  draftRevision = undefined;
  return true;
}

async function saveCurrentInvoiceToHistory() {
  if (!currentUser) {
    showToast("Sign in before saving an invoice.");
    return false;
  }
  const now = new Date().toISOString();
  const id = state.historyId || historyRecordId();
  const existingRecord = invoiceHistory.find((record) => record.id === id);
  const savedInvoice = cloneInvoice({ ...state, historyId: id, draftDirty: false });
  const savedRecord = {
    id,
    revision: existingRecord?.revision,
    createdAt: existingRecord?.createdAt || now,
    updatedAt: now,
    invoice: savedInvoice,
  };
  let remoteRecord;
  try {
    await persistDraftImmediately();
    remoteRecord = await backend.saveInvoice(currentUser.id, savedRecord);
  } catch (error) {
    if (error?.code === "INVOICE_REVISION_CONFLICT") {
      saveStatus.textContent = "Invoice changed elsewhere";
      showToast("This invoice changed in another session. Your edits were not overwritten; reload the invoice before saving again.");
    } else if (error?.code === "INVOICE_NUMBER_CONFLICT") {
      saveStatus.textContent = "Invoice number already used";
      showToast("That invoice number is already in use. Choose a unique invoice number and save again.");
    } else {
      saveStatus.textContent = "Could not save invoice";
      showToast("The invoice could not be saved. Check your connection and try again.");
    }
    return false;
  }

  try {
    await deleteCloudDraft();
  } catch {
    // The invoice is already safely stored. The durable outbox will retry the
    // draft deletion, and sign-out remains blocked until it succeeds.
  }
  invoiceHistory = [remoteRecord, ...invoiceHistory.filter((record) => record.id !== id)];
  if (!existingRecord) historyTotal += 1;
  historyQuery = "";
  invoiceSearch.value = "";

  state.historyId = id;
  state.draftDirty = false;
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
  const query = historyQuery.trim();
  const visibleRecords = invoiceHistory;

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

  const total = historyTotal;
  invoiceCount.textContent = historyLoading && visibleRecords.length === 0
    ? "Loading..."
    : query
      ? `${visibleRecords.length} of ${total} ${total === 1 ? "invoice" : "invoices"}`
      : `${total} ${total === 1 ? "invoice" : "invoices"}`;
  invoiceSearchField.hidden = total < 2 && !query;
  historyNewInvoiceButton.hidden = total === 0 && !query;
  historyLoadingState.hidden = !historyLoading;
  historyErrorState.hidden = !historyLoadError;
  historyEmptyState.hidden = historyLoading || historyLoadError || Boolean(query) || total !== 0;
  historyNoResults.hidden = historyLoading || historyLoadError || !query || total !== 0;
  loadMoreInvoicesButton.hidden = historyLoading || historyLoadError || !historyNextCursor;

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

async function duplicateSavedInvoice(id) {
  const record = invoiceHistory.find((candidate) => candidate.id === id);
  if (!record || !canReplaceCurrentDraft("Duplicate this invoice and replace your unsaved draft?")) return;
  clearTimeout(saveTimer);
  clearValidationErrors();
  let freshInvoice;
  try {
    freshInvoice = await createCloudInvoiceDraft();
  } catch {
    showToast("A new invoice number could not be created. Check your connection and try again.");
    return;
  }
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
    description.maxLength = MAX_ITEM_DESCRIPTION_LENGTH;
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

async function newInvoice() {
  const canUseCurrentBlankDraft = currentPage === "history" && !state.historyId && !hasUnsavedDraft();
  if (canUseCurrentBlankDraft) {
    saveStatus.textContent = "Draft ready";
    showEditorPage("new");
    return;
  }
  if (!canReplaceCurrentDraft("Start a new invoice and replace the current unsaved draft?")) return;
  clearValidationErrors();
  try {
    await deleteCloudDraft();
    state = await createCloudInvoiceDraft();
  } catch {
    showToast("A new invoice could not be created. Check your connection and try again.");
    return;
  }
  draftChanged = false;
  draftPersistenceEnabled = true;
  fillForm();
  saveDraft(false);
  showEditorPage("new");
  showToast("New invoice ready.");
}

async function clearSavedDraft() {
  if (!window.confirm("Delete this draft from your account?")) return;
  if (!await resetDraft()) return;
  saveStatus.textContent = "Saved draft cleared";
  showToast("Draft deleted from your account.");
}

async function resetDraft() {
  clearTimeout(saveTimer);
  try {
    await deleteCloudDraft();
    state = await createCloudInvoiceDraft();
  } catch {
    showToast("The draft could not be deleted. Check your connection and try again.");
    return false;
  }
  draftChanged = false;
  draftPersistenceEnabled = false;
  clearValidationErrors();
  fillForm();
  return true;
}

async function deleteUnsavedDraft() {
  if (!window.confirm("Delete this unsaved draft? This cannot be undone.")) return;
  if (!await resetDraft()) return;
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

async function openOutputDialog(event) {
  if (!invoiceIsReady("saving or printing")) return;
  outputDialogTrigger = event.currentTarget;
  printButton.disabled = true;
  document.querySelector("#mobilePrintButton").disabled = true;
  const saved = await saveCurrentInvoiceToHistory();
  printButton.disabled = false;
  document.querySelector("#mobilePrintButton").disabled = false;
  if (!saved) return;
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

function loadPdfLibrary() {
  if (typeof window.html2pdf === "function") return Promise.resolve(window.html2pdf);
  if (pdfLibraryPromise) return pdfLibraryPromise;
  pdfLibraryPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = PDF_LIBRARY_URL;
    script.async = true;
    script.dataset.pdfLibrary = "html2pdf";
    script.addEventListener("load", () => {
      if (typeof window.html2pdf === "function") resolve(window.html2pdf);
      else reject(new Error("The PDF library did not initialize."));
    }, { once: true });
    script.addEventListener("error", () => reject(new Error("The PDF library could not be loaded.")), { once: true });
    document.head.append(script);
  }).catch((error) => {
    pdfLibraryPromise = undefined;
    document.querySelector('script[data-pdf-library="html2pdf"]')?.remove();
    throw error;
  });
  return pdfLibraryPromise;
}

async function downloadInvoicePdf() {
  if (!invoiceIsReady("saving")) {
    dismissOutputDialog();
    return;
  }

  setOutputBusy(true);
  try {
    await loadPdfLibrary();
    const pdfBaseName = safePdfFileName(state.pdfFileName, state.invoiceNumber);
    const pdfFileName = `${pdfBaseName}.pdf`;
    const exportSheet = invoiceSheet.cloneNode(true);
    exportSheet.removeAttribute("id");
    exportSheet.style.width = `${Math.floor(PAPER_WIDTH)}px`;
    exportSheet.style.minHeight = `${Math.floor(PAPER_HEIGHT) - 1}px`;
    exportSheet.style.margin = "0";
    exportSheet.style.boxShadow = "none";
    exportSheet.style.transform = "none";
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
  } catch (error) {
    const message = typeof window.html2pdf === "function"
      ? "The PDF could not be created. Try again or use Print."
      : "PDF saving is unavailable. Check your connection and try again, or use Print.";
    showToast(message);
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
  if (navigator.onLine) {
    clearTimeout(draftRetryTimer);
    flushDraftOutbox({ force: true });
  } else if (currentUser) {
    draftOutbox.has(currentUser.id).then((pending) => {
      if (pending) setDraftSyncStatus("waiting", "Saved on this device. Waiting to sync");
    }).catch(() => {});
  }
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
  clearTimeout(historySearchTimer);
  historyQuery = invoiceSearch.value.trim();
  historySearchTimer = window.setTimeout(() => {
    if (historyLoading) {
      invoiceSearch.dispatchEvent(new Event("input", { bubbles: false }));
      return;
    }
    loadInvoiceHistory({ reset: true });
  }, 300);
});
loadMoreInvoicesButton.addEventListener("click", () => loadInvoiceHistory());
retryHistoryButton.addEventListener("click", () => loadInvoiceHistory({ reset: invoiceHistory.length === 0 }));
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
legacyMigrationDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  cancelLegacyMigration();
});
moveLegacyDataButton.addEventListener("click", moveLegacyBrowserData);
exportLegacyDataButton.addEventListener("click", exportLegacyBrowserData);
discardLegacyDataButton.addEventListener("click", discardLegacyBrowserData);
cancelLegacyMigrationButton.addEventListener("click", cancelLegacyMigration);
draftConflictDialog.addEventListener("cancel", (event) => event.preventDefault());
keepLocalDraftButton.addEventListener("click", () => finishDraftConflictChoice("local"));
keepCloudDraftButton.addEventListener("click", () => finishDraftConflictChoice("cloud"));

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

authForm.addEventListener("submit", handleSignIn);
createAccountButton.addEventListener("click", handleCreateAccount);
forgotPasswordButton.addEventListener("click", handlePasswordReset);
authEmail.addEventListener("input", () => {
  if (normalizeAuthEmail(authEmail.value) !== pendingAuthEmailRequest) updateAuthEmailActions();
});
passwordRecoveryForm.addEventListener("submit", handlePasswordRecovery);
recoveryPasswordConfirm.addEventListener("input", () => recoveryPasswordConfirm.setCustomValidity(""));
signOutButton.addEventListener("click", handleSignOut);

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

updateConnectionStatus();
updatePreviewScale();
initializeApplication();
