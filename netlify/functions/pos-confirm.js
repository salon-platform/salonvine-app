/* Did that checkout actually get paid? Ask Stripe — never the browser.

   POST {slug, sessionId} -> {ok, paid, amountCents, baseCents, tipCents, feeCents}

   Any signed-in staff member (the same people who can ring up the sale).
   The portal polls this while the "Waiting for payment" screen is up —
   the customer might be paying on their own phone, so the portal never
   sees a redirect and has to ask.

   When the sale was started from a booking, a paid result marks that
   booking paid (idempotently) so it shows on the Bookings screen.

   A paid sale with retail on it also takes those products off the shelf.
   The portal polls this endpoint every few seconds, so every side effect
   in here is claimed with a marker first: twenty polls, one stock count. */

import { cors, json, parseBody, requireSalonSession, getDataStore, userKey } from './_lib.js';
import { stripeConfigured, stripeFetch, payeeFor } from './_stripe.js';
import { markBookingPaid, takeStockOff, sendReceipt } from './_pos.js';

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = await parseBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const guard = requireSalonSession(req, body.slug, c.headers);
  if (guard.errorResponse) return guard.errorResponse;
  const { session, slug } = guard;

  const sessionId = String(body.sessionId || '').trim().slice(0, 200);
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return json(400, { error: 'Missing checkout session.' }, c.headers);
  if (!stripeConfigured()) return json(503, { error: 'Payments are not switched on.' }, c.headers);

  try {
    /* The sale lives on whichever account rang it up — the salon's for a
       commission stylist, her own for a booth renter. Resolve it the same
       way pos-checkout did, from the session, so the poll looks in the
       right place. */
    const user = session.role === 'admin'
      ? { role: 'admin', email: session.email }
      : ((await getDataStore().get(userKey(slug, session.email), { type: 'json' }))
         || { role: 'stylist', email: session.email });
    const payee = await payeeFor(slug, user);
    if (!payee.accountId) {
      return json(404, { error: 'No Stripe account is connected for this checkout.' }, c.headers);
    }

    /* Direct charges live on the CONNECTED account. */
    const checkout = await stripeFetch(`checkout/sessions/${encodeURIComponent(sessionId)}`,
      undefined, { account: payee.accountId });

    const meta = checkout.metadata || {};
    if (meta.slug !== slug || meta.kind !== 'pos') {
      return json(403, { error: 'That payment does not belong to this salon.' }, c.headers);
    }

    const paid = checkout.payment_status === 'paid';
    const out = {
      ok: true,
      paid,
      amountCents: Number(checkout.amount_total) || 0,
      baseCents: Number(meta.baseCents) || 0,
      tipCents: Number(meta.tipCents) || 0,
      feeCents: Number(meta.feeCents) || 0
    };
    if (!paid) return json(200, out, c.headers);

    /* Side effects (booking paid, stock off, receipt) — shared with the
       cash path in pos-cash.js, each claimed once per checkout session. */
    await markBookingPaid(slug, meta.bookingId, {
      amountCents: out.amountCents, tipCents: out.tipCents, method: 'card', ref: sessionId
    });
    let soldItems = [];
    try {
      const basket = meta.saleId
        ? await getDataStore().get(`s/${slug}/pos-items/${meta.saleId}`, { type: 'json' }).catch(() => null)
        : null;
      soldItems = (basket && Array.isArray(basket.items)) ? basket.items : [];
    } catch (e) { soldItems = []; }
    await takeStockOff(slug, sessionId, soldItems);
    await sendReceipt(slug, sessionId, {
      custPhone: meta.custPhone, custEmail: meta.custEmail, service: meta.service,
      serviceCents: Number(meta.serviceCents) || 0, soldItems,
      baseCents: out.baseCents, tipCents: out.tipCents, feeCents: out.feeCents,
      amountCents: out.amountCents, method: 'card'
    });

    return json(200, out, c.headers);
  } catch (e) {
    return json(502, { error: 'Could not check the payment yet.' }, c.headers);
  }
};
