(function initializeInvoiceBackend() {
  "use strict";

  if (typeof window.__INVOICE_STUDIO_BACKEND_FACTORY__ === "function") {
    window.invoiceBackend = window.__INVOICE_STUDIO_BACKEND_FACTORY__();
    return;
  }

  const features = window.INVOICE_STUDIO_FEATURES || {};
  if (features.temporaryGuestMode === true) {
    window.invoiceBackend = createLocalGuestBackend();
    return;
  }

  const config = window.INVOICE_STUDIO_SUPABASE || {};
  const configured = Boolean(
    /^https:\/\/[a-z0-9.-]+$/i.test(config.url || "")
      && !String(config.url).includes("YOUR_PROJECT_ID")
      && config.publishableKey
      && !String(config.publishableKey).includes("YOUR_SUPABASE_PUBLISHABLE_KEY")
      && window.supabase?.createClient,
  );

  if (!configured) {
    const configurationError = () => {
      throw new Error("Supabase is not configured. Add the project URL and publishable key in supabase-config.js.");
    };
    window.invoiceBackend = {
      configured: false,
      guestMode: false,
      getSession: configurationError,
      onAuthStateChange: () => ({ unsubscribe() {} }),
      signIn: configurationError,
      signUp: configurationError,
      sendPasswordReset: configurationError,
      updatePassword: configurationError,
      signOut: configurationError,
      listInvoices: configurationError,
      saveInvoice: configurationError,
      loadDraft: configurationError,
      saveDraft: configurationError,
      deleteDraft: configurationError,
      migrateLocalData: configurationError,
      nextInvoiceNumber: configurationError,
    };
    return;
  }

  const client = window.supabase.createClient(config.url, config.publishableKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
    },
  });

  const INVOICE_COLUMNS = "id, revision, invoice_number, pdf_file_name, pdf_file_name_customized, invoice_date, due_date, bill_to, items, created_at, updated_at";

  function throwIfError(error) {
    if (error) throw error;
  }

  function redirectUrl() {
    return `${window.location.origin}${window.location.pathname}`;
  }

  function recordToRow(userId, record) {
    const invoice = record.invoice;
    return {
      user_id: userId,
      id: record.id,
      invoice_number: invoice.invoiceNumber,
      pdf_file_name: invoice.pdfFileName,
      pdf_file_name_customized: Boolean(invoice.pdfFileNameCustomized),
      invoice_date: invoice.invoiceDate,
      due_date: invoice.dueDate,
      bill_to: invoice.billTo,
      items: invoice.items,
    };
  }

  function rowToRecord(row) {
    return {
      id: row.id,
      revision: Number(row.revision),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      invoice: {
        historyId: row.id,
        draftDirty: false,
        invoiceNumber: row.invoice_number,
        pdfFileName: row.pdf_file_name,
        pdfFileNameCustomized: Boolean(row.pdf_file_name_customized),
        invoiceDate: row.invoice_date,
        dueDate: row.due_date,
        billTo: row.bill_to,
        items: row.items,
      },
    };
  }

  async function getSession() {
    const { data, error } = await client.auth.getSession();
    throwIfError(error);
    return data.session;
  }

  function onAuthStateChange(callback) {
    const { data } = client.auth.onAuthStateChange((event, session) => {
      window.setTimeout(() => callback(event, session), 0);
    });
    return data.subscription;
  }

  async function signIn(email, password) {
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    throwIfError(error);
    return data;
  }

  async function signUp(email, password) {
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: redirectUrl() },
    });
    throwIfError(error);
    return data;
  }

  async function sendPasswordReset(email) {
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl() });
    throwIfError(error);
  }

  async function updatePassword(password) {
    const { data, error } = await client.auth.updateUser({ password });
    throwIfError(error);
    return data;
  }

  async function signOut() {
    const { error } = await client.auth.signOut();
    throwIfError(error);
  }

  async function listInvoices(userId, options = {}) {
    if (!userId) throw new Error("Sign in before loading invoices.");
    const limit = Math.min(50, Math.max(1, Number(options.limit) || 25));
    const query = String(options.query || "").trim().slice(0, 120);
    const cursor = options.cursor && typeof options.cursor === "object" ? options.cursor : null;
    const cursorUpdatedAt = cursor?.updatedAt && Number.isFinite(Date.parse(cursor.updatedAt)) ? cursor.updatedAt : null;
    const cursorId = cursorUpdatedAt && typeof cursor?.id === "string" ? cursor.id.slice(0, 160) : null;
    const { data, error } = await client.rpc("list_invoices_page", {
      p_query: query,
      p_limit: limit,
      p_cursor_updated_at: cursorUpdatedAt,
      p_cursor_id: cursorId,
    });
    throwIfError(error);
    const rows = Array.isArray(data) ? data : [];
    const hasMore = rows.length > limit;
    const visibleRows = hasMore ? rows.slice(0, limit) : rows;
    const records = visibleRows.map(rowToRecord);
    const lastRecord = records.at(-1);
    return {
      records,
      total: Number(visibleRows[0]?.total_count || 0),
      nextCursor: hasMore && lastRecord ? { updatedAt: lastRecord.updatedAt, id: lastRecord.id } : null,
    };
  }

  async function saveInvoice(userId, record) {
    const row = recordToRow(userId, record);
    const expectedRevision = Number(record.revision);
    let data;
    let error;

    if (Number.isInteger(expectedRevision) && expectedRevision > 0) {
      ({ data, error } = await client
        .from("invoices")
        .update({ ...row, revision: expectedRevision + 1 })
        .eq("user_id", userId)
        .eq("id", record.id)
        .eq("revision", expectedRevision)
        .select(INVOICE_COLUMNS)
        .maybeSingle());
      if (!error && !data) throw invoiceConflictError();
    } else {
      ({ data, error } = await client
        .from("invoices")
        .insert(row)
        .select(INVOICE_COLUMNS)
        .single());
    }

    throwInvoiceWriteError(error);
    return rowToRecord(data);
  }

  function invoiceConflictError() {
    const error = new Error("This invoice changed in another session. Reload it before saving again.");
    error.code = "INVOICE_REVISION_CONFLICT";
    return error;
  }

  function throwInvoiceWriteError(error) {
    if (!error) return;
    if (error.code === "40001" || String(error.message || "").includes("INVOICE_REVISION_CONFLICT")) {
      throw invoiceConflictError();
    }
    if (error.code === "23505" && String(error.message || error.details || "").includes("invoice_number")) {
      const conflict = new Error("That invoice number is already in use.");
      conflict.code = "INVOICE_NUMBER_CONFLICT";
      throw conflict;
    }
    throw error;
  }

  async function loadDraft(userId) {
    const { data, error } = await client
      .from("invoice_drafts")
      .select("invoice, revision")
      .eq("user_id", userId)
      .maybeSingle();
    throwIfError(error);
    return data ? { invoice: data.invoice, revision: Number(data.revision) } : null;
  }

  async function saveDraft(userId, invoice, signal, expectedRevision) {
    const revision = Number(expectedRevision);
    let request;
    if (Number.isInteger(revision) && revision > 0) {
      request = client
        .from("invoice_drafts")
        .update({ invoice, revision: revision + 1 })
        .eq("user_id", userId)
        .eq("revision", revision)
        .select("revision")
        .maybeSingle();
    } else {
      request = client
        .from("invoice_drafts")
        .insert({ user_id: userId, invoice })
        .select("revision")
        .single();
    }
    if (signal) request = request.abortSignal(signal);
    const { data, error } = await request;
    if (error?.code === "23505" || error?.code === "40001" || (!error && !data)) {
      const conflict = new Error("This draft changed in another session.");
      conflict.code = "DRAFT_REVISION_CONFLICT";
      throw conflict;
    }
    throwIfError(error);
    return { revision: Number(data.revision) };
  }

  async function deleteDraft(userId, signal, expectedRevision) {
    let request = client.from("invoice_drafts").delete().eq("user_id", userId);
    const revision = Number(expectedRevision);
    if (Number.isInteger(revision) && revision > 0) request = request.eq("revision", revision);
    request = request.select("revision").maybeSingle();
    if (signal) request = request.abortSignal(signal);
    const { data, error } = await request;
    throwIfError(error);
    if (Number.isInteger(revision) && revision > 0 && !data) {
      const conflict = new Error("This draft changed in another session.");
      conflict.code = "DRAFT_REVISION_CONFLICT";
      throw conflict;
    }
  }

  async function migrateLocalData(userId, records, draft) {
    if (records.length) {
      const { error } = await client
        .from("invoices")
        .upsert(records.map((record) => recordToRow(userId, record)), {
          onConflict: "user_id,id",
          ignoreDuplicates: true,
        });
      throwIfError(error);
    }
    if (draft) await saveDraft(userId, draft);
  }

  async function nextInvoiceNumber(invoiceDate) {
    const { data, error } = await client.rpc("next_invoice_number", { p_invoice_date: invoiceDate });
    throwIfError(error);
    return data;
  }

  window.invoiceBackend = {
    configured: true,
    guestMode: false,
    getSession,
    onAuthStateChange,
    signIn,
    signUp,
    sendPasswordReset,
    updatePassword,
    signOut,
    listInvoices,
    saveInvoice,
    loadDraft,
    saveDraft,
    deleteDraft,
    migrateLocalData,
    nextInvoiceNumber,
  };

  function createLocalGuestBackend() {
    const HISTORY_KEY = "invoice-studio-history-v1";
    const DRAFT_KEY = "invoice-studio-draft-v1";
    const DRAFT_REVISION_KEY = "invoice-studio-guest-draft-revision-v1";
    const SEQUENCE_KEY = "invoice-studio-sequence-v1";
    const guestSession = Object.freeze({
      user: Object.freeze({ id: "local-guest", email: "This device only" }),
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

    const unavailableAuthAction = async () => {
      throw new Error("Account login is temporarily disabled while local guest mode is active.");
    };

    return {
      configured: true,
      guestMode: true,
      getSession: async () => guestSession,
      onAuthStateChange: () => ({ unsubscribe() {} }),
      signIn: unavailableAuthAction,
      signUp: unavailableAuthAction,
      sendPasswordReset: unavailableAuthAction,
      updatePassword: unavailableAuthAction,
      signOut: async () => {},
      listInvoices,
      saveInvoice,
      loadDraft,
      saveDraft,
      deleteDraft,
      migrateLocalData,
      nextInvoiceNumber,
    };
  }
}());
