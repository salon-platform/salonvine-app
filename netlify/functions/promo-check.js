/* Promo-code validation for the signup wizard.
   Called from salonvine.com (CORS-allowed). Forwards {type:'promoCheck'}
   to the Apps Script registry with SV_SIGNUP_TOKEN added server-side — the
   token never ships to a browser. Never redeems; redemption happens only
   when the site is created (signup-proxy -> signupSite).
   Returns the registry's {ok, valid, promo?, reason?} verbatim. */

import { cors, json, parseBody } from './_lib.js';

export default async (req, context) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = await parseBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const code = String(body.code || '').trim().slice(0, 40);
  if (!code) return json(200, { ok: true, valid: false, reason: 'empty' }, c.headers);

  const exec = process.env.SV_EXEC;
  const signupToken = process.env.SV_SIGNUP_TOKEN;
  if (!exec || !signupToken) return json(500, { error: 'Not configured' }, c.headers);

  try {
    const res = await fetch(exec, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: signupToken, type: 'promoCheck', code }),
      redirect: 'follow'
    });
    const data = await res.json().catch(() => null);
    if (!data) return json(502, { error: 'Could not check that code right now.' }, c.headers);
    return json(200, data, c.headers);
  } catch (e) {
    return json(502, { error: 'Could not check that code right now.' }, c.headers);
  }
};
