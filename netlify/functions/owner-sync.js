/* Owner-sync (scheduled every 15 min): closes the legacy-funnel gap from the
   app side. The marketing site's old signup page posts straight to the Apps
   Script registry, which cannot reliably call us back (UrlFetchApp scope not
   yet authorized). So we poll: read the full registry, find live salons
   created after the cutoff whose owner has no portal account yet, and
   provision them via our own provision-owner endpoint (idempotent).
   Also alerts the founders on each new provision. */

import { getDataStore, userKey, normSlug, normEmail, relayMail, APP_URL } from './_lib.js';

/* Only auto-invite salons created after this moment (when the multi-tenant
   funnel went live) — older rows are historical/test data and must not be
   mass-emailed. */
const CUTOFF = Date.parse('2026-07-30T16:00:00Z');

export default async () => {
  const exec = process.env.SV_EXEC;
  const token = process.env.SV_TOKEN;
  if (!exec || !token) return new Response(JSON.stringify({ error: 'not configured' }), { status: 503 });

  const founders = String(process.env.FOUNDER_ALERT_EMAILS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const out = { checked: 0, provisioned: [], skipped: 0, errors: [] };

  try {
    const res = await fetch(`${exec}?token=${encodeURIComponent(token)}`, { redirect: 'follow' });
    const j = await res.json().catch(() => null);
    const salons = (j && j.salons) || [];
    const store = getDataStore();

    for (const s of salons) {
      const status = String(s.status || '');
      if (status !== 'live-free' && status !== 'live') continue;
      const created = Date.parse(s.createdAt || '') || 0;
      if (created < CUTOFF) continue;

      const slug = normSlug(s.slug);
      let cfg = {};
      try { cfg = JSON.parse(String(s.config || '{}')); } catch (e) { cfg = {}; }
      const email = normEmail(cfg.email);
      if (!slug || !email) { out.skipped++; continue; }

      out.checked++;
      const existing = await store.get(userKey(slug, email), { type: 'json' }).catch(() => null);
      if (existing) continue; // already provisioned (active or invited)

      try {
        const p = await fetch(`${APP_URL}/.netlify/functions/provision-owner`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token,
            slug,
            email,
            name: String(cfg.owner || ''),
            phone: String(cfg.phone || ''),
            salon: String(s.name || slug),
            url: String(s.url || '')
          })
        }).then(r => r.json()).catch(() => null);

        if (p && p.ok) {
          out.provisioned.push(slug);
          await Promise.all(founders.map(f => relayMail({
            to: f,
            subject: `New Salon Vine signup: ${s.name || slug} (${s.plan || '?'})`,
            text: `Salon:  ${s.name || slug}\nOwner:  ${cfg.owner || '—'}\nEmail:  ${email}\nPlan:   ${s.plan || '?'}\nSite:   ${s.url || ''}\nPortal: ${APP_URL}/p/${slug}\n\n(Provisioned by owner-sync — signup came through the legacy page.)`
          }).catch(() => null)));
        } else {
          out.errors.push(`${slug}: provision failed`);
        }
      } catch (e) {
        out.errors.push(`${slug}: ${String((e && e.message) || e)}`);
      }
    }
  } catch (e) {
    out.errors.push(String((e && e.message) || e));
  }
  return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } });
};

export const config = { schedule: '*/15 * * * *' };
