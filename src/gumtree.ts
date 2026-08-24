/**
 * Native Gumtree.com.au (Australia) car search, hardened with the same
 * browser / proxy / engine infrastructure as carsales (Camoufox + proxy + retries).
 *
 * Gumtree has no public JSON API, so we drive the real search page and parse the
 * listing cards out of the HTML. The same best-effort strategy used for carsales.
 * Markup changes on Gumtree may require selector tweaks; failures degrade to an
 * empty result rather than throwing, so the combined search still works.
 *
 * 100% FOSS: no paid API, no key. Best-effort only.
 */

import { getPage, fetchSearchHtml, num, ListingCard } from './browser.js';

const SEARCH_BASE = 'https://www.gumtree.com.au/s-cars-vans-utes';

export interface GumtreeSearchParams {
  query: string;
  location?: string;
  minPrice?: number;
  maxPrice?: number;
  limit?: number;
  radius?: number;
}

function idFromGumtreeUrl(u: string): string | null {
  const m = u.match(/\/(\d{6,})(?:\?|$)/);
  return m ? m[1] : null;
}

export function parseGumtree(html: string, limit: number): ListingCard[] {
  const cards: ListingCard[] = [];
  const seen = new Set<string>();

  // Gumtree embeds listing data as JSON: each listing has a `"url"` of the form
  // …/web/listing/…/<id>. We pair each URL with the nearest *preceding* `"title"`
  // (so the site title doesn't get mis-associated with the first listing).
  const urlRe = /"url":"(https:\/\/www\.gumtree\.com\.au\/web\/listing\/[^"]+)"/g;
  const titleRe = /"title":"([^"]{5,60})"/g;
  let um: RegExpExecArray | null;
  while ((um = urlRe.exec(html)) && cards.length < limit) {
    const url = um[1];
    const id = idFromGumtreeUrl(url);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const before = html.slice(0, um.index);
    const titles = [...before.matchAll(titleRe)];
    const title = titles.length ? titles[titles.length - 1][1] : url;
    const yearM = title.match(/\b(19|20)\d{2}\b/);
    const year = yearM ? Number(yearM[1]) : null;
    // Price isn't in the JSON; scan a window around this listing's URL in the HTML.
    const win = html.slice(Math.max(0, um.index - 600), um.index + 600).replace(/<[^>]+>/g, ' ');
    const priceM = win.match(/\$([\d,]{3,})/);
    const price = priceM ? num(priceM[1]) : null;
    const kmM = win.match(/([\d,]{2,})\s*km\b/i);
    const odometer = kmM ? num(kmM[1]) : null;
    cards.push({
      id,
      url,
      title,
      source: 'gumtree',
      year,
      price,
      priceExGovt: null,
      odometer,
      transmission: null,
      fuelType: null,
      bodyType: null,
      engine: null,
      seller: null,
      location: null,
      state: null,
      priceBadge: null,
      image: null,
    });
  }
  return cards;
}

export async function searchGumtreeCars(p: GumtreeSearchParams): Promise<ListingCard[]> {
  const page = await getPage();
  const q = encodeURIComponent(p.query.trim()).replace(/%20/g, '+');
  let url = `${SEARCH_BASE}/${q}/k0c18320`;
  const params = new URLSearchParams();
  if (p.location) params.set('q', p.location);
  if (p.minPrice != null) params.set('price-min', String(p.minPrice));
  if (p.maxPrice != null) params.set('price-max', String(p.maxPrice));
  if (p.radius != null) params.set('distance', String(p.radius)); // best-effort; Gumtree may ignore
  const qs = params.toString();
  if (qs) url += '?' + qs;
  const html = await fetchSearchHtml(url, page);
  return parseGumtree(html, p.limit ?? 20);
}
