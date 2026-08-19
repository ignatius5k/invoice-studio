# Invoice Studio

An installable invoicing app based on the supplied Eng Hoon Residences invoice. It uses Supabase email/password authentication, stores each user's invoices and draft in Postgres, downloads named A4 PDF files, and can also print through the browser's print dialog.

## Set up Supabase

Complete [SUPABASE_SETUP.md](SUPABASE_SETUP.md) before using the app. It covers the database migration, row-level security policies, authentication redirect URLs, and the two public project values required in `supabase-config.js`.

The repository does not create external infrastructure. Staging and production each require an independently provisioned Supabase project, authentication email service, static-host environment and operational ownership. The full environment and promotion process is in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Use it

1. Create an account or sign in.
2. Select **Create invoice** from the invoice history page.
3. Enter the invoice details and the customer in **Bill to**.
4. Add one or more items with quantity and unit price.
5. Select **Save invoice**. This adds the invoice to history, or updates the existing history record when editing.
6. Choose **Save as PDF** to download the named file, or **Print** to open the browser print dialog.

From the first page, choose **Edit** to update a saved invoice or **Duplicate** to create a new invoice with the same customer and items. Duplicates receive a fresh invoice number and current dates before they are saved.

If the browser contains older local invoices, sign-in pauses for an explicit choice to move, export, discard, or keep them. Nothing is silently assigned to an account. New invoice data is written to Supabase and protected by owner-only row-level security.

The service worker caches only the application shell. Account records are never put in Cache Storage. Draft changes use a per-user IndexedDB outbox, retry automatically, and must finish syncing before sign-out; saving an issued invoice still requires a connection to Supabase.

Invoice history is fetched in 25-record pages, and invoice-number or customer searches run in Postgres. The PDF library is loaded only when **Save as PDF** is selected while remaining part of the offline app shell.

## Run locally

Install the exact Node version from `.nvmrc`, then run from this directory:

```sh
npm ci --ignore-scripts
npm run verify:vendor
python -m http.server 4173
```

Then open `http://localhost:4173`.

## Verify

```sh
npm test
npm audit --omit=dev
```

The browser suite requires Chrome or Chromium. CI fails if a supported browser is unavailable rather than silently dropping browser coverage.

The `Verify` workflow also starts a temporary Supabase database, rebuilds it from migrations, lints the schema, and runs the pgTAP policy tests in `supabase/tests/`. To run those database checks locally, install Docker and Supabase CLI 2.115.0, then use:

```sh
supabase db start
supabase db reset
supabase db lint --local --level warning --fail-on error
supabase test db --local
supabase stop --no-backup
```

## Build and deploy

Temporary guest access is controlled by `temporaryGuestMode` in `feature-flags.js`. While it is `true`, the app skips Supabase Auth and keeps invoices only in that browser. Set it to `false` to restore sign-in; the next signed-in session will offer to move the browser invoices into the account.

Tracked `supabase-config.js` contains the development project's browser-safe URL and publishable key. A deployable artifact is still generated from environment-specific public configuration:

```sh
SUPABASE_URL="https://PROJECT_REF.supabase.co" \
SUPABASE_PUBLISHABLE_KEY="sb_publishable_..." \
npm run build
```

This creates `dist/`, including a generated runtime configuration and security headers restricted to the selected Supabase origin. `netlify.toml` is the included static-host configuration because GitHub Pages cannot apply the required response headers.

Use [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for staging, production promotion and rollback. Use [docs/OPERATIONS.md](docs/OPERATIONS.md) for backups, restore drills, monitoring and incident response. No external resource or backup is created merely by running the build.

## Vendored dependencies

The browser bundles are reproducible from the exact versions in `package-lock.json`:

```sh
npm run sync:vendor
npm run verify:vendor
```

Commit a vendor change only with its matching exact dependency update. CI verifies byte-for-byte equality with the installed packages.

## Design artifacts

The four explored workspace directions are stored in `design-directions/`. The implemented direction is `system-clarity.png`; the A4 invoice itself follows the supplied PDF reference rather than any generated variation.
