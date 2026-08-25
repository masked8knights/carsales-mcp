import { Browser, BrowserContext, Page } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export type { Page };
export type { Browser, BrowserContext };

// Engine selection. Camoufox (camoufox-js, a C++-patched Firefox that spoofs
// navigator.webdriver, WebGL, hardware concurrency, AudioContext, WebRTC) is the
// default, with the jo-inc build ('joinc', https://github.com/jo-inc/camofox-browser)
// as the hardest-to-fingerprint opt-in. Chromium was removed entirely: vanilla
// Chromium is trivially fingerprinted and would contradict the tool's stealth
// purpose, so it is never a safe fallback. Set CARS_ENGINE to pin one tier.
type Engine = 'joinc' | 'camoufox';
const ENGINE_RAW = (process.env.CARS_ENGINE || 'camoufox').toLowerCase();
const ENGINE: Engine = ENGINE_RAW === 'joinc' ? 'joinc' : 'camoufox';

// Optional: point Camoufox at a specific browser binary (e.g. a build you
// fetched yourself from github.com/jo-inc/camofox-browser releases).
const CUSTOM_CAMOUFOX_BINARY = process.env.CARS_CAMOUFOX_BINARY || '';

// The engine that actually launched, so the log and active-engine state reflect
// reality across the fallback chain (camoufox -> joinc).
let activeEngine: Engine | null = null;

export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

let browser: Browser | null = null;
let sharedContext: BrowserContext | null = null;
let sharedPage: Page | null = null;

