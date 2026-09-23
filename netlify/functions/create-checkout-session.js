/* Start a Stripe Checkout for a salon's subscription (30-day free trial).
   POST {slug, plan?, interval?} — plan defaults to the salon's registry plan,
   interval defaults to 'monthly'. Nothing is persisted here; the webhook
   (stripe-webhook.js) writes the billing blob when checkout completes. */

import { cors, json, parseBody, normSlug, getSalonRegistry, APP_URL } from './_lib.js';
import { stripeConfigured, stripeFetch, priceFor, readBilling } from './_stripe.js';

const PLANS = ['studio', 'pro', 'elite'];
const INTERVALS = ['monthly', 'annual'];

export default async (req, context) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);
  if (!stripeConfigured()) return json(503, { error: 'Billing is not switched on yet.' }, c.headers);

  const body = await parseBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const slug = normSlug(body.slug);
  if (!slug) return json(400, { error: 'Missing or invalid salon.' }, c.headers);

  try {
    const registry = await getSalonRegistry(slug);
    if (!registry) return json(404, { error: 'Salon not found.' }, c.headers);

    const requested = String(body.plan || '').trim().toLowerCase();
    const plan = PLANS.indexOf(requested) !== -1
      ? requested
      : (PLANS.indexOf(String(registry.plan || '').toLowerCase()) !== -1
        ? String(registry.plan).toLowerCase() : 'studio');
    const interval = INTERVALS.indexOf(String(body.interval || '').trim().toLowerCase()) !== -1
      ? String(body.interval).trim().toLowerCase() : 'monthly';

    const price = priceFor(plan, interval);
    if (!price) return json(503, { error: 'Billing is not switched on yet.' }, c.headers);

    /* The portal shows the terms (30 days free, monthly auto-renew, no
       refunds) and the owner ticks a box before we get here. Record it on the
       subscription so the acceptance travels with the billing record. */
    if (body.terms !== true) return json(400, { error: 'Please agree to the Terms of Service first.' }, c.headers);
    const acceptedAt = new Date().toISOString();
    const params = {
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      subscription_data: {
        trial_period_days: 30,
        metadata: { slug, terms_accepted_at: acceptedAt, terms_version: '2026-09-23', terms_accepted_by: session.email || '' }
      },
      metadata: { slug, terms_accepted_at: acceptedAt },
      custom_text: { submit: { message: 'By starting your trial you agree to the Salon Vine Terms of Service: monthly auto-renewal after 30 days, cancel any time, no refunds.' } },
      allow_promotion_codes: true,
      success_url: `${APP_URL}/p/${slug}?billing=success`,
      cancel_url: `${APP_URL}/p/${slug}?billing=cancelled`
    };

    /* Pre-fill the owner's email when a previous billing record knows it. */
    const billing = await readBilling(slug);
    if (billing && billing.ownerEmail) params.customer_email = billing.ownerEmail;

    const session = await stripeFetch('checkout/sessions', params);
    return json(200, { ok: true, url: session.url }, c.headers);
  } catch (e) {
    return json(502, { error: 'Could not start checkout right now. Try again in a minute.' }, c.headers);
  }
};
