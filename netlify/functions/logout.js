import { cors, json, clearCookieHeader } from './_lib.js';

export default async (req, context) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);
  return json(200, { ok: true }, { ...c.headers, 'Set-Cookie': clearCookieHeader() });
};
