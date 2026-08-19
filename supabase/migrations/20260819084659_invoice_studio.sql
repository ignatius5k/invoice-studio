begin;

create or replace function public.invoice_items_are_valid(p_items jsonb)
returns boolean
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  item jsonb;
  item_key_count integer;
  quantity_value numeric;
  price_value numeric;
begin
  if pg_catalog.jsonb_typeof(p_items) <> 'array'
    or pg_catalog.jsonb_array_length(p_items) not between 1 and 5
    or pg_catalog.octet_length(p_items::text) > 16000 then
    return false;
  end if;

  for item in select value from pg_catalog.jsonb_array_elements(p_items)
  loop
    select pg_catalog.count(*) into item_key_count from pg_catalog.jsonb_object_keys(item);
    if pg_catalog.jsonb_typeof(item) <> 'object'
      or item_key_count <> 4
      or not (item ?& array['id', 'quantity', 'description', 'price'])
      or pg_catalog.jsonb_typeof(item -> 'id') <> 'string'
      or pg_catalog.jsonb_typeof(item -> 'quantity') <> 'number'
      or pg_catalog.jsonb_typeof(item -> 'description') <> 'string'
      or pg_catalog.jsonb_typeof(item -> 'price') <> 'number'
      or pg_catalog.char_length(item ->> 'id') not between 1 and 160
      or (item ->> 'id') !~ '^[A-Za-z0-9._:-]+$'
      or pg_catalog.char_length(item ->> 'description') not between 1 and 1000 then
      return false;
    end if;

    quantity_value := (item ->> 'quantity')::numeric;
    price_value := (item ->> 'price')::numeric;
    if quantity_value not between 1 and 9999
      or quantity_value <> pg_catalog.trunc(quantity_value)
      or price_value not between 0 and 999999999.99
      or price_value <> pg_catalog.round(price_value, 2) then
      return false;
    end if;
  end loop;

  return true;
exception
  when others then
    return false;
end;
$$;

create or replace function public.invoice_draft_items_are_valid(p_items jsonb)
returns boolean
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  item jsonb;
  item_key_count integer;
  quantity_value numeric;
  price_value numeric;
begin
  if pg_catalog.jsonb_typeof(p_items) <> 'array'
    or pg_catalog.jsonb_array_length(p_items) not between 1 and 5
    or pg_catalog.octet_length(p_items::text) > 16000 then
    return false;
  end if;

  for item in select value from pg_catalog.jsonb_array_elements(p_items)
  loop
    select pg_catalog.count(*) into item_key_count from pg_catalog.jsonb_object_keys(item);
    if pg_catalog.jsonb_typeof(item) <> 'object'
      or item_key_count <> 4
      or not (item ?& array['id', 'quantity', 'description', 'price'])
      or pg_catalog.jsonb_typeof(item -> 'id') <> 'string'
      or pg_catalog.jsonb_typeof(item -> 'description') <> 'string'
      or pg_catalog.char_length(item ->> 'id') not between 1 and 160
      or (item ->> 'id') !~ '^[A-Za-z0-9._:-]+$'
      or pg_catalog.char_length(item ->> 'description') > 1000 then
      return false;
    end if;

    if pg_catalog.jsonb_typeof(item -> 'quantity') = 'string' and (item ->> 'quantity') = '' then
      quantity_value := null;
    elsif pg_catalog.jsonb_typeof(item -> 'quantity') = 'number' then
      quantity_value := (item ->> 'quantity')::numeric;
      if quantity_value not between 1 and 9999 or quantity_value <> pg_catalog.trunc(quantity_value) then
        return false;
      end if;
    else
      return false;
    end if;

    if pg_catalog.jsonb_typeof(item -> 'price') = 'string' and (item ->> 'price') = '' then
      price_value := null;
    elsif pg_catalog.jsonb_typeof(item -> 'price') = 'number' then
      price_value := (item ->> 'price')::numeric;
      if price_value not between 0 and 999999999.99 or price_value <> pg_catalog.round(price_value, 2) then
        return false;
      end if;
    else
      return false;
    end if;
  end loop;

  return true;
