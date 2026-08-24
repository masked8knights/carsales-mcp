#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  getPage,
  closeBrowser,
  fetchHtml,
  downloadImages,
  setAuthCookies,
  saveSession,
  authCookieFile,
  ListingCard,
  Page,
} from './browser.js';
import { buildSearchUrl, SearchParams } from './url.js';
import { parseDetails } from './details.js';
import { searchCars } from './provider.js';
import { searchFacebookCars } from './facebook.js';
import { computeDeal } from './deal.js';

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
    goodDealsOnly: z
      .boolean()
      .optional()
      .default(false)
      .describe('Only return listings flagged as GOOD/GREAT deals (uses carsales price badge + price/year/odometer)'),
    page: z.number().optional().default(1).describe('Results page number (1-based)'),
    limit: z.number().optional().default(25).describe('Max results to return'),
  },
  async (params) => {
    const url = buildSearchUrl(params as SearchParams);
    try {
      let cards = await searchCars(params as SearchParams);
      cards = applyPostFilters(cards, params as SearchParams);
      const deals = new Map(cards.map((c) => [c.id, computeDeal(c)]));
      if (params.goodDealsOnly) cards = cards.filter((c) => deals.get(c.id)!.isGoodDeal);
      cards = sortCards(cards, params.sort);
      const limited = cards.slice(0, params.limit ?? 25);
      const goodCount = limited.filter((c) => deals.get(c.id)!.isGoodDeal).length;
      const text = limited
        .map((c, i) => {
          const deal = deals.get(c.id)!;
          const flag = deal.isGoodDeal ? `[${deal.label.toUpperCase()} DEAL] ` : '';
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
          const dealLine = deal.isGoodDeal ? `\n   why: ${deal.reason}` : '';
          return `${i + 1}. ${flag}${c.title}\n   ${price} | ${bits.join(' | ')}\n   ${c.url}${dealLine}`;
        })
        .join('\n');
      return {
        content: [
          {
            type: 'text',
            text:
              `Found ${cards.length} matching listing(s) on carsales.com.au (showing ${limited.length})` +
              `${goodCount ? `, ${goodCount} flagged as good deals` : ''}.\n` +
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
    const deal = computeDeal(d);
    const dealLine = deal.isGoodDeal
      ? `Deal: ${deal.label.toUpperCase()} (score ${deal.score}) — ${deal.reason}`
      : `Deal: ${deal.label} (score ${deal.score}) — ${deal.reason}`;
    const lines = [
      d.title,
      d.year ? `Year: ${d.year}` : null,
      d.price ? `Price: $${d.price.toLocaleString()}` : null,
      d.priceExGovt ? `Price ex gov't charges: $${d.priceExGovt.toLocaleString()}` : null,
      d.priceBadge ? `Price indicator: ${d.priceBadge}` : null,
      dealLine,
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
        deal,
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
    const results = cards.map((c) => {
      const deal = computeDeal(c);
      return {
        id: 'carsales:' + c.id,
        title: c.title,
        text: (deal.isGoodDeal ? `[${deal.label.toUpperCase()} DEAL] ` : '') + cardSummary(c),
        url: c.url,
        image: c.image,
        deal,
      };
    });
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

function resolveListingTarget(listingId?: string, url?: string): string | null {
  if (url) return url;
  if (listingId) return `https://www.carsales.com.au/cars/details/${listingId}/`;
  return null;
}

function highRiskBanner(action: string, planned: string[]): string {
  return [
    'WARNING — HIGH-RISK ACTION, HUMAN IN THE LOOP REQUIRED',
    '',
    action,
    ...planned,
    '',
    'This contacts a REAL PERSON and may involve MONEY. Private sales carry little',
    'or no consumer protection. Independently verify the listing (PPSR, registration,',
    'VIN/odometer, pre-purchase inspection) before committing. Marketplace scams are',
    'common — if a price looks too good to be true, it probably is.',
    '',
    'No action was taken. To proceed, call this tool again with confirm: true.',
  ].join('\n');
}

server.tool(
  'set_auth',
  'Import a carsales.com.au login session by pasting cookies exported from your own ' +
    'browser (so the server can save vehicles, make offers, and contact sellers). ' +
    'Pass the cookies array from DevTools > Application > Cookies (or a cookie ' +
    'export extension). Stored at: ' + authCookieFile() + '.',
  {
    cookies: z
      .array(z.any())
      .describe('Array of cookie objects (name, value, domain, path, ...). Typically from a browser cookie export.'),
  },
  async ({ cookies }) => {
    try {
      await setAuthCookies(cookies);
    } catch (e) {
      return { content: [{ type: 'text', text: 'Failed to save cookies: ' + (e as Error).message }] };
    }
    return {
      content: [
        {
          type: 'text',
          text:
            `Saved ${cookies.length} cookie(s) to ${authCookieFile()}. ` +
            `The session will be used on subsequent requests. Re-run auth_status to confirm it works.`,
        },
      ],
    };
  },
);

server.tool(
  'auth_status',
  'Check whether the current session is logged in to carsales.com.au (i.e. whether ' +
    'authenticated actions like save_vehicle / make_offer will work).',
  {},
  async () => {
    const page = await getPage();
    const html = await fetchHtml('https://www.carsales.com.au/my-carsales/', page);
    const loggedIn =
      html.length >= 6000 &&
      /(my account|sign out|log out|my carsales|saved (cars|vehicles)|watchlist)/i.test(html);
    if (loggedIn) await saveSession();
    return {
      content: [
        {
          type: 'text',
          text: loggedIn
            ? 'Logged in to carsales.com.au. Authenticated actions are available.'
            : 'Not logged in (or the account page was blocked). Use set_auth with cookies from your browser to enable saving/making offers.',
        },
      ],
    };
  },
);

server.tool(
  'save_vehicle',
  'Save/watchlist a carsales listing to YOUR account (requires an authenticated session ' +
    'via set_auth). Best-effort: clicks the Save/Watchlist control on the listing page. ' +
    'Requires confirm: true (human-in-the-loop) before any account action is taken.',
  {
    listingId: z.string().optional().describe('Listing id, e.g. OAG-AD-26099426'),
    url: z.string().optional().describe('Full carsales listing URL'),
    confirm: z
      .boolean()
      .default(false)
      .describe('Must be true to actually perform the save. First call returns a warning and does nothing.'),
  },
  async ({ listingId, url, confirm }) => {
    const target = resolveListingTarget(listingId, url);
    if (!target) return { content: [{ type: 'text', text: 'Provide listingId or url.' }] };
    if (!confirm) {
      return {
        content: [
          {
            type: 'text',
            text: highRiskBanner(
              'Requested: SAVE / WATCHLIST this listing to your carsales account',
              [`Listing: ${target}`, 'This is an authenticated action on your account.'],
            ),
          },
        ],
      };
    }
    const page = await getPage();
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2500);
      const selectors = [
        'button:has-text("Save")',
        'button:has-text("Watchlist")',
        'a:has-text("Save this")',
        'a:has-text("Save ")',
        '[data-testid*="save" i]',
        '[data-testid*="watchlist" i]',
        'button[aria-label*="Save" i]',
        'button[aria-label*="Watchlist" i]',
        '.save-button',
        '[class*="save" i]',
      ];
      let clicked = false;
      let hitSelector = '';
      for (const sel of selectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.count()) {
            await el.click({ timeout: 5000 });
            clicked = true;
            hitSelector = sel;
            break;
          }
        } catch {
          // try next selector
        }
      }
      await saveSession();
      return {
        content: [
          {
            type: 'text',
            text: clicked
              ? `Clicked the Save control on ${target} (matched selector: ${hitSelector}; best-effort — confirm in your carsales account).`
              : `Could not find a Save/Watchlist control on ${target}. Tried ${selectors.length} selectors — the page may require login or its markup changed.`,
          },
        ],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: 'save_vehicle failed: ' + (e as Error).message }] };
    }
  },
);

