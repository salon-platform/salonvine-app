-- Product photos + low-stock threshold (2026-09-06). Additive and re-runnable.
-- Run in the Supabase SQL editor for project zdlytaswwvemnlgnonnd.
alter table public.product add column if not exists image_url text default '';
alter table public.product add column if not exists low_stock_at integer;
