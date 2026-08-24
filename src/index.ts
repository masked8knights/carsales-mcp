#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  getPage,
  closeBrowser,
  fetchHtml,
  downloadImages,
  ListingCard,
  Page,
} from './browser.js';
import { buildSearchUrl, SearchParams } from './url.js';
import { parseDetails } from './details.js';
import { searchCars } from './provider.js';

const server = new McpServer({
  name: 'carsales-mcp',
  version: '0.1.0',
});

function applyPostFilters(cards: ListingCard[], p: SearchParams): ListingCard[] {
  let out = cards;
  if (p.minPrice != null) out = out.filter((c) => (c.price ?? c.priceExGovt ?? 0) >= p.minPrice!);
  if (p.maxPrice != null) out = out.filter((c) => (c.price ?? c.priceExGovt ?? Infinity) <= p.maxPrice!);
  if (p.minYear != null) out = out.filter((c) => (c.year ?? 0) >= p.minYear!);
  if (p.maxYear != null) out = out.filter((c) => (c.year ?? Infinity) <= p.maxYear!);
  if (p.maxOdometer != null) out = out.filter((c) => (c.odometer ?? Infinity) <= p.maxOdometer!);
  return out;
}

function sortCards(cards: ListingCard[], sort?: string): ListingCard[] {
  const arr = [...cards];
  switch (sort) {
    case 'price_low':
      arr.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
      break;
    case 'price_high':
      arr.sort((a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity));
      break;
    case 'year_new':
      arr.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
      break;
    case 'year_old':
      arr.sort((a, b) => (a.year ?? 0) - (b.year ?? 0));
      break;
    case 'km_low':
      arr.sort((a, b) => (a.odometer ?? Infinity) - (b.odometer ?? Infinity));
      break;
    default:
      break;
  }
  return arr;
}

server.tool(
  'search_cars',
  'Search carsales.com.au for used and new cars. Supports make/model, state, body style, ' +
    'transmission, fuel type, condition, badge, and keyword. Price, year and odometer are ' +
    'filtered in-memory from the listing cards. Returns matching listings with price, year, ' +
    'odometer, location and a link.',
  {
    make: z.string().describe('Car make, e.g. "Toyota", "Mazda", "Tesla"'),
    model: z.string().optional().describe('Car model, e.g. "Camry", "CX-5"'),
    state: z
      .string()
      .optional()
      .describe('Australian state: NSW, VIC, QLD, SA, TAS, WA, ACT, NT'),
    bodyStyle: z
      .string()
      .optional()
      .describe('Body style: sedan, wagon, suv, hatch, ute, coupe, van, convertible'),
    transmission: z.string().optional().describe('automatic or manual'),
    fuelType: z
      .string()
      .optional()
      .describe('petrol, diesel, hybrid, electric, plug-in hybrid, lpg'),
    condition: z
      .enum(['used', 'new', 'private', 'dealer'])
      .optional()
      .describe('Listing condition/type'),
    badge: z.string().optional().describe('Trim/badge, e.g. "GT", "Ascent", "RS"'),
    colour: z.string().optional().describe('Exterior colour, e.g. "white", "black"'),
    keyword: z.string().optional().describe('Free-text keyword search'),
    minPrice: z.number().optional().describe('Minimum price in AUD'),
    maxPrice: z.number().optional().describe('Maximum price in AUD'),
    minYear: z.number().optional().describe('Minimum build year'),
    maxYear: z.number().optional().describe('Maximum build year'),
    maxOdometer: z.number().optional().describe('Maximum odometer in km'),
    sort: z
      .enum(['price_low', 'price_high', 'year_new', 'year_old', 'km_low'])
      .optional()
      .describe('Sort order (applied in-memory)'),
    page: z.number().optional().default(1).describe('Results page number (1-based)'),
    limit: z.number().optional().default(25).describe('Max results to return'),
  },
  async (params) => {
    const url = buildSearchUrl(params as SearchParams);
    try {
      let cards = await searchCars(params as SearchParams);
      cards = applyPostFilters(cards, params as SearchParams);
      cards = sortCards(cards, params.sort);
      const limited = cards.slice(0, params.limit ?? 25);
      const text = limited
        .map((c, i) => {
          const price = c.price ? `$${c.price.toLocaleString()}` : c.priceExGovt
            ? `$${c.priceExGovt.toLocaleString()} (ex gov't charges)`
            : 'n/a';
          const bits = [
            c.year,
            c.transmission,
            c.fuelType,
            c.bodyType,
            c.odometer ? `${c.odometer.toLocaleString()} km` : null,
            c.seller,
          ].filter(Boolean);
          return `${i + 1}. ${c.title}\n   ${price} | ${bits.join(' | ')}\n   ${c.url}`;
        })
        .join('\n');
      return {
        content: [
          {
            type: 'text',
            text:
              `Found ${cards.length} matching listing(s) on carsales.com.au (showing ${limited.length}).\n` +
              `Search URL: ${url}\n\n${text || 'No listings matched.'}`,
          },
        ],
      };
    } finally {
      // reuse the shared page; do not close it
    }
  },
);

