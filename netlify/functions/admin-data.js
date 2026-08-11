/* Founder console — all read endpoints. Founder cookie required on every one.

   GET ?view=overview        -> business metrics
   GET ?view=salons          -> every salon, enriched
   GET ?view=salon&slug=x    -> one salon, everything we know
   GET ?view=health          -> system diagnostics
   GET ?view=audit           -> recent privileged actions

   Scaling note: the salon list enriches each row with blob reads, fanned out
   concurrently. Fine into the low hundreds of salons. Past that this wants a
   materialised index rather than a fan-out. */

import {
  cors, json, normSlug, getDataStore, listJSON,
  usersPrefix, bookingsPrefix
} from './_lib.js';
import { readBilling, readPayments, stripeConfigured } from './_stripe.js';
import { requireFounder, AUDIT_PREFIX } from './_admin.js';

const PLAN_PRICE = { studio: 19, pro: 39, elite: 59 };
const PAYING = ['active', 'trialing', 'past_due'];

async function fetchRegistry() {
  const exec = process.env.SV_EXEC;
  const token = process.env.SV_TOKEN;
  if (!exec || !token) return { error: 'registry not configured', salons: [] };
  try {
    const res = await fetch(`${exec}?token=${encodeURIComponent(token)}`, { redirect: 'follow' });
    const j = await res.json().catch(() => null);
    return { salons: (j && j.salons) || [] };
  } catch (e) {
    return { error: String((e && e.message) || e), salons: [] };
  }
}

function parseConfig(raw) {
  try { return JSON.parse(String(raw || '{}')); } catch (e) { return {}; }
}

