/* Salon website photos — the gallery the public site shows as its header
   slideshow, plus the logo. Owner/admin only, scoped to the session's salon.

   POST {slug, action:'add',    kind:'gallery'|'logo', data:<base64 dataURL>}
        -> {ok, url, photos:[url...]}
   POST {slug, action:'remove', url}          (gallery photo)   -> {ok, photos}
   POST {slug, action:'remove', kind:'logo'}                    -> {ok}

   Images land in the Supabase `salon-photos` bucket (same one stylist and
   product photos use); the gallery lives in the salon_photo table, which
   sv_site already reads, so the public site picks it up on the next load.
   Cap of 8 gallery photos — the site shows the first 5 in the header. */

import { cors, json, parseBody, requireSalonSession } from './_lib.js';
import { sbReady, sbSalon, sbSelect, sbWrite } from './_supabase.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zdlytaswwvemnlgnonnd.supabase.co';
const KEY = process.env.SUPABASE_SECRET_KEY || '';
const BUCKET = 'salon-photos';
const MAX_DATAURL = 5500000;
export const MAX_GALLERY = 8;

/* Push one image into storage. Returns its public URL. */
export async function storeImage(slug, folder, data) {
  const m = /^data:(image\/(png|jpe?g|webp));base64,(.+)$/i.exec(String(data || ''));
  if (!m) throw Object.assign(new Error('Expected a PNG, JPG or WebP image.'), { status: 400 });
  if (data.length > MAX_DATAURL) throw Object.assign(new Error('That image is too large — try a smaller one.'), { status: 413 });
  const mime = m[1];
  const ext = /png/i.test(mime) ? 'png' : /webp/i.test(mime) ? 'webp' : 'jpg';
  const bytes = Buffer.from(m[3], 'base64');
  const path = `${folder}/${slug}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + KEY, 'apikey': KEY, 'Content-Type': mime, 'x-upsert': 'true' },
    body: bytes
  });
  if (!res.ok) throw Object.assign(new Error('Upload failed: ' + (await res.text()).slice(0, 140)), { status: 502 });
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
}

/* Best-effort delete of one of OUR storage objects; anything else is ignored. */
async function dropImage(url) {
  const prefix = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/`;
  if (!String(url || '').startsWith(prefix)) return;
  const path = String(url).slice(prefix.length);
  await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'DELETE', headers: { 'Authorization': 'Bearer ' + KEY, 'apikey': KEY }
  }).catch(() => null);
}

export async function galleryUrls(salonId) {
  const rows = await sbSelect('salon_photo', `salon_id=eq.${salonId}&select=url,sort_order,created_at&order=sort_order.asc,created_at.asc`);
  return rows.map(r => r.url);
}

/* Add a gallery photo for a salon that is already looked up. Shared with the
   signup wizard's upload (site-photo-proxy.js). */
export async function addGalleryPhoto(salon, slug, data) {
  const rows = await sbSelect('salon_photo', `salon_id=eq.${salon.id}&select=id,sort_order`);
  if (rows.length >= MAX_GALLERY) {
    throw Object.assign(new Error(`You can have up to ${MAX_GALLERY} photos — remove one first.`), { status: 400 });
  }
  const url = await storeImage(slug, 'site', data);
  const next = rows.reduce((m, r) => Math.max(m, Number(r.sort_order) || 0), 0) + 1;
  await sbWrite('salon_photo', 'insert', '', { salon_id: salon.id, url, sort_order: next });
  return url;
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
  if (session.role !== 'admin') return json(403, { error: 'Only the salon owner can change the website photos.' }, c.headers);
  if (!KEY || !sbReady()) return json(500, { error: 'Uploads are not configured yet.' }, c.headers);

  try {
    const salon = await sbSalon(slug);
    if (!salon) return json(404, { error: 'Salon not found.' }, c.headers);

    const action = String(body.action || 'add');
    const kind = String(body.kind || 'gallery') === 'logo' ? 'logo' : 'gallery';

    if (action === 'remove') {
      if (kind === 'logo') {
        const cur = await sbSelect('salon', `id=eq.${salon.id}&select=logo_url`);
        await sbWrite('salon', 'update', `id=eq.${salon.id}`, { logo_url: null });
        if (cur[0] && cur[0].logo_url) await dropImage(cur[0].logo_url);
        return json(200, { ok: true }, c.headers);
      }
      const url = String(body.url || '').slice(0, 500);
      if (!url) return json(400, { error: 'Which photo?' }, c.headers);
      await sbWrite('salon_photo', 'delete', `salon_id=eq.${salon.id}&url=eq.${encodeURIComponent(url)}`);
      await dropImage(url);
      return json(200, { ok: true, photos: await galleryUrls(salon.id) }, c.headers);
    }

    /* add */
    if (kind === 'logo') {
      const url = await storeImage(slug, 'logo', body.data);
      const cur = await sbSelect('salon', `id=eq.${salon.id}&select=logo_url`);
      await sbWrite('salon', 'update', `id=eq.${salon.id}`, { logo_url: url });
      if (cur[0] && cur[0].logo_url) await dropImage(cur[0].logo_url);
      return json(200, { ok: true, url }, c.headers);
    }
    const url = await addGalleryPhoto(salon, slug, body.data);
    return json(200, { ok: true, url, photos: await galleryUrls(salon.id) }, c.headers);
  } catch (e) {
    const status = (e && e.status) || 502;
    return json(status, { error: (e && e.message) || 'Upload failed. Try again in a minute.' }, c.headers);
  }
};