server.tool(
  'make_offer',
  'Contact the seller / make an offer on a carsales listing (requires an authenticated ' +
    'session via set_auth). Best-effort: opens the contact/enquire form and submits your ' +
    'message. HIGH-RISK: contacts a real person and may involve money. Requires confirm: ' +
    'true (human-in-the-loop) — the first call returns a warning and does nothing.',
  {
    listingId: z.string().optional().describe('Listing id, e.g. OAG-AD-26099426'),
    url: z.string().optional().describe('Full carsales listing URL'),
    message: z.string().describe('Message to send the seller'),
    price: z.number().optional().describe('Optional offer price in AUD'),
    confirm: z
      .boolean()
      .default(false)
      .describe('Must be true to actually send. First call returns a warning and does nothing.'),
  },
  async ({ listingId, url, message, price, confirm }) => {
    const target = resolveListingTarget(listingId, url);
    if (!target) return { content: [{ type: 'text', text: 'Provide listingId or url.' }] };
    if (!confirm) {
      return {
        content: [
          {
            type: 'text',
            text: highRiskBanner('Requested: MAKE AN OFFER / CONTACT SELLER', [
              `Listing: ${target}`,
              `Message: ${message}` + (price != null ? `  (offer price $${price.toLocaleString()})` : ''),
            ]),
          },
        ],
      };
    }
    const page = await getPage();
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2500);
      const openSelectors = [
        'button:has-text("Make an offer")',
        'button:has-text("Contact seller")',
        'button:has-text("Contact")',
        'button:has-text("Enquire")',
        'button:has-text("Email seller")',
        'a:has-text("Make an offer")',
        'a:has-text("Contact seller")',
        '[data-testid*="contact" i]',
        '[data-testid*="offer" i]',
        'button[aria-label*="Enquire" i]',
        'button[aria-label*="offer" i]',
      ];
      let opened = false;
      let hitOpen = '';
      for (const sel of openSelectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.count()) {
            await el.click({ timeout: 5000 });
            opened = true;
            hitOpen = sel;
            break;
          }
        } catch {
          // try next
        }
      }
      if (!opened) {
        return {
          content: [
            {
              type: 'text',
              text: `Could not find a Make-an-offer / Contact-seller control on ${target}. Tried ${openSelectors.length} selectors — the page may require login or its markup changed.`,
            },
          ],
        };
      }
      await page.waitForTimeout(1500);
      const textSel = page.locator(
        'textarea, input[type="text"], input[type="email"], [contenteditable="true"]',
      ).first();
      if (await textSel.count()) {
        const full = price != null ? `Offer: $${price.toLocaleString()}\n${message}` : message;
        await textSel.fill(full);
      }
      const submitSel = page
        .locator(
          'button:has-text("Send"), button:has-text("Submit"), button:has-text("Send message"), button:has-text("Send enquiry"), button[type="submit"], [data-testid*="submit" i], [data-testid*="send" i]',
        )
        .first();
      let sent = false;
      let hitSubmit = '';
      if (await submitSel.count()) {
        try {
          await submitSel.click({ timeout: 5000 });
          sent = true;
          hitSubmit = (await submitSel.textContent())?.trim() || hitSubmit;
        } catch {
          // submission may need further steps
        }
      }
      await saveSession();
      return {
        content: [
          {
            type: 'text',
            text:
              'WARNING: you just initiated contact with a real seller and may be discussing ' +
              'money. Verify the listing independently (PPSR, rego, VIN, inspection) before ' +
              'committing. No consumer protection applies to private sales.\n\n' +
              (sent
                ? `Submitted your message to the seller for ${target} (opened via ${hitOpen}, sent via "${hitSubmit}"; best-effort — confirm in your account/outbox).`
                : `Opened the contact form for ${target} via ${hitOpen} and filled your message, but could not click a Send/Submit button (markup may differ).`),
          },
        ],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: 'make_offer failed: ' + (e as Error).message }] };
    }
  },
);