exception
  when others then
    return false;
end;
$$;

create or replace function public.invoice_draft_is_valid(p_invoice jsonb)
returns boolean
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  invoice_date_value date;
  due_date_value date;
  invoice_key_count integer;
begin
  if pg_catalog.jsonb_typeof(p_invoice) = 'object' then
    select pg_catalog.count(*) into invoice_key_count from pg_catalog.jsonb_object_keys(p_invoice);
  end if;
  if pg_catalog.jsonb_typeof(p_invoice) <> 'object'
    or pg_catalog.octet_length(p_invoice::text) > 24000
    or invoice_key_count not between 8 and 9
    or not (p_invoice ?& array[
      'draftDirty', 'invoiceNumber', 'pdfFileName', 'pdfFileNameCustomized',
      'invoiceDate', 'dueDate', 'billTo', 'items'
    ])
    or pg_catalog.jsonb_typeof(p_invoice -> 'draftDirty') <> 'boolean'
    or pg_catalog.jsonb_typeof(p_invoice -> 'invoiceNumber') <> 'string'
    or pg_catalog.jsonb_typeof(p_invoice -> 'pdfFileName') <> 'string'
    or pg_catalog.jsonb_typeof(p_invoice -> 'pdfFileNameCustomized') <> 'boolean'
    or pg_catalog.jsonb_typeof(p_invoice -> 'invoiceDate') <> 'string'
    or pg_catalog.jsonb_typeof(p_invoice -> 'dueDate') <> 'string'
    or pg_catalog.jsonb_typeof(p_invoice -> 'billTo') <> 'string'
    or pg_catalog.char_length(p_invoice ->> 'invoiceNumber') not between 1 and 120
    or pg_catalog.char_length(p_invoice ->> 'pdfFileName') not between 1 and 120
    or pg_catalog.char_length(p_invoice ->> 'billTo') > 2000
    or (p_invoice ? 'historyId' and (
      pg_catalog.jsonb_typeof(p_invoice -> 'historyId') <> 'string'
      or pg_catalog.char_length(p_invoice ->> 'historyId') not between 1 and 160
    ))
    or (p_invoice ->> 'invoiceDate') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or (p_invoice ->> 'dueDate') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or not public.invoice_draft_items_are_valid(p_invoice -> 'items') then
    return false;
  end if;

  invoice_date_value := (p_invoice ->> 'invoiceDate')::date;
  due_date_value := (p_invoice ->> 'dueDate')::date;
  return invoice_date_value between date '2000-01-01' and date '2100-12-31'
    and due_date_value between invoice_date_value and date '2100-12-31';
exception
  when others then
    return false;
end;
$$;

create or replace function public.calculate_invoice_total(p_items jsonb)
returns numeric
language sql
immutable
strict
set search_path = ''
as $$
  select pg_catalog.round(
    coalesce(
      pg_catalog.sum((item ->> 'quantity')::numeric * (item ->> 'price')::numeric),
      0::numeric
    ),
    2
  )
  from pg_catalog.jsonb_array_elements(p_items) as line(item);
$$;

create table public.invoices (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null check (
    pg_catalog.char_length(id) between 1 and 160
    and id ~ '^[A-Za-z0-9._:-]+$'
  ),
  revision integer not null default 1 check (revision between 1 and 100),
  invoice_number text not null check (
    pg_catalog.char_length(invoice_number) between 1 and 120
    and invoice_number = pg_catalog.upper(invoice_number)
    and invoice_number = pg_catalog.btrim(invoice_number)
  ),
  pdf_file_name text not null check (
    pg_catalog.char_length(pdf_file_name) between 1 and 120
    and pdf_file_name !~ '[[:cntrl:]]'
  ),
  pdf_file_name_customized boolean not null default false,
  invoice_date date not null check (invoice_date between date '2000-01-01' and date '2100-12-31'),
  due_date date not null check (due_date between invoice_date and date '2100-12-31'),
  bill_to text not null check (pg_catalog.char_length(pg_catalog.btrim(bill_to)) between 1 and 2000),
  items jsonb not null check (public.invoice_items_are_valid(items)),
  total numeric(20, 2) not null default 0 check (total >= 0),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (user_id, id),
  constraint invoices_user_invoice_number_key unique (user_id, invoice_number)
);

