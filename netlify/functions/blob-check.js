/* Temporary diagnostic — reports why Blobs access fails. Remove after debugging. */
const { getStore, connectLambda } = require('@netlify/blobs');

exports.handler = async (event) => {
  const out = { env: Object.keys(process.env).filter(k => k.indexOf('NETLIFY') === 0 || k.indexOf('BLOBS') !== -1) };
  try { connectLambda(event); out.connect = 'ok'; } catch (e) { out.connect = String((e && e.message) || e); }
  try {
    const s = getStore({ name: 'sv-data', consistency: 'strong' });
    await s.setJSON('debug/ping', { t: Date.now() });
    const v = await s.get('debug/ping', { type: 'json' });
    out.write = 'ok'; out.read = v ? 'ok' : 'null';
  } catch (e) { out.store = String((e && e.message) || e); }
  return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out) };
};
