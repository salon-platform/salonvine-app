/* Portal photo upload — salon owner adds gallery shots, a logo, or a
   header (hero) photo from the portal's Website editor.

   POST {slug, data, kind} — salon ADMIN session required.
     data: base64 image dataURL (client resizes before upload)
     kind: 'gallery' (default) | 'logo' | 'hero'

   The registry stores the image in Drive and either appends it to the
   salon's photos array (gallery) or sets config.logo / config.heroImage
   (logo / hero). Tokens stay server-side, same as every other proxy. */

import { cors, json, parseBody, requireSalonSession } from './_lib.js';

const KINDS = ['gallery', 'logo', 'hero'];
const MAX_DATAURL_CHARS = 5500000; /* ~4MB image after base64 — client resizes far below this */

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

  const data = String(body.data || '');
  const kind = KINDS.includes(String(body.kind || 'gallery')) ? String(body.kind || 'gallery') : null;
  if (!kind) return json(400, { error: 'Unknown photo kind.' }, c.headers);
  if (!data.startsWith('data:image/')) return json(400, { error: 'Expected an image.' }, c.headers);
  if (data.length > MAX_DATAURL_CHARS) return json(413, { error: 'That image is too large — try a smaller one.' }, c.headers);

  const exec = process.env.SV_EXEC;
  const token = process.env.SV_SIGNUP_TOKEN;
  if (!exec || !token) return json(500, { error: 'Uploads are not configured yet.' }, c.headers);

  try {
    const res = await fetch(exec, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token, type: 'sitePhoto', slug, data, kind }),
      redirect: 'follow'
    });
    const out = await res.json().catch(() => null);
    if (out && out.ok) return json(200, out, c.headers);
    return json(502, { error: (out && out.error) || 'Upload failed. Try again in a minute.' }, c.headers);
  } catch (e) {
    return json(502, { error: 'Upload failed. Try again in a minute.' }, c.headers);
  }
};
