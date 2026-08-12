/* Did that checkout actually get paid? Ask Stripe — never the browser.

   POST {slug, sessionId} -> {ok, paid, amountCents, baseCents, tipCents, feeCents}

   Any signed-in staff member (the same people who can ring up the sale).
   The portal polls this while the "Waiting for payment" screen is up —
   the customer might be paying on their own phone, so the portal never
   sees a redirect and has to ask.

   When the sale was started from a booking, a paid result marks that
   booking paid (idempotently) so it shows on the Bookings screen. */

import {
  cors, json, parseBody, requireSalonSession, getDataStore, bookingKey,
  getSalonRegistry, relayMail
} from './_lib.js';

function fmt(c) { return '$' + (Number(c || 0) / 100).toFixed(2); }
import { stripeConfigured, stripeFetch, readPayments } from './_stripe.js';

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = await parseBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const guard = requireSalonSession(req, body.slug, c.headers);
  if (guard.errorResponse) return guard.errorResponse;
  const { slug } = guard;

  const sessionId = String(body.sessionId || '').trim().slice(0, 200);
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return json(400, { error: 'Missing checkout session.' }, c.headers);
  if (!stripeConfigured()) return json(503, { error: 'Payments are not switched on.' }, c.headers);

  try {
    const payments = await readPayments(slug);
    if (!payments || !payments.connectAccountId) {
      return json(404, { error: 'This salon has no Stripe account connected.' }, c.headers);
    }

    /* Direct charges live on the CONNECTED account. */
    const checkout = await stripeFetch(`checkout/sessions/${encodeURIComponent(sessionId)}`,
      undefined, { account: payments.connectAccountId });

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
                + `${service}  ${fmt(out.baseCents)}\n`
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
