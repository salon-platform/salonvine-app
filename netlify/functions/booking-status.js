/* Update a booking's status. Admin can touch any booking (and is the only one
   who may permanently delete); a stylist may only touch bookings assigned to her. */

const {
  cors, json, parseBody, normId,
  getDataStore, bookingKey,
  requireSalonSession
} = require('./_lib');

const STATUSES = ['new', 'confirmed', 'done', 'canceled'];

exports.handler = async (event) => {
  const c = cors(event);
  if (c.preflight) return c.preflight;
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = parseBody(event);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const auth = requireSalonSession(event, body.slug, c.headers);
  if (auth.errorResponse) return auth.errorResponse;
  const { session, slug } = auth;

  const id = normId(body.id);
  const status = String(body.status || '').toLowerCase();
  if (!id || !status) return json(400, { error: 'Missing fields.' }, c.headers);
  if (status !== 'delete' && STATUSES.indexOf(status) === -1) {
    return json(400, { error: 'Unknown status.' }, c.headers);
  }

  try {
    const store = getDataStore(event);
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

    booking.status = status;
    await store.setJSON(bookingKey(slug, id), booking);
    return json(200, { ok: true }, c.headers);
  } catch (e) {
    return json(500, { error: 'Could not update the booking. Try again.' }, c.headers);
  }
};
