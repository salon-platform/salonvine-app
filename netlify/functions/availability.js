/* "My profile" — each team member's own card on the booking site, and the
   "am I taking new bookings?" switch. A stylist edits her own; the owner
   can edit anyone's.

   GET  ?slug=                          -> { mine, team, services }  (team only for the owner)
   POST { slug, stylistId, accepting }  -> flips the switch
   POST { slug, action:'profile', stylistId, role, specialty, bio, instagram,
          bookingMode, offers:[{serviceId, priceCents, minutes}] } -> saves the card
   POST { slug, action:'photo', stylistId, data:'data:image/...' } -> uploads a photo

   OFF means: she disappears from the salon's booking site (no team card, not
   in "first available", no times offered) and the booking engine refuses new
   bookings for her. Everything already on her calendar stays put. ON puts
   her back exactly as she was. Under the hood that is stylist.is_public and
   stylist.is_active together. */

import { cors, json, parseBody, normEmail, requireSalonSession, getDataStore, userKey } from './_lib.js';
import { sbReady, sbSalon, sbSelect, sbWrite } from './_supabase.js';

const s = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 200);
const squash = v => s(v).toLowerCase().replace(/[^a-z0-9]/g, '');
const SEL = 'id,name,email,phone,role,specialty,bio,instagram,photo_url,booking_mode,is_public,is_active';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zdlytaswwvemnlgnonnd.supabase.co';
const KEY = process.env.SUPABASE_SECRET_KEY || '';

/* "09:00" — pad to HH:MM so string compare == clock compare. Accepts both
   "09:00" (portal/signup) and Postgres time's "09:00:00" (salon_hours reads
   back with seconds), dropping the seconds. Returns '' if it isn't a time. */
function normTime(v) {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(v == null ? '' : v).trim());
  if (!m) return '';
  const hh = Math.min(23, parseInt(m[1], 10));
  return String(hh).padStart(2, '0') + ':' + m[2];
}
/* The salon's default opening hours become a new stylist's starting hours,
   day for day (closed days simply get no row). This is the template both the
   seed-on-create path and the "use salon hours" button build from. */
function defaultHoursRows(stylistId, salonHours) {
  return (salonHours || [])
    .filter(h => !h.is_closed && h.opens_at && h.closes_at)
    .map(h => ({ stylist_id: stylistId, weekday: Number(h.weekday), starts_at: normTime(h.opens_at), ends_at: normTime(h.closes_at) }))
    .filter(r => Number.isInteger(r.weekday) && r.weekday >= 0 && r.weekday <= 6 && r.starts_at && r.ends_at && r.starts_at < r.ends_at);
}

function shape(x, offers, hoursByStylist) {
  return {
    id: x.id, name: x.name, role: x.role || '', specialty: x.specialty || '', bio: x.bio || '',
    instagram: x.instagram || '', photoUrl: x.photo_url || '', bookingMode: x.booking_mode || 'instant',
    accepting: x.is_public !== false && x.is_active !== false,
    offers: (offers || []).filter(o => o.stylist_id === x.id).map(o => ({ serviceId: o.service_id, priceCents: o.price_cents, minutes: o.duration_minutes })),
    /* the days this person actually works — what the public booking page turns
       into openings. Empty here (with the switch on) means "no openings ever",
       which is the bug we now heal. */
    hours: ((hoursByStylist && hoursByStylist[x.id]) || [])
      .map(h => ({ weekday: Number(h.weekday), opens: normTime(h.starts_at), closes: normTime(h.ends_at) }))
      .sort((a, b) => a.weekday - b.weekday)
  };
}
async function loadAll(salon) {
  const [rows, offers, services, salonHours] = await Promise.all([
    sbSelect('stylist', `salon_id=eq.${salon.id}&select=${SEL}&order=sort_order,name`),
    sbSelect('stylist_service', `select=stylist_id,service_id,price_cents,duration_minutes,stylist!inner(salon_id)&stylist.salon_id=eq.${salon.id}&limit=5000`).catch(() => []),
    sbSelect('service', `salon_id=eq.${salon.id}&is_active=eq.true&select=id,name,category,price_cents,duration_minutes&order=category,sort_order,name&limit=1000`),
    sbSelect('salon_hours', `salon_id=eq.${salon.id}&select=weekday,opens_at,closes_at,is_closed&order=weekday`).catch(() => [])
  ]);
  const ids = rows.map(r => r.id);
  const wh = ids.length
    ? await sbSelect('working_hours', `stylist_id=in.(${ids.join(',')})&select=stylist_id,weekday,starts_at,ends_at&limit=5000`).catch(() => [])
    : [];
  const hoursByStylist = {};
  wh.forEach(h => { (hoursByStylist[h.stylist_id] = hoursByStylist[h.stylist_id] || []).push(h); });
  return {
    rows, offers, hoursByStylist, salonHours,
    services: services.map(x => ({ id: x.id, name: x.name, category: x.category || '', priceCents: x.price_cents || 0, minutes: x.duration_minutes || 30 }))
  };
}
/* Give a stylist the salon's default hours, but only if they have none yet —
   idempotent, so it's safe to call on every create / turn-on. Returns true if
   it actually added rows. Exported because the calendar, invites and imports
   all create stylist rows and want them bookable from day one. */