function cardSummary(c: ListingCard): string {
  const price = c.price ? `$${c.price.toLocaleString()}` : c.priceExGovt
    ? `$${c.priceExGovt.toLocaleString()} (ex gov't charges)`
    : 'n/a';
  const bits = [
    c.year,
    c.transmission,
    c.fuelType,
    c.bodyType,
    c.odometer ? `${c.odometer.toLocaleString()} km` : null,
    c.seller,
  ].filter(Boolean);
  return `${c.title} — ${price} | ${bits.join(' | ')}`;
}

async function describeListing(
  listingId: string | undefined,
  target: string,
  includeImages = false,
): Promise<{ id: string; title: string | null; text: string; url: string; metadata: Record<string, unknown>; blocked: boolean; imageUrls: string[] }> {
  const idMatch = target.match(/([A-Z]{3,4}-AD-\d+)/);
  const id = idMatch ? idMatch[1] : listingId || 'unknown';
  const page = await getPage();
  const html = await fetchHtml(target, page);
  const blocked = html.length < 6000 || html.toLowerCase().includes('captcha-delivery');
  if (!blocked) {
    const d = parseDetails(html, id, target);
    const lines = [
      d.title,
      d.year ? `Year: ${d.year}` : null,
      d.price ? `Price: $${d.price.toLocaleString()}` : null,
      d.priceExGovt ? `Price ex gov't charges: $${d.priceExGovt.toLocaleString()}` : null,
      d.priceBadge ? `Price indicator: ${d.priceBadge}` : null,
      d.odometer ? `Odometer: ${d.odometer.toLocaleString()} km` : null,
      d.transmission ? `Transmission: ${d.transmission}` : null,
      d.fuelType ? `Fuel: ${d.fuelType}` : null,
      d.bodyType ? `Body: ${d.bodyType}` : null,
      d.engine ? `Engine: ${d.engine}` : null,
      d.seller ? `Seller: ${d.seller}` : null,
      d.description ? `Description: ${d.description}` : null,
      d.photos?.length ? `Photos (${d.photos.length}): ${d.photos.join(', ')}` : null,
    ].filter(Boolean);
    return {
      id,
      title: d.title ?? null,
      text: lines.join('\n'),
      url: target,
      metadata: {
        price: d.price,
        priceExGovt: d.priceExGovt,
        priceBadge: d.priceBadge,
        year: d.year,
        odometer: d.odometer,
        transmission: d.transmission,
        fuelType: d.fuelType,
        bodyType: d.bodyType,
        engine: d.engine,
        seller: d.seller,
        state: d.state,
        features: d.features,
        photos: d.photos?.length || 0,
      },
      blocked: false,
      imageUrls: includeImages ? d.photos || [] : [],
    };
  }
  // Fallback: recover summary card data via search.
  const slug = target.match(/\/cars\/details\/([^/]+)\//);
  let card: ListingCard | null = null;
  if (slug) {
    const parts = slug[1].split('-');
    card = await findCardById(page, id, parts[1] || '', parts[2] || '');
  }
  if (card) {
    return {
      id,
      title: card.title,
      text:
        `Full detail page is blocked by anti-bot protection from this network; ` +
        `showing summary card data:\n\n${card.title}\n` +
        `Price: $${(card.price ?? card.priceExGovt ?? 'n/a').toLocaleString()}\n` +
        cardSummary(card).replace(card.title + ' — ', ''),
      url: card.url,
      metadata: {
        price: card.price,
        priceExGovt: card.priceExGovt,
        year: card.year,
        odometer: card.odometer,
        transmission: card.transmission,
        fuelType: card.fuelType,
        bodyType: card.bodyType,
        seller: card.seller,
        state: card.state,
      },
      blocked: true,
      imageUrls: includeImages && card.image ? [card.image] : [],
    };
  }
  return {
    id,
    title: null,
    text: `The full detail page is blocked by anti-bot protection from this network. Open it in a browser: ${target}`,
    url: target,
    metadata: {},
    blocked: true,
    imageUrls: [],
  };
}

server.tool(
  'get_listing_details',
  'Get full details for a single carsales.com.au listing using its listing id (e.g. OAG-AD-26099426) ' +
    'or the full listing URL. Falls back to the summary card data (price, year, odometer, ' +
    'location, etc.) when the full detail page is blocked by anti-bot protection.',
  {
    listingId: z
      .string()
      .optional()
      .describe('Listing id from search results, e.g. OAG-AD-26099426'),
    url: z.string().optional().describe('Full carsales listing URL'),
    includeImages: z
      .boolean()
      .optional()
      .default(true)
      .describe('Download listing photos and return them as image blocks so the model can see them'),
  },
  async ({ listingId, url, includeImages }) => {
    let target = url;
    if (!target && listingId) {
      target = `https://www.carsales.com.au/cars/details/${listingId}/`;
    }
    if (!target) return { content: [{ type: 'text', text: 'Provide listingId or url.' }] };
    const d = await describeListing(listingId, target, includeImages);
    const page = await getPage();
    const imgs = includeImages ? await downloadImages(page, d.imageUrls, 8) : [];
    return { content: [{ type: 'text', text: d.text + `\n\nURL: ${d.url}` }, ...imgs] };
  },
);

server.tool(
  'search',
  'Deep-research search across carsales.com.au. Returns { results: [{ id, title, text, url }] } ' +
    'where id is "carsales:<listingId>" (pass to fetch). Mirrors the ChatGPT Deep Research tool contract.',
  {
    query: z.string().describe('Free-text search, e.g. "toyota camry victoria under 30000"'),
    includeImages: z
      .boolean()
      .optional()
      .default(false)
      .describe('Also return each listing’s photo as an image block so the model can see them'),
  },
  async ({ query, includeImages }) => {
    const cards = await searchCars({ keyword: query, limit: 20 } as SearchParams);
    const results = cards.map((c) => ({
      id: 'carsales:' + c.id,
      title: c.title,
      text: cardSummary(c),
      url: c.url,
      image: c.image,
    }));
    const content: any[] = [{ type: 'text', text: JSON.stringify({ results }, null, 2) }];
    if (includeImages) {
      const page = await getPage();
      for (const c of cards) if (c.image) content.push(...(await downloadImages(page, [c.image], 1)));
    }
    return { content };
  },
);

server.tool(
  'fetch',
  'Deep-research fetch: full details for a search-result id (e.g. "carsales:OAG-AD-26099426") ' +
    'or a listing URL. Returns { id, title, text, url, metadata }. Mirrors the ChatGPT Deep Research tool contract.',
  {
    id: z.string().describe('Listing id from search() (with carsales: prefix) or a full URL'),
    includeImages: z
      .boolean()
      .optional()
      .default(true)
      .describe('Download listing photos and return them as image blocks so the model can see them'),
  },
  async ({ id, includeImages }) => {
    const realId = id.replace(/^carsales:/, '');
    let target: string;
    if (/^https?:\/\//.test(realId)) target = realId;
    else if (/^[A-Z]{3,4}-AD-/.test(realId) || /\//.test(realId))
      target = `https://www.carsales.com.au/cars/details/${realId}/`;
    else target = realId;
    const d = await describeListing(undefined, target, includeImages);
    const page = await getPage();
    const imgs = includeImages ? await downloadImages(page, d.imageUrls, 8) : [];
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { id: d.id, title: d.title, text: d.text, url: d.url, metadata: d.metadata },
            null,
            2,
          ),
        },
        ...imgs,
      ],
    };
  },
);

async function findCardById(_page: Page, id: string, make: string, model = ''): Promise<ListingCard | null> {
  if (!make) return null;
  for (let p = 1; p <= 8; p++) {
    const cards = await searchCars({ make, model, page: p, limit: 100 } as SearchParams);
    const hit = cards.find((c) => c.id === id);
    if (hit) return hit;
    if (cards.length < 10) break;
  }
  return null;
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep the browser alive until the process exits.
  process.on('SIGINT', async () => {
    await closeBrowser();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    await closeBrowser();
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('carsales-mcp failed to start:', e);
  process.exit(1);
});
