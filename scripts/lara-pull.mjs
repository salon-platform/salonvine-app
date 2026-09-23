/* Pull newly licensed Michigan salons, barbershops, cosmetologists and barbers
   from LARA's public licence lists and keep a running CSV of them.

   Runs on GitHub Actions every weekday morning (.github/workflows/lara-pull.yml).
   The outreach mailer (netlify/functions/_outreach.js) reads the CSV it writes.

   HOW THE PULL WORKS (worked out by Zack's side, Sept 2026)
     LARA publishes whole-profession licence lists as Excel files, free, no
     login:  aca-prod.accela.com/MILARA/Report/ReportParameter.aspx?...reportID=
       32412  Cosmetology (salons, nail/skin shops, cosmetologists) ~107k rows
       32408  Professions A-L, which is where barbers and barbershops live
     ReportParameter.aspx needs a real browser: it sets up a session, then
     ShowReport.aspx with the same query hands back the .xlsx (60-90 s).
     Plain curl gets nothing. So this runs headless Chromium via Playwright.

   WHAT WE KEEP
     Cosmetology Est      full salon (incl. salon suites)   -> "New Salon"
     Cosmetology Est Ltd  nail / skin / wax shop            -> "New Salon (Limited)"
     Barbershop                                             -> "New Barbershop"
     Cosmetologist, Barber   newly licensed people          -> "New Cosmetologist" / "New Barber"
     Schools, instructors and students are skipped. Chains are skipped. Only
     Michigan addresses. Only rows with an email.

   OUTPUT  data/lara-4k9q2v/leads.csv  (same columns as Zack's sheet)
     #,Category,Business Name,Licensee Name,License Type,License #,Issue Date,
     Address,City,State,Zip,County,Email
     Rows are merged by License #: existing rows are kept, new ones added,
     newest issue date first. First run takes the last LOOKBACK_DAYS; after
     that anything newer than what we already have.                          */

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import AdmZip from 'adm-zip';

const OUT = process.env.LEADS_CSV || 'data/lara-4k9q2v/leads.csv';
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 30);
const BASE = 'https://aca-prod.accela.com/MILARA/Report/';
const REPORTS = [
  { id: 32412, label: 'cosmetology' },
  { id: 32408, label: 'professions A-L (barbers)' }
];

const KEEP = {
  'cosmetology est': 'New Salon',
  'cosmetology est ltd': 'New Salon (Limited)',
  'barbershop': 'New Barbershop',
  'cosmetologist': 'New Cosmetologist',
  'barber': 'New Barber'
};
const CHAIN = /\b(regis|supercuts|sport ?clips|great clips|waxing the city|fantastic sams|cost cutters|smartstyle|ulta|jcpenney|hair cuttery|european wax|floyd'?s|roosters|boardroom|lunchbox wax|drybar|massage envy|hand ?& ?stone|the joint)\b/i;

/* ---------- download ---------- */
async function download(page, id) {
  const q = `module=Licenses&reportID=${id}&reportType=LINK_REPORT_LIST`;
  console.log(`[${id}] opening ReportParameter…`);
  let dl = null;
  const waitDl = page.waitForEvent('download', { timeout: 240000 }).then(d => (dl = d)).catch(() => null);
  try {
    await page.goto(BASE + 'ReportParameter.aspx?' + q, { waitUntil: 'domcontentloaded', timeout: 120000 });
  } catch (e) {
    if (!/download/i.test(String(e))) throw e;         /* "Download is starting" is fine */
  }
  /* Give the page time to set up its session / redirect / start the file. */
  const t0 = Date.now();
  while (!dl && Date.now() - t0 < 150000) {
    await page.waitForTimeout(3000);
    if (/ShowReport\.aspx/i.test(page.url())) break;
  }
  if (dl) {
    const p = await dl.path();
    console.log(`[${id}] browser download after ${Math.round((Date.now() - t0) / 1000)}s`);
    return fs.readFileSync(p);
  }
  console.log(`[${id}] fetching ShowReport with the session…`);
  const res = await page.context().request.get(BASE + 'ShowReport.aspx?' + q, { timeout: 300000 });
  if (!res.ok()) throw new Error(`ShowReport ${res.status()} for ${id}`);
  const buf = await res.body();
  await waitDl.catch(() => {});
  return buf;
}

/* ---------- xlsx -> rows (no shared-strings assumption) ---------- */
function unesc(s) {
  return String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function colIndex(letters) {
  let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1;
}
function readSheet(buf) {
  const zip = new AdmZip(buf);
  const get = n => { const e = zip.getEntry(n); return e ? e.getData().toString('utf8') : ''; };
  const shared = [];
  const ss = get('xl/sharedStrings.xml');
  if (ss) for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    shared.push(unesc([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join('')));
  }
  const xml = get('xl/worksheets/sheet1.xml');
  if (!xml) throw new Error('sheet1.xml missing — not an xlsx?');
  const rows = [];
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    /* style attribute comes before r= in these files, so allow anything first */
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)\br="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1] + cm[3], inner = cm[4] || '';
      const t = (attrs.match(/\bt="([^"]+)"/) || [])[1] || '';
      let v = '';
      if (t === 's') { const i = (inner.match(/<v>([^<]*)<\/v>/) || [])[1]; v = shared[Number(i)] || ''; }
      else if (t === 'inlineStr') v = unesc([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join(''));
      else v = unesc((inner.match(/<v>([^<]*)<\/v>/) || [])[1] || '');
      row[colIndex(cm[2])] = v.trim();
    }
    if (row.some(x => x)) rows.push(row);
  }
  return rows;
}

