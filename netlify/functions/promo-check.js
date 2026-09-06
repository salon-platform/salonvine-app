/* Promo-code validation for the signup wizard.
   Called from salonvine.com (CORS-allowed). Reads the Supabase `promo` table
   directly — no Apps Script. Never redeems; redemption happens when the site
   is created (signup-proxy). Returns {ok, valid, comp?, promo?, label?, reason?}.
   Case-insensitive match; active must be true; max_redemptions 0 = unlimited. */

import { cors, json, parseBody } from './_lib.js';
import { sbReady, sbSelect } from './_supabase.js';

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = await parseBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const code = String(body.code || '').trim().slice(0, 40);
  if (!code) return json(200, { ok: true, valid: false, reason: 'empty' }, c.headers);
  if (!sbReady()) return json(200, { ok: true, valid: false, reason: 'unavailable' }, c.headers);

  try {
    // ilike with no wildcards = case-insensitive exact match
    const rows = await sbSelect('promo', `code=ilike.${encodeURIComponent(code)}&limit=1&select=code,kind,label,active,max_redemptions,redeemed`);
    const p = rows[0];
    if (!p || p.active === false) return json(200, { ok: true, valid: false, reason: 'invalid' }, c.headers);
    const cap = Number(p.max_redemptions || 0);
    if (cap > 0 && Number(p.redeemed || 0) >= cap) {
      return json(200, { ok: true, valid: false, reason: 'used_up' }, c.headers);
    }
    return json(200, {
      ok: true, valid: true,
      comp: p.kind === 'comp',
      promo: p.code,
      kind: p.kind || 'comp',
      label: p.label || ''
    }, c.headers);
  } catch (e) {
    return json(502, { error: 'Could not check that code right now.' }, c.headers);
  }
};
