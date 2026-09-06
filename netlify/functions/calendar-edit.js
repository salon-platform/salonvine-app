/* Calendar edits from the portal — add an appointment by hand (walk-in, phone
   booking), block time off for one person or close the whole salon.

   GET  ?slug=            -> { stylists, services, timeOff, closures }
   POST { slug, action:'add', stylistId, date:'2026-09-12', start:'10:00',
          minutes, clientName, email, phone, serviceIds:[], note, notify }
   POST { slug, action:'timeoff', stylistId | 'salon', startsAt, endsAt, reason }
   POST { slug, action:'timeoff-delete', id, kind:'stylist'|'salon' }

   Time off is honoured by the public booking page automatically (sv_slots
   already skips time_off and salon_closure). Appointments go in through
   sv_import_appointments so past ones land as completed, future ones as
   confirmed, with the normal day-before reminder; a confirmation goes out
   only when the person adding it ticks "let the client know". */

import { cors, json, parseBody, normEmail, requireSalonSession } from './_lib.js';
import { sbReady, sbSalon, sbSelect, sbWrite, sbRpc } from './_supabase.js';

const s = (v, max) => String(v == null ? '' : v).trim().slice(0, max || 200);

async function loadLists(salon) {
  const since = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
  const [stylists, services, timeOff, closures] = await Promise.all([
    sbSelect('stylist', `salon_id=eq.${salon.id}&select=id,name,is_active,is_public&order=sort_order,name`),
    sbSelect('service', `salon_id=eq.${salon.id}&is_active=eq.true&select=id,name,category,duration_minutes,price_cents&order=category,sort_order,name&limit=1000`),
    sbSelect('time_off', `select=id,stylist_id,starts_at,ends_at,reason,stylist!inner(name,salon_id)&stylist.salon_id=eq.${salon.id}&ends_at=gte.${encodeURIComponent(since)}&order=starts_at&limit=1000`),
    sbSelect('salon_closure', `salon_id=eq.${salon.id}&select=id,starts_at,ends_at,reason&ends_at=gte.${encodeURIComponent(since)}&order=starts_at&limit=1000`)
  ]);
  return {
    stylists: stylists.map(x => ({ id: x.id, name: x.name, active: x.is_active !== false, isPublic: x.is_public !== false })),
    services: services.map(x => ({ id: x.id, name: x.name, category: x.category || '', minutes: x.duration_minutes || 30, priceCents: x.price_cents || 0 })),
    timeOff: timeOff.map(x => ({ id: x.id, kind: 'stylist', stylistId: x.stylist_id, stylist: (x.stylist && x.stylist.name) || '', startsAt: x.starts_at, endsAt: x.ends_at, reason: x.reason || '' })),
    closures: closures.map(x => ({ id: x.id, kind: 'salon', stylistId: null, stylist: '', startsAt: x.starts_at, endsAt: x.ends_at, reason: x.reason || '' }))
  };
}

