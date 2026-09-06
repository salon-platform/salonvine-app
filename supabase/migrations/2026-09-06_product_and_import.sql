-- Owner data import (2026-09-06) — support for the portal "Import your data" screen.
-- Adds the one table SalonVine does not yet have (retail products) and makes sure
-- the four import targets are writable by the service role the import function uses.
-- SAFE to run more than once. Coordinate before running: this is on the shared
-- Supabase project (zdlytaswwvemnlgnonnd) that Dylan's booking engine also uses.

-- 1) Retail products a salon sells at the counter (shampoo, tools, gift cards…).
create table if not exists public.product (
  id          uuid primary key default gen_random_uuid(),
  salon_id    uuid not null references public.salon(id) on delete cascade,
  name        text not null,
  sku         text default '',
  price       integer not null default 0,   -- cents, same convention as service.price
  stock_qty   integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists product_salon_idx on public.product (salon_id);

-- Row-level security: a product is only ever visible/writable in the context of
-- its own salon. The import function talks to Supabase with the service role,
-- which bypasses RLS, so no permissive anon/auth policy is added here — the
-- public site reads products (when we surface them) through the same sv_site
-- RPC path as everything else, not by hitting this table directly.
alter table public.product enable row level security;

-- 2) The import runs as the service role via the Netlify function, so it already
--    has write access to service / client / stylist / working_hours. Nothing to
--    grant here — this block is a reminder of the targets, not a change:
--      services -> public.service        (name, price[cents], minutes, salon_id)
--      products -> public.product        (this table)
--      clients  -> public.client         (name, email, phone, salon_id)
--      staff    -> public.stylist        (name, email, phone, role, salon_id, is_public=false)
--      hours    -> public.working_hours  (weekday, opens, closes, closed, salon_id)

-- 3) Guard against accidental duplicate imports at the database level too, not
--    just in the function. Partial unique indexes, case-insensitive where it
--    matters. IF NOT EXISTS keeps this migration re-runnable.
create unique index if not exists service_salon_name_uidx
  on public.service (salon_id, lower(name));
create unique index if not exists product_salon_name_uidx
  on public.product (salon_id, lower(name));
