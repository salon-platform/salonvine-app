/* Owners & managers — handing a salon to a new owner, or adding a second
   owner-level login (a manager / co-owner). Owner (admin) only.

   GET  ?slug=                          -> { owners:[...], pending:[...] }
   POST { slug, action:'invite', kind:'manager'|'transfer', name, email }
   POST { slug, action:'cancel', email }   -> drop a pending invite
   POST { slug, action:'resend', email }   -> send the invite again
   POST { slug, action:'revoke', email }   -> remove another owner-level login

   MANAGER: the person gets an owner-level login alongside yours. You keep yours.
   TRANSFER: the person gets an owner-level login and, the moment she sets her
   password, the salon becomes hers — your login is removed, the salon's
   owner name/email change, and the salon's Stripe (deposits + checkout) is
   disconnected so she connects her own. Bookings, clients, team, menu and
   the website all stay exactly as they are. That last step lives in
   applyOwnership(), which set-password.js calls when an invite is accepted. */

import {
  cors, json, parseBody, normEmail,
  getDataStore, listJSON, userKey, usersPrefix,
  requireSalonSession, getSalonRegistry, seatLimitForPlan,
  newCode, welcomeLink, relayMail
} from './_lib.js';
import { readPayments, writePayments } from './_stripe.js';
import { sbReady, sbSalon, sbWrite } from './_supabase.js';

const s = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 200);

function inviteText(kind, name, salonName, fromName, link) {
  if (kind === 'transfer') {
    return `Hi ${name},\n\n${fromName} is handing the ${salonName} SalonVine account over to you. Once you set your password below, you become the owner: the booking site, calendar, clients, team and menu all carry over as they are, and ${fromName}'s login is closed.\n\nSet your password here:\n${link}\n\nTwo things to do once you're in: connect your own Stripe under Payments (deposits and checkout money go to you, not the previous owner), and check My plan so the subscription is in your name.`;
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
      return {
        ok: true,
        owners: admins.filter(u => u.active).map(u => ({ name: u.name, email: u.email, me: u.email === session.email, tookOverAt: u.tookOverAt || null })),
        pending: admins.filter(u => !u.active).map(u => ({ name: u.name, email: u.email, kind: (u.ownership && u.ownership.kind) || 'manager', sentAt: u.createdAt || null }))
      };
    }

    if (req.method === 'GET') return json(200, await payload(), c.headers);
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

    const action = s(body.action, 20);
    const email = normEmail(body.email);

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
