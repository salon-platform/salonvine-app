/* Public read for the site fields the registry's own public endpoint does not
   return.

   The registry's publicSiteConfig_ hands back a fixed set (name, tagline,
   theme, accent, photos, services, hours, instagram). Anything an owner adds
   beyond that — an about paragraph, social links, the show/hide toggles —
   lives in the same config blob but never reaches the browser through that
   route.

   Rather than widen the registry (one shared file, every salon depends on it),
   this reads the full registry server-side with SV_TOKEN, plucks the extra
   keys for one salon, and returns only those. The token never leaves the
   server, and nothing about the existing public path changes.               */

import { cors, json, normSlug } from './_lib.js';

const TTL_MS = 60 * 1000;
const cache = new Map();

const TEXT_KEYS = ['about', 'facebook', 'twitter', 'pinterest', 'yelp', 'externalWebsite'];
const FLAG_KEYS = ['showGallery', 'showTeam', 'servicesVisual'];

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' }, c.headers);

  const slug = normSlug(new URL(req.url).searchParams.get('slug'));
  if (!slug) return json(400, { error: 'Missing or invalid slug.' }, c.headers);

  const hit = cache.get(slug);
  if (hit && hit.exp > Date.now()) {
    return json(200, hit.data, { ...c.headers, 'Cache-Control': 'public, max-age=60' });
  }

  const exec = process.env.SV_EXEC;
  const token = process.env.SV_TOKEN;
  if (!exec || !token) return json(200, { ok: true, extra: {} }, c.headers);

  try {
    const res = await fetch(`${exec}?token=${encodeURIComponent(token)}`, { redirect: 'follow' });
    const j = await res.json().catch(() => null);
    const salons = (j && j.salons) || [];

    const row = salons.find(s => normSlug(s && s.slug) === slug);
    if (!row) return json(404, { error: 'Salon not found.' }, c.headers);

    /* Never serve a salon that is not publicly live — same rule the registry's
       own public endpoint applies. */
    const status = String(row.status || '').toLowerCase();
    if (status !== 'live' && status !== 'live-free') {
      return json(404, { error: 'Salon not found.' }, c.headers);
    }

    let cfg = {};
    try { cfg = JSON.parse(String(row.config || '{}')) || {}; } catch (e) { cfg = {}; }

    const extra = {};
    for (const k of TEXT_KEYS) {
      const v = String(cfg[k] == null ? '' : cfg[k]).trim();
      if (v) extra[k] = v;
    }
    /* Toggles default ON where the salon has never expressed a preference —
       a brand new site should look complete, not stripped. */
    for (const k of FLAG_KEYS) {
      extra[k] = cfg[k] === undefined ? true : !!cfg[k];
    }

    const data = { ok: true, slug, extra };
    cache.set(slug, { data, exp: Date.now() + TTL_MS });
    return json(200, data, { ...c.headers, 'Cache-Control': 'public, max-age=60' });
  } catch (e) {
    /* A read failure must never blank a salon's page — the caller falls back
       to showing everything, which is the pre-toggle behaviour. */
    return json(200, { ok: true, slug, extra: {} }, c.headers);
  }
};
