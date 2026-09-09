/* Public retail products for a salon's website (the "add a product at checkout"
   upsell on the booking page). The product table is NOT anon-readable — it holds
   cost, SKU and stock — so the public site can't query it directly. This reads it
   server-side with the service role and returns ONLY the safe display fields:
   id, name, price (cents) and photo. Read-only GET, no credentials, open CORS so
   it works from every salon origin (salonvine.com, /s/<slug>, and *.salonvine.com
   subdomains alike). */

import { normSlug } from './_lib.js';
import { sbReady, sbSalon, sbSelect } from './_supabase.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, max-age=120',
  'Content-Type': 'application/json'
};

function reply(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: CORS });
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'GET') return reply(405, { error: 'Method not allowed' });

  const url = new URL(req.url);
  const slug = normSlug(url.searchParams.get('slug') || '');
  if (!slug) return reply(400, { ok: false, products: [] });
  if (!sbReady()) return reply(200, { ok: true, products: [] });

  try {
    const salon = await sbSalon(slug);
    if (!salon) return reply(200, { ok: true, products: [] });

    /* Only active products; only the public-safe columns. */
    const rows = await sbSelect(
      'product',
      `salon_id=eq.${salon.id}&is_active=eq.true&select=id,name,price,image_url,stock_qty&order=name.asc`
    );

    const products = (Array.isArray(rows) ? rows : [])
      .filter((r) => r && r.name)
      .map((r) => ({
        id: r.id,
        name: String(r.name).slice(0, 140),
        price: Number(r.price) || 0,          // cents
        image: r.image_url || ''
      }));

    return reply(200, { ok: true, products });
  } catch (e) {
    /* Never break the booking page over an upsell — just show nothing. */
    return reply(200, { ok: true, products: [] });
  }
};
