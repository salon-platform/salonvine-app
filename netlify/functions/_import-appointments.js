/* Bookings import — "bring your calendar over from your old software."
   Used by import-data.js when type === 'appointments'.

   The front end sends canonical rows:
     { date, start, end, duration, stylist, client, email, phone,
       services, price, status, notes }
   (all strings, straight from the CSV — GlossGenius, Vagaro, Square, Booksy
   or a plain spreadsheet). This module turns them into real appointments:

     * the stylist is matched by name against the salon's team. A name we
       don't know gets a hidden team entry created for it (the owner switches
       them on later); a blank name goes under "Unassigned".
     * services are matched by name; a service we've never seen is created
       (hidden from the public menu) so old bookings keep their history.
     * the client is matched by email, then phone, then name; else created.
     * one line per service (GlossGenius style) is folded back into one
       booking when the stylist, client, date and start time match.
     * the database function sv_import_appointments does the writing: past
       bookings land as "completed", future ones as "confirmed", nothing
       emails or texts anyone, and a booking that's already there or that
       overlaps another one for the same stylist is skipped and reported.

   dryRun:true does all the matching and returns the counts without writing
   a thing (it does not create the missing services either). */

import { sbSelect, sbWrite, sbRpc } from './_supabase.js';
import { sbSelectAll } from './_page.js';

const s = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 200);
const squash = v => s(v, 200).toLowerCase().replace(/[^a-z0-9]/g, '');
const digits = v => s(v, 40).replace(/\D/g, '');

function toCents(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Math.round(v * 100);
  const t = String(v).replace(/[^0-9.\-]/g, '');
  if (!t || !/^-?\d*(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
function toInt(v) {
  const n = parseInt(String(v == null ? '' : v).replace(/[^\d-]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

/* ---------- dates & times ---------- */
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

/* "9/6/2026", "2026-09-06", "Sep 6, 2026", "6 Sep 2026", "Saturday, September 6, 2026"
   -> {y,m,d} or null. Anything after the date (a time) is returned as `rest`. */
function parseDate(v) {
  let t = s(v, 60).replace(/^[a-z]+day,?\s*/i, '');        // drop "Saturday, "
  let m;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(.*)$/.exec(t)))
    return { y: +m[1], mo: +m[2], d: +m[3], rest: m[4] };
  if ((m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})(.*)$/.exec(t))) {
    let y = +m[3]; if (y < 100) y += 2000;
    return { y, mo: +m[1], d: +m[2], rest: m[4] };          // US month/day
  }
  if ((m = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(.*)$/i.exec(t))) {
    const mo = MONTHS[m[1].slice(0, 4).toLowerCase()] || MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) return { y: +m[3], mo, d: +m[2], rest: m[4] };
  }
  if ((m = /^(\d{1,2})\s+([a-z]{3,9})\.?,?\s+(\d{4})(.*)$/i.exec(t))) {
    const mo = MONTHS[m[2].slice(0, 4).toLowerCase()] || MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) return { y: +m[3], mo, d: +m[1], rest: m[4] };
  }
  return null;
}

/* "10:00 AM", "1:30pm", "13:30", "10am", "10:00:00", "T10:00:00" -> minutes past midnight, or null */
function parseTime(v) {
  const pd = parseDate(v);                                  // "9/6/2026 10:00 AM" -> just the time part
  if (pd) return parseTime(pd.rest);
  const t = s(v, 30).toLowerCase().replace(/^[t,\s]+/, '').replace(/\s+/g, '');
  const m = /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?(?:\.\d+)?(a\.?m\.?|p\.?m\.?)?/.exec(t);
  if (!m) return null;
  let h = +m[1]; const mi = +(m[2] || 0);
  const ap = m[3] ? m[3][0] : '';
  if (h > 23 || mi > 59) return null;
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  return h * 60 + mi;
}

/* An ISO stamp with a zone ("2026-09-06T14:00:00Z", "...-04:00") is a real
   instant: turn it into wall-clock in the salon's timezone. */
function zonedToLocal(v, tz) {
  const t = s(v, 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(t)) return null;
  const d = new Date(t);
  if (isNaN(d)) return null;
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(d).forEach(x => { p[x.type] = x.value; });
  return { y: +p.year, mo: +p.month, d: +p.day, min: (+p.hour % 24) * 60 + (+p.minute) };
}

