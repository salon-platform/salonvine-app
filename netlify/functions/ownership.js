/* Managers — a second owner-level login the owner hands out. Owner (admin) only.

   A MANAGER cannot use any of the POST actions here. She could otherwise
   remove the owner who hired her, or quietly add another manager. She can
   still read the list, so she knows who else has a login.

   GET  ?slug=                              -> { owners:[...], pending:[...] }
   POST { slug, action:'invite', name, email } -> emails an invite; she sets a password
   POST { slug, action:'cancel', email }      -> drop a pending invite
   POST { slug, action:'resend', email }      -> send the invite again
   POST { slug, action:'revoke', email }      -> remove another owner-level login

   Handing a salon to a NEW owner is not an invite: the owner changes the
   owner email on the Account screen (account.js) and the new person sets a
   password from there. */

import {
  cors, json, parseBody, normEmail,
  getDataStore, listJSON, userKey, usersPrefix,
  requireSalonSession, getSalonRegistry, seatLimitForPlan,
  newCode, welcomeLink, relayMail
} from './_lib.js';

const s = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 200);

function inviteText(name, salonName, fromName, link) {
  return `Hi ${name},\n\n${fromName} has added you as a manager on the ${salonName} SalonVine account. You get the full owner portal — calendar, clients, team, website, payments — alongside ${fromName}.\n\nSet your password here:\n${link}`;
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
    const meRec = await store.get(userKey(slug, session.email), { type: 'json' });
    const iAmManager = !!(meRec && meRec.manager);
    if (iAmManager && req.method === 'POST') {
      return json(403, {
        error: 'Only the salon owner can add or remove owner-level logins.'
      }, c.headers);
    }
    const registry = await getSalonRegistry(slug);
    const salonName = (registry && registry.name) || 'the salon';
    const plan = String((registry && registry.plan) || 'studio').toLowerCase();
    const limit = seatLimitForPlan(plan);

    async function payload() {
      const users = await listJSON(store, usersPrefix(slug));
      const admins = users.filter(u => u.role === 'admin');
      return {
        ok: true,
        youAreManager: iAmManager,
        owners: admins.filter(u => u.active).map(u => ({
          name: u.name, email: u.email, me: u.email === session.email, manager: !!u.manager
        })),
        pending: admins.filter(u => !u.active).map(u => ({ name: u.name, email: u.email, sentAt: u.createdAt || null }))
      };
    }

    if (req.method === 'GET') return json(200, await payload(), c.headers);
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

    const action = s(body.action, 20);
    const email = normEmail(body.email);

    if (action === 'invite') {
      const name = s(body.name, 80);
      if (!name || !email) return json(400, { error: 'Name and email are both required.' }, c.headers);
      if (email === session.email) return json(400, { error: "That's your own login." }, c.headers);
      const existing = await store.get(userKey(slug, email), { type: 'json' });
      if (existing && existing.active) return json(409, { error: 'That email already has a login here. Remove it first if you want to re-invite.' }, c.headers);
      if (limit !== null && !existing) {
        const current = await listJSON(store, usersPrefix(slug));
        if (current.length >= limit) return json(409, { error: `Your plan includes ${limit} seats and all ${limit} are in use. Remove a team member to free a seat, or upgrade.` }, c.headers);
      }
      const inviteCode = newCode(6);
      await store.setJSON(userKey(slug, email), {
        email, name, phone: '', role: 'admin', active: false, inviteCode, createdAt: Date.now(),
        manager: { addedBy: session.email, at: Date.now() }
      });
      const link = welcomeLink(slug, inviteCode, email);
      const sent = await relayMail({ to: email, subject: `You've been added as a manager at ${salonName}`, text: inviteText(name, salonName, session.name || 'The owner', link) });
      return json(200, { ...(await payload()), emailSent: !!(sent && sent.ok), link: sent && sent.ok ? undefined : link }, c.headers);
    }

    if (action === 'resend' || action === 'cancel') {
      if (!email) return json(400, { error: 'Invalid email.' }, c.headers);
      const u = await store.get(userKey(slug, email), { type: 'json' });
      if (!u || u.role !== 'admin' || u.active) return json(404, { error: 'No pending manager invite for that email.' }, c.headers);
      if (action === 'cancel') { await store.delete(userKey(slug, email)); return json(200, await payload(), c.headers); }
      const link = welcomeLink(slug, u.inviteCode, email);
      const sent = await relayMail({ to: email, subject: `You've been added as a manager at ${salonName}`, text: inviteText(u.name, salonName, session.name || 'The owner', link) });
      return json(200, { ...(await payload()), emailSent: !!(sent && sent.ok), link: sent && sent.ok ? undefined : link }, c.headers);
    }

    if (action === 'revoke') {
      if (!email) return json(400, { error: 'Invalid email.' }, c.headers);
      if (email === session.email) return json(400, { error: "You can't remove your own login." }, c.headers);
      const u = await store.get(userKey(slug, email), { type: 'json' });
      if (!u || u.role !== 'admin') return json(404, { error: 'No owner-level login with that email.' }, c.headers);
      await store.delete(userKey(slug, email));
      return json(200, await payload(), c.headers);
    }

    return json(400, { error: 'Unknown action.' }, c.headers);
  } catch (e) {
    return json(500, { error: `Managers hit a snag: ${String((e && e.message) || e).slice(0, 160)}` }, c.headers);
  }
};
