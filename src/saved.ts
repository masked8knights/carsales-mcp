/**
 * Local "my saved cars" store - 100% FOSS, no paid service, survives restarts.
 *
 * Any listing (from carsales, Gumtree or Facebook) can be saved locally, and we
 * then track it: when check_saved runs it re-reads each saved listing's current
 * price/status and reports *changes* - a price drop, or that it looks SOLD (the
 * listing no longer resolves / is withdrawn). This is reliable and independent of
 * any site's public API, because it uses the same headed-browser fetch the rest of
 * the server uses.
 *
 * State lives in CARS_SAVED_FILE (default ~/.carsales-mcp/saved.json).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type SaveSource = 'carsales' | 'gumtree' | 'facebook';

export interface SavedListing {
  /** Unique key: `<source>:<id>` */
  key: string;
  source: SaveSource;
  id: string;
  url: string;
  title: string | null;
  price: number | null;
  priceExGovt: number | null;
  note?: string;
  savedAt: number;
  /** Last price we observed on a prior check (for drop detection). */
  lastPrice: number | null;
  /** True once a check found the listing withdrawn/no longer resolvable. */
  sold: boolean;
  lastCheckedAt?: number | null;
}

const FILE = process.env.CARS_SAVED_FILE || path.join(os.homedir(), '.carsales-mcp', 'saved.json');

function load(): SavedListing[] {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function save(list: SavedListing[]): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
  try {
    fs.chmodSync(FILE, 0o600);
  } catch {
    // ignore
  }
}

export function savedFile(): string {
  return FILE;
}

/** Save a listing locally. If it already exists, updates the optional note. */
export function saveListing(input: {
  source: SaveSource;
  id: string;
  url: string;
  title?: string | null;
  price?: number | null;
  priceExGovt?: number | null;
  note?: string;
}): SavedListing {
  const list = load();
  const key = `${input.source}:${input.id}`;
  let entry = list.find((x) => x.key === key);
  if (!entry) {
    entry = {
      key,
      source: input.source,
      id: input.id,
      url: input.url,
      title: input.title ?? null,
      price: input.price ?? null,
      priceExGovt: input.priceExGovt ?? null,
      note: input.note,
      savedAt: Date.now(),
      lastPrice: input.price ?? null,
      sold: false,
      lastCheckedAt: null,
    };
    list.push(entry);
  } else {
    entry.url = input.url || entry.url;
    entry.title = input.title != null ? input.title : entry.title;
    entry.price = input.price ?? entry.price;
    entry.priceExGovt = input.priceExGovt ?? entry.priceExGovt;
    if (input.note != null) entry.note = input.note;
  }
  save(list);
  return entry;
}

export function listSaved(): SavedListing[] {
  return load();
}

export function getSaved(key: string): SavedListing | null {
  return load().find((x) => x.key === key) ?? null;
}

export function setSavedNote(key: string, note: string): boolean {
  const list = load();
  const entry = list.find((x) => x.key === key);
  if (!entry) return false;
  entry.note = note;
  save(list);
  return true;
}

export function removeSaved(key: string): boolean {
  const list = load();
  const next = list.filter((x) => x.key !== key);
  if (next.length === list.length) return false;
  save(next);
  return true;
}

/** Optional free push alert (no paid service). Posts to a webhook (ntfy/Discord/Slack). */
async function postAlert(payload: Record<string, unknown>): Promise<void> {
  const webhook = process.env.CARS_WATCH_WEBHOOK;
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // best-effort alert; never break a check on a failed webhook
  }
}

/**
 * Apply the current observation of a saved listing and report what changed.
 * Returns a human-readable change summary, or null if nothing changed. On a
 * price drop or sold event it also fires a free webhook alert (CARS_WATCH_WEBHOOK).
 */
export function applyCheck(key: string, current: { price?: number | null; sold?: boolean }): string | null {
  const list = load();
  const entry = list.find((x) => x.key === key);
  if (!entry) return null;
  const changes: string[] = [];
  const now = Date.now();

  if (current.sold === true && !entry.sold) {
    entry.sold = true;
    changes.push('SOLD or withdrawn - the listing no longer resolves.');
  }

  const prevPrice = entry.lastPrice;
  const price = current.price ?? null;
  if (price != null && prevPrice != null && price < prevPrice) {
    const drop = prevPrice - price;
    changes.push(`PRICE DROP: $${prevPrice.toLocaleString()} -> $${price.toLocaleString()} (-$${drop.toLocaleString()}).`);
  }
  if (price != null) entry.lastPrice = price;
  if (current.sold === true) entry.sold = true;

  entry.lastCheckedAt = now;
  save(list);
  if (changes.length) {
    void postAlert({ saved: key, title: entry.title, url: entry.url, changes });
  }
  return changes.length ? changes.join('\n') : null;
}
