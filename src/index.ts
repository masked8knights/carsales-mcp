#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  getPage,
  closeBrowser,
  fetchHtml,
  downloadImages,
  saveSession,
  getCookiesAll,
  ListingCard,
  Page,
  describeGenericListing,
  DataDomeBlockedError,
} from './browser.js';
import { buildSearchUrl, SearchParams } from './url.js';
import { parseDetails } from './details.js';
import { searchCars } from './provider.js';
import { searchFacebookCars } from './facebook.js';
import { searchGumtreeCars } from './gumtree.js';
import { computeDeal } from './deal.js';
import { computePriceInsight, formatInsight, PriceInsight } from './insight.js';
import {
  addWatch,
  addListingWatch,
  listWatches,
  removeWatch,
  runWatch,
  getWatch,
  setWatchLastPrice,
  WatchSource,
} from './watch.js';
import { checkVehicle } from './vehicle.js';
import { hasIdenticalOffer, hasRecentOffer, recordOffer } from './offers.js';
import {
  saveListing,
  listSaved,
  getSaved,
  removeSaved,
  applyCheck,
  setSavedNote,
  savedFile,
  SaveSource,
} from './saved.js';
import { assessReliability, assessListingReliability, ReliabilityResult } from './reliability.js';
import {
  applyPrefFilters,
  addNote,
  clearPreferences,
  excludeEntry,
  getPreferences,
  prefsFile,
  prefsSummary,
  setFilter,
} from './prefs.js';

const server = new McpServer({
  name: 'carsales-mcp',
  version: '0.1.0',
});

function priceInRange(c: ListingCard, min?: number, max?: number): boolean {
  const p = c.price ?? c.priceExGovt;
  if (p == null) return true; // unknown price: never exclude on a price filter
  if (min != null && p < min) return false;
  if (max != null && p > max) return false;
  return true;
}

function applyPostFilters(cards: ListingCard[], p: SearchParams): ListingCard[] {
  let out = cards;
  if (p.minPrice != null) out = out.filter((c) => priceInRange(c, p.minPrice, undefined));
  if (p.maxPrice != null) out = out.filter((c) => priceInRange(c, undefined, p.maxPrice));
  // Unknown value (null) -> never exclude, matching the price contract above.
  if (p.minYear != null) out = out.filter((c) => c.year == null || c.year >= p.minYear!);
  if (p.maxYear != null) out = out.filter((c) => c.year == null || c.year <= p.maxYear!);
  if (p.maxOdometer != null) out = out.filter((c) => c.odometer == null || c.odometer <= p.maxOdometer!);
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
    make: z
      .string()
      .optional()
      .describe('Car make, e.g. "Toyota", "Mazda", "Tesla". Omit to search ALL makes.'),
    model: z.string().optional().describe('Car model, e.g. "Camry", "CX-5"'),
    keyword: z.string().optional().describe('Free-text keyword search'),
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
    minPrice: z.number().optional().describe('Minimum price in AUD'),
    maxPrice: z.number().optional().describe('Maximum price in AUD'),
    minYear: z.number().optional().describe('Minimum build year'),
    maxYear: z.number().optional().describe('Maximum build year'),
    maxOdometer: z.number().optional().describe('Maximum odometer in km'),
    postcode: z.string().optional().describe('Restrict to a postcode (carsales location facet)'),
    radius: z.number().optional().describe('Search radius in km around the postcode (carsales distance facet)'),
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
    // make/model/keyword are all optional: carsales supports a brand-agnostic
    // search, so e.g. state + transmission + maxPrice alone is a valid query.
    // Guard against a genuinely empty call that would fetch the whole site.
    const keys: (keyof SearchParams)[] = ['make', 'model', 'keyword', 'state', 'bodyStyle', 'transmission', 'fuelType', 'condition', 'badge', 'colour', 'minPrice', 'maxPrice', 'minYear', 'maxYear', 'maxOdometer', 'postcode'];
    if (!keys.some((k) => (params as any)[k] != null)) {
      return {
        content: [
          { type: 'text', text: 'Provide at least one filter (make, model, keyword, state, transmission, price, etc.).' },
        ],
      };
    }
    const url = buildSearchUrl(params as SearchParams);
    try {
      let cards = await searchCarsDeep(params as SearchParams);
      // Apply learned preferences (auto-filter + excluded listings).
      const prefs = getPreferences();
      const lost = new Set(prefs.excluded.map((e) => e.id));
      cards = cards.filter((c) => !lost.has(c.id));
      const overrides = {} as Record<string, unknown>;
      if (params.minPrice != null) overrides.minPrice = params.minPrice;
      if (params.maxPrice != null) overrides.maxPrice = params.maxPrice;
      const { cards: filtered, applied } = applyPrefFilters(cards, overrides as any);
      cards = filtered;
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
              `Search URL: ${url}\n\n${text || 'No listings matched.'}` +
              (prefsSummary() !== 'no preferences saved yet'
                ? `\n\nLearned preferences (auto-applied): ${prefsSummary()}.`
                : ''),
          },
        ],
      };
    } catch (e) {
      if (e instanceof DataDomeBlockedError) {
        return {
          content: [
            {
              type: 'text',
              text:
                'carsales.com.au is showing a DataDome bot-protection challenge, so this search returned nothing. ' +
                'This is not "no cars" - it is carsales blocking the request. It usually happens after many ' +
                'requests from one IP. Retry in a few minutes, reduce page depth, or set a residential proxy ' +
                '(CARS_PROXY) to rotate IPs. Search URL: ' + url,
            },
          ],
        };
      }
      return { content: [{ type: 'text', text: 'search_cars failed: ' + (e as Error).message }] };
    } finally {
      // reuse the shared page; do not close it
    }
  },
);

// How many extra result pages to scan when a price filter is set and page 1 is
// too sparse. carsales does not accept a server-side price param (it uses an
// internal predicate DSL hidden behind the client), and it sorts page 1 by
// relevance/freshness, so cheap old listings sit deep in the results. We use the
// server-side `sort=Odometer` token to pull high-km (hence cheap) cars onto page
// 1, then filter in-memory, and scan a few extra pages as a safety net.
const DEEP_PAGES = Math.max(0, Number(process.env.CARS_DEEP_PAGES || 6));

// Fetch page 1, then (when a price filter is active and the result is thin)
// keep fetching further pages and re-filtering until we have enough matches or
// hit the page cap. Deduped by listing id. A brand-agnostic (no make) search
// returns far more results than a single-make one, so the deep scan is bounded
// much lower there to avoid grinding pages (which stalls + triggers blocks).
async function searchCarsDeep(p: SearchParams): Promise<ListingCard[]> {
  const hasPrice = p.minPrice != null || p.maxPrice != null;
  const fetch = hasPrice ? { ...p, serverSort: p.serverSort || 'Odometer' } : p;
  let cards = applyPostFilters(await searchCars({ ...fetch, page: p.page ?? 1 }), p);
  if (!hasPrice) return cards;
  const target = p.limit ?? 25;
  const startPage = p.page ?? 1;
  // All-makes result sets are large, so cheap cars can sit very deep. The user
  // prefers completeness over speed here, so scan the full page budget; each page
  // is fetched politely (humanised, with backoff/cooldown) rather than fast.
  const maxPages = p.make ? DEEP_PAGES : Math.max(DEEP_PAGES, 10);
  let page = startPage + 1;
  while (cards.length < target && page <= startPage + maxPages) {
    let more: ListingCard[];
    try {
      more = await searchCars({ ...fetch, page });
    } catch (e) {
      // A block is NOT "no cars" - surface it so the client warns the user rather
      // than concluding the market is empty. Only stop quietly on other errors.
      if (e instanceof DataDomeBlockedError) throw e;
      break;
    }
    if (!more.length) break;
    cards = applyPostFilters([...cards, ...more], p);
    page++;
  }
  const seen = new Set<string>();
  return cards.filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
}

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
  return `${c.title} - ${price} | ${bits.join(' | ')}`;
}

