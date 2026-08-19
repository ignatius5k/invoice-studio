begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(27);

select has_table('public', 'invoices', 'invoices table exists');
select ok(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'public.invoices'::regclass),
  'invoices has row-level security enabled'
);
select ok(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'public.invoice_drafts'::regclass),
  'invoice drafts have row-level security enabled'
);
select ok(
  (select relrowsecurity from pg_catalog.pg_class where oid = 'public.invoice_revisions'::regclass),
  'invoice revisions have row-level security enabled'
);
select ok(
  not pg_catalog.has_table_privilege('anon', 'public.invoices', 'SELECT'),
  'anonymous users have no invoice table privilege'
);
select ok(
  not pg_catalog.has_table_privilege('authenticated', 'public.invoice_counters', 'SELECT'),
  'authenticated users cannot read counters directly'
);
select ok(
  not pg_catalog.has_function_privilege('anon', 'public.next_invoice_number(date)', 'EXECUTE'),
  'anonymous users cannot allocate invoice numbers'
);

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  email_change,
  recovery_token
) values
  (
    '00000000-0000-0000-0000-000000000000',
    '11111111-1111-4111-8111-111111111111',
    'authenticated',
    'authenticated',
    'first@example.test',
    crypt('Testing!Password123', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(),
    now(),
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '22222222-2222-4222-8222-222222222222',
    'authenticated',
    'authenticated',
    'second@example.test',
    crypt('Testing!Password456', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}',
    '{}',
    now(),
    now(),
    '',
    '',
    ''
  );

select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select lives_ok(
  $sql$
    insert into public.invoices (
      user_id, id, invoice_number, pdf_file_name, invoice_date, due_date, bill_to, items
    ) values (
      '11111111-1111-4111-8111-111111111111',
      'invoice-a',
      'EHR-20260819-001',
      'EHR-20260819-001',
      date '2026-08-19',
      date '2026-08-26',
      'Weekend Market Customer',
      '[{"id":"item-a","quantity":2,"description":"Weekend market space","price":10.50}]'::jsonb
    )
  $sql$,
  'an authenticated user can insert their own valid invoice'
);
select is(
  (select total from public.invoices where id = 'invoice-a'),
  21.00::numeric,
  'invoice total is derived by the database'
);
select is(
  (select revision from public.invoices where id = 'invoice-a'),
  1,
  'new invoice starts at revision one'
);
select is(
  (select count(*) from public.invoices),
  1::bigint,
  'the owner can read their invoice'
);

reset role;
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
set local role authenticated;

select is(
  (select count(*) from public.invoices),
  0::bigint,
  'a second authenticated user cannot read the first user invoice'
);
select throws_ok(
  $sql$
    insert into public.invoices (
      user_id, id, invoice_number, pdf_file_name, invoice_date, due_date, bill_to, items
    ) values (
      '11111111-1111-4111-8111-111111111111',
      'invoice-cross-tenant',
      'EHR-20260819-002',
      'EHR-20260819-002',
      date '2026-08-19',
      date '2026-08-26',
      'Blocked customer',
      '[{"id":"item-b","quantity":1,"description":"Blocked item","price":1}]'::jsonb
    )
  $sql$,
  '42501',
  null,
  'a user cannot insert an invoice for another tenant'
);

reset role;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'anon', true);
set local role anon;

select throws_ok(
  $sql$select count(*) from public.invoices$sql$,
  '42501',
  null,
  'anonymous users are denied invoice table access'
);
select throws_ok(
  $sql$select public.next_invoice_number(date '2026-08-19')$sql$,
  '42501',
  null,
  'anonymous users cannot call invoice number allocation'
);

reset role;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

select throws_ok(
  $sql$
    insert into public.invoices (
      user_id, id, invoice_number, pdf_file_name, invoice_date, due_date, bill_to, items
    ) values (
      '11111111-1111-4111-8111-111111111111',
      'invoice-invalid',
      'EHR-20260819-003',
      'EHR-20260819-003',
      date '2026-08-19',
      date '2026-08-26',
      'Invalid customer',
      '[{"id":"item-invalid","quantity":0,"description":"Invalid item","price":1}]'::jsonb
    )
  $sql$,
  '23514',
  null,
  'the database rejects an invalid line item'
);

select lives_ok(
  $sql$
    insert into public.invoice_drafts (user_id, invoice)
    values (
      '11111111-1111-4111-8111-111111111111',
      jsonb_build_object(
        'draftDirty', true,
        'invoiceNumber', 'EHR-20260819-004',
        'pdfFileName', 'EHR-20260819-004',
        'pdfFileNameCustomized', false,
        'invoiceDate', '2026-08-19',
        'dueDate', '2026-08-26',
        'billTo', 'Draft customer',
        'items', '[{"id":"item-draft","quantity":1,"description":"Draft item","price":12}]'::jsonb
      )
    )
  $sql$,
  'an owner can create a structurally valid draft'
);

reset role;
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
set local role authenticated;
select is(
  (select count(*) from public.invoice_drafts),
  0::bigint,
  'a second user cannot read the first user draft'
);

reset role;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
set local role authenticated;

select lives_ok(
  $sql$
    update public.invoices
    set
      items = '[{"id":"item-a","quantity":3,"description":"Weekend market space","price":10.50}]'::jsonb,
      revision = revision + 1
    where id = 'invoice-a'
  $sql$,
  'the current owner revision can be updated'
);
select is(
  (select total from public.invoices where id = 'invoice-a'),
  31.50::numeric,
  'the database recalculates total after an update'
);
select is(
  (select revision from public.invoices where id = 'invoice-a'),
  2,
  'a successful update advances the revision'
);
select throws_ok(
  $sql$update public.invoices set revision = 2 where id = 'invoice-a'$sql$,
  '40001',
  null,
  'a stale revision is rejected'
);
select throws_ok(
  $sql$
    insert into public.invoices (
      user_id, id, invoice_number, pdf_file_name, invoice_date, due_date, bill_to, items
    ) values (
      '11111111-1111-4111-8111-111111111111',
      'invoice-duplicate-number',
      'EHR-20260819-001',
      'duplicate-file',
      date '2026-08-19',
      date '2026-08-26',
      'Duplicate number customer',
      '[{"id":"item-duplicate","quantity":1,"description":"Duplicate number item","price":1}]'::jsonb
    )
  $sql$,
  '23505',
  null,
  'invoice numbers are unique within an account'
);
select is(
  (select count(*) from public.invoice_revisions where invoice_id = 'invoice-a'),
  2::bigint,
  'the owner can read insert and update audit snapshots'
);

reset role;
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
set local role authenticated;
select is(
  (select count(*) from public.invoice_revisions),
  0::bigint,
  'a second user cannot read another account audit snapshots'
);
select throws_ok(
  $sql$
    insert into public.invoice_revisions (
      user_id, invoice_id, revision, operation, invoice_snapshot
    ) values (
      '22222222-2222-4222-8222-222222222222',
      'forged',
      1,
      'insert',
      '{}'::jsonb
    )
  $sql$,
  '42501',
  null,
  'browser roles cannot forge audit history'
);

reset role;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
set local role authenticated;
select matches(
  public.next_invoice_number(date '2026-08-20'),
  '^EHR-20260820-[0-9]{3}$',
  'invoice number allocation is scoped and formatted'
);

select * from finish();
rollback;
