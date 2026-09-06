/* Public-site booking inquiry (contact form on a salon's site).
   Writes the lead to Supabase `site_lead` — no Apps Script — and mirrors it
   into the portal's booking list (Netlify Blobs) so staff see it immediately.
   The Supabase insert is self-healing: any column the table doesn't have is
   dropped and the insert retried, so schema differences can't break a lead. */

import { cors, json, parseBody, normSlug, getDataStore, bookingKey, newCode } from './_lib.js';
import { sbReady, sbSalon, sbWrite } from './_supabase.js';

/* Insert a row, surviving schema drift: on an unknown-column error, drop that
   column and retry. `keep` names columns that must never be stripped. */
async function insertResilient(table, row, keep) {
  const must = new Set(keep || []);
  let attempt = Object.assign({}, row);
  for (let i = 0; i < 14; i++) {
    try {
      const ins = await sbWrite(table, 'insert', '', attempt);
      return Array.isArray(ins) ? ins[0] : ins;
    } catch (e) {
      const m = String((e && e.message) || '');
      const mm = m.match(/Could not find the '([^']+)' column|column "([^"]+)"|'([^']+)' column/i);
      const col = mm && (mm[1] || mm[2] || mm[3]);
      if (col && Object.prototype.hasOwnProperty.call(attempt, col) && !must.has(col)) {
        delete attempt[col];
        continue;
      }
      throw e;
    }
  }
  throw new Error('too many unknown columns for ' + table);
}

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = await parseBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const slug = normSlug(body.slug);
  const name = String(body.name || '').trim().slice(0, 80);
  const phone = String(body.phone || '').replace(/[^\d+() .-]/g, '').slice(0, 20);
  const email = String(body.email || '').trim().slice(0, 254);
  const message = String(body.message || '').trim().slice(0, 2000);
  const service = String(body.service || '').trim().slice(0, 200);
  const stylist = String(body.stylist || '').trim().slice(0, 80);
  const when = String(body.when || '').trim().slice(0, 80);
  const date = String(body.date || '').trim().slice(0, 10);
  const time = String(body.time || '').trim().slice(0, 12);

  if (!slug) return json(400, { error: 'Missing salon.' }, c.headers);
  if (!name || (!phone && !email)) {
    return json(400, { error: 'Name plus a phone or email are required.' }, c.headers);
  }

  /* Both stores are best-effort: a lead must never be lost, so a failure in
     one path never fails the request as long as the other captured it. */
  let stored = false;

  /* 1) store the lead in Supabase */
  if (sbReady()) {
    try {
      const salon = await sbSalon(slug);
      if (salon) {
        await insertResilient('site_lead', {
          salon_id: salon.id, slug, name, phone, email, message,
          service, stylist, when, date, time
        }, ['name']);
        stored = true;
      }
    } catch (e) { /* fall through to the portal mirror */ }
  }

  /* 2) mirror into the portal booking list so staff see it immediately */
  let bookingId = '';
  try {
    const store = getDataStore();
    const id = `bk_${Date.now()}_${newCode(3)}`;
    await store.setJSON(bookingKey(slug, id), {
      id, ts: Date.now(), name, phone, email,
      service: service || message.slice(0, 200),
      stylist, when, date, time, message, status: 'new'
    });
    bookingId = id;
    stored = true;
  } catch (e2) { /* lead may still be in Supabase */ }

  if (!stored) return json(502, { error: 'Could not send your request. Try again.' }, c.headers);
  return json(200, { ok: true, bookingId }, c.headers);
};
