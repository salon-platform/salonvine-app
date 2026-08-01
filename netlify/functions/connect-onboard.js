/* Start (or resume) Stripe Connect onboarding for a salon so it can collect
   deposits and no-show fees from its own clients.

   We create an EXPRESS account and hand the owner a Stripe-hosted onboarding
   link. Stripe collects the identity/bank details — none of it ever touches
   us, which is deliberate: we do not want to be in the business of holding
   anyone's KYC data or their money.

   Charges made later use the Stripe-Account header (direct charges), so the
   salon is merchant of record and we take no application fee.

   POST {slug} — salon admin session required, Pro/Elite only.            */

import { cors, json, parseBody, requireSalonSession, getSalonRegistry, APP_URL } from './_lib.js';
import {
  stripeConfigured, stripeFetch, readPayments, writePayments, planAllowsDeposits
} from './_stripe.js';

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);
  if (!stripeConfigured()) return json(503, { error: 'Payments are not switched on yet.' }, c.headers);

  const body = await parseBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const guard = requireSalonSession(req, body.slug, c.headers);
  if (guard.errorResponse) return guard.errorResponse;
  const { session, slug } = guard;

  if (session.role !== 'admin') {
    return json(403, { error: 'Only the salon owner can set up payments.' }, c.headers);
  }

  const registry = await getSalonRegistry(slug);
  if (!registry) return json(404, { error: 'Salon not found.' }, c.headers);
  if (!planAllowsDeposits(registry.plan)) {
    return json(402, {
      error: 'Deposits are part of Studio Pro. Upgrade your plan to switch them on.',
      upgrade: true
    }, c.headers);
  }

  try {
    let payments = (await readPayments(slug)) || {};
    let accountId = payments.connectAccountId;

    if (!accountId) {
      const account = await stripeFetch('accounts', {
        type: 'express',
        country: 'US',
        email: session.email,
        business_type: 'individual',
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        business_profile: {
          name: registry.name || slug,
          url: `https://salonvine.com/s/${slug}`,
          mcc: '7230'                       // beauty/barber shops
        },
        metadata: { slug, salon: registry.name || slug }
      });
      accountId = account.id;
      payments = { ...payments, connectAccountId: accountId, chargesEnabled: false, detailsSubmitted: false };
      await writePayments(slug, payments);
    }

    const link = await stripeFetch('account_links', {
      account: accountId,
      refresh_url: `${APP_URL}/p/${slug}?payments=refresh`,
      return_url: `${APP_URL}/p/${slug}?payments=done`,
      type: 'account_onboarding'
    });

    return json(200, { ok: true, url: link.url, accountId }, c.headers);
  } catch (e) {
    /* Connect not enabled on the platform account is the likely first
       failure — surface it plainly instead of a generic 502. */
    const msg = String((e && e.message) || '');
    if (/connect/i.test(msg) || (e && e.status === 400)) {
      return json(502, { error: `Stripe rejected the request: ${msg}` }, c.headers);
    }
    return json(502, { error: 'Could not start payment setup. Try again in a minute.' }, c.headers);
  }
};
