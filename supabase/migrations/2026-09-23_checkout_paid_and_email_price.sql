-- Applied by hand in the Supabase SQL editor on 2026-09-23. Kept here so the
-- schema in git matches the live database.

-- 1. The outbox sender (service role) inserts staff "new booking" alerts.
--    It could read/write outbox rows but not take the next id.
grant usage, select on sequence public.outbox_id_seq to service_role;

-- 2. Checkout: remember when/how an appointment was paid — card via Stripe
--    (pos-confirm.js) or cash/other rung up in the portal (pos-cash.js).
alter table public.appointment
  add column if not exists paid_at timestamptz,
  add column if not exists paid_cents integer,
  add column if not exists paid_tip_cents integer,
  add column if not exists paid_method text,   -- 'card' | 'cash' | 'other'
  add column if not exists paid_ref text;      -- Stripe checkout session id, or cash_<saleId>

-- 3. Appointment emails said "$0" for a service with no price and dropped
--    the cents ($45 for $45.50).
create or replace function public.sv_appointment_vars_base(p_appt uuid)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select jsonb_build_object(
    'salon',        s.name,
    'client',       coalesce(c.name, 'there'),
    'client_email', c.email,
    'client_phone', c.phone,
    'client_note',  coalesce(nullif(a.client_note,''), ''),
    'stylist',      st.name,
    'stylist_email', null,
    'stylist_note', coalesce(nullif(a.stylist_note,''), ''),
    'services',     coalesce((select string_agg(sv.name, ' + ' order by aps.sequence)
                              from appointment_service aps join service sv on sv.id = aps.service_id
                              where aps.appointment_id = a.id), 'your appointment'),
    'day',          to_char(a.starts_at at time zone s.timezone, 'FMDay FMDD FMMonth'),
    'time',         lower(to_char(a.starts_at at time zone s.timezone, 'FMHH12:MIam')),
    'duration',     (extract(epoch from (a.ends_at - a.starts_at))/60)::int || ' minutes',
    'price',        case when coalesce(a.price_cents,0) <= 0 then 'price at the salon'
                         when a.price_cents % 100 = 0 then '$' || (a.price_cents/100)
                         else '$' || to_char(a.price_cents/100.0, 'FM999999990.00') end,
    'expiry_hours', st.request_expiry_hours::text,
    'salon_id',     s.id,
    'appt_id',      a.id
  )
  from appointment a
  join salon s   on s.id   = a.salon_id
  join stylist st on st.id  = a.stylist_id
  left join client c on c.id  = a.client_id
  where a.id  = p_appt;
$function$;

-- 4. (also applied earlier today) sv_book now updates a matched client's
--    email/phone/name to what they typed on the booking form.