create table public.invoice_drafts (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  invoice jsonb not null check (public.invoice_draft_is_valid(invoice)),
  revision integer not null default 1 check (revision > 0),
  updated_at timestamptz not null default pg_catalog.now()
);

create table public.invoice_counters (
  user_id uuid not null references auth.users(id) on delete cascade,
  invoice_date date not null check (invoice_date between date '2000-01-01' and date '2100-12-31'),
  last_sequence integer not null check (last_sequence between 1 and 999999),
  primary key (user_id, invoice_date)
);

create table public.invoice_revisions (
  event_id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  invoice_id text not null,
  revision integer not null,
  operation text not null check (operation in ('insert', 'update', 'delete')),
  invoice_snapshot jsonb not null,
  recorded_at timestamptz not null default pg_catalog.now()
);

create index invoices_user_updated_idx on public.invoices (user_id, updated_at desc);
create index invoice_revisions_user_invoice_idx on public.invoice_revisions (user_id, invoice_id, event_id desc);

create or replace function public.prepare_invoice_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  invoice_count integer;
begin
  if (select auth.uid()) is not null and new.user_id <> (select auth.uid()) then
    raise exception 'Cannot write an invoice for another user' using errcode = '42501';
  end if;
  if not public.invoice_items_are_valid(new.items) then
    raise exception 'Invalid invoice items' using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.user_id::text, 7441));
    select pg_catalog.count(*) into invoice_count
    from public.invoices
    where user_id = new.user_id;
    if invoice_count >= 2000 then
      raise exception 'INVOICE_QUOTA_EXCEEDED: maximum 2000 invoices per account' using errcode = 'P0001';
    end if;
    new.revision := 1;
    new.created_at := pg_catalog.clock_timestamp();
  else
    if new.user_id is distinct from old.user_id or new.id is distinct from old.id then
      raise exception 'Invoice identity cannot be changed' using errcode = '42501';
    end if;
    if new.revision is distinct from old.revision + 1 then
      raise exception 'INVOICE_REVISION_CONFLICT' using errcode = '40001';
    end if;
    if old.revision >= 100 then
      raise exception 'INVOICE_REVISION_QUOTA_EXCEEDED: maximum 100 revisions per invoice' using errcode = 'P0001';
    end if;
    new.created_at := old.created_at;
  end if;

  new.total := public.calculate_invoice_total(new.items);
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;

create trigger invoices_prepare_write
before insert or update on public.invoices
for each row execute function public.prepare_invoice_write();

create or replace function public.prepare_invoice_draft_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null and new.user_id <> (select auth.uid()) then
    raise exception 'Cannot write a draft for another user' using errcode = '42501';
  end if;
  if not public.invoice_draft_is_valid(new.invoice) then
    raise exception 'Invalid invoice draft' using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    new.revision := 1;
  else
    if new.user_id is distinct from old.user_id then
      raise exception 'Draft identity cannot be changed' using errcode = '42501';
    end if;
    if new.revision is distinct from old.revision + 1 then
      raise exception 'DRAFT_REVISION_CONFLICT' using errcode = '40001';
    end if;
  end if;
  new.updated_at := pg_catalog.clock_timestamp();
  return new;
end;
$$;

create trigger invoice_drafts_prepare_write
before insert or update on public.invoice_drafts
for each row execute function public.prepare_invoice_draft_write();

