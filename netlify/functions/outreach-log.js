/* The send log as a CSV — who has been emailed, when, and what happened.

   GET /api/outreach-log?t=<signed link token>     (what a Google Sheet uses)
   GET /api/outreach-log                            (founder cookie, from the console)

   The link token is signed with the founder-console secret and only ever
   unlocks this read-only list, so it can sit in a Google Sheet formula
   (=IMPORTDATA(...)) without exposing anything else. The founder console
   shows the link; nobody types a secret anywhere.                           */

import { cors } from './_lib.js';
import { requireFounder, verifyAdminToken } from './_admin.js';
import { readContacts } from './_outreach.js';

function csvEsc(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function whenET(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).replace(',', '');
}
const LABEL = { queued: 'Waiting', sent: 'Emailed', unsubscribed: 'Unsubscribed', failed: 'Failed' };

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  const url = new URL(req.url);
  const t = url.searchParams.get('t');
  let allowed = false;
  if (t) { const p = verifyAdminToken(t); allowed = !!(p && p.kind === 'log'); }
  if (!allowed) { const g = requireFounder(req, c.headers); if (g.errorResponse) return g.errorResponse; }

  const contacts = await readContacts();
  /* emailed first (newest at the top), then waiting, then the rest */
  const rank = { sent: 0, queued: 1, unsubscribed: 2, failed: 3 };
  contacts.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || (b.sentAt || b.addedAt || 0) - (a.sentAt || a.addedAt || 0));

  const lines = [['Status', 'Emailed on (ET)', 'Salon', 'Name', 'City', 'Email', 'Unsubscribed on (ET)', 'Problem', 'Added on (ET)', 'Source'].join(',')];
  for (const x of contacts) {
    lines.push([
      LABEL[x.status] || x.status, whenET(x.sentAt), x.salon, x.name, x.city, x.email,
      whenET(x.unsubAt), x.error || '', whenET(x.addedAt), x.source || 'pasted'
    ].map(csvEsc).join(','));
  }
  return new Response(lines.join('\n') + '\n', {
    status: 200,
    headers: {
      ...c.headers,
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'inline; filename="salonvine-outreach-log.csv"',
      'Cache-Control': 'no-store'
    }
  });
};
