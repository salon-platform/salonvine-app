/* Supabase hands back at most 1,000 rows per request no matter what limit
   you ask for. This walks the pages so a 1,900-client book comes back whole. */
import { sbSelect } from './_supabase.js';

export async function sbSelectAll(table, query, pageSize) {
  const size = pageSize || 1000;
  const out = [];
  for (let offset = 0; ; offset += size) {
    const q = query.replace(/&?limit=\d+/g, '').replace(/&?offset=\d+/g, '');
    const rows = await sbSelect(table, `${q}&limit=${size}&offset=${offset}`);
    out.push(...rows);
    if (rows.length < size) break;
    if (out.length > 200000) break;   /* safety valve */
  }
  return out;
}
