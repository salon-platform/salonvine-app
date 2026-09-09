/* Account — the owner's own settings. Owner (admin) only.

   GET  ?slug=  -> { owner:{name,email}, stripe:{connected, accountId, chargesEnabled}, billing:{status, ownerEmail, hasPortal} }
   POST { slug, action:'owner', name, email }
        A new email hands the login over: the new address gets a "set your
        password" email, the old login stops working, the salon's owner
        name/email follow. Same email = just renames.
   POST { slug, action:'password', current, next }
   POST { slug, action:'stripe-disconnect' }
        Detaches the salon's Stripe (deposits + checkout). The Payments screen
        then offers "Set up deposits with Stripe" again for a new account.
   The SalonVine subscription card is changed in Stripe's own billing page
   (billing-portal.js), linked from the same screen. */

import {
  cors, json, parseBody, normEmail,
  getDataStore, userKey, requireSalonSession, getSalonRegistry,
  hashPassword, verifyPassword, newCode, welcomeLink, relayMail
} from './_lib.js';
import { readPayments, writePayments, readBilling, writeBilling } from './_stripe.js';
import { sbReady, sbSalon, sbWrite } from './_supabase.js';

const s = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 200);

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
    const me = await store.get(userKey(slug, session.email), { type: 'json' });
    if (!me) return json(401, { error: 'Your login could not be found — sign in again.' }, c.headers);

    async function payload() {
      const pay = (await readPayments(slug)) || {};
      const bill = (await readBilling(slug)) || {};
      return {
        ok: true,
        owner: { name: me.name || '', email: me.email },
        stripe: { connected: !!pay.connectAccountId, accountId: pay.connectAccountId ? String(pay.connectAccountId).slice(-6) : '', chargesEnabled: !!pay.chargesEnabled },
        billing: { status: bill.status || 'none', ownerEmail: bill.ownerEmail || '', hasPortal: !!bill.customerId }
      };
    }

    if (req.method === 'GET') return json(200, await payload(), c.headers);
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);
    const action = s(body.action, 24);

    /* ---- name / email (a new email = handover) ---- */
    if (action === 'owner') {
      const name = s(body.name, 80) || me.name;
      const email = normEmail(body.email);
      if (!email) return json(400, { error: 'Enter a valid email.' }, c.headers);
      const registry = await getSalonRegistry(slug);
      const salonName = (registry && registry.name) || 'your salon';

      if (email === me.email) {
        await store.setJSON(userKey(slug, me.email), { ...me, name });
        if (sbReady()) { try { const salon = await sbSalon(slug); if (salon) await sbWrite('salon', 'update', `id=eq.${salon.id}`, { owner_name: name }); } catch (e) {} }
        return json(200, { ...(await payload()), renamed: true }, c.headers);
      }

      const clash = await store.get(userKey(slug, email), { type: 'json' });
      if (clash) return json(409, { error: 'That email already has a login at this salon. Remove it first (Staff), then try again.' }, c.headers);

      const inviteCode = newCode(6);
      await store.setJSON(userKey(slug, email), {
        ...me, email, name, active: false, inviteCode, salt: null, hash: null,
        previousEmail: me.email, ownerChangedAt: Date.now()
      });
      await store.delete(userKey(slug, me.email)).catch(() => {});
      if (sbReady()) { try { const salon = await sbSalon(slug); if (salon) await sbWrite('salon', 'update', `id=eq.${salon.id}`, { owner_email: email, owner_name: name }); } catch (e) { console.error('account: salon owner update failed', e.message); } }
      try { const bill = await readBilling(slug); if (bill) await writeBilling(slug, { ...bill, ownerEmail: email }); } catch (e) {}

      const link = welcomeLink(slug, inviteCode, email);
      const sent = await relayMail({
        to: email,
        subject: `${salonName} on SalonVine — set your password`,
        text: `Hi ${name},\n\nThe ${salonName} owner account on SalonVine is now under this email address. Set your password here to get in:\n${link}\n\nOnce you're in: Account > Stripe if the salon's deposits/checkout should go to a different Stripe account, and Account > Subscription to put the SalonVine plan on your own card.`
      });
      return json(200, { ok: true, handedOver: true, email, emailSent: !!(sent && sent.ok), link: sent && sent.ok ? undefined : link }, c.headers);
    }

    /* ---- password ---- */
    if (action === 'password') {
      const current = String(body.current || ''), next = String(body.next || '');
      if (!verifyPassword(current, me.salt, me.hash)) return json(403, { error: 'Current password is not right.' }, c.headers);
      if (next.length < 8) return json(400, { error: 'New password must be at least 8 characters.' }, c.headers);
      const { salt, hash } = hashPassword(next);
      await store.setJSON(userKey(slug, me.email), { ...me, salt, hash, passwordChangedAt: Date.now() });
      return json(200, { ok: true }, c.headers);
    }

    /* ---- stripe (deposits & checkout) ---- */
    if (action === 'stripe-disconnect') {
      const pay = (await readPayments(slug)) || {};
      if (!pay.connectAccountId) return json(200, await payload(), c.headers);
      await writePayments(slug, {
        ...pay, connectAccountId: null, chargesEnabled: false, detailsSubmitted: false, depositEnabled: false,
        previous: [ ...(pay.previous || []), { connectAccountId: pay.connectAccountId, detachedAt: Date.now(), by: session.email } ].slice(-5)
      });
      return json(200, await payload(), c.headers);
    }

    return json(400, { error: 'Unknown action.' }, c.headers);
  } catch (e) {
    return json(500, { error: `Account hit a snag: ${String((e && e.message) || e).slice(0, 160)}` }, c.headers);
  }
};
