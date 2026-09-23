/* Ring up a sale that was paid some other way — cash, Venmo, a gift card,
   whatever. No Stripe involved, no card fee. Works whether or not the salon
   has Stripe connected, so a salon can record every sale from day one.

   POST {slug, amountCents, tipCents, bookingId?, service?, client?, saleId,
         items:[{id, qty}], customerPhone?, customerEmail?, method:'cash'|'other'}
     -> {ok, saleId, baseCents, tipCents, totalCents}

   Same people as pos-checkout (any signed-in staff member). Retail is
   priced from the salon's own product table, never the browser. The sale
   is written to Blobs (cash-sales/<saleId>) so it shows in Sales history,
   the booking it came from is marked paid, stock comes off the shelf and
   the customer gets a receipt — all through the shared _pos.js helpers. */

import {
  cors, json, parseBody, normId, requireSalonSession, getDataStore, userKey
} from './_lib.js';
import { canSellProducts } from './_stripe.js';
import { sbReady, sbSalon, sbSelect, isUuid } from './_supabase.js';
import { markBookingPaid, takeStockOff, sendReceipt, cashSaleKey } from './_pos.js';

const MAX_CENTS = 1000000;    /* $10,000 sanity cap per sale */
const MAX_TIP_CENTS = 500000; /* $5,000 tip cap */

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = await parseBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const guard = requireSalonSession(req, body.slug, c.headers);
  if (guard.errorResponse) return guard.errorResponse;
  const { session, slug } = guard;

  try {
    const user = session.role === 'admin'
      ? { role: 'admin', email: session.email }
      : ((await getDataStore().get(userKey(slug, session.email), { type: 'json' }))
         || { role: 'stylist', email: session.email });

    let serviceCents = Math.round(Number(body.amountCents) || 0);
    if (!Number.isFinite(serviceCents) || serviceCents < 0 || serviceCents > MAX_CENTS) {
      return json(400, { error: 'Enter an amount up to $10,000.' }, c.headers);
    }

    /* Retail — priced from the salon's own table, same as the card path. */
    const wanted = Array.isArray(body.items) ? body.items.slice(0, 40) : [];
    const products = [];
    let productCents = 0;
    if (wanted.length) {
      if (!canSellProducts(user)) {
        return json(403, { error: 'The owner has not switched on product sales for you.' }, c.headers);
      }
      if (!sbReady()) return json(503, { error: 'Products are not available right now.' }, c.headers);
      const salon = await sbSalon(slug);
      if (!salon) return json(404, { error: 'Salon not found.' }, c.headers);
      const ids = [...new Set(wanted.map(i => String((i && i.id) || '')).filter(isUuid))];
      if (!ids.length) return json(400, { error: 'Those products are no longer on your list.' }, c.headers);
      const rows = await sbSelect('product',
        `salon_id=eq.${salon.id}&id=in.(${ids.join(',')})&select=id,name,price,stock_qty,is_active`);
      const byId = new Map(rows.map(r => [r.id, r]));
      for (const it of wanted) {
        const row = byId.get(String((it && it.id) || ''));
        if (!row || row.is_active === false) continue;
        let qty = Math.round(Number(it.qty) || 0);
        if (!Number.isFinite(qty) || qty < 1) continue;
        qty = Math.min(qty, 99);
        const unit = Math.round(Number(row.price) || 0);
        if (unit <= 0) continue;
        products.push({ id: row.id, name: String(row.name || 'Product').slice(0, 80), unit, qty });
        productCents += unit * qty;
      }
      if (!products.length) {
        return json(400, { error: 'None of those products could be added. Check they still have a price.' }, c.headers);
      }
    }

    const baseCents = serviceCents + productCents;
    if (baseCents <= 0 || baseCents > MAX_CENTS) {
      return json(400, { error: 'The sale has to come to between $0.01 and $10,000.' }, c.headers);
    }
    let tipCents = Math.round(Number(body.tipCents) || 0);
    if (!Number.isFinite(tipCents) || tipCents < 0) tipCents = 0;
    tipCents = Math.min(tipCents, MAX_TIP_CENTS);
    const totalCents = baseCents + tipCents;

    const method = String(body.method || 'cash').toLowerCase() === 'other' ? 'other' : 'cash';
    const bookingId = normId(body.bookingId || '') || '';
    const service = String(body.service || '').trim().slice(0, 80);
    const client = String(body.client || '').trim().slice(0, 80);
    const saleId = String(body.saleId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)
      || `${Date.now()}`;
    const custPhone = String(body.customerPhone || '').replace(/[^0-9+]/g, '').slice(0, 16);
    const custEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.customerEmail || '').trim())
      ? String(body.customerEmail).trim().slice(0, 120) : '';

    /* The sale record — written first and only once. A double-tap on the
       same saleId just returns the sale that already exists. */
    const store = getDataStore();
    const key = cashSaleKey(slug, saleId);
    const existing = await store.get(key, { type: 'json' }).catch(() => null);
    if (existing) {
      return json(200, { ok: true, saleId, baseCents: existing.baseCents, tipCents: existing.tipCents, totalCents: existing.totalCents, repeat: true }, c.headers);
    }
    const sale = {
      id: saleId, kind: 'cash', method, created: Date.now(),
      slug, staff: String(session.email || '').slice(0, 120),
      bookingId, service, client,
      serviceCents, productCents, baseCents, tipCents, feeCents: 0, totalCents,
      items: products.map(pr => ({ id: pr.id, name: pr.name, unit: pr.unit, qty: pr.qty })),
      custPhone, custEmail
    };
    try {
      await store.setJSON(key, sale);
    } catch (e) {
      return json(503, { error: 'Could not save the sale just now. Try again in a moment.' }, c.headers);
    }

    await markBookingPaid(slug, bookingId, { amountCents: totalCents, tipCents, method, ref: `cash_${saleId}` });
    await takeStockOff(slug, `cash_${saleId}`, sale.items);
    await sendReceipt(slug, `cash_${saleId}`, {
      custPhone, custEmail, service, serviceCents, soldItems: sale.items,
      baseCents, tipCents, feeCents: 0, amountCents: totalCents, method
    });

    return json(200, { ok: true, saleId, baseCents, tipCents, totalCents }, c.headers);
  } catch (e) {
    return json(502, { error: 'Could not record the sale. Try again in a minute.' }, c.headers);
  }
};
