/* Opening-hours helpers shared by signup (free-text "Tue–Sat 9–6") and the
   portal's hours editor. Everything ends up as 7 rows, one per weekday
   (0 = Sunday … 6 = Saturday): { weekday, closed, opens:'09:00', closes:'18:00' }.

   parseHoursText() is forgiving on purpose — owners type things like
   "Tue-Sat 9-6", "Mon–Fri 9am–7pm, Sat 9–3", "Tuesday to Saturday 10:00-6:00",
   "Closed Sun & Mon". Anything it can't read is simply left closed; the owner
   can fix it in the portal. */

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_ALIASES = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6
};

const pad = n => String(n).padStart(2, '0');

/* "9", "9am", "9:30", "6pm", "18:00", "12pm" -> minutes since midnight, or null */
function parseClock(raw) {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?$/i.exec(String(raw || '').trim());
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ap = (m[3] || '').toLowerCase().replace(/\./g, '');
  if (h > 24 || min > 59) return null;
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return { mins: h * 60 + min, explicit: !!ap || h > 12 || (m[2] !== undefined && h >= 13) };
}

/* "9-6", "9am–6pm", "10:00 to 18:00" -> { opens, closes } as HH:MM, or null.
   Without am/pm, a salon day is assumed to start in the morning and end in
   the afternoon: "9-6" means 09:00–18:00, "10-7" means 10:00–19:00. */
function parseRange(raw) {
  const m = /(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)\s*(?:-|–|—|to|until|till)\s*(\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)/i.exec(String(raw || ''));
  if (!m) return null;
  const a = parseClock(m[1]), b = parseClock(m[2]);
  if (!a || !b) return null;
  let opens = a.mins, closes = b.mins;
  if (!a.explicit && opens < 6 * 60) opens += 12 * 60;           /* "1-9" -> 13:00 */
  if (!b.explicit && closes <= opens) closes += 12 * 60;         /* "9-6"  -> 18:00 */
  if (closes <= opens || closes > 24 * 60) return null;
  return { opens: pad(Math.floor(opens / 60)) + ':' + pad(opens % 60), closes: pad(Math.floor(closes / 60) % 24) + ':' + pad(closes % 60) };
}

function dayIndex(word) {
  const w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (Object.prototype.hasOwnProperty.call(DAY_ALIASES, w)) return DAY_ALIASES[w];
  const short = w.slice(0, 3);
  return DAY_NAMES.indexOf(short);
}

/* "Tue-Sat", "Mon–Fri", "Sat", "Sun & Mon", "Monday to Friday", "weekdays", "daily" -> [weekday...] */
function parseDays(raw) {
  const s = String(raw || '').toLowerCase();
  if (/every ?day|daily|7 days|all week/.test(s)) return [0, 1, 2, 3, 4, 5, 6];
  if (/weekdays?/.test(s)) return [1, 2, 3, 4, 5];
  if (/weekends?/.test(s)) return [0, 6];
  const out = new Set();
  const dayWord = '(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)';
  const rangeRe = new RegExp(dayWord + '\\s*(?:-|–|—|to|through|thru)\\s*' + dayWord, 'g');
  let m;
  const consumed = [];
  while ((m = rangeRe.exec(s))) {
    const a = dayIndex(m[1]), b = dayIndex(m[2]);
    if (a < 0 || b < 0) continue;
    for (let d = a; ; d = (d + 1) % 7) { out.add(d); if (d === b) break; }
    consumed.push(m[0]);
  }
  let rest = s;
  consumed.forEach(c => { rest = rest.replace(c, ' '); });
  const singleRe = new RegExp('\\b' + dayWord + '\\b', 'g');
  while ((m = singleRe.exec(rest))) { const d = dayIndex(m[1]); if (d >= 0) out.add(d); }
  return [...out].sort();
}

/* Free text -> 7 rows. Returns [] when nothing at all could be read. */
export function parseHoursText(text) {
  const rows = {};
  const src = String(text || '').trim();
  if (!src) return [];
  let matchedAny = false;
  src.split(/[,;\n|]+|\s+and\s+|\s+&\s+/i).map(p => p.trim()).filter(Boolean).forEach(part => {
    const days = parseDays(part);
    if (!days.length) return;
    if (/closed|off/i.test(part) && !parseRange(part)) {
      days.forEach(d => { rows[d] = { weekday: d, closed: true, opens: null, closes: null }; });
      matchedAny = true;
      return;
    }
    const range = parseRange(part);
    if (!range) return;
    days.forEach(d => { rows[d] = { weekday: d, closed: false, opens: range.opens, closes: range.closes }; });
    matchedAny = true;
  });
  /* "9-6" with no days at all: treat as every day but Sunday */
  if (!matchedAny) {
    const range = parseRange(src);
    if (!range) return [];
    [1, 2, 3, 4, 5, 6].forEach(d => { rows[d] = { weekday: d, closed: false, opens: range.opens, closes: range.closes }; });
  }
  const out = [];
  for (let d = 0; d < 7; d++) out.push(rows[d] || { weekday: d, closed: true, opens: null, closes: null });
  return out;
}

/* Clean a structured list from the portal editor -> 7 rows (or null if bad). */
export function normalizeHoursRows(list) {
  if (!Array.isArray(list)) return null;
  const byDay = {};
  for (const h of list) {
    const wd = Number(h && h.weekday);
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) continue;
    const closed = !!(h.closed || h.is_closed);
    const o = closed ? null : parseClock(h.opens || h.opens_at), c = closed ? null : parseClock(h.closes || h.closes_at);
    if (!closed && (!o || !c || c.mins <= o.mins)) return null;
    byDay[wd] = closed
      ? { weekday: wd, closed: true, opens: null, closes: null }
      : { weekday: wd, closed: false, opens: pad(Math.floor(o.mins / 60)) + ':' + pad(o.mins % 60), closes: pad(Math.floor(c.mins / 60)) + ':' + pad(c.mins % 60) };
  }
  const out = [];
  for (let d = 0; d < 7; d++) out.push(byDay[d] || { weekday: d, closed: true, opens: null, closes: null });
  return out;
}

/* Rows -> salon_hours table shape. opens_at/closes_at are NOT NULL in the
   schema, so a closed day is stored as 00:00–00:00 with is_closed = true. */
export function toSalonHoursRows(salonId, rows) {
  return rows.map(r => ({
    salon_id: salonId, weekday: r.weekday, is_closed: !!r.closed,
    opens_at: r.closed ? '00:00' : r.opens, closes_at: r.closed ? '00:00' : r.closes
  }));
}
