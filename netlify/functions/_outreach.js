/* Shared pieces for the founder outreach mailer (outreach.js, outreach-send.js,
   outreach-unsub.js). Nothing here is reachable by a salon or a stylist.

   STORAGE (Netlify Blobs)
     outreach/config     { active, dailyLimit, from, replyTo, subject,
                           mailingAddress, updatedAt }
     outreach/contacts   [ { email, name, salon, city, status, addedAt,
                             sentAt, resendId, unsubAt, error } ]
                         status: 'queued' | 'sent' | 'unsubscribed' | 'failed'
     outreach/suppress   { "<email>": { at, why } }   never emailed again,
                         even if re-uploaded

   WHY A SUBDOMAIN
     Every appointment reminder and receipt SalonVine sends leaves from
     salonvine.com. Cold mail must never share that reputation: if a hundred
     strangers hit "spam", a client's booking confirmation tomorrow morning
     goes to junk too. So the default sender is on mail.salonvine.com — verify
     that subdomain in Resend before switching this on.                       */

import { getDataStore, normEmail, APP_URL } from './_lib.js';
import { signAdminToken, verifyAdminToken } from './_admin.js';

export const CONFIG_KEY = 'outreach/config';
export const CONTACTS_KEY = 'outreach/contacts';
export const SUPPRESS_KEY = 'outreach/suppress';

export const DEFAULTS = {
  active: false,
  dailyLimit: 40,                    /* a brand-new sending domain: start small */
  from: 'Dylan at SalonVine <dylan@mail.salonvine.com>',
  replyTo: 'hello@salonvine.com',
  subject: '',                       /* empty -> template default */
  mailingAddress: '',                /* REQUIRED before anything goes out */
  sheetCsvUrl: ''                    /* Google Sheet (CSV link) pulled before each batch */
};

export async function readConfig() {
  const c = await getDataStore().get(CONFIG_KEY, { type: 'json' }).catch(() => null);
  return { ...DEFAULTS, ...(c || {}) };
}
export async function writeConfig(patch) {
  const cur = await readConfig();
  const next = { ...cur, ...patch, updatedAt: Date.now() };
  await getDataStore().setJSON(CONFIG_KEY, next);
  return next;
}

export async function readContacts() {
  const c = await getDataStore().get(CONTACTS_KEY, { type: 'json' }).catch(() => null);
  return Array.isArray(c) ? c : [];
}
export async function writeContacts(list) {
  await getDataStore().setJSON(CONTACTS_KEY, list);
}

export async function readSuppress() {
  const s = await getDataStore().get(SUPPRESS_KEY, { type: 'json' }).catch(() => null);
  return (s && typeof s === 'object') ? s : {};
}
export async function suppress(email, why) {
  const s = await readSuppress();
  s[email] = { at: Date.now(), why: String(why || '').slice(0, 40) };
  await getDataStore().setJSON(SUPPRESS_KEY, s);
}

/* Counts for the console. */
export function tally(list) {
  const t = { total: list.length, queued: 0, sent: 0, unsubscribed: 0, failed: 0 };
  for (const c of list) if (t[c.status] !== undefined) t[c.status]++;
  return t;
}

/* ---- unsubscribe links ----
   Signed with the same secret the founder console uses, one year TTL. The
   link carries only the email; nothing else is needed and nothing else is
   exposed if someone forwards the mail. */
const UNSUB_TTL_MS = 365 * 24 * 60 * 60 * 1000;

export function unsubToken(email) {
  return signAdminToken({ kind: 'unsub', email: normEmail(email) }, UNSUB_TTL_MS);
}
export function unsubEmailFromToken(token) {
  const p = verifyAdminToken(token);
  if (!p || p.kind !== 'unsub' || !p.email) return null;
  return normEmail(p.email);
}

/* ---- CSV in ----
   Tolerant on purpose: any column whose header contains "email" is the
   email; "name"/"owner"/"contact" is the name; "salon"/"business"/"company"
   is the salon; "city" is the city. Quoted fields with commas are handled.
   Rows with no valid email are dropped and counted. */
export function parseContactsCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  const src = String(text || '').replace(/\r\n?/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return { contacts: [], dropped: 0, columns: [] };

  const header = rows[0].map(h => String(h || '').trim().toLowerCase());
  /* needles are in priority order: "owner" beats "name", so "Business Name"
     is not mistaken for the person when a "Licensee Name" column exists */
  const find = (...needles) => {
    for (const n of needles) { const i = header.findIndex(h => h.includes(n)); if (i !== -1) return i; }
    return -1;
  };
  const iEmail = find('email', 'e-mail');
  const iSalon = find('salon', 'business', 'company');
  const iName = find('owner', 'licensee', 'contact', 'name');
  const iCity = find('city', 'town');
  /* A licence export (LARA) mixes businesses with individual stylists. The
     invitation is written to salon owners, so when a type column exists only
     the business rows are kept. Plain lists without one are taken as-is. */
  const iType = find('license type', 'licence type', 'category', 'type');
  if (iEmail === -1) return { contacts: [], dropped: 0, people: 0, columns: header, error: 'No email column found.' };

  const out = [];
  let dropped = 0, people = 0;
  for (const r of rows.slice(1)) {
    if (iType !== -1 && !isBusinessType(r[iType])) { people++; continue; }
    const email = normEmail(r[iEmail]);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { dropped++; continue; }
    const name = iName === -1 ? '' : String(r[iName] || '').trim().slice(0, 80);
    let salon = iSalon === -1 ? '' : String(r[iSalon] || '').trim().slice(0, 120);
    if (!salon) salon = name;               /* sole proprietors: licensee is the salon */
    out.push({
      email, name, salon,
      city: iCity === -1 ? '' : String(r[iCity] || '').trim().slice(0, 80)
    });
  }
  return { contacts: out, dropped, people, columns: header };
}