async function describeListing(
  listingId: string | undefined,
  target: string,
  includeImages = false,
): Promise<{ id: string; title: string | null; text: string; url: string; metadata: Record<string, unknown>; blocked: boolean; imageUrls: string[] }> {
  const idMatch = target.match(/([A-Z]{3,4}-AD-\d+)/);
  const id = idMatch ? idMatch[1] : listingId || 'unknown';
  const page = await getPage();
  // Non-carsales listings (Facebook / Gumtree): use the generic scraper so
  // get_listing_details and compare_listings work across all three sites.
  if (!/carsales\.com\.au\/cars\/details/.test(target)) {
    const g = await describeGenericListing(target, page);
    const source = /facebook\.com/.test(target) ? 'facebook' : /gumtree\.com\.au/.test(target) ? 'gumtree' : 'unknown';
    return {
      id,
      title: g.title,
      text: g.text,
      url: target,
      metadata: { price: g.price, description: g.description, source, photos: g.imageUrls.length },
      blocked: g.blocked,
      imageUrls: g.imageUrls,
    };
  }
  const html = await fetchHtml(target, page);
  const blocked = html.length < 6000 || html.toLowerCase().includes('captcha-delivery');
  if (!blocked) {
    const d = parseDetails(html, id, target);
    const deal = computeDeal(d);
    const dealLine = deal.isGoodDeal
      ? `Deal: ${deal.label.toUpperCase()} (score ${deal.score}): ${deal.reason}`
      : `Deal: ${deal.label} (score ${deal.score}): ${deal.reason}`;
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
        cardSummary(card).replace(card.title + ' - ', ''),
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

function resolveListingTarget(listingId?: string, url?: string): string | null {
  if (url) return url;
  if (listingId) return `https://www.carsales.com.au/cars/details/${listingId}/`;
  return null;
}

function highRiskBanner(action: string, planned: string[]): string {
  return [
    'WARNING: HIGH-RISK ACTION, HUMAN IN THE LOOP REQUIRED',
    '',
    action,
    ...planned,
    '',
    'This contacts a REAL PERSON and may involve MONEY. Private sales carry little',
    'or no consumer protection. Independently verify the listing (PPSR, registration,',
    'VIN/odometer, pre-purchase inspection) before committing. Marketplace scams are',
    'common. If a price looks too good to be true, it probably is.',
    '',
    'ANTI-BOT / HUMAN-TONE: the message you supply is sent VERBATIM (the AI does not',
    'write or rewrite it). Do NOT send the SAME message to many sellers. Identical bulk',
    'messages are the #1 "bot" tell and can get your account flagged or banned. Personalize',
    'each message per listing. Messages are also paced with a short random delay before send.',
    '',
    'No action was taken. To proceed, call this tool again with confirm: true.',
  ].join('\n');
}

server.tool(
  'auth_status',
  'Check whether the current session is logged in across the sites the server drives ' +
    '(carsales, Facebook, Gumtree) - so authenticated actions like save_vehicle / ' +
    'make_offer (carsales) or a saved login will work. Log in by hand via open_browser; ' +
    'the shared browser persists each site\'s cookies.',
  {},
  async () => {
    const page = await getPage();
    // carsales: account page presence.
    let carsales = false;
    try {
      const html = await fetchHtml('https://www.carsales.com.au/my-carsales/', page);
      carsales =
        html.length >= 6000 &&
        /(my account|sign out|log out|my carsales|saved (cars|vehicles)|watchlist)/i.test(html);
    } catch {
      carsales = false;
    }
    // Facebook / Gumtree: no clean account probe, so report via the cookies we
    // hold (a session cookie for the domain implies a logged-in/visited session).
    const cookies = await getCookiesAll();
    const fbSession = cookies.some(
      (c) => /facebook\.com/.test(c.domain) && /(sb|c_user|xs|datr)/i.test(c.name),
    );
    const gumSession = cookies.some((c) => /gumtree\.com/.test(c.domain) && /(session|machId|token)/i.test(c.name));
    if (carsales || fbSession || gumSession) await saveSession();
    const lines: string[] = [];
    lines.push(`carsales: ${carsales ? 'logged in (authenticated actions available)' : 'not confirmed logged in'}`);
    lines.push(`facebook: ${fbSession ? 'session cookie present (logged in/visited)' : 'no session cookie'}`);
    lines.push(`gumtree: ${gumSession ? 'session cookie present (logged in/visited)' : 'no session cookie'}`);
    lines.push('', 'To log in to a site, call open_browser with its URL, sign in in the visible window, then re-run auth_status.');
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

server.tool(
  'open_browser',
  'Open the shared Camoufox browser to a URL and leave it open so you can log in by hand. ' +
    'Works for any site the server drives - carsales, Gumtree or Facebook Marketplace. Use it ' +
    'to build a warm, authenticated session by reaching into the visible heading window and ' +
    'signing in; the shared browser then persists that site\'s login cookies for reuse, and the ' +
    'AI can act on it as a logged-in user. Never asks the bot to type a password.',
  {
    url: z
      .string()
      .optional()
      .default('https://www.carsales.com.au/')
      .describe('URL to open (default carsales.com.au). Use a site login page to sign in to that site.'),
    waitSeconds: z
      .number()
      .optional()
      .default(0)
      .describe('How long to leave the window open for manual login before checking cookies (0 = return immediately).'),
  },
  async ({ url, waitSeconds }) => {
    const page = await getPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
      return { content: [{ type: 'text', text: 'Failed to open ' + url + ': ' + (e as Error).message }] };
    }
    if (waitSeconds > 0) await new Promise((r) => setTimeout(r, waitSeconds * 1000));
    await saveSession();
    const site =
      /facebook\.com/.test(url) ? 'Facebook' : /gumtree\.com\.au/.test(url) ? 'Gumtree' : 'carsales';
    return {
      content: [
        {
          type: 'text',
          text:
            'The shared browser is open at ' + url + ' (' + site + '). ' +
            'Log in in the visible Camoufox window, then call auth_status to confirm. ' +
            (waitSeconds > 0 ? 'Session cookies were captured after the wait period.' : 'Returned immediately; call auth_status after you finish logging in.'),
        },
      ],
    };
  },
);

server.tool(
  'save_vehicle',
  'Save/watchlist a carsales listing to YOUR account (requires an authenticated session for ' +
    'that site - log in via open_browser). Best-effort: clicks the Save/Watchlist control on the ' +
    'listing page. Also saves it locally. Requires confirm: true (human-in-the-loop) before any ' +
    'account action is taken.',
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
      // Also save locally so it is tracked for a price drop / sold state.
      saveListing({
        source: 'carsales',
        id: listingIdFromUrl(target) || target,
        url: target,
        title: null,
        price: null,
        note: 'saved via save_vehicle',
      });
      return {
        content: [
          {
            type: 'text',
            text:
              (clicked
                ? `Clicked the Save control on ${target} (matched selector: ${hitSelector}; best-effort - confirm in your carsales account).`
                : `Could not find a Save/Watchlist control on ${target}. Tried ${selectors.length} selectors - the page may require login or its markup changed.`) +
              '\nSaved locally as well; run check_saved to watch for a price drop / sold state.',
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
  'Contact the seller / make an offer on a listing (carsales, Gumtree or Facebook - best-effort, ' +
    'requires an authenticated session for that site). Opens the contact/enquire/message form and ' +
    'submits your message. HIGH-RISK: contacts a real person and may involve money. Requires ' +
    'confirm: true (human-in-the-loop) - the first call returns a warning and does nothing. The ' +
    'listing is also saved locally so you can track a reply later.',
  {
    listingId: z.string().optional().describe('Listing id (any site)'),
    url: z.string().optional().describe('Full listing URL (carsales / Gumtree / Facebook)'),
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
    // Enforced guard: never send the same offer twice (identical, or any offer to
    // the same listing within the cooldown). This CANNOT be disabled. The key is
    // site-aware (<source>:<id>) so the guard is independent per site.
    const cooldownHours = Number(process.env.CARS_OFFER_COOLDOWN_HOURS || 24);
    const offerKey = offerKeyFor(target, listingId);
    if (hasIdenticalOffer(offerKey, message, price ?? null)) {
      return {
        content: [
          {
            type: 'text',
            text:
              'BLOCKED: an identical offer (same listing + same message + same price) was already ' +
              'sent and recorded. The duplicate-send guard refused to send it again. If you genuinely ' +
              'want to re-message, change the message text or wait out the cooldown.',
          },
        ],
      };
    }
    if (hasRecentOffer(offerKey, cooldownHours)) {
      return {
        content: [
          {
            type: 'text',
            text:
              `BLOCKED: an offer was already sent to this listing within the last ${cooldownHours}h ` +
              '(CARS_OFFER_COOLDOWN_HOURS). The duplicate-send guard refused to contact the same seller ' +
              'again so soon. Wait out the cooldown or use a different listing.',
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
              text: `Could not find a Make-an-offer / Contact-seller control on ${target}. Tried ${openSelectors.length} selectors - the page may require login or its markup changed.`,
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
          // Human-like pacing: a short randomized delay before submitting helps avoid
          // the "instant bot" pattern (and is polite to the seller).
          await page.waitForTimeout(1500 + Math.floor(Math.random() * 3000));
          await submitSel.click({ timeout: 5000 });
          sent = true;
          hitSubmit = (await submitSel.textContent())?.trim() || hitSubmit;
        } catch {
          // submission may need further steps
        }
      }
      await saveSession();
      if (sent) recordOffer(offerKey, message, price ?? null);
      // Also save locally so a reply / price change / sold state can be tracked.
      saveListing({
        source: sourceOfUrl(target),
        id: offerKeyFor(target, listingId).split(':')[1] || target,
        url: target,
        note: `offered${price != null ? ' $' + price.toLocaleString() : ''} via make_offer`,
        price: price ?? null,
      });
      return {
        content: [
          {
            type: 'text',
            text:
              'WARNING: you just initiated contact with a real seller and may be discussing ' +
              'money. Verify the listing independently (PPSR, rego, VIN, inspection) before ' +
              'committing. No consumer protection applies to private sales.\n\n' +
              (sent
                ? `Submitted your message to the seller for ${target} (opened via ${hitOpen}, sent via "${hitSubmit}"; best-effort - confirm in your account/outbox). This offer is now recorded so it cannot be sent again, and the listing is saved locally. Use check_saved to watch for a reply indicator / price change.`
                : `Opened the contact form for ${target} via ${hitOpen} and filled your message, but could not click a Send/Submit button (markup may differ). Saved locally so it is still tracked.`),
          },
        ],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: 'make_offer failed: ' + (e as Error).message }] };
    }
  },
);

function sourceOfUrl(u: string): SaveSource {
  if (/facebook\.com/.test(u)) return 'facebook';
  if (/gumtree\.com\.au/.test(u)) return 'gumtree';
  return 'carsales';
}

function offerKeyFor(url: string, id?: string): string {
  const src = sourceOfUrl(url);
  const idPart =
    id ||
    (url.match(/([A-Z]{3,4}-AD-\d+)/) || [])[1] ||
    (url.match(/marketplace\/item\/(\d+)/) || [])[1] ||
    (url.match(/\/web\/listing\/[^/]*\/(\d+)/) || [])[1] ||
    url;
  return `${src}:${idPart}`;
}

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
    radius: z.number().optional().default(50).describe('Facebook search radius in km around the location'),
    goodDealsOnly: z.boolean().optional().default(false).describe('Only return GOOD/GREAT deals'),
    sort: z
      .enum(['price_low', 'price_high'])
      .optional()
      .default('price_low')
      .describe('Sort order. Default price_low = cheapest first (AUD).'),
    cluster: z.boolean().optional().default(false).describe('Append a "by area" grouping of results'),
    limit: z.number().optional().default(30).describe('Max total results to return'),
  },
  async ({ make, model, location, state, minPrice, maxPrice, minYear, maxYear, radius, goodDealsOnly, sort, cluster, limit }) => {
    const query = [make, model].filter(Boolean).join(' ');
    // Sequential, not Promise.all: carsales and gumtree both use page.goto() on the
    // shared singleton page, so parallel legs drive the same page concurrently and
    // interleave/cancel each other (returning incomplete data, and looking like bot
    // traffic). Run them one at a time to keep each page load clean and humanised.
    async function safe(fn: () => Promise<ListingCard[]>, label: string): Promise<ListingCard[]> {
      try {
        return await fn();
      } catch (e) {
        console.error(`[carsales-mcp] ${label} leg failed:`, (e as Error).message);
        return [];
      }
    }
    const carsales = await safe(
      () => searchCars({ make, model, state, minPrice, maxPrice, minYear, maxYear, limit: 100 } as SearchParams),
      'carsales',
    );
    const facebook = await safe(
      () => searchFacebookCars({ query, location, minPrice, maxPrice, radius, limit: 40 }),
      'facebook',
    );
    const gumtree = await safe(
      () => searchGumtreeCars({ query, location, minPrice, maxPrice, radius, limit: 40 }),
      'gumtree',
    );

    let cards = dedupeListings([...carsales, ...facebook, ...gumtree]);
    if (minPrice != null) cards = cards.filter((c) => priceInRange(c, minPrice, undefined));
    if (maxPrice != null) cards = cards.filter((c) => priceInRange(c, undefined, maxPrice));
    if (minYear != null) cards = cards.filter((c) => (c.year ?? 0) >= minYear);
    if (maxYear != null) cards = cards.filter((c) => (c.year ?? Infinity) <= maxYear);
    const deals = new Map(cards.map((c) => [c.source + ':' + c.id, computeDeal(c)]));
    if (goodDealsOnly) cards = cards.filter((c) => deals.get(c.source + ':' + c.id)!.isGoodDeal);
    // Sort by price low to high (default) or high to low. Price unknown sorts last.
    if (sort === 'price_high') {
      cards.sort((a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity));
    } else {
      cards.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    }
    const limited = cards.slice(0, limit ?? 30);
    if (!limited.length)
      return { content: [{ type: 'text', text: 'No combined listings matched your criteria.' }] };
    const goodCount = limited.filter((c) => deals.get(c.source + ':' + c.id)!.isGoodDeal).length;
    const text = limited.map((c, i) => `${i + 1}. ${formatSourceCard(c)}`).join('\n');
    let clusterLine = '';
    if (cluster) {
      const byArea = new Map<string, number>();
      for (const c of limited) {
        const area =
          c.source === 'carsales'
            ? c.state || 'unknown'
            : c.source === 'facebook'
              ? c.location || 'unknown'
              : 'unknown';
        byArea.set(area, (byArea.get(area) ?? 0) + 1);
      }
      const parts = [...byArea.entries()].sort((a, b) => b[1] - a[1]).map(([a, n]) => `${a}: ${n}`);
      clusterLine = `\n\nBy area: ${parts.join('  |  ')}`;
    }
    return {
      content: [
        {
          type: 'text',
          text:
            `Combined search across carsales (${carsales.length}) + Facebook (${facebook.length}) + Gumtree (${gumtree.length}) ` +
            `-> showing ${limited.length}${goodCount ? `, ${goodCount} good deals` : ''}.\n\n${text}${clusterLine}`,
        },
      ],
    };
  },
);

server.tool(
  'search_gumtree_cars',
  'Search Gumtree.com.au for cars (native, FOSS - no paid API). Returns listings with price, ' +
    'title, location and a link. Best-effort: depends on Gumtree not blocking the request from your IP.',
  {
    query: z.string().describe('Search terms, e.g. "toyota corolla", "tesla model 3"'),
    location: z.string().optional().describe('Gumtree location filter, e.g. "sydney"'),
    minPrice: z.number().optional().describe('Minimum price in AUD'),
    maxPrice: z.number().optional().describe('Maximum price in AUD'),
    radius: z.number().optional().describe('Search radius in km around the location (best-effort; Gumtree may ignore)'),
    limit: z.number().optional().default(20).describe('Max results to return'),
  },
  async ({ query, location, minPrice, maxPrice, radius, limit }) => {
    let cards: ListingCard[];
    try {
      cards = await searchGumtreeCars({ query, location, minPrice, maxPrice, radius, limit });
    } catch (e) {
      return { content: [{ type: 'text', text: 'Gumtree search failed: ' + (e as Error).message }] };
    }
    if (!cards.length) return { content: [{ type: 'text', text: 'No Gumtree listings found.' }] };
    const text = cards.map((c, i) => `${i + 1}. ${formatSourceCard(c)}`).join('\n');
    return {
      content: [
        {
          type: 'text',
          text: `Found ${cards.length} Gumtree listing(s) for "${query}".\n\n${text}`,
        },
      ],
    };
  },
);

server.tool(
  'price_insight',
  'Free, FOSS valuation. Derives a fair-price band (median + 25th/75th percentile) from ' +
    'free comparable carsales listings for the same make/model/year - no paid RedBook/CarHistory. ' +
    'Optionally judges a specific target price.',
  {
    make: z.string().describe('Car make, e.g. "Toyota"'),
    model: z.string().optional().describe('Car model, e.g. "Camry"'),
    state: z.string().optional().describe('Australian state to bias comparables'),
    minYear: z.number().optional().describe('Minimum build year for comparables'),
    maxYear: z.number().optional().describe('Maximum build year for comparables'),
    targetPrice: z.number().optional().describe('Optional price to judge against the band'),
  },
  async ({ make, model, state, minYear, maxYear, targetPrice }) => {
    let cards: ListingCard[];
    try {
      cards = await searchCars({ make, model, state, minYear, maxYear, limit: 100 } as SearchParams);
    } catch (e) {
      if (e instanceof DataDomeBlockedError)
        return {
          content: [
            {
              type: 'text',
              text:
                'carsales.com.au served a DataDome bot-protection challenge, so no free comparables ' +
                'could be pulled. This is a block, not an empty market. Retry shortly or set CARS_PROXY.',
            },
          ],
        };
      return { content: [{ type: 'text', text: 'price_insight failed: ' + (e as Error).message }] };
    }
    const insight = computePriceInsight(cards);
    let cross = '';
    // Second, free valuation source: cross-market comparables (Gumtree + Facebook).
    // RedBook's own endpoint is paid/form-based, so we don't hardcode it; note that
    // carsales' own price badge is already RedBook-derived and is captured per listing.
    const query = [make, model].filter(Boolean).join(' ');
    const extra: ListingCard[] = [];
    try {
      extra.push(...(await searchGumtreeCars({ query, limit: 40 })));
    } catch {}
    try {
      extra.push(...(await searchFacebookCars({ query, location: 'sydney', limit: 40 })));
    } catch {}
    if (extra.length) {
      const ci = computePriceInsight(extra);
      if (ci.count) {
        cross =
          `\n\nCross-market check (Gumtree + Facebook, ${ci.count} free listings): ` +
          `median ${ci.median != null ? '$' + Math.round(ci.median).toLocaleString() : 'n/a'} ` +
          `(25th–75th: ${ci.p25 != null ? '$' + Math.round(ci.p25).toLocaleString() : 'n/a'} – ` +
          `${ci.p75 != null ? '$' + Math.round(ci.p75).toLocaleString() : 'n/a'}).`;
      }
    }
    if (!insight.count)
      return {
        content: [
          {
            type: 'text',
            text:
              `No free carsales comparables found for ${make} ${model ?? ''}.` +
              (cross || ' No cross-market listings found either.'),
          },
        ],
      };
    return {
      content: [{ type: 'text', text: formatInsight(insight, make, model, targetPrice ?? null) + cross }],
    };
  },
);

server.tool(
  'compare_listings',
  'Side-by-side comparison of 2–3 listings (by listingId or url). Pulls full details for each ' +
    'and renders a comparison table so the model can surface differences.',
  {
    listings: z
      .array(
        z.object({
          listingId: z.string().optional().describe('carsales listing id, e.g. OAG-AD-26099426'),
          url: z.string().optional().describe('Full listing URL (carsales)'),
        }),
      )
      .min(2)
      .max(3)
      .describe('2–3 listings to compare'),
    includeImages: z.boolean().optional().default(false).describe('Also return photos as image blocks'),
  },
  async ({ listings, includeImages }) => {
    const resolved = listings
      .map((l) => l.url || (l.listingId ? `https://www.carsales.com.au/cars/details/${l.listingId}/` : ''))
      .filter(Boolean);
    const details: { id: string; title: string | null; url: string; metadata: Record<string, unknown>; imageUrls: string[] }[] = [];
    const imageBlocks: Array<{ type: 'image'; data: string; mimeType: string }> = [];
    for (const target of resolved) {
      const idMatch = target.match(/([A-Z]{3,4}-AD-\d+)/);
      const d = await describeListing(idMatch ? idMatch[1] : undefined, target, includeImages);
      details.push({ id: d.id, title: d.title, url: d.url, metadata: d.metadata, imageUrls: d.imageUrls });
      if (includeImages) {
        const page = await getPage();
        imageBlocks.push(...(await downloadImages(page, d.imageUrls, 8)));
      }
    }
    if (details.length < 2)
      return { content: [{ type: 'text', text: 'Provide at least 2 resolvable listings.' }] };
    const fields: (keyof (typeof details)[0]['metadata'])[] = [
      'price',
      'year',
      'odometer',
      'transmission',
      'fuelType',
      'bodyType',
      'engine',
      'seller',
      'state',
    ];
    const header = ['field', ...details.map((d) => d.title || d.id)].join(' | ');
    const rows = fields.map((f) => {
      const cells = details.map((d) => {
        const v = (d.metadata as any)[f];
        return v == null ? '-' : String(v);
      });
      return [f, ...cells].join(' | ');
    });
    const out =
      `Comparison (${details.length} listings):\n\n${header}\n${rows.join('\n')}\n\n` +
      details.map((d) => `${d.title || d.id}: ${d.url}`).join('\n');
    return { content: [{ type: 'text', text: out }, ...(includeImages ? imageBlocks : [])] };
  },
);

server.tool(
  'export_csv',
  'Export a carsales search to CSV (free, no external service) so results can be opened in a ' +
    'spreadsheet. Returns the CSV as a text block.',
  {
    make: z.string().describe('Car make, e.g. "Toyota"'),
    model: z.string().optional().describe('Car model, e.g. "Camry"'),
    state: z.string().optional().describe('Australian state'),
    minPrice: z.number().optional().describe('Minimum price in AUD'),
    maxPrice: z.number().optional().describe('Maximum price in AUD'),
    minYear: z.number().optional().describe('Minimum build year'),
    maxYear: z.number().optional().describe('Maximum build year'),
    postcode: z.string().optional().describe('Restrict to a postcode'),
    radius: z.number().optional().describe('Search radius in km around the postcode'),
    limit: z.number().optional().default(50).describe('Max results to return'),
  },
  async (p) => {
    let cards: ListingCard[];
    try {
      cards = await searchCars(p as SearchParams);
    } catch (e) {
      if (e instanceof DataDomeBlockedError)
        return {
          content: [
            {
              type: 'text',
              text:
                'carsales.com.au served a DataDome bot-protection challenge, so there is nothing to export. ' +
                'Retry shortly or set CARS_PROXY.',
            },
          ],
        };
      return { content: [{ type: 'text', text: 'export_csv failed: ' + (e as Error).message }] };
    }
    if (!cards.length) return { content: [{ type: 'text', text: 'No listings to export.' }] };
    const cols = ['source', 'id', 'title', 'year', 'price', 'priceExGovt', 'odometer', 'transmission', 'fuelType', 'bodyType', 'seller', 'state', 'url'];
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const rows = cards.map((c) => cols.map((k) => esc((c as any)[k])).join(','));
    const csv = [cols.join(','), ...rows].join('\n');
    return { content: [{ type: 'text', text: csv }] };
  },
);

server.tool(
  'watch_search',
  'Save a search to watch for NEW listings (FOSS alerts - no paid service). Re-run check_watch ' +
    'later to see what appeared since the last check. Sources: carsales (default), gumtree, facebook.',
  {
    name: z.string().describe('Watch name, e.g. "toyota-corolla-sydney"'),
    make: z.string().describe('Car make'),
    model: z.string().optional().describe('Car model'),
    state: z.string().optional().describe('Australian state'),
    minPrice: z.number().optional().describe('Minimum price in AUD'),
    maxPrice: z.number().optional().describe('Maximum price in AUD'),
    minYear: z.number().optional().describe('Minimum build year'),
    maxYear: z.number().optional().describe('Maximum build year'),
    sources: z
      .array(z.enum(['carsales', 'gumtree', 'facebook']))
      .optional()
      .describe('Sources to watch (default: carsales only)'),
  },
  async ({ name, make, model, state, minPrice, maxPrice, minYear, maxYear, sources }) => {
    const w = addWatch(
      name,
      { make, model, state, minPrice, maxPrice, minYear, maxYear, limit: 100 } as SearchParams,
      (sources as WatchSource[]) || ['carsales'],
    );
    return {
      content: [
        {
          type: 'text',
          text: `Watching "${name}" across [${w.sources.join(', ')}]. Call check_watch with this name to see new listings.`,
        },
      ],
    };
  },
);

server.tool(
  'watch_listing',
  'Watch a SINGLE listing for a PRICE DROP (FOSS alerts - no paid service). Re-run check_watch ' +
    'later to see if the price changed (especially a drop). Works for carsales, Facebook and ' +
    'Gumtree listing URLs.',
  {
    name: z.string().describe('Watch name, e.g. "corolla-abc123"'),
    listingId: z.string().optional().describe('carsales listing id, e.g. OAG-AD-26099426'),
    url: z.string().optional().describe('Full listing URL (carsales / Facebook / Gumtree)'),
  },
  async ({ name, listingId, url }) => {
    if (!listingId && !url) return { content: [{ type: 'text', text: 'Provide listingId or url.' }] };
    const w = addListingWatch(name, listingId, url);
    return {
      content: [
        {
          type: 'text',
          text: `Watching listing "${name}". Call check_watch with this name to detect a price drop.`,
        },
      ],
    };
  },
);

server.tool(
  'list_watches',
  'List all saved watches (search watches and listing price-drop watches).',
  {},
  async () => {
    const ws = listWatches();
    if (!ws.length) return { content: [{ type: 'text', text: 'No watches saved.' }] };
    return {
      content: [
        {
          type: 'text',
          text: ws
            .map((w) =>
              w.type === 'listing'
                ? `- ${w.name} [listing] ${w.url || w.listingId} (last price: ${w.lastPrice ?? 'unknown'})`
                : `- ${w.name} [${w.sources.join(', ')}] (last seen ${w.lastIds.length} listings)`,
            )
            .join('\n'),
        },
      ],
    };
  },
);

server.tool(
  'check_watch',
  'Re-run a saved watch and report what changed. For search watches: NEW listings since the last ' +
    'check. For listing watches: a PRICE DROP (or any price change). Pure local diff over free ' +
    'search results - no paid alert service.',
  {
    name: z.string().describe('Watch name to check'),
  },
  async ({ name }) => {
    const w = getWatch(name);
    if (!w) return { content: [{ type: 'text', text: `No watch named "${name}".` }] };
    if (w.type === 'listing') {
      const target = w.url || (w.listingId ? `https://www.carsales.com.au/cars/details/${w.listingId}/` : '');
      if (!target) return { content: [{ type: 'text', text: `Watch "${name}" has no listing URL/id.` }] };
      const d = await describeListing(w.listingId, target, false);
      const price = (d.metadata as Record<string, unknown>).price as number | null | undefined;
      const prev = w.lastPrice ?? null;
      setWatchLastPrice(name, price ?? null);
      if (prev != null && price != null && price < prev)
        return {
          content: [
            {
              type: 'text',
              text: `PRICE DROP on "${name}": ${'$' + Math.round(prev).toLocaleString()} → ${'$' + Math.round(price).toLocaleString()} (-${'$' + Math.round(prev - price).toLocaleString()}).\n${d.url}`,
            },
          ],
        };
      if (prev == null)
        return { content: [{ type: 'text', text: `Now watching "${name}" - current price ${price != null ? '$' + Math.round(price).toLocaleString() : 'unknown'}.\n${d.url}` }] };
      return {
        content: [
          {
            type: 'text',
            text: `No drop on "${name}" - still ${price != null ? '$' + Math.round(price).toLocaleString() : 'unknown'} (was ${'$' + Math.round(prev).toLocaleString()}).\n${d.url}`,
          },
        ],
      };
    }
    const res = await runWatch(name);
    if (!res) return { content: [{ type: 'text', text: `No watch named "${name}".` }] };
    if (!res.newCards.length)
      return {
        content: [{ type: 'text', text: `No new listings for "${name}" (tracking ${res.total} total).` }],
      };
    const text = res.newCards.map((c, i) => `${i + 1}. ${formatSourceCard(c)}`).join('\n');
    return {
      content: [
        {
          type: 'text',
          text: `${res.newCards.length} NEW listing(s) for "${name}":\n\n${text}`,
        },
      ],
    };
  },
);

server.tool(
  'remove_watch',
  'Delete a saved watch (search or listing) by name.',
  { name: z.string().describe('Watch name to delete') },
  async ({ name }) => {
    const ok = removeWatch(name);
    return {
      content: [{ type: 'text', text: ok ? `Removed watch "${name}".` : `No watch named "${name}".` }],
    };
  },
);

function listingIdFromUrl(url: string): string {
  return (
    (url.match(/([A-Z]{3,4}-AD-\d+)/) || [])[1] ||
    (url.match(/marketplace\/item\/(\d+)/) || [])[1] ||
    (url.match(/\/web\/listing\/[^/]*\/(\d+)/) || [])[1] ||
    ''
  );
}

server.tool(
  'save_listing',
  'Save a car listing LOCALLY so it is tracked for a price drop or when it sells. ' +
    'Works for carsales, Gumtree and Facebook listings. First call also attempts the ' +
    'site\'s own Save/Watchlist control (best-effort, like save_vehicle) so it is saved ' +
    'on the site too. Pairs with list_saved and check_saved.',
  {
    url: z.string().optional().describe('Full listing URL (carsales / Gumtree / Facebook)'),
    listingId: z.string().optional().describe('Listing id (carsales OAG-AD-xxx / FB marketplace id / Gumtree id)'),
    note: z.string().optional().describe('Optional note, e.g. "no rust - only if <200k km", "verify rego before offer"'),
    siteNative: z
      .boolean()
      .optional()
      .default(true)
      .describe('Also click the site\'s own Save/Watchlist control (best-effort). Set false to only save locally.'),
  },
  async ({ url, listingId, note, siteNative }) => {
    const target = resolveListingTarget(listingId, url);
    if (!target) return { content: [{ type: 'text', text: 'Provide listingId or url.' }] };
    const source = sourceOfUrl(target);
    const id = listingId || listingIdFromUrl(target) || target;
    const d = await describeListing(listingId, target, false).catch(() => null);
    const meta = d?.metadata as Record<string, any> | undefined;
    const entry = saveListing({
      source,
      id,
      url: target,
      title: d?.title ?? meta?.title ?? null,
      price: meta?.price ?? null,
      priceExGovt: meta?.priceExGovt ?? null,
      note,
    });
    // Best-effort site-native save via the shared headed browser.
    let native = 'skipped';
    if (siteNative) {
      const page = await getPage();
      try {
        await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2500);
        const selectors = [
          'button:has-text("Save")',
          'button:has-text("Watchlist")',
          'a:has-text("Save this")',
          '[data-testid*="save" i]',
          'button[aria-label*="save" i]',
          'a[aria-label*="Save" i]',
          'button:has-text("Saved")',
        ];
        let clicked = false;
        let hit = '';
        for (const sel of selectors) {
          try {
            const el = page.locator(sel).first();
            if (await el.count()) {
              await el.click({ timeout: 5000 });
              clicked = true;
              hit = sel;
              break;
            }
          } catch {
            // next
          }
        }
        await saveSession();
        native = clicked
          ? `clicked the site Save control (${hit}; best-effort - confirm in your account)`
          : 'could not find a Save control on this site (saved locally regardless)';
      } catch (e) {
        native = 'site save failed: ' + (e as Error).message + ' (saved locally regardless)';
      }
    }
    return {
      content: [
        {
          type: 'text',
          text:
            `Saved locally (${source}) at ${savedFile()}:\n` +
            `${entry.title || 'Untitled'} - ${entry.price != null ? '$' + entry.price.toLocaleString() : 'price n/a'}\n` +
            `${entry.url}\n` +
            `Site save: ${native}.\n\n` +
            `Run check_saved to watch it for a price drop / sold status.`,
        },
      ],
    };
  },
);

server.tool(
  'list_saved',
  'List all locally saved car listings (all sites) with their last known price and ' +
    'sold/price-drop status.',
  {},
  async () => {
    const list = listSaved();
    if (!list.length)
      return { content: [{ type: 'text', text: `No saved listings yet (${savedFile()}).` }] };
    const lines = list.map((s, i) => {
      const price = s.price != null ? '$' + s.price.toLocaleString() : 'price n/a';
      const flags = [
        s.sold ? 'SOLD' : null,
        s.lastPrice != null && s.price != null && s.price < s.lastPrice ? `dropped from $${s.lastPrice.toLocaleString()}` : null,
      ]
        .filter(Boolean)
        .join(', ');
      return `${i + 1}. [${s.source}] ${s.title || 'Untitled'}\n   ${price}${s.note ? ` | note: ${s.note}` : ''}${flags ? ` | ${flags}` : ''}\n   ${s.url}`;
    });
    return { content: [{ type: 'text', text: `Saved listings (${savedFile()}):\n\n${lines.join('\n')}` }] };
  },
);

server.tool(
  'check_saved',
  'Re-fetch every locally saved listing and report CHANGES: a price drop, or that a ' +
    'listing now appears sold/withdrawn (no longer resolves). Re-runs the listing ' +
    'lookup through the shared browser, so it works across carsales, Gumtree and Facebook.',
  {},
  async () => {
    const list = listSaved();
    if (!list.length)
      return { content: [{ type: 'text', text: 'No saved listings to check.' }] };
    const reports: string[] = [];
    for (const s of list) {
      try {
        const d = await describeListing(undefined, s.url, false);
        const meta = d.metadata as Record<string, any> | undefined;
        const price = meta?.price ?? null;
        const blocked = meta?.blocked === true || /blocked/i.test(d.text);
        const change = applyCheck(s.key, { price, sold: blocked });
        if (change) reports.push(`[${s.source}] ${s.title || s.id}\n${change}\n${s.url}`);
        // Also refresh stored price/title so list_saved stays current.
        if (price != null) {
          const cur = getSaved(s.key);
          if (cur && cur.price != price) {
            cur.title = d.title ?? cur.title;
            cur.price = price;
            saveListing({ source: cur.source, id: cur.id, url: cur.url, title: cur.title, price, note: cur.note });
          }
        }
      } catch {
        reports.push(`[${s.source}] ${s.title || s.id}\nCould not fetch (may be unavailable to this network / sold).`);
      }
    }
    if (!reports.length)
      return { content: [{ type: 'text', text: 'Checked all saved listings - no price drops and none sold.' }] };
    return { content: [{ type: 'text', text: 'Saved-car changes:\n\n' + reports.join('\n\n') }] };
  },
);

server.tool(
  'remove_saved',
  'Remove a locally saved listing by its key (<source>:<id>) or URL.',
  {
    key: z.string().optional().describe('Saved key, e.g. "carsales:OAG-AD-26136665" or "facebook:123"'),
    url: z.string().optional().describe('Alternatively, the listing URL'),
  },
  async ({ key, url }) => {
    let k = key;
    if (!k && url) {
      const id = listingIdFromUrl(url) || url;
      k = `${sourceOfUrl(url)}:${id}`;
    }
    if (!k) return { content: [{ type: 'text', text: 'Provide key or url.' }] };
    const ok = removeSaved(k);
    return { content: [{ type: 'text', text: ok ? `Removed saved listing "${k}".` : `No saved listing "${k}".` }] };
  },
);

server.tool(
  'check_inbox',
  'Check for seller replies / offer responses by opening the site\'s message inbox in the ' +
    'shared headed browser and reading what is visible (best-effort). Works for the site of a ' +
    'given URL, or defaults to carsales. For Facebook it opens Messenger; for Gumtree its ' +
    'message centre. Reports unread threads/snippets. Because these sites have no stable ' +
    'message API, this drives the real inbox UI - it is best-effort and depends on markup.',
  {
    site: z
      .enum(['carsales', 'gumtree', 'facebook'])
      .optional()
      .describe('Which site inbox to open (default: carsales).'),
    url: z.string().optional().describe('Optional listing URL to auto-detect the site.'),
  },
  async ({ site, url }) => {
    const s = site || sourceOfUrl(url || '') || 'carsales';
    const inbox =
      s === 'facebook'
        ? 'https://www.facebook.com/messages/'
        : s === 'gumtree'
          ? 'https://www.gumtree.com.au/'
          : 'https://www.carsales.com.au/my-carsales/messages/';
    const page = await getPage();
    let html = '';
    try {
      await page.goto(inbox, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3500);
      html = await page.content();
      await saveSession();
    } catch (e) {
      return {
        content: [
          {
            type: 'text',
            text:
              `Could not open the ${s} inbox (${inbox}). ` +
              `This is best-effort - you may need to log in to ${s} first via open_browser. Error: ${(e as Error).message}`,
          },
        ],
      };
    }
    // Best-effort: pull text snippets that look like message threads / unread counts.
    const unreadM = html.match(/(\d+)\s*unread/i) || html.match(/(\d+)\s*new message/i);
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1400);
    const flagged = /(login|log in|sign in|you must log|verify it's you)/i.test(text);
    if (flagged && !unreadM)
      return {
        content: [
          {
            type: 'text',
            text:
              `opened the ${s} inbox but the page indicates it needs a login or verification. ` +
              `Log in to ${s} via open_browser, then re-run check_inbox. (best-effort)`,
          },
        ],
      };
    const lines: string[] = [];
    if (unreadM) lines.push(`Detected unread indicator: ${unreadM[0]}.`);
    lines.push(`Opened ${s} inbox (${inbox}).`);
    lines.push(
      text.length > 40
        ? 'Visible page text (may contain thread snippets):\n' + text
        : 'No readable thread text detected from the page (markup-dependent / may need login).',
    );
    return {
      content: [
        {
          type: 'text',
          text: lines.join('\n') + '\n\nNote: this is best-effort. Verify replies in your actual inbox/app before acting.',
        },
      ],
    };
  },
);

server.tool(
  'check_vehicle',
  'Free vehicle trust check (FOSS, NO paid PPSR). Points at the official state-transport ' +
    'registration check (registration validity + written-off status) and attempts a best-effort ' +
    'automated lookup. Encumbrance (finance owed) is ONLY on paid PPSR and is intentionally out ' +
    'of scope. The manual URL is always returned for independent human verification.',
  {
    plate: z.string().describe('Registration plate, e.g. "ABC123"'),
    state: z
      .string()
      .optional()
      .default('nsw')
      .describe('Australian state: nsw, vic, qld, wa, sa, tas, act, nt'),
  },
  async ({ plate, state }) => {
    const r = await checkVehicle(plate, state);
    return {
      content: [
        {
          type: 'text',
          text:
            `Vehicle check (${r.plate}, ${r.state}) - automated: ${r.automated ? 'some data' : 'none'}.\n\n` +
            `${r.text}\n\nManual verification (human-in-the-loop): ${r.manualUrl}`,
        },
      ],
    };
  },
);

server.tool(
  'dealer_info',
  'Look up a seller/dealer reputation. For carsales dealer pages this scrapes the star rating + ' +
    'review count (best-effort). Facebook and Gumtree are mostly PRIVATE sellers with no dealer ' +
    'rating - for those it just confirms the seller type. Use before contacting anyone.',
  {
    url: z.string().optional().describe('carsales dealer page URL (or any listing URL)'),
    name: z.string().optional().describe('Dealer/seller name to echo'),
  },
  async ({ url, name }) => {
    if (!url) {
      return {
        content: [
          { type: 'text', text: name ? `Seller: ${name} (provide a URL to look up reputation).` : 'Provide a url.' },
        ],
      };
    }
    if (/facebook\.com|gumtree\.com\.au/.test(url)) {
      return {
        content: [
          {
            type: 'text',
            text: `That URL is on ${/facebook\.com/.test(url) ? 'Facebook Marketplace' : 'Gumtree'} - ` +
              `these are predominantly PRIVATE sellers with no dealer rating. Verify the individual ` +
              `listing and meet in a safe, public place. Never pay before inspecting the car.`,
          },
        ],
      };
    }
    const page = await getPage();
    const html = await fetchHtml(url, page);
    const ratingM =
      html.match(/"ratingValue"\s*:\s*([\d.]+)/i) ||
      html.match(/([\d](?:\.\d)?)\s*(?:out of|\/)\s*5/i) ||
      html.match(/([\d.]+)-?\s*star/i);
    const reviewsM = html.match(/(\d[\d,]*)\s*(?:reviews?|ratings?)/i);
    const rating = ratingM ? Number(ratingM[1]) : null;
    const reviews = reviewsM ? Number(reviewsM[1].replace(/,/g, '')) : null;
    if (rating == null && reviews == null)
      return {
        content: [
          {
            type: 'text',
            text: 'Could not extract a dealer rating from that page (markup may differ or it is a private listing). ' +
              'Verify independently before committing.',
          },
        ],
      };
    return {
      content: [
        {
          type: 'text',
          text:
            `Dealer reputation (best-effort): ${name ? name + ' - ' : ''}` +
            `${rating != null ? `rating ${rating}/5` : 'rating n/a'}` +
            `${reviews != null ? ` across ${reviews} review(s)` : ''}.\n${url}`,
        },
      ],
    };
  },
);

function makeModelFromTitle(title?: string | null): { make: string | null; model: string | null } {
  const m = (title || '').trim().match(/^(\d{4})\s+([A-Za-z]+)\s+([A-Za-z0-9]+)/);
  return m ? { make: m[2], model: m[3] } : { make: null, model: null };
}

async function findNewCarPrice(make: string | null, model: string | null, state?: string | null): Promise<number | null> {
  if (!make) return null;
  try {
    const cards = await searchCars({ make, model: model || undefined, condition: 'new', state: state || undefined, limit: 30 } as SearchParams);
    const prices = cards.map((c) => c.price ?? c.priceExGovt).filter((p): p is number => p != null && p > 0).sort((a, b) => a - b);
    return prices[0] ?? null;
  } catch {
    return null;
  }
}

server.tool(
  'remember_preference',
  'Learn what the buyer wants. Call this when the user accepts or rejects something: ' +
    '"filter" sets a search default (e.g. maxPrice=4000); "like"/"avoid" record a ' +
    'preference rule ("no rust", "dents are fine", "no diesels"); "reject" records a ' +
    'specific car they said no to (with the reason). Stored locally and auto-applied ' +
    'to future searches. Always capture the user reason - that is the learning.',
  {
    kind: z.enum(['filter', 'like', 'avoid', 'reject']),
    field: z.string().optional().describe('For filter: maxPrice, minPrice, maxYear, minYear, maxOdometer, transmission, fuelType, bodyStyle, states'),
    value: z.union([z.number(), z.string(), z.array(z.string())]).optional().describe('Filter value'),
    text: z.string().optional().describe('For like/avoid: the rule, e.g. "no rust" or "automatic preferred"'),
    reason: z.string().optional().describe('Why (the learning - capture the user rationale)'),
    listingId: z.string().optional().describe('For reject: the rejected listing id'),
    url: z.string().optional().describe('For reject: the rejected listing URL'),
  },
  async ({ kind, field, value, text, reason, listingId, url }) => {
    let confirmation: string;
    if (kind === 'filter') {
      if (!field) return { content: [{ type: 'text', text: 'Provide field for filter (e.g. maxPrice).' }] };
      setFilter(field as any, value ?? null, reason);
      confirmation = `Remembered filter: ${field} = ${JSON.stringify(value ?? null)}.`;
    } else if (kind === 'like' || kind === 'avoid') {
      if (!text) return { content: [{ type: 'text', text: 'Provide text for like/avoid.' }] };
      addNote(kind, text, reason);
      confirmation = `Learned (${kind}): "${text}"${reason ? ` — ${reason}` : ''}.`;
    } else {
      const id = listingId || (url?.match(/([A-Z]{3,4}-AD-\d+)/) || [])[1] || '';
      if (!id) return { content: [{ type: 'text', text: 'Provide listingId or url to reject.' }] };
      excludeEntry(id, url || `https://www.carsales.com.au/cars/details/${id}/`, undefined, reason);
      confirmation = `Recorded rejection of ${id}${reason ? ` — ${reason}` : ''}; it is excluded from future searches.`;
    }
    return {
      content: [{ type: 'text', text: `${confirmation}\n\nCurrent: ${prefsSummary()}` }],
    };
  },
);

server.tool(
  'get_preferences',
  'Return the buyer\'s learned preferences (filters, likes, avoid-rules, rejected ' +
    'listings) and the local file they are stored in.',
  {},
  async () => {
    const p = getPreferences();
    const lines = [
      `Learned preferences (${prefsFile()}):`,
      `  summary: ${prefsSummary()}`,
      `  filters: ${JSON.stringify(p.filters)}`,
      `  like:    ${p.like.map((n) => `"${n.text}"` + (n.reason ? ` (${n.reason})` : '')).join('; ') || 'none'}`,
      `  avoid:   ${p.avoid.map((n) => `"${n.text}"` + (n.reason ? ` (${n.reason})` : '')).join('; ') || 'none'}`,
      `  rejected: ${p.excluded.map((e) => `${e.id}` + (e.reason ? ` (${e.reason})` : '')).join('; ') || 'none'}`,
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

server.tool(
  'clear_preferences',
  'Forget all learned preferences (filters, likes, avoid-rules, rejected listings).',
  {},
  async () => {
    clearPreferences();
    return { content: [{ type: 'text', text: 'Cleared all learned preferences.' }] };
  },
);

server.tool(
  'vehicle_review',
  'Full buyer review of one listing: real photos (for the vision model) plus a ' +
    'reliability/reputation assessment and a comparison to both the market average ' +
    '(from free comparables) and the new-car price. Bundles get_listing_details + ' +
    'assessListingReliability + price_insight + compare-to-new.',
  {
    listingId: z.string().optional().describe('carsales listing id, e.g. OAG-AD-26099426'),
    url: z.string().optional().describe('Full listing URL (carsales)'),
    includeImages: z.boolean().optional().default(true).describe('Return photos so the model can see the car'),
  },
  async ({ listingId, url, includeImages }) => {
    let target = url;
    if (!target && listingId) target = `https://www.carsales.com.au/cars/details/${listingId}/`;
    if (!target) return { content: [{ type: 'text', text: 'Provide listingId or url.' }] };
    const d = await describeListing(listingId, target, includeImages);
    const meta = d.metadata as Record<string, any>;
    const { make, model } = makeModelFromTitle(d.title ?? meta.title);
    const year = meta.year ?? null;
    const price = meta.price ?? null;
    const odometer = meta.odometer ?? null;
    const badge = meta.priceBadge ?? null;
    const rel = assessListingReliability({ make, model, year, odometer, priceBadge: badge });

    const lines: string[] = [
      `REVIEW: ${d.title ?? listingId ?? 'listing'}`,
      `  price: ${price != null ? '$' + Number(price).toLocaleString() : 'n/a'}   year: ${year ?? '?'}   odometer: ${odometer != null ? Number(odometer).toLocaleString() + ' km' : '?'}`,
      `  Reliability/reputation: ${rel.band} (${rel.score}/100). ${rel.note}`,
      rel.issues.length ? `  Watch for: ${rel.issues.join('; ')}.` : '',
      d.text.includes('blocked') ? '  (full detail page was bot-blocked; using summary card data).' : '',
    ].filter(Boolean);

    // Market average from free comparables
    try {
      const comps = await searchCars({
        make,
        model: model || undefined,
        state: meta.state ?? undefined,
        minYear: year != null ? year - 1 : undefined,
        maxYear: year != null ? year + 1 : undefined,
        limit: 100,
      } as SearchParams).catch(() => [] as ListingCard[]);
      const ins = computePriceInsight(comps);
      if (ins.count) {
        lines.push(formatInsight(ins, make || 'this car', model || '', price));
      } else {
        lines.push('No free comparables found to benchmark the price.');
      }
    } catch {
      lines.push('Comparables search failed; could not benchmark the price.');
    }

    // Compare to a new / current model
    try {
      const np = await findNewCarPrice(make, model, meta.state);
      if (np != null) {
        const verdict = price != null && np > 0 ? ` (${Math.round((price / np) * 100)}% of a new one)` : '';
        lines.push(`New / current ${make || ''} ${model || ''} (new listing price): ~$${Number(np).toLocaleString()}${verdict}.`);
      } else {
        lines.push('No current new-car listing found to compare against.');
      }
    } catch {
      // ignore
    }

    const page = await getPage();
    const imgs = includeImages ? await downloadImages(page, d.imageUrls, 8) : [];
    return { content: [{ type: 'text', text: lines.join('\n') + `\n\nURL: ${d.url}` }, ...imgs] };
  },
);

async function findCardById(_page: Page, id: string, make: string, model = ''): Promise<ListingCard | null> {
  if (!make) return null;
  // Keep this short: every extra page is another navigation that DataDome scores,
  // and on a blocked detail page this fallback previously fired up to 8 full
  // searches (8 extra page loads) which ramps the block. Cap at 3 and stop early.
  for (let p = 1; p <= 3; p++) {
    let cards: ListingCard[];
    try {
      cards = await searchCars({ make, model, page: p, limit: 100 } as SearchParams);
    } catch (e) {
      if (e instanceof DataDomeBlockedError) break;
      continue;
    }
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
