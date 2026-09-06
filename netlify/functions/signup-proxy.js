/* New-salon signup. Called from salonvine.com (CORS-allowed).
   1. Forwards the signup to the Apps Script registry (type:'signupSite') with
      SV_SIGNUP_TOKEN added server-side — the token never ships to a browser.
      This keeps the founder console, promo/comp logic, and slug generation
      exactly as they are.
   2. Creates the SAME salon in Supabase (salon + owner stylist + service menu
      + offers) under the slug the registry returned, so the new site renders on
      the live engine (SEO, bookings) and the owner portal reads real data — the
      new home for every salon. Best-effort: never blocks the signup, and
      sb-migrate can backfill if it fails.
   3. Creates the owner's portal account (inactive, invite-coded) under
      s/<slug>/users/ and relays a set-password invite email (+ text).
   4. Pings the founders. Returns {ok, slug, url}. */

import {
  cors, json, parseBody, normSlug, normEmail,
  getDataStore, userKey, newCode, welcomeLink, relayMail
} from './_lib.js';
import { sbReady, sbSalon, sbSelect, sbWrite, sbRpc } from './_supabase.js';

const PLANS = ['studio', 'pro', 'elite'];

function priceCentsOf(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, ''));
  return isFinite(n) ? Math.round(n * 100) : null;
}
function stylistSlug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'stylist';
}

/* Insert a row, but survive schema drift: if PostgREST reports a column the
   table doesn't have, drop that column and try again. `keep` names the columns
   that must never be stripped (a failure on one of those is a real error). */
async function sbInsertResilient(table, row, keep) {
  const must = new Set(keep || []);
  let attempt = Object.assign({}, row);
  for (let i = 0; i < 16; i++) {
    try {
      const ins = await sbWrite(table, 'insert', '', attempt);
      return Array.isArray(ins) ? ins[0] : ins;
    } catch (e) {
      const m = String((e && e.message) || '');
      const mm = m.match(/Could not find the '([^']+)' column|column "([^"]+)"|'([^']+)' column/i);
      const col = mm && (mm[1] || mm[2] || mm[3]);
      if (col && Object.prototype.hasOwnProperty.call(attempt, col) && !must.has(col)) {
        delete attempt[col];
        continue;
      }
      throw e;
    }
  }
  throw new Error('too many unknown columns for ' + table);
}

/* Bring the freshly-signed-up salon onto Supabase so it renders on the live
   engine and the owner portal has real data. Idempotent by slug; best-effort. */
async function createSalonInSupabase({ slug, salon, name, email, phone, plan, theme, accent, tagline, services }) {
  if (!sbReady()) return { ok: false, note: 'supabase not configured' };
  const existing = await sbSalon(slug);
  if (existing) return { ok: true, salonId: existing.id, note: 'already in supabase' };

  /* 1) salon row — resilient so a wrong optional column can never fail signup */
  const salonRow = await sbInsertResilient('salon', {
    slug,
    name: salon,
    owner_name: name || '',
    owner_email: email || '',
    email: email || '',
    phone: phone || '',
    plan: plan || 'studio',
    status: 'live',
    theme: theme || 'classic-cream',
    accent: accent || '',
    tagline: tagline || '',
    timezone: 'America/Detroit'
  }, ['slug', 'name']);
  const salonId = salonRow && salonRow.id;
  if (!salonId) return { ok: false, note: 'salon insert returned no id' };

  /* 2) owner stylist so the Book button works on day one */
  let stylistId = null;
  try {
    const st = await sbInsertResilient('stylist', {
      salon_id: salonId, name: (name || salon || 'Owner').slice(0, 80),
      slug: stylistSlug(name || salon), role: 'Owner',
      is_active: true, is_public: true, booking_mode: 'instant'
    }, ['salon_id', 'name']);
    stylistId = st && st.id;
  } catch (e) { /* non-fatal */ }

  /* 3) service menu chosen at signup */
  const menu = Array.isArray(services) ? services.filter(s => s && String(s.name || '').trim()) : [];
  const madeServices = [];
  for (const s of menu) {
    try {
      const row = { salon_id: salonId, name: String(s.name).trim().slice(0, 80), is_active: true };
      const cents = priceCentsOf(s.price);
      if (cents !== null) row.price_cents = cents;
      const ins = await sbInsertResilient('service', row, ['salon_id', 'name']);
      if (ins && ins.id) madeServices.push(ins);
    } catch (e) { /* skip a bad service, keep going */ }
  }

  /* 4) owner offers every service so bookings can be taken immediately */
  if (stylistId) {
    for (const sv of madeServices) {
      try {
        await sbRpc('sv_set_duration', {
          p_stylist_id: stylistId, p_service_id: sv.id,
          p_minutes: sv.duration_minutes || 30, p_price_cents: sv.price_cents ?? null
        });
      } catch (e) { /* offer is best-effort */ }
    }
  }

  return { ok: true, salonId, stylistId, services: madeServices.length };
}

export default async (req, context) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = await parseBody(req);
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
          services: body.services, hours: body.hours, instagram: body.instagram,
          promo: String(body.promo || '').slice(0, 40)
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

    /* 1b) put the salon on Supabase (the live engine) — never blocks signup */
    let sbResult = null;
    try {
      sbResult = await createSalonInSupabase({
        slug, salon, name, email, phone, plan,
        theme: String(body.theme || '').slice(0, 60),
        accent: String(body.accent || '').slice(0, 20),
        tagline: String(body.tagline || '').slice(0, 200),
        services: body.services
      });
    } catch (e) {
      sbResult = { ok: false, note: String((e && e.message) || e).slice(0, 160) };
    }

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
      text: `Salon:  ${salon}\nOwner:  ${name || '—'}\nEmail:  ${email}\nPhone:  ${phone || '—'}\nPlan:   ${plan}\nSite:   ${reg.url}\nPortal: https://salonvine-app.netlify.app/p/${slug}\nSupabase: ${sbResult && sbResult.ok ? ('created (' + (sbResult.services || 0) + ' services)') : ('NOT created — ' + ((sbResult && sbResult.note) || 'unknown') + ' — run /api/sb-migrate?slug=' + slug)}`
    }).catch(() => null)));

    return json(200, { ok: true, slug, url: reg.url || '', comped: !!reg.comped, promo: reg.promo || '' }, c.headers);
  } catch (e) {
    return json(500, { error: 'Something went wrong. Try again in a minute.' }, c.headers);
  }
};
