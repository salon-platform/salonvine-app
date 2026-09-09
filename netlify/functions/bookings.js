/* Booking list for signed-in staff. Everyone sees the whole salon book by
   default (?scope=all) so the calendar shows the full day. ?scope=mine
   narrows a stylist to her own bookings plus unclaimed "first available"
   ones — matched by her stylist ID, not her name, so a rename changes nothing.

   Two sources, one list: appointments in Supabase (the new system — real
   calendar, real availability) and the older request notes kept in Netlify
   Blobs. Both are shaped the same so the screens do not care. */

import {
  cors, json,
  getDataStore, listJSON, bookingsPrefix,
  requireSalonSession
} from './_lib.js';
import { sbReady, sbSalon, sbBookings, sbSelect } from './_supabase.js';
import { myStylistRow } from './availability.js';

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

    let salon = null;
    if (sbReady()) {
      try {
        salon = await sbSalon(slug);
        if (salon) bookings = bookings.concat(await sbBookings(salon));
      } catch (e) {
        console.error('bookings: supabase read failed', e.message);
      }
    }

    const scope = String(qs.get('scope') || 'all').toLowerCase();
    if (session.role !== 'admin' && scope !== 'all') {
      let myId = null, myName = String(session.name || '').toLowerCase();
      if (salon) {
        try {
          const rows = await sbSelect('stylist', `salon_id=eq.${salon.id}&select=id,name,email`);
          const me = await myStylistRow(slug, session, rows);
          if (me) { myId = me.id; myName = String(me.name || myName).toLowerCase(); }
        } catch (e) { console.error('bookings: could not match stylist', e.message); }
      }
      bookings = bookings.filter(b => {
        if (b.stylistId) return myId && b.stylistId === myId;      /* Supabase: by ID */
        const sty = String(b.stylist || '').toLowerCase();         /* old notes: by name */
        return sty === myName || sty.indexOf('first available') !== -1 || sty === '';
      });
    }

    bookings.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return json(200, { ok: true, bookings }, c.headers);
  } catch (e) {
    return json(500, { error: 'Could not load bookings. Try again.' }, c.headers);
  }
};
