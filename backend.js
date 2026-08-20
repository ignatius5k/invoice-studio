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
  const localSession = Object.freeze({
    user: Object.freeze({ id: "local-guest", email: "This device" }),
  });

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function readJson(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      throw new Error("Browser storage is unavailable or full. Export any important invoices before continuing.");
    }
  }

  function storedHistory() {
    const value = readJson(HISTORY_KEY, []);
    return Array.isArray(value) ? value.filter((record) => record?.id && record?.invoice) : [];
  }

  function invoiceConflictError() {
    const error = new Error("This invoice changed in another tab. Reload it before saving again.");
    error.code = "INVOICE_REVISION_CONFLICT";
    return error;
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
    const duplicateNumber = records.some((candidate) => (
      candidate.id !== record.id
      && String(candidate.invoice?.invoiceNumber || "") === String(record.invoice?.invoiceNumber || "")
    ));
    if (duplicateNumber) {
      const error = new Error("That invoice number is already in use.");
      error.code = "INVOICE_NUMBER_CONFLICT";
      throw error;
    }

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
    window.localStorage.removeItem(DRAFT_KEY);
    window.localStorage.removeItem(DRAFT_REVISION_KEY);
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

  async function nextInvoiceNumber(invoiceDate) {
    const compactDate = String(invoiceDate || "").replaceAll("-", "");
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
    writeJson(SEQUENCE_KEY, { date: compactDate, sequence });
    return `${prefix}${String(sequence).padStart(3, "0")}`;
  }

  const unavailableAccountAction = async () => {
    throw new Error("Account access is not enabled. This workspace currently saves to this device only.");
  };

  window.invoiceBackend = {
    configured: true,
    guestMode: true,
    localMode: true,
    getSession: async () => localSession,
    onAuthStateChange: () => ({ unsubscribe() {} }),
    signIn: unavailableAccountAction,
    signUp: unavailableAccountAction,
    sendPasswordReset: unavailableAccountAction,
    updatePassword: unavailableAccountAction,
    signOut: async () => {},
    listInvoices,
    saveInvoice,
    loadDraft,
    saveDraft,
    deleteDraft,
    migrateLocalData,
    nextInvoiceNumber,
  };
}());
