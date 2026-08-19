# Production operations

No external monitoring, backup or recovery service is created by this repository. The production owner must configure these controls and verify them against the selected Supabase and hosting plans.

## Service objectives and ownership

Before launch, assign owners and choose measurable targets for:

- recovery point objective (maximum acceptable data loss);
- recovery time objective (maximum acceptable outage);
- frontend and API availability;
- authentication email delivery;
- incident response and customer communication.

Keep escalation contacts and provider access outside the repository in an approved operational inventory.

## Backup policy

1. Enable the Supabase backup or point-in-time-recovery capability that meets the chosen RPO/RTO.
2. Keep an independent encrypted logical export on a schedule appropriate for invoice volume and retention requirements.
3. Store exports in a separate access-controlled account or project with encryption, retention and deletion policies.
4. Restrict database and backup credentials to the backup job and designated operators. Never use them in the browser build.
5. Alert when a scheduled export, provider backup or retention check fails.
6. Review whether business or regulatory obligations require invoice retention beyond the lifetime of an Auth account; the current foreign keys cascade on user deletion.

## Restore drill

Run a restore drill before launch and at least quarterly thereafter:

1. Choose a known recovery point and record the expected invoice/draft counts and sample record identifiers without copying customer data into the ticket.
2. Restore into an isolated non-production Supabase project.
3. Apply any later forward migrations needed by the current frontend.
4. Verify table counts, ownership, RLS enforcement with two test users, invoice-number allocation and application login/save behavior.
5. Record elapsed time, data gap, failures and remediation work.
6. Destroy the temporary restore project and its credentials according to the data-retention policy.

Never test a restore by overwriting the active production project.

## Monitoring and alerts

Configure dashboards and alerts for:

- static-site availability, TLS expiry and required response headers;
- JavaScript errors and failed authentication/data requests, with invoice content and credentials removed before reporting;
- Supabase database availability, connections, storage, query latency and error rate;
- Auth sign-up/sign-in/reset error rates and suspicious volume;
- PostgREST 401, 403, 409, 429 and 5xx responses;
- SMTP rejection, bounce and delivery failure;
- backup age, export failure and restore-drill status;
- hosting and Supabase quota or billing thresholds.

Use a dedicated synthetic account containing only test data for end-to-end monitoring. Do not place real customer names, invoice descriptions, access tokens or password-reset URLs in logs, error trackers or alert messages.

## Failure-mode runbook

### Frontend unavailable

Check the host status, domain/TLS, last deployment and required headers. Roll back to the last known-good static deploy if the failure began with a frontend release.

### Authentication email unavailable

Check Supabase Auth logs, SMTP provider health, sender-domain records, rate limits and bounce status. Do not disable email confirmation as an outage workaround.

### Supabase unavailable or quota exhausted

Place release activity on hold, inspect provider status and quota alerts, and communicate that invoices cannot currently load or save. The cached app shell is not a database backup and must not be represented as one.

### Draft reports "Could not sync"

The draft remains in the browser's per-user outbox and retries automatically. Ask the user to reconnect and wait for the account header to report that all changes are synced. The app deliberately blocks sign-out while a draft operation is pending. If retries continue while connectivity is healthy, preserve the browser profile and investigate the Supabase response before clearing any site data.

### Suspected credential exposure

Identify the credential type. A publishable key does not bypass RLS, but secret/service-role/database/SMTP/hosting credentials require immediate rotation, log review and an incident assessment. Redeploy after rotation and invalidate affected sessions where appropriate.

### Suspected cross-user access

Treat this as a security incident. Disable public access if necessary, preserve logs, reproduce only in an isolated environment, audit RLS/policies/grants and notify the designated security owner. Do not alter production evidence before it is captured.

### Data deletion or corruption

Stop writes where feasible, record the incident time and affected scope, identify the safest recovery point, and follow the tested restore process. Reconcile any invoices created after the recovery point before reopening writes.

## Routine checks

Weekly:

- review availability, Auth, database, SMTP and quota alerts;
- confirm the latest backup/export completed;
- review administrative membership and unusual authentication volume.

Monthly:

- apply reviewed dependency updates through staging;
- review storage growth, query latency and invoice-list scale;
- verify security headers and redirect allowlists;
- confirm operational contacts and billing remain current.

Quarterly:

- perform and document a restore drill;
- test two-user RLS isolation and password recovery;
- review RPO/RTO, retention and incident procedures.