const PROXY_LIST = (process.env.CARS_PROXY || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const MIN_DELAY = Number(process.env.CARS_MIN_DELAY || 1500);
const MAX_RETRIES = Number(process.env.CARS_RETRIES || 3);
const BACKOFF = Number(process.env.CARS_BACKOFF || 2000);

// Optional FOSS CAPTCHA help. Buster (https://github.com/dessant/buster, MIT)
// solves hCaptcha/reCAPTCHA *audio* challenges locally via the browser's Web
// Speech API (no paid service). The build must match the Firefox engine and you
// must point CARS_BUSTER_EXTENSION at your installed copy. It does NOT defeat
// behavioural bot-protection like DataDome - that relies on avoidance (residential
// IP + headful Camoufox). Opt-in, default off.
const CAPTCHA_SOLVER = (process.env.CARS_CAPTCHA_SOLVER || 'none').toLowerCase();
const BUSTER_EXT = process.env.CARS_BUSTER_EXTENSION || '';

// Headful is mandatory (headless is one of the strongest bot signals DataDome
// scores, and a headed browser needs a display - WSLg/desktop shows a window;
// a headless server should wrap the process in xvfb, not run headless).

// Authenticated sessions: cookies are persisted to this file so a user can log
// in once (via set_auth / a real browser) and have the session reused across
// runs and tool calls. Carsales unlocks extra actions (saving a vehicle, making
// an offer/contacting the seller) for logged-in users.
const COOKIE_FILE =
  process.env.CARS_COOKIE_FILE || path.join(os.homedir(), '.carsales-mcp', 'cookies.json');

let lastNav = 0;
// Adaptive anti-blast memory: after a DataDome challenge, back off far more for
// a while so we don't keep hammering right after a block (which looks exactly like
// a bot doing burst retries and extends the block). Reset once a real page loads.
let lastBlockAt = 0;
const BLOCK_COOLDOWN_MS = 90_000; // after a block, wait ~90s before the next navigate

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Human-like pacing. DataDome scores behaviour, so a robot that navigates at a
// perfectly fixed interval is easy to catch. We add random jitter to every wait
// and lightly "read" each page (scroll, pause) rather than snapping from one
// navigation to the next.
const HUMANIZE = (process.env.CARS_HUMANIZE || '1') !== '0';

function rand(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}

function humanPause(minMs: number, maxMs: number): Promise<void> {
  return sleep(rand(minMs, maxMs)) as Promise<void>;
}

/** Simulate a human lightly scanning the page: a short pause and a small scroll. */
async function humanizePage(page: Page, isResults: boolean): Promise<void> {
  if (!HUMANIZE) return;
  try {
    await humanPause(1200, 3200);
    if (isResults) {
      // A reader scrolls the grid a little rather than reading the top only. rand()
      // is a Node-side function and does not exist inside page.evaluate, so the
      // scroll offsets must be passed in (previously this silently threw a
      // ReferenceError and the page never scrolled - a real behavioural tell).
      await page.evaluate((y) => window.scrollBy(0, y), rand(200, 900)).catch(() => {});
      await humanPause(600, 1600);
      await page.evaluate((y) => window.scrollBy(0, y), rand(-300, 300)).catch(() => {});
    }
  } catch {
    // best-effort, never let humanizing break a fetch
  }
}

function pickProxy(): { server: string; bypass: string } | undefined {
  if (!PROXY_LIST.length) return undefined;
  const server = PROXY_LIST[Math.floor(Math.random() * PROXY_LIST.length)];
  return { server, bypass: '<-loopback>' };
}

function camoufoxCacheDir(): string {
  return process.env.CAMOUFOX_INSTALL_DIR || path.join(os.homedir(), '.cache', 'camoufox');
}

async function ensureCamoufoxBinary(): Promise<void> {
  if (fs.existsSync(camoufoxCacheDir())) return;
  console.error('[carsales-mcp] Downloading Camoufox browser (one-time, ~700MB)...');
  await new Promise<void>((resolve) => {
    const cp = spawn('npx', ['camoufox-js', 'fetch'], {
      stdio: 'inherit',
      env: process.env,
    });
    cp.on('exit', () => resolve());
    cp.on('error', () => resolve());
  });
}

async function launchCamoufox(): Promise<Browser> {
  await ensureCamoufoxBinary();
  const mod: any = await import('camoufox-js');
  const { firefox } = await import('playwright');
  const opts: any = await mod.launchOptions({});
  if (CUSTOM_CAMOUFOX_BINARY) {
    opts.executablePath = CUSTOM_CAMOUFOX_BINARY;
    console.error(`[carsales-mcp] Using custom Camoufox binary: ${CUSTOM_CAMOUFOX_BINARY}`);
  }
  return firefox.launch({ ...opts, headless: false });
}

// Ordered fallback chain. Both are anti-detect Firefox forks. Camoufox is the
// default (stable, C++-patched). The jo-inc build ('joinc') is the hardest to
// fingerprint but least stable, so it is tried last as an explicit opt-in. There
// is deliberately no Chromium fallback: a real, headed, anti-detect Firefox is the
// only path consistent with this tool's stealth purpose.
function engineOrder(): Engine[] {
  if (ENGINE === 'joinc') return ['joinc', 'camoufox'];
  return ['camoufox', 'joinc'];
}

async function getBrowser(): Promise<Browser> {
  // A crashed / disconnected browser must be relaunched, never reused. Without
  // this check, the singleton caches a dead browser and every later call fails,
  // which surfaced as a harmless-looking "session stuck in a loop".
  if (browser && browser.isConnected()) return browser;
  if (browser) {
    console.error('[carsales-mcp] Browser disconnected; relaunching.');
    sharedContext = null;
    sharedPage = null;
    await browser.close().catch(() => {});
    browser = null;
  }
  for (const step of engineOrder()) {
    try {
      browser = await launchCamoufox();
      activeEngine = step;
      console.error(`[carsales-mcp] Using Camoufox engine (${step}).`);
      return browser;
    } catch (e) {
      console.error(
        `[carsales-mcp] Engine "${step}" failed:`,
        (e as Error).message.split('\n')[0],
      );
    }
  }
  throw new Error('All browser engines failed to launch');
}

function baseContextOptions(): any {
  // IMPORTANT: the UA must match the engine. Camoufox and joinc are both
  // Firefox-based, so a Chrome UA on Firefox is a classic fingerprint mismatch
  // that trips anti-bot. Chromium was removed, so there is never a Chrome UA.
  const firefoxUA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';
  return {
    userAgent: firefoxUA,
    locale: 'en-AU',
    timezoneId: 'Australia/Sydney',
    viewport: null,
  };
}

async function newContext(): Promise<BrowserContext> {
  const b = await getBrowser();
  const ctx = await b.newContext({ ...baseContextOptions(), proxy: pickProxy() });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const cookies = await loadCookies();
  if (cookies.length) {
    try {
      await ctx.addCookies(cookies);
    } catch {
      // ignore cookies that don't match the context's domain
    }
  }
  return ctx;
}

let ephemeralPage: Page | null = null;

async function newPageWithProxy(): Promise<Page> {
  // Rotating proxies must not leak a context on every request: close the previous
  // disposable page before minting a fresh one, so memory stays bounded even over
  // a long session (previously each getPage() leaked a full browser context).
  if (ephemeralPage) {
    try {
      await ephemeralPage.context().close();
    } catch {
      // already closed
    }
    ephemeralPage = null;
  }
  const page = await (await newContext()).newPage();
  ephemeralPage = page;
  return page;
}

export async function getPage(): Promise<Page> {
  if (PROXY_LIST.length > 1) {
    // Rotate proxy per request.
    return newPageWithProxy();
  }
  // Transparently recover from a browser / context / page that died mid-run
  // (Camoufox can drop the page after many navigations). The old code reused the
  // dead shared page, so every subsequent call errored with "Target page, context
  // or browser has been closed" and the client retried in a loop. Rebuild on
  // demand instead of returning a corpse.
  if (browser && !browser.isConnected()) {
    console.error('[carsales-mcp] Shared browser died; resetting.');
    browser = null;
    sharedContext = null;
    sharedPage = null;
  }
  try {
    if (!sharedContext) sharedContext = await newContext();
    if (!sharedPage || sharedPage.isClosed()) sharedPage = await sharedContext.newPage();
    return sharedPage;
  } catch (e) {
    console.error(
      '[carsales-mcp] Recovering from unusable page/context:',
      (e as Error).message.split('\n')[0],
    );
    try {
      await sharedContext?.close().catch(() => {});
    } catch {
      // already closed
    }
    sharedContext = null;
    sharedPage = null;
    if (browser && !browser.isConnected()) {
      browser = null;
    }
    sharedContext = await newContext();
    sharedPage = await sharedContext.newPage();
    return sharedPage;
  }
}

async function loadCookies(): Promise<any[]> {
  try {
    const data = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function saveCookiesToFile(context: BrowserContext): Promise<void> {
  try {
    const cookies = await context.cookies();
    fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true });
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
    fs.chmodSync(COOKIE_FILE, 0o600); // cookies are sensitive, restrict access
  } catch {
    // best-effort persistence
  }
}

/** Save the current session's cookies to disk (call after a successful login). */
export async function saveSession(): Promise<boolean> {
  if (!sharedContext) return false;
  await saveCookiesToFile(sharedContext);
  return true;
}

/** Import cookies (e.g. exported from your own logged-in browser) for reuse. */
export async function setAuthCookies(cookies: any[]): Promise<void> {
  if (!Array.isArray(cookies)) throw new Error('cookies must be an array');
  fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true });
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
  fs.chmodSync(COOKIE_FILE, 0o600); // cookies are sensitive, restrict access
}

