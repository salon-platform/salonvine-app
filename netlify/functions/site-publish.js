/* Publish edits made in the visual "My Website" editor (studio.html).
   Owner/admin only, scoped to the session's own salon. Takes a flat list of
   changes keyed by field id and writes them to Supabase:
     salon:<col>            -> the salon row (tagline, hero_title, about, phone, address, theme, accent)
     service:<uuid>:<field> -> a service row (name, price)          [salon-scoped]
     stylist:<uuid>:<field> -> a stylist row (name, role, bio, specialty)  [salon-scoped]
   salon_id is resolved from the session, never trusted from the client, and
   every service/stylist write is filtered by salon_id so an owner can only
   ever touch their own rows. Writes are self-healing: a column the table
   doesn't have is dropped and the write retried, so one odd field can't fail
   the whole publish. */

import { cors, json, parseBody, requireSalonSession } from './_lib.js';
import { sbReady, sbSalon, sbWrite, isUuid } from './_supabase.js';

/* map an editor field name -> the salon column it writes */
const SALON_COLS = {
  tagline: 'tagline', heroTitle: 'hero_title', about: 'about',
  phone: 'phone', address: 'address', theme: 'theme', accent: 'accent',
  headline: 'hero_title'
};
const SERVICE_FIELDS = { name: 'name', price: 'price_cents' };
const STYLIST_FIELDS = { name: 'name', role: 'role', bio: 'bio', specialty: 'specialty' };

function centsFrom(v) {
  const n = Number(String(v == null ? '' : v).replace(/[$,\s]/g, ''));
  return (!Number.isFinite(n) || n < 0) ? 0 : Math.round(n * 100);
}
async function patchResilient(table, filter, patch) {
  let body = Object.assign({}, patch);
  for (let i = 0; i < 10; i++) {
    try { return await sbWrite(table, 'update', filter, body); }
    catch (e) {
      const m = String((e && e.message) || '');
      const mm = m.match(/Could not find the '([^']+)' column|column "([^"]+)"|'([^']+)' column/i);
      const col = mm && (mm[1] || mm[2] || mm[3]);
      if (col && Object.prototype.hasOwnProperty.call(body, col) && Object.keys(body).length > 1) { delete body[col]; continue; }
      if (col && Object.keys(body).length === 1) return null; // the only field is unknown — skip
      throw e;
    }
  }
  return null;
}

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = await parseBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const auth = requireSalonSession(req, body.slug, c.headers);
  if (auth.errorResponse) return auth.errorResponse;
  const { session, slug } = auth;
  if (session.role !== 'admin') {
    return json(403, { error: 'Only the salon owner can publish site changes right now.' }, c.headers);
  }
  if (!sbReady()) return json(500, { error: 'Publishing is not configured yet.' }, c.headers);

  const changes = (body.changes && typeof body.changes === 'object') ? body.changes : null;
  if (!changes) return json(400, { error: 'Nothing to publish.' }, c.headers);

  try {
    const salon = await sbSalon(slug);
    if (!salon) return json(404, { error: 'Salon not found.' }, c.headers);

    const salonPatch = {};
    const svc = {};   // id -> {col: value}
    const sty = {};   // id -> {col: value}

    for (const key of Object.keys(changes)) {
      const val = changes[key];
      const parts = String(key).split(':');
      if (parts[0] === 'salon' && SALON_COLS[parts[1]]) {
        salonPatch[SALON_COLS[parts[1]]] = String(val == null ? '' : val).slice(0, 4000);
      } else if (parts[0] === 'service' && isUuid(parts[1]) && SERVICE_FIELDS[parts[2]]) {
        const col = SERVICE_FIELDS[parts[2]];
        (svc[parts[1]] = svc[parts[1]] || {})[col] = col === 'price_cents' ? centsFrom(val) : String(val).slice(0, 140);
      } else if (parts[0] === 'stylist' && isUuid(parts[1]) && STYLIST_FIELDS[parts[2]]) {
        (sty[parts[1]] = sty[parts[1]] || {})[STYLIST_FIELDS[parts[2]]] = String(val == null ? '' : val).slice(0, 600);
      }
    }

    let applied = 0;
    if (Object.keys(salonPatch).length) {
      await patchResilient('salon', `id=eq.${salon.id}`, salonPatch);
      applied += Object.keys(salonPatch).length;
    }
    for (const id of Object.keys(svc)) {
      await patchResilient('service', `id=eq.${id}&salon_id=eq.${salon.id}`, svc[id]);
      applied += Object.keys(svc[id]).length;
    }
    for (const id of Object.keys(sty)) {
      await patchResilient('stylist', `id=eq.${id}&salon_id=eq.${salon.id}`, sty[id]);
      applied += Object.keys(sty[id]).length;
    }

    return json(200, { ok: true, applied }, c.headers);
  } catch (e) {
    return json(500, { error: 'Could not publish your changes. ' + String((e && e.message) || '').slice(0, 120) }, c.headers);
  }
};
