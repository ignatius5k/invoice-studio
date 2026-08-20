# Deployment

Invoice Studio is a static progressive web app. Run `npm run build` and publish the generated `dist/` directory from one stable HTTPS origin.

## Requirements

- Serve `index.html`, `sw.js`, and the application assets from the same origin.
- Apply the response headers generated at `dist/_headers`, or reproduce them on the selected host.
- Keep `index.html` and `sw.js` revalidating so updates are discovered promptly.
- Keep the production hostname stable. Browser records are scoped to the hostname and do not automatically move when it changes.
- Test installation, offline launch, invoice history, draft recovery, editing, duplication, PDF download, and printing on desktop and mobile before release.

## Release

```sh
npm ci
npm test
npm run build
```

Deploy `dist/` only after the checks pass. The build requires no secrets or public service configuration.

## Rollback

Restore the previous static artifact without changing the hostname. Do not clear browser storage during a rollback; stored invoices and drafts are independent of the application shell cache.
