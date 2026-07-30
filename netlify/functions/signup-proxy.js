/* New-salon signup. Called from salonvine.com (CORS-allowed).
   1. Forwards the signup to the Apps Script registry (type:'signupSite') with
      SV_SIGNUP_TOKEN added server-side — the token never ships to a browser.
   2. Creates the owner's portal account (inactive, invite-coded) under
      s/<slug>/users/ and relays a set-password invite email (+ text).
   3. Pings the founders. Returns {ok, slug, url}. */

const {
  cors, json, parseBody, normSlug, normEmail,
  getDataStore, userKey, newCode, welcomeLink, relayMail
} = require('./_lib');

const PLANS = ['studio', 'pro', 'elite'];

exports.handler = async (event) => {
  const c = cors(event);
  if (c.preflight) return c.preflight;
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = parseBody(event);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const salon = String(body.salon || '').trim().slice(0, 120);
  const name = String(body.name || '').trim().slice(0, 80);
  const email = normEmail(body.email);
  const phone = String(body.phone || '').replace(/[^\d+() .-]/g, '').slice(0, 20);
  const website = String(body.website || '').trim().slice(0, 200);
  const plan = PLANS.indexOf(String(body.plan || '').toLowerCase()) !== -1
    ? String(body.plan).toLowerCase() : 'studio';

  if (!salon || !email) return json(400, { error: 'Salon name and email are required.' }, c.headers);

  const exec = process.env.SV_EXEC;
  const signupToken = process.env.SV_SIGNUP_TOKEN;
  if (!exec || !signupToken) return json(500, { error: 'Signup is not configured yet.' }, c.headers);

  try {
    /* 1) register with the source of truth */
    let reg;
    try {
      const res = await fetch(exec, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          token: signupToken, type: 'signupSite',
          salon, name, email, phone, website, plan,
          slug: String(body.slug || '').slice(0, 80),
          theme: String(body.theme || '').slice(0, 60),
          accent: String(body.accent || '').slice(0, 20),
          tagline: String(body.tagline || '').slice(0, 200),
          services: body.services, hours: body.hours, instagram: body.instagram
        }),
        redirect: 'follow'
      });
      reg = await res.json().catch(() => null);
    } catch (e) {
      reg = null;
    }
    if (!reg || !reg.ok || !reg.slug) {
      return json(502, { error: (reg && reg.error) || 'Could not create your site right now. Try again in a minute.' }, c.headers);
    }

    const slug = normSlug(reg.slug);
    if (!slug) return json(502, { error: 'Signup succeeded but returned a bad site address. Contact support.' }, c.headers);

    /* 2) owner portal account (inactive until she sets a password) */
    const store = getDataStore();
    const existing = await store.get(userKey(slug, email), { type: 'json' });

    let inviteCode;
    if (existing && existing.active) {
      inviteCode = null; // already set up — nothing to invite
    } else if (existing && existing.inviteCode) {
      inviteCode = existing.inviteCode; // retry — reuse the pending invite
    } else {
      inviteCode = newCode(6);
      await store.setJSON(userKey(slug, email), {
        email, name: name || salon, phone, role: 'admin',
        active: false, inviteCode, createdAt: Date.now()
      });
    }

    /* 3) invite email + text */
    if (inviteCode) {
      const link = welcomeLink(slug, inviteCode, email);
      await relayMail({
        to: email,
        subject: `${salon} is live — set up your Salon Vine portal`,
        text: `Hi ${name || 'there'},\n\nYour site is live: ${reg.url}\n\nNext, set the password for your owner portal — that's where bookings land and where you add your stylists:\n${link}\n\nTap the link, choose a password, and you're in. From the portal you can invite your team; each stylist gets her own login. Add the portal to your phone's home screen and it works like an app.\n\n— Salon Vine`
      });
      if (phone) {
        await relayMail({
          sms: { phone },
          text: `Salon Vine: ${salon} is live! Set your portal password here: ${link}`
        });
      }
    }

    /* founder heads-up (best-effort, never blocks the signup) */
    const founders = String(process.env.FOUNDER_ALERT_EMAILS || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    await Promise.all(founders.map(f => relayMail({
      to: f,
      subject: `New Salon Vine signup: ${salon} (${plan})`,
      text: `Salon:  ${salon}\nOwner:  ${name || '—'}\nEmail:  ${email}\nPhone:  ${phone || '—'}\nPlan:   ${plan}\nSite:   ${reg.url}\nPortal: https://salonvine-app.netlify.app/p/${slug}`
    }).catch(() => null)));

    return json(200, { ok: true, slug, url: reg.url || '' }, c.headers);
  } catch (e) {
    return json(500, { error: 'Something went wrong. Try again in a minute.' }, c.headers);
  }
};
