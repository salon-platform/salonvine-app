/* Salon owner edits their own public site.

   POST {slug, fields} — salon admin session required.

   The registry's `salonEdit` is a founder-level operation, so this is the
   narrow, authenticated doorway a salon owner is allowed through: the session
   is checked against the slug FIRST, every field is allow-listed and
   validated here, and the registry token is added server-side. A salon owner
   can only ever edit their own salon, and only these fields — never status,
   never plan, never another salon.

   Deliberately not editable here:
   - status / plan  — those move with billing and belong to the founder console
   - slug           — changing it would break every link the salon has shared */

import { cors, json, parseBody, requireSalonSession, getSalonRegistry, getDataStore } from './_lib.js';
import { sbReady, sbSalon, sbSelect, sbWrite } from './_supabase.js';

/* Kept in sync with site.html + signup.html. A theme outside this list would
   render as the default and quietly lose the owner's choice. */
const THEMES = ['classic-cream', 'midnight', 'rose-gold', 'sage-spa', 'bold-noir', 'ocean'];

const MAX_SERVICES = 40;

/* Free-text extras that live in the config blob rather than a Salons column.
   These go through the registry's `salonConfig` patch, which shallow-merges
   arbitrary keys — so they need no change to the shared backend. */
const TEXT_EXTRAS = ['about', 'facebook', 'twitter', 'pinterest', 'yelp', 'externalWebsite'];
const FLAG_EXTRAS = ['showGallery', 'showTeam', 'servicesVisual'];

/* Social handles: accept a full URL or a bare handle, store a bare handle.
   Storing the handle keeps the public site free to build its own links. */
function handle(v, max) {
  return String(v == null ? '' : v)
    .trim()
    .replace(/^https?:\/\/(www\.)?[^\/]+\//i, '')
    .replace(/^@+/, '')
    .replace(/\/+$/, '')
    .slice(0, max);
}

function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }

function cleanServices(input) {
  if (!Array.isArray(input)) return null;
  const out = [];
  for (const row of input.slice(0, MAX_SERVICES)) {
    if (!row) continue;
    const name = str(row.name, 80);
    if (!name) continue;                       // a price with no name is not a service
    out.push({ name, price: str(row.price, 24) });
  }
  return out;
}

