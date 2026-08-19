# Supabase setup

Invoice Studio uses Supabase Auth and Postgres. Invoice and draft access is enforced with row-level security, so each authenticated user can access only their own records.

## 1. Create and configure the project

1. Create a Supabase project.
2. Apply the SQL files in [`supabase/migrations/`](supabase/migrations/) in timestamp order, preferably with `supabase db push` so migration history stays synchronized.
3. In **Authentication > URL Configuration**, set **Site URL** to the exact production app URL. Add only exact trusted production and development callback URLs under **Redirect URLs** (for example, `http://localhost:4173/**`). Do not use a wildcard that could match deployments controlled by another person.
4. In **Authentication > Providers > Email**, keep email/password enabled. For production, require email confirmation and configure a custom SMTP provider with appropriate sending limits.
5. Copy the project URL and publishable key from **Project Settings > API** into `supabase-config.js`.

Use the publishable key (or legacy anon key) in the browser. Never place a `service_role` or secret key in this project.

## 2. Data migration behavior

If the browser contains `invoice-studio-history-v1` or `invoice-studio-draft-v1` data, the app pauses sign-in and shows the record count and destination email. The user must explicitly choose to move it, export a JSON backup, discard it, or cancel sign-in. Nothing is silently attached to an account. Local entries are removed only after a successful move or an explicit discard.

The service worker still caches the application shell for installation, but it does not cache invoice records. An internet connection is required to load or save account data.

## 3. Security rules

The migration enables RLS before granting table access:

- `anon` receives no table privileges.
- `authenticated` can select, insert, update, and delete `invoices` only when `auth.uid() = user_id`.
- The same owner-only rules protect `invoice_drafts`.
- Clients cannot access `invoice_counters` directly. They can only execute `next_invoice_number(date)`, which derives ownership from the authenticated JWT.
- Saved items and drafts have database-enforced JSON schemas, numeric and text ranges, serialized-size caps, and fixed date bounds. The database calculates invoice totals and owns timestamps.
- Each account is limited to 2,000 invoices, 3,660 dated counters, and 100 revisions per invoice.
- Invoice numbers are unique per account. Invoice and draft revision numbers provide optimistic concurrency, so a stale browser session cannot silently overwrite newer data.
- `invoice_revisions` is append-only to browser clients and records insert, update, and delete snapshots. Users may read only their own revision history.
- Deleting an Auth user cascades to that user's invoices, draft, and counters.

The public key identifies the Supabase project; it does not bypass RLS. Administrative work that uses a service-role key must run only in a trusted server environment.

## 4. Production authentication checklist

Before enabling public sign-up:

- Enable CAPTCHA for sign-up, sign-in, and password-recovery traffic.
- Review Auth rate limits for sign-up, token refresh, verification, and password recovery. Match them to the expected user count and SMTP capacity.
- Set the dashboard password minimum to 6 characters or stronger, match the character requirements in `supabase/config.toml`, and enable leaked-password protection when available on the selected Supabase plan.
- Enable MFA for administrative or other privileged accounts. This app has no elevated browser role; perform administrative work only through trusted server-side tooling.
- Set an appropriate session lifetime and inactivity policy for the devices that will use the app. Shared devices should sign out after use.
- Keep redirect URLs exact and remove expired preview deployments promptly.
- Test account confirmation, password recovery, sign-out, CAPTCHA, and throttling against the production domain before launch.
- Define backup retention, invoice-revision retention, account deletion, and incident-recovery procedures for the organization.