/* Wall-clock in the salon's timezone -> UTC ms (for the "already there" check). */
function localToUtc(y, mo, d, min, tz) {
  const guess = Date.UTC(y, mo - 1, d, Math.floor(min / 60), min % 60);
  const off = t => {
    const p = {};
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date(t)).forEach(x => { p[x.type] = x.value; });
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - t;
  };
  let utc = guess - off(guess);
  utc = guess - off(utc);
  return utc;
}

const pad = n => String(n).padStart(2, '0');
const localStamp = (y, mo, d, min) => `${y}-${pad(mo)}-${pad(d)} ${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
function prettyWhen(y, mo, d, min) {
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let h = Math.floor(min / 60), ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return `${M[mo - 1]} ${d}, ${y} ${h}:${pad(min % 60)} ${ap}`;
}

/* GlossGenius / Vagaro / Square wording -> our statuses ('' = let the calendar decide) */
function mapStatus(v) {
  const t = s(v, 40).toLowerCase();
  if (/cancel|declin|void|refund/.test(t)) return 'cancelled';
  if (/no.?show|noshow|missed/.test(t)) return 'no_show';
  if (/complet|checked.?out|paid|closed|done|finish/.test(t)) return 'completed';
  return '';
}

/* "Balayage, Toner; Blowout" -> ["Balayage","Toner","Blowout"] */
function splitServices(v) {
  return s(v, 600).split(/\s*(?:,|;|\||\n|\s\+\s)\s*/).map(x => x.trim()).filter(Boolean).slice(0, 8);
}

/* ---------- name matching ---------- */
function matchStylist(name, stylists) {
  const q = squash(name);
  if (!q) return null;
  let hit = stylists.find(x => x.q === q);
  if (hit) return hit;
  const first = squash(s(name).split(/\s+/)[0]);
  const byFirst = stylists.filter(x => x.first === first);
  if (byFirst.length === 1) return byFirst[0];
  hit = stylists.find(x => x.q.startsWith(q) || q.startsWith(x.q));
  return hit || null;
}
function matchService(name, services) {
  const q = squash(name);
  if (!q) return null;
  return services.find(x => x.q === q)
      || services.find(x => x.q.startsWith(q) || q.startsWith(x.q))
      || null;
}

/* ---------- the import ---------- */
export async function importAppointments({ salon, rows, dryRun }) {
  const tz = salon.timezone || 'America/Anchorage';

  const [stylistRows, serviceRows] = await Promise.all([
    sbSelect('stylist', `salon_id=eq.${salon.id}&select=id,name,slug,is_active&order=sort_order`),
    sbSelectAll('service', `salon_id=eq.${salon.id}&select=id,name,price_cents,duration_minutes&order=id`)
  ]);
  const stylists = stylistRows.map(x => ({ id: x.id, name: x.name, slug: x.slug, q: squash(x.name), first: squash(s(x.name).split(/\s+/)[0]) }));
  const slugify = name => s(name, 80).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'staff';
  const services = serviceRows.map(x => ({ id: x.id, name: x.name, q: squash(x.name), price_cents: x.price_cents || 0, minutes: x.duration_minutes || 60 }));

  /* 1. read every line */
  const parsed = [];
  const unknownStylists = {};
  const newServices = {};              // name -> {price_cents}
  let blank = 0, badDate = 0, noTime = 0;
  for (const raw of rows) {
    const r = raw || {};
    const stylistName = s(r.stylist, 120);
    const dateStr = s(r.date, 60), startStr = s(r.start, 40), endStr = s(r.end, 40);
    if (!stylistName && !dateStr && !s(r.client)) { blank++; continue; }

    /* when */
    let y, mo, d, min;
    let dt = zonedToLocal(dateStr, tz);
    if (dt) {
      ({ y, mo, d, min } = dt);
      const t = startStr && !zonedToLocal(startStr, tz) ? parseTime(startStr) : null;
      if (t != null) min = t;
    } else if ((dt = zonedToLocal(startStr, tz))) {
      ({ y, mo, d, min } = dt);
    } else {
      const pd = parseDate(dateStr);
      if (!pd) { badDate++; continue; }
      ({ y, mo, d } = pd);
      min = parseTime(startStr);
      if (min == null) min = parseTime(pd.rest);
      if (min == null) { noTime++; continue; }
    }
    let endMin = null;
    const ze = zonedToLocal(endStr, tz);
    if (ze) endMin = ze.min + ((ze.y !== y || ze.mo !== mo || ze.d !== d) ? 24 * 60 : 0);
    else if (endStr) endMin = parseTime(endStr);
    const dur = toInt(r.duration);
    if ((endMin == null || endMin <= min) && dur && dur > 0) endMin = min + dur;

    /* who — a name we don't know gets a hidden team entry made for it (the
       owner switches them on later); a blank name goes under "Unassigned" */
    let st = matchStylist(stylistName, stylists);
    if (!st) {
      const label = stylistName || 'Unassigned';
      st = { id: null, pending: squash(label), name: label, q: squash(label), first: squash(label.split(/\s+/)[0]) };
      stylists.push(st);                                 // so the next row with this name reuses it
    }
    if (st.pending) unknownStylists[st.name] = (unknownStylists[st.name] || 0) + 1;

    /* what */
    const names = splitServices(r.services);
    const total = toCents(r.price);
    const svc = names.map(n => {
      const hit = matchService(n, services);
      if (hit) return { id: hit.id, name: hit.name, minutes: hit.minutes, price_cents: hit.price_cents };
      const key = squash(n);
      if (!newServices[key]) newServices[key] = { name: s(n, 120), price_cents: names.length === 1 && total != null ? total : 0 };
      return { id: null, key, name: s(n, 120), minutes: 60, price_cents: newServices[key].price_cents };
    });

    parsed.push({
      key: `${st.id || 'new:' + st.pending}|${y}-${mo}-${d}|${min}|${squash(r.email) || digits(r.phone) || squash(r.client)}`,
      stylist: st, y, mo, d, min, endMin, dur, svc, total,
      client_name: [s(r.client, 80), s(r.clientlast, 60)].filter(Boolean).join(' '), client_email: s(r.email, 160).toLowerCase(), client_phone: s(r.phone, 40),
      status: mapStatus(r.status), note: s(r.notes, 500)
    });
  }

  /* 2. fold one-line-per-service exports back into one booking */
  const byKey = new Map();
  for (const p of parsed) {
    const have = byKey.get(p.key);
    if (!have) { byKey.set(p.key, p); continue; }
    for (const x of p.svc) if (!have.svc.some(h => (h.id && h.id === x.id) || (h.key && h.key === x.key))) have.svc.push(x);
    if (p.total != null) have.total = (have.total || 0) + p.total;
    if (p.endMin != null && (have.endMin == null || p.endMin > have.endMin)) have.endMin = p.endMin;
    if (!have.note && p.note) have.note = p.note;
  }
  const bookings = [...byKey.values()];

  /* 3. finish the times: end = given, else start + service minutes */
  for (const b of bookings) {
    if (b.endMin == null || b.endMin <= b.min) {
      const sum = b.svc.reduce((a, x) => a + (x.minutes || 0), 0);
      b.endMin = b.min + (sum > 0 ? sum : 60);
    }
    /* spread the booking's length over its services */
    const len = b.endMin - b.min, n = b.svc.length || 1;
    const each = Math.max(5, Math.floor(len / n));
    b.svc.forEach((x, i) => { x.minutes = i === 0 ? Math.max(5, len - each * (n - 1)) : each; });
    if (b.total == null) b.total = b.svc.reduce((a, x) => a + (x.price_cents || 0), 0);
    if (b.svc.length === 1) b.svc[0].price_cents = b.total;
    b.startsUtc = localToUtc(b.y, b.mo, b.d, b.min, tz);
  }

  /* 4. already there? (same stylist + same start, not cancelled) */
  let already = 0;
  const fresh = [];
  if (bookings.length) {
    const lo = new Date(Math.min(...bookings.map(b => b.startsUtc))).toISOString();
    const hi = new Date(Math.max(...bookings.map(b => b.startsUtc))).toISOString();
    const existing = await sbSelectAll('appointment',
      `salon_id=eq.${salon.id}&select=stylist_id,starts_at&starts_at=gte.${encodeURIComponent(lo)}&starts_at=lte.${encodeURIComponent(hi)}&status=not.in.(cancelled,declined,expired)&order=starts_at`).catch(() => []);
    const have = new Set(existing.map(e => `${e.stylist_id}|${Date.parse(e.starts_at)}`));
    for (const b of bookings) {
      if (have.has(`${b.stylist.id}|${b.startsUtc}`)) already++; else fresh.push(b);
    }
  }
  fresh.sort((a, b) => a.startsUtc - b.startsUtc);

  const unknownList = Object.keys(unknownStylists).map(n => ({ name: n, rows: unknownStylists[n] }));
  const pendingStylists = stylists.filter(x => x.pending);
  const summary = {
    type: 'appointments',
    received: rows.length,
    willImport: fresh.length,
    alreadyThere: already,
    skippedBlank: blank + badDate + noTime,
    badDates: badDate,
    noTimes: noTime,
    newStylists: unknownList,
    newStylistRows: unknownList.reduce((a, x) => a + x.rows, 0),
    newServices: Object.values(newServices).map(x => x.name),
    preview: fresh.slice(0, 8).map(b => ({
      when: prettyWhen(b.y, b.mo, b.d, b.min), stylist: b.stylist.name, client: b.client_name || b.client_email || b.client_phone || '—',
      services: b.svc.map(x => x.name).join(', '), price: b.total, status: b.status || (b.startsUtc < Date.now() ? 'completed' : 'confirmed')
    }))
  };
  if (dryRun) return { ok: true, dryRun: true, ...summary };

  /* 5a. create team entries for names we've never seen (hidden, off the
     public site and calendar until the owner switches them on) */
  if (pendingStylists.length) {
    const taken = new Set(stylists.map(x => x.slug).filter(Boolean));
    const batch = pendingStylists.map(x => {
      let slug = slugify(x.name), n = 1;
      while (taken.has(slug)) slug = `${slugify(x.name)}-${++n}`;
      taken.add(slug);
      return { salon_id: salon.id, name: x.name, slug, role: 'Stylist', is_public: false, is_active: true, booking_mode: 'request' };
    });
    const wrote = await sbWrite('stylist', 'insert', null, batch);
    (wrote || []).forEach(w => { const hit = pendingStylists.find(x => x.q === squash(w.name)); if (hit) hit.id = w.id; });
    const lost = pendingStylists.filter(x => !x.id);
    if (lost.length) throw new Error(`could not add team member "${lost[0].name}"`);
  }

  /* 5b. create the services we've never seen (hidden from the public menu) */
  const created = {};
  const need = Object.keys(newServices);
  if (need.length) {
    const batch = need.map(k => ({
      salon_id: salon.id, name: newServices[k].name, category: 'Other',
      price_cents: newServices[k].price_cents || 0, duration_minutes: 60, is_active: false
    }));
    const wrote = await sbWrite('service', 'insert', null, batch);
    (wrote || []).forEach(w => { created[squash(w.name)] = w.id; });
  }

  /* 6. write, in bites */
  let imported = 0, skipped = 0, failed = 0;
  const errors = {};
  const CH = 100;
  for (let i = 0; i < fresh.length; i += CH) {
    const chunk = fresh.slice(i, i + CH).map(b => ({
      stylist_id: b.stylist.id,
      starts_local: localStamp(b.y, b.mo, b.d, b.min),
      ends_local: localStamp(b.y, b.mo, b.d, b.endMin),
      client_name: b.client_name, client_email: b.client_email, client_phone: b.client_phone,
      services: b.svc.map(x => ({ id: x.id || created[x.key], minutes: x.minutes, price_cents: x.price_cents })).filter(x => x.id),
      price_cents: b.total || 0, status: b.status, note: b.note
    }));
    const out = await sbRpc('sv_import_appointments', { p_salon_id: salon.id, p_rows: chunk });
    for (const r of (out || [])) {
      if (r && r.ok) imported++;
      else if (r && r.skip) skipped++;
      else { failed++; const e = (r && r.error) || 'unknown'; errors[e] = (errors[e] || 0) + 1; }
    }
  }

  return { ok: true, ...summary, imported, alreadyThere: already + skipped, failed,
           errors: Object.keys(errors).map(e => ({ error: e, rows: errors[e] })) };
}
