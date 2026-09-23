/* What happens AFTER a checkout is paid — shared by the card path
   (pos-confirm, once Stripe says "paid") and the cash/other path
   (pos-cash, the moment the stylist taps "Paid another way").

   Three side effects, each claimed with a marker so the portal's polling
   (twenty polls, one sale) can never double-count:
     - the booking it came from is marked paid (Supabase appointment row,
       or the older Blobs request note)
     - retail on the sale comes off the shelf
     - the customer gets a text/email receipt

   None of these may ever make a paid sale look unpaid, so every step
   swallows its own errors. */

import { getDataStore, bookingKey, getSalonRegistry, relayMail } from './_lib.js';
import { sbReady, sbSalon, sbSelect, sbWrite, isUuid } from './_supabase.js';

export function fmtCents(c) { return '$' + (Number(c || 0) / 100).toFixed(2); }

/* Mark the booking paid, once. method: 'card' | 'cash' | 'other'. */
export async function markBookingPaid(slug, bookingId, { amountCents, tipCents, method, ref }) {
  if (!bookingId) return;
  try {
    if (isUuid(bookingId) && sbReady()) {
      const salon = await sbSalon(slug);
      if (!salon) return;
      /* Scoped to the salon: one stray id must never pay off another salon's booking. */
      await sbWrite('appointment', 'update',
        `id=eq.${bookingId}&salon_id=eq.${salon.id}&paid_at=is.null`, {
          paid_at: new Date().toISOString(),
          paid_cents: Math.round(Number(amountCents) || 0),
          paid_tip_cents: Math.round(Number(tipCents) || 0),
          paid_method: String(method || 'card').slice(0, 20),
          paid_ref: String(ref || '').slice(0, 120) || null
        });
      return;
    }
    const store = getDataStore();
    const key = bookingKey(slug, bookingId);
    const booking = await store.get(key, { type: 'json' });
    if (booking && !booking.posPaid) {
      await store.setJSON(key, {
        ...booking,
        posPaid: true, posPaidCents: amountCents, posTipCents: tipCents,
        posPaidAt: Date.now(), posSessionId: ref || '', posMethod: method || 'card'
      });
    }
  } catch (e) { /* a paid sale must never look unpaid over a storage hiccup */ }
}

/* Take sold retail off the shelf, once per sale (markerId). Claim the
   marker BEFORE touching stock: a missed decrement is a counting error the
   owner can fix on Inventory, a double decrement is one she cannot spot. */
export async function takeStockOff(slug, markerId, soldItems) {
  try {
    if (!soldItems || !soldItems.length || !sbReady()) return;
    const store = getDataStore();
    const marker = `s/${slug}/pos-stock/${markerId}`;
    const done = await store.get(marker, { type: 'json' }).catch(() => null);
    if (done) return;
    await store.setJSON(marker, { at: Date.now() });
    const ids = [...new Set(soldItems.map(i => String(i.id || '')).filter(isUuid))];
    const salon = ids.length ? await sbSalon(slug) : null;
    if (!ids.length || !salon) return;
    const rows = await sbSelect('product',
      `salon_id=eq.${salon.id}&id=in.(${ids.join(',')})&select=id,stock_qty`);
    const have = new Map(rows.map(r => [r.id, Number(r.stock_qty) || 0]));
    for (const it of soldItems) {
      if (!have.has(it.id)) continue;
      const left = Math.max(0, have.get(it.id) - (Number(it.qty) || 0));
      await sbWrite('product', 'update',
        `id=eq.${it.id}&salon_id=eq.${salon.id}`, { stock_qty: left }).catch(() => null);
    }
  } catch (e) { /* stock is a count, not the payment */ }
}

/* Customer receipt — text + email, once per sale (markerId). Ends with the
   thing that brings them back. feeCents is 0 for cash. */
export async function sendReceipt(slug, markerId, {
  custPhone, custEmail, service, serviceCents, soldItems, baseCents, tipCents, feeCents, amountCents, method
}) {
  if (!custPhone && !custEmail) return;
  try {
    const store = getDataStore();
    const marker = `s/${slug}/receipts/${markerId}`;
    const sent = await store.get(marker, { type: 'json' }).catch(() => null);
    if (sent) return;
    await store.setJSON(marker, { at: Date.now() }); // claim first: a double-send beats none, a race beats spam
    const reg = await getSalonRegistry(slug).catch(() => null);
    const salonName = (reg && reg.name) || 'Your salon';
    const bookUrl = `https://salonvine.com/s/${slug}`;
    const svc = String(service || '').trim() || 'Salon service';
    const items = soldItems || [];
    const paidHow = method === 'cash' ? ' (cash)' : method === 'other' ? '' : '';

    if (custPhone) {
      await relayMail({
        sms: { phone: custPhone },
        text: `${salonName}: ${fmtCents(amountCents)} paid${paidHow} — thank you! `
          + `Book your next appointment: ${bookUrl}`
      }).catch(() => null);
    }
    if (custEmail) {
      await relayMail({
        to: custEmail,
        subject: `Your receipt from ${salonName}`,
        text: `${salonName} — receipt\n`
          + `${'-'.repeat(30)}\n`
          + `${Number(serviceCents) > 0 ? `${svc}  ${fmtCents(Number(serviceCents))}\n` : ''}`
          + `${items.map(i => `${i.name}${i.qty > 1 ? ` x${i.qty}` : ''}  ${fmtCents(i.unit * i.qty)}\n`).join('')}`
          + `${(!Number(serviceCents) && !items.length) ? `${svc}  ${fmtCents(baseCents)}\n` : ''}`
          + `${tipCents ? `Tip  ${fmtCents(tipCents)}\n` : ''}`
          + `${feeCents ? `Card processing fee  ${fmtCents(feeCents)}\n` : ''}`
          + `${'-'.repeat(30)}\n`
          + `Total paid  ${fmtCents(amountCents)}${method === 'cash' ? '  (cash)' : ''}\n`
          + `${new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' })}\n\n`
          + `Thank you!\n\n`
          + `Book your next appointment:\n${bookUrl}`
      }).catch(() => null);
    }
  } catch (e) { /* a receipt hiccup must never make a paid sale look unpaid */ }
}

/* Cash / other sales live in Blobs, newest first on read. One record per sale. */
export function cashSaleKey(slug, saleId) { return `s/${slug}/cash-sales/${saleId}`; }
export function cashSalesPrefix(slug) { return `s/${slug}/cash-sales/`; }