export function authCookieFile(): string {
  return COOKIE_FILE;
}

/** True when a page is a DataDome / bot-protection challenge, not real content. */
export function isBlocked(html: string): boolean {
  return html.length < 6000 || html.toLowerCase().includes('captcha-delivery') || /geo\.captcha/i.test(html);
}

/**
 * Thrown when carsales serves a bot-protection challenge instead of results. We
 * surface this distinctly so the client can report "blocked, retry or use a
 * proxy" rather than silently returning zero listings (which previously made the
 * AI conclude there were no cars and loop).
 */
export class DataDomeBlockedError extends Error {
  constructor(message = 'carsales.com.au served a DataDome bot-protection challenge for this request.') {
    super(message);
    this.name = 'DataDomeBlockedError';
  }
}

/**
 * Best-effort FOSS CAPTCHA handling. Only does something when CARS_CAPTCHA_SOLVER=buster
 * (the Buster extension is loaded). It detects a standard hCaptcha/reCAPTCHA widget and
 * waits for Buster to clear it (polls up to 60s). Returns true if the challenge appears gone.
 * Note: this will NOT solve DataDome-style behavioural challenges.
 */
export async function solveCaptchaIfPresent(page: Page): Promise<boolean> {
  if (CAPTCHA_SOLVER !== 'buster') return false;
  const frameSel = 'iframe[src*="hcaptcha"], iframe[src*="recaptcha"], iframe[title*="captcha" i]';
  try {
    if ((await page.locator(frameSel).count()) === 0) return false;
    console.error('[carsales-mcp] CAPTCHA widget detected, Buster attempting to solve...');
    await page
      .waitForFunction(
        (sel: string) => {
          const f = document.querySelector(sel) as HTMLElement | null;
          return !f || f.offsetParent === null;
        },
        frameSel,
        { timeout: 60000 },
      )
      .catch(() => {});
    return (await page.locator(frameSel).count()) === 0;
  } catch {
    return false;
  }
}

