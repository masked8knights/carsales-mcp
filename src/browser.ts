import { chromium, Browser, BrowserContext, Page } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export type { Page };
export type { Browser, BrowserContext };

// Camoufox is the default engine (harder fingerprint than Chromium). Set
// CARS_ENGINE=chromium to force the original behaviour. If Camoufox fails to
// launch (e.g. missing system libs) we transparently fall back to Chromium.
const ENGINE = (process.env.CARS_ENGINE || 'camoufox').toLowerCase() === 'camoufox' ? 'camoufox' : 'chromium';

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

async function getBrowser(): Promise<Browser> {
  if (browser) return browser;
  if (ENGINE === 'camoufox') {
    try {
      await ensureCamoufoxBinary();
      const mod: any = await import('camoufox-js');
      const { firefox } = await import('playwright');
      const opts = await mod.launchOptions({});
      browser = await firefox.launch({ ...opts, headless: true });
      console.error('[carsales-mcp] Using Camoufox engine.');
      return browser;
    } catch (e) {
      console.error(
        '[carsales-mcp] Camoufox launch failed, falling back to Chromium:',
        (e as Error).message.split('\n')[0],
      );
    }
  }
  browser = await chromium.launch({
    channel: 'chromium',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  return browser;
}

function baseContextOptions(): any {
  const opts: any = {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    locale: 'en-AU',
    timezoneId: 'Australia/Sydney',
  };
  // Firefox (Camoufox) does not support setDefaultViewport; disable it.
  if (ENGINE === 'chromium') opts.viewport = { width: 1366, height: 900 };
  else opts.viewport = null;
  return opts;
}

async function newPageWithProxy(): Promise<Page> {
  const b = await getBrowser();
  const ctx = await b.newContext({ ...baseContextOptions(), proxy: pickProxy() });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return ctx.newPage();
}

export async function getPage(): Promise<Page> {
  if (PROXY_LIST.length > 1) {
    // Rotate proxy per request.
    return newPageWithProxy();
  }
  if (!sharedContext) {
    const b = await getBrowser();
    sharedContext = await b.newContext({ ...baseContextOptions(), proxy: pickProxy() });
    await sharedContext.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
  }
  if (!sharedPage || sharedPage.isClosed()) {
    sharedPage = await sharedContext.newPage();
  }
  return sharedPage;
}

function isBlocked(html: string): boolean {
  return html.length < 6000 || html.toLowerCase().includes('captcha-delivery');
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

const DETAIL_RE = /href="(\/cars\/details\/[^"]+)"[^>]*>View details<\/a>/g;

export interface ListingCard {
  id: string;
  url: string;
  title: string;
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

function parseCardSegment(seg: string): Partial<ListingCard> {
  const out: Partial<ListingCard> = {};
  const specs = [...seg.matchAll(/<title>([^<]+)<\/title>/g)]
    .map((m) => m[1].trim())
    .filter(Boolean);
  for (const s of specs) {
    const lower = s.toLowerCase();
    if (/km\b|\skm$/.test(lower) && /\d/.test(s)) out.odometer = num(s);
    else if (lower.includes('auto') || lower.includes('manual') || lower.includes('cvt'))
      out.transmission = s;
    else if (/cyl|hybrid|petrol|diesel|electric|lpg|fuel/i.test(lower)) out.fuelType = s;
    else if (/(sedan|wagon|suv|hatch|ute|coupe|van|convertible|cab|chassis)/.test(lower))
      out.bodyType = s;
    else if (/\d.*(cyl|l\b|cc|electric)/i.test(lower) || lower.includes('engine')) out.engine = s;
  }
  const main = seg.match(/\$([\d,]{2,})/);
  out.price = main ? num(main[1]) : null;
  const excl = seg.match(/\$([\d,]{2,})\s*Excl\./);
  out.priceExGovt = excl ? num(excl[1]) : null;
  const sell = seg.match(/data-testid="seller-section"[^>]*>\s*<span[^>]*>([^<]+)</);
  if (sell) {
    const text = sell[1].trim();
    out.seller = text;
    const st = text.match(/\b(NSW|VIC|QLD|SA|TAS|WA|ACT|NT)\b/);
    out.state = st ? st[1] : null;
  }
  const badge = seg.match(/(FAIR PRICE|GOOD PRICE|GREAT PRICE|BAD PRICE)/);
  if (badge) out.priceBadge = badge[1];
  const img = seg.match(/<img[^>]+src="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i);
  out.image = img ? img[1] : null;
  return out;
}

export function parseListings(html: string): ListingCard[] {
  const cards: ListingCard[] = [];
  let m: RegExpExecArray | null;
  DETAIL_RE.lastIndex = 0;
  while ((m = DETAIL_RE.exec(html))) {
    const href = decodeEntities(m[1]);
    const seg = html.slice(Math.max(0, m.index - 9000), m.index);
    const ids = href.match(/\/cars\/details\/([^/]+)\/([^/]+)\//);
    if (!ids) continue;
    const slug = ids[1];
    const id = ids[2];
    const yearMatch = slug.match(/^(\d{4})/);
    const meta = parseCardSegment(seg);
    const title = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    cards.push({
      id,
      url: 'https://www.carsales.com.au' + href,
      title,
      year: yearMatch ? Number(yearMatch[1]) : null,
      price: meta.price ?? null,
      priceExGovt: meta.priceExGovt ?? null,
      odometer: meta.odometer ?? null,
      transmission: meta.transmission ?? null,
      fuelType: meta.fuelType ?? null,
      bodyType: meta.bodyType ?? null,
      engine: meta.engine ?? null,
      seller: meta.seller ?? null,
      location: meta.location ?? null,
      state: meta.state ?? null,
      priceBadge: meta.priceBadge ?? null,
      image: meta.image ?? null,
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