create or replace function public.record_invoice_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    insert into public.invoice_revisions (
      user_id, invoice_id, revision, operation, invoice_snapshot, recorded_at
    ) values (
      old.user_id, old.id, old.revision, 'delete', pg_catalog.to_jsonb(old), pg_catalog.clock_timestamp()
    );
    return old;
  end if;

  insert into public.invoice_revisions (
    user_id, invoice_id, revision, operation, invoice_snapshot, recorded_at
  ) values (
    new.user_id, new.id, new.revision, pg_catalog.lower(tg_op), pg_catalog.to_jsonb(new), pg_catalog.clock_timestamp()
  );
  return new;
end;
$$;

create trigger invoices_record_revision
after insert or update or delete on public.invoices
for each row execute function public.record_invoice_revision();

create or replace function public.sync_invoice_counter_from_invoice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  number_parts text[];
  parsed_date date;
  parsed_sequence integer;
begin
  number_parts := pg_catalog.regexp_match(new.invoice_number, '^EHR-([0-9]{8})-([0-9]{1,6})$');
  if number_parts is null then
    return new;
  end if;

  begin
    parsed_date := pg_catalog.to_date(number_parts[1], 'YYYYMMDD');
    parsed_sequence := number_parts[2]::integer;
  exception when others then
    return new;
  end;
  if parsed_date not between date '2000-01-01' and date '2100-12-31'
    or parsed_sequence not between 1 and 999999 then
    return new;
  end if;

  insert into public.invoice_counters (user_id, invoice_date, last_sequence)
  values (new.user_id, parsed_date, parsed_sequence)
  on conflict (user_id, invoice_date) do update
  set last_sequence = greatest(public.invoice_counters.last_sequence, excluded.last_sequence);

  return new;
end;
$$;

create trigger invoices_sync_counter
after insert or update of invoice_number on public.invoices
for each row execute function public.sync_invoice_counter_from_invoice();

create or replace function public.next_invoice_number(p_invoice_date date)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  next_sequence integer;
  counter_count integer;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if p_invoice_date is null or p_invoice_date not between date '2000-01-01' and date '2100-12-31' then
    raise exception 'Invoice date is outside the permitted range' using errcode = '22008';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(requesting_user::text, 7442));
  select last_sequence into next_sequence
  from public.invoice_counters
  where user_id = requesting_user and invoice_date = p_invoice_date
  for update;

  if found then
    if next_sequence >= 999999 then
      raise exception 'INVOICE_SEQUENCE_EXHAUSTED' using errcode = 'P0001';
    end if;
    next_sequence := next_sequence + 1;
    update public.invoice_counters
    set last_sequence = next_sequence
    where user_id = requesting_user and invoice_date = p_invoice_date;
  else
    select pg_catalog.count(*) into counter_count
    from public.invoice_counters
    where user_id = requesting_user;
    if counter_count >= 3660 then
      raise exception 'COUNTER_QUOTA_EXCEEDED: maximum 3660 dated counters per account' using errcode = 'P0001';
    end if;
    next_sequence := 1;
    insert into public.invoice_counters (user_id, invoice_date, last_sequence)
    values (requesting_user, p_invoice_date, next_sequence);
  end if;

  return pg_catalog.format(
    'EHR-%s-%s',
    pg_catalog.to_char(p_invoice_date, 'YYYYMMDD'),
    pg_catalog.lpad(next_sequence::text, 3, '0')
  );
end;
$$;

