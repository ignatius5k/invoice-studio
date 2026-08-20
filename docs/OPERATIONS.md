# Operations

Invoice Studio currently stores invoice records only in each browser profile. There is no remote replica or cross-device recovery service.

## Data precautions

- Do not clear site data on a device that contains invoices that still matter.
- Avoid private browsing for production work because its storage can be discarded automatically.
- Keep the deployed origin stable; each origin has a separate browser storage area.
- Save important completed invoices as PDFs using the app's existing output flow.
- Before device replacement or browser-profile removal, confirm that required invoices have been saved externally.

## Troubleshooting

If records appear missing, first verify the exact hostname, protocol, browser profile, and device. A different combination will have a different local data store.

If the application shell fails to update, reload once while online. The service worker removes older shell caches during activation without deleting invoice records from local storage.

If a draft reports a local conflict, keep the version with the expected invoice number, customer, and line items. The conflict guard exists to prevent two tabs from silently overwriting one another.