export default async (req) => {
  const c = cors(req);
  if (c.preflight) return c.preflight;
  if (!sbReady()) return json(503, { error: 'Calendar editing is not switched on yet.' }, c.headers);

  const qs = new URL(req.url).searchParams;
  const body = req.method === 'POST' ? await parseBody(req) : null;
  if (req.method === 'POST' && !body) return json(400, { error: 'Invalid JSON' }, c.headers);

  const auth = requireSalonSession(req, body ? body.slug : qs.get('slug'), c.headers);
  if (auth.errorResponse) return auth.errorResponse;
  const { slug } = auth;

  try {
    const salon = await sbSalon(slug);
    if (!salon) return json(404, { error: 'Salon not found.' }, c.headers);

    if (req.method === 'GET') return json(200, { ok: true, ...(await loadLists(salon)) }, c.headers);
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' }, c.headers);

    const action = s(body.action, 30);

    /* ---- a booking added by hand ---- */
    if (action === 'add') {
      const stylistId = s(body.stylistId, 60);
      const date = s(body.date, 10), start = s(body.start, 5);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(start)) return json(400, { error: 'Pick a date and a start time.' }, c.headers);
      if (!stylistId) return json(400, { error: 'Pick who the appointment is with.' }, c.headers);
      const stylist = (await sbSelect('stylist', `id=eq.${stylistId}&salon_id=eq.${salon.id}&select=id,name`))[0];
      if (!stylist) return json(400, { error: 'That team member is not in this salon.' }, c.headers);

      const ids = Array.isArray(body.serviceIds) ? body.serviceIds.map(x => s(x, 60)).filter(Boolean).slice(0, 8) : [];
      let services = [];
      if (ids.length) {
        const rows = await sbSelect('service', `salon_id=eq.${salon.id}&id=in.(${ids.join(',')})&select=id,name,duration_minutes,price_cents`);
        /* a stylist's own duration/price wins when she has set one */
        const own = await sbSelect('stylist_service', `stylist_id=eq.${stylist.id}&service_id=in.(${ids.join(',')})&select=service_id,duration_minutes,price_cents`).catch(() => []);
        services = ids.map(id => rows.find(r => r.id === id)).filter(Boolean).map(r => {
          const o = own.find(x => x.service_id === r.id) || {};
          return { id: r.id, name: r.name, minutes: o.duration_minutes || r.duration_minutes || 30, price_cents: o.price_cents != null ? o.price_cents : (r.price_cents || 0) };
        });
      }
      let minutes = parseInt(body.minutes, 10);
      if (!Number.isFinite(minutes) || minutes < 5) minutes = services.reduce((a, x) => a + x.minutes, 0) || 60;
      minutes = Math.min(minutes, 12 * 60);
      if (services.length) {
        /* stretch/shrink the services to the chosen length */
        const sum = services.reduce((a, x) => a + x.minutes, 0) || 1;
        let left = minutes;
        services.forEach((x, i) => { x.minutes = i === services.length - 1 ? Math.max(5, left) : Math.max(5, Math.round(minutes * x.minutes / sum)); left -= x.minutes; });
      }
      const [h, m] = start.split(':').map(Number);
      const startMin = h * 60 + m, endMin = startMin + minutes;
      const pad = n => String(n).padStart(2, '0');
      const stamp = mm => `${date} ${pad(Math.floor(mm / 60) % 24)}:${pad(mm % 60)}`;
      const price = services.reduce((a, x) => a + (x.price_cents || 0), 0);
      const email = normEmail(body.email) || '';
      const row = {
        stylist_id: stylist.id, starts_local: stamp(startMin), ends_local: stamp(endMin),
        client_name: s(body.clientName, 120) || 'Walk-in', client_email: email, client_phone: s(body.phone, 40),
        services: services.map(x => ({ id: x.id, minutes: x.minutes, price_cents: x.price_cents })),
        price_cents: price, status: '', note: s(body.note, 500)
      };
      const out = await sbRpc('sv_import_appointments', { p_salon_id: salon.id, p_rows: [row] });
      const r = (out && out[0]) || {};
      if (!r.ok) return json(409, { error: r.skip ? 'There is already a booking for ' + stylist.name + ' at that time.' : (r.error || 'Could not add that appointment.') }, c.headers);

      let notified = false;
      if (body.notify && r.status === 'confirmed' && (email || row.client_phone)) {
        try { await sbRpc('sv_queue', { p_template: 'booking_confirmed', p_appt: r.id, p_to: email || row.client_phone, p_when: new Date().toISOString() }); notified = true; }
        catch (e) { console.error('calendar-edit: confirmation not queued', e.message); }
      }
      return json(200, { ok: true, id: r.id, status: r.status, notified }, c.headers);
    }

    /* ---- time off / salon closed ---- */
    if (action === 'timeoff') {
      const startsAt = new Date(s(body.startsAt, 40)), endsAt = new Date(s(body.endsAt, 40));
      if (isNaN(startsAt) || isNaN(endsAt) || endsAt <= startsAt) return json(400, { error: 'Pick a start and an end (the end has to be after the start).' }, c.headers);
      const reason = s(body.reason, 140);
      const who = s(body.stylistId, 60);
      if (!who || who === 'salon') {
        const w = await sbWrite('salon_closure', 'insert', null, [{ salon_id: salon.id, starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(), reason }]);
        return json(200, { ok: true, id: w[0] && w[0].id, kind: 'salon' }, c.headers);
      }
      const stylist = (await sbSelect('stylist', `id=eq.${who}&salon_id=eq.${salon.id}&select=id`))[0];
      if (!stylist) return json(400, { error: 'That team member is not in this salon.' }, c.headers);
      const w = await sbWrite('time_off', 'insert', null, [{ stylist_id: stylist.id, starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(), reason }]);
      return json(200, { ok: true, id: w[0] && w[0].id, kind: 'stylist' }, c.headers);
    }

    if (action === 'timeoff-delete') {
      const id = s(body.id, 60), kind = s(body.kind, 10);
      if (!id) return json(400, { error: 'Nothing to remove.' }, c.headers);
      if (kind === 'salon') {
        await sbWrite('salon_closure', 'delete', `id=eq.${id}&salon_id=eq.${salon.id}`);
      } else {
        const own = await sbSelect('time_off', `id=eq.${id}&select=id,stylist!inner(salon_id)&stylist.salon_id=eq.${salon.id}`);
        if (!own.length) return json(404, { error: 'That time off is not in this salon.' }, c.headers);
        await sbWrite('time_off', 'delete', `id=eq.${id}`);
      }
      return json(200, { ok: true }, c.headers);
    }

    return json(400, { error: 'Unknown action.' }, c.headers);
  } catch (e) {
    return json(500, { error: `Calendar hit a snag: ${String((e && e.message) || e).slice(0, 160)}` }, c.headers);
  }
};
