/* Team management — admin (owner) only. Seat limits come from the salon's plan
   in the registry and are enforced server-side: over-limit salons keep every
   existing user working, but new adds are blocked until a seat frees up. */

import {
  cors, json, parseBody, normSlug, normEmail,
  getDataStore, listJSON, userKey, usersPrefix,
  requireSalonSession, getSalonRegistry, seatLimitForPlan,
  newCode, welcomeLink, relayMail
} from './_lib.js';

function inviteEmailText(name, salonName, link) {
  return `Hi ${name},\n\nYou've been added to the ${salonName} team portal — that's where your bookings will show up the moment a client books you.\n\nSet your password here:\n${link}\n\nTap the link, choose a password, and you're in. Once you're logged in, add the page to your phone's home screen so it opens like an app from then on (the page shows you exactly how).`;
}
function inviteSmsText(salonName, link) {
  return `${salonName}: You've been invited to the team portal. Set your password here: ${link} — after logging in, add it to your home screen so it works like an app.`;
}

export default async (req, context) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;

  /* A request body can only be read once — parse it here and reuse it below. */
  const parsedBody = req.method === 'GET' ? null : await parseBody(req);
  const requestedSlug = req.method === 'GET'
    ? new URL(req.url).searchParams.get('slug')
    : ((parsedBody || {}).slug);

  const auth = requireSalonSession(req, requestedSlug, c.headers);
  if (auth.errorResponse) return auth.errorResponse;
  const { session, slug } = auth;
  if (session.role !== 'admin') return json(403, { error: 'Owner access only.' }, c.headers);

  try {
    const store = getDataStore();

    const registry = await getSalonRegistry(slug);
    const plan = String((registry && registry.plan) || 'studio').toLowerCase();
    const salonName = (registry && registry.name) || 'the salon';
    const limit = seatLimitForPlan(plan);

    async function teamPayload() {
      const users = await listJSON(store, usersPrefix(slug));
      users.sort((a, b) => (a.role === b.role ? (a.createdAt || 0) - (b.createdAt || 0) : (a.role === 'admin' ? -1 : 1)));
      return {
        team: users.map(u => ({
          name: u.name, email: u.email, phone: u.phone || '',
          role: u.role, active: !!u.active
        })),
        seats: { used: users.length, limit, plan }
      };
    }

    if (req.method === 'GET') {
      return json(200, { ok: true, ...(await teamPayload()) }, c.headers);
    }

    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);
    const body = parsedBody;
    if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

    /* ---------- remove ---------- */
    if (body.action === 'remove') {
      const email = normEmail(body.email);
      if (!email) return json(400, { error: 'Invalid email.' }, c.headers);
      if (email === session.email) return json(400, { error: "You can't remove your own account." }, c.headers);
      const target = await store.get(userKey(slug, email), { type: 'json' });
      if (!target) return json(404, { error: 'No team member with that email.' }, c.headers);
      if (target.role === 'admin') return json(403, { error: "Owner accounts can't be removed here." }, c.headers);
      await store.delete(userKey(slug, email));
      return json(200, { ok: true, ...(await teamPayload()) }, c.headers);
    }

    /* ---------- bulk remove (select-all) ---------- */
    if (body.action === 'bulkRemove') {
      const emails = Array.isArray(body.emails) ? body.emails.map(normEmail).filter(Boolean) : [];
      if (!emails.length) return json(400, { error: 'Nothing selected.' }, c.headers);
      let removed = 0;
      const skipped = [];
      for (const email of emails) {
        if (email === session.email) { skipped.push(email); continue; }  // never remove yourself
        const target = await store.get(userKey(slug, email), { type: 'json' });
        if (!target) continue;
        if (target.role === 'admin') { skipped.push(email); continue; }  // never bulk-remove an owner
        await store.delete(userKey(slug, email));
        removed++;
      }
      return json(200, { ok: true, removed, skipped, ...(await teamPayload()) }, c.headers);
    }

    /* ---------- resend invite ---------- */
    if (body.action === 'resend') {
      const email = normEmail(body.email);
      if (!email) return json(400, { error: 'Invalid email.' }, c.headers);
      const user = await store.get(userKey(slug, email), { type: 'json' });
      if (!user || user.active || !user.inviteCode) {
        return json(404, { error: 'No pending invite for that email.' }, c.headers);
      }
      const link = welcomeLink(slug, user.inviteCode, email);
      const emailResult = await relayMail({
        to: email,
        subject: `You're invited to the ${salonName} staff portal`,
        text: inviteEmailText(user.name, salonName, link)
      });
      let textResult = { ok: false };
      if (user.phone) {
        textResult = await relayMail({ sms: { phone: user.phone }, text: inviteSmsText(salonName, link) });
      }
      return json(200, { ok: true, emailSent: emailResult.ok, textSent: textResult.ok, inviteLink: link }, c.headers);
    }

    /* ---------- add ---------- */
    const name = String(body.name || '').trim().slice(0, 80);
    const email = normEmail(body.email);
    const phone = String(body.phone || '').replace(/[^\d+() .-]/g, '').slice(0, 20);
    if (!name || !email) return json(400, { error: 'Name and email are both required.' }, c.headers);

    const existing = await store.get(userKey(slug, email), { type: 'json' });
    if (existing) return json(409, { error: 'That email is already on the team.' }, c.headers);

    // Seat check — the owner counts as a seat.
    const current = await listJSON(store, usersPrefix(slug));
    if (limit !== null && current.length >= limit) {
      const planLabel = plan.charAt(0).toUpperCase() + plan.slice(1);
      return json(409, {
        error: `Your ${planLabel} plan includes ${limit} seats and all ${limit} are in use. Remove a team member to free a seat, or upgrade your plan at salonvine.com.`,
        seats: { used: current.length, limit, plan }
      }, c.headers);
    }

    const inviteCode = newCode(6);
    await store.setJSON(userKey(slug, email), {
      email, name, phone, role: 'stylist',
      active: false, inviteCode, createdAt: Date.now()
    });

    const link = welcomeLink(slug, inviteCode, email);
    const emailResult = await relayMail({
      to: email,
      subject: `You're invited to the ${salonName} staff portal`,
      text: inviteEmailText(name, salonName, link)
    });
    let textResult = { ok: false };
    if (phone) {
      textResult = await relayMail({ sms: { phone }, text: inviteSmsText(salonName, link) });
    }

    return json(200, {
      ok: true, inviteLink: link,
      emailSent: emailResult.ok, textSent: textResult.ok,
      ...(await teamPayload())
    }, c.headers);
  } catch (e) {
    return json(500, { error: 'Something went wrong. Try again.' }, c.headers);
  }
};
