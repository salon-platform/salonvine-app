/* Salon Vine multi-tenant portal — shared function library.
   Every blob key is built here, always prefixed s/<slug>/... — no function
   may ever touch the store with a hand-built key. */

import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { sbReady, sbSalon, sbSite, sendEmail, money, hoursText } from './_supabase.js';

export const APP_URL = process.env.APP_URL || 'https://app.salonvine.com';

const ALLOWED_ORIGINS = [
  'https://salonvine.com',
  'https://www.salonvine.com',
  'https://salonvine-app.netlify.app'
];

/* ---------------- CORS ----------------
   Usage in every handler:
     const c = cors(req);
     if (c.preflight) return c.preflight;
     ...
     return json(200, {...}, c.headers);            */
export function cors(req) {
  const origin = (req && req.headers && req.headers.get('origin')) || '';
  const allow = ALLOWED_ORIGINS.indexOf(origin) !== -1 ? origin : ALLOWED_ORIGINS[2];
  const headers = {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin'
  };
  if (req && req.method === 'OPTIONS') {
    return { headers, preflight: new Response(null, { status: 204, headers }) };
  }
  return { headers };
}

export function json(status, obj, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) }
  });
}

export async function parseBody(req) {
  try {
    const b = await req.json();
    return (b && typeof b === 'object' && !Array.isArray(b)) ? b : null;
  } catch (e) {
    return null;
  }
}

/* ---------------- tenant keys ---------------- */

export function normSlug(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(s) ? s : null;
}
export function normEmail(raw) {
  const e = String(raw || '').trim().toLowerCase();
  return (e.length >= 5 && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) ? e : null;
}
export function normId(raw) {
  const s = String(raw || '').trim();
  return /^[A-Za-z0-9_-]{1,80}$/.test(s) ? s : null;
}

export function getDataStore() {
  return getStore({ name: 'sv-data', consistency: 'strong' });
}

export function userKey(slug, email)   { return `s/${slug}/users/${email}`; }
export function bookingKey(slug, id)   { return `s/${slug}/bookings/${id}`; }
export function resetKey(slug, code)   { return `s/${slug}/resets/${code}`; }
export function usersPrefix(slug)      { return `s/${slug}/users/`; }
export function bookingsPrefix(slug)   { return `s/${slug}/bookings/`; }

export async function listJSON(store, prefix) {
  const { blobs } = await store.list({ prefix });
  const items = await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null)));
  return items.filter(Boolean);
}

/* ---------------- passwords (identical crypto to the proven template) ---------------- */

export function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { salt, hash };
}
export function verifyPassword(password, salt, hash) {
  if (!salt || !hash) return false;
  const check = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  const a = Buffer.from(check);
  const b = Buffer.from(String(hash));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* ---------------- sessions (HMAC-SHA256 JWT in an HttpOnly cookie) ---------------- */

const SESSION_DAYS = 90; // stylists live in this all shift — keep them signed in like a real app
const COOKIE_NAME = 'sv_session';

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

export function signToken(payload) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET not configured');
  const body = { ...payload, exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000 };
  const data = b64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', secret).update(data).digest('hex');
  return `${data}.${sig}`;
}
export function verifyToken(token) {
  if (!token) return null;
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest('hex');
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(parts[0]));
    if (!payload || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch (e) { return null; }
}

