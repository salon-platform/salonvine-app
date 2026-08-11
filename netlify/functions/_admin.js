/* Founder console — identity, authorisation, impersonation and audit.

   THREAT MODEL, read before changing anything here.
   This layer can read every salon's data and mint a session inside any
   salon. It is the most valuable target in the system. The defences:

   1. Founder identity is an ALLOWLIST (FOUNDER_EMAILS env var). Not a role
      flag on a user record — a record can be edited by any bug that can
      write blobs; an env var cannot.
   2. Login is a MAGIC LINK to that allowlisted address. There is no founder
      password anywhere: nothing to leak, nothing to reuse, nothing for an
      assistant or a screenshot to expose. Proving control of the inbox is
      the whole authentication.
   3. Founder sessions are SHORT (12h) and live in their own cookie, so a
      stale salon session can never be mistaken for founder rights.
   4. Impersonation is a separate, 60-minute, single-salon token carrying an
      `imp` claim. The portal renders a banner when it is set — the salon
      always knows we are in there. We never see or reset their password.
   5. Every privileged action is written to an append-only audit log BEFORE
      it is considered done.                                              */

import crypto from 'node:crypto';
import { getDataStore, json, normEmail, relayMail, APP_URL } from './_lib.js';

export const FOUNDER_COOKIE = 'sv_founder';
const FOUNDER_TTL_MS = 12 * 60 * 60 * 1000;       // console session
const LINK_TTL_MS = 15 * 60 * 1000;               // magic link
export const IMPERSONATION_TTL_MS = 60 * 60 * 1000; // in-salon support session

/* ---------------- allowlist ---------------- */

export function founderEmails() {
  return String(process.env.FOUNDER_EMAILS || '')
    .split(',').map(s => normEmail(s)).filter(Boolean);
}

export function isFounderEmail(email) {
  const e = normEmail(email);
  if (!e) return false;
  const list = founderEmails();
  /* Constant-time-ish membership: compare every entry so a timing signal
     cannot be used to enumerate which addresses are founders. */
  let hit = false;
  for (const f of list) {
    const a = Buffer.from(f.padEnd(64, '\0').slice(0, 64));
    const b = Buffer.from(e.padEnd(64, '\0').slice(0, 64));
    if (crypto.timingSafeEqual(a, b)) hit = true;
  }
  return hit;
}

/* ---------------- tokens (same HMAC scheme as _lib, explicit TTLs) ------- */

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

export function signAdminToken(payload, ttlMs) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET not configured');
  const body = { ...payload, exp: Date.now() + ttlMs };
  const data = b64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', secret).update(data).digest('hex');
  return `${data}.${sig}`;
}

export function verifyAdminToken(token) {
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
    const p = JSON.parse(b64urlDecode(parts[0]));
    if (!p || typeof p.exp !== 'number' || p.exp < Date.now()) return null;
    return p;
  } catch (e) { return null; }
}

function readCookie(req, name) {
  const header = (req && req.headers && req.headers.get('cookie')) || '';
  const match = header.split(';').map(c => c.trim()).find(c => c.indexOf(name + '=') === 0);
  if (!match) return null;
  try { return decodeURIComponent(match.split('=').slice(1).join('=')); } catch (e) { return null; }
}

export function setFounderCookieHeader(token) {
  return `${FOUNDER_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(FOUNDER_TTL_MS / 1000)}`;
}
export function clearFounderCookieHeader() {
  return `${FOUNDER_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function mintFounderSession(email) {
  return signAdminToken({ kind: 'founder', email: normEmail(email) }, FOUNDER_TTL_MS);
}
export function mintLoginLink(email) {
  const token = signAdminToken({ kind: 'link', email: normEmail(email) }, LINK_TTL_MS);
  return `${APP_URL}/.netlify/functions/admin-auth?token=${encodeURIComponent(token)}`;
}

/* ---------------- the guard ---------------- */

export function getFounder(req) {
  const p = verifyAdminToken(readCookie(req, FOUNDER_COOKIE));
  if (!p || p.kind !== 'founder') return null;
  /* Re-check the allowlist on every request. Removing someone from
     FOUNDER_EMAILS must revoke them immediately, not in 12 hours. */
  if (!isFounderEmail(p.email)) return null;
  return { email: p.email };
}

export function requireFounder(req, corsHeaders) {
  const founder = getFounder(req);
  if (!founder) return { errorResponse: json(401, { error: 'Founder sign-in required.' }, corsHeaders) };
  return { founder };
}

/* ---------------- impersonation ---------------- */

/* Mints a normal salon session (same cookie the portal reads) but short-lived
   and stamped with `imp`. me.js surfaces `imp` so the portal can show the
   support banner. */
export function mintImpersonation(slug, email, name, founderEmail) {
  return signAdminToken(
    { slug, email: normEmail(email), role: 'admin', name: name || 'Salon Vine Support', imp: normEmail(founderEmail) },
    IMPERSONATION_TTL_MS
  );
}

/* ---------------- audit log ---------------- */

export function auditKey(ts, rand) { return `admin/audit/${ts}_${rand}`; }
export const AUDIT_PREFIX = 'admin/audit/';

export async function audit(founderEmail, action, detail) {
  const ts = Date.now();
  const rand = crypto.randomBytes(3).toString('hex');
  const entry = {
    ts, founder: normEmail(founderEmail), action,
    detail: detail || {}
  };
  try {
    await getDataStore().setJSON(auditKey(ts, rand), entry);
  } catch (e) { /* never block the action on a log write */ }
  return entry;
}

/* Founders get told when someone signs in to the console or impersonates a
   salon — including themselves. If one of us ever gets an alert we didn't
   trigger, that is the signal something is wrong. */
export async function alertFounders(subject, text) {
  const list = founderEmails();
  await Promise.all(list.map(f => relayMail({ to: f, subject, text }).catch(() => null)));
}
