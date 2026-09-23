/* One-click unsubscribe for the outreach mailer. Public on purpose.

   GET  ?t=<token>   the link in the email footer -> marks the address
                     unsubscribed, shows a plain confirmation page
   POST ?t=<token>   what Gmail/Yahoo send when someone presses their own
                     "Unsubscribe" button (RFC 8058) -> same, returns 200

   The token is signed, so nobody can unsubscribe someone else by guessing.
   The address goes on the permanent suppression list as well as being
   flagged in the contact list, so a re-uploaded CSV can never bring it back. */

import { cors, json } from './_lib.js';
import { readContacts, writeContacts, suppress, unsubEmailFromToken } from './_outreach.js';

function page(title, body) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<body style="margin:0;background:#F6F4F0;font-family:Arial,Helvetica,sans-serif;color:#3A3A36">
<div style="max-width:520px;margin:60px auto;background:#fff;border:1px solid #E5E1DA;border-radius:6px;padding:36px 32px">
<img src="https://salonvine.com/logo-sv.png" width="90" alt="SalonVine" style="display:block;margin:0 auto 18px">
<h1 style="font:normal 22px Georgia,serif;color:#1C1C1A;text-align:center;margin:0 0 14px">${title}</h1>
<p style="font-size:15px;line-height:24px;text-align:center;margin:0">${body}</p>
</div></body>`,
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
  );
}

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (req.method !== 'GET' && req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

  const token = new URL(req.url).searchParams.get('t') || '';
  const email = unsubEmailFromToken(token);
  if (!email) {
    return req.method === 'POST'
      ? json(400, { error: 'Bad link' }, c.headers)
      : page('That link has expired', 'Reply to the original email with the word "unsubscribe" and we’ll take care of it by hand.');
  }

  try {
    await suppress(email, 'unsubscribed');
    const contacts = await readContacts();
    let hit = false;
    for (const ct of contacts) {
      if (ct.email === email) { ct.status = 'unsubscribed'; ct.unsubAt = Date.now(); hit = true; }
    }
    if (hit) await writeContacts(contacts);
  } catch (e) {
    /* Suppression is the part that matters and it ran first. */
  }

  if (req.method === 'POST') return json(200, { ok: true }, c.headers);
  return page('You’re unsubscribed', 'You won’t hear from us again. Thanks for letting us know.');
};
