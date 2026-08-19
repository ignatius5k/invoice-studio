-- Remove broad platform defaults before granting only the browser operations.
revoke all on table public.invoices from authenticated;
revoke all on table public.invoice_drafts from authenticated;

grant select, insert, update, delete on table public.invoices to authenticated;
grant select, insert, update, delete on table public.invoice_drafts to authenticated;
