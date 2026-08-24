import { chromium, Browser, BrowserContext, Page } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export type { Page };
export type { Browser, BrowserContext };

// Engine selection. The default is the Camoufox browser built by jo-inc
// (https://github.com/jo-inc/camofox-browser) — the hardest-to-fingerprint
// option. If it fails to launch we fall back to the camoufox-js packaged
// stable build, and finally to a hardened Chromium. Set CARS_ENGINE to pin a
// tier: 'joinc' (default) | 'camoufox' | 'chromium'.
type Engine = 'joinc' | 'camoufox' | 'chromium';
const ENGINE_RAW = (process.env.CARS_ENGINE || 'joinc').toLowerCase();
const ENGINE: Engine =
  ENGINE_RAW === 'chromium' ? 'chromium' : ENGINE_RAW === 'camoufox' ? 'camoufox' : 'joinc';

// Optional: point Camoufox at a specific browser binary (e.g. a build you
// fetched yourself from github.com/jo-inc/camofox-browser releases).
const CUSTOM_CAMOUFOX_BINARY = process.env.CARS_CAMOUFOX_BINARY || '';

function isFirefox(): boolean {
  return ENGINE !== 'chromium';
}

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

// Optional FOSS CAPTCHA help. The only free, open-source solver we wire in is
// Buster (https://github.com/dessant/buster, MIT) — it solves hCaptcha/reCAPTCHA
// *audio* challenges locally via the browser's Web Speech API (no paid service).
// It loads as a Chromium extension, so it only applies when ENGINE=chromium and
// the user points CARS_BUSTER_EXTENSION at their installed copy. It does NOT
// defeat behavioural bot-protection like DataDome (carsales' own stack) — that
// relies on avoidance (residential IP + Camoufox + proxy). Default: off.
const CAPTCHA_SOLVER = (process.env.CARS_CAPTCHA_SOLVER || 'none').toLowerCase();
const BUSTER_EXT = process.env.CARS_BUSTER_EXTENSION || '';

// Authenticated sessions: cookies are persisted to this file so a user can log
// in once (via set_auth / a real browser) and have the session reused across
// runs and tool calls. Carsales unlocks extra actions (saving a vehicle, making
// an offer/contacting the seller) for logged-in users.
const COOKIE_FILE =
  process.env.CARS_COOKIE_FILE || path.join(os.homedir(), '.carsales-mcp', 'cookies.json');

let lastNav = 0;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function pickProxy(): { server: string; bypass: string } | undefined {
  if (!PROXY_LIST.length) return undefined;
  const server = PROXY_LIST[Math.floor(Math.random() * PROXY_LIST.length)];
  return { server, bypass: '<-loopback>' };
}

function camoufoxCacheDir(): string {
  return process.env.CAMOUFOX_INSTALL_DIR || path.join(os.homedir(), '.cache', 'camoufox');
}

