/* Sales history — the salon's own payments, shown inside the portal.

   GET ?slug=<slug>&starting_after=<chargeId>
     -> {ok, ready, sales:[{id, created, description, amountCents,
         refundedCents, refunded, status, receiptUrl}], hasMore}

   Any signed-in staff member can look (the same people who ring up sales);
   refunds are a separate, owner-only call (pos-refund).

   Why this exists: salon owners must never need the Stripe dashboard — and
   the founders must never be a refund help desk. Everything a salon does
   with its own money happens here, scoped by the session's slug: we resolve
   the salon's OWN connected account server-side and ask Stripe with the
   Stripe-Account header, so one salon can never see another's charges.     */

import { cors, json, requireSalonSession } from './_lib.js';
import { stripeConfigured, stripeFetch, readPayments } from './_stripe.js';

const PAGE = 25;

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' }, c.headers);

  const url = new URL(req.url);
  const guard = requireSalonSession(req, url.searchParams.get('slug'), c.headers);
  if (guard.errorResponse) return guard.errorResponse;
  const { slug } = guard;

  try {
    const payments = (await readPayments(slug)) || {};
    if (!stripeConfigured() || !payments.connectAccountId) {
      /* Not an error: the screen simply says there is nothing here yet. */
      return json(200, { ok: true, ready: false, sales: [], hasMore: false }, c.headers);
    }

    const after = String(url.searchParams.get('starting_after') || '').trim();
    let path = `charges?limit=${PAGE}`;
    if (/^ch_[A-Za-z0-9]+$/.test(after)) path += `&starting_after=${after}`;

    const res = await stripeFetch(path, undefined, { account: payments.connectAccountId });
    const sales = (res.data || []).map((ch) => ({
      id: ch.id,
      created: (Number(ch.created) || 0) * 1000,
      description: String(ch.description || 'Payment').slice(0, 140),
      amountCents: Number(ch.amount) || 0,
      refundedCents: Number(ch.amount_refunded) || 0,
      refunded: Boolean(ch.refunded),
      status: String(ch.status || ''),
      receiptUrl: String(ch.receipt_url || '')
    }));

    return json(200, { ok: true, ready: true, sales, hasMore: Boolean(res.has_more) }, c.headers);
  } catch (e) {
    return json(502, { error: 'Could not load your sales just now. Try again in a minute.' }, c.headers);
  }
};
