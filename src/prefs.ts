/**
 * Per-user preference learning (100% local, FOSS, no service).
 *
 * The idea: as a buyer browses, they accept or reject cars. When they say "no",
 * the AI can ask why and we store that reason, so future searches are shaped by
 * what the user actually wants (budget, transmission, body, "no rust",
 * "no diesels", an excluded listing, etc.). Everything lives in a local JSON
 * file next to the other state (cookies/watches).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface PrefNote {
  text: string;
  reason?: string;
  createdAt: number;
}
export interface PrefFilters {
  maxPrice?: number | null;
  minPrice?: number | null;
  maxYear?: number | null;
  minYear?: number | null;
  maxOdometer?: number | null;
  transmission?: string | null;
  fuelType?: string | null;
  bodyStyle?: string | null;
  states?: string[];
}
export interface Excluded {
  id: string;
  url: string;
  title?: string;
  reason?: string;
  createdAt: number;
}
export interface Preferences {
  filters: PrefFilters;
  like: PrefNote[];
  avoid: PrefNote[];
  excluded: Excluded[];
  updatedAt: number;
}

const FILE =
  process.env.CARS_PREFS_FILE || path.join(os.homedir(), '.carsales-mcp', 'prefs.json');

const EMPTY: Preferences = { filters: {}, like: [], avoid: [], excluded: [], updatedAt: 0 };

function load(): Preferences {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { ...EMPTY, ...d };
  } catch {
    return { ...EMPTY };
  }
}

function save(p: Preferences): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(p, null, 2));
  try {
    fs.chmodSync(FILE, 0o600);
  } catch {
    // ignore
  }
}

/** Set/update a named filter preference (e.g. maxPrice=4000) with an optional reason. */
export function setFilter(key: keyof PrefFilters, value: unknown, reason?: string): Preferences {
  const p = load();
  (p.filters as any)[key] = value;
  if (reason) p.like.push({ text: `${key}=${value}`, reason, createdAt: Date.now() });
  p.updatedAt = Date.now();
  save(p);
  return p;
}

/** Record a like or an avoidance rule (free text with a reason). */
export function addNote(kind: 'like' | 'avoid', text: string, reason?: string): Preferences {
  const p = load();
  p[kind].push({ text, reason, createdAt: Date.now() });
  p.updatedAt = Date.now();
  save(p);
  return p;
}

/** Record "the user said no to this listing" (with the reason it was rejected). */
export function excludeEntry(id: string, url: string, title?: string, reason?: string): Preferences {
  const p = load();
  if (!p.excluded.some((e) => e.id === id)) {
    p.excluded.push({ id, url, title, reason, createdAt: Date.now() });
    p.updatedAt = Date.now();
    save(p);
  }
  return p;
}

export function getPreferences(): Preferences {
  return load();
}

export function clearPreferences(): Preferences {
  const p = { ...EMPTY };
  p.updatedAt = Date.now();
  save(p);
  return p;
}

export function prefsFile(): string {
  return FILE;
}

/** A single-line human description of the stored preferences, for context. */
export function prefsSummary(): string {
  const p = load();
  const parts: string[] = [];
  const f = p.filters;
  if (f.maxPrice != null) parts.push(`max $${f.maxPrice.toLocaleString()}`);
  if (f.minPrice != null) parts.push(`min $${f.minPrice.toLocaleString()}`);
  if (f.minYear != null) parts.push(`from ${f.minYear}`);
  if (f.maxYear != null) parts.push(`to ${f.maxYear}`);
  if (f.maxOdometer != null) parts.push(`≤ ${f.maxOdometer.toLocaleString()} km`);
  if (f.transmission) parts.push(`${f.transmission}`);
  if (f.fuelType) parts.push(`${f.fuelType}`);
  if (f.bodyStyle) parts.push(`${f.bodyStyle}`);
  if (f.states?.length) parts.push(f.states.join('/'));
  for (const n of p.avoid) parts.push(`avoid "${n.text}"`);
  for (const n of p.like) parts.push(`like "${n.text}"`);
  if (p.excluded.length) parts.push(`${p.excluded.length} rejected car(s)`);
  return parts.length ? parts.join(' · ') : 'no preferences saved yet';
}

/** Apply stored filter preferences to a list of cards (sparse, non-destructive). */
export function applyPrefFilters<
  T extends {
    price?: number | null;
    year?: number | null;
    odometer?: number | null;
    transmission?: string | null;
    fuelType?: string | null;
    bodyType?: string | null;
    state?: string | null;
  },
>(cards: T[], overrides: PrefFilters = {}): { cards: T[]; applied: string[] } {
  const p = load();
  const f = p.filters;
  const applied: string[] = [];
  const maxPrice = overrides.maxPrice ?? f.maxPrice;
  const minPrice = overrides.minPrice ?? f.minPrice;
  if (maxPrice != null) {
    const before = cards.length;
    cards = cards.filter((c) => (c.price != null && c.price <= maxPrice) || c.price == null);
    if (cards.length !== before) applied.push(`≤ $${maxPrice.toLocaleString()}`);
  }
  if (minPrice != null) cards = cards.filter((c) => c.price == null || c.price >= minPrice);
  if (overrides.maxYear ?? f.maxYear) {
    const y = overrides.maxYear ?? f.maxYear!;
    cards = cards.filter((c) => c.year == null || c.year <= y);
  }
  if (overrides.minYear ?? f.minYear) {
    const y = overrides.minYear ?? f.minYear!;
    cards = cards.filter((c) => c.year == null || c.year >= y);
  }
  if (overrides.maxOdometer ?? f.maxOdometer) {
    const k = overrides.maxOdometer ?? f.maxOdometer!;
    cards = cards.filter((c) => c.odometer == null || c.odometer <= k);
  }
  const trans = overrides.transmission ?? f.transmission;
  if (trans) {
    const want = trans.toLowerCase();
    cards = cards.filter((c) => !c.transmission || c.transmission.toLowerCase().includes(want));
    applied.push(`${trans}`);
  }
  const fuel = overrides.fuelType ?? f.fuelType;
  if (fuel) {
    const want = fuel.toLowerCase();
    cards = cards.filter((c) => !c.fuelType || c.fuelType.toLowerCase().includes(want));
    applied.push(`${fuel}`);
  }
  const body = overrides.bodyStyle ?? f.bodyStyle;
  if (body) {
    const want = body.toLowerCase();
    cards = cards.filter((c) => !c.bodyType || c.bodyType.toLowerCase().includes(want));
    applied.push(`${body}`);
  }
  if (f.states?.length) cards = cards.filter((c) => !c.state || f.states!.includes(c.state));
  return { cards, applied };
}
