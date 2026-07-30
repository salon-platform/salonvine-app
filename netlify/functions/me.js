const { cors, json, getSession } = require('./_lib');

exports.handler = async (event) => {
  const c = cors(event);
  if (c.preflight) return c.preflight;
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' }, c.headers);

  const session = getSession(event);
  if (!session || !session.slug || !session.email) {
    return json(401, { error: 'Not signed in.' }, c.headers);
  }
  return json(200, {
    ok: true,
    slug: session.slug,
    email: session.email,
    role: session.role,
    name: session.name
  }, c.headers);
};
