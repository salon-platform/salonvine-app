/* Product photo upload for the Inventory screen. Owner/admin only, scoped to
   the session's salon. Takes a base64 image (the browser resizes it first),
   stores it in the Supabase `salon-photos` storage bucket, and returns the
   public URL — the Inventory screen then saves that URL on the product row.
   Uses the server-side service key, which never reaches a browser. */

import { cors, json, parseBody, requireSalonSession } from './_lib.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zdlytaswwvemnlgnonnd.supabase.co';
const KEY = process.env.SUPABASE_SECRET_KEY || '';
const BUCKET = 'salon-photos';
const MAX_DATAURL = 5500000; // ~4MB after base64; the client resizes far below this

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = await parseBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const guard = requireSalonSession(req, body.slug, c.headers);
  if (guard.errorResponse) return guard.errorResponse;
  const { session, slug } = guard;
  if (session.role !== 'admin') return json(403, { error: 'Only the owner can upload product photos.' }, c.headers);
  if (!KEY) return json(500, { error: 'Uploads are not configured yet.' }, c.headers);

  const data = String(body.data || '');
  const m = /^data:(image\/(png|jpe?g|webp));base64,(.+)$/i.exec(data);
  if (!m) return json(400, { error: 'Expected a PNG, JPG or WebP image.' }, c.headers);
  if (data.length > MAX_DATAURL) return json(413, { error: 'That image is too large — try a smaller one.' }, c.headers);

  const mime = m[1];
  const ext = /png/i.test(mime) ? 'png' : /webp/i.test(mime) ? 'webp' : 'jpg';
  const bytes = Buffer.from(m[3], 'base64');
  const path = `products/${slug}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  try {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + KEY, 'apikey': KEY, 'Content-Type': mime, 'x-upsert': 'true' },
      body: bytes
    });
    if (!res.ok) {
      const t = await res.text();
      return json(502, { error: 'Upload failed: ' + t.slice(0, 140) }, c.headers);
    }
    const url = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
    return json(200, { ok: true, url }, c.headers);
  } catch (e) {
    return json(502, { error: 'Upload failed. Try again in a minute.' }, c.headers);
  }
};
