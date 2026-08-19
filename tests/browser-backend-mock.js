(function installBrowserBackendMock() {
  const REMOTE_HISTORY_KEY = "test-supabase-invoices";
  const REMOTE_DRAFT_KEY = "test-supabase-draft";
  const REMOTE_COUNTER_KEY = "test-supabase-counters";
  let session = { user: { id: "test-user-1", email: "owner@example.com" } };
  let authCallback;
  const controls = {
    draftSaveFailures: 0,
    draftDeleteFailures: 0,
    listFailures: 0,
    signOutCalls: 0,
    listCalls: [],
  };

  window.INVOICE_STUDIO_SUPABASE = {
    url: "https://test-project.supabase.co",
    publishableKey: "sb_publishable_test",
  };

  function read(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback));
    } catch {
      return fallback;
    }
  }

  function write(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function copy(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function syncCounter(record) {
    const match = record.invoice.invoiceNumber.match(/^EHR-(\d{8})-(\d+)$/);
    if (!match) return;
    const counters = read(REMOTE_COUNTER_KEY, {});
    counters[match[1]] = Math.max(counters[match[1]] || 0, Number(match[2]));
    write(REMOTE_COUNTER_KEY, counters);
  }

  window.__INVOICE_STUDIO_BACKEND_FACTORY__ = () => ({
    configured: true,
    async getSession() {
      return copy(session);
    },
    onAuthStateChange(callback) {
      authCallback = callback;
      return { unsubscribe() {} };
    },
    async signIn(email) {
      session = { user: { id: "test-user-1", email } };
      authCallback?.("SIGNED_IN", copy(session));
      return { session: copy(session), user: copy(session.user) };
    },
    async signUp(email) {
      return { session: null, user: { id: "pending-user", email } };
    },
    async sendPasswordReset() {},
    async updatePassword() {
      return { user: copy(session.user) };
    },
    async signOut() {
      controls.signOutCalls += 1;
      session = null;
      authCallback?.("SIGNED_OUT", null);
    },
    async listInvoices(_userId, options = {}) {
      controls.listCalls.push(copy(options));
      if (controls.listFailures > 0) {
        controls.listFailures -= 1;
        throw new Error("Invoice list unavailable.");
      }
      const limit = Math.min(50, Math.max(1, Number(options.limit) || 25));
      const query = String(options.query || "").trim().toLocaleLowerCase("en-SG");
      const cursor = options.cursor || null;
      const matching = copy(read(REMOTE_HISTORY_KEY, []))
        .filter((record) => !query || `${record.invoice.invoiceNumber} ${record.invoice.billTo}`.toLocaleLowerCase("en-SG").includes(query))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
      const afterCursor = cursor
        ? matching.filter((record) => record.updatedAt < cursor.updatedAt
          || (record.updatedAt === cursor.updatedAt && record.id < cursor.id))
        : matching;
      const page = afterCursor.slice(0, limit + 1);
      const hasMore = page.length > limit;
      const records = hasMore ? page.slice(0, limit) : page;
      const last = records.at(-1);
      return {
        records,
        total: matching.length,
        nextCursor: hasMore && last ? { updatedAt: last.updatedAt, id: last.id } : null,
      };
    },
    async saveInvoice(_userId, record) {
      const records = read(REMOTE_HISTORY_KEY, []);
      const existing = records.find((candidate) => candidate.id === record.id);
      if (existing && record.revision !== existing.revision) {
        const error = new Error("This invoice changed in another session.");
        error.code = "INVOICE_REVISION_CONFLICT";
        throw error;
      }
      const saved = copy({
        ...record,
        revision: existing ? existing.revision + 1 : 1,
        createdAt: existing?.createdAt || record.createdAt,
        updatedAt: new Date().toISOString(),
      });
      write(REMOTE_HISTORY_KEY, [saved, ...records.filter((candidate) => candidate.id !== saved.id)]);
      syncCounter(saved);
      return copy(saved);
    },
    async loadDraft() {
      const stored = read(REMOTE_DRAFT_KEY, null);
      if (!stored) return null;
      return copy(stored.invoice && stored.revision ? stored : { invoice: stored, revision: 1 });
    },
    async saveDraft(_userId, invoice, _signal, expectedRevision) {
      if (controls.draftSaveFailures > 0) {
        controls.draftSaveFailures -= 1;
        throw new Error("Draft network failure.");
      }
      const stored = read(REMOTE_DRAFT_KEY, null);
      const existing = stored ? (stored.invoice && stored.revision ? stored : { invoice: stored, revision: 1 }) : null;
      if (existing && expectedRevision !== existing.revision) {
        const error = new Error("This draft changed in another session.");
        error.code = "DRAFT_REVISION_CONFLICT";
        throw error;
      }
      if (!existing && expectedRevision !== undefined) {
        const error = new Error("This draft changed in another session.");
        error.code = "DRAFT_REVISION_CONFLICT";
        throw error;
      }
      const saved = { invoice: copy(invoice), revision: existing ? existing.revision + 1 : 1 };
      write(REMOTE_DRAFT_KEY, saved);
      return { revision: saved.revision };
    },
    async deleteDraft(_userId, _signal, expectedRevision) {
      if (controls.draftDeleteFailures > 0) {
        controls.draftDeleteFailures -= 1;
        throw new Error("Draft delete network failure.");
      }
      const stored = read(REMOTE_DRAFT_KEY, null);
      const existingRevision = stored ? (stored.revision || 1) : undefined;
      if (expectedRevision !== undefined && expectedRevision !== existingRevision) {
        const error = new Error("This draft changed in another session.");
        error.code = "DRAFT_REVISION_CONFLICT";
        throw error;
      }
      localStorage.removeItem(REMOTE_DRAFT_KEY);
    },
    async migrateLocalData(_userId, records, draft) {
      const remote = read(REMOTE_HISTORY_KEY, []);
      const migratedIds = new Set(records.map((record) => record.id));
      write(REMOTE_HISTORY_KEY, [
        ...copy(records).map((record) => ({ ...record, revision: 1 })),
        ...remote.filter((record) => !migratedIds.has(record.id)),
      ]);
      records.forEach(syncCounter);
      if (draft) {
        if (read(REMOTE_DRAFT_KEY, null)) throw new Error("The account already has a draft. Choose which draft to keep before moving local data.");
        write(REMOTE_DRAFT_KEY, { invoice: copy(draft), revision: 1 });
      }
    },
    async nextInvoiceNumber(invoiceDate) {
      const compactDate = invoiceDate.replaceAll("-", "");
      const counters = read(REMOTE_COUNTER_KEY, {});
      counters[compactDate] = (counters[compactDate] || 0) + 1;
      write(REMOTE_COUNTER_KEY, counters);
      return `EHR-${compactDate}-${String(counters[compactDate]).padStart(3, "0")}`;
    },
  });

  window.__BROWSER_BACKEND_MOCK__ = {
    emitPasswordRecovery() {
      authCallback?.("PASSWORD_RECOVERY", copy(session));
    },
    failNextDraftSaves(count = 1) {
      controls.draftSaveFailures = count;
    },
    failNextDraftDeletes(count = 1) {
      controls.draftDeleteFailures = count;
    },
    failNextLists(count = 1) {
      controls.listFailures = count;
    },
    controls,
  };
}());
