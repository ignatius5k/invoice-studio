(function initializeInvoiceBackend() {
  "use strict";

  if (typeof window.__INVOICE_STUDIO_BACKEND_FACTORY__ === "function") {
    window.invoiceBackend = window.__INVOICE_STUDIO_BACKEND_FACTORY__();
    return;
  }

  const HISTORY_KEY = "invoice-studio-history-v1";
  const DRAFT_KEY = "invoice-studio-draft-v1";
  const DRAFT_REVISION_KEY = "invoice-studio-guest-draft-revision-v1";
  const SEQUENCE_KEY = "invoice-studio-sequence-v1";
  const RESTORE_JOURNAL_KEY = "invoice-studio-restore-journal-v1";
  const MANAGED_KEYS = [HISTORY_KEY, DRAFT_KEY, DRAFT_REVISION_KEY, SEQUENCE_KEY];
  const localSession = Object.freeze({
    user: Object.freeze({ id: "local-guest", email: "This device" }),
  });

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function storageError(message, code, key) {
    const error = new Error(message);
    error.code = code;
    if (key) error.storageKey = key;
    return error;
  }

  function readStoredRaw(key) {
    try {
      return window.localStorage.getItem(key);
    } catch {
      throw storageError("Browser storage is unavailable. Check this browser's site-storage settings and try again.", "LOCAL_STORAGE_UNAVAILABLE", key);
    }
  }

  function readRestoreJournal() {
    const raw = readStoredRaw(RESTORE_JOURNAL_KEY);
    if (raw === null) return null;
    try {
      const journal = JSON.parse(raw);
      return journal && typeof journal === "object" ? journal : null;
    } catch {
      throw storageError("Backup recovery data cannot be read. Download a recovery backup before clearing it.", "LOCAL_DATA_CORRUPT", RESTORE_JOURNAL_KEY);
    }
  }

  function readRaw(key) {
    if (MANAGED_KEYS.includes(key)) {
      const journal = readRestoreJournal();
      if (journal?.status === "pending" && journal.previous && Object.hasOwn(journal.previous, key)) {
        return journal.previous[key];
      }
    }
    return readStoredRaw(key);
  }

  function recoverInterruptedRestore() {
    const journal = readRestoreJournal();
    if (!journal) return;
    if (journal.status === "committed") {
      try {
        window.localStorage.removeItem(RESTORE_JOURNAL_KEY);
      } catch {}
      return;
    }
    if (journal.status !== "pending" || !journal.previous) return;
    try {
      for (const key of MANAGED_KEYS) {
        const raw = Object.hasOwn(journal.previous, key) ? journal.previous[key] : null;
        if (raw === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, raw);
      }
      window.localStorage.removeItem(RESTORE_JOURNAL_KEY);
    } catch {
      throw storageError("A backup restore was interrupted. Your earlier data is protected; free browser storage and try again.", "LOCAL_STORAGE_UNAVAILABLE", RESTORE_JOURNAL_KEY);
    }
  }

  function readJson(key, fallback) {
    const raw = readRaw(key);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      throw storageError("Some saved Invoice Studio data cannot be read. Download a recovery backup before clearing it.", "LOCAL_DATA_CORRUPT", key);
    }
  }

  function writeJson(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      throw storageError("Browser storage is unavailable or full. Download a backup and free browser storage before continuing.", "LOCAL_STORAGE_UNAVAILABLE", key);
    }
  }

  function removeStoredValue(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      throw storageError("Browser storage is unavailable. Check this browser's site-storage settings and try again.", "LOCAL_STORAGE_UNAVAILABLE", key);
    }
  }

  function validHistoryRecord(record) {
    return Boolean(record && typeof record.id === "string" && record.id && record.invoice && Array.isArray(record.invoice.items));
  }

  function storedHistory() {
    const value = readJson(HISTORY_KEY, []);
    if (!Array.isArray(value) || value.some((record) => !validHistoryRecord(record))) {
      throw storageError("Some saved invoices cannot be read. Download a recovery backup before clearing them.", "LOCAL_DATA_CORRUPT", HISTORY_KEY);
    }
    const seen = new Set();
    return value.map((record, index) => {
      let id = String(record.id);
      if (seen.has(id)) {
        const base = `${id}-recovered-${index + 1}`;
        id = base;
        let suffix = 2;
        while (seen.has(id)) id = `${base}-${suffix++}`;
      }
      seen.add(id);
      if (id === record.id) return record;
      return { ...record, id, invoice: { ...record.invoice, historyId: id } };
    });
  }

  function invoiceConflictError() {
    const error = new Error("This invoice changed in another tab. Reload it before saving again.");
    error.code = "INVOICE_REVISION_CONFLICT";
    return error;
  }

  function preserveInvoiceSequence(invoiceNumber) {
    const match = String(invoiceNumber || "").match(/^EHR-(\d{8})-(\d+)$/);
    if (!match) return;
    const [, date, rawSequence] = match;
    const sequence = Number(rawSequence);
    if (!Number.isInteger(sequence) || sequence < 1) return;
    const saved = readJson(SEQUENCE_KEY, null);
    const savedSequence = saved?.date === date && Number.isInteger(saved.sequence) ? saved.sequence : 0;
    if (sequence > savedSequence) writeJson(SEQUENCE_KEY, { date, sequence });
  }

  function draftConflictError() {
    const error = new Error("This draft changed in another tab.");
    error.code = "DRAFT_REVISION_CONFLICT";
    return error;
  }

  function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    const error = new Error("The browser storage operation was cancelled.");
    error.name = "AbortError";
    throw error;
  }

  async function listInvoices(userId, options = {}) {
    if (!userId) throw new Error("Open the local workspace before loading invoices.");
    const limit = Math.min(50, Math.max(1, Number(options.limit) || 25));
    const query = String(options.query || "").trim().toLocaleLowerCase("en-SG").slice(0, 120);
    const cursor = options.cursor && typeof options.cursor === "object" ? options.cursor : null;
    const matchingRecords = storedHistory()
      .filter((record) => {
        if (!query) return true;
        const invoice = record.invoice || {};
        return `${invoice.invoiceNumber || ""} ${invoice.billTo || ""}`.toLocaleLowerCase("en-SG").includes(query);
      })
      .sort((left, right) => {
        const dateOrder = String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
        return dateOrder || String(right.id).localeCompare(String(left.id));
      });
    const recordsAfterCursor = cursor?.updatedAt && cursor?.id
      ? matchingRecords.filter((record) => (
        String(record.updatedAt || "") < String(cursor.updatedAt)
        || (String(record.updatedAt || "") === String(cursor.updatedAt) && String(record.id) < String(cursor.id))
      ))
      : matchingRecords;
    const page = recordsAfterCursor.slice(0, limit);
    const lastRecord = page.at(-1);
    return {
      records: clone(page),
      total: matchingRecords.length,
      nextCursor: recordsAfterCursor.length > limit && lastRecord
        ? { updatedAt: lastRecord.updatedAt, id: lastRecord.id }
        : null,
    };
  }

  async function saveInvoice(userId, record) {
    if (!userId) throw new Error("Open the local workspace before saving invoices.");
    const records = storedHistory();
    const existingIndex = records.findIndex((candidate) => candidate.id === record.id);
    const existing = existingIndex >= 0 ? records[existingIndex] : null;
    const expectedRevision = Number(record.revision);
    const currentRevision = Number(existing?.revision) || (existing ? 1 : 0);
    if (existing && (!Number.isInteger(expectedRevision) || expectedRevision !== currentRevision)) {
      throw invoiceConflictError();
    }

    const now = new Date().toISOString();
    const savedRecord = {
      id: String(record.id),
      revision: existing ? currentRevision + 1 : 1,
      createdAt: existing?.createdAt || record.createdAt || now,
      updatedAt: now,
      invoice: { ...clone(record.invoice), historyId: String(record.id), draftDirty: false },
    };
    if (existingIndex >= 0) records[existingIndex] = savedRecord;
    else records.push(savedRecord);
    writeJson(HISTORY_KEY, records);
    return clone(savedRecord);
  }

  async function deleteInvoice(userId, id, expectedRevision) {
    if (!userId) throw new Error("Open the local workspace before deleting invoices.");
    const records = storedHistory();
    const existingIndex = records.findIndex((candidate) => candidate.id === id);
    if (existingIndex < 0) return false;
    const existing = records[existingIndex];
    const expected = Number(expectedRevision);
    const currentRevision = Number(existing.revision) || 1;
    if (Number.isInteger(expected) && expected > 0 && expected !== currentRevision) throw invoiceConflictError();
    preserveInvoiceSequence(existing.invoice?.invoiceNumber);
    records.splice(existingIndex, 1);
    writeJson(HISTORY_KEY, records);
    return true;
  }

  async function loadDraft(userId) {
    if (!userId) return null;
    const invoice = readJson(DRAFT_KEY, null);
    if (!invoice || typeof invoice !== "object" || !Array.isArray(invoice.items)) return null;
    const revision = Number(readJson(DRAFT_REVISION_KEY, 1));
    return { invoice: clone(invoice), revision: Number.isInteger(revision) && revision > 0 ? revision : 1 };
  }

  async function saveDraft(userId, invoice, signal, expectedRevision) {
    if (!userId) throw new Error("Open the local workspace before saving a draft.");
    throwIfAborted(signal);
    const existingInvoice = readJson(DRAFT_KEY, null);
    const currentRevision = existingInvoice ? Number(readJson(DRAFT_REVISION_KEY, 1)) || 1 : 0;
    const expected = Number(expectedRevision);
    if (existingInvoice && (!Number.isInteger(expected) || expected !== currentRevision)) throw draftConflictError();
    if (!existingInvoice && Number.isInteger(expected) && expected > 0) throw draftConflictError();
    const revision = currentRevision + 1;
    writeJson(DRAFT_KEY, clone(invoice));
    writeJson(DRAFT_REVISION_KEY, revision);
    throwIfAborted(signal);
    return { revision };
  }

  async function deleteDraft(userId, signal, expectedRevision) {
    if (!userId) return;
    throwIfAborted(signal);
    const existingInvoice = readJson(DRAFT_KEY, null);
    const currentRevision = existingInvoice ? Number(readJson(DRAFT_REVISION_KEY, 1)) || 1 : 0;
    const expected = Number(expectedRevision);
    if (existingInvoice && Number.isInteger(expected) && expected > 0 && expected !== currentRevision) {
      throw draftConflictError();
    }
    removeStoredValue(DRAFT_REVISION_KEY);
    removeStoredValue(DRAFT_KEY);
    throwIfAborted(signal);
  }

  async function migrateLocalData(userId, records, draft) {
    if (!userId) return;
    const merged = storedHistory();
    const knownIds = new Set(merged.map((record) => record.id));
    for (const record of records || []) {
      if (!knownIds.has(record.id)) merged.push({ ...clone(record), revision: Number(record.revision) || 1 });
    }
    writeJson(HISTORY_KEY, merged);
    if (draft) {
      writeJson(DRAFT_KEY, clone(draft));
      writeJson(DRAFT_REVISION_KEY, 1);
    }
  }

  function calculateNextInvoiceNumber(invoiceDate) {
    const compactDate = String(invoiceDate || "").replace(/-/g, "");
    if (!/^\d{8}$/.test(compactDate)) throw new Error("Choose a valid invoice date.");
    const savedSequence = readJson(SEQUENCE_KEY, null);
    const savedValue = savedSequence?.date === compactDate && Number.isInteger(savedSequence.sequence)
      ? savedSequence.sequence
      : 0;
    const prefix = `EHR-${compactDate}-`;
    const historyValue = storedHistory().reduce((highest, record) => {
      const invoiceNumber = String(record.invoice?.invoiceNumber || "");
      if (!invoiceNumber.startsWith(prefix)) return highest;
      const value = Number(invoiceNumber.slice(prefix.length));
      return Number.isInteger(value) ? Math.max(highest, value) : highest;
    }, 0);
    const sequence = Math.max(savedValue, historyValue) + 1;
    if (sequence > 999999) throw new Error("The invoice sequence for this date is full.");
    return `${prefix}${String(sequence).padStart(3, "0")}`;
  }

  async function nextInvoiceNumber(invoiceDate) {
    return calculateNextInvoiceNumber(invoiceDate);
  }

  async function reserveInvoiceNumber(invoiceDate) {
    const invoiceNumber = calculateNextInvoiceNumber(invoiceDate);
    preserveInvoiceSequence(invoiceNumber);
    return invoiceNumber;
  }

  function exportValue(key) {
    const raw = readRaw(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return { unreadableRawValue: raw };
    }
  }

  function exportLocalData() {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      source: "Eng Hoon Residences Invoice Studio browser storage",
      history: exportValue(HISTORY_KEY),
      draft: exportValue(DRAFT_KEY),
      draftRevision: exportValue(DRAFT_REVISION_KEY),
      sequence: exportValue(SEQUENCE_KEY),
    };
  }

  function validateBackup(backup) {
    if (!backup || typeof backup !== "object") throw new Error("Choose an Invoice Studio backup file.");
    const history = backup.history ?? [];
    const draft = backup.draft ?? null;
    if (!Array.isArray(history) || history.some((record) => !validHistoryRecord(record))) {
      throw new Error("This backup contains unreadable invoice history.");
    }
    if (draft !== null && (!draft || typeof draft !== "object" || !Array.isArray(draft.items))) {
      throw new Error("This backup contains an unreadable draft.");
    }
    for (const value of [history, draft, backup.draftRevision, backup.sequence]) {
      if (value && typeof value === "object" && Object.hasOwn(value, "unreadableRawValue")) {
        throw new Error("This recovery backup contains unreadable raw data and cannot be restored automatically.");
      }
    }
    return {
      history,
      draft,
      draftRevision: backup.draftRevision ?? (draft ? 1 : null),
      sequence: backup.sequence ?? null,
    };
  }

  function restoreLocalData(backup) {
    const values = validateBackup(backup);
    const previous = Object.fromEntries(MANAGED_KEYS.map((key) => [key, readRaw(key)]));
    const journal = { version: 1, status: "pending", previous };
    try {
      window.localStorage.setItem(RESTORE_JOURNAL_KEY, JSON.stringify(journal));
      writeJson(HISTORY_KEY, values.history);
      if (values.draft === null) removeStoredValue(DRAFT_KEY);
      else writeJson(DRAFT_KEY, values.draft);
      if (values.draftRevision === null) removeStoredValue(DRAFT_REVISION_KEY);
      else writeJson(DRAFT_REVISION_KEY, values.draftRevision);
      if (values.sequence === null) removeStoredValue(SEQUENCE_KEY);
      else writeJson(SEQUENCE_KEY, values.sequence);
      window.localStorage.setItem(RESTORE_JOURNAL_KEY, JSON.stringify({ ...journal, status: "committed" }));
      window.localStorage.removeItem(RESTORE_JOURNAL_KEY);
    } catch (error) {
      if (error?.code) throw error;
      throw storageError("The backup could not be restored. Your earlier data is protected.", "LOCAL_STORAGE_UNAVAILABLE", RESTORE_JOURNAL_KEY);
    }
  }

  function clearLocalData() {
    removeStoredValue(HISTORY_KEY);
    removeStoredValue(DRAFT_KEY);
    removeStoredValue(DRAFT_REVISION_KEY);
    removeStoredValue(SEQUENCE_KEY);
    removeStoredValue(RESTORE_JOURNAL_KEY);
  }

  const unavailableAccountAction = async () => {
    throw new Error("Account access is not enabled. This workspace currently saves to this device only.");
  };

  window.invoiceBackend = {
    configured: true,
    guestMode: true,
    localMode: true,
    getSession: async () => {
      recoverInterruptedRestore();
      return localSession;
    },
    onAuthStateChange: () => ({ unsubscribe() {} }),
    signIn: unavailableAccountAction,
    signUp: unavailableAccountAction,
    sendPasswordReset: unavailableAccountAction,
    updatePassword: unavailableAccountAction,
    signOut: async () => {},
    listInvoices,
    saveInvoice,
    deleteInvoice,
    loadDraft,
    saveDraft,
    deleteDraft,
    migrateLocalData,
    nextInvoiceNumber,
    reserveInvoiceNumber,
    exportLocalData,
    restoreLocalData,
    clearLocalData,
  };
}());
