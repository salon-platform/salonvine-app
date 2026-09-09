/* Salon payment settings — deposits and no-show fees.

   GET  ?slug=<slug>   -> connection status + current settings (admin only).
                          Refreshes charges_enabled from Stripe so the portal
                          reflects reality right after Connect onboarding.
   POST {slug, ...}    -> save deposit / no-show settings (admin only).

   Deposits are Pro/Elite. Studio gets the booking page; deposits are the
   reason to move up a tier. */

import { cors, json, parseBody, requireSalonSession, getSalonRegistry, getDataStore, userKey } from './_lib.js';
import {
  stripeConfigured, stripeFetch, readPayments, writePayments,
  readStaffPayments, writeStaffPayments, isIndependent, planAllowsDeposits
} from './_stripe.js';

function publicView(payments, plan, own) {
  const p = payments || {};
  return {
    planAllows: planAllowsDeposits(plan),
    plan: String(plan || '').toLowerCase(),
    own: Boolean(own),                 // true = the signed-in stylist's OWN account, not the salon's
    payType: own ? 'independent' : 'commission',
    connected: Boolean(p.connectAccountId),
    chargesEnabled: Boolean(p.chargesEnabled),
    detailsSubmitted: Boolean(p.detailsSubmitted),
    depositEnabled: Boolean(p.depositEnabled),
    depositType: p.depositType === 'percent' ? 'percent' : 'fixed',
    depositAmount: Number(p.depositAmount) || 0,
    noShowFeeEnabled: Boolean(p.noShowFeeEnabled),
    noShowFeeCents: Number(p.noShowFeeCents) || 0
  };
}

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;

  const url = new URL(req.url);
  const isGet = req.method === 'GET';
  const body = isGet ? {} : await parseBody(req);
  if (!isGet && !body) return json(400, { error: 'Invalid JSON' }, c.headers);
  if (!isGet && req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const requestedSlug = isGet ? url.searchParams.get('slug') : body.slug;
  const guard = requireSalonSession(req, requestedSlug, c.headers);
  if (guard.errorResponse) return guard.errorResponse;
  const { session, slug } = guard;

  /* Who owns this settings page? The owner manages the salon's account
     (commission stylists route here). An INDEPENDENT stylist manages their
     OWN account. A commission stylist has nothing to manage — the owner does. */
  const isAdmin = session.role === 'admin';
  let own = false;
  if (!isAdmin) {
    const staffUser = await getDataStore().get(userKey(slug, session.email), { type: 'json' }).catch(() => null);
    own = Boolean(staffUser && isIndependent(staffUser));
    if (!own) {
      return json(403, { error: "You're set up as commission, so the salon owner manages payments. Ask them to switch you to independent if you take your own payments." }, c.headers);
    }
  }
  const readP = () => (isAdmin ? readPayments(slug) : readStaffPayments(slug, session.email));
  const writeP = (data) => (isAdmin ? writePayments(slug, data) : writeStaffPayments(slug, session.email, data));

  const registry = await getSalonRegistry(slug);
  const plan = registry ? registry.plan : '';

  try {
    let payments = (await readP()) || {};

    if (isGet) {
      /* Pull live capability status so the card stops saying "finish setup"
         the moment Stripe approves them. Never fail the read on a Stripe blip. */
      if (payments.connectAccountId && stripeConfigured()) {
        try {
          const acct = await stripeFetch(`accounts/${payments.connectAccountId}`);
          const chargesEnabled = Boolean(acct.charges_enabled);
          const detailsSubmitted = Boolean(acct.details_submitted);
          if (chargesEnabled !== payments.chargesEnabled || detailsSubmitted !== payments.detailsSubmitted) {
            payments = { ...payments, chargesEnabled, detailsSubmitted };
            await writeP(payments);
          }
        } catch (e) { /* keep cached status */ }
      }
      return json(200, { ok: true, payments: publicView(payments, plan, own) }, c.headers);
    }

    /* ---- POST: save settings ---- */
    if (!planAllowsDeposits(plan)) {
      return json(402, {
        error: 'Deposits are part of Studio Pro. Upgrade your plan to switch them on.',
        upgrade: true
      }, c.headers);
    }

    const depositEnabled = Boolean(body.depositEnabled);
    const depositType = body.depositType === 'percent' ? 'percent' : 'fixed';
    let depositAmount = Number(body.depositAmount);
    if (!Number.isFinite(depositAmount) || depositAmount < 0) depositAmount = 0;
    /* Clamp server-side — a percent over 100 or a $10k "deposit" is either a
       typo or an attack, and either way it must never reach a client. */
    depositAmount = depositType === 'percent'
      ? Math.min(Math.round(depositAmount), 100)
      : Math.min(Math.round(depositAmount), 100000);

    const noShowFeeEnabled = Boolean(body.noShowFeeEnabled);
    let noShowFeeCents = Number(body.noShowFeeCents);
    if (!Number.isFinite(noShowFeeCents) || noShowFeeCents < 0) noShowFeeCents = 0;
    noShowFeeCents = Math.min(Math.round(noShowFeeCents), 100000);

    if (depositEnabled && !payments.chargesEnabled) {
      return json(400, {
        error: 'Finish your Stripe setup before switching deposits on.'
      }, c.headers);
    }
    if (depositEnabled && depositAmount <= 0) {
      return json(400, { error: 'Set a deposit amount above zero.' }, c.headers);
    }

    payments = {
      ...payments,
      depositEnabled, depositType, depositAmount,
      noShowFeeEnabled, noShowFeeCents
    };
    await writeP(payments);
    return json(200, { ok: true, payments: publicView(payments, plan, own) }, c.headers);
  } catch (e) {
    return json(500, { error: 'Could not load payment settings.' }, c.headers);
  }
};
