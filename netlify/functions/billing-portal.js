/* Stripe customer billing portal — owner (admin) only. Lets the salon update
   the card, switch plans, download invoices, or cancel. */

import { cors, json, parseBody, requireSalonSession, APP_URL } from './_lib.js';
import { stripeConfigured, stripeFetch, readBilling } from './_stripe.js';

export default async (req, context) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);
  if (!stripeConfigured()) return json(503, { error: 'Billing is not switched on yet.' }, c.headers);

  const body = await parseBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const auth = requireSalonSession(req, body.slug, c.headers);
  if (auth.errorResponse) return auth.errorResponse;
  const { session, slug } = auth;
  if (session.role !== 'admin') return json(403, { error: 'Owner access only.' }, c.headers);

  try {
    const billing = await readBilling(slug);
    if (!billing || !billing.customerId) {
      return json(404, { error: 'No billing account yet — start your trial first.' }, c.headers);
    }
    const portal = await stripeFetch('billing_portal/sessions', {
      customer: billing.customerId,
      return_url: `${APP_URL}/p/${slug}`
    });
    return json(200, { ok: true, url: portal.url }, c.headers);
  } catch (e) {
    return json(502, { error: 'Could not open the billing portal right now. Try again in a minute.' }, c.headers);
  }
};
