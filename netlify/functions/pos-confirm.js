/* Did that checkout actually get paid? Ask Stripe — never the browser.

   POST {slug, sessionId} -> {ok, paid, amountCents, baseCents, tipCents, feeCents}

   Any signed-in staff member (the same people who can ring up the sale).
   The portal polls this while the "Waiting for payment" screen is up —
   the customer might be paying on their own phone, so the portal never
   sees a redirect and has to ask.

   When the sale was started from a booking, a paid result marks that
   booking paid (idempotently) so it shows on the Bookings screen.

   A paid sale with retail on it also takes those products off the shelf.
   The portal polls this endpoint every few seconds, so every side effect
   in here is claimed with a marker first: twenty polls, one stock count. */

import {
  cors, json, parseBody, requireSalonSession, getDataStore, bookingKey,
  getSalonRegistry, relayMail, userKey
} from './_lib.js';

function fmt(c) { return '$' + (Number(c || 0) / 100).toFixed(2); }
import { stripeConfigured, stripeFetch, payeeFor } from './_stripe.js';
import { sbReady, sbSalon, sbSelect, sbWrite, isUuid } from './_supabase.js';

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = await parseBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const guard = requireSalonSession(req, body.slug, c.headers);
  if (guard.errorResponse) return guard.errorResponse;
  const { session, slug } = guard;

  const sessionId = String(body.sessionId || '').trim().slice(0, 200);
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return json(400, { error: 'Missing checkout session.' }, c.headers);
  if (!stripeConfigured()) return json(503, { error: 'Payments are not switched on.' }, c.headers);

  try {
    /* The sale lives on whichever account rang it up — the salon's for a
       commission stylist, her own for a booth renter. Resolve it the same
       way pos-checkout did, from the session, so the poll looks in the
       right place. */
    const user = session.role === 'admin'
      ? { role: 'admin', email: session.email }
      : ((await getDataStore().get(userKey(slug, session.email), { type: 'json' }))
         || { role: 'stylist', email: session.email });
    const payee = await payeeFor(slug, user);
    if (!payee.accountId) {
      return json(404, { error: 'No Stripe account is connected for this checkout.' }, c.headers);
    }

    /* Direct charges live on the CONNECTED account. */
    const checkout = await stripeFetch(`checkout/sessions/${encodeURIComponent(sessionId)}`,
      undefined, { account: payee.accountId });

    const meta = checkout.metadata || {};
    if (meta.slug !== slug || meta.kind !== 'pos') {
      return json(403, { error: 'That payment does not belong to this salon.' }, c.headers);
    }

    const paid = checkout.payment_status === 'paid';
    const out = {
      ok: true,
      paid,
      amountCents: Number(checkout.amount_total) || 0,
      baseCents: Number(meta.baseCents) || 0,
      tipCents: Number(meta.tipCents) || 0,
      feeCents: Number(meta.feeCents) || 0
    };
    if (!paid) return json(200, out, c.headers);

    /* Sale came from a booking -> mark it paid, once. */
    if (meta.bookingId) {
      try {
        const store = getDataStore();
        const key = bookingKey(slug, meta.bookingId);
        const booking = await store.get(key, { type: 'json' });
        if (booking && !booking.posPaid) {
          await store.setJSON(key, {
            ...booking,
            posPaid: true,
            posPaidCents: out.amountCents,
            posTipCents: out.tipCents,
            posPaidAt: Date.now(),
            posSessionId: sessionId
          });
        }
      } catch (e) { /* a paid sale must never look unpaid over a blob hiccup */ }
    }

    /* Retail sold -> take it off the shelf, once. Claim the marker before
       touching stock: a missed decrement is a counting error the owner can
       fix on the Inventory screen, a double decrement is one she cannot
       spot. Never let any of this make a paid sale look unpaid. */
    let soldItems = [];
    try {
      const store = getDataStore();
      const basket = meta.saleId
        ? await store.get(`s/${slug}/pos-items/${meta.saleId}`, { type: 'json' }).catch(() => null)
        : null;
      soldItems = (basket && Array.isArray(basket.items)) ? basket.items : [];
      if (soldItems.length && sbReady()) {
        const marker = `s/${slug}/pos-stock/${sessionId}`;
        const done = await store.get(marker, { type: 'json' }).catch(() => null);
        if (!done) {
          await store.setJSON(marker, { at: Date.now() });
          const ids = [...new Set(soldItems.map(i => String(i.id || '')).filter(isUuid))];
          const salon = ids.length ? await sbSalon(slug) : null;
          if (ids.length && salon) {
            /* Scoped to this salon on both the read and the write: the ids
               came from our own basket, but one stray id must never be able
               to change another salon's count. */
            const rows = await sbSelect('product',
              `salon_id=eq.${salon.id}&id=in.(${ids.join(',')})&select=id,stock_qty`);
            const have = new Map(rows.map(r => [r.id, Number(r.stock_qty) || 0]));
            for (const it of soldItems) {
              if (!have.has(it.id)) continue;
              const left = Math.max(0, have.get(it.id) - (Number(it.qty) || 0));
              await sbWrite('product', 'update',
                `id=eq.${it.id}&salon_id=eq.${salon.id}`, { stock_qty: left }).catch(() => null);
            }
          }
        }
      }
    } catch (e) { /* stock is a count, not the payment */ }

    /* Customer receipt — text + email, once per checkout session. The blob
       marker makes it idempotent across the portal's polling: twenty polls,
       one receipt. Ends with the thing that brings them back. */
    if (meta.custPhone || meta.custEmail) {
      try {
        const store = getDataStore();
        const marker = `s/${slug}/receipts/${sessionId}`;
        const sent = await store.get(marker, { type: 'json' }).catch(() => null);
        if (!sent) {
          await store.setJSON(marker, { at: Date.now() }); // claim first: a double-send beats none, a race beats spam
          const reg = await getSalonRegistry(slug).catch(() => null);
          const salonName = (reg && reg.name) || 'Your salon';
          const bookUrl = `https://salonvine.com/s/${slug}`;
          const service = String(meta.service || '').trim() || 'Salon service';

          if (meta.custPhone) {
            await relayMail({
              sms: { phone: meta.custPhone },
              text: `${salonName}: ${fmt(out.amountCents)} paid — thank you! `
                + `Book your next appointment: ${bookUrl}`
            }).catch(() => null);
          }
          if (meta.custEmail) {
            await relayMail({
              to: meta.custEmail,
              subject: `Your receipt from ${salonName}`,
              text: `${salonName} — receipt\n`
                + `${'-'.repeat(30)}\n`
                + `${Number(meta.serviceCents) > 0 ? `${service}  ${fmt(Number(meta.serviceCents))}\n` : ''}`
                + `${soldItems.map(i => `${i.name}${i.qty > 1 ? ` x${i.qty}` : ''}  ${fmt(i.unit * i.qty)}\n`).join('')}`
                + `${(!Number(meta.serviceCents) && !soldItems.length) ? `${service}  ${fmt(out.baseCents)}\n` : ''}`
                + `${out.tipCents ? `Tip  ${fmt(out.tipCents)}\n` : ''}`
                + `Card processing fee  ${fmt(out.feeCents)}\n`
                + `${'-'.repeat(30)}\n`
                + `Total paid  ${fmt(out.amountCents)}\n`
                + `${new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' })}\n\n`
                + `Thank you!\n\n`
                + `Book your next appointment:\n${bookUrl}`
            }).catch(() => null);
          }
        }
      } catch (e) { /* a receipt hiccup must never make a paid sale look unpaid */ }
    }

    return json(200, out, c.headers);
  } catch (e) {
    return json(502, { error: 'Could not check the payment yet.' }, c.headers);
  }
};
