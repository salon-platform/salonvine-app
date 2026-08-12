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

import { cors, json, parseBody, requireSalonSession, getSalonRegistry } from './_lib.js';

/* Kept in sync with site.html + signup.html. A theme outside this list would
   render as the default and quietly lose the owner's choice. */
const THEMES = ['classic-cream', 'midnight', 'rose-gold', 'sage-spa', 'bold-noir', 'ocean'];

const MAX_SERVICES = 40;

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
    const handle = str(src.instagram, 60).replace(/^@+/, '').replace(/[^A-Za-z0-9._]/g, '');
    fields.instagram = handle;
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

  if (!Object.keys(fields).length) {
    return json(400, { error: 'Nothing to change.' }, c.headers);
  }

  const res = await registryPost('salonEdit', { slug, fields });
  if (res && res.ok) return json(200, { ok: true, fields }, c.headers);

  return json(502, {
    error: (res && res.error) || 'Could not save your changes. Try again in a minute.'
  }, c.headers);
};
