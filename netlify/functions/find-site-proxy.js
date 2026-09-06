/* "Find my salon site" lookup for login.html on salonvine.com.
   Reads Supabase directly — no Apps Script. Given the email a salon signed up
   with, returns that salon's public address. Reveals only slug/url/salonName,
   and only for a live (not deleted) salon. Matches the owner email held on the
   salon row (owner_email or email, whichever the schema uses). */

import { cors, json, parseBody, normEmail } from './_lib.js';
import { sbReady, sbSelect } from './_supabase.js';

const SITE_BASE = 'https://salonvine.com/s/';

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = await parseBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const email = normEmail(body.email);
  if (!email) return json(400, { error: 'Enter the email you signed up with.' }, c.headers);
  if (!sbReady()) return json(200, { ok: true, found: false }, c.headers);

  try {
    const rows = await sbSelect('salon', 'select=*&deleted_at=is.null');
    const hit = rows.find(r => {
      const e = String(r.owner_email || r.email || '').trim().toLowerCase();
      return e && e === email;
    });
    if (!hit) return json(200, { ok: true, found: false }, c.headers);
    const slug = String(hit.slug || '');
    return json(200, {
      ok: true, found: true,
      slug,
      url: hit.url || (slug ? SITE_BASE + slug : ''),
      salonName: hit.name || ''
    }, c.headers);
  } catch (e) {
    return json(502, { error: 'Lookup failed. Try again.' }, c.headers);
  }
};