async function navigate(_page: Page, url: string): Promise<string> {
  let lastHtml = '';
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const elapsed = Date.now() - lastNav;
    // Jittered, human-ish gap between navigations instead of a fixed interval.
    let gap = HUMANIZE ? rand(MIN_DELAY, MIN_DELAY + 2600) : MIN_DELAY;
    // Right after a DataDome challenge, stay quiet for a while so we don't retry
    // in a burst (a burst is a strong behavioural bot signal and extends the ban).
    const sinceBlock = Date.now() - lastBlockAt;
    if (lastBlockAt && sinceBlock < BLOCK_COOLDOWN_MS) {
      gap = Math.max(gap, BLOCK_COOLDOWN_MS - sinceBlock);
    }
    if (elapsed < gap) await sleep(gap - elapsed);
    lastNav = Date.now();

    // Re-acquire a live page on every attempt. If the previous page/context/browser
    // died mid-run, getPage() transparently relaunches it, instead of reusing the
    // corpse (which previously surfaced as an endless "browser has been closed"
    // retry loop after ~16 navigations).
    let page: Page;
    try {
      page = await getPage();
    } catch {
      break; // could not obtain any browser page
    }

    let got = false;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2500);
      await humanizePage(page, !/\/cars\/details\//.test(url));
      lastHtml = await page.content();
      got = true;
    } catch {
      // Page/context/browser closed mid-navigation: drop it so getPage() rebuilds.
      sharedPage = null;
      lastHtml = '';
    }
    if (got && !isBlocked(lastHtml)) {
      // Persist the session's cookies (incl. the DataDome clearance cookie) as
      // soon as we earn them, so later requests within this browser session reuse
      // the clearance instead of being re-challenged. Best-effort.
      lastBlockAt = 0; // a real page loaded; clear the cooldown
      try {
        await saveCookiesToFile(page.context());
      } catch {
        // never let background cookie persistence break a navigation
      }
      return lastHtml;
    }
    if (got) lastBlockAt = Date.now();
    // Blocked: try the FOSS CAPTCHA solver, then re-navigate to fetch the real page.
    if (CAPTCHA_SOLVER === 'buster' && got) {
      const solved = await solveCaptchaIfPresent(page);
      if (solved) {
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch {
          sharedPage = null;
        }
        await page.waitForTimeout(2500);
        await humanizePage(page, !/\/cars\/details\//.test(url));
        lastHtml = await page.content();
        if (!isBlocked(lastHtml)) return lastHtml;
      }
    }
    // Blocked: wait and (if rotating) get a fresh proxied page for next attempt.
    if (attempt < MAX_RETRIES - 1) {
      await sleep(BACKOFF * (attempt + 1));
      if (PROXY_LIST.length > 1) {
        const np = await newPageWithProxy();
        try {
          await page.context().close();
        } catch {}
        page = np;
      }
    }
  }
  return lastHtml;
}

// Match any link to a carsales listing detail page. The detail URL uses a stable
// slug pattern (`<4-digit-year>-<make>-<model>/<CODE>-AD-<digits>/`) so we don't
// depend on the anchor's inner text (which varies / can be localized) to detect
// listings. This is the most common reason the scraper returned 0 results.
const DETAIL_RE = /href="(\/cars\/details\/[^"]+)"/g;

export interface ListingCard {
  id: string;
  url: string;
  title: string;
  source: string;
  year: number | null;
  price: number | null;
  priceExGovt: number | null;
  odometer: number | null;
  transmission: string | null;
  fuelType: string | null;
  bodyType: string | null;
  engine: string | null;
  seller: string | null;
  location: string | null;
  state: string | null;
  priceBadge: string | null;
  image: string | null;
  /** All photo URLs for the listing (the search page's JSON-LD exposes an image
   * array, not just the first thumbnail). Lets us return a real photo gallery
   * even when the full detail page is bot-blocked. */
  images?: string[];
}

