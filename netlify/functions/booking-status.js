/* Update a booking's status. Admin can touch any booking (and is the only one
   who may permanently delete); a stylist may only touch bookings assigned to her. */

import {
  cors, json, parseBody, normId,
  getDataStore, bookingKey,
  requireSalonSession, getSalonRegistry, relayMail
} from './_lib.js';
import { sbReady, sbSalon, sbSelect, sbWrite, isUuid } from './_supabase.js';

const STATUSES = ['new', 'confirmed', 'done', 'canceled'];

export default async (req, context) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = await parseBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const auth = requireSalonSession(req, body.slug, c.headers);
  if (auth.errorResponse) return auth.errorResponse;
  const { session, slug } = auth;

  const id = normId(body.id);
  const status = String(body.status || '').toLowerCase();
  if (!id || !status) return json(400, { error: 'Missing fields.' }, c.headers);
  if (status !== 'delete' && STATUSES.indexOf(status) === -1) {
    return json(400, { error: 'Unknown status.' }, c.headers);
  }

  /* Supabase appointments carry a uuid. Changing the status is all it takes:
     the database writes and sends the matching email itself (accepted,
     declined, and so on), so nothing is composed here. */
  if (isUuid(id) && sbReady()) {
    try {
      const salon = await sbSalon(slug);
      if (!salon) return json(404, { error: 'Salon not found.' }, c.headers);
      const rows = await sbSelect('appointment',
        `id=eq.${id}&salon_id=eq.${salon.id}&select=id,status,stylist:stylist_id(name)`);
      const appt = rows[0];
      if (!appt) return json(404, { error: 'Booking not found.' }, c.headers);

      const isOwner = session.role === 'admin';
      const isAssigned = String((appt.stylist && appt.stylist.name) || '').toLowerCase() === String(session.name || '').toLowerCase();
      if (!isOwner && !isAssigned) return json(403, { error: 'Not your booking.' }, c.headers);

      if (status === 'delete') {
        if (!isOwner) return json(403, { error: 'Only the owner can permanently delete a booking.' }, c.headers);
        await sbWrite('appointment', 'delete', `id=eq.${id}&salon_id=eq.${salon.id}`);
        return json(200, { ok: true, deleted: true }, c.headers);
      }

      const next = status === 'confirmed' ? 'confirmed'
                 : status === 'done'      ? 'completed'
                 : status === 'canceled'  ? (appt.status === 'pending' ? 'declined' : 'cancelled')
                 : null;   /* 'new' has no meaning once a slot is really held */
      if (!next) return json(400, { error: 'That status does not apply to a calendar booking.' }, c.headers);
      if (next !== appt.status) {
        await sbWrite('appointment', 'update', `id=eq.${id}&salon_id=eq.${salon.id}`, { status: next });
      }
      return json(200, { ok: true, status: next }, c.headers);
    } catch (e) {
      console.error('booking-status: supabase update failed', e.message);
      return json(500, { error: 'Could not update the booking. Try again.' }, c.headers);
    }
  }

  try {
    const store = getDataStore();
    const booking = await store.get(bookingKey(slug, id), { type: 'json' });
    if (!booking) return json(404, { error: 'Booking not found.' }, c.headers);

    const isOwner = session.role === 'admin';
    const isAssigned = String(booking.stylist || '').toLowerCase() === String(session.name || '').toLowerCase();
    if (!isOwner && !isAssigned) return json(403, { error: 'Not your booking.' }, c.headers);

    if (status === 'delete') {
      if (!isOwner) return json(403, { error: 'Only the owner can permanently delete a booking.' }, c.headers);
      await store.delete(bookingKey(slug, id));
      return json(200, { ok: true, deleted: true }, c.headers);
    }

    const wasConfirmed = booking.status === 'confirmed' || booking.confirmNoticeAt;
    booking.status = status;

    /* Client hears it from the salon, not from silence: first flip to
       'confirmed' sends a text + email. Once only — flipping back and
       forth must not spam the client. */
    if (status === 'confirmed' && !wasConfirmed && (booking.phone || booking.email)) {
      try {
        const reg = await getSalonRegistry(slug);
        const salonName = (reg && reg.name) || 'Your salon';
        const when = String(booking.when || '').trim();
        const line = `${salonName}: your appointment is confirmed${when ? ` — ${when}` : ''}. See you soon!`;
        if (booking.phone) {
          await relayMail({ sms: { phone: booking.phone }, text: line }).catch(() => null);
        }
        if (booking.email) {
          await relayMail({
            to: booking.email,
            subject: `You're booked at ${salonName}`,
            text: `Hi ${String(booking.name || '').split(' ')[0] || 'there'},\n\n`
              + `Your appointment at ${salonName} is confirmed`
              + `${when ? `:\n\n  ${when}` : '.'}`
              + `${booking.service ? `\n  ${booking.service}` : ''}`
              + `${booking.stylist ? `\n  with ${booking.stylist}` : ''}`
              + `\n\nSee you soon!\n${salonName}\n`
              + `\nNeed to change it? Just reply to the salon or rebook: https://salonvine.com/s/${slug}`
          }).catch(() => null);
        }
        booking.confirmNoticeAt = Date.now();
      } catch (e) { /* a notification hiccup must never block the status change */ }
    }

    await store.setJSON(bookingKey(slug, id), booking);
    return json(200, { ok: true }, c.headers);
  } catch (e) {
    return json(500, { error: 'Could not update the booking. Try again.' }, c.headers);
  }
};
