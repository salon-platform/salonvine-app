/* Turn whatever an owner typed on the login page into the salon's real slug.
   "Studio 17", "studio-17", "Studio 17 Salon" and "studio17" all mean the
   salon whose slug is studio17. Falls back to the plain slug when Supabase
   is unreachable, so nothing gets worse than before. */
import { normSlug } from './_lib.js';
import { sbReady, sbSelect } from './_supabase.js';

const bare = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const trimKind = s => s.replace(/(salon|barbershop|barbers|studio|spa|hair)$/g, '');

export async function resolveSlug(input) {
  const want = bare(input);
  if (!want) return null;
  const plain = normSlug(input) || normSlug(want);
  if (!sbReady()) return plain;
  try {
    const rows = await sbSelect('salon', 'select=slug,name&deleted_at=is.null');
    const hit = rows.find(r => bare(r.slug) === want)
      || rows.find(r => bare(r.name) === want)
      || rows.find(r => trimKind(bare(r.name)) === trimKind(want) && trimKind(want).length >= 3)
      || rows.find(r => trimKind(bare(r.slug)) === trimKind(want) && trimKind(want).length >= 3);
    return hit ? hit.slug : plain;
  } catch (e) { return plain; }
}
