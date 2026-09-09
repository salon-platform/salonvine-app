import { cors, json, getSession, getDataStore, userKey } from './_lib.js';
import { isIndependent } from './_stripe.js';

export default async (req, context) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' }, c.headers);

  const session = getSession(req);
  if (!session || !session.slug || !session.email) {
    return json(401, { error: 'Not signed in.' }, c.headers);
  }
  /* Does this stylist take their own payments? The portal shows them a
     Payments tab if so. Owners manage the salon's account, not this flag. */
  let independent = false;
  if (session.role !== 'admin') {
    try {
      const u = await getDataStore().get(userKey(session.slug, session.email), { type: 'json' });
      independent = Boolean(u && isIndependent(u));
    } catch (e) { /* default commission */ }
  }
  return json(200, {
    ok: true,
    slug: session.slug,
    email: session.email,
    role: session.role,
    name: session.name,
    independent,
    /* Set when a founder is inside this salon on a support session. The
       portal renders a banner from it — a salon is always told when we are
       looking at their account, no exceptions. */
    impersonatedBy: session.imp || null
  }, c.headers);
};
