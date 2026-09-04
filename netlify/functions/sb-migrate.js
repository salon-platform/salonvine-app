/* One-time bridge: bring a salon fully onto Supabase so its page can take
   real bookings. Founder-only (SV_TOKEN header). Safe to run twice — every
   step is "make sure this exists", never "add another".

   GET /api/sb-migrate?slug=cali-cuts            one salon
   GET /api/sb-migrate?slug=all                  every salon in Supabase
   Header: x-sv-token: <SV_TOKEN>

   For each salon:
   1. Service menu — from the old Apps Script record (name + price) into the
      `service` table, matched by name so nothing is duplicated.
   2. Stylists — every active member of the salon's portal team becomes a
      `stylist` row (instant booking, visible on the site). A salon with no
      team at all gets one stylist under the owner's name, so the Book button
      still works on day one. The owner can rename or add people in the portal.
   3. Working hours — a stylist with no hours yet gets the salon's opening
      hours, day for day.
   4. Every stylist offers every service, at the menu price, 30 minutes unless
      the service says otherwise. Stylists adjust their own durations later. */

import { cors, json, normSlug, getDataStore, listJSON, usersPrefix } from './_lib.js';
import { sbReady, sbSelect, sbWrite, sbRpc } from './_supabase.js';
import { getFounder } from './_admin.js';

function priceCents(p) {
  const n = parseFloat(String(p == null ? '' : p).replace(/[^0-9.]/g, ''));
  return isFinite(n) ? Math.round(n * 100) : null;
}
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'stylist';
}

async function appsScriptSite(slug) {
  const exec = process.env.SV_EXEC;
  if (!exec) return null;
  try {
    const res = await fetch(`${exec}?site=${encodeURIComponent(slug)}`, { redirect: 'follow' });
    const j = await res.json().catch(() => null);
    return (j && j.ok && !j.error) ? j : null;
  } catch (e) { return null; }
}

async function migrateSalon(salon, log) {
  const out = { slug: salon.slug, services: 0, stylists: 0, hours: 0, offers: 0, notes: [] };

  /* 1) services */
  const old = await appsScriptSite(salon.slug);
  const menu = (old && Array.isArray(old.services) ? old.services : []).filter(s => s && String(s.name || '').trim());
  const existing = await sbSelect('service', `salon_id=eq.${salon.id}&select=id,name,price_cents,duration_minutes`);
  const byName = new Map(existing.map(s => [String(s.name).toLowerCase(), s]));
  for (const s of menu) {
    const name = String(s.name).trim().slice(0, 80);
    if (byName.has(name.toLowerCase())) continue;
    const row = { salon_id: salon.id, name };
    const cents = priceCents(s.price);
    if (cents !== null) row.price_cents = cents;
    const ins = await sbWrite('service', 'insert', '', row);
    if (ins[0]) { byName.set(name.toLowerCase(), ins[0]); out.services++; }
  }
  if (!old) out.notes.push('old Apps Script record not reachable — services not imported');
  if (!menu.length && !existing.length) out.notes.push('no services anywhere — owner must add a menu before the site can take bookings');

  /* 2) stylists from the portal team */
  const store = getDataStore();
  const users = (await listJSON(store, usersPrefix(salon.slug))).filter(u => u && u.name && u.active !== false);
  const have = await sbSelect('stylist', `salon_id=eq.${salon.id}&select=id,name,is_active`);
  const haveByName = new Map(have.map(s => [String(s.name).toLowerCase(), s]));
  const wanted = users.length ? users.map(u => ({ name: String(u.name).trim().slice(0, 80), role: u.role === 'admin' ? 'Owner' : 'Stylist' }))
                              : [{ name: String(salon.owner_name || salon.name || 'Stylist').trim().slice(0, 80), role: 'Owner' }];
  if (!users.length) out.notes.push('no portal team — created one stylist under the owner name');
  for (const wnt of wanted) {
    if (haveByName.has(wnt.name.toLowerCase())) continue;
    const ins = await sbWrite('stylist', 'insert', '', {
      salon_id: salon.id, name: wnt.name, slug: slugify(wnt.name), role: wnt.role,
      is_active: true, is_public: true, booking_mode: 'instant'
    });
    if (ins[0]) { haveByName.set(wnt.name.toLowerCase(), ins[0]); out.stylists++; }
  }

  /* 3) hours + 4) offers, for every active stylist */
  const stylists = await sbSelect('stylist', `salon_id=eq.${salon.id}&is_active=eq.true&select=id,name`);
  const salonHours = await sbSelect('salon_hours', `salon_id=eq.${salon.id}&select=weekday,opens_at,closes_at,is_closed`);
  const services = await sbSelect('service', `salon_id=eq.${salon.id}&select=id,price_cents,duration_minutes`);
  for (const st of stylists) {
    const wh = await sbSelect('working_hours', `stylist_id=eq.${st.id}&select=id`);
    if (!wh.length) {
      for (const h of salonHours.filter(h => !h.is_closed && h.opens_at && h.closes_at)) {
        await sbWrite('working_hours', 'insert', '', { stylist_id: st.id, weekday: h.weekday, starts_at: h.opens_at, ends_at: h.closes_at });
        out.hours++;
      }
    }
    const offers = await sbSelect('stylist_service', `stylist_id=eq.${st.id}&select=service_id`);
    const has = new Set(offers.map(o => o.service_id));
    for (const sv of services) {
      if (has.has(sv.id)) continue;
      try {
        await sbRpc('sv_set_duration', { p_stylist_id: st.id, p_service_id: sv.id, p_minutes: sv.duration_minutes || 30, p_price_cents: sv.price_cents });
        out.offers++;
      } catch (e) { out.notes.push(`offer ${st.name}/${sv.id}: ${e.message.slice(0, 80)}`); }
    }
  }
  /* totals, so a second run still shows what the salon has */
  const allOffers = await sbSelect('stylist_service', `stylist_id=in.(${stylists.map(s => s.id).join(',') || '00000000-0000-0000-0000-000000000000'})&select=service_id`);
  const allHours  = await sbSelect('working_hours', `stylist_id=in.(${stylists.map(s => s.id).join(',') || '00000000-0000-0000-0000-000000000000'})&select=id`);
  out.now = { services: services.length, stylists: stylists.length, hours: allHours.length, offers: allOffers.length,
              stylist_names: stylists.map(s => s.name) };
  log.push(out);
}

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' }, c.headers);
  /* A signed-in founder (the /admin console cookie) or the founder token. */
  const token = req.headers.get('x-sv-token') || new URL(req.url).searchParams.get('token');
  const founder = getFounder(req);
  if (!founder && !(process.env.SV_TOKEN && token === process.env.SV_TOKEN)) return json(403, { error: 'Founder login required.' }, c.headers);
  if (!sbReady()) return json(500, { error: 'SUPABASE_SECRET_KEY not set' }, c.headers);

  const want = String(new URL(req.url).searchParams.get('slug') || '').toLowerCase();
  const salons = await sbSelect('salon', 'select=id,slug,name,owner_name&deleted_at=is.null&order=slug');
  const bare = want.replace(/[^a-z0-9]/g, '');
  const targets = want === 'all' ? salons : salons.filter(s => String(s.slug).replace(/[^a-z0-9]/g, '') === bare);
  if (!targets.length) return json(404, { error: 'No such salon in Supabase.', known: salons.map(s => s.slug) }, c.headers);

  const log = [];
  for (const s of targets) {
    try { await migrateSalon(s, log); }
    catch (e) { log.push({ slug: s.slug, error: e.message.slice(0, 200) }); }
  }
  return json(200, { ok: true, results: log }, c.headers);
};
