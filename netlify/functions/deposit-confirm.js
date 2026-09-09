/* Confirm a deposit actually got paid, by asking Stripe — never by trusting
   the browser that just came back from Checkout.

   GET ?slug=&bookingId=&session_id=  -> {ok, paid:boolean}

   Public: the client landing on the success URL calls this. It reads the
   deposit record written by booking-deposit (which knows WHICH account the
   charge was created on — the salon's for a commission stylist, the stylist's
   own for an independent), verifies the session with Stripe on that account,
   and only flips the deposit to paid when Stripe says payment_status is 'paid'
   AND the session metadata matches this exact booking. */

import {
  cors, json, normSlug, normId, getDataStore, relayMail, getSalonRegistry
} from './_lib.js';
import { stripeConfigured, stripeFetch } from './_stripe.js';

function depositKey(slug, apptId) { return `s/${slug}/deposits/${apptId}`; }

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' }, c.headers);

  const url = new URL(req.url);
  const slug = normSlug(url.searchParams.get('slug'));
  const bookingId = normId(url.searchParams.get('bookingId'));
  const sessionId = String(url.searchParams.get('session_id') || '').trim().slice(0, 200);
  if (!slug || !bookingId || !sessionId) return json(400, { error: 'Missing details.' }, c.headers);
  if (!stripeConfigured()) return json(503, { error: 'Payments are not switched on.' }, c.headers);

  try {
    const store = getDataStore();
    const dep = await store.get(depositKey(slug, bookingId), { type: 'json' });
    if (!dep || !dep.account) return json(404, { error: 'No deposit for this booking.' }, c.headers);
    if (dep.status === 'paid') return json(200, { ok: true, paid: true, amountCents: dep.cents || 0 }, c.headers);

    /* Read the session from the account the charge was created on — a direct
       charge lives on the connected (salon OR stylist) account, not ours. */
    const session = await stripeFetch(`checkout/sessions/${encodeURIComponent(sessionId)}`,
      undefined, { account: dep.account });

    const meta = session.metadata || {};
    if (meta.slug !== slug || meta.bookingId !== bookingId) {
      return json(403, { error: 'That payment does not belong to this booking.' }, c.headers);
    }
    if (session.payment_status !== 'paid') {
      return json(200, { ok: true, paid: false }, c.headers);
    }

    const paidCents = Number(session.amount_total) || dep.cents || 0;
    await store.setJSON(depositKey(slug, bookingId), {
      ...dep,
      status: 'paid',
      paidAt: Date.now(),
      paymentIntent: session.payment_intent || ''
    });

    /* Tell whoever the money went to — the salon always, and the independent
       stylist too when it's their own account. A mail hiccup never un-pays it. */
    try {
      const registry = await getSalonRegistry(slug);
      const who = dep.clientName || 'A client';
      const amt = `$${(paidCents / 100).toFixed(2)}`;
      const to = [];
      if (registry && registry.email) to.push(registry.email);
      if (dep.payType === 'independent' && dep.stylistEmail && to.indexOf(dep.stylistEmail) === -1) to.push(dep.stylistEmail);
      for (const addr of to) {
        await relayMail({
          to: addr,
          subject: `Deposit paid — ${who} (${amt})`,
          text: `${who} just paid a ${amt} deposit to hold their appointment.\n\n`
            + `Email: ${dep.clientEmail || '—'}\n\n`
            + `The money is in ${dep.payType === 'independent' ? 'the stylist\'s own' : 'your'} Stripe account — Salon Vine never touches it.\n`
            + `See it in the portal: https://app.salonvine.com/p/${slug}`
        });
      }
    } catch (e) { /* never fail a paid deposit on a mail hiccup */ }

    return json(200, { ok: true, paid: true, amountCents: paidCents }, c.headers);
  } catch (e) {
    return json(502, { error: 'Could not confirm the payment yet.' }, c.headers);
  }
};
