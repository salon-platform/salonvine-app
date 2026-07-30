/* Booking list for signed-in staff. Admin sees everything; a stylist sees her
   own bookings plus unclaimed "first available" ones — unless she asks for the
   read-only ?scope=all team view. All keys are salon-prefixed. */

import {
  cors, json,
  getDataStore, listJSON, bookingsPrefix,
  requireSalonSession
} from './_lib.js';

export default async (req, context) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' }, c.headers);

  const qs = new URL(req.url).searchParams;
  const auth = requireSalonSession(req, qs.get('slug'), c.headers);
  if (auth.errorResponse) return auth.errorResponse;
  const { session, slug } = auth;

  try {
    const store = getDataStore();
    let bookings = await listJSON(store, bookingsPrefix(slug));

    const scope = String(qs.get('scope') || 'mine').toLowerCase();
    if (session.role !== 'admin' && scope !== 'all') {
      const myName = String(session.name || '').toLowerCase();
      bookings = bookings.filter(b => {
        const sty = String(b.stylist || '').toLowerCase();
        return sty === myName || sty.indexOf('first available') !== -1 || sty === '';
      });
    }

    bookings.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return json(200, { ok: true, bookings }, c.headers);
  } catch (e) {
    return json(500, { error: 'Could not load bookings. Try again.' }, c.headers);
  }
};
