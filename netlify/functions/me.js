import { cors, json, getSession } from './_lib.js';

export default async (req, context) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' }, c.headers);

  const session = getSession(req);
  if (!session || !session.slug || !session.email) {
    return json(401, { error: 'Not signed in.' }, c.headers);
  }
  return json(200, {
    ok: true,
    slug: session.slug,
    email: session.email,
    role: session.role,
    name: session.name,
    /* Set when a founder is inside this salon on a support session. The
       portal renders a banner from it — a salon is always told when we are
       looking at their account, no exceptions. */
    impersonatedBy: session.imp || null
  }, c.headers);
};
