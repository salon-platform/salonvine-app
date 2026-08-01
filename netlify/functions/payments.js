/* Salon payment settings — deposits and no-show fees.

   GET  ?slug=<slug>   -> connection status + current settings (admin only).
                          Refreshes charges_enabled from Stripe so the portal
                          reflects reality right after Connect onboarding.
   POST {slug, ...}    -> save deposit / no-show settings (admin only).

   Deposits are Pro/Elite. Studio gets the booking page; deposits are the
   reason to move up a tier. */

import { cors, json, parseBody, requireSalonSession, getSalonRegistry } from './_lib.js';
import {
  stripeConfigured, stripeFetch, readPayments, writePayments, planAllowsDeposits
} from './_stripe.js';

function publicView(payments, plan) {
  const p = payments || {};
  return {
    planAllows: planAllowsDeposits(plan),
    plan: String(plan || '').toLowerCase(),
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

  if (session.role !== 'admin') {
    return json(403, { error: 'Only the salon owner can manage payments.' }, c.headers);
  }

  const registry = await getSalonRegistry(slug);
  const plan = registry ? registry.plan : '';

  try {
    let payments = (await readPayments(slug)) || {};

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
            await writePayments(slug, payments);
          }
        } catch (e) { /* keep cached status */ }
      }
      return json(200, { ok: true, payments: publicView(payments, plan) }, c.headers);
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
    await writePayments(slug, payments);
    return json(200, { ok: true, payments: publicView(payments, plan) }, c.headers);
  } catch (e) {
    return json(500, { error: 'Could not load payment settings.' }, c.headers);
  }
};
