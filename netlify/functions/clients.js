/* Client list for the owner portal (Clients screen). Owner/admin only, scoped
   to the session's own salon. Read-only — reads the Supabase `client` table,
   which is populated by bookings and by the data importer. */

import { cors, json, requireSalonSession } from './_lib.js';
import { sbReady, sbSalon, sbSelect } from './_supabase.js';

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' }, c.headers);

  const auth = requireSalonSession(req, new URL(req.url).searchParams.get('slug'), c.headers);
  if (auth.errorResponse) return auth.errorResponse;
  const { session, slug } = auth;
  if (session.role !== 'admin') return json(403, { error: 'Owner access only.' }, c.headers);

  if (!sbReady()) return json(200, { ok: true, clients: [] }, c.headers);

  try {
    const salon = await sbSalon(slug);
    if (!salon) return json(404, { error: 'Salon not found.' }, c.headers);

    const rows = await sbSelect('client',
      `salon_id=eq.${salon.id}&select=id,name,email,phone&limit=5000`);

    const clients = rows
      .map(r => ({ id: r.id, name: r.name || '', email: r.email || '', phone: r.phone || '' }))
      .sort((a, b) => {
        const an = String(a.name || a.email).toLowerCase();
        const bn = String(b.name || b.email).toLowerCase();
        return an < bn ? -1 : an > bn ? 1 : 0;
      });

    return json(200, { ok: true, clients }, c.headers);
  } catch (e) {
    return json(500, { error: 'Could not load clients.' }, c.headers);
  }
};
