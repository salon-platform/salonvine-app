/* Daily outreach batch — scheduled (see netlify.toml), weekday mornings.

   Sends the next `dailyLimit` queued contacts the invitation email through
   Resend, one at a time, and marks each one sent. It refuses to run at all
   unless the founder has switched it on AND set a mailing address, because
   commercial email without a postal address is not legal in the US and a
   missing one is the easiest mistake to make.

   Deliverability is the whole game here, so:
     - the sender is a SUBDOMAIN (mail.salonvine.com), never the domain the
       booking emails use;
     - every message carries List-Unsubscribe + one-click headers, which
       Gmail and Yahoo require of anyone sending in volume;
     - a text version rides along with the HTML;
     - the batch stops on the first Resend error rather than hammering on;
     - the daily cap starts small and the founder raises it by hand as the
       domain earns a reputation.

   Also callable by the founder with ?now=1 for an immediate batch (used by
   the "Send today's batch now" button).                                    */

import { cors, json, APP_URL } from './_lib.js';
import { requireFounder } from './_admin.js';
import {
  readConfig, writeConfig, readContacts, writeContacts, readSuppress, unsubToken
} from './_outreach.js';
import { HTML, TEXT, SUBJECT_DEFAULT } from './outreach-template.js';

const PAUSE_MS = 1200;   /* ~1 message a second: gentle, looks human */

function fill(tpl, vars) {
  return tpl.replace(/\{\{(UNSUB|ADDRESS)\}\}/g, (_, k) => vars[k] || '');
}
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendOne(cfg, contact) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: false, error: 'RESEND_API_KEY not set' };

  const unsub = `${APP_URL}/api/outreach-unsub?t=${encodeURIComponent(unsubToken(contact.email))}`;
  const vars = { UNSUB: unsub, ADDRESS: esc(cfg.mailingAddress) };
  const payload = {
    from: cfg.from,
    to: [contact.email],
    reply_to: cfg.replyTo || undefined,
    subject: cfg.subject || SUBJECT_DEFAULT,
    html: fill(HTML, vars),
    text: fill(TEXT, { UNSUB: unsub, ADDRESS: cfg.mailingAddress }),
    headers: {
      'List-Unsubscribe': `<${unsub}>, <mailto:${(cfg.replyTo || 'hello@salonvine.com')}?subject=unsubscribe>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
    },
    tags: [{ name: 'kind', value: 'outreach' }]
  };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) return { ok: false, error: `Resend ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const data = await res.json().catch(() => ({}));
  return { ok: true, id: data.id || '' };
}

/* One copy to one address, outside the list. The founder's "send me a test".
   Uses whatever sender is configured; if the subdomain is not verified yet
   Resend says so in plain words and the console shows it. */
export async function runTest(cfg, contact) {
  return sendOne(cfg, contact);
}

function todayNY() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export async function runBatch(limitOverride, manual) {
  const cfg = await readConfig();
  const out = { ran: false, sent: 0, failed: 0, skipped: 0, remaining: 0, reason: '' };

  if (!cfg.active) { out.reason = 'Outreach is switched off.'; return out; }
  /* The function URL is public like any other. Whoever pokes it, the
     automatic batch goes out at most once a day; only a signed-in founder
     can send more than that. */
  if (!manual && cfg.lastRunDay === todayNY()) { out.reason = 'Already sent today\u2019s batch.'; return out; }
  if (!cfg.mailingAddress || cfg.mailingAddress.length < 12) {
    out.reason = 'No mailing address set — required on commercial email. Nothing sent.';
    return out;
  }
  if (!/@mail\.salonvine\.com>?$/i.test(cfg.from.trim())) {
    out.reason = 'Sender is not on mail.salonvine.com. Cold mail must not go out on the booking-email domain. Nothing sent.';
    return out;
  }

  const limit = Math.max(1, Math.min(Number(limitOverride) || cfg.dailyLimit || 40, 500));
  const contacts = await readContacts();
  const suppressed = await readSuppress();
  out.ran = true;

  for (const c of contacts) {
    if (out.sent + out.failed >= limit) break;
    if (c.status !== 'queued') continue;
    if (suppressed[c.email]) { c.status = 'unsubscribed'; c.unsubAt = Date.now(); out.skipped++; continue; }

    const r = await sendOne(cfg, c);
    if (r.ok) {
      c.status = 'sent'; c.sentAt = Date.now(); c.resendId = r.id; out.sent++;
    } else {
      c.status = 'failed'; c.error = r.error; c.failedAt = Date.now(); out.failed++;
      /* An auth or domain error will fail every message the same way. Stop,
         save what happened, and let the founder read the error. */
      if (/Resend 4(0[13]|22)/.test(r.error)) { out.reason = r.error; break; }
    }
    await new Promise(res => setTimeout(res, PAUSE_MS));
  }
  await writeContacts(contacts);
  if (!manual) await writeConfig({ lastRunDay: todayNY() });
  out.remaining = contacts.filter(c => c.status === 'queued').length;
  return out;
}

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;

  /* Scheduled invocations carry no founder cookie; a founder pressing the
     button does. Anyone else gets nothing. */
  const url = new URL(req.url);
  const manual = url.searchParams.get('now') === '1';
  if (manual) {
    const g = requireFounder(req, c.headers);
    if (g.errorResponse) return g.errorResponse;
    const result = await runBatch(url.searchParams.get('limit'), true);
    return json(200, { ok: true, ...result }, c.headers);
  }

  const result = await runBatch();
  console.log('outreach-send', JSON.stringify(result));
  return json(200, { ok: true, ...result }, c.headers);
};
