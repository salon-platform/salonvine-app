/* Owners & managers — handing a salon to a new owner, or adding a second
   owner-level login (a manager / co-owner). Owner (admin) only.

   GET  ?slug=                          -> { owners:[...], pending:[...] }
   POST { slug, action:'invite', kind:'manager'|'transfer', name, email }
   POST { slug, action:'cancel', email }   -> drop a pending invite
   POST { slug, action:'resend', email }   -> send the invite again
   POST { slug, action:'revoke', email }   -> remove another owner-level login

   MANAGER: the person gets an owner-level login alongside yours. You keep yours.
   TRANSFER: the person gets an owner-level login; after she sets her password
   the portal asks her for a card for the SalonVine subscription (Stripe
   Checkout, no trial). The moment that goes through, the salon becomes hers:
   the old subscription is cancelled, your login is removed, the salon's
   owner name/email change, and the salon's Stripe (deposits + checkout) is
   disconnected so she connects her own. Bookings, clients, team, menu and
   the website all stay exactly as they are. completeTakeover() does that
   last part; stripe-webhook.js calls it when the checkout completes. */

import {
  cors, json, parseBody, normEmail,
  getDataStore, listJSON, userKey, usersPrefix,
  requireSalonSession, getSalonRegistry, seatLimitForPlan,
  newCode, welcomeLink, relayMail
} from './_lib.js';
import { readPayments, writePayments, readBilling, stripeConfigured, stripeFetch, priceFor } from './_stripe.js';
import { sbReady, sbSalon, sbWrite } from './_supabase.js';
import { APP_URL } from './_lib.js';

const s = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 200);

function inviteText(kind, name, salonName, fromName, link) {
  if (kind === 'transfer') {
    return `Hi ${name},\n\n${fromName} is handing the ${salonName} SalonVine account over to you. Set your password below, then add a card for the SalonVine subscription — the moment that's done you become the owner: the booking site, calendar, clients, team and menu all carry over as they are, and ${fromName}'s login is closed.\n\nSet your password here:\n${link}\n\nOnce you're in, connect your own Stripe under Payments so deposits and checkout money go to you, not the previous owner.`;
  }
  return `Hi ${name},\n\n${fromName} has added you as a manager on the ${salonName} SalonVine account. You get the full owner portal — calendar, clients, team, website, payments — alongside ${fromName}.\n\nSet your password here:\n${link}`;
}

/* Called when an invited owner-level login sets her password. */
export async function applyOwnership(store, slug, user) {
  const own = user && user.ownership;
  if (!own || own.kind !== 'transfer') return { applied: false };
  const notes = [];
  /* 1. the previous owner's login goes away */
  const prev = normEmail(own.from);
  if (prev && prev !== normEmail(user.email)) {
    await store.delete(userKey(slug, prev)).catch(() => {});
    notes.push('previous owner removed');
  }
  /* 2. the salon record says it's hers now */
  if (sbReady()) {
    try {
      const salon = await sbSalon(slug);
      if (salon) { await sbWrite('salon', 'update', `id=eq.${salon.id}`, { owner_email: user.email, owner_name: user.name || '' }); notes.push('salon owner updated'); }
    } catch (e) { console.error('ownership: salon owner update failed', e.message); }
  }
  /* 3. money: the old Stripe connection is detached so she sets up her own */
  try {
    const pay = (await readPayments(slug)) || {};
    if (pay.connectAccountId) {
      await writePayments(slug, {
        ...pay, connectAccountId: null, chargesEnabled: false, detailsSubmitted: false, depositEnabled: false,
        previousOwner: { email: prev, connectAccountId: pay.connectAccountId, detachedAt: Date.now() }
      });
      notes.push('stripe detached');
    }
  } catch (e) { console.error('ownership: payments detach failed', e.message); }
  /* 4. the invite record itself: remember what happened, drop the trigger */
  await store.setJSON(userKey(slug, user.email), { ...user, ownership: null, tookOverAt: Date.now(), tookOverFrom: prev });
  return { applied: true, notes };
}

/* Stripe Checkout for the new owner's card. No trial — the salon is already
   live. metadata.takeover carries her email so the webhook knows what to do. */
async function takeoverCheckout(slug, user, registry) {
  if (!stripeConfigured()) throw new Error('Billing is not switched on yet.');
  const plan = String((registry && registry.plan) || 'studio').toLowerCase();
  const price = priceFor(plan, 'monthly');
  if (!price) throw new Error('No price is set up for this plan yet.');
  const session = await stripeFetch('checkout/sessions', {
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    subscription_data: { metadata: { slug, takeover: user.email } },
    metadata: { slug, takeover: user.email },
    customer_email: user.email,
    allow_promotion_codes: true,
    success_url: `${APP_URL}/p/${slug}?takeover=done`,
    cancel_url: `${APP_URL}/p/${slug}?takeover=cancelled`
  });
  return session.url;
}

