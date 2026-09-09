/* "Am I taking new bookings?" — the switch each team member controls herself.

   GET  ?slug=                       -> { mine, team }   (team only for the owner)
   POST { slug, stylistId, accepting } -> flips it. A stylist may only flip her
                                        own; the owner may flip anyone's.

   OFF means: she disappears from the salon's booking site (no team card, not
   in "first available", no times offered) and the booking engine refuses new
   bookings for her. Everything already on her calendar stays put. ON puts
   her back exactly as she was. Under the hood that is stylist.is_public and
   stylist.is_active together. */

import { cors, json, parseBody, normEmail, requireSalonSession } from './_lib.js';
import { sbReady, sbSalon, sbSelect, sbWrite } from './_supabase.js';

const s = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 200);
const squash = v => s(v).toLowerCase().replace(/[^a-z0-9]/g, '');

function shape(x) {
  return { id: x.id, name: x.name, role: x.role || '', accepting: x.is_public !== false && x.is_active !== false };
}
/* which stylist row is the signed-in person? email first, then name */
function mineOf(session, rows) {
  const em = normEmail(session.email);
  return rows.find(x => em && normEmail(x.email) === em)
      || rows.find(x => squash(x.name) === squash(session.name))
      || null;
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
    const rows = await sbSelect('stylist', `salon_id=eq.${salon.id}&select=id,name,email,role,is_public,is_active&order=sort_order,name`);
    const mine = mineOf(session, rows);

    if (req.method === 'GET') {
      return json(200, { ok: true, mine: mine ? shape(mine) : null, team: admin ? rows.map(shape) : [] }, c.headers);
    }
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

    const id = s(body.stylistId, 60);
    const target = rows.find(x => x.id === id);
    if (!target) return json(404, { error: 'That team member is not in this salon.' }, c.headers);
    if (!admin && !(mine && mine.id === target.id)) return json(403, { error: 'You can only change your own availability.' }, c.headers);

    const on = body.accepting === true || body.accepting === 'true';
    await sbWrite('stylist', 'update', `id=eq.${target.id}&salon_id=eq.${salon.id}`, { is_public: on, is_active: on });
    const fresh = await sbSelect('stylist', `salon_id=eq.${salon.id}&select=id,name,email,role,is_public,is_active&order=sort_order,name`);
    const m2 = mineOf(session, fresh);
    return json(200, { ok: true, mine: m2 ? shape(m2) : null, team: admin ? fresh.map(shape) : [] }, c.headers);
  } catch (e) {
    return json(500, { error: `Availability hit a snag: ${String((e && e.message) || e).slice(0, 160)}` }, c.headers);
  }
};