async function ensureCamoufoxBinary(_latest = false): Promise<void> {
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

async function launchCamoufox(latest: boolean): Promise<Browser> {
  await ensureCamoufoxBinary(latest);
  const mod: any = await import('camoufox-js');
  const { firefox } = await import('playwright');
  const opts: any = await mod.launchOptions({});
  if (CUSTOM_CAMOUFOX_BINARY) {
    opts.executablePath = CUSTOM_CAMOUFOX_BINARY;
    console.error(`[carsales-mcp] Using custom Camoufox binary: ${CUSTOM_CAMOUFOX_BINARY}`);
  }
  return firefox.launch({ ...opts, headless: true });
}

async function launchChromium(): Promise<Browser> {
  const args = [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ];
  if (CAPTCHA_SOLVER === 'buster' && BUSTER_EXT) {
    args.push(`--load-extension=${BUSTER_EXT}`, `--disable-extensions-except=${BUSTER_EXT}`);
    console.error('[carsales-mcp] CAPTCHA solver: Buster extension loaded (audio challenges).');
  }
  return chromium.launch({ channel: 'chromium', args });
}

// Ordered fallback chain. Default (joinc) tries the jo-inc Camoufox build first,
// then the camoufox-js stable build, then hardened Chromium. Other ENGINE values
// shorten the chain but always end in the Chromium fallback.
function engineOrder(): Engine[] {
  if (ENGINE === 'chromium') return ['chromium'];
  if (ENGINE === 'camoufox') return ['camoufox', 'chromium'];
  return ['joinc', 'camoufox', 'chromium'];
}

async function getBrowser(): Promise<Browser> {
  if (browser) return browser;
  for (const step of engineOrder()) {
    try {
      if (step === 'chromium') {
        browser = await launchChromium();
        console.error('[carsales-mcp] Using hardened Chromium engine.');
        return browser;
      }
      const latest = step === 'joinc';
      browser = await launchCamoufox(latest);
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
  // IMPORTANT: the UA must match the engine. Camoufox is Firefox-based, so a
  // Chrome UA on Firefox is a classic fingerprint mismatch that trips anti-bot.
  const firefoxUA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';
  const chromeUA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
  const opts: any = {
    userAgent: isFirefox() ? firefoxUA : chromeUA,
    locale: 'en-AU',
    timezoneId: 'Australia/Sydney',
  };
  // Firefox (Camoufox) does not support setDefaultViewport; disable it.
  if (!isFirefox()) opts.viewport = { width: 1366, height: 900 };
  else opts.viewport = null;
  return opts;
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

async function newPageWithProxy(): Promise<Page> {
  return (await newContext()).newPage();
}

export async function getPage(): Promise<Page> {
  if (PROXY_LIST.length > 1) {
    // Rotate proxy per request.
    return newPageWithProxy();
  }
  if (!sharedContext) {
    sharedContext = await newContext();
  }
  if (!sharedPage || sharedPage.isClosed()) {
    sharedPage = await sharedContext.newPage();
  }
  return sharedPage;
}

export async function currentContext(): Promise<BrowserContext | null> {
  return sharedContext;
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
    fs.chmodSync(COOKIE_FILE, 0o600); // cookies are sensitive — restrict access
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
  fs.chmodSync(COOKIE_FILE, 0o600); // cookies are sensitive — restrict access
}

export function authCookieFile(): string {
  return COOKIE_FILE;
}

function isBlocked(html: string): boolean {
  return html.length < 6000 || html.toLowerCase().includes('captcha-delivery');
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
    console.error('[carsales-mcp] CAPTCHA widget detected — Buster attempting to solve...');
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

async function navigate(page: Page, url: string): Promise<string> {
  let lastHtml = '';
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const elapsed = Date.now() - lastNav;
    if (elapsed < MIN_DELAY) await sleep(MIN_DELAY - elapsed);
    lastNav = Date.now();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch {
      // navigation may throw on challenge; still inspect content
    }
    await page.waitForTimeout(2500);
    lastHtml = await page.content();
    if (!isBlocked(lastHtml)) return lastHtml;
    // Blocked: try the FOSS CAPTCHA solver, then retry.
    if (CAPTCHA_SOLVER === 'buster') {
      const solved = await solveCaptchaIfPresent(page);
      if (solved) {
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
}

function num(s: string | null): number | null {
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
  const img = Array.isArray(item.image) && item.image[0]?.url
    ? item.image[0].url
    : typeof item.image === 'string'
      ? item.image
      : null;
  return {
    id: idFromUrl(url) || '',
    url: url.startsWith('http') ? url : 'https://www.carsales.com.au' + url,
    title: name,
    year: yearM ? Number(yearM[1]) : null,
    price: item.offers?.price != null ? Number(item.offers.price) : null,
    odometer: mileage != null ? Number(mileage) : null,
    bodyType: item.bodyType || null,
    image: img,
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

export async function fetchSearchHtml(url: string, page: Page): Promise<string> {
  const html = await navigate(page, url);
  if (!isBlocked(html)) {
    try {
      await page.waitForSelector('a[aria-label="View details"]', { timeout: 15000 });
    } catch {}
    await page.waitForTimeout(1500);
    return page.content();
  }
  return html;
}

export async function fetchHtml(url: string, page: Page): Promise<string> {
  return navigate(page, url);
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