/* Called by the webhook when the new owner's checkout completes. */
export async function completeTakeover(store, slug, email, previousSubscriptionId) {
  const user = await store.get(userKey(slug, normEmail(email)), { type: 'json' });
  if (!user || !user.ownership || user.ownership.kind !== 'transfer') return { applied: false, why: 'no pending transfer' };
  /* the previous owner's SalonVine subscription ends now */
  if (previousSubscriptionId) {
    try {
      const key = process.env.STRIPE_SECRET_KEY;
      await fetch(`https://api.stripe.com/v1/subscriptions/${previousSubscriptionId}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${key}` } });
    } catch (e) { console.error('ownership: could not cancel previous subscription', e.message); }
  }
  return applyOwnership(store, slug, user);
}

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  const qs = new URL(req.url).searchParams;
  const body = req.method === 'POST' ? await parseBody(req) : null;
  if (req.method === 'POST' && !body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const auth = requireSalonSession(req, body ? body.slug : qs.get('slug'), c.headers);
  if (auth.errorResponse) return auth.errorResponse;
  const { session, slug } = auth;
  if (session.role !== 'admin') return json(403, { error: 'Owner access only.' }, c.headers);

  try {
    const store = getDataStore();
    const registry = await getSalonRegistry(slug);
    const salonName = (registry && registry.name) || 'the salon';
    const plan = String((registry && registry.plan) || 'studio').toLowerCase();
    const limit = seatLimitForPlan(plan);

    async function payload() {
      const users = await listJSON(store, usersPrefix(slug));
      const admins = users.filter(u => u.role === 'admin');
      const meRec = users.find(u => u.email === session.email);
      const pendingTakeover = !!(meRec && meRec.ownership && meRec.ownership.kind === 'transfer');
      return {
        ok: true,
        takeover: pendingTakeover ? { pending: true, from: meRec.ownership.fromName || meRec.ownership.from || '', salonName } : null,
        owners: admins.filter(u => u.active).map(u => ({ name: u.name, email: u.email, me: u.email === session.email, tookOverAt: u.tookOverAt || null })),
        pending: admins.filter(u => !u.active).map(u => ({ name: u.name, email: u.email, kind: (u.ownership && u.ownership.kind) || 'manager', sentAt: u.createdAt || null }))
      };
    }

    if (req.method === 'GET') return json(200, await payload(), c.headers);
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

    const action = s(body.action, 20);
    const email = normEmail(body.email);

    if (action === 'checkout') {
      const meRec = await store.get(userKey(slug, session.email), { type: 'json' });
      if (!meRec || !meRec.ownership || meRec.ownership.kind !== 'transfer') return json(400, { error: 'There is no handover waiting on you.' }, c.headers);
      try { const url = await takeoverCheckout(slug, meRec, registry); return json(200, { ok: true, url }, c.headers); }
      catch (e) { return json(502, { error: String(e.message || e).slice(0, 160) }, c.headers); }
    }

    if (action === 'invite') {
      const kind = body.kind === 'transfer' ? 'transfer' : 'manager';
      const name = s(body.name, 80);
      if (!name || !email) return json(400, { error: 'Name and email are both required.' }, c.headers);
      if (email === session.email) return json(400, { error: "That's your own login." }, c.headers);
      const existing = await store.get(userKey(slug, email), { type: 'json' });
      if (existing && existing.active) return json(409, { error: 'That email already has a login here. Remove it first if you want to re-invite.' }, c.headers);
      if (kind === 'manager' && limit !== null) {
        const current = await listJSON(store, usersPrefix(slug));
        if (current.length >= limit && !existing) {
          return json(409, { error: `Your plan includes ${limit} seats and all ${limit} are in use. Remove a team member to free a seat, or upgrade.` }, c.headers);
        }
      }
      const inviteCode = newCode(6);
      await store.setJSON(userKey(slug, email), {
        email, name, phone: '', role: 'admin', active: false, inviteCode, createdAt: Date.now(),
        ownership: { kind, from: session.email, fromName: session.name || '', at: Date.now() }
      });
      const link = welcomeLink(slug, inviteCode, email);
      const sent = await relayMail({
        to: email,
        subject: kind === 'transfer' ? `${salonName} on SalonVine is being handed to you` : `You've been added as a manager at ${salonName}`,
        text: inviteText(kind, name, salonName, session.name || 'The owner', link)
      });
      return json(200, { ...(await payload()), emailSent: !!(sent && sent.ok), link: sent && sent.ok ? undefined : link }, c.headers);
    }

    if (action === 'resend' || action === 'cancel') {
      if (!email) return json(400, { error: 'Invalid email.' }, c.headers);
      const u = await store.get(userKey(slug, email), { type: 'json' });
      if (!u || u.role !== 'admin' || u.active) return json(404, { error: 'No pending owner invite for that email.' }, c.headers);
      if (action === 'cancel') { await store.delete(userKey(slug, email)); return json(200, await payload(), c.headers); }
      const kind = (u.ownership && u.ownership.kind) || 'manager';
      const link = welcomeLink(slug, u.inviteCode, email);
      const sent = await relayMail({ to: email, subject: kind === 'transfer' ? `${salonName} on SalonVine is being handed to you` : `You've been added as a manager at ${salonName}`, text: inviteText(kind, u.name, salonName, session.name || 'The owner', link) });
      return json(200, { ...(await payload()), emailSent: !!(sent && sent.ok), link: sent && sent.ok ? undefined : link }, c.headers);
    }

    if (action === 'revoke') {
      if (!email) return json(400, { error: 'Invalid email.' }, c.headers);
      if (email === session.email) return json(400, { error: "You can't remove your own login. Hand the salon to someone else instead." }, c.headers);
      const u = await store.get(userKey(slug, email), { type: 'json' });
      if (!u || u.role !== 'admin') return json(404, { error: 'No owner-level login with that email.' }, c.headers);
      await store.delete(userKey(slug, email));
      return json(200, await payload(), c.headers);
    }

    return json(400, { error: 'Unknown action.' }, c.headers);
  } catch (e) {
    return json(500, { error: `Owners hit a snag: ${String((e && e.message) || e).slice(0, 160)}` }, c.headers);
  }
};
