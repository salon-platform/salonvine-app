/* Owner data import — "bring your salon over from your old software."
   POST { slug, type, rows:[{...}], dryRun? }  (owner/admin session required)

   The FRONT END does the messy part — reading a Vagaro / GlossGenius / Square /
   Booksy / generic CSV and mapping its columns onto the canonical keys below —
   so this function only ever sees clean, already-normalised rows. That keeps the
   format-guessing on the client (where we can show a preview) and keeps this
   endpoint simple, safe and idempotent.

   type -> target Supabase table + canonical row shape the client must send:
     services : service   { name, category, price (dollars or cents), minutes }
     products : product   { name, sku, price, stock }
     clients  : client    { name, email, phone, notes }
     staff    : stylist    { name, email, phone, role }
     hours    : salon_hours { weekday(0-6 or Mon..Sun), opens("09:00"), closes("17:00"), closed(bool) }
     appointments : appointment { date, start, end, duration, stylist, client, clientlast,
                    email, phone, services, price, status, notes } -> see _import-appointments.js

   EVERYTHING is scoped to the session's own salon — salon_id is resolved from
   the session slug server-side and NEVER taken from the client, so one salon can
   never write into another. Imports are idempotent: a row that already exists
   (matched on the dedupe key below) is skipped, so an owner can safely re-run an
   import or upload an overlapping file without creating duplicates.

   dryRun:true validates + dedupes and returns the same per-type counts WITHOUT
   writing anything — that powers the "here's what will import" preview. */

import {
  cors, json, parseBody, normEmail, requireSalonSession
} from './_lib.js';
import { sbReady, sbSalon, sbSelect, sbWrite } from './_supabase.js';
import { sbSelectAll } from './_page.js';
import { importAppointments } from './_import-appointments.js';
import { ensureStylistRow } from './availability.js';

/* A stylist can bring over their OWN book — their client list and their own
   calendar — but not salon-wide settings (menu, products, team, hours). */
const STYLIST_TYPES = ['clients', 'appointments'];

const MAX_ROWS = 5000;                 // one upload; the UI paginates past this
const TYPES = ['services', 'products', 'clients', 'staff', 'hours', 'appointments'];

/* ---- small helpers ---- */
const s = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 200);
const lc = v => s(v).toLowerCase();

/* "$45", "45.00", "4500c", 45 -> cents. Bare numbers <= 1000 are read as
   dollars (a $12 haircut), which is what every export means; append "c" or pass
   an integer field named *_cents to force cents. */
