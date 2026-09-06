/* TEMP founder-only schema probe. Returns the real column names of the core
   tables (service_role bypasses RLS, so select=* reveals every column).
   Delete after the signup-to-Supabase wiring is confirmed.
   GET /api/sb-cols  with x-sv-token: <SV_TOKEN>  (or founder cookie). */

import { cors, json } from './_lib.js';
import { sbReady, sbSelect } from './_supabase.js';
import { getFounder } from './_admin.js';

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  const token = req.headers.get('x-sv-token') || new URL(req.url).searchParams.get('token');
  const founder = getFounder(req);
  if (!founder && !(process.env.SV_TOKEN && token === process.env.SV_TOKEN)) return json(403, { error: 'Founder login required.' }, c.headers);
  if (!sbReady()) return json(500, { error: 'SUPABASE_SECRET_KEY not set' }, c.headers);
  const out = {};
  for (const t of ['salon', 'stylist', 'service', 'salon_hours', 'working_hours', 'client', 'product']) {
    try {
      const rows = await sbSelect(t, 'select=*&limit=1');
      out[t] = rows[0] ? Object.keys(rows[0]) : '(no rows — empty table)';
    } catch (e) { out[t] = 'ERR ' + String(e.message || e).slice(0, 120); }
  }
  return json(200, { ok: true, columns: out }, c.headers);
};
