/* Refund a sale — owner-only, from the portal, no Stripe dashboard.

   POST {slug, chargeId} -> {ok, refunded: true, amountCents}

   Guardrails, in order:
   1. Valid salon session for this slug (requireSalonSession).
   2. session.role === 'admin' — stylists can ring up sales, only the OWNER
      gives money back.
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

import { cors, json, parseBody, requireSalonSession } from './_lib.js';
import { stripeConfigured, stripeFetch, readPayments } from './_stripe.js';

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = await parseBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const guard = requireSalonSession(req, body.slug, c.headers);
  if (guard.errorResponse) return guard.errorResponse;
  const { session, slug } = guard;

  if (session.role !== 'admin') {
    return json(403, { error: 'Only the salon owner can issue refunds.' }, c.headers);
  }

  const chargeId = String(body.chargeId || '').trim();
  if (!/^ch_[A-Za-z0-9]+$/.test(chargeId)) {
    return json(400, { error: 'Missing charge to refund.' }, c.headers);
  }
  if (!stripeConfigured()) return json(503, { error: 'Payments are not switched on.' }, c.headers);

  try {
    const payments = await readPayments(slug);
    if (!payments || !payments.connectAccountId) {
      return json(404, { error: 'This salon has no Stripe account connected.' }, c.headers);
    }
    const account = payments.connectAccountId;

    /* Fetching on the salon's account IS the ownership check (see header). */
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
