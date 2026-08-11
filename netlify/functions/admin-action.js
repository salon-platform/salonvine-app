/* Founder console — everything that CHANGES something.

   POST {action, ...}. Founder cookie required. Every action is audited
   before it returns, and impersonation additionally emails both founders.

   Deliberately NOT here:
   - Reading or resetting a salon's password. Passwords are PBKDF2 hashes; we
     cannot read them and should not be able to set them. Support enters a
     salon by impersonation, which is time-boxed and visible to the salon.
   - Changing a plan directly. Plan and Stripe subscription have to move
     together or billing silently diverges from entitlements. That belongs in
     the Stripe customer page, which this returns a deep link to. */

import {
  cors, json, parseBody, normSlug, normEmail, getDataStore,
  userKey, usersPrefix, listJSON, getSalonRegistry, setCookieHeader, APP_URL
} from './_lib.js';
import { readBilling } from './_stripe.js';
import { requireFounder, audit, alertFounders, mintImpersonation, IMPERSONATION_TTL_MS } from './_admin.js';

async function registryPost(type, extra) {
  const exec = process.env.SV_EXEC;
  const token = process.env.SV_TOKEN;
  if (!exec || !token) return { ok: false, error: 'registry not configured' };
  try {
    const res = await fetch(exec, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token, type, ...extra }),
      redirect: 'follow'
    });
    return (await res.json().catch(() => null)) || { ok: false, error: 'bad registry response' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const guard = requireFounder(req, c.headers);
  if (guard.errorResponse) return guard.errorResponse;
  const founder = guard.founder;

  const body = await parseBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const action = String(body.action || '');
  const slug = normSlug(body.slug);
  if (!slug && action !== 'note') return json(400, { error: 'Missing salon.' }, c.headers);

  try {
    /* ---------- enter a salon to fix something ---------- */
    if (action === 'impersonate') {
      const registry = await getSalonRegistry(slug);
      if (!registry) return json(404, { error: 'Salon not found.' }, c.headers);

      /* Prefer a real admin on the account so the portal behaves exactly as
         the owner sees it, quirks included. */
      const users = await listJSON(getDataStore(), usersPrefix(slug)).catch(() => []);
      const target = users.find(u => u && u.role === 'admin' && u.active)
        || users.find(u => u && u.role === 'admin')
        || null;
      if (!target) {
        return json(409, {
          error: 'This salon has no owner account yet — send the owner invite first, then impersonate.'
        }, c.headers);
      }

      const token = mintImpersonation(slug, target.email, target.name, founder.email);
      await audit(founder.email, 'salon.impersonate', {
        slug, as: target.email, minutes: IMPERSONATION_TTL_MS / 60000
      });
      await alertFounders(
        `Support session opened: ${registry.name || slug}`,
        `${founder.email} opened a ${IMPERSONATION_TTL_MS / 60000}-minute support session inside ${registry.name || slug} (${slug}) as ${target.email}.\n\n` +
        `The salon sees a banner while this is active. If this was not one of you, remove the address from FOUNDER_EMAILS in Netlify now.`
      );

      /* Sets the normal portal cookie — this browser IS the salon until it
         expires or the founder signs out of the portal. */
      return json(200, {
        ok: true,
        portalUrl: `${APP_URL}/p/${encodeURIComponent(slug)}`,
        as: target.email,
        expiresInMinutes: IMPERSONATION_TTL_MS / 60000
      }, { ...c.headers, 'Set-Cookie': setCookieHeader(token) });
    }

    /* ---------- resend the owner's invite ---------- */
    if (action === 'resend-owner-invite') {
      const registry = await getSalonRegistry(slug);
      if (!registry) return json(404, { error: 'Salon not found.' }, c.headers);
      const email = normEmail(body.email || registry.email);
      if (!email) return json(400, { error: 'No owner email on file for this salon.' }, c.headers);

      const res = await fetch(`${APP_URL}/.netlify/functions/provision-owner`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: process.env.SV_TOKEN,
          slug, email,
          name: registry.owner || '',
          phone: registry.phone || '',
          salon: registry.name || slug,
          url: registry.url || ''
        })
      }).then(r => r.json()).catch(() => null);

      await audit(founder.email, 'salon.resend_invite', { slug, email, result: res });
      if (res && res.ok) return json(200, { ok: true, result: res }, c.headers);
      return json(502, { error: 'Could not send the invite.', result: res }, c.headers);
    }

    /* ---------- suspend / reactivate the public site ---------- */
    if (action === 'suspend' || action === 'reactivate') {
      const status = action === 'suspend' ? 'suspended' : 'live';
      const res = await registryPost('salonStatus', { slug, status });
      await audit(founder.email, `salon.${action}`, { slug, result: res });
      if (res && res.ok) return json(200, { ok: true, status }, c.headers);
      return json(502, { error: `Registry rejected the change: ${res && res.error}` }, c.headers);
    }

    /* ---------- deep links out to Stripe ---------- */
    if (action === 'stripe-links') {
      const billing = await readBilling(slug);
      if (!billing) return json(404, { error: 'This salon has no billing record yet.' }, c.headers);
      const base = 'https://dashboard.stripe.com';
      await audit(founder.email, 'salon.stripe_links', { slug });
      return json(200, {
        ok: true,
        customer: billing.customerId ? `${base}/customers/${billing.customerId}` : '',
        subscription: billing.subscriptionId ? `${base}/subscriptions/${billing.subscriptionId}` : ''
      }, c.headers);
    }

    /* ---------- support note against a salon ---------- */
    if (action === 'note') {
      const text = String(body.text || '').trim().slice(0, 2000);
      if (!text) return json(400, { error: 'Write something first.' }, c.headers);
      const entry = await audit(founder.email, 'note', { slug: slug || '', text });
      return json(200, { ok: true, entry }, c.headers);
    }

    /* ---------- clear a stuck invite so the owner can be re-invited ------- */
    if (action === 'reset-invite') {
      const email = normEmail(body.email);
      if (!email) return json(400, { error: 'Which user?' }, c.headers);
      const store = getDataStore();
      const user = await store.get(userKey(slug, email), { type: 'json' });
      if (!user) return json(404, { error: 'No such user on this salon.' }, c.headers);
      if (user.active) {
        return json(409, { error: 'That account is already active — resetting its invite would lock them out. Use impersonate instead.' }, c.headers);
      }
      await store.setJSON(userKey(slug, email), { ...user, inviteCode: null });
      await audit(founder.email, 'user.reset_invite', { slug, email });
      return json(200, { ok: true }, c.headers);
    }

    return json(400, { error: `Unknown action: ${action}` }, c.headers);
  } catch (e) {
    return json(500, { error: String((e && e.message) || e) }, c.headers);
  }
};
