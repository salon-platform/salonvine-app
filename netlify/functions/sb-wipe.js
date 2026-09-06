/* One-time clean-up: wipe the old TEST salons everywhere except Supabase
   (Dylan already cleared Supabase by hand). Founder-only.

   GET /api/sb-wipe?keep=studio17            dry run — lists what WOULD go
   GET /api/sb-wipe?keep=studio17&go=1       actually deletes

   For every salon in the old Apps Script registry whose slug is not in
   `keep` (comma-separated):
   1. every Netlify Blob under s/<slug>/  (portal logins, old bookings,
      site extras, billing/payment records)
   2. the salon's row in the Apps Script sheet (type:'salonDelete')
   Supabase rows, if any still exist, are soft-deleted (deleted_at set).
   Nothing touches the kept salons. */

import { cors, json, getDataStore } from './_lib.js';
import { getFounder, audit } from './_admin.js';
import { sbReady, sbSelect, sbWrite } from './_supabase.js';

async function registrySalons() {
  const exec = process.env.SV_EXEC, token = process.env.SV_TOKEN;
  if (!exec || !token) return { error: 'registry not configured', salons: [] };
  try {
    const res = await fetch(`${exec}?token=${encodeURIComponent(token)}`, { redirect: 'follow' });
    const j = await res.json().catch(() => null);
    return { salons: (j && j.salons) || [] };
  } catch (e) { return { error: String((e && e.message) || e), salons: [] }; }
}
async function registryDelete(ref) {
  const exec = process.env.SV_EXEC, token = process.env.SV_TOKEN;
  const res = await fetch(exec, {
    method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ token, type: 'salonDelete', ref }), redirect: 'follow'
  });
  return await res.json().catch(() => ({ error: 'bad reply' }));
}
const bare = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' }, c.headers);
  const founder = getFounder(req);
  if (!founder) return json(403, { error: 'Founder login required.' }, c.headers);

  const url = new URL(req.url);
  const keep = String(url.searchParams.get('keep') || 'studio17').split(',').map(bare).filter(Boolean);
  const go = url.searchParams.get('go') === '1';
  const store = getDataStore();

  /* what exists */
  const reg = await registrySalons();
  const regSlugs = reg.salons.map(s => String(s.slug || '').toLowerCase()).filter(Boolean);
  const { blobs } = await store.list({ prefix: 's/' });
  const blobSlugs = Array.from(new Set(blobs.map(b => b.key.split('/')[1]).filter(Boolean)));
  const sbSlugs = sbReady() ? (await sbSelect('salon', 'select=id,slug&deleted_at=is.null').catch(() => [])) : [];

  const targets = Array.from(new Set([...regSlugs, ...blobSlugs, ...sbSlugs.map(s => s.slug)]))
    .filter(slug => keep.indexOf(bare(slug)) === -1);

  const plan = targets.map(slug => ({
    slug,
    inRegistry: regSlugs.includes(slug),
    blobs: blobs.filter(b => b.key.startsWith(`s/${slug}/`)).length,
    inSupabase: sbSlugs.some(s => s.slug === slug)
  }));
  if (!go) return json(200, { ok: true, dryRun: true, keep, registryError: reg.error || null, wouldDelete: plan }, c.headers);

  const results = [];
  for (const p of plan) {
    const r = { slug: p.slug, blobsDeleted: 0, registry: null, supabase: null, errors: [] };
    for (const b of blobs.filter(b => b.key.startsWith(`s/${p.slug}/`))) {
      try { await store.delete(b.key); r.blobsDeleted++; } catch (e) { r.errors.push(`blob ${b.key}: ${e.message}`); }
    }
    if (p.inRegistry) {
      /* a slug can appear on more than one sheet row (duplicate signups);
         delete each row by its own id so nothing is left behind */
      const rows = reg.salons.filter(s => String(s.slug || '').toLowerCase() === p.slug);
      r.registry = [];
      for (const row of rows) {
        try { r.registry.push(await registryDelete(String(row.salonId || p.slug))); } catch (e) { r.errors.push(`registry: ${e.message}`); }
      }
    }
    if (p.inSupabase) {
      try {
        const row = sbSlugs.find(s => s.slug === p.slug);
        await sbWrite('salon', 'update', `id=eq.${row.id}`, { deleted_at: new Date().toISOString() });
        r.supabase = 'soft-deleted';
      } catch (e) { r.errors.push(`supabase: ${e.message}`); }
    }
    results.push(r);
  }
  await audit(founder.email, 'salons.wipe', { keep, results }).catch(() => null);
  return json(200, { ok: true, keep, results }, c.headers);
};
