/* Health check: verifies the function can reach Netlify Blobs with strong
   consistency (write + read back of debug/ping). Returns {ok:true} or
   {ok:false, error}. */

import { cors, json, getDataStore } from './_lib.js';

export default async (req, context) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;

  try {
    const store = getDataStore();
    const stamp = { ts: Date.now() };
    await store.setJSON('debug/ping', stamp);
    const back = await store.get('debug/ping', { type: 'json' });
    if (!back || back.ts !== stamp.ts) {
      return json(500, { ok: false, error: 'read-back mismatch' }, c.headers);
    }
    return json(200, { ok: true }, c.headers);
  } catch (e) {
    return json(500, { ok: false, error: String((e && e.message) || e) }, c.headers);
  }
};
