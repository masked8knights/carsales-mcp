/**
 * Enforced "don't send the same offer twice" guard. Persisted to disk so the
 * protection survives restarts. Two independent checks before any send:
 *   1. exact-duplicate: same listing + same message + same price  -> refuse
 *   2. recent: any offer to the same listing within CARS_OFFER_COOLDOWN_HOURS -> refuse
 * This is mandatory and cannot be disabled (matches the no-AI-posting rule).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const FILE = process.env.CARS_OFFERS_FILE || path.join(os.homedir(), '.carsales-mcp', 'sent-offers.json');

interface OfferRecord {
  listingKey: string;
  messageHash: string;
  ts: number;
  price: number | null;
}

function load(): OfferRecord[] {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function save(records: OfferRecord[]): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(records.slice(-500), null, 2));
  try {
    fs.chmodSync(FILE, 0o600);
  } catch {
    // ignore
  }
}

export function messageHash(message: string, price: number | null): string {
  return crypto.createHash('sha256').update(`${message}::${price ?? ''}`).digest('hex');
}

export function hasIdenticalOffer(listingKey: string, message: string, price: number | null): boolean {
  const h = messageHash(message, price);
  return load().some((r) => r.listingKey === listingKey && r.messageHash === h);
}

export function hasRecentOffer(listingKey: string, withinHours: number): boolean {
  if (!withinHours || withinHours <= 0) return false;
  const cutoff = Date.now() - withinHours * 3600 * 1000;
  return load().some((r) => r.listingKey === listingKey && r.ts >= cutoff);
}

export function recordOffer(listingKey: string, message: string, price: number | null): void {
  const records = load();
  records.push({ listingKey, messageHash: messageHash(message, price), ts: Date.now(), price });
  save(records);
}