function formatSourceCard(c: ListingCard): string {
  const deal = computeDeal(c);
  const flag = deal.isGoodDeal ? `[${deal.label.toUpperCase()} DEAL] ` : '';
  const price = c.price ? `$${c.price.toLocaleString()}` : c.priceExGovt
    ? `$${c.priceExGovt.toLocaleString()} (ex gov't charges)`
    : 'n/a';
  const bits = [c.year, c.transmission, c.fuelType, c.bodyType, c.odometer ? `${c.odometer.toLocaleString()} km` : null, c.seller]
    .filter(Boolean);
  return `${flag}${c.title}\n   [${c.source}] ${price} | ${bits.join(' | ')}\n   ${c.url}`;
}

function normalizeListingKey(title: string | undefined): string {
  return (title ?? '')
    .toLowerCase()
    .replace(/\b(?:19|20)\d{2}\b/g, '') // drop build year
    .replace(/\$[\d,]+(?:\.\d+)?/g, '') // drop prices
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(?:used|new|demo|auto|automatic|manual|private|dealer|hatch|suv|sedan|wagon|ute|coupe|van|convertible)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Best-effort cross-source de-duplication: the same car listed on both carsales and
// Facebook collapses to a single card (carsales kept, since it carries richer data).
function dedupeListings(cards: ListingCard[]): ListingCard[] {
  const seen = new Set<string>();
  const out: ListingCard[] = [];
  for (const c of cards) {
    const key = normalizeListingKey(c.title);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(c);
  }
  return out;
}

server.tool(
  'search_facebook_cars',
  'Search Facebook Marketplace for cars (native, hardened through the same ' +
    'browser/proxy engine as carsales). Returns listings with price, title, ' +
    'location, seller and a photo. Best-effort: depends on Facebook not ' +
    'blocking the request from your IP.',
  {
    query: z.string().describe('Search terms, e.g. "toyota corolla", "tesla model 3"'),
    location: z
      .string()
      .optional()
      .default('sydney')
      .describe('City for Facebook Marketplace, e.g. "sydney", "melbourne", "brisbane"'),
    minPrice: z.number().optional().describe('Minimum price in AUD'),
    maxPrice: z.number().optional().describe('Maximum price in AUD'),
    limit: z.number().optional().default(20).describe('Max results to return'),
  },
  async ({ query, location, minPrice, maxPrice, limit }) => {
    let cards: ListingCard[];
    try {
      cards = await searchFacebookCars({ query, location, minPrice, maxPrice, limit });
    } catch (e) {
      return {
        content: [
          { type: 'text', text: 'Facebook Marketplace search failed: ' + (e as Error).message },
        ],
      };
    }
    if (!cards.length)
      return { content: [{ type: 'text', text: 'No Facebook Marketplace listings found.' }] };
    const text = cards.map((c, i) => `${i + 1}. ${formatSourceCard(c)}`).join('\n');
    return {
      content: [
        {
          type: 'text',
          text: `Found ${cards.length} Facebook Marketplace listing(s) for "${query}" near ${location}.\n\n${text}`,
        },
      ],
    };
  },
);

server.tool(
  'search_all_cars',
  'Search BOTH carsales.com.au and Facebook Marketplace for cars at once and ' +
    'return combined, de-duplicated-where-possible results tagged by source, with ' +
    'good-deal flags. Use this as the one-shot "find me a car" tool.',
  {
    make: z.string().describe('Car make, e.g. "Toyota", "Mazda", "Tesla"'),
    model: z.string().optional().describe('Car model, e.g. "Camry", "CX-5"'),
    location: z
      .string()
      .optional()
      .default('sydney')
      .describe('Facebook Marketplace city, e.g. "sydney", "melbourne"'),
    state: z.string().optional().describe('Australian state for carsales: NSW, VIC, QLD, ...'),
    minPrice: z.number().optional().describe('Minimum price in AUD'),
    maxPrice: z.number().optional().describe('Maximum price in AUD'),
    minYear: z.number().optional().describe('Minimum build year'),
    maxYear: z.number().optional().describe('Maximum build year'),
    goodDealsOnly: z.boolean().optional().default(false).describe('Only return GOOD/GREAT deals'),
    limit: z.number().optional().default(30).describe('Max total results to return'),
  },
  async ({ make, model, location, state, minPrice, maxPrice, minYear, maxYear, goodDealsOnly, limit }) => {
    const query = [make, model].filter(Boolean).join(' ');
    const [csRes, fbRes] = await Promise.allSettled([
      searchCars({ make, model, state, minPrice, maxPrice, minYear, maxYear, limit: 100 } as SearchParams),
      searchFacebookCars({ query, location, minPrice, maxPrice, limit: 40 }),
    ]);
    const carsales = csRes.status === 'fulfilled' ? csRes.value : [];
    const facebook = fbRes.status === 'fulfilled' ? fbRes.value : [];
    if (csRes.status === 'rejected')
      console.error('[carsales-mcp] carsales leg failed:', (csRes.reason as Error).message);
    if (fbRes.status === 'rejected')
      console.error('[carsales-mcp] facebook leg failed:', (fbRes.reason as Error).message);

    let cards = dedupeListings([...carsales, ...facebook]);
    if (minPrice != null) cards = cards.filter((c) => (c.price ?? c.priceExGovt ?? 0) >= minPrice);
    if (maxPrice != null) cards = cards.filter((c) => (c.price ?? c.priceExGovt ?? Infinity) <= maxPrice);
    if (minYear != null) cards = cards.filter((c) => (c.year ?? 0) >= minYear);
    if (maxYear != null) cards = cards.filter((c) => (c.year ?? Infinity) <= maxYear);
    const deals = new Map(cards.map((c) => [c.source + ':' + c.id, computeDeal(c)]));
    if (goodDealsOnly) cards = cards.filter((c) => deals.get(c.source + ':' + c.id)!.isGoodDeal);
    // Best deals first.
    cards.sort((a, b) => deals.get(b.source + ':' + b.id)!.score - deals.get(a.source + ':' + a.id)!.score);
    const limited = cards.slice(0, limit ?? 30);
    if (!limited.length)
      return { content: [{ type: 'text', text: 'No combined listings matched your criteria.' }] };
    const goodCount = limited.filter((c) => deals.get(c.source + ':' + c.id)!.isGoodDeal).length;
    const text = limited.map((c, i) => `${i + 1}. ${formatSourceCard(c)}`).join('\n');
    return {
      content: [
        {
          type: 'text',
          text:
            `Combined search across carsales (${carsales.length}) + Facebook (${facebook.length}) ` +
            `-> showing ${limited.length}${goodCount ? `, ${goodCount} good deals` : ''}.\n\n${text}`,
        },
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
