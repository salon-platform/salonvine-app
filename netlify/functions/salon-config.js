/* Public-safe salon config for portal chrome (name, accent, plan tier).
   Backed by the registry's 5-minute cache; no token, no session required —
   this only ever exposes what the public site config already exposes,
   plus the plan tier label. */

import { cors, json, normSlug, getSalonRegistry, seatLimitForPlan } from './_lib.js';

export default async (req, context) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' }, c.headers);

  const slug = normSlug(new URL(req.url).searchParams.get('slug'));
  if (!slug) return json(400, { error: 'Missing or invalid slug.' }, c.headers);

  try {
    const registry = await getSalonRegistry(slug);
    if (!registry) return json(404, { error: 'Salon not found.' }, c.headers);

    const plan = String(registry.plan || 'studio').toLowerCase();
    return json(200, {
      ok: true,
      slug,
      name: registry.name || slug,
      tagline: registry.tagline || '',
      theme: registry.theme || '',
      accent: registry.accent || '',
      plan,
      seatLimit: seatLimitForPlan(plan)
    }, { ...c.headers, 'Cache-Control': 'public, max-age=120' });
  } catch (e) {
    return json(500, { error: 'Could not load salon.' }, c.headers);
  }
};