export async function seedStylistHoursIfEmpty(salon, stylistId) {
  try {
    const existing = await sbSelect('working_hours', `stylist_id=eq.${stylistId}&select=stylist_id&limit=1`);
    if (existing.length) return false;
    const salonHours = await sbSelect('salon_hours', `salon_id=eq.${salon.id}&select=weekday,opens_at,closes_at,is_closed`).catch(() => []);
    const rows = defaultHoursRows(stylistId, salonHours);
    if (rows.length) await sbWrite('working_hours', 'insert', null, rows);
    return rows.length > 0;
  } catch (e) { return false; }
}
/* which stylist row is the signed-in person? email first, then name.
   Only a fallback — the real link is the stylistId saved on her login
   (see myStylistRow), so renaming her never loses her bookings. */
function mineOf(session, rows) {
  const em = normEmail(session.email);
  return rows.find(x => em && normEmail(x.email) === em)
      || rows.find(x => squash(x.name) === squash(session.name))
      || null;
}

/* Save which team row a portal login belongs to. */
export async function rememberStylist(slug, email, stylistId) {
  if (!stylistId) return;
  try {
    const store = getDataStore();
    const key = userKey(slug, normEmail(email));
    const u = await store.get(key, { type: 'json' });
    if (u && u.stylistId !== stylistId) await store.setJSON(key, { ...u, stylistId });
  } catch (e) { console.error('rememberStylist', e.message); }
}

/* The signed-in person's team row, by ID. The login record carries
   stylistId; logins from before that existed (or a row that has since gone)
   fall back to email, then name, and the id is saved for next time. */
export async function myStylistRow(slug, session, rows) {
  let u = null;
  try { u = await getDataStore().get(userKey(slug, normEmail(session.email)), { type: 'json' }); } catch (e) { /* fall through */ }
  if (u && u.stylistId) {
    const hit = rows.find(x => x.id === u.stylistId);
    if (hit) return hit;
  }
  const hit = mineOf(session, rows);
  if (hit) await rememberStylist(slug, session.email, hit.id);
  return hit;
}

/* Make sure a portal login has a matching row on the booking site's team
   (hidden and not bookable until she turns herself on). Used here and by
   the owner's "Add a stylist" flow. Returns the row, or null if none could be made. */
