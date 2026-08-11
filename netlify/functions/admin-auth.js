/* Founder console auth.

   GET  ?token=<magic link>  -> verify, set founder cookie, redirect to /admin
   GET                       -> who am I ({ok:true,email} or 401)
   POST {action:'request', email} -> email a 15-minute sign-in link
   POST {action:'logout'}         -> clear the founder cookie

   There is no founder password. Whoever controls an allowlisted inbox is a
   founder; that is the entire authentication, and it means no credential of
   ours exists to be leaked, screenshotted, or pasted into the wrong window. */

import { cors, json, parseBody, normEmail, relayMail, APP_URL } from './_lib.js';
import {
  isFounderEmail, mintFounderSession, mintLoginLink, verifyAdminToken,
  setFounderCookieHeader, clearFounderCookieHeader, getFounder, audit, alertFounders
} from './_admin.js';

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;

  const url = new URL(req.url);

  /* ---- magic link landing ---- */
  if (req.method === 'GET' && url.searchParams.get('token')) {
    const p = verifyAdminToken(url.searchParams.get('token'));
    if (!p || p.kind !== 'link' || !isFounderEmail(p.email)) {
      return new Response(
        '<!doctype html><meta charset="utf-8"><title>Link expired</title>' +
        '<body style="font-family:system-ui;max-width:34rem;margin:15vh auto;padding:0 1.5rem;line-height:1.6">' +
        '<h1 style="font-size:1.3rem">That link has expired</h1>' +
        '<p>Sign-in links last 15 minutes and work once. Request a new one from the console.</p>' +
        '<p><a href="/admin">Back to the console</a></p></body>',
        { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    }
    const token = mintFounderSession(p.email);
    await audit(p.email, 'founder.login', { ua: String(req.headers.get('user-agent') || '').slice(0, 120) });
    await alertFounders(
      'Salon Vine console sign-in',
      `${p.email} just signed in to the founder console at ${new Date().toISOString()}.\n\n` +
      `If that was not one of you, remove the address from FOUNDER_EMAILS in Netlify immediately — that revokes access on the next request.`
    );
    return new Response(null, {
      status: 302,
      headers: { 'Location': `${APP_URL}/admin`, 'Set-Cookie': setFounderCookieHeader(token) }
    });
  }

  /* ---- who am I ---- */
  if (req.method === 'GET') {
    const founder = getFounder(req);
    if (!founder) return json(401, { error: 'Not signed in.' }, c.headers);
    return json(200, { ok: true, email: founder.email }, c.headers);
  }

  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const body = await parseBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);

  if (body.action === 'logout') {
    return json(200, { ok: true }, { ...c.headers, 'Set-Cookie': clearFounderCookieHeader() });
  }

  if (body.action === 'request') {
    const email = normEmail(body.email);
    /* Always the same answer, always the same shape. An attacker must not be
       able to learn which addresses are founders by watching responses. */
    const generic = { ok: true, sent: true };
    if (!email || !isFounderEmail(email)) return json(200, generic, c.headers);

    const link = mintLoginLink(email);
    await relayMail({
      to: email,
      subject: 'Your Salon Vine console sign-in link',
      text: `Tap to sign in to the founder console:\n\n${link}\n\n` +
            `This link lasts 15 minutes. If you did not ask for it, ignore it — ` +
            `it only works from your inbox, and nothing has been accessed.`
    }).catch(() => null);
    await audit(email, 'founder.link_requested', {});
    return json(200, generic, c.headers);
  }

  return json(400, { error: 'Unknown action.' }, c.headers);
};
