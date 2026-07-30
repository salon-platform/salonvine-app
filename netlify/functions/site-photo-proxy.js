/* Forwards a signup-wizard photo upload to the registry (type:'sitePhoto')
   with the token added server-side. */

import { cors, json, parseBody, normSlug } from './_lib.js';

const MAX_DATA_CHARS = 5 * 1024 * 1024; // stays under the function payload cap

export default async (req, context) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = await parseBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const slug = normSlug(body.slug);
  const data = String(body.data || '');
  const n = Number(body.n) || 0;

  if (!slug || !data) return json(400, { error: 'Missing slug or photo data.' }, c.headers);
  if (data.length > MAX_DATA_CHARS) return json(413, { error: 'Photo too large — keep it under about 3.5MB.' }, c.headers);
  if (!/^data:image\/(jpeg|jpg|png|webp);base64,/.test(data)) {
    return json(400, { error: 'Expected a base64 image dataURL.' }, c.headers);
  }

  const exec = process.env.SV_EXEC;
  const token = process.env.SV_SIGNUP_TOKEN;
  if (!exec || !token) return json(500, { error: 'Uploads are not configured yet.' }, c.headers);

  try {
    const res = await fetch(exec, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token, type: 'sitePhoto', slug, n, data }),
      redirect: 'follow'
    });
    const j = await res.json().catch(() => null);
    if (j && j.ok) return json(200, { ok: true, url: j.url || '' }, c.headers);
    return json(502, { error: (j && j.error) || 'Photo upload failed. Try again.' }, c.headers);
  } catch (e) {
    return json(502, { error: 'Photo upload failed. Try again.' }, c.headers);
  }
};