/* "Cosmetology Est", "Cosmetology Est Ltd", "Barbershop", "New Salon" -> yes.
   "Cosmetologist", "Barber", "Manicurist", "Instructor" -> no. */
export function isBusinessType(v) {
  const s = String(v || '').trim();
  if (!s) return true;                       /* no value: don't throw the row away */
  if (/^(new\s+)?(cosmetologist|barber|manicurist|esthetician|electrologist|natural hair|instructor|student)s?\s*$/i.test(s)) return false;
  return /(\best\b|establishment|salon|barbershop|shop|spa|studio|llc|inc\b)/i.test(s);
}

/* ---- Google Sheet in ----
   The sheet the founders keep new-licence pulls in. Any link that returns CSV
   without signing in works: a sheet shared "anyone with the link" via
   .../export?format=csv&gid=..., or a "publish to web" CSV link. A normal
   /edit link is turned into the export form automatically.
   Contacts already on the list or suppressed are left alone. */
export function sheetCsvUrl(link) {
  const s = String(link || '').trim();
  if (!s) return '';
  const m = s.match(/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})\//);
  if (m && !/\/export\?|\/pub\?/.test(s)) {
    const gid = (s.match(/[?&#]gid=(\d+)/) || [])[1] || '0';
    return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
  }
  return s;
}

/* The daily LARA pull (GitHub Action, scripts/lara-pull.mjs) commits its
   running list here; Netlify serves it as a plain file. */
export const LEADS_CSV_URL = `${APP_URL}/data/lara-4k9q2v/leads.csv`;

async function fetchCsv(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'Accept': 'text/csv,*/*' } });
  if (!res.ok) throw new Error(`returned ${res.status}${res.status === 401 || res.status === 403 ? ' — is it shared "anyone with the link"?' : ''}`);
  const text = await res.text();
  if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('needs sign-in — share it "anyone with the link" (viewer) first.');
  return text;
}

/* Pull every source (the LARA CSV, plus the Google Sheet if one is set) and
   queue anyone new. Contacts already on the list or suppressed are left alone. */
export async function syncFromSheet(cfg) {
  const sources = [{ name: 'LARA pull', url: LEADS_CSV_URL }];
  const sheet = sheetCsvUrl(cfg.sheetCsvUrl);
  if (sheet) sources.push({ name: 'sheet', url: sheet });
  const out = { ok: true, added: 0, dupes: 0, blocked: 0, dropped: 0, people: 0, rows: 0, error: '', sources: [] };

  const existing = await readContacts();
  const have = new Set(existing.map(x => x.email));
  const suppressed = await readSuppress();

  for (const src of sources) {
    let text = '';
    try { text = await fetchCsv(src.url); }
    catch (e) {
      const msg = `${src.name}: ${String((e && e.message) || e).slice(0, 140)}`;
      out.sources.push({ name: src.name, error: msg });
      if (src.name === 'sheet') { out.ok = false; out.error = msg; }   /* the founder set this one by hand */
      continue;
    }
    const parsed = parseContactsCsv(text);
    if (parsed.error) { out.sources.push({ name: src.name, error: parsed.error }); if (src.name === 'sheet') { out.ok = false; out.error = parsed.error; } continue; }
    let added = 0;
    for (const ct of parsed.contacts) {
      if (have.has(ct.email)) { out.dupes++; continue; }
      if (suppressed[ct.email]) { out.blocked++; continue; }
      existing.push({ ...ct, status: 'queued', addedAt: Date.now(), source: src.name });
      have.add(ct.email); added++;
    }
    out.added += added; out.dropped += parsed.dropped; out.people += parsed.people;
    out.rows += parsed.contacts.length + parsed.dropped + parsed.people;
    out.sources.push({ name: src.name, rows: parsed.contacts.length + parsed.dropped + parsed.people, added });
  }
  if (out.added) await writeContacts(existing);
  await writeConfig({ lastSync: { at: Date.now(), added: out.added, rows: out.rows, error: out.error || out.sources.filter(s => s.error).map(s => s.error).join('; ') } });
  return out;
}
