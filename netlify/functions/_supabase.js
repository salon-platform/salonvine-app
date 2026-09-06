/* Supabase — the new home for salons, stylists, appointments and clients.
   Every function that used to ask Apps Script goes through here instead.
   Server-side only: uses the secret key, which never reaches a browser. */

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zdlytaswwvemnlgnonnd.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || '';

export function sbReady() { return !!SUPABASE_KEY; }

function headers(extra) {
  return Object.assign({
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json'
  }, extra || {});
}

/* REST read: sbSelect('appointment', 'salon_id=eq.X&select=id,status') */
export async function sbSelect(table, query) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: headers() });
  const text = await res.text();
  if (!res.ok) throw new Error(`${table} ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : [];
}

/* REST write. op = 'insert' | 'update' | 'delete'. Returns the affected rows. */
export async function sbWrite(table, op, filter, body) {
  const method = op === 'insert' ? 'POST' : op === 'update' ? 'PATCH' : 'DELETE';
  const url = `${SUPABASE_URL}/rest/v1/${table}${filter ? '?' + filter : ''}`;
  const res = await fetch(url, {
    method, headers: headers({ 'Prefer': 'return=representation' }),
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${table} ${op} ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : [];
}

export async function sbRpc(name, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: headers(), body: JSON.stringify(args || {})
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${name} ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/* The salon row, or null. Slug matching ignores hyphens, like everywhere else. */
export async function sbSalon(slug) {
  const clean = String(slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!clean) return null;
  const rows = await sbSelect('salon', `select=*&slug=eq.${encodeURIComponent(clean)}&limit=1`);
  if (rows[0]) return rows[0];
  const bare = clean.replace(/-/g, '');
  const all = await sbSelect('salon', 'select=*&deleted_at=is.null');
  return all.find(s => String(s.slug).replace(/-/g, '') === bare) || null;
}

/* Everything a salon page shows — same call the public site makes. */
export async function sbSite(slug) {
  try { return await sbRpc('sv_site', { p_slug: slug }); } catch (e) { return null; }
}

/* "Tue, Sep 8 at 10:00am" in the salon's own time zone. */
export function whenText(iso, tz) {
  try {
    const d = new Date(iso);
    const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz });
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }).toLowerCase().replace(' ', '');
    return `${day} at ${time}`;
  } catch (e) { return String(iso); }
}

/* Supabase status -> the four words the portal already understands. */
const STATUS_TO_PORTAL = {
  pending: 'new', confirmed: 'confirmed', completed: 'done',
  declined: 'canceled', cancelled: 'canceled', expired: 'canceled', no_show: 'canceled'
};

/* Appointments for one salon, shaped exactly like the portal's existing
   booking records so the screens need no changes. */
export async function sbBookings(salon) {
  /* Everything from 60 days back onwards (the calendar needs the whole
     upcoming book, not the latest 500 rows). Pages past Supabase's 1,000 cap. */
  const since = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await sbSelect('appointment',
      `salon_id=eq.${salon.id}&starts_at=gte.${encodeURIComponent(since)}&order=starts_at.asc&limit=1000&offset=${offset}`
      + `&select=id,status,starts_at,ends_at,price_cents,client_note,created_at,`
      + `client:client_id(name,email,phone),stylist:stylist_id(name),`
      + `appointment_service(sequence,service:service_id(name))`);
    rows.push(...page);
    if (page.length < 1000 || rows.length >= 10000) break;
  }
  return rows.map(a => ({
    id: a.id,
    source: 'supabase',
    name: (a.client && a.client.name) || 'Client',
    email: (a.client && a.client.email) || '',
    phone: (a.client && a.client.phone) || '',
    service: (a.appointment_service || [])
      .sort((x, y) => (x.sequence || 0) - (y.sequence || 0))
      .map(s => s.service && s.service.name).filter(Boolean).join(' + ') || 'Appointment',
    stylist: (a.stylist && a.stylist.name) || '',
    when: whenText(a.starts_at, salon.timezone),
    startsAt: a.starts_at,
    endsAt: a.ends_at,
    priceCents: a.price_cents,
    message: a.client_note || '',
    status: STATUS_TO_PORTAL[a.status] || 'new',
    rawStatus: a.status,
    ts: Date.parse(a.starts_at) || Date.parse(a.created_at) || 0
  }));
}

export function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
}

/* Send one email through Resend. Text-only unless the body looks like HTML. */
export async function sendEmail({ to, subject, text, replyTo }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: 'RESEND_API_KEY not set' };
  const payload = {
    from: process.env.OUTBOX_FROM || 'SalonVine <bookings@salonvine.com>',
    to: [String(to)], subject: String(subject)
  };
  if (/^\s*</.test(text || '')) payload.html = text; else payload.text = text;
  if (replyTo) payload.reply_to = replyTo;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) return { ok: false, error: `Resend ${res.status}: ${(await res.text()).slice(0, 200)}` };
  return { ok: true };
}

/* 4500 -> "$45", 4550 -> "$45.50". Strings pass through untouched. */
export function money(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v !== 'number') return String(v);
  const whole = Math.floor(v / 100), cents = v % 100;
  return '$' + whole + (cents ? '.' + (cents < 10 ? '0' : '') + cents : '');
}

/* Seven weekday rows -> "Mon closed · Tue–Wed 9am–6pm · …" (Monday first). */
export function hoursText(rows) {
  if (!Array.isArray(rows) || !rows.length) return '';
  const NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const clock = t => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); if (!m) return '';
    const h = Number(m[1]); return (h % 12 || 12) + (m[2] === '00' ? '' : ':' + m[2]) + (h < 12 ? 'am' : 'pm'); };
  const by = {}; rows.forEach(r => { by[Number(r.weekday)] = r; });
  const parts = []; let run = null;
  const flush = () => { if (!run) return; parts.push((run.from === run.to ? NAMES[run.from] : NAMES[run.from] + '–' + NAMES[run.to]) + ' ' + run.text); run = null; };
  [1, 2, 3, 4, 5, 6, 0].forEach(d => {
    const r = by[d];
    const text = (!r || r.closed) ? 'closed' : clock(r.opens) + '–' + clock(r.closes);
    if (run && run.text === text) run.to = d; else { flush(); run = { from: d, to: d, text }; }
  });
  flush();
  return parts.join(' · ');
}
