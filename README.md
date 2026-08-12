# Invoice Studio

A fast, installable invoicing PWA based on the supplied Eng Hoon Residences invoice. It runs as a normal web app, saves drafts locally, works offline after the first visit, and prints to an A4 PDF through the browser's print dialog.

## Use it

1. Enter the invoice details and the customer in **Bill to**.
2. Add one or more items with quantity and unit price.
3. Select **Print / Save PDF**.
4. Choose **Save as PDF** in the browser print dialog.

Drafts are stored only in the current browser using `localStorage`. They remain on that browser profile until **Clear saved draft** is selected or the browser's site data is removed. Clear the draft after use on a shared device.

## Run locally

From this directory:

```powershell
python -m http.server 4173
```

Then open `http://localhost:4173`.

## Verify

```powershell
npm test
```

## GitHub Pages

Deploy from the `main` branch and repository root in **Settings > Pages**. The PWA uses relative URLs, so it works correctly under the repository's Pages subpath.

## Design artifacts

The four explored workspace directions are stored in `design-directions/`. The implemented direction is `system-clarity.png`; the A4 invoice itself follows the supplied PDF reference rather than any generated variation.