export function num(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.replace(/[^0-9]/g, '');
  return m ? Number(m) : null;
}

// carsales embeds a JSON-LD `OfferCatalog` on the search results page with
// reliable structured data per listing (price, odometer, body type, image, url).
// We use that as the primary source and fall back to HTML scanning for fields it
// omits (badge, transmission, fuel, seller).
function extractJsonLdItems(html: string): any[] {
  const m = html.match(
    /<script data-testid="applicationld-script" type="application\/ld\+json">([\s\S]*?)<\/script>/,
  );
  if (!m) return [];
  try {
    const data = JSON.parse(m[1]);
    const graph = Array.isArray(data['@graph']) ? data['@graph'] : [data];
    for (const g of graph) {
      if (
        g &&
        g['@type'] === 'SearchResultsPage' &&
        g.mainEntity &&
        Array.isArray(g.mainEntity.itemListElement)
      ) {
        return g.mainEntity.itemListElement.map((e: any) => e.item).filter(Boolean);
      }
    }
    return graph.filter((g: any) => g && g['@type'] === 'Vehicle');
  } catch {
    return [];
  }
}

function idFromUrl(u: string): string | null {
  const m = u.match(/([A-Z]{3,4}-AD-\d+)/);
  return m ? m[1] : null;
}

function cardFromJsonLd(item: any): Partial<ListingCard> {
  const url = item.url || '';
  const name: string = item.name || '';
  const yearM = name.match(/^(\d{4})/);
  const mileage = item.mileageFromOdometer?.value;
  // The JSON-LD `image` is usually an array of ImageObject (or strings): the full
  // photo gallery, not just the first thumbnail.
  const images: string[] = [];
  const iv: any = item.image;
  if (Array.isArray(iv)) {
    for (const i of iv) {
      const u = typeof i === 'string' ? i : i?.url;
      if (u) images.push(u);
    }
  } else if (typeof iv === 'string') images.push(iv);
  else if (iv?.url) images.push(iv.url);
  return {
    id: idFromUrl(url) || '',
    url: url.startsWith('http') ? url : 'https://www.carsales.com.au' + url,
    title: name,
    year: yearM ? Number(yearM[1]) : null,
    price: item.offers?.price != null ? Number(item.offers.price) : null,
    odometer: mileage != null ? Number(mileage) : null,
    bodyType: item.bodyType || null,
    image: images[0] ?? null,
    images: images.slice(0, 10),
  };
}

