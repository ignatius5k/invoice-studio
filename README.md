# Invoice Studio

An installable, device-local invoicing app based on the supplied Eng Hoon Residences invoice. It creates, edits, duplicates, stores, downloads, and prints A4 invoices without requiring an account or remote data service.

## Local data

Invoices and drafts stay in the browser on the current device. The app keeps the original storage keys so records created by earlier local versions remain available:

- `invoice-studio-history-v1`
- `invoice-studio-draft-v1`
- `invoice-studio-guest-draft-revision-v1`
- `invoice-studio-sequence-v1`

Browser storage is tied to the exact site origin. Clearing site data, using private browsing, changing domains, or opening the app on a different device will not carry records across automatically.

## Run locally

Use any static file server from the repository root. For example:

```sh
python3 -m http.server 4173
```

Then open `http://localhost:4173`.

## Verify

```sh
npm ci
npm test
npm run build
```

The build writes the deployable static site to `dist/`. No runtime environment variables are required.

## Production notes

See [deployment](docs/DEPLOYMENT.md) for static-host requirements and [operations](docs/OPERATIONS.md) for local-data precautions.
