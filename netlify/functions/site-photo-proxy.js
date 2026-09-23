/* Signup-wizard photo upload. The wizard has no login yet, so this is the
   one photo path without a session — it is fenced two ways: the salon must
   have been created in the last 30 minutes (the wizard uploads seconds
   after signup), and the usual gallery cap applies. Photos go to the same
   place the portal's Website editor puts them (Supabase storage +
   salon_photo), so the public site shows them straight away. */

import { cors, json, parseBody, normSlug } from './_lib.js';
import { sbReady, sbSalon } from './_supabase.js';
import { addGalleryPhoto } from './salon-photo.js';

const MAX_DATA_CHARS = 5 * 1024 * 1024; // stays under the function payload cap
const FRESH_MS = 30 * 60 * 1000;

export default async (req, context) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = await parseBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const slug = normSlug(body.slug);
  const data = String(body.data || '');

  if (!slug || !data) return json(400, { error: 'Missing slug or photo data.' }, c.headers);
  if (data.length > MAX_DATA_CHARS) return json(413, { error: 'Photo too large — keep it under about 3.5MB.' }, c.headers);
  if (!/^data:image\/(jpeg|jpg|png|webp);base64,/.test(data)) {
    return json(400, { error: 'Expected a base64 image dataURL.' }, c.headers);
  }
  if (!sbReady()) return json(500, { error: 'Uploads are not configured yet.' }, c.headers);

  try {
    const salon = await sbSalon(slug);
    if (!salon) return json(404, { error: 'Salon not found.' }, c.headers);
    const age = Date.now() - (Date.parse(salon.created_at) || 0);
    if (!(age >= 0 && age < FRESH_MS)) {
      return json(403, { error: 'Add photos from your portal (My website) instead.' }, c.headers);
    }
    const url = await addGalleryPhoto(salon, slug, data);
    return json(200, { ok: true, url }, c.headers);
  } catch (e) {
    const status = (e && e.status) || 502;
    return json(status, { error: (e && e.message) || 'Photo upload failed. Try again.' }, c.headers);
  }
};
