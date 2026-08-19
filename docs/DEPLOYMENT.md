# Deployment and release process

This repository contains the application and database migration, but it does not provision a Supabase project, SMTP provider, domain, monitoring service, backup plan, or hosting account. Those resources must be created and owned outside the repository before a production release.

## Environments

Maintain isolated staging and production environments. Each environment needs:

- a separate Supabase project;
- its own email sender and authentication redirect allowlist;
- its own static-host deployment context and domain;
- `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` build variables;
- named operational owners and access limited to least privilege.

The publishable key is expected in browser code, but it must still be environment-specific. Never expose a Supabase secret key, service-role key, database password, SMTP credential, hosting token, or backup credential in a static build or pull-request log.

## External Supabase provisioning

For each environment:

1. Create the Supabase project in the intended organization and region.
2. Record project ownership, billing owner, recovery contacts and administrative access in the team's password manager or infrastructure inventory.
3. Apply the pending files in `supabase/migrations/` to staging first. A second reviewer should verify the target project before production execution.
4. Complete `SUPABASE_SETUP.md`, including the Site URL, exact redirect URLs, email confirmation and custom SMTP.
5. Configure Auth abuse controls: CAPTCHA, appropriate sign-up and email rate limits, leaked-password protection, session policy and alerts for SMTP failure or unusual sign-up volume.
6. Run two-user isolation tests: each account must be unable to select, update or delete the other account's invoices and draft, and unauthenticated access must fail.
7. Configure and verify backups before loading production data. See `docs/OPERATIONS.md`.

The SQL file is a schema migration, not a backup. Do not assume that committing it protects production data.

## Reproducible static build

Use the Node and npm versions pinned in `.nvmrc` and `package.json`:

```sh
npm ci --ignore-scripts
npm run verify:vendor
SUPABASE_URL="https://PROJECT_REF.supabase.co" \
SUPABASE_PUBLISHABLE_KEY="sb_publishable_..." \
npm run build
```

The build creates `dist/`, copies only the runtime asset allowlist, generates `dist/supabase-config.js`, and renders `dist/_headers` with the exact Supabase HTTPS and WebSocket origins. It rejects missing configuration, placeholders and obvious secret/service-role keys.

Netlify is the supplied production-host example because it serves the generated `_headers` file. `netlify.toml` publishes `dist/`. A different host is acceptable only if it reproduces all headers in `deployment/_headers.template` and keeps `index.html`, `sw.js`, and `supabase-config.js` revalidating rather than immutable.

GitHub Pages can serve a development preview, but it cannot apply the repository's required response-header policy. It is not the documented production target.

## Staging release

1. Open a pull request and require both `Application and infrastructure` and `Supabase migration and RLS` in the `Verify` workflow to pass.
2. Review application changes and migration changes separately. Confirm that vendored files changed only when their exact package version changed.
3. Apply new database migrations to staging before deploying code that depends on them.
4. Build the staging branch/deploy context with only staging variables.
5. Verify the deployed response headers, service-worker version and generated configuration.
6. Smoke-test account creation/confirmation, sign-in, password recovery, invoice creation, draft recovery, duplicate/edit, PDF download, sign-out and cross-user isolation on desktop and mobile.
7. Leave staging under normal monitoring long enough to expose Auth, SMTP and database errors before promotion.

## Production promotion

1. Identify the exact staging-tested commit and create a release record containing the commit, migration list, operator and rollback owner.
2. Confirm a current restorable production backup and record the recovery point.
3. Apply backward-compatible migrations first. Never remove a column or policy still needed by the currently deployed frontend.
4. Promote the staging-tested commit to `main`; do not make unreviewed production-only source changes.
5. Build with production variables and deploy `dist/`.
6. Run the smoke checks again against production without entering real customer data into monitoring accounts.
7. Watch frontend errors, Supabase Auth/PostgREST/database metrics, SMTP delivery and the external availability check during the release window.

## Rollback

For a frontend-only incident, restore the previously known-good static deployment through the host's immutable deploy history. Confirm that the older frontend remains compatible with the current schema before rollback.

Database changes are forward-only by default. Correct a faulty migration with a reviewed follow-up migration. Restore a database backup only for confirmed data loss or corruption, following `docs/OPERATIONS.md`; a restore has a much larger blast radius than a frontend rollback.

The service worker does not activate a new version immediately. Existing tabs continue on their current worker until they close, or until the application explicitly sends the `SKIP_WAITING` message. During rollback verification, close all installed-app windows and reopen the application so the intended worker becomes active.

## Release evidence

Retain the following with each release:

- source commit and static-host deploy identifier;
- CI result and dependency audit;
- rendered security-header check;
- migrations applied to each project;
- staging and production smoke-test results;
- backup recovery point and rollback owner;
- known limitations or follow-up work.
