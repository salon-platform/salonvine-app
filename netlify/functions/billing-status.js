/* Billing status for the portal chrome. Any signed-in staff member of the
   salon may view (the client only shows the manage/checkout actions to the
   admin). Never exposes Stripe IDs — just enough to drive the banners. */

import { cors, json, requireSalonSession } from './_lib.js';
import { stripeConfigured, readBilling } from './_stripe.js';

export default async (req, context) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' }, c.headers);

  const requestedSlug = new URL(req.url).searchParams.get('slug');
  const auth = requireSalonSession(req, requestedSlug, c.headers);
  if (auth.errorResponse) return auth.errorResponse;
  const { slug } = auth;

  try {
    const billing = await readBilling(slug);
    return json(200, {
      ok: true,
      configured: stripeConfigured(),
      billing: billing ? {
        status: billing.status || null,
        graceStartedAt: billing.graceStartedAt || null,
        trialStartedAt: billing.trialStartedAt || null
      } : null
    }, c.headers);
  } catch (e) {
    return json(500, { error: 'Could not load billing status.' }, c.headers);
  }
};
