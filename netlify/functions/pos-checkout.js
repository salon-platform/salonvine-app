/* In-person checkout — the register button for the portal.

   A stylist finishes an appointment, taps Checkout, enters the amount, hands
   the phone over for the tip screen, and takes the card — typed in on this
   phone, or paid on the CUSTOMER'S phone (Apple Pay / Google Pay) via QR.

   GET  ?slug=<slug>       -> {ok, ready, connected, chargesEnabled}
                              Any signed-in staff member. Lets the Checkout
                              screen say "ask the owner to finish Stripe
                              setup" instead of failing at the last step.
   POST {slug, amountCents, tipCents, bookingId?, service?, client?, saleId}
                           -> {ok, url, sessionId, baseCents, tipCents,
                               feeCents, totalCents}

   Any signed-in staff member can ring up a sale (a register the stylists
   can't use is not a register); only the owner can change payment SETTINGS,
   which stay behind payments.js.

   The card-processing fee (2.9% + 30c — what Stripe charges the salon) is
   always added as its own line item, so the salon nets the full service
   amount + tip. It is computed HERE, never trusted from the browser.

   Direct charge on the salon's connected account (Stripe-Account header),
   no application fee — Salon Vine takes nothing, same as deposits. */

import {
  cors, json, parseBody, normId, requireSalonSession
} from './_lib.js';
import { stripeConfigured, stripeFetch, readPayments } from './_stripe.js';

const FEE_PCT = 0.029;   /* Stripe's standard US card rate */
const FEE_FIXED_CENTS = 30;

const MIN_CENTS = 50;         /* Stripe minimum charge */
const MAX_CENTS = 1000000;    /* $10,000 sanity cap per sale */
const MAX_TIP_CENTS = 500000; /* $5,000 tip cap */

export function cardFeeCents(baseCents) {
  return Math.round(baseCents * FEE_PCT) + FEE_FIXED_CENTS;
}

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;

  const isGet = req.method === 'GET';
  if (!isGet && req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = isGet ? {} : await parseBody(req);
  if (!isGet && !body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const url = new URL(req.url);
  const requestedSlug = isGet ? url.searchParams.get('slug') : body.slug;
  const guard = requireSalonSession(req, requestedSlug, c.headers);
  if (guard.errorResponse) return guard.errorResponse;
  const { session, slug } = guard;

  try {
    const payments = (await readPayments(slug)) || {};
    const ready = Boolean(stripeConfigured() && payments.connectAccountId && payments.chargesEnabled);

    if (isGet) {
      return json(200, {
        ok: true,
        ready,
        connected: Boolean(payments.connectAccountId),
        chargesEnabled: Boolean(payments.chargesEnabled)
      }, c.headers);
    }

    if (!ready) {
      return json(400, {
        error: session.role === 'admin'
          ? 'Finish your Stripe setup on the Payments screen before taking a checkout.'
          : 'Checkout is not set up yet — ask the owner to finish Stripe setup on the Payments screen.'
      }, c.headers);
    }

    let baseCents = Math.round(Number(body.amountCents));
    if (!Number.isFinite(baseCents) || baseCents < MIN_CENTS || baseCents > MAX_CENTS) {
      return json(400, { error: 'Enter an amount between $0.50 and $10,000.' }, c.headers);
    }
    let tipCents = Math.round(Number(body.tipCents) || 0);
    if (!Number.isFinite(tipCents) || tipCents < 0) tipCents = 0;
    tipCents = Math.min(tipCents, MAX_TIP_CENTS);

    const feeCents = cardFeeCents(baseCents + tipCents);
    const totalCents = baseCents + tipCents + feeCents;

    const bookingId = normId(body.bookingId || '') || '';
    const service = String(body.service || '').trim().slice(0, 80);
    const client = String(body.client || '').trim().slice(0, 80);
    const saleId = String(body.saleId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
      || `${Date.now()}`;

    const lineItems = [{
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: baseCents,
        product_data: {
          name: service || 'Salon service',
          description: client ? `For ${client}` : undefined
        }
      }
    }];
    if (tipCents > 0) {
      lineItems.push({
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: tipCents,
          product_data: { name: 'Tip' }
        }
      });
    }
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: feeCents,
        product_data: { name: 'Card processing fee' }
      }
    });

    /* success/cancel land on the salon's public site: whichever PHONE pays
       (the stylist's or the customer's own, via QR), the person holding it
       should see the salon, never a portal sign-in box. The portal itself
       never navigates away — it polls pos-confirm until the money is in. */
    const siteUrl = `https://salonvine.com/s/${slug}`;

    const checkout = await stripeFetch('checkout/sessions', {
      mode: 'payment',
      line_items: lineItems,
      payment_intent_data: {
        description: `${service || 'Service'}${client ? ` — ${client}` : ''} (in-salon checkout)`,
        metadata: { slug, kind: 'pos', bookingId, saleId }
      },
      metadata: {
        slug, kind: 'pos', bookingId, saleId,
        baseCents: String(baseCents), tipCents: String(tipCents), feeCents: String(feeCents),
        staff: String(session.email || '').slice(0, 120)
      },
      success_url: `${siteUrl}?checkout=thanks`,
      cancel_url: `${siteUrl}?checkout=cancelled`
    }, {
      account: payments.connectAccountId,
      /* Same sale re-submitted (double-tap, flaky signal) must not create a
         second session with a second idempotent charge attempt. */
      idempotencyKey: `pos_${slug}_${saleId}`
    });

    return json(200, {
      ok: true,
      url: checkout.url,
      sessionId: checkout.id,
      baseCents, tipCents, feeCents, totalCents
    }, c.headers);
  } catch (e) {
    const msg = String((e && e.message) || '');
    if (e && e.status === 400 && msg) {
      return json(502, { error: `Stripe rejected the charge: ${msg}` }, c.headers);
    }
    return json(502, { error: 'Could not start the checkout. Try again in a minute.' }, c.headers);
  }
};