function getCookie(req, name) {
  const header = (req && req.headers && req.headers.get('cookie')) || '';
  const match = header.split(';').map(c => c.trim()).find(c => c.indexOf(name + '=') === 0);
  if (!match) return null;
  try { return decodeURIComponent(match.split('=').slice(1).join('=')); } catch (e) { return null; }
}
export function setCookieHeader(token) {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`;
}
export function clearCookieHeader() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function getSession(req) {
  return verifyToken(getCookie(req, COOKIE_NAME));
}

/* The hard multi-tenant rule: a session is only valid for the salon it was
   minted for. Returns { session, slug } or { errorResponse }. */
export function requireSalonSession(req, requestedSlug, corsHeaders) {
  const session = getSession(req);
  if (!session || !session.slug || !session.email) {
    return { errorResponse: json(401, { error: 'Not signed in.' }, corsHeaders) };
  }
  const slug = normSlug(requestedSlug);
  if (!slug) {
    return { errorResponse: json(400, { error: 'Missing or invalid salon.' }, corsHeaders) };
  }
  if (session.slug !== slug) {
    return { errorResponse: json(403, { error: 'This session does not belong to that salon.' }, corsHeaders) };
  }
  return { session, slug };
}

/* ---------------- mail / SMS relay (Apps Script sends as ai@zbrockmotors.com) ---------------- */

export async function relayMail({ to, subject, text, sms }) {
  /* Email goes out through Resend as SalonVine. Texts have no provider yet
     (Twilio is on Zack's list); say so plainly instead of pretending. */
  if (!text) return { ok: false, error: 'missing text' };
  if (sms && sms.phone) return { ok: false, error: 'sms not configured yet' };
  if (!to || !subject) return { ok: false, error: 'missing to/subject' };
  return sendEmail({ to, subject, text });
}

/* ---------------- salon registry (Supabase first, Apps Script for salons not moved yet) ---------------- */

const SEAT_LIMITS = { studio: 3, pro: 10, elite: null };
const REGISTRY_TTL_MS = 5 * 60 * 1000;
const registryCache = new Map(); // slug -> { data, exp }

export function seatLimitForPlan(plan) {
  const p = String(plan || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(SEAT_LIMITS, p)) return SEAT_LIMITS[p];
  return SEAT_LIMITS.studio; // unknown/missing plan gets the smallest tier — never gives seats away
}

/* Returns the public registry record {name, plan, theme, accent, tagline, ...}
   or null if the salon is unknown. 5-minute in-memory cache per warm function. */
export async function getSalonRegistry(slug) {
  const clean = normSlug(slug);
  if (!clean) return null;
  const hit = registryCache.get(clean);
  if (hit && hit.exp > Date.now()) return hit.data;

  /* Supabase is the source of truth now. The public payload (sv_site) plus
     the plan and status off the salon row — same shape the portal expects. */
  if (sbReady()) {
    try {
      const salon = await sbSalon(clean);
      if (salon) {
        const site = await sbSite(salon.slug) || {};
        const data = Object.assign({ ok: true }, site, {
          slug: salon.slug,
          name: salon.name || site.name,
          plan: salon.plan || site.plan || 'studio',
          status: salon.status || '',
          ownerEmail: salon.owner_email || '',
          ownerName: salon.owner_name || '',
          address: salon.address || '',
          timezone: salon.timezone || site.timezone || '',
          stylists: Array.isArray(site.team) ? site.team.map(t => t.name) : [],
          services: Array.isArray(site.services) ? site.services.map(s => ({ name: s.name, price: money(s.price), minutes: s.minutes })) : [],
          hours: salon.hours_note || hoursText(site.hours),
          about: salon.about_text || '',
          heroTitle: site.heroTitle || salon.hero_title || '',
          logo: site.logo || salon.logo_url || '',
          heroImage: site.heroImage || salon.hero_image_url || '',
          photos: Array.isArray(site.photos) ? site.photos : []
        });
        registryCache.set(clean, { data, exp: Date.now() + REGISTRY_TTL_MS });
        return data;
      }
    } catch (e) { console.error('registry: supabase path failed for ' + clean + ': ' + (e && e.message)); }
  }

  /* Legacy: salons not yet in Supabase still live on Apps Script. */
  const exec = process.env.SV_EXEC;
  if (!exec) return null;
  try {
    const res = await fetch(`${exec}?site=${encodeURIComponent(clean)}`, { redirect: 'follow' });
    const j = await res.json().catch(() => null);
    const data = (j && j.ok && !j.error) ? j : null;
    if (data && process.env.SV_TOKEN) {
      try {
        const pres = await fetch(exec, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ token: process.env.SV_TOKEN, type: 'salonPlan', slug: clean }),
          redirect: 'follow'
        });
        const pj = await pres.json().catch(() => null);
        if (pj && pj.ok) { data.plan = pj.plan || data.plan; data.status = pj.status || ''; }
      } catch (e2) { /* keep public data; plan defaults apply */ }
    }
    registryCache.set(clean, { data, exp: Date.now() + REGISTRY_TTL_MS });
    return data;
  } catch (e) {
    return hit ? hit.data : null;
  }
}

export function newCode(bytes) {
  return crypto.randomBytes(bytes || 8).toString('hex');
}

export function welcomeLink(slug, inviteCode, email) {
  return `${APP_URL}/p/${slug}/welcome?invite=${inviteCode}&email=${encodeURIComponent(email)}`;
}
export function resetLink(slug, code, email) {
  return `${APP_URL}/p/${slug}/reset?code=${code}&email=${encodeURIComponent(email)}`;
}
