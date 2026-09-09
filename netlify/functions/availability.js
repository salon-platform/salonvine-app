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

import { cors, json, parseBody, normEmail, requireSalonSession } from './_lib.js';
import { sbReady, sbSalon, sbSelect, sbWrite } from './_supabase.js';

const s = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 200);
const squash = v => s(v).toLowerCase().replace(/[^a-z0-9]/g, '');
const SEL = 'id,name,email,phone,role,specialty,bio,instagram,photo_url,booking_mode,is_public,is_active';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zdlytaswwvemnlgnonnd.supabase.co';
const KEY = process.env.SUPABASE_SECRET_KEY || '';

function shape(x, offers) {
  return {
    id: x.id, name: x.name, role: x.role || '', specialty: x.specialty || '', bio: x.bio || '',
    instagram: x.instagram || '', photoUrl: x.photo_url || '', bookingMode: x.booking_mode || 'instant',
    accepting: x.is_public !== false && x.is_active !== false,
    offers: (offers || []).filter(o => o.stylist_id === x.id).map(o => ({ serviceId: o.service_id, priceCents: o.price_cents, minutes: o.duration_minutes }))
  };
}
async function loadAll(salon) {
  const [rows, offers, services] = await Promise.all([
    sbSelect('stylist', `salon_id=eq.${salon.id}&select=${SEL}&order=sort_order,name`),
    sbSelect('stylist_service', `select=stylist_id,service_id,price_cents,duration_minutes,stylist!inner(salon_id)&stylist.salon_id=eq.${salon.id}&limit=5000`).catch(() => []),
    sbSelect('service', `salon_id=eq.${salon.id}&is_active=eq.true&select=id,name,category,price_cents,duration_minutes&order=category,sort_order,name&limit=1000`)
  ]);
  return { rows, offers, services: services.map(x => ({ id: x.id, name: x.name, category: x.category || '', priceCents: x.price_cents || 0, minutes: x.duration_minutes || 30 })) };
}
/* which stylist row is the signed-in person? email first, then name */
function mineOf(session, rows) {
  const em = normEmail(session.email);
  return rows.find(x => em && normEmail(x.email) === em)
      || rows.find(x => squash(x.name) === squash(session.name))
      || null;
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
  return (w && w[0]) || null;
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
    let mine = mineOf(session, all.rows);

    /* an invited staff login becomes a team member automatically (hidden
       until she turns bookings on) — no extra step for her or the owner */
    if (!mine && !admin && req.method === 'GET') {
      try {
        const made = await ensureStylistRow(salon, { name: session.name, email: session.email });
        if (made) { all = await loadAll(salon); mine = mineOf(session, all.rows) || made; }
      } catch (e) { console.error('availability: auto-join failed', e.message); }
    }
    const payload = () => ({ ok: true, mine: mine ? shape(mine, all.offers) : null, team: admin ? all.rows.map(x => shape(x, all.offers)) : [], services: all.services });

    if (req.method === 'GET') return json(200, payload(), c.headers);
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

    /* a login with no team row yet: put her on the team (hidden) so she has a switch */
    if (body.action === 'join') {
      if (!mine) {
        const made = await ensureStylistRow(salon, { name: session.name, email: session.email });
        if (!made) return json(400, { error: 'Could not add you — your login has no name on it.' }, c.headers);
        all = await loadAll(salon); mine = mineOf(session, all.rows) || made;
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
      all = await loadAll(salon); mine = mineOf(session, all.rows);
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
      const res = await fetch(`${SUPABASE_URL}/storage/v1/object/salon-photos/${path}`, {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + KEY, 'apikey': KEY, 'Content-Type': mime, 'x-upsert': 'true' },
        body: Buffer.from(m[3], 'base64')
      });
      if (!res.ok) return json(502, { error: 'Upload failed: ' + (await res.text()).slice(0, 140) }, c.headers);
      const url = `${SUPABASE_URL}/storage/v1/object/public/salon-photos/${path}`;
      await sbWrite('stylist', 'update', `id=eq.${target.id}&salon_id=eq.${salon.id}`, { photo_url: url });
      all = await loadAll(salon); mine = mineOf(session, all.rows);
      return json(200, { ...payload(), url }, c.headers);
    }

    /* ---- the switch ---- */
    const on = body.accepting === true || body.accepting === 'true';
    await sbWrite('stylist', 'update', `id=eq.${target.id}&salon_id=eq.${salon.id}`, { is_public: on, is_active: on });
    all = await loadAll(salon); mine = mineOf(session, all.rows);
    return json(200, payload(), c.headers);
  } catch (e) {
    return json(500, { error: `Availability hit a snag: ${String((e && e.message) || e).slice(0, 160)}` }, c.headers);
  }
};