/* ---------- dates ---------- */
function serialToISO(n) {
  const d = new Date(Math.round((Number(n) - 25569) * 86400000));
  return d.toISOString().slice(0, 10);
}
function toISO(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/^\d+(\.\d+)?$/.test(s)) return serialToISO(s);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const d = new Date(s); return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}

/* ---------- header mapping ---------- */
function mapHeader(h) {
  const H = h.map(x => String(x || '').toLowerCase());
  const find = (...needles) => { for (const n of needles) { const i = H.findIndex(x => x.includes(n)); if (i !== -1) return i; } return -1; };
  const m = {
    last: find('last'), first: find('first'),
    facility: find('facility', 'business', 'dba', 'establishment'),
    type: find('license type', 'licence type', 'type'),
    profession: find('profession'),
    num: H.findIndex(x => /licen[cs]e\s*(#|no|num)/.test(x)),
    status: find('status'),
    issue: find('issue'),
    address: find('address', 'street'),
    city: find('city'), state: find('state'), zip: find('zip', 'postal'), county: find('county'),
    email: find('email', 'e-mail')
  };
  if (m.num === -1) m.num = find('license', 'licence');
  return m;
}

/* ---------- csv ---------- */
const HEAD = ['#', 'Category', 'Business Name', 'Licensee Name', 'License Type', 'License #', 'Issue Date', 'Address', 'City', 'State', 'Zip', 'County', 'Email'];
function csvEsc(v) { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  const src = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) { if (ch === '"') { if (src[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else f += ch;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows;
}

/* ---------- main ---------- */
const existing = new Map();          /* license# -> row (array, without #) */
if (fs.existsSync(OUT)) {
  const rows = parseCsv(fs.readFileSync(OUT, 'utf8'));
  for (const r of rows.slice(1)) if (r[5]) existing.set(r[5], r.slice(1));
}
const newestKnown = [...existing.values()].map(r => r[5]).filter(Boolean).sort().pop() || '';
const cutoff = newestKnown || new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString().slice(0, 10);
console.log(`existing ${existing.size} rows; keeping issue dates >= ${cutoff}`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ acceptDownloads: true, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36' });
const page = await ctx.newPage();

let added = 0, seenTypes = {};
for (const rep of REPORTS) {
  let buf;
  try { buf = await download(page, rep.id); }
  catch (e) { console.error(`[${rep.id}] FAILED: ${e.message}`); continue; }
  console.log(`[${rep.id}] ${(buf.length / 1048576).toFixed(1)} MB`);
  let rows;
  try { rows = readSheet(buf); } catch (e) { console.error(`[${rep.id}] parse failed: ${e.message}`); continue; }
  console.log(`[${rep.id}] ${rows.length} rows; header: ${JSON.stringify(rows[0])}`);
  const m = mapHeader(rows[0]);
  if (m.type === -1 || m.issue === -1 || m.email === -1) { console.error(`[${rep.id}] header not understood`, m); continue; }

  for (const r of rows.slice(1)) {
    const type = String(r[m.type] || '').trim();
    seenTypes[type] = (seenTypes[type] || 0) + 1;
    const cat = KEEP[type.toLowerCase()];
    if (!cat) continue;
    if (m.status !== -1 && r[m.status] && !/active/i.test(r[m.status])) continue;
    const issue = toISO(r[m.issue]);
    if (!issue || issue < cutoff) continue;
    const email = String(r[m.email] || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) continue;
    const num = String(r[m.num] || '').trim();
    if (!num || existing.has(num)) continue;
    const state = m.state !== -1 ? String(r[m.state] || '').trim().toUpperCase() : 'MI';
    if (state && state !== 'MI') continue;
    const facility = m.facility !== -1 ? String(r[m.facility] || '').trim() : '';
    if (CHAIN.test(facility)) continue;
    const person = [m.first !== -1 ? r[m.first] : '', m.last !== -1 ? r[m.last] : ''].map(x => String(x || '').trim()).filter(Boolean).join(' ');
    existing.set(num, [cat, facility, person, type, num, issue,
      m.address !== -1 ? r[m.address] || '' : '', m.city !== -1 ? r[m.city] || '' : '', state || 'MI',
      m.zip !== -1 ? String(r[m.zip] || '').slice(0, 5) : '', m.county !== -1 ? r[m.county] || '' : '', email]);
    added++;
  }
}
await browser.close();
console.log('types seen:', JSON.stringify(Object.fromEntries(Object.entries(seenTypes).sort((a, b) => b[1] - a[1]).slice(0, 25))));

/* newest first, then business before people, then name */
const all = [...existing.values()].sort((a, b) => (b[5] || '').localeCompare(a[5] || '') || a[0].localeCompare(b[0]) || (a[1] || a[2]).localeCompare(b[1] || b[2]));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
const lines = [HEAD.join(',')].concat(all.map((r, i) => [i + 1, ...r].map(csvEsc).join(',')));
fs.writeFileSync(OUT, lines.join('\n') + '\n');
fs.writeFileSync(path.join(path.dirname(OUT), 'last-run.json'), JSON.stringify({ at: new Date().toISOString(), added, total: all.length, cutoff }, null, 2) + '\n');
console.log(`added ${added}; total ${all.length}; wrote ${OUT}`);
