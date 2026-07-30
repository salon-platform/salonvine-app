/* Salon Vine multi-tenant portal — shared function library.
   Every blob key is built here, always prefixed s/<slug>/... — no function
   may ever touch the store with a hand-built key. */

const crypto = require('crypto');
const { getStore, connectLambda } = require('@netlify/blobs');

const APP_URL = process.env.URL || 'https://salonvine-app.netlify.app';

const ALLOWED_ORIGINS = [
  'https://salonvine.com',
  'https://www.salonvine.com',
  'https://salonvine-app.netlify.app'
];

/* ---------------- CORS ----------------
   Usage in every handler:
     const c = cors(event);
     if (c.preflight) return c.preflight;
     ...
     return json(200, {...}, c.headers);            */
function cors(event) {
  const h = (event && event.headers) || {};
  const origin = h.origin || h.Origin || '';
  const allow = ALLOWED_ORIGINS.indexOf(origin) !== -1 ? origin : ALLOWED_ORIGINS[2];
  const headers = {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin'
  };
  if (event && event.httpMethod === 'OPTIONS') {
    return { headers, preflight: { statusCode: 204, headers, body: '' } };
  }
  return { headers };
}

function json(statusCode, obj, extraHeaders) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...(extraHeaders || {}) },
    body: JSON.stringify(obj)
  };
}

function parseBody(event) {
  try {
    const b = JSON.parse(event.body || '{}');
    return (b && typeof b === 'object' && !Array.isArray(b)) ? b : null;
  } catch (e) {
    return null;
  }
}

/* ---------------- tenant keys ---------------- */

function normSlug(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(s) ? s : null;
}
function normEmail(raw) {
  const e = String(raw || '').trim().toLowerCase();
  return (e.length >= 5 && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) ? e : null;
}
function normId(raw) {
  const s = String(raw || '').trim();
  return /^[A-Za-z0-9_-]{1,80}$/.test(s) ? s : null;
}

function getDataStore(event) {
  /* v1 lambda-compat functions don't get the Blobs context automatically —
     connectLambda(event) reads it from the invocation payload. */
  if (event) { try { connectLambda(event); } catch (e) { /* already connected */ } }
  /* NOTE: lambda-compat context has no uncachedEdgeURL, so strong
     consistency is unavailable — default (eventual) is fine for these flows. */
  return getStore({ name: 'sv-data' });
}

function userKey(slug, email)   { return `s/${slug}/users/${email}`; }
function bookingKey(slug, id)   { return `s/${slug}/bookings/${id}`; }
function resetKey(slug, code)   { return `s/${slug}/resets/${code}`; }
function usersPrefix(slug)      { return `s/${slug}/users/`; }
function bookingsPrefix(slug)   { return `s/${slug}/bookings/`; }

async function listJSON(store, prefix) {
  const { blobs } = await store.list({ prefix });
  const items = await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null)));
  return items.filter(Boolean);
}

/* ---------------- passwords (identical crypto to the proven template) ---------------- */

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
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

function signToken(payload) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET not configured');
  const body = { ...payload, exp: Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000 };
  const data = b64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', secret).update(data).digest('hex');
  return `${data}.${sig}`;
}
function verifyToken(token) {
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

function getCookie(event, name) {
  const h = (event && event.headers) || {};
  const header = h.cookie || h.Cookie || '';
  const match = header.split(';').map(c => c.trim()).find(c => c.indexOf(name + '=') === 0);
  if (!match) return null;
  try { return decodeURIComponent(match.split('=').slice(1).join('=')); } catch (e) { return null; }
}
function setCookieHeader(token) {
  return `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 24 * 60 * 60}`;
}
function clearCookieHeader() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function getSession(event) {
  return verifyToken(getCookie(event, COOKIE_NAME));
}

/* The hard multi-tenant rule: a session is only valid for the salon it was
   minted for. Returns { session, slug } or { errorResponse }. */
function requireSalonSession(event, requestedSlug, corsHeaders) {
  const session = getSession(event);
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

async function relayMail({ to, subject, text, sms }) {
  const exec = process.env.SV_EXEC;
  const token = process.env.SV_TOKEN;
  if (!exec || !token || !text) return { ok: false, error: 'relay not configured' };
  const payload = { token, type: 'sendMail', text };
  if (sms && sms.phone) {
    payload.sms = { phone: String(sms.phone) };
  } else {
    if (!to || !subject) return { ok: false, error: 'missing to/subject' };
    payload.to = String(to);
    payload.subject = String(subject);
  }
  try {
    const res = await fetch(exec, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids Apps Script CORS/redirect quirks
      body: JSON.stringify(payload),
      redirect: 'follow'
    });
    const j = await res.json().catch(() => null);
    if (j && j.ok) return { ok: true };
    return { ok: false, error: (j && j.error) || `relay status ${res.status}` };
  } catch (e) {
    return { ok: false, error: 'relay unreachable' };
  }
}

/* ---------------- salon registry (Apps Script is the source of truth) ---------------- */

const SEAT_LIMITS = { studio: 3, pro: 10, elite: null };
const REGISTRY_TTL_MS = 5 * 60 * 1000;
const registryCache = new Map(); // slug -> { data, exp }

function seatLimitForPlan(plan) {
  const p = String(plan || '').trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(SEAT_LIMITS, p)) return SEAT_LIMITS[p];
  return SEAT_LIMITS.studio; // unknown/missing plan gets the smallest tier — never gives seats away
}

/* Returns the public registry record {name, plan, theme, accent, tagline, ...}
   or null if the salon is unknown. 5-minute in-memory cache per warm function. */
async function getSalonRegistry(slug) {
  const clean = normSlug(slug);
  if (!clean) return null;
  const hit = registryCache.get(clean);
  if (hit && hit.exp > Date.now()) return hit.data;
  const exec = process.env.SV_EXEC;
  if (!exec) return null;
  try {
    const res = await fetch(`${exec}?site=${encodeURIComponent(clean)}`, { redirect: 'follow' });
    const j = await res.json().catch(() => null);
    const data = (j && j.ok && !j.error) ? j : null;
    /* The public payload deliberately omits plan/status. Fetch them
       server-side with the full token so seat limits use the real plan. */
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
    return hit ? hit.data : null; // stale beats nothing if the registry hiccups
  }
}

function newCode(bytes) {
  return crypto.randomBytes(bytes || 8).toString('hex');
}

function welcomeLink(slug, inviteCode, email) {
  return `${APP_URL}/p/${slug}/welcome?invite=${inviteCode}&email=${encodeURIComponent(email)}`;
}
function resetLink(slug, code, email) {
  return `${APP_URL}/p/${slug}/reset?code=${code}&email=${encodeURIComponent(email)}`;
}

module.exports = {
  APP_URL,
  cors, json, parseBody,
  normSlug, normEmail, normId,
  getDataStore, listJSON,
  userKey, bookingKey, resetKey, usersPrefix, bookingsPrefix,
  hashPassword, verifyPassword,
  signToken, verifyToken, getSession, requireSalonSession,
  setCookieHeader, clearCookieHeader,
  relayMail, getSalonRegistry, seatLimitForPlan,
  newCode, welcomeLink, resetLink
};
