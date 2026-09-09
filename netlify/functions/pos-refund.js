/* Refund a sale — owner-only, from the portal, no Stripe dashboard.

   POST {slug, chargeId} -> {ok, refunded: true, amountCents}

   Guardrails, in order:
   1. Valid salon session for this slug (requireSalonSession).
   2. The owner gives money back on the salon's account. A stylist who is
      set up independent (booth rent) can refund her OWN account's sales —
      it is her money, and nobody else can reach that account. A commission
      stylist still cannot: that is the owner's till.
   3. The charge is fetched with the salon's own Stripe-Account header. A
      charge id from any other salon simply does not exist on this account,
      so Stripe 404s and nothing can be refunded across salons.
   4. Full refunds only (v1) — partial refunds invite fat-finger amounts on
      a phone; the full amount is what "undo this sale" means.
   5. Idempotency key on the charge id: double-taps cannot refund twice
      (Stripe also refuses to over-refund, this just keeps the UX clean).

   The refund is created ON the connected account, so the salon's balance
   funds it and Stripe reverses to the customer's card. Stripe keeps the
   original processing fee — that is Stripe's standard behaviour, not ours. */

import { cors, json, parseBody, requireSalonSession, getDataStore, userKey } from './_lib.js';
import { stripeConfigured, stripeFetch, payeeFor } from './_stripe.js';

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = await parseBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const guard = requireSalonSession(req, body.slug, c.headers);
  if (guard.errorResponse) return guard.errorResponse;
  const { session, slug } = guard;


  const chargeId = String(body.chargeId || '').trim();
  if (!/^ch_[A-Za-z0-9]+$/.test(chargeId)) {
    return json(400, { error: 'Missing charge to refund.' }, c.headers);
  }
  if (!stripeConfigured()) return json(503, { error: 'Payments are not switched on.' }, c.headers);

  try {
    /* Whose till is this? The owner's salon account, or — for a booth
       renter — her own. A commission stylist has no account of her own and
       must not reach the salon's, so she is turned away here. */
    const user = session.role === 'admin'
      ? { role: 'admin', email: session.email }
      : ((await getDataStore().get(userKey(slug, session.email), { type: 'json' }))
         || { role: 'stylist', email: session.email });
    const payee = await payeeFor(slug, user);
    if (session.role !== 'admin' && !payee.own) {
      return json(403, { error: 'Only the salon owner can issue refunds.' }, c.headers);
    }
    if (!payee.accountId) {
      return json(404, { error: 'No Stripe account is connected for these sales.' }, c.headers);
    }
    const account = payee.accountId;

    /* Fetching on that account IS the ownership check (see header). */
    const charge = await stripeFetch(`charges/${encodeURIComponent(chargeId)}`,
      undefined, { account });

    if (charge.refunded) {
      return json(200, { ok: true, refunded: true, alreadyRefunded: true,
        amountCents: Number(charge.amount_refunded) || 0 }, c.headers);
    }
    if (charge.status !== 'succeeded') {
      return json(400, { error: 'Only completed payments can be refunded.' }, c.headers);
    }

    const refund = await stripeFetch('refunds', { charge: chargeId }, {
      account,
      idempotencyKey: `posrefund_${chargeId}`
    });

    return json(200, {
      ok: true,
      refunded: true,
      amountCents: Number(refund.amount) || Number(charge.amount) || 0
    }, c.headers);
  } catch (e) {
    if (e && e.status === 404) {
      return json(404, { error: 'That payment does not belong to this salon.' }, c.headers);
    }
    const msg = String((e && e.message) || '');
    if (e && e.status === 400 && msg) {
      return json(502, { error: `Stripe rejected the refund: ${msg}` }, c.headers);
    }
    return json(502, { error: 'Could not issue the refund. Try again in a minute.' }, c.headers);
  }
};
