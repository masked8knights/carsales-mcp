/**
 * Native Facebook Marketplace search for cars, hardened with the same
 * browser / proxy / engine infrastructure as carsales (Camoufox + proxy +
 * retries). Facebook exposes an internal GraphQL API that works without login;
 * we issue those requests through our Playwright page's `request` context so
 * they inherit the browser's TLS fingerprint and any configured proxy.
 *
 * doc_id values are Facebook frontend constants and may need updating if
 * Facebook changes its web app — hence the try/catch + clear error.
 */

import { getPage } from './browser.js';
import { ListingCard } from './browser.js';

const GRAPHQL_URL = 'https://www.facebook.com/api/graphql/';
const LOCATION_DOC_ID = '5585904654783609';
const SEARCH_DOC_ID = '7111939778879383';
const MAX_PRICE_SENTINEL = 214748364700;

export interface FacebookSearchParams {
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

async function fbRequest(docId: string, variables: string, retry: number): Promise<any> {
  const page = await getPage();
  const body = new URLSearchParams({ variables, doc_id: docId }).toString();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retry; attempt++) {
    try {
      const res = await page.request.post(GRAPHQL_URL, {
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'sec-fetch-site': 'same-origin',
        },
        data: body,
        timeout: 30000,
      });
      if (!res.ok()) throw new Error(`Facebook GraphQL HTTP ${res.status()}`);
      const json = await res.json();
      if (Array.isArray(json.errors) && json.errors.length)
        throw new Error(`Facebook GraphQL: ${json.errors[0].message}`);
      return json;
    } catch (e) {
      lastErr = e;
      if (attempt < retry) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Facebook request failed');
}

async function resolveLocation(
  query: string,
  retry: number,
): Promise<{ latitude: number; longitude: number; name: string } | null> {
  const variables = JSON.stringify({
    params: {
      caller: 'MARKETPLACE',
      page_category: ['CITY', 'SUBCITY', 'NEIGHBORHOOD', 'POSTAL_CODE'],
      query: query.toLowerCase().trim(),
    },
  });
  try {
    const response = await fbRequest(LOCATION_DOC_ID, variables, retry);
    const edges = response?.data?.city_street_search?.street_results?.edges;
    if (!edges || !edges.length) return null;
    const node = edges[0].node;
    const name =
      node.subtitle?.split(' ·')[0] === 'City'
        ? node.single_line_address
        : node.subtitle?.split(' ·')[0] || node.single_line_address;
    return {
      latitude: node.location.latitude,
      longitude: node.location.longitude,
      name,
    };
  } catch {
    return null;
  }
}

function parseFbListings(edges: any[], limit: number): ListingCard[] {
  const out: ListingCard[] = [];
  for (const edge of edges) {
    if (out.length >= limit) break;
    try {
      const node = edge?.node;
      if (!node || node.__typename !== 'MarketplaceFeedListingStoryObject') continue;
      const listing = node.listing;
      if (!listing) continue;
      if (listing.is_sold || listing.is_pending || listing.is_hidden || listing.is_live === false)
        continue;
      const title: string = listing.marketplace_listing_title || 'Untitled Listing';
      if (/^(\[SOLD\]|SOLD -|SOLD$)/i.test(title)) continue;

      const priceStr: string = listing.listing_price?.formatted_amount || '';
      const price = num(priceStr);
      const yearM = title.match(/^(\d{4})/);
      const image = listing.primary_listing_photo?.image?.uri || null;
      const id: string = String(listing.id);
      out.push({
        id,
        url: `https://www.facebook.com/marketplace/item/${id}`,
        title,
        source: 'facebook',
        year: yearM ? Number(yearM[1]) : null,
        price,
        priceExGovt: null,
        odometer: null,
        transmission: null,
        fuelType: null,
        bodyType: null,
        engine: null,
        seller: listing.marketplace_listing_seller?.name ?? null,
        location: listing.location?.reverse_geocode?.city_page?.display_name ?? null,
        state: null,
        priceBadge: null,
        image,
      });
    } catch {
      continue;
    }
  }
  return out;
}

export async function searchFacebookCars(p: FacebookSearchParams): Promise<ListingCard[]> {
  const retry = 3;
  const location = p.location || 'sydney';
  const coords = await resolveLocation(location, retry);
  if (!coords) {
    throw new Error(
      `Could not resolve Facebook Marketplace location "${location}". Try a major city (e.g. "sydney", "melbourne").`,
    );
  }
  const variables = JSON.stringify({
    count: Math.min(p.limit ?? 20, 24),
    params: {
      bqf: { callsite: 'COMMERCE_MKTPLACE_WWW', query: p.query },
      browse_request_params: {
        commerce_enable_local_pickup: true,
        commerce_enable_shipping: true,
        commerce_search_and_rp_available: true,
        commerce_search_and_rp_condition: null,
        commerce_search_and_rp_ctime_days: null,
        filter_location_latitude: coords.latitude,
        filter_location_longitude: coords.longitude,
        filter_price_lower_bound: p.minPrice ?? 0,
        filter_price_upper_bound: p.maxPrice ?? MAX_PRICE_SENTINEL,
        filter_radius_km: 50,
      },
      custom_request_params: { surface: 'SEARCH' },
    },
  });
  const response = await fbRequest(SEARCH_DOC_ID, variables, retry);
  const edges = response?.data?.marketplace_search?.feed_units?.edges || [];
  return parseFbListings(edges, p.limit ?? 20);
}
