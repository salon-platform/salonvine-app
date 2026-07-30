/* One-time code -> password. Accepts either a user's inviteCode (welcome flow)
   or a reset code stored under s/<slug>/resets/<code> (forgot-password flow).
   Both are single-use. Signs the user in on success. */

import {
  cors, json, parseBody, normSlug, normEmail,
  getDataStore, userKey, resetKey,
  hashPassword, signToken, setCookieHeader
} from './_lib.js';

export default async (req, context) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = await parseBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const slug = normSlug(body.slug);
  const email = normEmail(body.email);
  const code = String(body.invite || body.code || '').trim();
  const password = String(body.password || '');

  if (!slug || !email || !code) return json(400, { error: 'Missing fields.' }, c.headers);
  if (!/^[a-f0-9]{8,64}$/i.test(code)) return json(403, { error: 'Invalid or already-used link.' }, c.headers);
  if (password.length < 8) return json(400, { error: 'Password must be at least 8 characters.' }, c.headers);

  try {
    const store = getDataStore();
    const user = await store.get(userKey(slug, email), { type: 'json' });
    if (!user) return json(403, { error: 'Invalid or already-used link.' }, c.headers);

    let valid = false;
    let usedReset = false;

    // Path 1: invite activation (account not yet active)
    if (!user.active && user.inviteCode && user.inviteCode === code) {
      valid = true;
    }

    // Path 2: reset code
    if (!valid) {
      const reset = await store.get(resetKey(slug, code), { type: 'json' });
      if (reset && reset.email === email && typeof reset.exp === 'number' && reset.exp > Date.now()) {
        valid = true;
        usedReset = true;
      }
    }

    if (!valid) {
      return json(403, { error: 'Invalid or already-used link. Ask for a fresh one.' }, c.headers);
    }

    const { salt, hash } = hashPassword(password);
    await store.setJSON(userKey(slug, email), {
      ...user, salt, hash, active: true, inviteCode: null
    });
    if (usedReset) {
      await store.delete(resetKey(slug, code)).catch(() => {});
    }

    const token = signToken({ slug, email: user.email, role: user.role, name: user.name });
    return json(200,
      { ok: true, role: user.role, name: user.name, slug },
      { ...c.headers, 'Set-Cookie': setCookieHeader(token) });
  } catch (e) {
    return json(500, { error: 'Something went wrong. Try the link again.' }, c.headers);
  }
};
