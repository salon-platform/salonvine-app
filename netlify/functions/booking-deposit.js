/* Create a Stripe Checkout session so a salon's CLIENT can pay their booking
   deposit. Public endpoint — the person paying is not signed in to anything.

   ROUTING (the core of the multi-account model):
     - The booking's stylist decides whose Stripe account the deposit lands on.
     - An INDEPENDENT stylist (owner marked them independent + they connected
       their own Stripe) takes the deposit on THEIR account, at THEIR amount.
     - A COMMISSION stylist (the default) takes it on the SALON's account, at
       the salon's amount.
     - Deposits off, no account, setup half-finished, plan too low → NO deposit.
   All of that is DIRECT charges (Stripe-Account header), no application fee:
   the money goes salon/stylist <- client and we take nothing.

   The deposit amount is read from the Supabase appointment (authoritative),
   never from the client — a client can't talk their own price down.

   POST {slug, bookingId, clientEmail?, clientName?} where bookingId is the
   Supabase appointment id returned by sv_book.
     -> {ok, depositRequired:true, url, amountCents}
      | {ok:true, depositRequired:false}                                       */

import {
  cors, json, parseBody, normSlug, normId, getDataStore, getSalonRegistry, userKey
} from './_lib.js';
import {
  stripeConfigured, stripeFetch, readPayments, readStaffPayments,
  planAllowsDeposits, depositCentsFor, isIndependent
} from './_stripe.js';
import { sbReady, sbSalon, sbSelect } from './_supabase.js';

/* where a deposit's live state lives — keyed by the appointment id, separate
   from the appointment row so we need no schema change and deposit-confirm can
   read back the account + session to verify the payment with Stripe. */
function depositKey(slug, apptId) { return `s/${slug}/deposits/${apptId}`; }

const NO_DEPOSIT = (headers) => json(200, { ok: true, depositRequired: false }, headers);

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = await parseBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const slug = normSlug(body.slug);
  const bookingId = normId(body.bookingId);
  if (!slug || !bookingId) return json(400, { error: 'Missing booking.' }, c.headers);

  try {
    const registry = await getSalonRegistry(slug);
    /* Any reason a deposit can't apply resolves to the SAME harmless answer —
       the client never sees a billing error because of the salon's setup. */
    if (!registry || !stripeConfigured() || !sbReady() || !planAllowsDeposits(registry.plan)) {
      return NO_DEPOSIT(c.headers);
    }

    const salon = await sbSalon(slug);
    if (!salon) return NO_DEPOSIT(c.headers);

    /* Authoritative appointment: price + who it's with. */
    const rows = await sbSelect('appointment',
      `id=eq.${bookingId}&salon_id=eq.${salon.id}&limit=1`
      + `&select=id,price_cents,status,stylist:stylist_id(email,name),client:client_id(email,name)`);
    const appt = Array.isArray(rows) ? rows[0] : null;
    if (!appt) return NO_DEPOSIT(c.headers);

    const store = getDataStore();

    /* already have a deposit going/paid for this appointment? don't double up. */
    const existing = await store.get(depositKey(slug, bookingId), { type: 'json' }).catch(() => null);
    if (existing && existing.status === 'paid') {
      return json(200, { ok: true, depositRequired: false, alreadyPaid: true }, c.headers);
    }

    const stylistEmail = String((appt.stylist && appt.stylist.email) || '').toLowerCase();

    /* Which account + which deposit settings? The stylist's login record carries
       payType; no record (or not 'independent') means commission → the salon. */
    let settings = null, payType = 'commission';
    if (stylistEmail) {
      const staffUser = await store.get(userKey(slug, stylistEmail), { type: 'json' }).catch(() => null);
      if (staffUser && staffUser.role !== 'admin' && isIndependent(staffUser)) {
        payType = 'independent';
        settings = await readStaffPayments(slug, stylistEmail);
      }
    }
    if (payType === 'commission') settings = await readPayments(slug);

    /* Gates — all resolve to no deposit, never an error. An independent with
       deposits on but no connected account gets NO deposit (we never fall back
       to charging the salon for an independent's client). */
    if (!settings || !settings.connectAccountId || !settings.chargesEnabled || !settings.depositEnabled) {
      return NO_DEPOSIT(c.headers);
    }

    const cents = depositCentsFor(settings, appt.price_cents);
    if (!cents) return NO_DEPOSIT(c.headers);

    const clientEmail = String(body.clientEmail || (appt.client && appt.client.email) || '').trim().slice(0, 254);
    const clientName = String(body.clientName || (appt.client && appt.client.name) || 'a booking').trim().slice(0, 120);
    const siteUrl = `https://salonvine.com/s/${slug}`;

    const session = await stripeFetch('checkout/sessions', {
      mode: 'payment',
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: cents,
          product_data: {
            name: `Booking deposit — ${registry.name || slug}`,
            description: 'Applied to the cost of your appointment.'
          }
        }
      }],
      payment_intent_data: {
        description: `Deposit for ${clientName} at ${registry.name || slug}`,
        metadata: { slug, bookingId, payType }
      },
      metadata: { slug, bookingId, kind: 'deposit', payType },
      customer_email: clientEmail || undefined,
      success_url: `${siteUrl}?deposit=paid&b=${encodeURIComponent(bookingId)}&cs={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}?deposit=cancelled`
    }, {
      account: settings.connectAccountId,
      /* one appointment, one deposit session — a double-tap or reload can't make two. */
      idempotencyKey: `dep_${slug}_${bookingId}`
    });

    await store.setJSON(depositKey(slug, bookingId), {
      status: 'pending',
      sessionId: session.id,
      account: settings.connectAccountId,
      payType,
      cents,
      stylistEmail,
      clientEmail,
      clientName,
      createdAt: Date.now()
    });

    return json(200, { ok: true, depositRequired: true, url: session.url, amountCents: cents }, c.headers);
  } catch (e) {
    /* A deposit hiccup must never cost the booking — it's already saved in
       Supabase. Tell the site to just confirm. */
    return NO_DEPOSIT(c.headers);
  }
};
