/* Server-to-server owner provisioning, called by the Apps Script registry
   (backend v4.1+) right after ANY signup lands — including signups from the
   legacy marketing page that still posts type:'signupSite' directly.
   Closes the funnel gap: every signup gets an owner account + invite +
   (via the portal) the 30-day trial checkout, no matter which version of
   signup.html the marketing site is serving.
   Auth: full backend token in the body. No CORS — not a browser endpoint. */

import {
  json, parseBody, normSlug, normEmail,
  getDataStore, userKey, newCode, welcomeLink, relayMail
} from './_lib.js';

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const body = await parseBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });

  if (!process.env.SV_TOKEN || body.token !== process.env.SV_TOKEN) {
    return json(403, { error: 'Forbidden' });
  }

  const slug = normSlug(body.slug);
  const email = normEmail(body.email);
  const name = String(body.name || '').trim().slice(0, 80);
  const salon = String(body.salon || '').trim().slice(0, 120) || slug;
  const phone = String(body.phone || '').replace(/[^\d+() .-]/g, '').slice(0, 20);
  const siteUrl = String(body.url || '').slice(0, 300);
  if (!slug || !email) return json(400, { error: 'Need slug and email.' });

  try {
    const store = getDataStore();
    const existing = await store.get(userKey(slug, email), { type: 'json' });

    let inviteCode;
    if (existing && existing.active) {
      return json(200, { ok: true, alreadyActive: true });
    } else if (existing && existing.inviteCode) {
      inviteCode = existing.inviteCode; // resend path
    } else {
      inviteCode = newCode(6);
      await store.setJSON(userKey(slug, email), {
        email, name: name || salon, phone, role: 'admin',
        active: false, inviteCode, createdAt: Date.now()
      });
    }

    const link = welcomeLink(slug, inviteCode, email);
    await relayMail({
      to: email,
      subject: `${salon} is live — set up your Salon Vine portal`,
      text: `Hi ${name || 'there'},\n\nYour site is live${siteUrl ? ': ' + siteUrl : ''}\n\nNext, set the password for your owner portal — that's where bookings land and where you add your stylists:\n${link}\n\nTap the link, choose a password, and you're in. From the portal you can invite your team; each stylist gets her own login. Add the portal to your phone's home screen and it works like an app.\n\n— Salon Vine`
    });
    if (phone) {
      await relayMail({
        sms: { phone },
        text: `Salon Vine: ${salon} is live! Set your portal password here: ${link}`
      }).catch(() => null);
    }

    return json(200, { ok: true, invited: true });
  } catch (e) {
    return json(500, { error: 'Provisioning failed.' });
  }
};
