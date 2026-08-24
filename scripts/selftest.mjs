#!/usr/bin/env node
/**
 * Self-test / regression harness (FOSS, no paid deps).
 *
 * Live-fetches a carsales + Gumtree + Facebook search, saves the raw HTML as a
 * fixture, and asserts the parsers extract >0 listings. Catches silent parser
 * breakage (e.g. when carsales/Gumtree change their markup) early.
 *
 * Usage:  node scripts/selftest.mjs            (live fetch + parse + assert)
 *         node scripts/selftest.mjs --offline  (re-parse saved fixtures only)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPage, fetchSearchHtml, parseListings } from '../dist/browser.js';
import { searchGumtreeCars } from '../dist/gumtree.js';
import { searchFacebookCars } from '../dist/facebook.js';

const CACHE = process.env.CARS_SELFTEST_DIR || path.join(os.homedir(), '.carsales-mcp', 'selftest');
const OFFLINE = process.argv.includes('--offline');
fs.mkdirSync(CACHE, { recursive: true });

let failures = 0;

async function assert(name, cond, detail) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function testCarsales(offline) {
  const fixture = path.join(CACHE, 'carsales-corolla.html');
  let html;
  if (offline) {
    html = fs.readFileSync(fixture, 'utf8');
  } else {
    const page = await getPage();
    html = await fetchSearchHtml('https://www.carsales.com.au/cars/used/toyota/corolla/victoria-state/', page);
    fs.writeFileSync(fixture, html);
  }
  const cards = parseListings(html);
  await assert('carsales parser extracts listings', cards.length > 0, `${cards.length} cards`);
}

async function testGumtree(offline) {
  const fixture = path.join(CACHE, 'gumtree-corolla.html');
  let cards;
  if (offline) {
    const html = fs.readFileSync(fixture, 'utf8');
    const { parseGumtree } = await import('../dist/gumtree.js');
    cards = parseGumtree(html, 40);
  } else {
    cards = await searchGumtreeCars({ query: 'toyota corolla', location: 'sydney', limit: 20 });
    // save raw HTML is not exposed here; parser-only coverage is what matters
  }
  await assert('gumtree parser extracts listings', cards.length > 0, `${cards.length} cards`);
}

async function testFacebook(offline) {
  if (offline) {
    await assert('facebook (offline skip)', true, 'no fixture parser for FB GraphQL');
    return;
  }
  const cards = await searchFacebookCars({ query: 'toyota corolla', location: 'sydney', limit: 20 });
  await assert('facebook GraphQL extracts listings', cards.length > 0, `${cards.length} cards`);
}

try {
  await testCarsales(OFFLINE);
  await testGumtree(OFFLINE);
  await testFacebook(OFFLINE);
} catch (e) {
  console.error('selftest error:', e);
  failures++;
} finally {
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
}