async function enrich(store, s) {
  const slug = normSlug(s.slug);
  if (!slug) return null;
  const cfg = parseConfig(s.config);

  const [users, billing, payments, bookings] = await Promise.all([
    listJSON(store, usersPrefix(slug)).catch(() => []),
    readBilling(slug).catch(() => null),
    readPayments(slug).catch(() => null),
    listJSON(store, bookingsPrefix(slug)).catch(() => [])
  ]);

  const ownerEmail = String(cfg.email || '').toLowerCase();
  const owner = users.find(u => u && String(u.email || '').toLowerCase() === ownerEmail) || null;
  const admins = users.filter(u => u && u.role === 'admin');
  const activeUsers = users.filter(u => u && u.active);
  const status = String(billing && billing.status || '');

  return {
    slug,
    name: s.name || slug,
    plan: String(s.plan || '').toLowerCase(),
    registryStatus: String(s.status || ''),
    createdAt: Date.parse(s.createdAt || '') || 0,
    siteUrl: s.url || `https://salonvine.com/s/${slug}`,
    owner: {
      name: cfg.owner || '',
      email: ownerEmail,
      phone: cfg.phone || '',
      hasAccount: Boolean(owner),
      activated: Boolean(owner && owner.active),
      invitedOnly: Boolean(owner && !owner.active)
    },
    team: { total: users.length, active: activeUsers.length, admins: admins.length },
    billing: billing ? {
      status,
      paying: PAYING.indexOf(status) !== -1,
      trialEnd: billing.trialEnd || 0,
      currentPeriodEnd: billing.currentPeriodEnd || 0,
      subscriptionId: billing.subscriptionId || '',
      customerId: billing.customerId || '',
      graceStartedAt: billing.graceStartedAt || 0,
      suspendedAt: billing.suspendedAt || 0
    } : null,
    payments: payments ? {
      connected: Boolean(payments.connectAccountId),
      chargesEnabled: Boolean(payments.chargesEnabled),
      depositEnabled: Boolean(payments.depositEnabled),
      depositType: payments.depositType || 'fixed',
      depositAmount: payments.depositAmount || 0
    } : null,
    bookings: {
      total: bookings.length,
      unhandled: bookings.filter(b => b && String(b.status || 'new') === 'new').length,
      depositsPaid: bookings.filter(b => b && b.depositPaid).length,
      lastAt: bookings.reduce((m, b) => Math.max(m, (b && b.ts) || 0), 0)
    },
    /* Things a founder should notice without hunting for them. */
    flags: [
      !owner ? 'no-owner-account' : null,
      owner && !owner.active ? 'owner-never-activated' : null,
      !billing ? 'never-started-trial' : null,
      status === 'past_due' ? 'payment-failed' : null,
      billing && billing.suspendedAt ? 'suspended' : null,
      bookings.filter(b => b && String(b.status || 'new') === 'new').length > 5 ? 'bookings-piling-up' : null
    ].filter(Boolean)
  };
}

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' }, c.headers);

  const guard = requireFounder(req, c.headers);
  if (guard.errorResponse) return guard.errorResponse;

  const url = new URL(req.url);
  const view = url.searchParams.get('view') || 'overview';
  const store = getDataStore();

  try {
    if (view === 'health') {
      const need = ['JWT_SECRET', 'SV_EXEC', 'SV_TOKEN', 'SV_SIGNUP_TOKEN', 'STRIPE_SECRET_KEY',
        'STRIPE_WEBHOOK_SECRET', 'FOUNDER_EMAILS', 'FOUNDER_ALERT_EMAILS'];
      /* Presence only — never echo a secret's value into a browser. */
      const env = need.map(k => ({ key: k, set: Boolean(process.env[k]) }));
      let blobs = 'ok', registry = 'ok';
      try { await store.get('admin/_healthprobe', { type: 'json' }); } catch (e) { blobs = String(e && e.message || e); }
      const reg = await fetchRegistry();
      if (reg.error) registry = reg.error;
      return json(200, {
        ok: true,
        env,
        blobs,
        registry,
        stripe: stripeConfigured() ? 'configured' : 'MISSING KEY',
        salonCount: reg.salons.length,
        now: Date.now()
      }, c.headers);
    }

    if (view === 'audit') {
      const { blobs } = await store.list({ prefix: AUDIT_PREFIX });
      const keys = blobs.map(b => b.key).sort().reverse().slice(0, 200);
      const entries = await Promise.all(keys.map(k => store.get(k, { type: 'json' }).catch(() => null)));
      return json(200, { ok: true, entries: entries.filter(Boolean) }, c.headers);
    }

    const reg = await fetchRegistry();

    if (view === 'salon') {
      const slug = normSlug(url.searchParams.get('slug'));
      if (!slug) return json(400, { error: 'Missing salon.' }, c.headers);
      const row = reg.salons.find(s => normSlug(s.slug) === slug);
      if (!row) return json(404, { error: 'Salon not found in the registry.' }, c.headers);

      const [base, users, bookings] = await Promise.all([
        enrich(store, row),
        listJSON(store, usersPrefix(slug)).catch(() => []),
        listJSON(store, bookingsPrefix(slug)).catch(() => [])
      ]);

      const { blobs } = await store.list({ prefix: AUDIT_PREFIX });
      const auditKeys = blobs.map(b => b.key).sort().reverse().slice(0, 400);
      const auditAll = await Promise.all(auditKeys.map(k => store.get(k, { type: 'json' }).catch(() => null)));
      const salonAudit = auditAll.filter(a => a && a.detail && a.detail.slug === slug).slice(0, 40);

      return json(200, {
        ok: true,
        salon: base,
        config: parseConfig(row.config),
        team: users.map(u => ({
          email: u.email, name: u.name, role: u.role,
          active: Boolean(u.active), createdAt: u.createdAt || 0,
          pendingInvite: Boolean(u.inviteCode && !u.active)
        })).sort((a, b) => (a.role === 'admin' ? -1 : 1) - (b.role === 'admin' ? -1 : 1)),
        bookings: bookings
          .sort((a, b) => (b.ts || 0) - (a.ts || 0))
          .slice(0, 50)
          .map(b => ({
            id: b.id, ts: b.ts, name: b.name, phone: b.phone, email: b.email,
            service: b.service, status: b.status || 'new',
            depositPaid: Boolean(b.depositPaid), depositCents: b.depositCents || 0
          })),
        audit: salonAudit
      }, c.headers);
    }

    /* ---- salons + overview both need the enriched list ---- */
    const enriched = (await Promise.all(reg.salons.map(s => enrich(store, s).catch(() => null))))
      .filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt);

    if (view === 'salons') {
      return json(200, { ok: true, salons: enriched, registryError: reg.error || null }, c.headers);
    }

    /* ---- overview ---- */
    const live = enriched.filter(s => s.registryStatus === 'live' || s.registryStatus === 'live-free');
    const paying = enriched.filter(s => s.billing && s.billing.paying);
    const trialing = enriched.filter(s => s.billing && s.billing.status === 'trialing');
    const active = enriched.filter(s => s.billing && s.billing.status === 'active');
    const pastDue = enriched.filter(s => s.billing && s.billing.status === 'past_due');
    const noTrial = enriched.filter(s => !s.billing);
    const neverActivated = enriched.filter(s => !s.owner.activated);

    const mrr = active.reduce((sum, s) => sum + (PLAN_PRICE[s.plan] || 0), 0);
    const committedMrr = paying.reduce((sum, s) => sum + (PLAN_PRICE[s.plan] || 0), 0);

    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const signups7 = enriched.filter(s => now - s.createdAt < 7 * DAY).length;
    const signups30 = enriched.filter(s => now - s.createdAt < 30 * DAY).length;

    return json(200, {
      ok: true,
      totals: {
        salons: enriched.length,
        live: live.length,
        paying: paying.length,
        active: active.length,
        trialing: trialing.length,
        pastDue: pastDue.length,
        noTrial: noTrial.length,
        neverActivated: neverActivated.length,
        signups7, signups30
      },
      revenue: {
        mrrActive: mrr,
        mrrCommitted: committedMrr,
        arrCommitted: committedMrr * 12,
        note: 'Active = billing today. Committed also counts trials and past-due, which have NOT paid yet.'
      },
      byPlan: ['studio', 'pro', 'elite'].map(p => ({
        plan: p,
        total: enriched.filter(s => s.plan === p).length,
        paying: paying.filter(s => s.plan === p).length
      })),
      /* Whatever most deserves a founder's attention, computed not guessed. */
      attention: enriched
        .filter(s => s.flags.length)
        .map(s => ({ slug: s.slug, name: s.name, flags: s.flags }))
        .slice(0, 50),
      trialsEndingSoon: trialing
        .filter(s => s.billing.trialEnd && s.billing.trialEnd - now < 7 * DAY)
        .map(s => ({ slug: s.slug, name: s.name, trialEnd: s.billing.trialEnd }))
        .sort((a, b) => a.trialEnd - b.trialEnd),
      registryError: reg.error || null
    }, c.headers);
  } catch (e) {
    return json(500, { error: String((e && e.message) || e) }, c.headers);
  }
};
