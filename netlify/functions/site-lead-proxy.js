/* Forwards a public-site booking inquiry to the registry (type:'siteLead')
   with the token added server-side. */

const { cors, json, parseBody, normSlug, getDataStore, bookingKey, newCode } = require('./_lib');

exports.handler = async (event) => {
  const c = cors(event);
  if (c.preflight) return c.preflight;
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = parseBody(event);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const slug = normSlug(body.slug);
  const name = String(body.name || '').trim().slice(0, 80);
  const phone = String(body.phone || '').replace(/[^\d+() .-]/g, '').slice(0, 20);
  const email = String(body.email || '').trim().slice(0, 254);
  const message = String(body.message || '').trim().slice(0, 2000);

  if (!slug) return json(400, { error: 'Missing salon.' }, c.headers);
  if (!name || (!phone && !email)) {
    return json(400, { error: 'Name plus a phone or email are required.' }, c.headers);
  }

  const exec = process.env.SV_EXEC;
  const token = process.env.SV_SIGNUP_TOKEN;
  if (!exec || !token) return json(500, { error: 'Not configured yet.' }, c.headers);

  try {
    const res = await fetch(exec, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token, type: 'siteLead', slug, name, phone, email, message }),
      redirect: 'follow'
    });
    const j = await res.json().catch(() => null);
    if (j && j.ok) {
      /* Mirror the request into the portal's booking list so staff see it
         the second it lands. Failure here must never fail the lead. */
      try {
        const store = getDataStore(event);
        const id = `bk_${Date.now()}_${newCode(3)}`;
        await store.setJSON(bookingKey(slug, id), {
          id, ts: Date.now(), name, phone, email,
          service: message.slice(0, 200), stylist: '', when: '', status: 'new'
        });
      } catch (e2) { /* logged nowhere client-visible; lead is already saved */ }
      return json(200, { ok: true }, c.headers);
    }
    return json(502, { error: (j && j.error) || 'Could not send your request. Try again.' }, c.headers);
  } catch (e) {
    return json(502, { error: 'Could not send your request. Try again.' }, c.headers);
  }
};
