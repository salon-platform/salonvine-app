const { cors, json, clearCookieHeader } = require('./_lib');

exports.handler = async (event) => {
  const c = cors(event);
  if (c.preflight) return c.preflight;
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);
  return json(200, { ok: true }, { ...c.headers, 'Set-Cookie': clearCookieHeader() });
};