// HTML enrichment for fields the search JSON-LD does not include. Scans plain
// text (tags stripped) so we don't match CSS-module class names.
function parseCardSegment(seg: string): Partial<ListingCard> {
  const out: Partial<ListingCard> = {};
  const text = seg.replace(/<[^>]+>/g, ' ');
  const main = seg.match(/\$([\d,]{4,})/);
  if (main) out.price = num(main[1]);
  const excl = seg.match(/\$([\d,]{4,})\s*(?:excl?\.?|ex[- ]?gov)/i);
  if (excl) out.priceExGovt = num(excl[1]);
  const km = text.match(/([\d,]{2,})\s*km\b/i);
  if (km) out.odometer = num(km[1]);
    const badge = text.match(/\b(FAIR|GOOD|GREAT|BAD) PRICE\b/i);
  if (badge) out.priceBadge = badge[0].toUpperCase();
  const trans = text.match(/\b(automatic|manual|cvt|sequential|dct|dual clutch)\b/i);
  if (trans) out.transmission = trans[0];
  const fuel = text.match(/\b(petrol|diesel|hybrid|electric|plug-in hybrid|lpg)\b/i);
  if (fuel) out.fuelType = fuel[0];
  const body = text.match(/\b(sedan|wagon|suv|hatch|hatchback|ute|coupe|van|convertible)\b/i);
  if (body) out.bodyType = body[0];
  const sell = seg.match(/data-testid="seller-section"[^>]*>\s*<span[^>]*>([^<]+)</);
  if (sell) {
    const t = sell[1].trim();
    out.seller = t;
    const st = t.match(/\b(NSW|VIC|QLD|SA|TAS|WA|ACT|NT)\b/);
    out.state = st ? st[1] : null;
  }
  const img = seg.match(/<img[^>]+src="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
  if (img) out.image = img[1];
  return out;
}

export function parseListings(html: string): ListingCard[] {
  const ldItems = extractJsonLdItems(html);
  const ldById = new Map<string, any>();
  for (const it of ldItems) {
    const id = idFromUrl(it.url || '');
    if (id) ldById.set(id, it);
  }
  const cards: ListingCard[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  DETAIL_RE.lastIndex = 0;
  while ((m = DETAIL_RE.exec(html))) {
    const href = decodeEntities(m[1]);
    const ids = href.match(/\/cars\/details\/([^/]+)\/([^/]+)\//);
    if (!ids) continue;
    const slug = ids[1];
    const id = ids[2];
    if (seen.has(id)) continue; // same listing linked from multiple anchors on a card
    seen.add(id);
    // Bound the scan to this card. A card contains several /cars/details/ links
    // (outer link + inner image links), all sharing the SAME id, so we can't just
    // stop at the next such link. Instead stop at the next *different* listing id
    // (the start of the following card), capped at 20KB.
    let scan = m.index + m[0].length;
    let nextCard = -1;
    const ID_SCAN = /([A-Z]{3,4}-AD-\d+)/g;
    ID_SCAN.lastIndex = scan;
    let sm: RegExpExecArray | null;
    while ((sm = ID_SCAN.exec(html))) {
      if (sm[1] !== id) {
        nextCard = sm.index;
        break;
      }
    }
    const end = nextCard === -1 ? m.index + 20000 : Math.min(nextCard, m.index + 20000);
    const seg = html.slice(m.index, end);
    const htmlMeta = parseCardSegment(seg);
    const ld = ldById.get(id);
    const base = ld ? cardFromJsonLd(ld) : ({} as Partial<ListingCard>);
    const yearMatch = slug.match(/^(\d{4})/);
    const title =
      (base.title as string) || slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    cards.push({
      id,
      url: base.url || 'https://www.carsales.com.au' + href,
      title,
      source: 'carsales',
      year: base.year ?? (yearMatch ? Number(yearMatch[1]) : null),
      price: base.price ?? htmlMeta.price ?? null,
      priceExGovt: base.priceExGovt ?? htmlMeta.priceExGovt ?? null,
      odometer: base.odometer ?? htmlMeta.odometer ?? null,
      transmission: htmlMeta.transmission ?? null,
      fuelType: htmlMeta.fuelType ?? null,
      bodyType: base.bodyType ?? htmlMeta.bodyType ?? null,
      engine: htmlMeta.engine ?? null,
      seller: htmlMeta.seller ?? null,
      location: htmlMeta.location ?? null,
      state: htmlMeta.state ?? null,
      priceBadge: htmlMeta.priceBadge ?? null,
      image: base.image ?? htmlMeta.image ?? null,
    });
  }
  return cards;
}

export async function fetchSearchHtml(url: string, _page: Page): Promise<string> {
  const html = await navigate(_page, url);
  if (!isBlocked(html)) {
    try {
      // Re-acquire the live page (navigate may have rebuilt it after a crash).
      const page = await getPage();
      await page.waitForSelector('a[aria-label="View details"]', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1500);
      return page.content();
    } catch {
      return html;
    }
  }
  return html;
}

export async function fetchHtml(url: string, page: Page): Promise<string> {
  // carsales detail pages are guarded by DataDome, which 403s a direct navigation
  // but allows the page when reached by clicking through from the results page
  // (a real user flow). So for detail URLs we try the direct nav first and, if it
  // is challenged, re-acquire the listing by clicking it out of a live search.
  if (/carsales\.com\.au\/cars\/details\//.test(url)) {
    const direct = await navigate(page, url);
    if (!isBlocked(direct)) return direct;
    const viaClick = await clickThroughDetail(page, url);
    if (viaClick && !isBlocked(viaClick)) return viaClick;
    return direct;
  }
  return navigate(page, url);
}

// DataDome lets listing detail pages through when they are reached by a real
// click from the results grid. This fetches the results that contain the listing
// and clicks its anchor, returning the fully loaded detail HTML. Returns '' if
// the listing can't be located.
async function clickThroughDetail(page: Page, url: string): Promise<string> {
  const m = url.match(/\/cars\/details\/([^/]+)\/([A-Z]{3,4}-AD-\d+)\//);
  if (!m) return '';
  const slug = m[1];
  const id = m[2];
  const parts = slug.split('-');
  const yearIdx = /^\d{4}$/.test(parts[0]) ? 0 : -1;
  const make = parts[yearIdx + 1] || '';
  const model = parts[yearIdx + 2] || '';
  if (!make) return '';
  const base = `https://www.carsales.com.au/cars/used/${make}${model ? '/' + model : ''}/?sort=Odometer`;
  for (let p = 1; p <= 8; p++) {
    const searchUrl = p > 1 ? `${base}&page=${p}` : base;
    const html = await navigate(page, searchUrl);
    if (isBlocked(html)) continue;
    try {
      const anchor = page.locator(`a[href*="${id}"]`).first();
      if (await anchor.count()) {
        // Human-like: scroll the listing into view, pause, then click.
        await anchor.scrollIntoViewIfNeeded().catch(() => {});
        await humanPause(700, 1800);
        await anchor.click({ timeout: 15000 }).catch(async () => {
          await anchor.click({ timeout: 15000, force: true }).catch(() => {});
        });
        await humanPause(2500, 5500);
        return page.content();
      }
    } catch {
      // try the next results page
    }
  }
  return '';
}

/**
 * Generic listing scraper for non-carsales URLs (Facebook Marketplace / Gumtree).
 * Best-effort: pulls title, price, description and image URLs from OpenGraph +
 * img tags so `get_listing_details` / `compare_listings` work for all three sites
 * (and return multiple photos). No structured JSON-LD is assumed.
 */
export async function describeGenericListing(
  url: string,
  page: Page,
): Promise<{
  title: string | null;
  price: number | null;
  description: string | null;
  imageUrls: string[];
  text: string;
  blocked: boolean;
}> {
  const html = await navigate(page, url);
  const blocked = html.length < 4000 || /captcha-delivery/i.test(html.toLowerCase());
  const ogTitle = html.match(/<meta property="og:title" content="([^"]+)"/i);
  const titleTag = html.match(/<title>([^<]+)<\/title>/i);
  const title = ogTitle
    ? decodeEntities(ogTitle[1]).trim()
    : titleTag
      ? decodeEntities(titleTag[1]).replace(/\s*\|?\s*(Gumtree|Facebook).*$/i, '').trim()
      : null;
  const descM =
    html.match(/<meta name="description" content="([^"]+)"/i) ||
    html.match(/<meta property="og:description" content="([^"]+)"/i);
  const description = descM ? decodeEntities(descM[1]).trim() : null;
  const priceM = html.match(/\$([\d,]{3,})/);
  const price = priceM ? Number(priceM[1].replace(/[^0-9]/g, '')) : null;
  const imgs: string[] = [];
  for (const m of html.matchAll(/<meta property="og:image" content="([^"]+)"/gi)) imgs.push(m[1]);
  for (const m of html.matchAll(/<img[^>]+src="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi)) imgs.push(m[1]);
  const imageUrls = [...new Set(imgs)].slice(0, 12);
  const text = [title, price != null ? `Price: $${price.toLocaleString()}` : null, description]
    .filter(Boolean)
    .join('\n');
  return { title, price, description, imageUrls, text, blocked };
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    sharedContext = null;
    sharedPage = null;
  }
}

/**
 * Download listing images through the browser's network context (so proxy/DNS
 * settings apply) and return MCP image content blocks with base64 data, so a
 * multimodal model can actually *see* the photos.
 */
export async function downloadImages(
  page: Page,
  urls: string[],
  max: number,
): Promise<Array<{ type: 'image'; data: string; mimeType: string }>> {
  const blocks: Array<{ type: 'image'; data: string; mimeType: string }> = [];
  for (const u of urls.slice(0, max)) {
    try {
      const resp = await page.request.get(u, { timeout: 15000 });
      if (!resp.ok()) continue;
      const buf = Buffer.from(await resp.body());
      if (!buf.length) continue;
      const ct = (resp.headers()['content-type'] || 'image/jpeg').split(';')[0];
      blocks.push({ type: 'image', data: buf.toString('base64'), mimeType: ct });
    } catch {
      // skip undownloadable image
    }
  }
  return blocks;
}