function toCents(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Math.round(v * (v < 1000 ? 100 : 1));
  let t = String(v).trim().toLowerCase().replace(/[$,\s]/g, '');
  const forceCents = t.endsWith('c');
  t = t.replace(/c$/, '');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return forceCents ? Math.round(n) : Math.round(n * 100);
}
function toInt(v) {
  const n = parseInt(String(v == null ? '' : v).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}
function phoneClean(v) {
  const t = s(v, 40).replace(/[^\d+()\-.\s]/g, '');
  return t.replace(/\D/g, '').length >= 7 ? t : '';
}

const slugify = name => s(name, 80).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'staff';
/* "Mon", "monday", "1" -> 0..6 (0 = Sunday), or null */
function weekdayOf(v) {
  const t = lc(v).slice(0, 3);
  const i = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(t);
  if (i >= 0) return i;
  const n = toInt(v);
  return n != null && n >= 0 && n <= 6 ? n : null;
}
/* "9", "09:00", "9:30 AM", "5pm" -> "HH:MM", or null */
function timeOf(v) {
  const t = lc(v).replace(/\s+/g, '');
  const m = /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?(am|pm|a|p)?$/.exec(t);
  if (!m) return null;
  let h = +m[1]; const mi = +(m[2] || 0);
  if (h > 23 || mi > 59) return null;
  if ((m[3] || '')[0] === 'p' && h < 12) h += 12;
  if ((m[3] || '')[0] === 'a' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

/* Per-type spec: which table, how to build a clean DB row from a canonical
   input row (or null to reject it), and the key used to dedupe. */
const SPECS = {
  services: {
    table: 'service',
    key: r => lc(r.name),
    build: r => {
      const name = s(r.name, 120);
      if (!name) return null;
      const cents = toCents(r.price_cents != null ? r.price_cents + 'c' : r.price);
      const minutes = toInt(r.minutes || r.duration);
      return {
        name, category: s(r.category, 60) || 'Other',
        price_cents: cents == null ? 0 : cents,
        duration_minutes: minutes == null ? 30 : Math.max(5, minutes),
        is_active: true
      };
    }
  },
  products: {
    table: 'product',
    key: r => lc(r.sku) || lc(r.name),
    build: r => {
      const name = s(r.name, 140);
      if (!name) return null;
      const cents = toCents(r.price_cents != null ? r.price_cents + 'c' : r.price);
      return {
        name, sku: s(r.sku, 60),
        price: cents == null ? 0 : cents,
        stock_qty: toInt(r.stock != null ? r.stock : r.stock_qty) || 0,
        is_active: true
      };
    }
  },
  clients: {
    table: 'client',
    key: r => normEmail(r.email) || phoneClean(r.phone) || lc(r.name),
    build: r => {
      const name = s(r.name, 120) || s(r.email, 120);
      const email = normEmail(r.email) || '';
      const phone = phoneClean(r.phone);
      if (!name && !email && !phone) return null;   // an empty line — drop it
      return { name: name || 'Client', email, phone };
    }
  },
  staff: {
    table: 'stylist',
    key: r => normEmail(r.email) || lc(r.name),
    build: r => {
      const name = s(r.name, 120);
      if (!name) return null;
      return {
        name, email: normEmail(r.email) || '', phone: phoneClean(r.phone),
        role: s(r.role, 60) || 'Stylist',
        slug: slugify(name),                 // made unique per salon before insert
        /* Imported staff start hidden + inactive-for-booking so an owner opts
           each person onto the public site and calendar deliberately. */
        is_public: false, is_active: true, booking_mode: 'request'
      };
    }
  },
  hours: {
    table: 'salon_hours',
    key: r => String(weekdayOf(r.weekday)),
    build: r => {
      const wd = weekdayOf(r.weekday);
      if (wd == null) return null;
      const opens = timeOf(r.opens), closes = timeOf(r.closes);
      const closed = r.closed === true || /^(y|yes|true|closed|1)$/i.test(s(r.closed)) || !opens || !closes;
      return { weekday: wd, is_closed: closed, opens_at: closed ? '00:00' : opens, closes_at: closed ? '00:00' : closes };
    }
  }
};

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);
  if (!sbReady()) return json(503, { error: 'Import is not switched on yet.' }, c.headers);

  const body = await parseBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const auth = requireSalonSession(req, body.slug, c.headers);
  if (auth.errorResponse) return auth.errorResponse;
  const { session, slug } = auth;
  const isAdmin = session.role === 'admin';

  const type = String(body.type || '').toLowerCase();
  if (TYPES.indexOf(type) === -1) return json(400, { error: 'Unknown import type.' }, c.headers);
  if (!isAdmin && STYLIST_TYPES.indexOf(type) === -1) {
    return json(403, { error: 'Only the owner can import that. You can bring over your clients and your own calendar.' }, c.headers);
  }
  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!rows) return json(400, { error: 'No rows to import.' }, c.headers);
  if (rows.length > MAX_ROWS) return json(413, { error: `That's ${rows.length} rows — please import ${MAX_ROWS} at a time.` }, c.headers);

  const spec = SPECS[type];
  const dryRun = body.dryRun === true;

  try {
    const salon = await sbSalon(slug);
    if (!salon) return json(404, { error: 'Salon not found.' }, c.headers);

    /* Bookings are a different animal (stylists, services, clients, times) —
       they have their own module. */
    if (type === 'appointments') {
      /* A stylist's own-calendar import is pinned to them; an owner import keeps
         the file's stylist column (they're bringing over the whole team). */
      let forceStylist = null;
      if (!isAdmin) {
        forceStylist = await ensureStylistRow(salon, { name: session.name, email: session.email });
        if (!forceStylist || !forceStylist.id) {
          return json(403, { error: 'We could not find your stylist profile to attach these appointments to. Ask the salon owner to confirm you are on the team.' }, c.headers);
        }
      }
      return json(200, await importAppointments({ salon, rows, dryRun, forceStylist }), c.headers);
    }

    /* Build clean rows, drop empties, and de-dupe within the file itself. */
    const seen = new Set();
    const clean = [];
    let invalid = 0;
    for (const raw of rows) {
      const built = spec.build(raw || {});
      if (!built) { invalid++; continue; }
      const k = spec.key(raw || {});
      if (k && seen.has(k)) continue;         // duplicate line in the same file
      if (k) seen.add(k);
      clean.push({ k, row: built });
    }

    /* Skip anything that already exists in the salon. Match on the same key. */
    const existing = await sbSelectAll(spec.table,
      `salon_id=eq.${salon.id}&select=*&order=id`).catch(() => []);
    const existingKeys = new Set();
    for (const e of existing) {
      // rebuild the dedupe key from the stored row using the same shape
      const asInput = type === 'clients' ? { email: e.email, phone: e.phone, name: e.name }
        : type === 'staff' ? { email: e.email, name: e.name }
        : type === 'products' ? { sku: e.sku, name: e.name }
        : type === 'hours' ? { weekday: e.weekday }
        : type === 'services' ? { name: e.name }
        : { name: e.name };
      const k = spec.key(asInput);
      if (k) existingKeys.add(k);
    }

    /* Opening hours are a weekly schedule, not a list — a day that already
       exists gets updated rather than skipped. */
    const toUpdate = type === 'hours' ? clean.filter(x => x.k && existingKeys.has(x.k)) : [];
    const toInsert = clean.filter(x => !x.k || !existingKeys.has(x.k));
    const skipped = clean.length - toInsert.length - toUpdate.length;

    if (type === 'staff') {
      const taken = new Set(existing.map(e => e.slug).filter(Boolean));
      toInsert.forEach(x => {
        let base = x.row.slug, slug = base, n = 1;
        while (taken.has(slug)) slug = `${base}-${++n}`;
        taken.add(slug); x.row.slug = slug;
      });
    }

    const summary = {
      type,
      received: rows.length,
      willImport: toInsert.length + toUpdate.length,
      willUpdate: toUpdate.length,
      alreadyThere: skipped,
      skippedBlank: invalid,
      preview: toInsert.slice(0, 8).map(x => x.row)
    };

    if (dryRun) return json(200, { ok: true, dryRun: true, ...summary }, c.headers);

    let imported = 0;
    for (const x of toUpdate) {
      await sbWrite(spec.table, 'update', `salon_id=eq.${salon.id}&weekday=eq.${x.row.weekday}`, x.row);
      imported++;
    }
    if (toInsert.length) {
      /* Insert in chunks so a big list can't blow the request size. */
      const CH = 200;
      for (let i = 0; i < toInsert.length; i += CH) {
        const batch = toInsert.slice(i, i + CH).map(x => ({ ...x.row, salon_id: salon.id }));
        const wrote = await sbWrite(spec.table, 'insert', null, batch);
        imported += Array.isArray(wrote) ? wrote.length : batch.length;
      }
    }

    return json(200, { ok: true, ...summary, imported }, c.headers);
  } catch (e) {
    return json(500, { error: `Import hit a snag: ${String((e && e.message) || e).slice(0, 160)}` }, c.headers);
  }
};
