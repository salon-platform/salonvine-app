// Empties the Supabase outbox: hands each pending email to Resend and marks
// it sent or failed. Runs every minute on a schedule (see netlify.toml).
//
// This file never decides WHAT to send. The database writes every letter
// (see sv_queue / appointment_messages); this just carries them. If Resend
// is down, letters stay in the tray and get retried — up to 5 attempts,
// then they are marked failed with the reason kept on the row.
//
// Env vars (Netlify → Site configuration → Environment variables):
//   SUPABASE_SECRET_KEY  server-only key, never in a browser
//   RESEND_API_KEY       from resend.com → API keys
//   OUTBOX_FROM          optional, default "SalonVine <bookings@salonvine.com>"
//   SMS_GATEWAYS         optional, carrier email-to-text domains, default
//                        "vtext.com,tmomail.net,txt.att.net" (Verizon, T-Mobile, AT&T)
//
// Texts: there is no paid SMS provider. A text is sent as a short email to the
// phone number at each carrier's email-to-text gateway; only the client's own
// carrier delivers it, the others quietly drop it. That is how the old Apps
// Script relay did it too, just from a salonvine.com address now.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zdlytaswwvemnlgnonnd.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || '';
const RESEND_KEY   = process.env.RESEND_API_KEY || '';
const FROM         = process.env.OUTBOX_FROM || 'SalonVine <bookings@salonvine.com>';
const BATCH        = 25;
const SMS_GATEWAYS = String(process.env.SMS_GATEWAYS || 'vtext.com,tmomail.net,txt.att.net')
  .split(',').map(function (g) { return g.trim(); }).filter(Boolean);

function sbHeaders(extra) {
  return Object.assign({
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json'
  }, extra || {});
}

async function rpc(name, args) {
  const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + name, {
    method: 'POST', headers: sbHeaders(), body: JSON.stringify(args || {})
  });
  const text = await res.text();
  if (!res.ok) throw new Error(name + ' HTTP ' + res.status + ': ' + text.slice(0, 200));
  return text ? JSON.parse(text) : null;
}

// The salon this letter belongs to, so replies go to the salon, not to us.
async function salonFor(outboxId) {
  const url = SUPABASE_URL + '/rest/v1/outbox?id=eq.' + outboxId + '&select=salon:salon_id(name,owner_email)';
  const res = await fetch(url, { headers: sbHeaders() });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows && rows[0] && rows[0].salon ? rows[0].salon : null;
}

async function sendEmail(row, salon) {
  const isHtml = /^\s*</.test(row.body || '');
  const payload = {
    from: FROM,
    to: [row.to_name ? row.to_name + ' <' + row.to_address + '>' : row.to_address],
    subject: row.subject || 'Your appointment',
    headers: { 'X-SalonVine-Outbox': String(row.id) }
  };
  if (isHtml) payload.html = row.body; else payload.text = row.body;
  if (salon && salon.owner_email) payload.reply_to = salon.owner_email;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  if (!res.ok) throw new Error('Resend HTTP ' + res.status + ': ' + text.slice(0, 200));
  return text;
}

// A US number -> its email-to-text addresses. "(989) 555-1234" -> 9895551234@vtext.com ...
function smsAddresses(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  const ten = (digits.length === 11 && digits[0] === '1') ? digits.slice(1) : digits;
  if (ten.length !== 10) return [];
  return SMS_GATEWAYS.map(function (g) { return ten + '@' + g; });
}

async function sendSms(row, salon) {
  const targets = smsAddresses(row.to_address);
  if (!targets.length) throw new Error('not a 10-digit US number: ' + row.to_address);
  // Gateways show roughly 160 characters; keep the text tight and plain.
  const text = String(row.body || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
  let lastErr = null, ok = 0;
  for (const to of targets) {
    const payload = {
      from: FROM, to: [to],
      subject: (salon && salon.name) ? salon.name : 'SalonVine',
      text: text,
      headers: { 'X-SalonVine-Outbox': String(row.id) }
    };
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) { ok++; } else { lastErr = 'Resend HTTP ' + res.status + ': ' + (await res.text()).slice(0, 200); }
  }
  if (!ok) throw new Error(lastErr || 'no gateway accepted the text');
}

exports.handler = async function () {
  if (!SUPABASE_KEY || !RESEND_KEY) {
    const missing = [!SUPABASE_KEY && 'SUPABASE_SECRET_KEY', !RESEND_KEY && 'RESEND_API_KEY'].filter(Boolean);
    console.error('outbox-send: not configured, missing ' + missing.join(', '));
    return { statusCode: 500, body: 'missing ' + missing.join(', ') };
  }

  let rows;
  try { rows = await rpc('sv_outbox_claim', { p_limit: BATCH }); }
  catch (e) { console.error('outbox-send: claim failed', e.message); return { statusCode: 500, body: e.message }; }
  if (!rows || !rows.length) return { statusCode: 200, body: 'nothing to send' };

  let sent = 0, failed = 0, skipped = 0;
  for (const row of rows) {
    if (row.channel !== 'email' && row.channel !== 'sms') {
      skipped++;
      await rpc('sv_outbox_done', { p_id: row.id, p_ok: false, p_error: 'no ' + row.channel + ' provider configured yet' }).catch(function () {});
      continue;
    }
    try {
      const salon = await salonFor(row.id);
      if (row.channel === 'sms') await sendSms(row, salon); else await sendEmail(row, salon);
      await rpc('sv_outbox_done', { p_id: row.id, p_ok: true });
      sent++;
    } catch (e) {
      failed++;
      console.error('outbox-send: row ' + row.id + ' failed: ' + e.message);
      await rpc('sv_outbox_done', { p_id: row.id, p_ok: false, p_error: e.message.slice(0, 500) }).catch(function () {});
    }
  }
  const summary = 'sent ' + sent + ', failed ' + failed + ', skipped ' + skipped + ' of ' + rows.length;
  console.log('outbox-send: ' + summary);
  return { statusCode: 200, body: summary };
};
