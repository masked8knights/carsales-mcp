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

export function parseGumtree(html: string, limit: number): ListingCard[] {
  const cards: ListingCard[] = [];
  const seen = new Set<string>();

  // Gumtree (2026) serves listing cards as <a href="/web/listing/cars-vans-utes/<id>"
  // id="user-ad-<id>" ... aria-label="<title>. Price: $X . Location: Y. Ad listed ...">.
  // The title/price/location live in the aria-label, so we parse the card anchors.
  const cardRe = /<a\b[^>]*\bid="user-ad-(\d+)"[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = cardRe.exec(html)) && cards.length < limit) {
    const id = m[1];
    if (seen.has(id)) continue;
    const tag = m[0];
    const aria = tag.match(/aria-label="([^"]+)"/);
    if (!aria) continue;
    seen.add(id);
    const label = aria[1];
    const title = label
      .split(/\.?\s*Price:/i)[0]
      .replace(/\.\s*$/, '')
      .trim();
    const priceM = label.match(/\$\s?([\d,]{3,})/);
    const price = priceM ? num(priceM[1]) : null;
    const locM = label.match(/Location:\s*([^.]*?)(?:\.\s*Ad|$)/i);
    const location = locM ? locM[1].trim() : null;
    const yearM = title.match(/\b(19|20)?\d{2}\b/);
    const year = yearM ? Number(yearM[0]) : null;
    const kmM = label.match(/([\d,]{3,})\s?km\b/i);
    const odometer = kmM ? num(kmM[1]) : null;
    const url = `https://www.gumtree.com.au/web/listing/cars-vans-utes/${id}`;
    // Best-effort photo: the card image appears shortly after the opening anchor
    // (an <img> or a CSS background-image) until this id's next </a>.
    let image: string | null = null;
    const seg = html.slice(m.index + tag.length, m.index + tag.length + 2200);
    const imgM = seg.match(/src="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/) ||
      seg.match(/background-image:\s*url\('?(https?:\/\/[^)'"]+)'?\)/);
    if (imgM) image = imgM[1];
    cards.push({
      id,
      url,
      title: title || url,
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
      location,
      state: null,
      priceBadge: null,
      image,
      images: image ? [image] : [],
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
