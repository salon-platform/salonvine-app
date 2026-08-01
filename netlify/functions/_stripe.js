/* Salon Vine — shared Stripe helpers (underscore prefix = never deployed as a
   function). Talks to Stripe's REST API directly with fetch; no SDK.
   Billing state lives in the sv-data blob store:
     s/<slug>/billing                 — the salon's billing record
     s/_billing-index/<subscriptionId> — reverse lookup subscriptionId -> {slug}
   (the "_billing-index" segment can never collide with a real salon slug,
   slugs may not contain underscores per normSlug). */

import crypto from 'node:crypto';
import { getDataStore } from './_lib.js';

const STRIPE_API = 'https://api.stripe.com/v1';

export function stripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/* Flat + nested x-www-form-urlencoded encoder, Stripe style:
   { line_items: [{ price: 'p', quantity: 1 }] }
     -> line_items[0][price]=p&line_items[0][quantity]=1
   { metadata: { slug: 'x' } } -> metadata[slug]=x                          */
export function encodeStripeParams(params) {
  const pairs = [];
  function walk(key, val) {
    if (val === null || val === undefined) return;
    if (Array.isArray(val)) {
      val.forEach((v, i) => walk(`${key}[${i}]`, v));
    } else if (typeof val === 'object') {
      for (const k of Object.keys(val)) walk(`${key}[${k}]`, val[k]);
    } else {
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(val))}`);
    }
  }
  for (const k of Object.keys(params || {})) walk(k, params[k]);
  return pairs.join('&');
}

/* POST (or GET when params is undefined) to https://api.stripe.com/v1/<path>.
   Resolves with the parsed JSON on 2xx; throws Error (with .status and
   .stripeError) otherwise.                                                  */
export async function stripeFetch(path, params, options) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY is not configured');
  const o = options || {};
  const opts = {
    method: params === undefined ? 'GET' : 'POST',
    headers: { 'Authorization': `Bearer ${key}` }
  };
  /* Stripe-Account makes this a DIRECT charge on the connected salon's
     account: the salon is merchant of record, owns the dispute, and pays
     Stripe's processing fee directly. We never touch the funds and take no
     application fee — that is what keeps "0% of your bookings" literally true. */
  if (o.account) opts.headers['Stripe-Account'] = o.account;
  if (o.idempotencyKey) opts.headers['Idempotency-Key'] = o.idempotencyKey;
  if (params !== undefined) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = encodeStripeParams(params);
  }
  const res = await fetch(`${STRIPE_API}/${path}`, opts);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (data && data.error && data.error.message) || `Stripe returned ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.stripeError = data && data.error;
    throw err;
  }
  return data;
}

/* Price ID lookup: STRIPE_PRICE_{STUDIO|PRO|ELITE}_{MONTHLY|ANNUAL}.
   Returns null when the plan/interval is unknown or the env var is unset.   */
export function priceFor(plan, interval) {
  const p = String(plan || '').trim().toUpperCase();
  const i = String(interval || 'monthly').trim().toUpperCase();
  if (['STUDIO', 'PRO', 'ELITE'].indexOf(p) === -1) return null;
  if (['MONTHLY', 'ANNUAL'].indexOf(i) === -1) return null;
  return process.env[`STRIPE_PRICE_${p}_${i}`] || null;
}

/* Stripe-Signature verification: header is `t=<unix>,v1=<hex>[,v1=...]`.
   HMAC-SHA256 of `${t}.${rawBody}` with the webhook secret, timing-safe
   compare, and a 5-minute tolerance window against replay. Returns boolean. */
export function verifyStripeSig(rawBody, sigHeader, secret) {
  if (!rawBody || !sigHeader || !secret) return false;
  let t = null;
  const v1s = [];
  for (const part of String(sigHeader).split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1' && v) v1s.push(v);
  }
  if (!t || !v1s.length) return false;
  const ts = Number(t);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const expected = Buffer.from(
    crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex')
  );
  return v1s.some(v => {
    const candidate = Buffer.from(v);
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  });
}

/* ---------------- billing blobs ---------------- */

export function billingKey(slug) { return `s/${slug}/billing`; }
export function billingIndexKey(subscriptionId) { return `s/_billing-index/${subscriptionId}`; }

export async function readBilling(slug) {
  try {
    return await getDataStore().get(billingKey(slug), { type: 'json' });
  } catch (e) {
    return null;
  }
}

export async function writeBilling(slug, data) {
  await getDataStore().setJSON(billingKey(slug), data);
}

/* ---------------- payments / deposits (Stripe Connect) ----------------
   s/<slug>/payments — the salon's connected-account + deposit settings.
   Shape:
     { connectAccountId, chargesEnabled, detailsSubmitted,
       depositEnabled, depositType:'fixed'|'percent', depositAmount,
       noShowFeeEnabled, noShowFeeCents, updatedAt }
   depositAmount is CENTS when depositType==='fixed', otherwise whole
   percent (1-100). Never trust it from the client without clamping. */

export function paymentsKey(slug) { return `s/${slug}/payments`; }

export async function readPayments(slug) {
  try {
    return await getDataStore().get(paymentsKey(slug), { type: 'json' });
  } catch (e) {
    return null;
  }
}

export async function writePayments(slug, data) {
  await getDataStore().setJSON(paymentsKey(slug), { ...data, updatedAt: Date.now() });
}

/* Deposits and no-show fees are the Pro/Elite dividing line. Studio is the
   booking page on its own — seats alone never gave a solo stylist a reason
   to move up a tier. Unknown/missing plan gets the smallest tier. */
const DEPOSIT_PLANS = ['pro', 'elite'];
export function planAllowsDeposits(plan) {
  return DEPOSIT_PLANS.indexOf(String(plan || '').trim().toLowerCase()) !== -1;
}

/* Deposit owed on a booking, in cents. Returns 0 when deposits are off,
   misconfigured, or the computed amount is below Stripe's 50c minimum. */
export function depositCentsFor(payments, servicePriceCents) {
  if (!payments || !payments.depositEnabled) return 0;
  const type = payments.depositType === 'percent' ? 'percent' : 'fixed';
  const amt = Number(payments.depositAmount);
  if (!Number.isFinite(amt) || amt <= 0) return 0;
  let cents;
  if (type === 'fixed') {
    cents = Math.round(amt);
  } else {
    const base = Number(servicePriceCents);
    if (!Number.isFinite(base) || base <= 0) return 0;
    cents = Math.round((base * Math.min(amt, 100)) / 100);
  }
  if (!Number.isFinite(cents) || cents < 50) return 0;   // Stripe minimum charge
  return Math.min(cents, 100000);                        // $1,000 sanity cap
}

export async function readBillingIndex(subscriptionId) {
  if (!subscriptionId) return null;
  try {
    return await getDataStore().get(billingIndexKey(subscriptionId), { type: 'json' });
  } catch (e) {
    return null;
  }
}

export async function writeBillingIndex(subscriptionId, slug) {
  if (!subscriptionId) return;
  await getDataStore().setJSON(billingIndexKey(subscriptionId), { slug });
}
