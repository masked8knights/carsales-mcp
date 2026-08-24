import { ListingCard, getPage, fetchSearchHtml, parseListings } from './browser.js';
import { buildSearchUrl, SearchParams } from './url.js';

/**
 * Provider strategy (mirrors secondhand-mcp's API + scraping balance):
 *  - If CARAPIS_API_KEY is set, use the Carapis REST API for carsales.com.au
 *    (clean structured data, no bot challenges).
 *  - Otherwise (or if the API call fails) fall back to the browser scraper.
 */
export async function searchCars(p: SearchParams): Promise<ListingCard[]> {
  if (process.env.CARAPIS_API_KEY) {
    const fromApi = await carapisSearch(p).catch(() => null);
    if (fromApi && fromApi.length) {
      console.error('[carsales-mcp] search served from Carapis API.');
      return fromApi;
    }
  }
  const page = await getPage();
  const url = buildSearchUrl(p);
  const html = await fetchSearchHtml(url, page);
  return parseListings(html);
}

async function carapisSearch(p: SearchParams): Promise<ListingCard[] | null> {
  const q = new URLSearchParams();
  q.set('source', 'carsales-com-au');
  if (p.make) q.set('make', p.make);
  if (p.model) q.set('model', p.model);
  if (p.minPrice != null) q.set('price_min', String(p.minPrice));
  if (p.maxPrice != null) q.set('price_max', String(p.maxPrice));
  if (p.minYear != null) q.set('year_min', String(p.minYear));
  if (p.maxYear != null) q.set('year_max', String(p.maxYear));
  if (p.maxOdometer != null) q.set('odometer_max', String(p.maxOdometer));
  if (p.state) q.set('state', p.state);
  if (p.fuelType) q.set('fuel_type', p.fuelType);
  if (p.transmission) q.set('transmission', p.transmission);
  if (p.bodyStyle) q.set('body_type', p.bodyStyle);
  if (p.limit != null) q.set('limit', String(Math.min(p.limit, 100)));

  const resp = await fetch('https://api.carapis.com/v2/listings?' + q.toString(), {
    headers: { Authorization: 'Bearer ' + process.env.CARAPIS_API_KEY! },
  });
  if (!resp.ok) return null;
  const data: any = await resp.json();
  const results: any[] = data.results || [];
  return results.map(normalizeCarapis);
}

function normalizeCarapis(c: any): ListingCard {
  const id: string = c.listing_id || c.id || '';
  const year: number | null = c.year ?? null;
  const make: string = c.make || '';
  const model: string = c.model || '';
  return {
    id,
    url:
      c.url ||
      (id ? 'https://www.carsales.com.au/cars/details/' + id + '/' : 'https://www.carsales.com.au/'),
    title: [year, make, model].filter(Boolean).join(' '),
    source: 'carsales',
    year,
    price: c.price ?? null,
    priceExGovt: c.price_ex_govt ?? null,
    odometer: c.odometer ?? null,
    transmission: c.transmission ?? null,
    fuelType: c.fuel_type ?? null,
    bodyType: c.body_type ?? null,
    engine: null,
    seller: c.seller_type ? [c.seller_type, c.state].filter(Boolean).join(' • ') : c.state ?? null,
    location: c.suburb ?? c.state ?? null,
    state: c.state ?? null,
    priceBadge: c.price_indicator ?? null,
    image: c.image ?? c.photo ?? null,
  };
}
