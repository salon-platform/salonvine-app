/* Start (or resume) Stripe Connect onboarding so money can be collected
   from a salon's own clients.

   Two kinds of account come through here:
     - the SALON's account (owner) — deposits, no-show fees, and checkout
       for every commission stylist;
     - an INDEPENDENT stylist's own account — booth renters who keep their
       own money. The owner marks her independent on the Staff screen
       first; she then connects her own Stripe from her Checkout tab.

   We create an EXPRESS account and hand the owner a Stripe-hosted onboarding
   link. Stripe collects the identity/bank details — none of it ever touches
   us, which is deliberate: we do not want to be in the business of holding
   anyone's KYC data or their money.

   Charges made later use the Stripe-Account header (direct charges), so the
   salon is merchant of record and we take no application fee.

   POST {slug} — signed-in owner, or an independent stylist. Pro/Elite only. */

import {
  cors, json, parseBody, requireSalonSession, getSalonRegistry, APP_URL,
  getDataStore, userKey
} from './_lib.js';
import {
  stripeConfigured, stripeFetch, readPayments, writePayments, planAllowsDeposits,
  readStaffPayments, writeStaffPayments, isIndependent
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

  /* Who is this account for? The owner sets up the salon's; a stylist may
     only set up her own, and only once the owner has marked her
     independent. A commission stylist has nothing to connect — her sales
     go to the salon. */
  let staffUser = null;
  if (session.role !== 'admin') {
    staffUser = await getDataStore().get(userKey(slug, session.email), { type: 'json' });
    if (!staffUser || !isIndependent(staffUser)) {
      return json(403, {
        error: "You're set up as commission, so your checkouts go to the salon's Stripe account. Ask the owner to switch you to independent if you take your own payments."
      }, c.headers);
    }
  }
  const forStaff = Boolean(staffUser);

  const registry = await getSalonRegistry(slug);
  if (!registry) return json(404, { error: 'Salon not found.' }, c.headers);
  if (!planAllowsDeposits(registry.plan)) {
    return json(402, {
      error: 'Deposits are part of Studio Pro. Upgrade your plan to switch them on.',
      upgrade: true
    }, c.headers);
  }

  try {
    let record = forStaff
      ? ((await readStaffPayments(slug, session.email)) || {})
      : ((await readPayments(slug)) || {});
    let accountId = record.connectAccountId;

    if (!accountId) {
      const who = forStaff
        ? (staffUser.name || session.email)
        : (registry.name || slug);
      const account = await stripeFetch('accounts', {
        type: 'express',
        country: 'US',
        email: session.email,
        business_type: 'individual',
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        business_profile: {
          name: who,
          url: `https://salonvine.com/s/${slug}`,
          mcc: '7230'                       // beauty/barber shops
        },
        metadata: forStaff
          ? { slug, salon: registry.name || slug, stylist: session.email }
          : { slug, salon: registry.name || slug }
      });
      accountId = account.id;
      record = { ...record, connectAccountId: accountId, chargesEnabled: false, detailsSubmitted: false };
      if (forStaff) await writeStaffPayments(slug, session.email, record);
      else await writePayments(slug, record);
    }

    const link = await stripeFetch('account_links', {
      account: accountId,
      refresh_url: `${APP_URL}/p/${slug}?payments=refresh`,
      return_url: `${APP_URL}/p/${slug}?payments=done${forStaff ? '&to=checkout' : ''}`,
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
