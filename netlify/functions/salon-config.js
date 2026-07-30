/* Public-safe salon config for portal chrome (name, accent, plan tier).
   Backed by the registry's 5-minute cache; no token, no session required —
   this only ever exposes what the public site config already exposes,
   plus the plan tier label. */

const { cors, json, normSlug, getSalonRegistry, seatLimitForPlan } = require('./_lib');

exports.handler = async (event) => {
  const c = cors(event);
  if (c.preflight) return c.preflight;
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' }, c.headers);

  const slug = normSlug((event.queryStringParameters || {}).slug);
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
