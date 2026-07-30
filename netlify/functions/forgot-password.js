/* Always answers {ok:true} so it can't be used to probe which emails exist.
   If the account is real, drops a 1-hour reset code and relays the email. */

const {
  cors, json, parseBody, normSlug, normEmail,
  getDataStore, userKey, resetKey,
  newCode, resetLink, relayMail, getSalonRegistry
} = require('./_lib');

exports.handler = async (event) => {
  const c = cors(event);
  if (c.preflight) return c.preflight;
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = parseBody(event);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const slug = normSlug(body.slug);
  const email = normEmail(body.email);
  if (!slug || !email) return json(400, { error: 'Missing fields.' }, c.headers);

  try {
    const store = getDataStore(event);
    const user = await store.get(userKey(slug, email), { type: 'json' });

    if (user) {
      const code = newCode(9);
      await store.setJSON(resetKey(slug, code), {
        email,
        exp: Date.now() + 60 * 60 * 1000
      });

      const registry = await getSalonRegistry(slug);
      const salonName = (registry && registry.name) || 'your salon';
      const link = resetLink(slug, code, email);

      await relayMail({
        to: email,
        subject: `Reset your ${salonName} portal password`,
        text: `Hi ${user.name || ''},\n\nSomeone asked to reset the password for your ${salonName} staff portal account. If that was you, set a new password here (link works for 1 hour):\n\n${link}\n\nIf you didn't ask for this, you can ignore this email — your password hasn't changed.`
      });
    }

    return json(200, { ok: true }, c.headers);
  } catch (e) {
    // Still opaque — never reveal whether the account exists.
    return json(200, { ok: true }, c.headers);
  }
};
