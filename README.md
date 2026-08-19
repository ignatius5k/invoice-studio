# Invoice Studio

A fast, installable invoicing PWA based on the supplied Eng Hoon Residences invoice. It runs as a normal web app, keeps an editable invoice history and in-progress drafts locally, works offline after the first visit, downloads named A4 PDF files, and can also print through the browser's print dialog.

## Use it

1. Select **Create invoice** from the invoice history page.
2. Enter the invoice details and the customer in **Bill to**.
3. Add one or more items with quantity and unit price.
4. Select **Save invoice**. This adds the invoice to history, or updates the existing history record when editing.
5. Choose **Save as PDF** to download the named file, or **Print** to open the browser print dialog.

From the first page, choose **Edit** to update a saved invoice or **Duplicate** to create a new invoice with the same customer and items. Duplicates receive a fresh invoice number and current dates before they are saved.

Invoice history and drafts are stored only in the current browser using `localStorage`. They remain on that browser profile until the browser's site data is removed; **Clear saved draft** removes only the in-progress draft. Clear site data after use on a shared device.

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
