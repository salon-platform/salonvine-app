/* Sales history — the salon's own payments, shown inside the portal.

   GET ?slug=<slug>&starting_after=<chargeId>
     -> {ok, ready, sales:[{id, created, description, amountCents,
         refundedCents, refunded, status, receiptUrl}], hasMore}

   Any signed-in staff member can look (the same people who ring up sales).
   A stylist the owner has marked independent (booth rent) sees HER OWN
   account's sales, because that is where her money went — everyone else
   sees the salon's.

   Why this exists: salon owners must never need the Stripe dashboard — and
   the founders must never be a refund help desk. Everything a salon does
   with its own money happens here, scoped by the session's slug: we resolve
   the salon's OWN connected account server-side and ask Stripe with the
   Stripe-Account header, so one salon can never see another's charges.     */

import { cors, json, requireSalonSession, getDataStore, userKey, listJSON } from './_lib.js';
import { stripeConfigured, stripeFetch, payeeFor } from './_stripe.js';
import { cashSalesPrefix } from './_pos.js';

const PAGE = 25;

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' }, c.headers);

  const url = new URL(req.url);
  const guard = requireSalonSession(req, url.searchParams.get('slug'), c.headers);
  if (guard.errorResponse) return guard.errorResponse;
  const { session, slug } = guard;

  try {
    const user = session.role === 'admin'
      ? { role: 'admin', email: session.email }
      : ((await getDataStore().get(userKey(slug, session.email), { type: 'json' }))
         || { role: 'stylist', email: session.email });
    const payee = await payeeFor(slug, user);
    const after = String(url.searchParams.get('starting_after') || '').trim();

    /* Cash / other sales rung up in the portal live in Blobs. Newest first;
       they ride along with the FIRST page only, merged in by date. */
    let cash = [];
    if (!after) {
      try {
        cash = (await listJSON(getDataStore(), cashSalesPrefix(slug)))
          .filter(sl => sl && sl.kind === 'cash')
          .sort((a, b) => (b.created || 0) - (a.created || 0))
          .slice(0, 200)
          .map(sl => ({
            id: 'cash_' + sl.id,
            created: Number(sl.created) || 0,
            description: `${sl.service || 'Sale'}${sl.client ? ` — ${sl.client}` : ''}`
              + `${(sl.items || []).length ? ` + ${sl.items.length} product${sl.items.length > 1 ? 's' : ''}` : ''}`
              + ` (${sl.method === 'other' ? 'paid another way' : 'cash'})`,
            amountCents: Number(sl.totalCents) || 0,
            refundedCents: 0, refunded: false,
            status: 'succeeded', receiptUrl: '', method: sl.method || 'cash', cash: true
          }));
      } catch (e) { cash = []; }
    }

    if (!stripeConfigured() || !payee.accountId) {
      /* No Stripe yet: cash sales are still a history. */
      return json(200, { ok: true, ready: false, sales: cash, hasMore: false }, c.headers);
    }
    let path = `charges?limit=${PAGE}`;
    if (/^ch_[A-Za-z0-9]+$/.test(after)) path += `&starting_after=${after}`;

    const res = await stripeFetch(path, undefined, { account: payee.accountId });
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

    /* Cash sales slot in by date among the cards on the first page; any
       older than the oldest card on this page still show (at the end) so
       nothing is hidden when the salon has few card sales. */
    let merged = sales;
    if (cash.length) {
      merged = sales.concat(cash.map(x => ({ ...x, method: x.method })))
        .sort((a, b) => (b.created || 0) - (a.created || 0));
    }
    return json(200, { ok: true, ready: true, sales: merged, hasMore: Boolean(res.has_more) }, c.headers);
  } catch (e) {
    return json(502, { error: 'Could not load your sales just now. Try again in a minute.' }, c.headers);
  }
};
