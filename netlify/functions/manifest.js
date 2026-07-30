/* Per-salon web app manifest so "Add to Home Screen" installs the portal
   under the salon's own name and accent color. */

import { normSlug, getSalonRegistry } from './_lib.js';

const DEFAULT_ACCENT = '#a8836a';
const BACKGROUND = '#faf6f0';

export default async (req, context) => {
  const slug = normSlug(new URL(req.url).searchParams.get('slug'));

  let name = 'Salon Vine Portal';
  let accent = DEFAULT_ACCENT;
  let startUrl = '/portal.html';

  if (slug) {
    startUrl = `/p/${slug}`;
    try {
      const registry = await getSalonRegistry(slug);
      if (registry) {
        name = `${registry.name || slug} Portal`;
        if (/^#[0-9a-fA-F]{3,8}$/.test(String(registry.accent || ''))) accent = registry.accent;
      }
    } catch (e) { /* defaults are fine */ }
  }

  const shortName = name.replace(/ Portal$/, '');
  const manifest = {
    name,
    short_name: shortName.length > 12 ? 'Portal' : shortName,
    start_url: startUrl,
    scope: '/',
    display: 'standalone',
    background_color: BACKGROUND,
    theme_color: accent,
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }
    ]
  };

  return new Response(JSON.stringify(manifest), {
    status: 200,
    headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' }
  });
};