create or replace function public.list_invoices_page(
  p_query text default '',
  p_limit integer default 25,
  p_cursor_updated_at timestamptz default null,
  p_cursor_id text default null
)
returns table (
  id text,
  revision integer,
  invoice_number text,
  pdf_file_name text,
  pdf_file_name_customized boolean,
  invoice_date date,
  due_date date,
  bill_to text,
  items jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  total_count bigint
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  requesting_user uuid := (select auth.uid());
  query_value text := pg_catalog.left(pg_catalog.btrim(coalesce(p_query, '')), 120);
  escaped_query text;
  page_limit integer := greatest(1, least(coalesce(p_limit, 25), 50));
  cursor_updated_at timestamptz := p_cursor_updated_at;
  cursor_id text := p_cursor_id;
begin
  if requesting_user is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  if (cursor_updated_at is null) <> (cursor_id is null) then
    raise exception 'A complete invoice cursor is required' using errcode = '22023';
  end if;
  if cursor_id is not null and pg_catalog.char_length(cursor_id) not between 1 and 160 then
    raise exception 'Invoice cursor is invalid' using errcode = '22023';
  end if;

  escaped_query := pg_catalog.replace(
    pg_catalog.replace(
      pg_catalog.replace(query_value, E'\\', E'\\\\'),
      '%', E'\\%'
    ),
    '_', E'\\_'
  );

  return query
  with matching as (
    select
      invoice.id,
      invoice.revision,
      invoice.invoice_number,
      invoice.pdf_file_name,
      invoice.pdf_file_name_customized,
      invoice.invoice_date,
      invoice.due_date,
      invoice.bill_to,
      invoice.items,
      invoice.created_at,
      invoice.updated_at,
      pg_catalog.count(*) over () as total_count
    from public.invoices as invoice
    where invoice.user_id = requesting_user
      and (
        escaped_query = ''
        or invoice.invoice_number ilike '%' || escaped_query || '%' escape E'\\'
        or invoice.bill_to ilike '%' || escaped_query || '%' escape E'\\'
      )
  )
  select
    matching.id,
    matching.revision,
    matching.invoice_number,
    matching.pdf_file_name,
    matching.pdf_file_name_customized,
    matching.invoice_date,
    matching.due_date,
    matching.bill_to,
    matching.items,
    matching.created_at,
    matching.updated_at,
    matching.total_count
  from matching
  where cursor_updated_at is null
    or (matching.updated_at, matching.id) < (cursor_updated_at, cursor_id)
  order by matching.updated_at desc, matching.id desc
  limit page_limit + 1;
end;
$$;

alter table public.invoices enable row level security;
alter table public.invoice_drafts enable row level security;
alter table public.invoice_counters enable row level security;
alter table public.invoice_revisions enable row level security;

create policy "Users can read their invoices"
on public.invoices for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can create their invoices"
on public.invoices for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their invoices"
on public.invoices for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete their invoices"
on public.invoices for delete
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can read their draft"
on public.invoice_drafts for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can create their draft"
on public.invoice_drafts for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their draft"
on public.invoice_drafts for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete their draft"
on public.invoice_drafts for delete
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can read their invoice revision history"
on public.invoice_revisions for select
to authenticated
using ((select auth.uid()) = user_id);

revoke all on table public.invoices from anon, authenticated;
revoke all on table public.invoice_drafts from anon, authenticated;
revoke all on table public.invoice_counters from anon, authenticated;
revoke all on table public.invoice_revisions from anon, authenticated;
grant select, insert, update, delete on table public.invoices to authenticated;
grant select, insert, update, delete on table public.invoice_drafts to authenticated;
grant select on table public.invoice_revisions to authenticated;

revoke all on function public.invoice_items_are_valid(jsonb) from public, anon;
revoke all on function public.invoice_draft_items_are_valid(jsonb) from public, anon;
revoke all on function public.invoice_draft_is_valid(jsonb) from public, anon;
grant execute on function public.invoice_items_are_valid(jsonb) to authenticated;
grant execute on function public.invoice_draft_items_are_valid(jsonb) to authenticated;
grant execute on function public.invoice_draft_is_valid(jsonb) to authenticated;
revoke all on function public.calculate_invoice_total(jsonb) from public, anon, authenticated;
revoke all on function public.prepare_invoice_write() from public, anon, authenticated;
revoke all on function public.prepare_invoice_draft_write() from public, anon, authenticated;
revoke all on function public.record_invoice_revision() from public, anon, authenticated;
revoke all on function public.sync_invoice_counter_from_invoice() from public, anon, authenticated;
revoke all on function public.next_invoice_number(date) from public, anon;
grant execute on function public.next_invoice_number(date) to authenticated;
revoke all on function public.list_invoices_page(text, integer, timestamptz, text) from public, anon;
grant execute on function public.list_invoices_page(text, integer, timestamptz, text) to authenticated;

commit;
