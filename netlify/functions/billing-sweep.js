/* Daily billing sweep (Netlify scheduled function, runs at 09:00 UTC).
   Enforces the 14-day grace window the webhook only records:
   any salon whose payment failed more than 14 days ago and never recovered
   is suspended (registry status -> 'suspended', founders alerted).
   Reactivation stays automatic via invoice.paid in stripe-webhook.js. */

import { getDataStore, relayMail } from './_lib.js';

const GRACE_DAYS = 14;

export default async () => {
  const store = getDataStore();
  const exec = process.env.SV_EXEC;
  const token = process.env.SV_TOKEN;
  const founders = String(process.env.FOUNDER_ALERT_EMAILS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  const results = { checked: 0, suspended: [], errors: [] };
  try {
    const { blobs } = await store.list({ prefix: 's/' });
    const billingKeys = blobs.map(b => b.key).filter(k => k.endsWith('/billing'));
    for (const key of billingKeys) {
      results.checked++;
      try {
        const b = await store.get(key, { type: 'json' });
        if (!b || b.status !== 'past_due' || !b.graceStartedAt) continue;
        const expired = Date.now() - b.graceStartedAt > GRACE_DAYS * 24 * 60 * 60 * 1000;
        if (!expired || b.suspendedAt) continue;

        const slug = key.split('/')[1];
        /* registry: mark suspended (public site + config hidden) */
        if (exec && token) {
          await fetch(exec, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ token, type: 'salonStatus', slug, status: 'suspended' }),
            redirect: 'follow'
          }).catch(() => null);
        }
        await store.setJSON(key, { ...b, suspendedAt: Date.now() });
        results.suspended.push(slug);

        await Promise.all(founders.map(f => relayMail({
          to: f,
          subject: `Salon Vine: ${slug} suspended (grace period expired)`,
          text: `The 14-day grace period for ${slug} ended without a successful payment.\nThe salon has been suspended automatically.\n\nIt reactivates instantly if their payment goes through (Stripe keeps retrying), or you can extend grace manually by editing the billing record.`
        }).catch(() => null)));
      } catch (e) {
        results.errors.push(String((e && e.message) || e));
      }
    }
  } catch (e) {
    results.errors.push(String((e && e.message) || e));
  }
  return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json' } });
};

export const config = { schedule: '0 9 * * *' };
