/* Create a Stripe Checkout session so a salon's CLIENT can pay their booking
   deposit. Public endpoint — the person paying is not signed in to anything.

   This is a DIRECT charge on the salon's connected account (Stripe-Account
   header), with no application_fee_amount. The money goes salon <- client;
   we are not in the middle and take nothing.

   POST {slug, bookingId} -> {ok, url} | {ok:true, depositRequired:false}   */

import {
  cors, json, parseBody, normSlug, normId, getDataStore, bookingKey, getSalonRegistry
} from './_lib.js';
import {
  stripeConfigured, stripeFetch, readPayments, planAllowsDeposits, depositCentsFor
} from './_stripe.js';

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = await parseBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const slug = normSlug(body.slug);
  const bookingId = normId(body.bookingId);
  if (!slug || !bookingId) return json(400, { error: 'Missing booking.' }, c.headers);

  try {
    const [registry, payments] = await Promise.all([
      getSalonRegistry(slug),
      readPayments(slug)
    ]);
    if (!registry) return json(404, { error: 'Salon not found.' }, c.headers);

    /* Every gate that could make a deposit inapplicable resolves to the same
       harmless answer: no deposit needed. A client must never see a billing
       error because the SALON's plan lapsed or setup is half-finished. */
    if (!stripeConfigured() || !payments || !payments.connectAccountId ||
        !payments.chargesEnabled || !payments.depositEnabled ||
        !planAllowsDeposits(registry.plan)) {
      return json(200, { ok: true, depositRequired: false }, c.headers);
    }

    const store = getDataStore();
    const booking = await store.get(bookingKey(slug, bookingId), { type: 'json' });
    if (!booking) return json(404, { error: 'Booking not found.' }, c.headers);
    if (booking.depositPaid) {
      return json(200, { ok: true, depositRequired: false, alreadyPaid: true }, c.headers);
    }

    const cents = depositCentsFor(payments, booking.servicePriceCents);
    if (!cents) return json(200, { ok: true, depositRequired: false }, c.headers);

    const siteUrl = `https://salonvine.com/s/${slug}`;
    const session = await stripeFetch('checkout/sessions', {
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: cents,
          product_data: {
            name: `Booking deposit — ${registry.name || slug}`,
            description: 'Applied to the cost of your appointment.'
          }
        }
      }],
      payment_intent_data: {
        description: `Deposit for ${booking.name || 'a booking'} at ${registry.name || slug}`,
        metadata: { slug, bookingId }
      },
      metadata: { slug, bookingId, kind: 'deposit' },
      customer_email: booking.email || undefined,
      success_url: `${siteUrl}?deposit=paid&b=${encodeURIComponent(bookingId)}&cs={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}?deposit=cancelled`
    }, {
      account: payments.connectAccountId,
      /* One booking can only ever create one deposit session, even if the
         client double-taps or the page reloads mid-redirect. */
      idempotencyKey: `dep_${slug}_${bookingId}`
    });

    await store.setJSON(bookingKey(slug, bookingId), {
      ...booking,
      depositCents: cents,
      depositSessionId: session.id,
      depositStatus: 'pending'
    });

    return json(200, { ok: true, depositRequired: true, url: session.url, amountCents: cents }, c.headers);
  } catch (e) {
    return json(502, { error: 'Could not start the deposit payment. Your request was still sent.' }, c.headers);
  }
};
