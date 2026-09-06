/* Client list for the owner portal (Clients screen). Owner/admin only, scoped
   to the session's own salon. Backed by the Supabase `client` table, which is
   populated by bookings and by the data importer.
     GET  ?slug=          -> list this salon's clients
     POST {action:'delete', ids:[...]}  -> remove selected clients (bulk or single)
   Clients that have appointments are protected by the database's own foreign
   key, so a delete that would orphan booking history is refused, not silently
   applied. salon_id is always resolved from the session, never the client. */

import { cors, json, parseBody, requireSalonSession } from './_lib.js';
import { sbReady, sbSalon, sbWrite, isUuid } from './_supabase.js';
import { sbSelectAll } from './_page.js';

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  const isGet = req.method === 'GET';
  if (!isGet && req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = isGet ? null : await parseBody(req);
  if (!isGet && !body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const reqSlug = isGet ? new URL(req.url).searchParams.get('slug') : body.slug;
  const auth = requireSalonSession(req, reqSlug, c.headers);
  if (auth.errorResponse) return auth.errorResponse;
  const { session, slug } = auth;
  if (session.role !== 'admin') return json(403, { error: 'Owner access only.' }, c.headers);

  if (!sbReady()) return json(200, { ok: true, clients: [] }, c.headers);

  try {
    const salon = await sbSalon(slug);
    if (!salon) return json(404, { error: 'Salon not found.' }, c.headers);

    if (isGet) {
      const rows = await sbSelectAll('client',
        `salon_id=eq.${salon.id}&select=id,name,email,phone&order=id`);
      const clients = rows
        .map(r => ({ id: r.id, name: r.name || '', email: r.email || '', phone: r.phone || '' }))
        .sort((a, b) => {
          const an = String(a.name || a.email).toLowerCase();
          const bn = String(b.name || b.email).toLowerCase();
          return an < bn ? -1 : an > bn ? 1 : 0;
        });
      return json(200, { ok: true, clients }, c.headers);
    }

    if (String(body.action || '') === 'delete') {
      const ids = Array.isArray(body.ids) ? body.ids.filter(isUuid) : (isUuid(body.id) ? [body.id] : []);
      if (!ids.length) return json(400, { error: 'Nothing selected.' }, c.headers);
      await sbWrite('client', 'delete', `id=in.(${ids.join(',')})&salon_id=eq.${salon.id}`);
      return json(200, { ok: true, removed: ids.length }, c.headers);
    }

    return json(400, { error: 'Unknown action.' }, c.headers);
  } catch (e) {
    const m = String((e && e.message) || '');
    if (/foreign key|violates/i.test(m)) {
      return json(409, { error: 'Some of those clients have booking history and can’t be removed. Cancel or clear their appointments first.' }, c.headers);
    }
    return json(500, { error: 'Could not update clients. ' + m.slice(0, 120) }, c.headers);
  }
};
