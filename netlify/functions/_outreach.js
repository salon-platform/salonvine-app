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

import { getDataStore, normEmail } from './_lib.js';
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
  mailingAddress: ''                 /* REQUIRED before anything goes out */
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
  const find = (...needles) => header.findIndex(h => needles.some(n => h.includes(n)));
  const iEmail = find('email', 'e-mail');
  const iName = find('owner', 'name', 'contact');
  const iSalon = find('salon', 'business', 'company');
  const iCity = find('city', 'town');
  if (iEmail === -1) return { contacts: [], dropped: rows.length - 1, columns: header, error: 'No email column found.' };

  const out = [];
  let dropped = 0;
  for (const r of rows.slice(1)) {
    const email = normEmail(r[iEmail]);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { dropped++; continue; }
    out.push({
      email,
      name: iName === -1 ? '' : String(r[iName] || '').trim().slice(0, 80),
      salon: iSalon === -1 ? '' : String(r[iSalon] || '').trim().slice(0, 120),
      city: iCity === -1 ? '' : String(r[iCity] || '').trim().slice(0, 80)
    });
  }
  return { contacts: out, dropped, columns: header };
}
