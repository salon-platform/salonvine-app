import {
  cors, json, parseBody, normSlug, normEmail,
  getDataStore, userKey, verifyPassword, signToken, setCookieHeader
} from './_lib.js';
import { resolveSlug } from './_slug.js';

export default async (req, context) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = await parseBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const slug = await resolveSlug(body.slug);   /* "Studio 17" -> studio17 */
  const email = normEmail(body.email);
  const password = String(body.password || '');
  if (!slug || !email || !password) return json(400, { error: 'Missing fields.' }, c.headers);

  try {
    const store = getDataStore();
    const user = await store.get(userKey(slug, email), { type: 'json' });

    if (!user || !user.active || !user.salt || !user.hash) {
      return json(401, { error: 'Invalid email or password.' }, c.headers);
    }
    if (!verifyPassword(password, user.salt, user.hash)) {
      return json(401, { error: 'Invalid email or password.' }, c.headers);
    }

    const token = signToken({ slug, email: user.email, role: user.role, name: user.name });
    return json(200,
      { ok: true, role: user.role, name: user.name, slug },
      { ...c.headers, 'Set-Cookie': setCookieHeader(token) });
  } catch (e) {
    return json(500, { error: 'Something went wrong signing you in. Try again.' }, c.headers);
  }
};
