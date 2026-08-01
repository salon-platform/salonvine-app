/* Confirm a deposit actually got paid, by asking Stripe — never by trusting
   the browser that just came back from Checkout.

   GET ?slug=&bookingId=&session_id=  -> {ok, paid:boolean}

   Public: the client landing on the success URL calls this. It only ever
   flips a booking from unpaid to paid after Stripe says payment_status is
   'paid', and only for a session whose metadata matches this booking. */

import {
  cors, json, normSlug, normId, getDataStore, bookingKey, relayMail, getSalonRegistry
} from './_lib.js';
import { stripeConfigured, stripeFetch, readPayments } from './_stripe.js';

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' }, c.headers);

  const url = new URL(req.url);
  const slug = normSlug(url.searchParams.get('slug'));
  const bookingId = normId(url.searchParams.get('bookingId'));
  const sessionId = String(url.searchParams.get('session_id') || '').trim().slice(0, 200);
  if (!slug || !bookingId || !sessionId) return json(400, { error: 'Missing details.' }, c.headers);
  if (!stripeConfigured()) return json(503, { error: 'Payments are not switched on.' }, c.headers);

  try {
    const payments = await readPayments(slug);
    if (!payments || !payments.connectAccountId) {
      return json(404, { error: 'This salon is not taking deposits.' }, c.headers);
    }

    const store = getDataStore();
    const booking = await store.get(bookingKey(slug, bookingId), { type: 'json' });
    if (!booking) return json(404, { error: 'Booking not found.' }, c.headers);
    if (booking.depositPaid) return json(200, { ok: true, paid: true }, c.headers);

    /* Read the session from the CONNECTED account — that is where a direct
       charge lives. */
    const session = await stripeFetch(`checkout/sessions/${encodeURIComponent(sessionId)}`,
      undefined, { account: payments.connectAccountId });

    const meta = session.metadata || {};
    if (meta.slug !== slug || meta.bookingId !== bookingId) {
      return json(403, { error: 'That payment does not belong to this booking.' }, c.headers);
    }
    if (session.payment_status !== 'paid') {
      return json(200, { ok: true, paid: false }, c.headers);
    }

    const paidCents = Number(session.amount_total) || booking.depositCents || 0;
    await store.setJSON(bookingKey(slug, bookingId), {
      ...booking,
      depositPaid: true,
      depositStatus: 'paid',
      depositCents: paidCents,
      depositPaidAt: Date.now(),
      depositPaymentIntent: session.payment_intent || ''
    });

    /* Tell the salon — a paid deposit is the strongest possible signal that
       this booking is real, and it should not wait for them to open the app. */
    try {
      const registry = await getSalonRegistry(slug);
      const cfgEmail = registry && registry.email;
      if (cfgEmail) {
        await relayMail({
          to: cfgEmail,
          subject: `Deposit paid — ${booking.name || 'new booking'} ($${(paidCents / 100).toFixed(2)})`,
          text: `${booking.name || 'A client'} just paid a $${(paidCents / 100).toFixed(2)} deposit to hold their appointment.\n\n` +
                `Phone: ${booking.phone || '—'}\nEmail: ${booking.email || '—'}\nRequested: ${booking.service || '—'}\n\n` +
                `The money is in your own Stripe account — Salon Vine never touches it.\n` +
                `See it in your portal: https://salonvine-app.netlify.app/p/${slug}`
        });
      }
    } catch (e) { /* never fail a paid deposit on a mail hiccup */ }

    return json(200, { ok: true, paid: true, amountCents: paidCents }, c.headers);
  } catch (e) {
    return json(502, { error: 'Could not confirm the payment yet.' }, c.headers);
  }
};
