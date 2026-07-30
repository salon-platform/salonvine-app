/* "Find my salon site" lookup for login.html on salonvine.com.
   Proxies {type:'findSite'} to the registry with the full token held
   server-side, so the marketing site needs no secrets at all.
   Reveals only what the backend reveals: found + slug/url/salonName. */

const { cors, json, parseBody, normEmail } = require('./_lib');

exports.handler = async (event) => {
  const c = cors(event);
  if (c.preflight) return c.preflight;
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = parseBody(event);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const email = normEmail(body.email);
  if (!email) return json(400, { error: 'Enter the email you signed up with.' }, c.headers);

  const exec = process.env.SV_EXEC;
  const token = process.env.SV_TOKEN;
  if (!exec || !token) return json(500, { error: 'Lookup is not configured yet.' }, c.headers);

  try {
    const res = await fetch(exec, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token, type: 'findSite', email }),
      redirect: 'follow'
    });
    const j = await res.json().catch(() => null);
    if (j && j.ok) {
      return json(200, {
        ok: true,
        found: !!j.found,
        url: j.url || '',
        slug: j.slug || '',
        salonName: j.salonName || ''
      }, c.headers);
    }
    return json(502, { error: (j && j.error) || 'Lookup failed. Try again.' }, c.headers);
  } catch (e) {
    return json(502, { error: 'Lookup failed. Try again.' }, c.headers);
  }
};
