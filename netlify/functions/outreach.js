/* Outreach controls — founder only. Backs outreach.html.

   GET  ?action=status               -> { config, tally, recent[] }
   POST { action:'load', csv }       -> add contacts from a CSV (dedupes,
                                        honours the suppression list)
   POST { action:'config', ... }     -> save settings (dailyLimit, from,
                                        replyTo, subject, mailingAddress,
                                        sheetCsvUrl)
   POST { action:'sync' }            -> pull new rows from the Google Sheet
                                        now (also happens before each batch)
   POST { action:'start' | 'pause' } -> switch the daily batch on / off
   POST { action:'test', to }        -> send one copy to an address now,
                                        so the founder can see it in a real
                                        inbox before anyone else does
   POST { action:'clear' }           -> drop everyone still queued (sent and
                                        unsubscribed records are kept)      */

import { cors, json, parseBody, normEmail } from './_lib.js';
import { requireFounder, audit } from './_admin.js';
import {
  readConfig, writeConfig, readContacts, writeContacts, readSuppress,
  parseContactsCsv, tally, DEFAULTS, syncFromSheet
} from './_outreach.js';
import { runBatch } from './outreach-send.js';

const s = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 200);

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  const g = requireFounder(req, c.headers);
  if (g.errorResponse) return g.errorResponse;
  const { founder } = g;

  try {
    if (req.method === 'GET') {
      const contacts = await readContacts();
      const recent = contacts
        .filter(x => x.sentAt || x.unsubAt || x.failedAt)
        .sort((a, b) => (b.sentAt || b.unsubAt || b.failedAt || 0) - (a.sentAt || a.unsubAt || a.failedAt || 0))
        .slice(0, 25)
        .map(x => ({ email: x.email, salon: x.salon, status: x.status, at: x.sentAt || x.unsubAt || x.failedAt, error: x.error || '' }));
      return json(200, { ok: true, config: await readConfig(), tally: tally(contacts), recent }, c.headers);
    }

    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);
    const body = await parseBody(req);
    if (!body) return json(400, { error: 'Invalid JSON' }, c.headers);
    const action = s(body.action, 20);

    /* ---- load a CSV ---- */
    if (action === 'load') {
      const parsed = parseContactsCsv(body.csv);
      if (parsed.error) return json(400, { error: parsed.error, columns: parsed.columns }, c.headers);
      const existing = await readContacts();
      const have = new Set(existing.map(x => x.email));
      const suppressed = await readSuppress();
      let added = 0, dupes = 0, blocked = 0;
      for (const ct of parsed.contacts) {
        if (have.has(ct.email)) { dupes++; continue; }
        if (suppressed[ct.email]) { blocked++; continue; }
        existing.push({ ...ct, status: 'queued', addedAt: Date.now() });
        have.add(ct.email); added++;
      }
      await writeContacts(existing);
      await audit(founder.email, 'outreach.load', { added, dupes, blocked, dropped: parsed.dropped });
      return json(200, { ok: true, added, dupes, blocked, dropped: parsed.dropped, columns: parsed.columns, tally: tally(existing) }, c.headers);
    }

    /* ---- settings ---- */
    if (action === 'config') {
      const patch = {};
      if (body.dailyLimit != null) patch.dailyLimit = Math.max(1, Math.min(parseInt(body.dailyLimit, 10) || DEFAULTS.dailyLimit, 500));
      if (body.from != null) patch.from = s(body.from, 120);
      if (body.replyTo != null) patch.replyTo = normEmail(body.replyTo) || DEFAULTS.replyTo;
      if (body.subject != null) patch.subject = s(body.subject, 140);
      if (body.mailingAddress != null) patch.mailingAddress = s(body.mailingAddress, 160);
      if (body.sheetCsvUrl != null) patch.sheetCsvUrl = s(body.sheetCsvUrl, 400);
      const cfg = await writeConfig(patch);
      await audit(founder.email, 'outreach.config', patch);
      return json(200, { ok: true, config: cfg }, c.headers);
    }

    if (action === 'start' || action === 'pause') {
      const cfg = await readConfig();
      if (action === 'start') {
        if (!cfg.mailingAddress || cfg.mailingAddress.length < 12) return json(400, { error: 'Set a mailing address first — it has to appear on every email.' }, c.headers);
        if (!/@mail\.salonvine\.com>?$/i.test(cfg.from)) return json(400, { error: 'The sender has to be on mail.salonvine.com. Verify that subdomain in Resend, then set it here.' }, c.headers);
      }
      const next = await writeConfig({ active: action === 'start' });
      await audit(founder.email, 'outreach.' + action, {});
      return json(200, { ok: true, config: next }, c.headers);
    }

    /* ---- one test copy ---- */
    if (action === 'test') {
      const to = normEmail(body.to);
      if (!to) return json(400, { error: 'Enter an email to send the test to.' }, c.headers);
      const cfg = await readConfig();
      if (!cfg.mailingAddress) return json(400, { error: 'Set a mailing address first so the test matches the real thing.' }, c.headers);
      /* Run the real sender against a one-off contact, without touching the list. */
      const { runTest } = await import('./outreach-send.js');
      const r = await runTest(cfg, { email: to, name: 'Test', salon: 'Test Salon', city: '' });
      if (!r.ok) return json(502, { error: r.error }, c.headers);
      return json(200, { ok: true, id: r.id }, c.headers);
    }

    /* ---- pull the sheet now ---- */
    if (action === 'sync') {
      const cfg = await readConfig();
      const r = await syncFromSheet(cfg);
      await audit(founder.email, 'outreach.sync', { added: r.added, rows: r.rows, error: r.error });
      if (!r.ok) return json(502, { error: r.error, ...r }, c.headers);
      return json(200, { ok: true, ...r, tally: tally(await readContacts()) }, c.headers);
    }

    /* ---- send today's batch right now ---- */
    if (action === 'batch') {
      const r = await runBatch(body.limit, true);
      await audit(founder.email, 'outreach.batch', r);
      return json(200, { ok: true, ...r }, c.headers);
    }

    /* ---- drop the queue ---- */
    if (action === 'clear') {
      const contacts = await readContacts();
      const keep = contacts.filter(x => x.status !== 'queued');
      await writeContacts(keep);
      await audit(founder.email, 'outreach.clear', { removed: contacts.length - keep.length });
      return json(200, { ok: true, tally: tally(keep) }, c.headers);
    }

    return json(400, { error: 'Unknown action.' }, c.headers);
  } catch (e) {
    return json(500, { error: `Outreach hit a snag: ${String((e && e.message) || e).slice(0, 160)}` }, c.headers);
  }
};
