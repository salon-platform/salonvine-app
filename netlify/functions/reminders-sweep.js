/* Booking reminders — hourly scheduled sweep.

   Every confirmed booking with a date gets ONE reminder by text + email in
   the 24 hours before the appointment day. `reminderSentAt` on the booking
   makes it idempotent; a canceled or finished booking never reminds.

   Timezone: bookings store a plain YYYY-MM-DD chosen by the client on the
   salon's site. Salons are US-based, so "is this today or tomorrow?" is
   answered in America/New_York. When the platform goes multi-timezone this
   is the one line to revisit (marked TZ below).                            */

import { getDataStore, getSalonRegistry, relayMail } from './_lib.js';

function dayInNY(offsetDays) {
  const d = new Date(Date.now() + (offsetDays || 0) * 864e5);
  /* en-CA gives YYYY-MM-DD directly. TZ: see header. */
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

export default async () => {
  const store = getDataStore();
  const today = dayInNY(0);
  const tomorrow = dayInNY(1);

  const results = { checked: 0, reminded: 0, errors: 0 };
  const names = new Map(); // slug -> salon name (one registry hit per salon)

  try {
    const { blobs } = await store.list({ prefix: 's/' });
    const bookingKeys = blobs.map(b => b.key).filter(k => k.includes('/bookings/'));

    for (const key of bookingKeys) {
      try {
        const b = await store.get(key, { type: 'json' });
        if (!b) continue;
        results.checked++;

        if (b.status !== 'confirmed') continue;
        if (b.reminderSentAt) continue;
        if (!b.phone && !b.email) continue;
        const date = String(b.date || '').trim();
        if (date !== today && date !== tomorrow) continue;

        const slug = key.split('/')[1];
        if (!names.has(slug)) {
          const reg = await getSalonRegistry(slug).catch(() => null);
          names.set(slug, (reg && reg.name) || 'Your salon');
        }
        const salonName = names.get(slug);
        const dayWord = date === today ? 'today' : 'tomorrow';
        const time = String(b.time || '').trim();
        const line = `${salonName}: reminder — your appointment is ${dayWord}`
          + `${time ? ` at ${time}` : ''}. See you soon!`;

        if (b.phone) {
          await relayMail({ sms: { phone: b.phone }, text: line }).catch(() => null);
        }
        if (b.email) {
          await relayMail({
            to: b.email,
            subject: `Reminder: your appointment ${dayWord}${time ? ` at ${time}` : ''} — ${salonName}`,
            text: `Hi ${String(b.name || '').split(' ')[0] || 'there'},\n\n`
              + `Just a reminder — your appointment at ${salonName} is ${dayWord}`
              + `${time ? ` at ${time}` : ''}.`
              + `${b.service ? `\n\n  ${b.service}` : ''}`
              + `${b.stylist ? `\n  with ${b.stylist}` : ''}`
              + `\n\nSee you soon!\n${salonName}`
          }).catch(() => null);
        }

        await store.setJSON(key, { ...b, reminderSentAt: Date.now() });
        results.reminded++;
      } catch (e) { results.errors++; }
    }
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: 'sweep failed' }), { status: 500 });
  }
  return new Response(JSON.stringify({ ok: true, ...results }), { status: 200 });
};

export const config = { schedule: '0 * * * *' };