export async function ensureStylistRow(salon, { name, email, phone }) {
  const rows = await sbSelect('stylist', `salon_id=eq.${salon.id}&select=id,name,email,slug,role,is_public,is_active`);
  const hit = mineOf({ name, email }, rows);
  if (hit) return hit;
  const clean = s(name, 80);
  if (!clean) return null;
  const base = clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'staff';
  const taken = new Set(rows.map(x => x.slug));
  let slug = base, n = 1;
  while (taken.has(slug)) slug = `${base}-${++n}`;
  const w = await sbWrite('stylist', 'insert', null, [{
    salon_id: salon.id, name: clean, slug, email: normEmail(email) || '', phone: s(phone, 40),
    role: 'Stylist', is_public: false, is_active: false, booking_mode: 'request'
  }]);
  const made = (w && w[0]) || null;
  /* Give them the salon's hours straight away, so the day they flip their
     switch on they have real openings — no silent "wide open in the portal,
     nothing on the site" gap. Best-effort: never fail a create over hours. */
  if (made && made.id) { try { await seedStylistHoursIfEmpty(salon, made.id); } catch (e) { /* non-fatal */ } }
  if (made && made.id && email) await rememberStylist(salon.slug, email, made.id);
  return made;
}

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (!sbReady()) return json(503, { error: 'Not switched on yet.' }, c.headers);

  const qs = new URL(req.url).searchParams;
  const body = req.method === 'POST' ? await parseBody(req) : null;
  if (req.method === 'POST' && !body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const auth = requireSalonSession(req, body ? body.slug : qs.get('slug'), c.headers);
  if (auth.errorResponse) return auth.errorResponse;
  const { session, slug } = auth;
  const admin = session.role === 'admin';

  try {
    const salon = await sbSalon(slug);
    if (!salon) return json(404, { error: 'Salon not found.' }, c.headers);
    let all = await loadAll(salon);
    let mine = await myStylistRow(slug, session, all.rows);

    /* an invited staff login becomes a team member automatically (hidden
       until she turns bookings on) — no extra step for her or the owner */
    if (!mine && !admin && req.method === 'GET') {
      try {
        const made = await ensureStylistRow(salon, { name: session.name, email: session.email });
        if (made) { await rememberStylist(slug, session.email, made.id); all = await loadAll(salon); mine = all.rows.find(x => x.id === made.id) || made; }
      } catch (e) { console.error('availability: auto-join failed', e.message); }
    }
    const payload = () => ({
      ok: true,
      mine: mine ? shape(mine, all.offers, all.hoursByStylist) : null,
      team: admin ? all.rows.map(x => shape(x, all.offers, all.hoursByStylist)) : [],
      services: all.services,
      /* the salon's own opening hours — the starting point the Hours editor
         offers as "use salon hours", and the outer bound the public page shows. */
      salonHours: (all.salonHours || []).map(h => ({ weekday: Number(h.weekday), closed: !!h.is_closed || !h.opens_at || !h.closes_at, opens: normTime(h.opens_at), closes: normTime(h.closes_at) })).sort((a, b) => a.weekday - b.weekday)
    });

    /* Self-heal: any stylist whose switch is ON but who has no working hours is
       unbookable on the public site while looking wide-open in the portal — the
       exact trap a stylist added before hours existed falls into. When the owner
       opens the team, quietly give those people the salon's default hours. Only
       "accepting + zero hours" is touched (a deliberately closed day is a missing
       row, not zero rows), and it's idempotent, so it runs at most once each. */
    if (req.method === 'GET' && admin) {
      const stuck = all.rows.filter(x => (x.is_public !== false && x.is_active !== false) && !(all.hoursByStylist[x.id] && all.hoursByStylist[x.id].length));
      if (stuck.length) {
        let seededAny = false;
        for (const x of stuck) { if (await seedStylistHoursIfEmpty(salon, x.id)) seededAny = true; }
        if (seededAny) { all = await loadAll(salon); mine = mine ? (all.rows.find(x => x.id === mine.id) || null) : null; }
      }
    }
    if (req.method === 'GET') return json(200, payload(), c.headers);
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

    /* a login with no team row yet: put her on the team (hidden) so she has a switch */
    if (body.action === 'join') {
      if (!mine) {
        const made = await ensureStylistRow(salon, { name: session.name, email: session.email });
        if (!made) return json(400, { error: 'Could not add you — your login has no name on it.' }, c.headers);
        await rememberStylist(slug, session.email, made.id); all = await loadAll(salon); mine = all.rows.find(x => x.id === made.id) || made;
      }
      return json(200, payload(), c.headers);
    }

    const id = s(body.stylistId, 60);
    const target = all.rows.find(x => x.id === id);
    if (!target) return json(404, { error: 'That team member is not in this salon.' }, c.headers);
    if (!admin && !(mine && mine.id === target.id)) return json(403, { error: 'You can only change your own profile.' }, c.headers);

    /* ---- the card ---- */
    if (body.action === 'profile') {
      const patch = {
        role: s(body.role, 60), specialty: s(body.specialty, 120), bio: s(body.bio, 1200),
        instagram: s(body.instagram, 60).replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/\/$/, ''),
        booking_mode: body.bookingMode === 'request' ? 'request' : 'instant'
      };
      if (admin && s(body.name, 80)) patch.name = s(body.name, 80);
      await sbWrite('stylist', 'update', `id=eq.${target.id}&salon_id=eq.${salon.id}`, patch);
      if (Array.isArray(body.offers)) {
        const ok = new Set(all.services.map(x => x.id));
        const rows = body.offers.filter(o => o && ok.has(s(o.serviceId, 60))).slice(0, 200).map(o => {
          const svc = all.services.find(x => x.id === s(o.serviceId, 60));
          const pc = parseInt(o.priceCents, 10), mn = parseInt(o.minutes, 10);
          return { stylist_id: target.id, service_id: svc.id,
                   price_cents: Number.isFinite(pc) && pc >= 0 ? pc : svc.priceCents,
                   duration_minutes: Number.isFinite(mn) && mn >= 5 ? Math.min(mn, 720) : svc.minutes };
        });
        await sbWrite('stylist_service', 'delete', `stylist_id=eq.${target.id}`);
        if (rows.length) await sbWrite('stylist_service', 'insert', null, rows);
      }
      all = await loadAll(salon); mine = mine ? (all.rows.find(x => x.id === mine.id) || null) : null;
      return json(200, payload(), c.headers);
    }

    /* ---- the days & times this person works ---- */
    if (body.action === 'hours') {
      const days = Array.isArray(body.hours) ? body.hours : [];
      const seen = new Set();
      const rows = [];
      for (const d of days) {
        const wd = Number(d && d.weekday);
        if (!Number.isInteger(wd) || wd < 0 || wd > 6 || seen.has(wd)) continue;
        if (d.closed) { seen.add(wd); continue; }   /* closed = no row for that day */
        const opens = normTime(d.opens), closes = normTime(d.closes);
        if (!opens || !closes || opens >= closes) continue;
        seen.add(wd);
        rows.push({ stylist_id: target.id, weekday: wd, starts_at: opens, ends_at: closes });
      }
      /* replace the whole week in one shot — the client always sends all 7 days */
      await sbWrite('working_hours', 'delete', `stylist_id=eq.${target.id}`);
      if (rows.length) await sbWrite('working_hours', 'insert', null, rows);
      all = await loadAll(salon); mine = mine ? (all.rows.find(x => x.id === mine.id) || null) : null;
      return json(200, payload(), c.headers);
    }

    /* ---- copy the salon's opening hours onto this person ---- */
    if (body.action === 'hours-default') {
      const rows = defaultHoursRows(target.id, all.salonHours);
      await sbWrite('working_hours', 'delete', `stylist_id=eq.${target.id}`);
      if (rows.length) await sbWrite('working_hours', 'insert', null, rows);
      all = await loadAll(salon); mine = mine ? (all.rows.find(x => x.id === mine.id) || null) : null;
      return json(200, payload(), c.headers);
    }

    /* ---- a service that isn't on the menu yet ---- */
    if (body.action === 'service-add') {
      const name = s(body.name, 120);
      if (!name) return json(400, { error: 'Give the service a name.' }, c.headers);
      const pc = parseInt(body.priceCents, 10), mn = parseInt(body.minutes, 10);
      const cat = s(body.category, 60) || 'Other';
      let svc = all.services.find(x => squash(x.name) === squash(name));
      if (!svc) {
        const w = await sbWrite('service', 'insert', null, [{
          salon_id: salon.id, name, category: cat,
          price_cents: Number.isFinite(pc) && pc >= 0 ? pc : 0,
          duration_minutes: Number.isFinite(mn) && mn >= 5 ? Math.min(mn, 720) : 60,
          is_active: true, sort_order: 999
        }]);
        const made = w && w[0];
        if (!made) return json(500, { error: 'Could not add that service.' }, c.headers);
        svc = { id: made.id, priceCents: made.price_cents || 0, minutes: made.duration_minutes || 60 };
      }
      /* keep whatever she had ticked, plus this one */
      const keep = (Array.isArray(body.offers) ? body.offers : []).filter(o => o && s(o.serviceId, 60) !== svc.id);
      const rows = keep.map(o => {
        const base = all.services.find(x => x.id === s(o.serviceId, 60)); if (!base) return null;
        const p2 = parseInt(o.priceCents, 10), m2 = parseInt(o.minutes, 10);
        return { stylist_id: target.id, service_id: base.id, price_cents: Number.isFinite(p2) && p2 >= 0 ? p2 : base.priceCents, duration_minutes: Number.isFinite(m2) && m2 >= 5 ? Math.min(m2, 720) : base.minutes };
      }).filter(Boolean);
      rows.push({ stylist_id: target.id, service_id: svc.id, price_cents: Number.isFinite(pc) && pc >= 0 ? pc : svc.priceCents, duration_minutes: Number.isFinite(mn) && mn >= 5 ? Math.min(mn, 720) : svc.minutes });
      await sbWrite('stylist_service', 'delete', `stylist_id=eq.${target.id}`);
      await sbWrite('stylist_service', 'insert', null, rows);
      all = await loadAll(salon); mine = mine ? (all.rows.find(x => x.id === mine.id) || null) : null;
      return json(200, payload(), c.headers);
    }

    /* ---- the photo ---- */
    if (body.action === 'photo') {
      if (!KEY) return json(500, { error: 'Uploads are not configured yet.' }, c.headers);
      const data = String(body.data || '');
      const m = /^data:(image\/(png|jpe?g|webp));base64,(.+)$/i.exec(data);
      if (!m) return json(400, { error: 'Expected a PNG, JPG or WebP image.' }, c.headers);
      if (data.length > 5500000) return json(413, { error: 'That image is too large — try a smaller one.' }, c.headers);
      const mime = m[1], ext = /png/i.test(mime) ? 'png' : /webp/i.test(mime) ? 'webp' : 'jpg';
      const path = `team/${slug}/${target.id.slice(0, 8)}-${Date.now().toString(36)}.${ext}`;
      const put = () => fetch(`${SUPABASE_URL}/storage/v1/object/salon-photos/${path}`, {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + KEY, 'apikey': KEY, 'Content-Type': mime, 'x-upsert': 'true' },
        body: Buffer.from(m[3], 'base64')
      });
      let res = await put();
      if (!res.ok && /NoSuchBucket|Bucket not found/i.test(await res.clone().text())) {
        /* first photo ever: make the public bucket, then try again */
        await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
          method: 'POST', headers: { 'Authorization': 'Bearer ' + KEY, 'apikey': KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: 'salon-photos', name: 'salon-photos', public: true, file_size_limit: 6000000 })
        });
        res = await put();
      }
      if (!res.ok) return json(502, { error: 'Upload failed: ' + (await res.text()).slice(0, 140) }, c.headers);
      const url = `${SUPABASE_URL}/storage/v1/object/public/salon-photos/${path}`;
      await sbWrite('stylist', 'update', `id=eq.${target.id}&salon_id=eq.${salon.id}`, { photo_url: url });
      all = await loadAll(salon); mine = mine ? (all.rows.find(x => x.id === mine.id) || null) : null;
      return json(200, { ...payload(), url }, c.headers);
    }

    /* ---- the switch ---- */
    const on = body.accepting === true || body.accepting === 'true';
    await sbWrite('stylist', 'update', `id=eq.${target.id}&salon_id=eq.${salon.id}`, { is_public: on, is_active: on });
    /* Turning someone on is a promise that clients can book them. If they have
       no hours yet, that promise is empty — give them the salon's hours now so
       "on" always means bookable. Idempotent; a no-op once they have any. */
    if (on) { try { await seedStylistHoursIfEmpty(salon, target.id); } catch (e) { /* non-fatal */ } }
    all = await loadAll(salon); mine = mine ? (all.rows.find(x => x.id === mine.id) || null) : null;
    return json(200, payload(), c.headers);
  } catch (e) {
    return json(500, { error: `Availability hit a snag: ${String((e && e.message) || e).slice(0, 160)}` }, c.headers);
  }
};
