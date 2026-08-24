/**
 * Native Gumtree.com.au (Australia) car search, hardened with the same
 * browser / proxy / engine infrastructure as carsales (Camoufox + proxy + retries).
 *
 * Gumtree has no public JSON API, so we drive the real search page and parse the
 * listing cards out of the HTML — the same best-effort strategy used for carsales.
 * Markup changes on Gumtree may require selector tweaks; failures degrade to an
 * empty result rather than throwing, so the combined search still works.
 *
 * 100% FOSS: no paid API, no key. Best-effort only.
 */

import { getPage, fetchSearchHtml, ListingCard } from './browser.js';

const SEARCH_BASE = 'https://www.gumtree.com.au/s-cars-vans-utes';
const DETAIL_RE = /href="(\/s-ad\/[^"]+)"/g;

export interface GumtreeSearchParams {
  query: string;
  location?: string;
  minPrice?: number;
  maxPrice?: number;
  limit?: number;
}

function num(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.replace(/[^0-9]/g, '');
  return m ? Number(m) : null;
}

function idFromGumtreeUrl(u: string): string | null {
  const m = u.match(/\/(\d{6,})(?:\?|$)/);
  return m ? m[1] : null;
}

function parseGumtree(html: string, limit: number): ListingCard[] {
  const cards: ListingCard[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  DETAIL_RE.lastIndex = 0;
  while ((m = DETAIL_RE.exec(html)) && cards.length < limit) {
    const href = m[1];
    const id = idFromGumtreeUrl(href);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    // Bound the scan to this card (20KB window) and pull what we can.
    const scan = m.index + m[0].length;
    const seg = html.slice(scan, scan + 20000);
    const text = seg.replace(/<[^>]+>/g, ' ');
    const priceM = seg.match(/\$([\d,]{3,})/);
    const price = priceM ? num(priceM[1]) : null;
    const yearM = seg.match(/\b(19|20)\d{2}\b/);
    const year = yearM ? Number(yearM[1]) : null;
    const kmM = text.match(/([\d,]{2,})\s*km\b/i);
    const odometer = kmM ? num(kmM[1]) : null;
    // Title: prefer an anchor's text near the link, else derive from the URL slug.
    const titleM = seg.match(/<a[^>]+[^>]*>([^<]{6,80})<\/a>/);
    const slug = href.split('/').filter(Boolean).pop() || '';
    const title =
      titleM && titleM[1].trim().length > 3
        ? titleM[1].trim()
        : slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    cards.push({
      id,
      url: 'https://www.gumtree.com.au' + href,
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
  const qs = params.toString();
  if (qs) url += '?' + qs;
  const html = await fetchSearchHtml(url, page);
  return parseGumtree(html, p.limit ?? 20);
}
