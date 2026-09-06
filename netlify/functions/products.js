/* Retail products for the owner portal (Inventory screen). Owner/admin only,
   scoped to the session's own salon. Backed by the Supabase `product` table.
     GET  ?slug=            -> list this salon's products
     POST {action:'add'}    -> add a product (name required)         [default]
     POST {action:'stock'}  -> update just the stock count of one product
     POST {action:'delete'} -> remove one product
   salon_id is always resolved from the session, never taken from the client. */

import { cors, json, parseBody, requireSalonSession } from './_lib.js';
import { sbReady, sbSalon, sbSelect, sbWrite, isUuid } from './_supabase.js';
import { sbSelectAll } from './_page.js';

function centsFrom(v) {
  if (v === '' || v == null) return 0;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return (!Number.isFinite(n) || n < 0) ? 0 : Math.round(n * 100);
}
function intOf(v) {
  const n = parseInt(String(v == null ? '' : v).replace(/[^\d]/g, ''), 10);
  return (Number.isFinite(n) && n >= 0) ? n : 0;
}
function mapP(r) {
  return { id: r.id, name: r.name || '', sku: r.sku || '', price: r.price || 0, stock: r.stock_qty || 0, active: r.is_active !== false };
}

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  const isGet = req.method === 'GET';
  if (!isGet && req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = isGet ? null : await parseBody(req);
  if (!isGet && !body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const reqSlug = isGet ? new URL(req.url).searchParams.get('slug') : body.slug;
  const auth = requireSalonSession(req, reqSlug, c.headers);
  if (auth.errorResponse) return auth.errorResponse;
  const { session, slug } = auth;
  if (session.role !== 'admin') return json(403, { error: 'Owner access only.' }, c.headers);

  if (!sbReady()) return json(200, { ok: true, products: [] }, c.headers);

  try {
    const salon = await sbSalon(slug);
    if (!salon) return json(404, { error: 'Salon not found.' }, c.headers);

    if (isGet) {
      const rows = await sbSelectAll('product', `salon_id=eq.${salon.id}&select=*&order=name.asc`);
      return json(200, { ok: true, products: rows.map(mapP) }, c.headers);
    }

    const action = String(body.action || 'add');

    if (action === 'delete') {
      const ids = Array.isArray(body.ids) ? body.ids.filter(isUuid) : (isUuid(body.id) ? [body.id] : []);
      if (!ids.length) return json(400, { error: 'Nothing selected.' }, c.headers);
      await sbWrite('product', 'delete', `id=in.(${ids.join(',')})&salon_id=eq.${salon.id}`);
      return json(200, { ok: true, removed: ids.length }, c.headers);
    }

    if (action === 'stock') {
      if (!isUuid(body.id)) return json(400, { error: 'Bad id' }, c.headers);
      const rows = await sbWrite('product', 'update', `id=eq.${body.id}&salon_id=eq.${salon.id}`, { stock_qty: intOf(body.stock) });
      return json(200, { ok: true, product: mapP(rows[0] || {}) }, c.headers);
    }

    // add
    const name = String(body.name || '').trim().slice(0, 140);
    if (!name) return json(400, { error: 'Give the product a name.' }, c.headers);
    const row = {
      salon_id: salon.id, name,
      sku: String(body.sku || '').trim().slice(0, 60),
      price: centsFrom(body.price), stock_qty: intOf(body.stock), is_active: true
    };
    const rows = await sbWrite('product', 'insert', null, [row]);
    return json(200, { ok: true, product: mapP(rows[0] || row) }, c.headers);
  } catch (e) {
    return json(500, { error: 'Could not save that. ' + String((e && e.message) || '').slice(0, 120) }, c.headers);
  }
};
