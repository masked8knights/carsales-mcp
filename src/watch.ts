/**
 * Saved-search alerts ("watch"). 100% FOSS / no paid service: we periodically
 * re-run a stored search and diff the listing IDs against the last run, reporting
 * what's *new* since you last checked. State lives in a local JSON file.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ListingCard } from './browser.js';
import { searchCars } from './provider.js';
import { searchGumtreeCars } from './gumtree.js';
import { searchFacebookCars } from './facebook.js';
import { SearchParams } from './url.js';

export type WatchSource = 'carsales' | 'gumtree' | 'facebook';

export interface Watch {
  name: string;
  params: SearchParams;
  sources: WatchSource[];
  lastIds: string[];
  createdAt: number;
}

const FILE = process.env.CARS_WATCH_FILE || path.join(os.homedir(), '.carsales-mcp', 'watches.json');

function load(): Watch[] {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function save(watches: Watch[]): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(watches, null, 2));
  try {
    fs.chmodSync(FILE, 0o600);
  } catch {
    // ignore
  }
}

export function addWatch(name: string, params: SearchParams, sources: WatchSource[]): Watch {
  const watches = load();
  const existing = watches.find((w) => w.name === name);
  const watch: Watch = {
    name,
    params,
    sources: sources.length ? sources : ['carsales'],
    lastIds: existing?.lastIds ?? [],
    createdAt: existing?.createdAt ?? Date.now(),
  };
  const idx = watches.findIndex((w) => w.name === name);
  if (idx >= 0) watches[idx] = watch;
  else watches.push(watch);
  save(watches);
  return watch;
}

export function listWatches(): Watch[] {
  return load();
}

export function removeWatch(name: string): boolean {
  const watches = load();
  const next = watches.filter((w) => w.name !== name);
  if (next.length === watches.length) return false;
  save(next);
  return true;
}

export async function runWatch(
  name: string,
): Promise<{ watch: Watch; newCards: ListingCard[]; total: number } | null> {
  const watches = load();
  const watch = watches.find((w) => w.name === name);
  if (!watch) return null;

  const cards: ListingCard[] = [];
  const seen = new Set<string>();
  const collect = (cs: ListingCard[]) => {
    for (const c of cs) {
      const key = c.source + ':' + c.id;
      if (seen.has(key)) continue;
      seen.add(key);
      cards.push(c);
    }
  };

  if (watch.sources.includes('carsales')) {
    try {
      collect(await searchCars({ ...watch.params, limit: 100 }));
    } catch {
      // best-effort
    }
  }
  if (watch.sources.includes('gumtree')) {
    try {
      const q = [watch.params.make, watch.params.model].filter(Boolean).join(' ');
      collect(await searchGumtreeCars({ query: q, minPrice: watch.params.minPrice, maxPrice: watch.params.maxPrice, limit: 40 }));
    } catch {
      // best-effort
    }
  }
  if (watch.sources.includes('facebook')) {
    try {
      const q = [watch.params.make, watch.params.model].filter(Boolean).join(' ');
      collect(
        await searchFacebookCars({
          query: q,
          location: 'sydney',
          minPrice: watch.params.minPrice,
          maxPrice: watch.params.maxPrice,
          limit: 40,
        }),
      );
    } catch {
      // best-effort
    }
  }

  const prev = new Set(watch.lastIds);
  const newCards = cards.filter((c) => !prev.has(c.source + ':' + c.id));
  watch.lastIds = cards.map((c) => c.source + ':' + c.id);
  const idx = watches.findIndex((w) => w.name === name);
  watches[idx] = watch;
  save(watches);
  return { watch, newCards, total: cards.length };
}