async function registryPost(type, extra) {
  const exec = process.env.SV_EXEC;
  const token = process.env.SV_TOKEN;
  if (!exec || !token) return { ok: false, error: 'registry not configured' };
  try {
    const res = await fetch(exec, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token, type, ...extra }),
      redirect: 'follow'
    });
    return (await res.json().catch(() => null)) || { ok: false, error: 'bad registry response' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ---- Supabase (salons that have moved off Apps Script) ----
   Named fields land on the salon row; the service list is synced by name
   so a stylist's own durations on an existing service survive a rename of
   the price; the "extras" (about, socials, toggles) live in Netlify's own
   store and are served by /api/site-extra. Photos still go through the old
   Drive upload for now — that move is a separate job. */
function priceCents(p) {
  const n = parseFloat(String(p == null ? '' : p).replace(/[^0-9.]/g, ''));
  return isFinite(n) ? Math.round(n * 100) : null;
}
async function syncServices(salonId, list) {
  const existing = await sbSelect('service', `salon_id=eq.${salonId}&select=id,name`);
  const byName = new Map(existing.map(s => [String(s.name).toLowerCase(), s]));
  const keep = new Set();
  for (const s of list) {
    const row = { name: s.name };
    const cents = priceCents(s.price);
    if (cents !== null) row.price_cents = cents;
    const hit = byName.get(s.name.toLowerCase());
    if (hit) {
      keep.add(hit.id);
      await sbWrite('service', 'update', `id=eq.${hit.id}&salon_id=eq.${salonId}`, row);
    } else {
      const ins = await sbWrite('service', 'insert', '', Object.assign({ salon_id: salonId }, row));
      if (ins[0]) keep.add(ins[0].id);
    }
  }
  for (const s of existing) {
    if (keep.has(s.id)) continue;
    try { await sbWrite('service', 'delete', `id=eq.${s.id}&salon_id=eq.${salonId}`); }
    catch (e) { /* already booked at least once — history keeps it */ }
  }
}
export function extrasKey(slug) { return `s/${slug}/site-extra`; }

async function saveToSupabase(slug, salon, src, fields, patch) {
  const row = {};
  if (fields.name !== undefined)      row.name = fields.name;
  if (fields.tagline !== undefined)   row.tagline = fields.tagline;
  if (fields.hours !== undefined)     row.hours_note = fields.hours;
  if (fields.instagram !== undefined) row.instagram = fields.instagram;
  if (fields.theme !== undefined)     row.theme = fields.theme;
  if (fields.accent !== undefined)    row.accent_color = fields.accent;
  if (fields.heroTitle !== undefined) row.hero_title = fields.heroTitle;
  if (fields.logo !== undefined)      row.logo_url = fields.logo || null;
  if (fields.heroImage !== undefined) row.hero_image_url = fields.heroImage || null;
  if (patch.about !== undefined)      row.about_text = patch.about;
  if (src.address !== undefined)      row.address = str(src.address, 200);
  if (Object.keys(row).length) await sbWrite('salon', 'update', `id=eq.${salon.id}`, row);
  if (fields.services) await syncServices(salon.id, fields.services);
  if (Object.keys(patch).length) {
    const store = getDataStore();
    const cur = (await store.get(extrasKey(slug), { type: 'json' })) || {};
    await store.setJSON(extrasKey(slug), Object.assign(cur, patch));
  }
}

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = await parseBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const guard = requireSalonSession(req, body.slug, c.headers);
  if (guard.errorResponse) return guard.errorResponse;
  const { session, slug } = guard;

  if (session.role !== 'admin') {
    return json(403, { error: 'Only the salon owner can change the website.' }, c.headers);
  }

  const registry = await getSalonRegistry(slug);
  if (!registry) return json(404, { error: 'Salon not found.' }, c.headers);

  const src = body.fields || {};
  const fields = {};

  if (src.name !== undefined) {
    const v = str(src.name, 120);
    if (!v) return json(400, { error: 'Your salon needs a name.' }, c.headers);
    fields.name = v;
  }
  if (src.tagline !== undefined) fields.tagline = str(src.tagline, 200);
  if (src.hours !== undefined) fields.hours = str(src.hours, 200);

  if (src.instagram !== undefined) {
    fields.instagram = str(src.instagram, 60).replace(/^@+/, '').replace(/[^A-Za-z0-9._]/g, '');
  }

  if (src.theme !== undefined) {
    const t = str(src.theme, 40);
    if (t && THEMES.indexOf(t) === -1) {
      return json(400, { error: 'That theme is not one of ours.' }, c.headers);
    }
    fields.theme = t;
  }

  if (src.accent !== undefined) {
    const a = str(src.accent, 20);
    if (a && !/^#[0-9a-fA-F]{6}$/.test(a)) {
      return json(400, { error: 'Accent colour must be a hex value like #a8836a.' }, c.headers);
    }
    fields.accent = a;
  }

  if (src.services !== undefined) {
    const svc = cleanServices(src.services);
    if (svc === null) return json(400, { error: 'Services must be a list.' }, c.headers);
    fields.services = svc;
  }

  /* v6.3 — portal site editor: hero heading, logo, hero image and the
     gallery order. Images must be OUR Drive-hosted uploads (from
     /api/site-photo) — never arbitrary external URLs. */
  const IMG_URL = /^https:\/\/lh3\.googleusercontent\.com\/d\/[A-Za-z0-9_-]+(=w\d+)?$/;

  if (src.heroTitle !== undefined) fields.heroTitle = str(src.heroTitle, 120);

  if (src.logo !== undefined) {
    const v = str(src.logo, 300);
    if (v && !IMG_URL.test(v)) return json(400, { error: 'Logo must be an image uploaded here.' }, c.headers);
    fields.logo = v;
  }

  if (src.heroImage !== undefined) {
    const v = str(src.heroImage, 300);
    if (v && !IMG_URL.test(v)) return json(400, { error: 'Header photo must be an image uploaded here.' }, c.headers);
    fields.heroImage = v;
  }

  if (src.photos !== undefined) {
    if (!Array.isArray(src.photos)) return json(400, { error: 'Photos must be a list.' }, c.headers);
    const cleaned = [];
    for (const u of src.photos.slice(0, 8)) {
      const v = str(u, 300);
      if (!IMG_URL.test(v)) return json(400, { error: 'Photos can only be images uploaded here.' }, c.headers);
      cleaned.push(v);
    }
    fields.photos = cleaned;
  }

  /* ---- extras: straight into the config blob ---- */
  const patch = {};
  for (const k of TEXT_EXTRAS) {
    if (src[k] === undefined) continue;
    patch[k] = k === 'about' ? str(src[k], 1200)
             : k === 'externalWebsite' ? str(src[k], 200)
             : handle(src[k], 80);
  }
  for (const k of FLAG_EXTRAS) {
    if (src[k] === undefined) continue;
    patch[k] = !!src[k];
  }

  if (!Object.keys(fields).length && !Object.keys(patch).length && src.address === undefined) {
    return json(400, { error: 'Nothing to change.' }, c.headers);
  }

  /* Salons on Supabase save there and are done. */
  if (sbReady()) {
    try {
      const salon = await sbSalon(slug);
      if (salon) {
        await saveToSupabase(slug, salon, src, fields, patch);
        return json(200, { ok: true, fields, patch, store: 'supabase' }, c.headers);
      }
    } catch (e) {
      console.error('site-edit: supabase save failed', e.message);
      return json(502, { error: 'Could not save your changes (' + e.message.slice(0, 120) + ').' }, c.headers);
    }
  }

  /* The registry identifies a salon by `ref` (slug, salonId or name — it
     refuses anything that matches more than one row). Passing slug as well
     is harmless and keeps the payload readable in logs. */
  /* Two writes because the registry keeps these in two places: named columns
     on the Salons row (salonEdit) and the JSON config blob (salonConfig). */
  if (Object.keys(fields).length) {
    const res = await registryPost('salonEdit', { ref: slug, slug, fields });
    if (!res || !res.ok) {
      return json(502, {
        error: (res && res.error) || 'Could not save your changes. Try again in a minute.'
      }, c.headers);
    }
  }

  if (Object.keys(patch).length) {
    const res2 = await registryPost('salonConfig', { slug, patch });
    if (!res2 || !res2.ok) {
      /* Anything in `fields` already saved — say so rather than implying the
         whole save failed and inviting a duplicate attempt. */
      return json(502, {
        error: (res2 && res2.error) || 'Some changes saved, but the extras did not. Try those again.'
      }, c.headers);
    }
  }

  return json(200, { ok: true, fields, patch }, c.headers);
};
